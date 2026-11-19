// OTel 上报层：初始化 APM（trace，OTLP gRPC + authentication 头）与
// AOM（metric，OTLP gRPC + Bearer/projectid/promid 头），把 coordinator 聚合的
// EventRecord 转成 AgentArts 规范的 span 层级与 metric。
import { context, trace, diag, DiagLogLevel, SpanStatusCode, TraceFlags } from "@opentelemetry/api"
import type { AttributeValue, Counter, Gauge, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics"
import type { ExportResult } from "@opentelemetry/core"
import { ExportResultCode } from "@opentelemetry/core"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { Metadata } from "@grpc/grpc-js"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { log, logError, logDebug, isDebugEnabled } from "./logger.js"
import { PROBE_VERSION } from "./probe-version.generated.js"
import type { RootSpanContext, RootSpanHandle, TurnEventRecord } from "./coordinator.js"

/** AgentArts APM/AOM 上报配置（config.json 的 otel 节点） */
export interface AgentArtsOtelConfig {
  agentarts_agentops_otel_agent_apm_enable?: boolean
  agentarts_agentops_otel_agent_aom_enable?: boolean
  agent_domain_id?: string
  agentarts_project_id?: string
  agent_resource_id?: string
  resource_type?: string
  resource_version?: string
  agentarts_agentops_apm_token?: string
  agentarts_agentops_apm_exporter_endpoint?: string
  agentarts_agentops_aom_access_code?: string
  agentarts_agentops_aom_exporter_endpoint?: string
  agentarts_agentops_aom_prometheus_id?: string
}

interface MetricInstruments {
  // LLM metrics
  inputTokens: Counter
  outputTokens: Counter
  totalRequests: Counter
  llmDuration: Histogram
  // 诊断别名：直接上报 agent-ops 查询名 gen_ai_client_operation_duration_seconds
  //（若模型平均耗时 Top5 由此别名生效 → 证明 AOM 对 operation.duration 未自动加 seconds 后缀）
  llmDurationSeconds: Histogram
  ttft: Histogram
  // 下划线别名：AOM 对带点 Histogram 不自动加 _seconds 后缀（opencode 2026-10-12 验证），
  // 平台查询名 gen_ai_server_time_to_first_token_seconds 依赖此别名（对齐 llama metrics.py L35-40）
  ttftSeconds: Histogram
  tbt: Histogram
  // Agent/workflow metrics
  totalAgentRequests: Counter
  agentDuration: Histogram
  // 下划线别名：平台查询名 client_operation_duration_seconds（对齐 llama metrics.py L54-59）
  agentDurationSeconds: Histogram
  // Synchronous Gauges (matching Python reference's meter.create_gauge)
  usageStatusGauge: Gauge
  sessionCountGauge: Gauge
  // Tool metrics
  toolCallTotal: Counter
  toolCallDuration: Histogram
  // 下划线别名：平台查询名 gen_ai_client_tool_call_duration_seconds（对齐 llama metrics.py L83-88）
  toolCallDurationSeconds: Histogram
  toolCallInputTokens: Counter
  toolCallOutputTokens: Counter
  // Skill metrics
  skillCallCount: Counter
  skillDuration: Histogram
  // 下划线别名：平台查询名 gen_ai_skill_duration_seconds（对齐 llama metrics.py L96-101）
  skillDurationSeconds: Histogram
  skillErrorCount: Counter
  // 下划线命名副本：值与 gen_ai.skill.call.count 完全一致，用于验证 AOM 指标名转换规则
  skillCallCountTotal: Counter
}

interface StepUnit {
  stepId: string
  startNano: number
  llmEvents: TurnEventRecord[]
  toolEvents: TurnEventRecord[]
}

let tracerProvider: BasicTracerProvider | null = null
let meterProvider: MeterProvider | null = null
let tracer: Tracer | null = null
let metricInstruments: MetricInstruments | null = null
let captureContentEnabled = true

function setCaptureContentEnabled(enabled: boolean) {
  captureContentEnabled = enabled
}

function captureContent() {
  return captureContentEnabled
}

const SCOPE_NAME = "@cloud/huaweicloud-agentarts-observation-dsh-plugin"

// 导出超时（毫秒）。OTLP 默认 10s，在跨境/弱网链路上不足以完成 TCP+TLS+HTTP/2
// 建链（实测有约 40% 连接超时、需要重试），会导致首个周期丢数据。取 30s 折中：
// 足够覆盖建链重试，又不会让 shutdown 阻塞过久。
const EXPORT_TIMEOUT_MS = 30_000

// 导出重试：BatchSpanProcessor 与 PeriodicExportingMetricReader 在 export 回调报告失败后
// 会直接丢弃这一批数据（不重试）。弱网下 gRPC 建链失败（ETIMEDOUT / UNAVAILABLE）是常见且
// 可恢复的，所以在我们自己的 export 包装里做有界重试，复用同一批 payload，避免丢数据。
const EXPORT_MAX_ATTEMPTS = 3
// 退避需要盖过 grpc-js 通道自身的重连退避：通道进入 TRANSIENT_FAILURE 后，过短的重试
// 会复用同一个坏通道并立即失败（实测 1s/3s 的第二次、第三次尝试都是瞬时失败）。
const EXPORT_RETRY_BACKOFF_MS = [2000, 8000]

function exportWithRetry<T>(
  rawExport: (payload: T, callback: (result: ExportResult) => void) => void,
  payload: T,
  callback: (result: ExportResult) => void,
  label: string,
  describe: () => Record<string, unknown>,
  onSuccess?: () => void
) {
  let attempt = 0
  const run = () => {
    attempt += 1
    if (attempt === 1) log(`[dsh-metrics] ${label} exporting`, describe())
    rawExport(payload, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        log(`[dsh-metrics] ${label} export SUCCESS`, { ...describe(), attempt })
        onSuccess?.()
        callback(result)
        return
      }
      const detail = {
        ...describe(),
        attempt,
        maxAttempts: EXPORT_MAX_ATTEMPTS,
        code: result.code,
        error: result.error?.message || "unknown"
      }
      if (attempt < EXPORT_MAX_ATTEMPTS) {
        const delay = EXPORT_RETRY_BACKOFF_MS[Math.min(attempt - 1, EXPORT_RETRY_BACKOFF_MS.length - 1)]
        log(`[dsh-metrics] ${label} export failed, retrying in ${delay}ms`, detail)
        setTimeout(run, delay)
        return
      }
      logError(`[dsh-metrics] ${label} export FAILED`, detail)
      callback(result)
    })
  }
  run()
}

let agentName: string | null = null

function setAgentName(name: string) {
  agentName = name && name.length > 0 ? name : null
}

function rootSpanName() {
  return `invoke_agent ${agentName ?? "dsh_agent"}`
}

const DURATION_HISTOGRAM_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]

let contextManagerRegistered = false

function initOtel(config: AgentArtsOtelConfig) {
  if (!contextManagerRegistered) {
    const ctxManager = new AsyncLocalStorageContextManager()
    ctxManager.enable()
    context.setGlobalContextManager(ctxManager)
    contextManagerRegistered = true
    log("[dsh-metrics] AsyncLocalStorageContextManager registered")
  }
  const apmEnabled = config.agentarts_agentops_otel_agent_apm_enable === true
  const aomEnabled = config.agentarts_agentops_otel_agent_aom_enable === true
  if (!apmEnabled && !aomEnabled) {
    log("[dsh-metrics] OTel disabled (both APM and AOM are off)")
    return
  }
  diag.setLogger(
    {
      debug: (msg, ...args) => log("[OTel]", msg, ...args),
      info: (msg, ...args) => log("[OTel]", msg, ...args),
      warn: (msg, ...args) => log("[OTel][WARN]", msg, ...args),
      error: (msg, ...args) => logError("[OTel]", msg, ...args),
      verbose: () => {}
    },
    DiagLogLevel.INFO
  )
  log("[dsh-metrics] OTel init config:", {
    apmEnabled,
    aomEnabled,
    apmEndpoint: config.agentarts_agentops_apm_exporter_endpoint,
    aomEndpoint: config.agentarts_agentops_aom_exporter_endpoint,
    domainId: config.agent_domain_id,
    resourceId: config.agent_resource_id,
    resourceType: config.resource_type,
    projectId: config.agentarts_project_id,
    promId: config.agentarts_agentops_aom_prometheus_id
  })
  const resource = resourceFromAttributes({
    "service.name": "AgentArts.default.default",
    "domain.id": config.agent_domain_id,
    "gen_ai.resource.id": config.agent_resource_id,
    "gen_ai.resource.type": config.resource_type
  })
  if (apmEnabled) {
    try {
      const traceMetadata = new Metadata()
      traceMetadata.set("authentication", config.agentarts_agentops_apm_token ?? "")
      const traceExporter = new OTLPTraceExporter({
        url: toGrpcUrl(config.agentarts_agentops_apm_exporter_endpoint),
        metadata: traceMetadata,
        timeoutMillis: EXPORT_TIMEOUT_MS
      })
      const apmEndpoint = config.agentarts_agentops_apm_exporter_endpoint
      const origTraceExport = traceExporter.export.bind(traceExporter)
      traceExporter.export = (spans: ReadableSpan[], callback: (result: ExportResult) => void) => {
        exportWithRetry(origTraceExport, spans, callback, "APM (Traces)", () => ({
          spanCount: spans.length,
          endpoint: apmEndpoint
        }))
      }
      tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(traceExporter)]
      })
      tracer = tracerProvider.getTracer(SCOPE_NAME, PROBE_VERSION)
      log("[dsh-metrics] APM (Traces) initialized", {
        endpoint: config.agentarts_agentops_apm_exporter_endpoint
      })
    } catch (error) {
      logError("[dsh-metrics] APM init failed:", error)
    }
  }
  if (aomEnabled) {
    try {
      const aomEndpoint = config.agentarts_agentops_aom_exporter_endpoint
      const metricMetadata = new Metadata()
      metricMetadata.set("authorization", `Bearer ${config.agentarts_agentops_aom_access_code}`)
      metricMetadata.set("projectid", config.agentarts_project_id ?? "")
      metricMetadata.set("promid", config.agentarts_agentops_aom_prometheus_id ?? "")
      const metricExporter = new OTLPMetricExporter({
        url: toGrpcUrl(aomEndpoint),
        metadata: metricMetadata,
        timeoutMillis: EXPORT_TIMEOUT_MS
      })
      const origMetricExport = metricExporter.export.bind(metricExporter)
      metricExporter.export = (metrics: ResourceMetrics, callback: (result: ExportResult) => void) => {
        let totalDataPoints = 0
        const metricNames: string[] = []
        // 仅在 debug 日志开启时收集全量 datapoint 明细：
        // 每次导出（60s）对所有 dataPoints 做对象展开开销不小，非 debug 时只保留计数与指标名。
        const collectDetails = isDebugEnabled()
        const skillMetricDetails: unknown[] = []
        const allMetricDetails: unknown[] = []
        const tokenCounterDetails: unknown[] = []
        if (metrics?.scopeMetrics) {
          for (const sm of metrics.scopeMetrics) {
            for (const m of sm.metrics || []) {
              const name = m.descriptor?.name || "unknown"
              metricNames.push(name)
              const dpCount = m.dataPoints?.length || 0
              totalDataPoints += dpCount
              if (!collectDetails) continue
              const dataPoints = m.dataPoints || []
              dataPoints.forEach((dp, idx) => {
                allMetricDetails.push({
                  metricName: name,
                  index: idx,
                  value: dp.value,
                  startTime: dp.startTime,
                  endTime: dp.endTime,
                  attributes: dp.attributes
                })
              })
              if (name.includes("skill")) {
                dataPoints.forEach((dp, idx) => {
                  skillMetricDetails.push({
                    metricName: name,
                    index: idx,
                    value: dp.value,
                    startTime: dp.startTime,
                    endTime: dp.endTime,
                    attributes: dp.attributes
                  })
                })
              }
              if (name.includes("tokens") || name === "gen_ai.total.requests") {
                dataPoints.forEach((dp, idx) => {
                  tokenCounterDetails.push({
                    metric: name,
                    cumulativeValue: dp.value,
                    attributes: dp.attributes
                  })
                })
              }
            }
          }
        }
        exportWithRetry(
          origMetricExport,
          metrics,
          callback,
          "AOM (Metrics)",
          () => ({ totalDataPoints, endpoint: aomEndpoint, metricNames: metricNames.join(", ") }),
          () => {
            if (tokenCounterDetails.length > 0) {
              logDebug("[dsh-metrics] AOM Token/Request Counter values:", tokenCounterDetails)
            }
            if (allMetricDetails.length > 0) {
              logDebug("[dsh-metrics] AOM All Metric Details:", {
                count: allMetricDetails.length,
                details: allMetricDetails
              })
            }
            if (skillMetricDetails.length > 0) {
              logDebug("[dsh-metrics] AOM Skill Metric Details:", {
                count: skillMetricDetails.length,
                details: skillMetricDetails
              })
            }
          }
        )
      }
      const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 6e4
      })
      meterProvider = new MeterProvider({
        resource,
        readers: [metricReader]
      })
      const meter = meterProvider.getMeter(SCOPE_NAME, PROBE_VERSION)
      metricInstruments = {
        // LLM metrics
        inputTokens: meter.createCounter("gen_ai.usage.input_tokens", { description: "Number of input tokens" }),
        outputTokens: meter.createCounter("gen_ai.usage.output_tokens", { description: "Number of output tokens" }),
        totalRequests: meter.createCounter("gen_ai.total.requests", { description: "Number of requests to GenAI" }),
        llmDuration: meter.createHistogram("gen_ai.client.operation.duration", {
          description: "Time to successful call LLM",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        // 诊断别名：直接上报 agent-ops 查询名 gen_ai_client_operation_duration_seconds
        //（若模型平均耗时 Top5 由此别名生效 → 证明 AOM 对 operation.duration 未自动加 seconds 后缀）
        llmDurationSeconds: meter.createHistogram("gen_ai_client_operation_duration_seconds", {
          description: "Time to successful call LLM (underscore alias)",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        ttft: meter.createHistogram("gen_ai.server.time_to_first_token", { description: "Time to first token", unit: "s" }),
        // 下划线别名：AOM 对带点 Histogram 不自动加 _seconds 后缀（opencode 2026-10-12 验证），
        // 平台查询名 gen_ai_server_time_to_first_token_seconds 依赖此别名（对齐 llama metrics.py L35-40）
        ttftSeconds: meter.createHistogram("gen_ai_server_time_to_first_token_seconds", {
          description: "Time to first token (underscore alias)",
          unit: "s"
        }),
        tbt: meter.createHistogram("gen_ai.server.time_per_output_token", { description: "Time per output token", unit: "s" }),
        // Agent/workflow metrics
        totalAgentRequests: meter.createCounter("total.requests", { description: "Number of requests count processed" }),
        agentDuration: meter.createHistogram("client.operation.duration", {
          description: "Time to successful responses",
          unit: "s"
        }),
        // 下划线别名：平台查询名 client_operation_duration_seconds（对齐 llama metrics.py L54-59）
        agentDurationSeconds: meter.createHistogram("client_operation_duration_seconds", {
          description: "Time to successful responses (underscore alias)",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        // Synchronous Gauges (matching Python reference's meter.create_gauge)
        usageStatusGauge: meter.createGauge("gen_ai.usage.status", {
          description: "Status of processed",
          unit: "1"
        }),
        sessionCountGauge: meter.createGauge("gen_ai.session.count", {
          description: "Number of session count processed",
          unit: "1"
        }),
        // Tool metrics
        toolCallTotal: meter.createCounter("gen_ai.client.tool_call.total", { description: "Number of tool call requests" }),
        toolCallDuration: meter.createHistogram("gen_ai.client.tool_call.duration", {
          description: "Duration of tool call requests",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        // 下划线别名：平台查询名 gen_ai_client_tool_call_duration_seconds（对齐 llama metrics.py L83-88）
        toolCallDurationSeconds: meter.createHistogram("gen_ai_client_tool_call_duration_seconds", {
          description: "Duration of tool call requests (underscore alias)",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        toolCallInputTokens: meter.createCounter("gen_ai.client.tool_call.input_tokens", {
          description: "Number of input tokens in tool call requests"
        }),
        toolCallOutputTokens: meter.createCounter("gen_ai.client.tool_call.output_tokens", {
          description: "Number of output tokens in tool call requests"
        }),
        // Skill metrics
        skillCallCount: meter.createCounter("gen_ai.skill.call.count", { description: "Number of tool call skills", unit: "1" }),
        skillDuration: meter.createHistogram("gen_ai.skill.duration", {
          description: "Duration of tool call skills",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        // 下划线别名：平台查询名 gen_ai_skill_duration_seconds（对齐 llama metrics.py L96-101）
        skillDurationSeconds: meter.createHistogram("gen_ai_skill_duration_seconds", {
          description: "Duration of tool call skills (underscore alias)",
          unit: "s",
          advice: { explicitBucketBoundaries: DURATION_HISTOGRAM_BUCKETS }
        }),
        skillErrorCount: meter.createCounter("gen_ai.skill.error.count", { description: "Number of failed skill calls", unit: "1" }),
        // 下划线命名副本：值与 gen_ai.skill.call.count 完全一致，用于验证 AOM 指标名转换规则
        skillCallCountTotal: meter.createCounter("gen_ai_skill_call_count_total", {
          description: "Number of tool call skills (underscore alias)",
          unit: "1"
        })
      }
      log("[dsh-metrics] AOM (Metrics) initialized", {
        endpoint: aomEndpoint,
        protocol: "gRPC"
      })
    } catch (error) {
      logError("[dsh-metrics] AOM init failed:", error)
    }
  }
}

function beginRootSpan(startTime: number, parentContext: RootSpanContext | undefined, agentName: string | undefined) {
  if (!tracer) return undefined
  try {
    let spanCtx = context.active()
    if (parentContext) {
      const parentSpanContext: SpanContext = {
        traceId: parentContext.traceId,
        spanId: parentContext.spanId,
        traceFlags: TraceFlags.SAMPLED, // 1 = sampled
        isRemote: false
      }
      // 官方 API 把父 SpanContext 包装为只读 Span 作为 parent
      //（等价于此前 duck-typed 的 { spanContext: () => parentSpanContext }）
      spanCtx = trace.setSpan(spanCtx, trace.wrapSpanContext(parentSpanContext))
    }
    const spanName = agentName && agentName.length > 0 ? `invoke_agent ${agentName}` : rootSpanName()
    const span = tracer.startSpan(spanName, { startTime }, spanCtx)
    span.setAttribute("gen_ai.operation.name", "invoke_agent")
    span.setAttribute("gen_ai.span.kind", "AGENT")
    span.setAttribute("gen_ai.call.type", "SDK")
    if (parentContext) span.setAttribute("dsh.subagent", true)
    const sc = span.spanContext()
    log("[dsh-metrics] OTel root span begun:", {
      name: spanName,
      traceId: sc.traceId,
      spanId: sc.spanId,
      linked: !!parentContext
    })
    return { span, context: { traceId: sc.traceId, spanId: sc.spanId } }
  } catch (error) {
    logError("[dsh-metrics] OTel beginRootSpan failed:", error)
    return undefined
  }
}

function reportEvents(events: TurnEventRecord[], handle: RootSpanHandle | undefined) {
  if (!tracer && !metricInstruments) return undefined
  if (events.length === 0) return undefined
  try {
    const typeCounts: Record<string, number> = {}
    for (const e of events) {
      const name = e["event.name"] || "unknown"
      typeCounts[name] = (typeCounts[name] || 0) + 1
    }
    log("[dsh-metrics] OTel reportEvents start:", { total: events.length, types: typeCounts })
    const turns = new Map<string, TurnEventRecord[]>()
    for (const event of events) {
      const turnId = event["gen_ai.turn.id"] || event.trace_id || "unknown"
      if (!turns.has(turnId)) turns.set(turnId, [])
      turns.get(turnId)!.push(event)
    }
    log("[dsh-metrics] OTel processing", turns.size, "turn(s)")
    let rootSpanContext
    for (const [turnId, turnEvents] of turns) {
      const ctx = processTurn(turnId, turnEvents, handle)
      if (ctx) rootSpanContext = ctx
    }
    log("[dsh-metrics] OTel reportEvents done")
    return rootSpanContext
  } catch (error) {
    logError("[dsh-metrics] OTel reportEvents failed:", error)
    return undefined
  }
}

function processTurn(turnId: string, events: TurnEventRecord[], handle: RootSpanHandle | undefined) {
  events.sort((a, b) => {
    const ta = a.time_unix_nano ? Number(a.time_unix_nano) : 0
    const tb = b.time_unix_nano ? Number(b.time_unix_nano) : 0
    return ta - tb
  })
  logDebug("[dsh-metrics] OTel processTurn:", turnId, "events:", events.length)
  const otherEvent = events.find((e) => e["event.name"] === "other")
  const firstRequest = events.find((e) => e["event.name"] === "llm.request" && e["gen_ai.input.messages"])
  const lastResponse = [...events].reverse().find((e) => e["event.name"] === "llm.response" && e["gen_ai.output.messages"])
  const steps = new Map<string, TurnEventRecord[]>()
  const toolGroups = new Map<string, TurnEventRecord[]>()
  for (const event of events) {
    const eventName = event["event.name"]
    if (eventName === "llm.request" || eventName === "llm.response") {
      const stepId = event["gen_ai.step.id"]
      if (stepId) {
        if (!steps.has(stepId)) steps.set(stepId, [])
        steps.get(stepId)!.push(event)
      }
    } else if (eventName === "tool.call" || eventName === "tool.result") {
      const callId = event["gen_ai.tool.call.id"]
      if (callId) {
        if (!toolGroups.has(callId)) toolGroups.set(callId, [])
        toolGroups.get(callId)!.push(event)
      }
    }
  }
  log("[dsh-metrics] OTel turn", turnId, "- LLM steps:", steps.size, "tool calls:", toolGroups.size)
  let rootSpan: Span | null = handle?.span ?? null
  let rootSpanCtx = handle?.context
  if (tracer && otherEvent) {
    try {
      if (!rootSpan) {
        const startTime = nanoToMs(otherEvent.time_unix_nano)
        let spanCtx = context.active()
        rootSpan = tracer.startSpan(
          rootSpanName(),
          {
            startTime,
            attributes: buildCommonSpanAttrs(otherEvent)
          },
          spanCtx
        )
      } else {
        const commonAttrs = buildCommonSpanAttrs(otherEvent)
        for (const [key, value] of Object.entries(commonAttrs)) {
          rootSpan.setAttribute(key, value)
        }
      }
      rootSpan.setAttribute("gen_ai.operation.name", "invoke_agent")
      rootSpan.setAttribute("gen_ai.span.kind", "AGENT")
      rootSpan.setAttribute("gen_ai.call.type", "SDK")
      if (captureContent()) {
        const inputMessages =
          (otherEvent && otherEvent["gen_ai.input.messages"]) ||
          (firstRequest && messagesWithRole(firstRequest, "gen_ai.input.messages", "user")) ||
          (lastResponse && messagesWithRole(lastResponse, "gen_ai.input.messages", "user"))
        const outputMessages =
          (otherEvent && otherEvent["gen_ai.output.messages"]) ||
          (lastResponse && messagesWithRole(lastResponse, "gen_ai.output.messages", "assistant")) ||
          (firstRequest && messagesWithRole(firstRequest, "gen_ai.output.messages", "assistant"))
        if (inputMessages) {
          setAttr(rootSpan, "gen_ai.input.messages", toJsonAttr(inputMessages))
        }
        if (outputMessages) {
          setAttr(rootSpan, "gen_ai.output.messages", toJsonAttr(outputMessages))
        }
      }
      log("[dsh-metrics] OTel root agent span created:", turnId)
    } catch (error) {
      logError("[dsh-metrics] OTel root agent span creation failed:", { turnId, error })
    }
  }
  if (metricInstruments && otherEvent) {
    try {
      const userId = String(otherEvent["user.id"] || "")
      if (userId) {
        const statusAttrs = buildUsageStatusAttrs(otherEvent)
        metricInstruments.usageStatusGauge.record(1, statusAttrs)
        log("[dsh-metrics] OTel usage status gauge recorded:", { userId, attrs: statusAttrs })
      }
      const genAttrs = buildGenerationAttrs(otherEvent)
      metricInstruments.totalAgentRequests.add(1, genAttrs)
      const turnStartMs = nanoToMs(otherEvent.time_unix_nano)
      const turnEndMs = nanoToMs(events[events.length - 1].time_unix_nano)
      const turnDurationS = (turnEndMs - turnStartMs) / 1e3
      if (turnDurationS > 0) {
        metricInstruments.agentDuration.record(turnDurationS, genAttrs)
        if (metricInstruments.agentDurationSeconds) {
          metricInstruments.agentDurationSeconds.record(turnDurationS, genAttrs)
        }
      }
      log("[dsh-metrics] OTel agent metrics recorded:", { turnId, turnDurationS })
    } catch (error) {
      logError("[dsh-metrics] OTel agent metric recording failed:", { turnId, error })
    }
  }
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTokens = 0
  const stepUnits = new Map<string, StepUnit>()
  for (const [stepId, stepEvents] of steps) {
    const req = stepEvents.find((e) => e["event.name"] === "llm.request")
    const resp = stepEvents.find((e) => e["event.name"] === "llm.response")
    let startNano = Number(req?.time_unix_nano || resp?.time_unix_nano || 0)
    for (const ev of stepEvents) {
      const n = Number(ev.time_unix_nano || 0)
      if (n > 0 && (startNano === 0 || n < startNano)) startNano = n
    }
    stepUnits.set(stepId, { stepId, startNano, llmEvents: stepEvents, toolEvents: [] })
  }
  for (const [, toolEvents] of toolGroups) {
    const call = toolEvents.find((e) => e["event.name"] === "tool.call")
    const toolStepId = call?.["gen_ai.step.id"] || toolEvents[0]?.["gen_ai.step.id"]
    if (toolStepId && stepUnits.has(toolStepId)) {
      stepUnits.get(toolStepId)!.toolEvents.push(...toolEvents)
    } else {
      const orphanNano = Number(call?.time_unix_nano || toolEvents[0]?.time_unix_nano || 0)
      let bestStep: StepUnit | undefined
      for (const unit of stepUnits.values()) {
        if (orphanNano >= unit.startNano) {
          if (!bestStep || unit.startNano > bestStep.startNano) bestStep = unit
        }
      }
      if (bestStep) {
        bestStep.toolEvents.push(...toolEvents)
      }
    }
  }
  for (const unit of stepUnits.values()) {
    for (const ev of unit.toolEvents) {
      const n = Number(ev.time_unix_nano || 0)
      if (n > 0 && (unit.startNano === 0 || n < unit.startNano)) unit.startNano = n
    }
  }
  const orderedStepUnits = [...stepUnits.values()].sort((a, b) => a.startNano - b.startNano)
  const intentSkillName = otherEvent && otherEvent["gen_ai.intent.skill"] ? String(otherEvent["gen_ai.intent.skill"]) : undefined
  const processAll = () => {
    for (const unit of orderedStepUnits) {
      let lastNano = unit.startNano
      for (const ev of unit.llmEvents) {
        const n = Number(ev.time_unix_nano || 0)
        if (n > lastNano) lastNano = n
      }
      for (const ev of unit.toolEvents) {
        const n = Number(ev.time_unix_nano || 0)
        if (n > lastNano) lastNano = n
      }
      const llmReqEvent = unit.llmEvents.find((e) => e["event.name"] === "llm.request")
      const stepStartMs = nanoToMs(String(unit.startNano)) || undefined
      const stepSpan = tracer && rootSpan ? tracer.startSpan("react step", {
        startTime: stepStartMs,
        attributes: buildCommonSpanAttrs(otherEvent || events[0])
      }) : null
      logDebug("[dsh-metrics] OTel react step created:", {
        stepId: unit.stepId,
        llmRequestTimeRaw: llmReqEvent?.time_unix_nano ?? "(missing)",
        startNano: unit.startNano,
        stepStartMs,
        llmEvents: unit.llmEvents.length,
        toolEvents: unit.toolEvents.length
      })
      if (stepSpan) {
        stepSpan.setAttribute("gen_ai.span.kind", "STEP")
        stepSpan.setAttribute("gen_ai.operation.name", "react_step")
        stepSpan.setAttribute("gen_ai.step.id", unit.stepId)
        const lastRespEvent = sortByTime(unit.llmEvents).filter((e) => e["event.name"] === "llm.response").pop()
        const stepFinishReasons = lastRespEvent?.["gen_ai.response.finish_reasons"]
        const stepFinishReason = Array.isArray(stepFinishReasons) ? stepFinishReasons[0] : stepFinishReasons
        if (stepFinishReason) {
          stepSpan.setAttribute("gen_ai.react.finish_reason", String(stepFinishReason))
        }
        const roundNo = llmReqEvent?.["dsh.step"] ?? lastRespEvent?.["dsh.step"]
        if (typeof roundNo === "number") {
          stepSpan.setAttribute("gen_ai.react.round", roundNo)
        }
      }
      const stepCtx = stepSpan ? trace.setSpan(context.active(), stepSpan) : context.active()
      context.with(stepCtx, () => {
        // per-step 全量时间戳明细，仅 debug 记录（信息量大、无日常排障价值）
        logDebug("[dsh-metrics] Step event timestamps:", {
          stepId: unit.stepId,
          llmEvents: unit.llmEvents.map((e) => ({
            name: e["event.name"],
            time_unix_nano: e.time_unix_nano,
            time_ms: nanoToMs(e.time_unix_nano)
          })),
          toolEvents: unit.toolEvents.map((e) => ({
            name: e["event.name"],
            tool_name: e["gen_ai.tool.name"],
            time_unix_nano: e.time_unix_nano,
            time_ms: nanoToMs(e.time_unix_nano)
          }))
        })
        const llmCalls = splitLlmCalls(unit.llmEvents)
        llmCalls.forEach((callEvents) => {
          const callResp = processLlmSpan(callEvents)
          if (callResp) {
            totalInputTokens += callResp.inputTokens || 0
            totalOutputTokens += callResp.outputTokens || 0
            totalTokens += callResp.totalTokens || 0
          }
        })
        const toolSubGroups = new Map<string, TurnEventRecord[]>()
        for (const ev of unit.toolEvents) {
          const cid = ev["gen_ai.tool.call.id"] || "orphan"
          if (!toolSubGroups.has(cid)) toolSubGroups.set(cid, [])
          toolSubGroups.get(cid)!.push(ev)
        }
        for (const [, subEvents] of toolSubGroups) {
          processToolSpan(subEvents, !!intentSkillName)
        }
      })
      if (stepSpan) {
        try {
          stepSpan.end(nanoToMs(String(lastNano)))
          log("[dsh-metrics] OTel react step closed:", {
            stepId: unit.stepId,
            startNano: unit.startNano,
            lastNano,
            durationS: lastNano > unit.startNano ? (lastNano - unit.startNano) / 1e9 : 0,
            llmEvents: unit.llmEvents.length,
            toolEvents: unit.toolEvents.length
          })
        } catch (error) {
          logError("[dsh-metrics] OTel react step end failed:", { error })
        }
      }
    }
  }
  if (rootSpan) {
    context.with(trace.setSpan(context.active(), rootSpan), processAll)
  } else {
    processAll()
  }
  if (metricInstruments && otherEvent && intentSkillName) {
    try {
      const skillAttrs = buildSkillMetricAttrs(otherEvent, intentSkillName)
      metricInstruments.skillCallCount.add(1, skillAttrs)
      metricInstruments.skillCallCountTotal.add(1, skillAttrs)
      const turnStartNs = Number(otherEvent.time_unix_nano || 0)
      const turnEndNs = events.length > 0 ? Number(events[events.length - 1].time_unix_nano || 0) : 0
      const turnDurationS = turnEndNs > turnStartNs ? (turnEndNs - turnStartNs) / 1e9 : 0
      metricInstruments.skillDuration.record(turnDurationS, skillAttrs)
      if (metricInstruments.skillDurationSeconds) {
        metricInstruments.skillDurationSeconds.record(turnDurationS, skillAttrs)
      }
      log("[dsh-metrics] OTel intent skill metrics recorded:", {
        turnId,
        intentSkillName,
        turnDurationS,
        attrs: skillAttrs
      })
    } catch (error) {
      logError("[dsh-metrics] OTel intent skill metric recording failed:", { turnId, intentSkillName, error })
    }
  }
  if (rootSpan) {
    try {
      rootSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens)
      rootSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens)
      rootSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens)
      const failedResponse = [...events].reverse().find((e) => e["event.name"] === "llm.response" && e["error.type"])
      if (failedResponse) {
        const errMsg = String(failedResponse["error.message"] || failedResponse["error.type"]).slice(0, 500)
        rootSpan.setAttribute("gen_ai.call.status", false)
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errMsg })
        log("[dsh-metrics] OTel root agent span marked ERROR:", { turnId, errorMessage: errMsg })
      }
      rootSpan.end(nanoToMs(events[events.length - 1].time_unix_nano))
      const sc = rootSpan.spanContext()
      rootSpanCtx = { traceId: sc.traceId, spanId: sc.spanId }
      log("[dsh-metrics] OTel root agent span ended:", turnId, {
        totalInputTokens,
        totalOutputTokens,
        totalTokens
      })
    } catch (error) {
      logError("[dsh-metrics] OTel root agent span end failed:", { turnId, error })
    }
  }
  return rootSpanCtx
}

function processLlmSpan(events: TurnEventRecord[]) {
  const requestEvent = events.find((e) => e["event.name"] === "llm.request")
  const responseEvent = events.find((e) => e["event.name"] === "llm.response")
  if (!tracer && !metricInstruments) return null
  if (!requestEvent && !responseEvent) return null
  const startTime = requestEvent
    ? nanoToMs(requestEvent.time_unix_nano)
    : responseEvent
      ? nanoToMs(responseEvent.time_unix_nano)
      : Date.now()
  const endTime = responseEvent ? nanoToMs(responseEvent.time_unix_nano) : startTime
  const spanEndTime = endTime
  const stepId = requestEvent?.["gen_ai.step.id"] || responseEvent?.["gen_ai.step.id"]
  const model = responseEvent?.["gen_ai.response.model"] || requestEvent?.["gen_ai.request.model"]
  const provider = requestEvent?.["gen_ai.provider.name"] || responseEvent?.["gen_ai.provider.name"]
  logDebug("[dsh-metrics] OTel LLM span:", { stepId, model, provider, hasRequest: !!requestEvent, hasResponse: !!responseEvent })
  if (tracer) {
    try {
      const llmSpanName = model ? `chat ${model}` : "chat"
      const span = tracer.startSpan(llmSpanName, {
        startTime,
        attributes: buildCommonSpanAttrs(requestEvent || responseEvent!)
      })
      span.setAttribute("gen_ai.operation.name", "chat")
      span.setAttribute("gen_ai.span.kind", "LLM")
      span.setAttribute("gen_ai.call.type", "SDK")
      if (requestEvent) {
        setAttr(span, "gen_ai.step.id", requestEvent["gen_ai.step.id"])
        setAttr(span, "gen_ai.provider.name", requestEvent["gen_ai.provider.name"])
        setAttr(span, "gen_ai.request.model", requestEvent["gen_ai.request.model"])
        setAttr(span, "gen_ai.model.id", requestEvent["gen_ai.model.id"])
        setAttr(span, "dsh.message.id", requestEvent["dsh.message.id"])
        setAttr(span, "gen_ai.request.temperature", requestEvent["gen_ai.request.temperature"])
        setAttr(span, "gen_ai.request.stop_sequences", requestEvent["gen_ai.request.stop_sequences"])
        setAttr(span, "gen_ai.request.max_tokens", requestEvent["gen_ai.request.max_tokens"])
        setAttr(span, "gen_ai.request.is_stream", requestEvent["gen_ai.request.is_stream"])
        if (captureContent()) {
          if (requestEvent["gen_ai.input.messages"]) {
            setAttr(span, "gen_ai.input.messages", JSON.stringify(requestEvent["gen_ai.input.messages"]))
          }
        }
      }
      if (responseEvent) {
        setAttr(span, "gen_ai.step.id", responseEvent["gen_ai.step.id"])
        setAttr(span, "gen_ai.provider.name", responseEvent["gen_ai.provider.name"])
        setAttr(span, "gen_ai.request.model", responseEvent["gen_ai.request.model"])
        setAttr(span, "gen_ai.response.model", responseEvent["gen_ai.response.model"])
        setAttr(span, "gen_ai.model.id", responseEvent["gen_ai.model.id"])
        setAttr(span, "gen_ai.response.id", responseEvent["gen_ai.response.id"])
        const finishReasons = responseEvent["gen_ai.response.finish_reasons"]
        if (finishReasons !== undefined && finishReasons !== null) {
          setAttr(span, "gen_ai.response.finish_reasons", JSON.stringify(finishReasons))
        }
        setAttr(span, "gen_ai.usage.input_tokens", responseEvent["gen_ai.usage.input_tokens"])
        setAttr(span, "gen_ai.usage.output_tokens", responseEvent["gen_ai.usage.output_tokens"])
        setAttr(span, "gen_ai.usage.total_tokens", responseEvent["gen_ai.usage.total_tokens"])
        setAttr(span, "gen_ai.usage.cache_read.input_tokens", responseEvent["gen_ai.usage.cache_read.input_tokens"])
        setAttr(span, "gen_ai.usage.cache_write.input_tokens", responseEvent["gen_ai.usage.cache_write.input_tokens"])
        const cacheWriteTokens = responseEvent["gen_ai.usage.cache_write.input_tokens"]
        const cacheCreationTokens = responseEvent["gen_ai.usage.cache_creation.input_tokens"] ?? cacheWriteTokens
        setAttr(span, "gen_ai.usage.cache_creation.input_tokens", cacheCreationTokens)
        setAttr(span, "gen_ai.usage.reasoning_tokens", responseEvent["gen_ai.usage.reasoning_tokens"])
        const ttftSec = responseEvent["gen_ai.response.ttft"]
        if (typeof ttftSec === "number" && ttftSec > 0) {
          const ttftMs = Math.round(ttftSec * 1e3)
          setAttr(span, "gen_ai.response.time_to_first_token", ttftMs)
        }
        setAttr(span, "cost_usd", responseEvent["cost_usd"])
        if (captureContent()) {
          if (responseEvent["gen_ai.input.messages"]) {
            setAttr(span, "gen_ai.input.messages", JSON.stringify(responseEvent["gen_ai.input.messages"]))
          }
          if (responseEvent["gen_ai.output.messages"]) {
            setAttr(span, "gen_ai.output.messages", JSON.stringify(responseEvent["gen_ai.output.messages"]))
          }
        }
        if (responseEvent["error.type"]) {
          setAttr(span, "error.type", responseEvent["error.type"])
          setAttr(span, "error.message", responseEvent["error.message"])
          span.setAttribute("gen_ai.call.status", false)
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(responseEvent["error.message"] || responseEvent["error.type"]).slice(0, 500) })
        }
      }
      span.end(spanEndTime)
      log("[dsh-metrics] OTel LLM span created:", stepId)
    } catch (error) {
      logError("[dsh-metrics] OTel LLM span creation failed:", { stepId, error })
    }
  }
  if (metricInstruments && responseEvent) {
    try {
      const attrs = buildLLMMetricAttrs(responseEvent)
      const inputTokens = responseEvent["gen_ai.usage.input_tokens"]
      const outputTokens = responseEvent["gen_ai.usage.output_tokens"]
      if (typeof inputTokens === "number") {
        metricInstruments.inputTokens.add(inputTokens, attrs)
      }
      if (typeof outputTokens === "number") {
        metricInstruments.outputTokens.add(outputTokens, attrs)
      }
      metricInstruments.totalRequests.add(1, attrs)
      const llmDurationS = (endTime - startTime) / 1e3
      if (llmDurationS > 0) {
        metricInstruments.llmDuration.record(llmDurationS, attrs)
        if (metricInstruments.llmDurationSeconds) {
          metricInstruments.llmDurationSeconds.record(llmDurationS, attrs)
        }
      }
      const ttft = responseEvent["gen_ai.response.ttft"]
      if (typeof ttft === "number" && ttft > 0) {
        metricInstruments.ttft.record(ttft, buildTTOMetricAttrs(responseEvent))
        if (metricInstruments.ttftSeconds) {
          metricInstruments.ttftSeconds.record(ttft, buildTTOMetricAttrs(responseEvent))
        }
      }
      const tbt = responseEvent["gen_ai.response.tbt"]
      if (typeof tbt === "number" && tbt > 0) {
        metricInstruments.tbt.record(tbt, buildTTOMetricAttrs(responseEvent))
      }
      log("[dsh-metrics] OTel LLM metrics recorded:", { stepId, inputTokens, outputTokens, model, llmDurationS, ttft, tbt })
    } catch (error) {
      logError("[dsh-metrics] OTel LLM metric recording failed:", { stepId, error })
    }
  }
  if (metricInstruments && requestEvent) {
    try {
      const sessionId = String(requestEvent["gen_ai.session.id"] || requestEvent["gen_ai.conversation.id"] || "")
      if (sessionId) {
        const countAttrs = buildSessionCountAttrs(requestEvent)
        metricInstruments.sessionCountGauge.record(1, countAttrs)
        log("[dsh-metrics] OTel session count gauge recorded:", { sessionId, attrs: countAttrs })
      }
    } catch (error) {
      logError("[dsh-metrics] OTel session count failed:", { stepId, error })
    }
  }
  if (responseEvent) {
    return {
      inputTokens: typeof responseEvent["gen_ai.usage.input_tokens"] === "number" ? responseEvent["gen_ai.usage.input_tokens"] : 0,
      outputTokens: typeof responseEvent["gen_ai.usage.output_tokens"] === "number" ? responseEvent["gen_ai.usage.output_tokens"] : 0,
      totalTokens: typeof responseEvent["gen_ai.usage.total_tokens"] === "number" ? responseEvent["gen_ai.usage.total_tokens"] : 0
    }
  }
  return null
}

function processToolSpan(events: TurnEventRecord[], skipSkillMetrics = false) {
  const callEvent = events.find((e) => e["event.name"] === "tool.call")
  const resultEvent = events.find((e) => e["event.name"] === "tool.result")
  if (!tracer && !metricInstruments) return
  if (!callEvent && !resultEvent) return
  const startTime = callEvent ? nanoToMs(callEvent.time_unix_nano) : resultEvent ? nanoToMs(resultEvent.time_unix_nano) : Date.now()
  const endTime = resultEvent ? nanoToMs(resultEvent.time_unix_nano) : startTime
  const toolName = callEvent?.["gen_ai.tool.name"] || resultEvent?.["gen_ai.tool.name"]
  const callId = callEvent?.["gen_ai.tool.call.id"] || resultEvent?.["gen_ai.tool.call.id"]
  logDebug("[dsh-metrics] OTel tool span:", { toolName, callId, hasCall: !!callEvent, hasResult: !!resultEvent })
  const skillName = parseSkillNameFromTool(callEvent, resultEvent)
  if (tracer) {
    try {
      const toolSpanName = skillName ? `execute_tool ${skillName}` : toolName ? `execute_tool ${toolName}` : "execute_tool unknown"
      const span = tracer.startSpan(toolSpanName, {
        startTime,
        attributes: buildCommonSpanAttrs(callEvent || resultEvent!)
      })
      span.setAttribute("gen_ai.operation.name", "execute_tool")
      span.setAttribute("gen_ai.span.kind", "TOOL")
      span.setAttribute("gen_ai.tool.type", "function")
      span.setAttribute("gen_ai.call.type", "SDK")
      if (skillName) {
        setAttr(span, "gen_ai.skill.name", skillName)
      }
      if (callEvent) {
        setAttr(span, "gen_ai.tool.name", callEvent["gen_ai.tool.name"])
        setAttr(span, "gen_ai.tool.call.id", callEvent["gen_ai.tool.call.id"])
        setAttr(span, "gen_ai.step.id", callEvent["gen_ai.step.id"])
        if (captureContent()) {
          setAttr(span, "gen_ai.tool.call.arguments", callEvent["gen_ai.tool.call.arguments"])
        }
      }
      if (resultEvent) {
        setAttr(span, "gen_ai.tool.name", resultEvent["gen_ai.tool.name"])
        setAttr(span, "gen_ai.tool.call.id", resultEvent["gen_ai.tool.call.id"])
        setAttr(span, "gen_ai.tool.call.duration", resultEvent["gen_ai.tool.call.duration"])
        setAttr(span, "gen_ai.step.id", resultEvent["gen_ai.step.id"])
        if (captureContent()) {
          setAttr(span, "gen_ai.tool.call.result", resultEvent["gen_ai.tool.call.result"])
        }
      }
      const toolCallStatus = resultEvent
        ? resultEvent["gen_ai.call.status"] !== false && resultEvent["gen_ai.call.status"] !== "false"
        : true
      setAttr(span, "gen_ai.call.status", toolCallStatus)
      const turnIdForTool = callEvent?.["gen_ai.turn.id"] || resultEvent?.["gen_ai.turn.id"]
      if (turnIdForTool) {
        setAttr(span, "gen_ai.turn.id", turnIdForTool)
      }
      span.end(endTime)
      log("[dsh-metrics] OTel tool span created:", toolName, callId)
    } catch (error) {
      logError("[dsh-metrics] OTel tool span creation failed:", { toolName, callId, error })
    }
  }
  if (metricInstruments && callEvent) {
    try {
      const metricEvent = resultEvent || callEvent
      const attrs = buildToolMetricAttrs(metricEvent)
      metricInstruments.toolCallTotal.add(1, attrs)
      const durationMs = resultEvent?.["gen_ai.tool.call.duration"]
      if (typeof durationMs === "number" && durationMs > 0) {
        metricInstruments.toolCallDuration.record(durationMs / 1e3, attrs)
        if (metricInstruments.toolCallDurationSeconds) {
          metricInstruments.toolCallDurationSeconds.record(durationMs / 1e3, attrs)
        }
      }
      const argsStr = callEvent["gen_ai.tool.call.arguments"]
      if (argsStr) {
        const estimatedInput = Math.ceil(String(argsStr).length / 4)
        metricInstruments.toolCallInputTokens.add(estimatedInput, attrs)
      }
      const resultStr = resultEvent?.["gen_ai.tool.call.result"]
      if (resultStr) {
        const estimatedOutput = Math.ceil(String(resultStr).length / 4)
        metricInstruments.toolCallOutputTokens.add(estimatedOutput, attrs)
      }
      log("[dsh-metrics] OTel tool metrics recorded:", toolName)
      if (skipSkillMetrics) {
        log("[dsh-metrics] OTel skip tool-level skill metrics (intent already recorded):", toolName)
      } else if (toolName && toolName.toLowerCase() === "skill") {
        const skillName2 = parseSkillNameFromTool(callEvent, resultEvent)
        if (skillName2) {
          const skillAttrs = buildSkillMetricAttrs(metricEvent, skillName2)
          logDebug("[dsh-metrics] OTel skill metric attributes:", {
            skillName: skillName2,
            domainId: skillAttrs["domain.id"],
            resourceId: skillAttrs["gen_ai.resource.id"],
            resourceType: skillAttrs["gen_ai.resource.type"],
            callStatus: skillAttrs["gen_ai.call.status"],
            durationMs,
            fullAttrs: skillAttrs
          })
          try {
            metricInstruments.skillCallCount.add(1, skillAttrs)
            log("[dsh-metrics] OTel skillCallCount.add(1) succeeded for:", skillName2)
          } catch (error) {
            logError("[dsh-metrics] OTel skillCallCount.add(1) failed:", { skillName: skillName2, error })
          }
          try {
            metricInstruments.skillCallCountTotal.add(1, skillAttrs)
            log("[dsh-metrics] OTel skillCallCountTotal.add(1) succeeded for:", skillName2)
          } catch (error) {
            logError("[dsh-metrics] OTel skillCallCountTotal.add(1) failed:", { skillName: skillName2, error })
          }
          if (skillAttrs["gen_ai.call.status"] === false) {
            try {
              metricInstruments.skillErrorCount.add(1, skillAttrs)
              log("[dsh-metrics] OTel skillErrorCount.add(1) succeeded for failed skill:", skillName2)
            } catch (error) {
              logError("[dsh-metrics] OTel skillErrorCount.add(1) failed:", { skillName: skillName2, error })
            }
          }
          if (typeof durationMs === "number" && durationMs > 0) {
            const durationSeconds = durationMs / 1e3
            try {
              metricInstruments.skillDuration.record(durationSeconds, skillAttrs)
              if (metricInstruments.skillDurationSeconds) {
                metricInstruments.skillDurationSeconds.record(durationSeconds, skillAttrs)
              }
              log("[dsh-metrics] OTel skillDuration.record() succeeded:", {
                skillName: skillName2,
                durationMs,
                durationSeconds
              })
            } catch (error) {
              logError("[dsh-metrics] OTel skillDuration.record() failed:", {
                skillName: skillName2,
                durationMs,
                durationSeconds,
                error
              })
            }
          } else {
            log("[dsh-metrics] OTel skill duration not recorded:", {
              skillName: skillName2,
              durationMs,
              type: typeof durationMs
            })
          }
          log("[dsh-metrics] OTel skill metrics recording completed:", skillName2)
        } else {
          log("[dsh-metrics] OTel skill detected but no skill name parsed from args:", argsStr)
        }
      }
    } catch (error) {
      logError("[dsh-metrics] OTel tool metric recording failed:", { toolName, callId, error })
    }
  }
}

function buildCommonSpanAttrs(event: TurnEventRecord) {
  const attrs: Record<string, any> = {}
  attrs["gen_ai.call.type"] = "SDK"
  if (event["gen_ai.conversation.id"]) attrs["gen_ai.conversation.id"] = event["gen_ai.conversation.id"]
  else if (event["gen_ai.session.id"]) attrs["gen_ai.conversation.id"] = event["gen_ai.session.id"]
  if (event["gen_ai.turn.id"]) attrs["gen_ai.turn.id"] = event["gen_ai.turn.id"]
  if (event["user.id"]) attrs["gen_ai.user.id"] = event["user.id"]
  attrs["probe_version"] = PROBE_VERSION
  if (event["domain.id"]) attrs["domain.id"] = event["domain.id"]
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = event["gen_ai.resource.id"]
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = event["gen_ai.resource.type"]
  if (event["gen_ai.project.id"]) attrs["gen_ai.project.id"] = event["gen_ai.project.id"]
  if (event["gen_ai.call.status"]) attrs["gen_ai.call.status"] = event["gen_ai.call.status"]
  if (event["gen_ai.agent.type"]) attrs["gen_ai.agent.type"] = event["gen_ai.agent.type"]
  if (event["gen_ai.agent.name"]) attrs["gen_ai.agent.name"] = event["gen_ai.agent.name"]
  if (event["resource_version"]) attrs["resource_version"] = event["resource_version"]
  if (event["event.id"]) attrs["event.id"] = event["event.id"]
  if (event["event.name"]) attrs["event.name"] = event["event.name"]
  if (event["agent.dsh.cwd"]) attrs["agent.dsh.cwd"] = event["agent.dsh.cwd"]
  return attrs
}

function buildUsageStatusAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  if (event["user.id"]) attrs["user.id"] = String(event["user.id"])
  return attrs
}

function buildSessionCountAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  const convId = event["gen_ai.conversation.id"] || event["gen_ai.session.id"]
  if (convId) attrs["gen_ai.conversation.id"] = String(convId)
  return attrs
}

function buildGenerationAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string | boolean> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  const convId = event["gen_ai.conversation.id"] || event["gen_ai.session.id"]
  if (convId) attrs["gen_ai.conversation.id"] = String(convId)
  attrs["gen_ai.call.status"] = event["gen_ai.call.status"] !== false && event["gen_ai.call.status"] !== "false"
  return attrs
}

function buildLLMMetricAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string | boolean> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  const model = event["gen_ai.model.id"] || event["gen_ai.response.model"] || event["gen_ai.request.model"]
  if (model) attrs["gen_ai.model.id"] = String(model)
  attrs["gen_ai.call.status"] = event["gen_ai.call.status"] !== false && event["gen_ai.call.status"] !== "false"
  return attrs
}

function buildTTOMetricAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  const model = event["gen_ai.model.id"] || event["gen_ai.response.model"] || event["gen_ai.request.model"]
  if (model) attrs["gen_ai.model.id"] = String(model)
  return attrs
}

function buildToolMetricAttrs(event: TurnEventRecord) {
  const attrs: Record<string, string | boolean> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  if (event["gen_ai.tool.name"]) attrs["tool_name"] = String(event["gen_ai.tool.name"])
  const convId = event["gen_ai.conversation.id"] || event["gen_ai.session.id"]
  if (convId) attrs["gen_ai.conversation.id"] = String(convId)
  const callStatus = event["gen_ai.call.status"] !== false && event["gen_ai.call.status"] !== "false"
  attrs["gen_ai.call.status"] = callStatus
  return attrs
}

function parseSkillNameFromTool(callEvent: TurnEventRecord | undefined, resultEvent: TurnEventRecord | undefined) {
  const toolName = callEvent?.["gen_ai.tool.name"] || resultEvent?.["gen_ai.tool.name"]
  if (!toolName || String(toolName).toLowerCase() !== "skill") {
    return undefined
  }
  const argsStr = callEvent?.["gen_ai.tool.call.arguments"] || resultEvent?.["gen_ai.tool.call.arguments"]
  if (!argsStr) return undefined
  try {
    const parsed = JSON.parse(String(argsStr))
    const name = parsed.skill || parsed.name
    return name ? String(name) : undefined
  } catch {
    return undefined
  }
}

function buildSkillMetricAttrs(event: TurnEventRecord, skillName: string) {
  const attrs: Record<string, string | boolean> = {}
  if (event["domain.id"]) attrs["domain.id"] = String(event["domain.id"])
  if (event["gen_ai.resource.id"]) attrs["gen_ai.resource.id"] = String(event["gen_ai.resource.id"])
  if (event["gen_ai.resource.type"]) attrs["gen_ai.resource.type"] = String(event["gen_ai.resource.type"])
  const convId = event["gen_ai.conversation.id"] || event["gen_ai.session.id"]
  if (convId) attrs["gen_ai.conversation.id"] = String(convId)
  attrs["gen_ai.skill.name"] = skillName
  const callStatus = event["gen_ai.call.status"] !== false && event["gen_ai.call.status"] !== "false"
  attrs["gen_ai.call.status"] = callStatus
  return attrs
}

function sortByTime(events: TurnEventRecord[]) {
  return [...events].sort((a, b) => Number(a.time_unix_nano || 0) - Number(b.time_unix_nano || 0))
}

function toJsonAttr(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function messagesWithRole(event: TurnEventRecord | undefined, key: string, role: string) {
  const messages = event?.[key]
  if (!Array.isArray(messages)) return undefined
  const filtered = messages.filter((m) => m && m.role === role)
  return filtered.length > 0 ? filtered : undefined
}

function splitLlmCalls(llmEvents: TurnEventRecord[]) {
  const sorted = sortByTime(llmEvents)
  const groups = new Map<string, TurnEventRecord[]>()
  const order: string[] = []
  let seq = 0
  let openKey: string | null = null
  let lastRequestKey: string | null = null
  const groupOf = (key: string) => {
    let group = groups.get(key)
    if (group === undefined) {
      group = []
      groups.set(key, group)
      order.push(key)
    }
    return group
  }
  for (const e of sorted) {
    const attempt = e["dsh.llm.attempt"]
    let key: string
    if (typeof attempt === "number") {
      key = `attempt-${attempt}`
    } else if (e["event.name"] === "llm.request") {
      key = `seq-${seq++}`
    } else if (openKey !== null) {
      key = openKey
    } else if (lastRequestKey !== null) {
      key = lastRequestKey
    } else {
      key = `seq-${seq++}`
    }
    groupOf(key).push(e)
    if (e["event.name"] === "llm.request") {
      openKey = key
      lastRequestKey = key
    } else if (e["event.name"] === "llm.response") {
      openKey = null
    }
  }
  return order.map((k) => groups.get(k)!)
}

function setAttr(span: Span, key: string, value: AttributeValue | null | undefined) {
  if (value !== undefined && value !== null) {
    span.setAttribute(key, value)
  }
}

function nanoToMs(nano: string | undefined) {
  if (!nano) return Date.now()
  const n = Number(nano)
  if (!Number.isFinite(n)) return Date.now()
  return n / 1e6
}

/**
 * 归一化上报地址为可用的 gRPC URL。
 *
 * 上报地址不做强校验：以下形式都合法，按规则统一归一化即可，绝不拒绝输入。
 *   https://apm-access.cn-southwest-2.myhuaweicloud.com   （生产域名，TLS/443）
 *   http://10.0.0.1:4317                                 （内网明文 gRPC）
 *   aom-access.cn-southwest-2.myhuaweicloud.com:443      （域名:端口）
 *   10.0.0.1:4317                                        （IP:端口）
 *   10.0.0.1                                             （裸 IP，补内网默认端口）
 *   localhost                                            （裸主机名）
 *
 * 推断规则（仅补全缺省值，不改变已显式给出的部分）：
 *   已带 http(s)://            → 原样
 *   带端口且端口为 443          → 补 https://
 *   带端口（其他）              → 补 http://
 *   无端口、形如域名            → 补 https://（默认 443）
 *   无端口、形如 IPv4           → 补 http:// 与 :4317（内网 gRPC 默认端口）
 *   其余（localhost 等）        → 补 http://
 */
function toGrpcUrl(endpoint: string | undefined) {
  const ep = String(endpoint || "").trim()
  if (!ep) return ep
  if (/^https?:\/\//i.test(ep)) return ep
  // 域名:端口 / IP:端口
  const withPort = ep.match(/^([^/]+):(\d+)\/?$/)
  if (withPort) {
    const port = Number(withPort[2])
    return `${port === 443 ? "https" : "http"}://${withPort[1]}:${port}`
  }
  // 无端口：域名按生产 TLS 处理
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ep)) {
    return `https://${ep}`
  }
  // 无端口的裸 IPv4：沿用内网 gRPC 默认端口
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ep)) return `http://${ep}:4317`
  return `http://${ep}`
}

async function shutdownOtel() {
  const promises: Promise<void>[] = []
  if (tracerProvider) {
    log("[dsh-metrics] OTel shutting down APM (Traces)...")
    promises.push(
      tracerProvider
        .shutdown()
        .then(() => {
          tracerProvider = null
          tracer = null
          log("[dsh-metrics] OTel APM shutdown complete")
        })
        .catch((error: unknown) => {
          logError("[dsh-metrics] OTel APM shutdown failed:", error)
          tracerProvider = null
          tracer = null
        })
    )
  }
  if (meterProvider) {
    log("[dsh-metrics] OTel shutting down AOM (Metrics)...")
    promises.push(
      meterProvider
        .shutdown()
        .then(() => {
          meterProvider = null
          metricInstruments = null
          log("[dsh-metrics] OTel AOM shutdown complete")
        })
        .catch((error: unknown) => {
          logError("[dsh-metrics] OTel AOM shutdown failed:", error)
          meterProvider = null
          metricInstruments = null
        })
    )
  }
  await Promise.allSettled(promises)
  log("[dsh-metrics] OTel shutdown complete")
}

export {
  initOtel,
  beginRootSpan,
  reportEvents,
  shutdownOtel,
  setAgentName,
  setCaptureContentEnabled,
  exportWithRetry,
  toGrpcUrl
}

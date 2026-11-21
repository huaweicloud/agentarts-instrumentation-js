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

const SCOPE_NAME = "agentarts-instrumentation-dsh"

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
    if (attempt === 1) log(`[agentarts-dsh] ${label} exporting`, describe())
    rawExport(payload, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        log(`[agentarts-dsh] ${label} export SUCCESS`, { ...describe(), attempt })
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
        log(`[agentarts-dsh] ${label} export failed, retrying in ${delay}ms`, detail)
        setTimeout(run, delay)
        return
      }
      logError(`[agentarts-dsh] ${label} export FAILED`, detail)
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
    log("[agentarts-dsh] AsyncLocalStorageContextManager registered")
  }
  const apmEnabled = config.agentarts_agentops_otel_agent_apm_enable === true
  const aomEnabled = config.agentarts_agentops_otel_agent_aom_enable === true
  if (!apmEnabled && !aomEnabled) {
    log("[agentarts-dsh] OTel disabled (both APM and AOM are off)")
    return
  }
  diag.setLogger(
    {
      debug: (msg, ...args) => log("[agentarts-dsh] [OTel]", msg, ...args),
      info: (msg, ...args) => log("[agentarts-dsh] [OTel]", msg, ...args),
      warn: (msg, ...args) => log("[agentarts-dsh] [OTel][WARN]", msg, ...args),
      error: (msg, ...args) => logError("[agentarts-dsh] [OTel]", msg, ...args),
      verbose: () => {}
    },
    DiagLogLevel.INFO
  )
  log("[agentarts-dsh] OTel init config:", {
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
      log("[agentarts-dsh] APM (Traces) initialized", {
        endpoint: config.agentarts_agentops_apm_exporter_endpoint
      })
    } catch (error) {
      logError("[agentarts-dsh] APM init failed:", error)
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
              logDebug("[agentarts-dsh] AOM Token/Request Counter values:", tokenCounterDetails)
            }
            if (allMetricDetails.length > 0) {
              logDebug("[agentarts-dsh] AOM All Metric Details:", {
                count: allMetricDetails.length,
                details: allMetricDetails
              })
            }
            if (skillMetricDetails.length > 0) {
              logDebug("[agentarts-dsh] AOM Skill Metric Details:", {
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
      log("[agentarts-dsh] AOM (Metrics) initialized", {
        endpoint: aomEndpoint,
        protocol: "gRPC"
      })
    } catch (error) {
      logError("[agentarts-dsh] AOM init failed:", error)
    }
  }
}

/**
 * 根 span 的命名规则。
 *
 * 子 agent 若拿不到自己的名称（未收到 subagent/catalog），不能回退成配置里的
 * agent 名——那会和父 span 同名，在 APM 列表里无法区分。因此子 agent 统一
 * 兜底为 `invoke_agent subagent`；顶层会话仍用配置名（缺省 dsh_agent）。
 */
export function resolveRootSpanName(explicitAgentName: string | undefined, isSubagent: boolean) {
  if (explicitAgentName && explicitAgentName.length > 0) return `invoke_agent ${explicitAgentName}`
  if (isSubagent) return "invoke_agent subagent"
  return rootSpanName()
}

function beginRootSpan(
  startTime: number,
  parentContext: RootSpanContext | undefined,
  agentName: string | undefined,
  isSubagent = false
) {
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
    const spanName = resolveRootSpanName(agentName, isSubagent || !!parentContext)
    const span = tracer.startSpan(spanName, { startTime }, spanCtx)
    span.setAttribute("gen_ai.operation.name", "invoke_agent")
    span.setAttribute("gen_ai.span.kind", "AGENT")
    if (parentContext) span.setAttribute("dsh.subagent", true)
    const sc = span.spanContext()
    log("[agentarts-dsh] OTel root span begun:", {
      name: spanName,
      traceId: sc.traceId,
      spanId: sc.spanId,
      linked: !!parentContext
    })
    return { span, context: { traceId: sc.traceId, spanId: sc.spanId } }
  } catch (error) {
    logError("[agentarts-dsh] OTel beginRootSpan failed:", error)
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
    log("[agentarts-dsh] OTel reportEvents start:", { total: events.length, types: typeCounts })
    const turns = new Map<string, TurnEventRecord[]>()
    for (const event of events) {
      const turnId = event["gen_ai.turn.id"] || event.trace_id || "unknown"
      if (!turns.has(turnId)) turns.set(turnId, [])
      turns.get(turnId)!.push(event)
    }
    log("[agentarts-dsh] OTel processing", turns.size, "turn(s)")
    let rootSpanContext
    for (const [turnId, turnEvents] of turns) {
      const ctx = processTurn(turnId, turnEvents, handle)
      if (ctx) rootSpanContext = ctx
    }
    log("[agentarts-dsh] OTel reportEvents done")
    return rootSpanContext
  } catch (error) {
    logError("[agentarts-dsh] OTel reportEvents failed:", error)
    return undefined
  }
}

function processTurn(turnId: string, events: TurnEventRecord[], handle: RootSpanHandle | undefined) {
  events.sort((a, b) => {
    const ta = a.time_unix_nano ? Number(a.time_unix_nano) : 0
    const tb = b.time_unix_nano ? Number(b.time_unix_nano) : 0
    return ta - tb
  })
  logDebug("[agentarts-dsh] OTel processTurn:", turnId, "events:", events.length)
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
  log("[agentarts-dsh] OTel turn", turnId, "- LLM steps:", steps.size, "tool calls:", toolGroups.size)
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
      log("[agentarts-dsh] OTel root agent span created:", turnId)
    } catch (error) {
      logError("[agentarts-dsh] OTel root agent span creation failed:", { turnId, error })
    }
  }
  if (metricInstruments && otherEvent) {
    try {
      const userId = String(otherEvent["user.id"] || "")
      if (userId) {
        const statusAttrs = buildUsageStatusAttrs(otherEvent)
        metricInstruments.usageStatusGauge.record(1, statusAttrs)
        log("[agentarts-dsh] OTel usage status gauge recorded:", { userId, attrs: statusAttrs })
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
      log("[agentarts-dsh] OTel agent metrics recorded:", { turnId, turnDurationS })
    } catch (error) {
      logError("[agentarts-dsh] OTel agent metric recording failed:", { turnId, error })
    }
  }
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheWriteTokens = 0
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
      logDebug("[agentarts-dsh] OTel react step created:", {
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
        logDebug("[agentarts-dsh] Step event timestamps:", {
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
            totalCacheReadTokens += callResp.cacheReadTokens || 0
            totalCacheWriteTokens += callResp.cacheWriteTokens || 0
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
          // 该 step 内任一 LLM 调用或工具调用失败，step 整体记为 ERROR
          const stepEvents = [...unit.llmEvents, ...unit.toolEvents]
          applySpanStatus(stepSpan, !eventsHaveFailure(stepEvents), firstErrorMessage(stepEvents))
          stepSpan.end(nanoToMs(String(lastNano)))
          log("[agentarts-dsh] OTel react step closed:", {
            stepId: unit.stepId,
            startNano: unit.startNano,
            lastNano,
            durationS: lastNano > unit.startNano ? (lastNano - unit.startNano) / 1e9 : 0,
            llmEvents: unit.llmEvents.length,
            toolEvents: unit.toolEvents.length
          })
        } catch (error) {
          logError("[agentarts-dsh] OTel react step end failed:", { error })
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
      log("[agentarts-dsh] OTel intent skill metrics recorded:", {
        turnId,
        intentSkillName,
        turnDurationS,
        attrs: skillAttrs
      })
    } catch (error) {
      logError("[agentarts-dsh] OTel intent skill metric recording failed:", { turnId, intentSkillName, error })
    }
  }
  if (rootSpan) {
    try {
      const usageAttrs = rootUsageAttributes({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens
      })
      for (const [key, value] of Object.entries(usageAttrs)) {
        rootSpan.setAttribute(key, value)
      }
      const failedResponse = [...events].reverse().find((e) => e["event.name"] === "llm.response" && e["error.type"])
      if (failedResponse) {
        const errMsg = String(failedResponse["error.message"] || failedResponse["error.type"]).slice(0, 500)
        rootSpan.setAttribute("gen_ai.call.status", false)
        applySpanStatus(rootSpan, false, errMsg)
        log("[agentarts-dsh] OTel root agent span marked ERROR:", { turnId, errorMessage: errMsg })
      } else {
        // 成功路径显式置 OK（默认 UNSET 会让平台无法判定成功）
        applySpanStatus(rootSpan, true)
      }
      rootSpan.end(nanoToMs(events[events.length - 1].time_unix_nano))
      const sc = rootSpan.spanContext()
      rootSpanCtx = { traceId: sc.traceId, spanId: sc.spanId }
      log("[agentarts-dsh] OTel root agent span ended:", turnId, {
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        totalCacheReadTokens,
        totalCacheWriteTokens
      })
    } catch (error) {
      logError("[agentarts-dsh] OTel root agent span end failed:", { turnId, error })
    }
  }
  return rootSpanCtx
}

/**
 * 从一次 LLM 调用的事件中提取 token 用量。
 *
 * 单次 LLM span 与根 span 的累计值都走这里，保证两处口径一致——
 * 尤其是缓存读写 token：它们只出现在 llm.response 事件上，
 * 早期实现漏掉了它们，导致根节点没有累计值。
 */
export function llmUsageFromEvents(events: TurnEventRecord[]) {
  const responseEvent = events.find((e) => e["event.name"] === "llm.response")
  if (!responseEvent) return null
  const num = (value: unknown) => (typeof value === "number" ? value : 0)
  return {
    inputTokens: num(responseEvent["gen_ai.usage.input_tokens"]),
    outputTokens: num(responseEvent["gen_ai.usage.output_tokens"]),
    totalTokens: num(responseEvent["gen_ai.usage.total_tokens"]),
    cacheReadTokens: num(responseEvent["gen_ai.usage.cache_read.input_tokens"]),
    cacheWriteTokens: num(responseEvent["gen_ai.usage.cache_write.input_tokens"])
  }
}

/**
 * 根 span 的 token 用量属性。
 *
 * 缓存读写 token 与 input/output 同一口径在根节点汇总；为 0 时不写属性，
 * 避免为未启用缓存的调用产出无意义的 0。
 */
export function rootUsageAttributes(totals: {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}) {
  const attrs: Record<string, number> = {
    "gen_ai.usage.input_tokens": totals.inputTokens,
    "gen_ai.usage.output_tokens": totals.outputTokens,
    "gen_ai.usage.total_tokens": totals.totalTokens
  }
  if (totals.cacheReadTokens > 0) {
    attrs["gen_ai.usage.cache_read.input_tokens"] = totals.cacheReadTokens
  }
  if (totals.cacheWriteTokens > 0) {
    attrs["gen_ai.usage.cache_write.input_tokens"] = totals.cacheWriteTokens
    // 与单次 LLM span 保持一致：cache_creation 是 cache_write 的别名
    attrs["gen_ai.usage.cache_creation.input_tokens"] = totals.cacheWriteTokens
  }
  return attrs
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
  logDebug("[agentarts-dsh] OTel LLM span:", { stepId, model, provider, hasRequest: !!requestEvent, hasResponse: !!responseEvent })
  if (tracer) {
    try {
      const llmSpanName = model ? `chat ${model}` : "chat"
      const span = tracer.startSpan(llmSpanName, {
        startTime,
        attributes: buildCommonSpanAttrs(requestEvent || responseEvent!)
      })
      span.setAttribute("gen_ai.operation.name", "chat")
      span.setAttribute("gen_ai.span.kind", "LLM")
      if (requestEvent) {
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
          applySpanStatus(span, false, responseEvent["error.message"] || responseEvent["error.type"])
        } else {
          // 成功路径必须显式置 OK，否则会停留在 UNSET
          applySpanStatus(span, true)
        }
      }
      span.end(spanEndTime)
      log("[agentarts-dsh] OTel LLM span created:", stepId)
    } catch (error) {
      logError("[agentarts-dsh] OTel LLM span creation failed:", { stepId, error })
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
      log("[agentarts-dsh] OTel LLM metrics recorded:", { stepId, inputTokens, outputTokens, model, llmDurationS, ttft, tbt })
    } catch (error) {
      logError("[agentarts-dsh] OTel LLM metric recording failed:", { stepId, error })
    }
  }
  if (metricInstruments && requestEvent) {
    try {
      const sessionId = String(requestEvent["gen_ai.session.id"] || requestEvent["gen_ai.conversation.id"] || "")
      if (sessionId) {
        const countAttrs = buildSessionCountAttrs(requestEvent)
        metricInstruments.sessionCountGauge.record(1, countAttrs)
        log("[agentarts-dsh] OTel session count gauge recorded:", { sessionId, attrs: countAttrs })
      }
    } catch (error) {
      logError("[agentarts-dsh] OTel session count failed:", { stepId, error })
    }
  }
  if (responseEvent) {
    return llmUsageFromEvents(events)
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
  logDebug("[agentarts-dsh] OTel tool span:", { toolName, callId, hasCall: !!callEvent, hasResult: !!resultEvent })
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
      // 工具描述：来自 LLM 请求携带的工具定义（tool/call 事件本身不含描述）
      setAttr(span, "gen_ai.tool.description", callEvent?.["gen_ai.tool.description"] ?? resultEvent?.["gen_ai.tool.description"])
      if (skillName) {
        setAttr(span, "gen_ai.skill.name", skillName)
      }
      if (callEvent) {
        setAttr(span, "gen_ai.tool.name", callEvent["gen_ai.tool.name"])
        setAttr(span, "gen_ai.tool.call.id", callEvent["gen_ai.tool.call.id"])
        if (captureContent()) {
          setAttr(span, "gen_ai.tool.call.arguments", callEvent["gen_ai.tool.call.arguments"])
        }
      }
      if (resultEvent) {
        setAttr(span, "gen_ai.tool.name", resultEvent["gen_ai.tool.name"])
        setAttr(span, "gen_ai.tool.call.id", resultEvent["gen_ai.tool.call.id"])
        if (captureContent()) {
          setAttr(span, "gen_ai.tool.call.result", resultEvent["gen_ai.tool.call.result"])
        }
      }
      const toolCallStatus = resultEvent
        ? resultEvent["gen_ai.call.status"] !== false && resultEvent["gen_ai.call.status"] !== "false"
        : true
      setAttr(span, "gen_ai.call.status", toolCallStatus)
      // 工具失败（含 step 结束前没有结果、结果里带 error.type）一律置 ERROR
      if (!toolCallSucceeded(resultEvent)) {
        applySpanStatus(
          span,
          false,
          resultEvent?.["error.message"] || resultEvent?.["error.type"] || `tool ${String(toolName || "unknown")} failed`
        )
      } else {
        applySpanStatus(span, true)
      }

      span.end(endTime)
      log("[agentarts-dsh] OTel tool span created:", toolName, callId)
    } catch (error) {
      logError("[agentarts-dsh] OTel tool span creation failed:", { toolName, callId, error })
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
      log("[agentarts-dsh] OTel tool metrics recorded:", toolName)
      if (skipSkillMetrics) {
        log("[agentarts-dsh] OTel skip tool-level skill metrics (intent already recorded):", toolName)
      } else if (toolName && toolName.toLowerCase() === "skill") {
        const skillName2 = parseSkillNameFromTool(callEvent, resultEvent)
        if (skillName2) {
          const skillAttrs = buildSkillMetricAttrs(metricEvent, skillName2)
          logDebug("[agentarts-dsh] OTel skill metric attributes:", {
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
            log("[agentarts-dsh] OTel skillCallCount.add(1) succeeded for:", skillName2)
          } catch (error) {
            logError("[agentarts-dsh] OTel skillCallCount.add(1) failed:", { skillName: skillName2, error })
          }
          try {
            metricInstruments.skillCallCountTotal.add(1, skillAttrs)
            log("[agentarts-dsh] OTel skillCallCountTotal.add(1) succeeded for:", skillName2)
          } catch (error) {
            logError("[agentarts-dsh] OTel skillCallCountTotal.add(1) failed:", { skillName: skillName2, error })
          }
          if (skillAttrs["gen_ai.call.status"] === false) {
            try {
              metricInstruments.skillErrorCount.add(1, skillAttrs)
              log("[agentarts-dsh] OTel skillErrorCount.add(1) succeeded for failed skill:", skillName2)
            } catch (error) {
              logError("[agentarts-dsh] OTel skillErrorCount.add(1) failed:", { skillName: skillName2, error })
            }
          }
          if (typeof durationMs === "number" && durationMs > 0) {
            const durationSeconds = durationMs / 1e3
            try {
              metricInstruments.skillDuration.record(durationSeconds, skillAttrs)
              if (metricInstruments.skillDurationSeconds) {
                metricInstruments.skillDurationSeconds.record(durationSeconds, skillAttrs)
              }
              log("[agentarts-dsh] OTel skillDuration.record() succeeded:", {
                skillName: skillName2,
                durationMs,
                durationSeconds
              })
            } catch (error) {
              logError("[agentarts-dsh] OTel skillDuration.record() failed:", {
                skillName: skillName2,
                durationMs,
                durationSeconds,
                error
              })
            }
          } else {
            log("[agentarts-dsh] OTel skill duration not recorded:", {
              skillName: skillName2,
              durationMs,
              type: typeof durationMs
            })
          }
          log("[agentarts-dsh] OTel skill metrics recording completed:", skillName2)
        } else {
          log("[agentarts-dsh] OTel skill detected but no skill name parsed from args:", argsStr)
        }
      }
    } catch (error) {
      logError("[agentarts-dsh] OTel tool metric recording failed:", { toolName, callId, error })
    }
  }
}

// 子 agent 归属信息：这些字段由 coordinator 写在事件上，但此前没有复制到 span，
// 导致在 APM 里只能靠 trace 层级看父子关系，无法按父会话 ID 过滤或聚合。
export function buildCommonSpanAttrs(event: TurnEventRecord) {
  const attrs: Record<string, any> = {}
  if (event["gen_ai.conversation.id"]) attrs["gen_ai.conversation.id"] = event["gen_ai.conversation.id"]
  else if (event["gen_ai.session.id"]) attrs["gen_ai.conversation.id"] = event["gen_ai.session.id"]
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
  // ── 子 agent 归属 ──
  // 父会话 ID：即便关闭 trace 串联，也能据此把子 span 归到父会话之下
  if (event["dsh.session.parent_id"]) attrs["dsh.session.parent_id"] = event["dsh.session.parent_id"]
  // 委派深度：0 是有效值，需用 undefined 判断而非真值判断

  if (event["dsh.session.origin"]) attrs["dsh.session.origin"] = event["dsh.session.origin"]
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

/**
 * 统一设置 span 状态。
 *
 * OTel 的默认状态是 UNSET，必须在成功路径上显式置为 OK，否则平台侧无法区分
 * "成功"与"未设置"。失败路径统一置 ERROR，并附带截断后的错误信息。
 */
export function applySpanStatus(span: Span, ok: boolean, message?: unknown) {
  if (ok) {
    span.setStatus({ code: SpanStatusCode.OK })
    return
  }
  // ERROR 必须带 status_message，否则平台侧显示为空、无法据此排障
  const text = message === undefined || message === null || message === "" ? "unknown error" : String(message).slice(0, 500)
  span.setStatus({ code: SpanStatusCode.ERROR, message: text })
}

/** 工具调用是否成功：无结果事件视为成功，结果显式标记失败或带 error.type 视为失败。 */
export function toolCallSucceeded(resultEvent: TurnEventRecord | undefined): boolean {
  if (!resultEvent) return true
  const status = resultEvent["gen_ai.call.status"]
  if (status === false || status === "false") return false
  return !resultEvent["error.type"]
}

/** 这组事件里是否存在失败（LLM 响应或工具结果带 error.type）。 */
export function eventsHaveFailure(events: TurnEventRecord[]): boolean {
  return events.some((e) => e["error.type"])
}

/** 从一组事件里取第一条错误信息，用于 span 的 status message。 */
function firstErrorMessage(events: TurnEventRecord[]): string | undefined {
  for (const event of events) {
    if (!event["error.type"] && !event["error.message"]) continue
    return String(event["error.message"] || event["error.type"])
  }
  return undefined
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
  // 无端口的裸 IPv4：沿用内网 gRPC 默认端口（必须在域名判断之前：
  // 数字同样满足域名字符集，先判域名会把 10.0.0.1 误当成公网域名）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ep)) return `http://${ep}:4317`
  // 无端口：域名按生产 TLS 处理
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ep)) {
    return `https://${ep}`
  }
  return `http://${ep}`
}

async function shutdownOtel() {
  const promises: Promise<void>[] = []
  if (tracerProvider) {
    log("[agentarts-dsh] OTel shutting down APM (Traces)...")
    promises.push(
      tracerProvider
        .shutdown()
        .then(() => {
          tracerProvider = null
          tracer = null
          log("[agentarts-dsh] OTel APM shutdown complete")
        })
        .catch((error: unknown) => {
          logError("[agentarts-dsh] OTel APM shutdown failed:", error)
          tracerProvider = null
          tracer = null
        })
    )
  }
  if (meterProvider) {
    log("[agentarts-dsh] OTel shutting down AOM (Metrics)...")
    promises.push(
      meterProvider
        .shutdown()
        .then(() => {
          meterProvider = null
          metricInstruments = null
          log("[agentarts-dsh] OTel AOM shutdown complete")
        })
        .catch((error: unknown) => {
          logError("[agentarts-dsh] OTel AOM shutdown failed:", error)
          meterProvider = null
          metricInstruments = null
        })
    )
  }
  await Promise.allSettled(promises)
  log("[agentarts-dsh] OTel shutdown complete")
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

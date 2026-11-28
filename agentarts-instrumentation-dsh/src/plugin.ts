// DSH 插件入口：服务类默认导出。
// 订阅 session 生命周期事件 + 拦截 llm/stream，把 DSH 运行时观测数据
// 经 coordinator 聚合后由 otel-reporter 上报 AgentArts APM（trace）/AOM（metric）。
// 运行参数从 ~/.dsh/plugins/agentarts-instrumentation-dsh/config.json 读取。
import * as os from "node:os"
import * as path from "node:path"
import { CONFIG_PATH, detectDshVersion, loadConfig, resolveOutputDir, resolveReportingState, validateConfig, watchConfig } from "./config.js"
import { initLogger, log, logError, setDebugEnabled, setLogRetentionDays } from "./logger.js"
import { DshTraceCoordinator } from "./coordinator.js"
import {
  beginRootSpan,
  initOtel,
  reportEvents,
  setAgentName,
  setCaptureContentEnabled,
  shutdownOtel
} from "./otel-reporter.js"
import { PROBE_VERSION } from "./probe-version.generated.js"

// ~standard 校验型 Config：cordis 行的 config 节点（仅 enabled 开关，业务参数在 config.json）
const ConfigSchema = {
  "~standard": {
    version: 1,
    vendor: "agentarts-dsh",
    validate(value: any) {
      if (value === null || value === undefined) return { value: { enabled: true } }
      return { value: { enabled: value.enabled !== false } }
    }
  }
}

export default class DshMetricsPlugin {
  static inject = ["sessions"]
  static Config = ConfigSchema
  coordinator: DshTraceCoordinator | null = null

  constructor(ctx: any, cordisConfig: { enabled?: boolean }) {
    const dsh = ctx
    if (cordisConfig.enabled === false) {
      dsh.logger.info("[agentarts-dsh] collection is disabled by cordis config")
      return
    }
    const config = loadConfig()
    if (!config.enabled) {
      dsh.logger.info("[agentarts-dsh] collection is disabled")
      return
    }
    // 未配置任何上报通道时保持完全惰性：不建日志、不建 coordinator、
    // 不订阅会话事件、不拦截 llm/stream，避免给未接入的 profile 增加开销。
    const reporting = resolveReportingState(config)
    if (!reporting.ready) {
      const detail = reporting.missing.length > 0 ? ` (incomplete: ${reporting.missing.join(", ")})` : ""
      dsh.logger.info(
        `[agentarts-dsh] not configured, plugin stays idle${detail}; set APM/AOM settings in ${CONFIG_PATH} or via environment variables`
      )
      return
    }
    const outputDir = resolveOutputDir(config)
    const logsDir = path.join(outputDir, "logs")
    initLogger(logsDir, config.features?.logRetentionDays ?? 14)
    setDebugEnabled(config.features.debug)
    setCaptureContentEnabled(config.features.captureMessageContent)
    setAgentName(config.agent_name)
    log("[agentarts-dsh] plugin starting, version:", PROBE_VERSION)
    log("[agentarts-dsh] config loaded:", {
      outputDir,
      debug: config.features.debug,
      captureMessageContent: config.features.captureMessageContent,
      // 资源版本上报值：自动探测的 DSH 版本
      resourceVersion: detectDshVersion(),
      apmEnabled: config.otel?.agentarts_agentops_otel_agent_apm_enable ?? false,
      aomEnabled: config.otel?.agentarts_agentops_otel_agent_aom_enable ?? false
    })
    // 启动校验：字段拼写/缺失/类型问题集中告警（仅告警，不阻止运行）
    for (const issue of validateConfig(config)) {
      const message = `[agentarts-dsh] config warning [${issue.field}]: ${issue.message}`
      dsh.logger.warn(message)
      logError(message)
    }
    // 只启用确定可用的通道：声明开启但缺字段的那一路不注册导出器
    initOtel({
      ...config.otel,
      agentarts_agentops_otel_agent_apm_enable: reporting.apmEnabled,
      agentarts_agentops_otel_agent_aom_enable: reporting.aomEnabled
    })
    log("[agentarts-dsh] OTel initialized", {
      apm: reporting.apmEnabled,
      aom: reporting.aomEnabled
    })
    const userId = config["user.id"] || os.hostname()
    this.coordinator = new DshTraceCoordinator(config, userId, dsh.logger)
    this.coordinator.onTurnStart = (startTime, parentContext, subagentName, isSubagent) => {
      return beginRootSpan(startTime, parentContext, subagentName, isSubagent)
    }
    this.coordinator.onTurnComplete = (events, handle) => {
      if (events.length === 0) return undefined
      log("[agentarts-dsh] reporting turn events:", events.length, handle ? "(pre-created root span)" : "")
      return reportEvents(events, handle)
    }
    for (const session of dsh.sessions.list()) this.coordinator.adoptSession(session)
    // 热重载：轻量字段（features/agent_name）即时生效；otel/enabled/outputDir/user.id
    // 变更只提示重启（OTel 管线与 userId 在构造期绑定，不支持热切换）。
    const reportIssues = (target: Record<string, any>) => {
      for (const issue of validateConfig(target)) {
        const message = `[agentarts-dsh] config warning [${issue.field}]: ${issue.message}`
        dsh.logger.warn(message)
        logError(message)
      }
    }
    const stopConfigWatch = watchConfig(
      CONFIG_PATH,
      (next) => {
        const restartReasons: string[] = []
        if (JSON.stringify(config.otel ?? null) !== JSON.stringify(next.otel ?? null)) {
          restartReasons.push("otel (reporting settings)")
        }
        if (config.enabled !== next.enabled) restartReasons.push("enabled")
        if (config.outputDir !== next.outputDir) restartReasons.push("outputDir")
        if (config["user.id"] !== next["user.id"]) restartReasons.push("user.id")
        // 原地更新共享 config 对象（coordinator 持有同一引用，features 开关即时生效）
        config.features.debug = next.features.debug
        config.features.captureMessageContent = next.features.captureMessageContent
        config.features.linkSubagentTrace = next.features.linkSubagentTrace
        config.features.logRetentionDays = next.features.logRetentionDays
        config.agent_name = next.agent_name
        setDebugEnabled(next.features.debug)
        setCaptureContentEnabled(next.features.captureMessageContent)
        setAgentName(next.agent_name)
        setLogRetentionDays(next.features.logRetentionDays)
        reportIssues(next)
        log("[agentarts-dsh] config reloaded (hot-applied: features, agent_name)")
        dsh.logger.info("[agentarts-dsh] config reloaded; features and agent_name applied without restart")
        if (restartReasons.length > 0) {
          const message = `[agentarts-dsh] config change requires a DSH restart to take effect: ${restartReasons.join(", ")}`
          dsh.logger.warn(message)
          logError(message)
        }
      },
      (error) => {
        const message = `[agentarts-dsh] config.json changed but failed to parse; keeping current config: ${String(error)}`
        dsh.logger.warn(message)
        logError(message)
      }
    )
    const disposers = [
      stopConfigWatch,
      dsh.on("session/created", (session: any) => {
        try {
          this.coordinator!.adoptSession(session)
        } catch (error) {
          dsh.logger.warn(`[agentarts-dsh] failed to adopt session ${String(session.id)}: ${String(error)}`)
        }
      }),
      dsh.on("session/event", (session: any, event: any) => this.coordinator!.onSessionEvent(session, event)),
      dsh.on("session/disposed", (session: any) => {
        try {
          this.coordinator!.disposeSession(session)
        } catch (error) {
          dsh.logger.warn(`[agentarts-dsh] failed to dispose session ${String(session.id)}: ${String(error)}`)
        }
      }),
      dsh.on("llm/stream", (options: any, next: () => AsyncIterable<any>) => this.coordinator!.interceptLlm(options, next))
    ]
    dsh.effect(
      () => async () => {
        for (const dispose of disposers.reverse()) dispose()
        try {
          this.coordinator?.closeAll()
        } catch (error) {
          dsh.logger.warn(`[agentarts-dsh] failed to close live spans: ${String(error)}`)
        }
        await shutdownOtel()
        log("[agentarts-dsh] plugin unloaded")
      },
      "agentarts-dsh: detach listeners and shutdown OTLP"
    )
    const traceEndpoint = config.otel?.agentarts_agentops_apm_exporter_endpoint ?? "(not configured)"
    const metricEndpoint = config.otel?.agentarts_agentops_aom_exporter_endpoint ?? "(not configured)"
    dsh.logger.info(
      `[agentarts-dsh] loaded; traces=${traceEndpoint}; metrics=${metricEndpoint}; content=${
        config.features.captureMessageContent ? "enabled" : "disabled"
      }`
    )
    log("[agentarts-dsh] plugin loaded successfully")
  }
}

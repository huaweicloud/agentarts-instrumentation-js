// 会话/turn/step/LLM/工具事件协调器：
// 订阅 DSH session 事件与 llm/stream 拦截，聚合成 AgentArts 事件记录
//（EventRecord），turn 结束时交给 otel-reporter 生成 span / metric。
import {
  mapContent,
  mapFinishReason,
  mapInputMessage,
  mapInputMessages,
  mapOutputMessage,
  mapSystemInstruction,
  mapToolDefinitions,
  applyUsageToRecord,
  extractToolResultText,
  llmRequestAttributes
} from "./mapping.js"
import { logDebug, logError } from "./logger.js"
import type { Span } from "@opentelemetry/api"

export interface RootSpanContext {
  traceId: string
  spanId: string
}

export interface RootSpanHandle {
  span: Span
  context: RootSpanContext
}

/** AgentArts 事件记录（gen_ai.* 规范字段 + 事件元数据） */
export interface TurnEventRecord {
  "time_unix_nano": string
  "event.name": string
  [key: string]: any
}

interface DshLogger {
  debug?: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
}

interface DshSession {
  id: string | number
  header: {
    cwd?: string
    parentSession?: string | number
    origin?: string
    delegationDepth?: number
    agentPreset?: string
  }
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface TurnEndReason {
  kind: "stop" | "error" | "aborted" | "interrupted" | (string & {})
  error?: { message: string; code: string }
}

interface LlmFinishReason {
  kind: "stop" | "tool-calls" | "max-tokens" | "error" | "aborted" | (string & {})
  failure?: { message: string; code: string }
}

interface ToolCallState {
  callId: string
  name: string
  startTimeMs: number
  arguments: string
  ended: boolean
}

interface LlmStreamState {
  options: any
  attempt: number
  inputMessages: any[]
  blocks: any[]
  ended: boolean
  firstTokenSeen: boolean
  tokenCount: number
  startTimeMs: number
  firstTokenMs: number | null
  lastTokenMs: number | null
  usage?: any
}

interface StepState {
  turn: number
  step: number
  startTimeMs: number
  tools: Map<string, ToolCallState>
  llms: Set<LlmStreamState>
  nextAttempt: number
  lastEndTimeMs: number
  lastFinishReason?: string
}

interface TurnState {
  session: DshSession
  turn: number
  startTimeMs: number
  step?: StepState
  contextMessages: any[]
  inputs: any[]
  outputs: any[]
  usage: UsageTotals
  events: TurnEventRecord[]
  traceId: string
  ended: boolean
  rootSpanHandle?: RootSpanHandle
}

interface SessionState {
  session: DshSession
  turn?: TurnState
  parentSessionId?: string
}

export interface CoordinatorConfig {
  agent_name: string
  features: { debug: boolean; captureMessageContent: boolean; linkSubagentTrace: boolean }
  otel?: {
    agent_domain_id?: string
    agentarts_project_id?: string
    agent_resource_id?: string
    resource_type?: string
    resource_version?: string
  }
}

function nowNanos() {
  return String(Date.now() * 1e6)
}

function msToNanos(ms: number) {
  return String(Math.round(ms * 1e6))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function finishFailure(reason: TurnEndReason): { message: string; code: string } | undefined {
  if (reason.kind === "error") {
    const value = reason.error
    return value ?? { message: "DSH turn ended with an error", code: "ERROR" }
  }
  if (reason.kind === "aborted") {
    return { message: "DSH turn was aborted", code: "ABORTED" }
  }
  if (reason.kind === "interrupted") {
    return { message: "DSH turn was interrupted", code: "INTERRUPTED" }
  }
  return undefined
}

function usageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addUsage(total: UsageTotals, usage: any) {
  total.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += usage.cacheReadTokens ?? 0
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

function isVisibleToken(chunk: any) {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    return typeof chunk.text === "string" && chunk.text !== ""
  }
  if (chunk.type !== "tool-call-delta") return false
  const value = chunk
  return value.name !== undefined || (typeof value.argumentsDelta === "string" && value.argumentsDelta !== "")
}

function scalarAttributes(session: DshSession, turn: number, agentName: string) {
  const header = session.header
  return {
    "gen_ai.session.id": String(session.id),
    "gen_ai.turn.id": `${String(session.id)}:${turn}`,
    "dsh.session.id": String(session.id),
    "dsh.turn": turn,
    ...(header.parentSession === undefined ? {} : { "dsh.session.parent_id": String(header.parentSession) }),
    ...(header.origin === undefined ? {} : { "dsh.session.origin": header.origin }),
    // gen_ai.agent.name 从配置 agent_name 读取（为空兜底 deepseek-harness）
    "gen_ai.agent.name": agentName || "deepseek-harness"
  }
}

export class DshTraceCoordinator {
  config: CoordinatorConfig
  userId: string
  logger: DshLogger

  constructor(config: CoordinatorConfig, userId: string, logger: DshLogger) {
    this.config = config
    this.userId = userId
    this.logger = logger
  }
  sessions = new Map<string, SessionState>()
  // 工具名 -> 描述（来自 LLM 请求携带的工具定义，用于 tool span 的属性）
  toolDescriptions = new Map<string, string>()
  // ── 子 agent trace 串联（方案 B：提前创建 root span，无缓冲） ──
  // 活跃 turn 的 root span context 注册表：key = sessionId
  //（startTurn 时写入，closeTurn/disposeSession 时清除；子 turn/start 查父用）
  rootSpanRegistry = new Map<string, RootSpanContext>()
  // 子 agent 独立名称：key = childSessionId，value = subagent/catalog 事件注册的 name
  //（父 session 的 catalog 事件写入；子 startTurn 查名用于 root span 名）
  subagentNames = new Map<string, string>()

  adoptSession(session: DshSession) {
    const id = String(session.id)
    const previous = this.sessions.get(id)
    if (previous?.session === session) return
    if (previous?.turn !== undefined) {
      this.closeTurn(previous, { kind: "interrupted" }, Date.now())
    }
    const parentSessionId = session.header.parentSession ? String(session.header.parentSession) : undefined
    this.sessions.set(id, { session, turn: undefined, parentSessionId })
    this.debug(`adopted session ${id}${parentSessionId ? ` (child of ${parentSessionId})` : ""}`)
  }

  disposeSession(session: DshSession) {
    const state = this.sessions.get(String(session.id))
    if (state === undefined || state.session !== session) return
    if (state.turn !== undefined) this.closeTurn(state, { kind: "interrupted" }, Date.now())
    this.sessions.delete(String(session.id))
    this.rootSpanRegistry.delete(String(session.id))
    this.subagentNames.delete(String(session.id))
    this.debug(`disposed session ${String(session.id)}`)
  }

  onSessionEvent(session: DshSession, event: { type: string; time: number; data: any }) {
    try {
      const state = this.ensureSession(session)
      switch (event.type) {
        case "turn/start":
          this.startTurn(state, event.data.turn, event.time)
          break
        case "turn/end": {
          const data = event.data
          if (state.turn?.turn === data.turn) this.closeTurn(state, data.reason, event.time)
          break
        }
        case "step/start": {
          const data = event.data
          this.startStep(state, data.turn, data.step, event.time)
          break
        }
        case "step/end": {
          const data = event.data
          const step = state.turn?.step
          if (step?.turn === data.turn && step.step === data.step) {
            this.closeStep(state.turn!, event.time)
          }
          break
        }
        case "user/message":
          this.captureTurnInput(state, event.data)
          break
        case "assistant/message": {
          const data = event.data
          this.captureTurnOutput(state, data.turn, data.step, data.message)
          break
        }
        case "tool/call": {
          const data = event.data
          this.startTool(state, data, event.time)
          break
        }
        case "subagent/catalog": {
          const data = event.data
          if (data.childId && data.name) {
            this.subagentNames.set(data.childId, data.name)
            const childState = this.sessions.get(data.childId)
            const handle = childState?.turn?.rootSpanHandle
            if (handle?.span?.updateName) {
              try {
                handle.span.updateName(`invoke_agent ${data.name}`)
                this.debug(`updated root span name for late catalog: ${data.childId} → ${data.name}`)
              } catch {
                // span 已结束等情况：忽略
              }
            }
          }
          break
        }
        case "tool/result": {
          const data = event.data
          this.endTool(state, data, event.time)
          break
        }
      }
    } catch (error) {
      this.warn(`failed to observe ${event.type} for session ${String(session.id)}: ${errorMessage(error)}`)
    }
  }

  interceptLlm(options: any, next: () => AsyncIterable<any>) {
    if (options.sessionId === undefined || options.purpose !== undefined) return next()
    let llm
    try {
      llm = this.startLlm(options)
    } catch (error) {
      this.warn(`failed to start LLM telemetry for session ${options.sessionId}: ${errorMessage(error)}`)
    }
    let stream: AsyncIterable<any>
    try {
      stream = next()
    } catch (error) {
      if (llm !== undefined) this.failLlm(llm, error, Date.now())
      throw error
    }
    return llm === undefined ? stream : this.observeLlmStream(llm, stream)
  }

  closeAll(reason = "plugin unloaded") {
    const now = Date.now()
    for (const state of this.sessions.values()) {
      if (state.turn !== undefined) {
        this.closeTurn(state, { kind: "error", error: { message: reason, code: "PLUGIN_UNLOADED" } }, now)
      }
    }
    this.sessions.clear()
    this.rootSpanRegistry.clear()
  }

  // -------------------------------------------------------------------------
  // private: session 管理
  // -------------------------------------------------------------------------
  private ensureSession(session: DshSession): SessionState {
    const id = String(session.id)
    const existing = this.sessions.get(id)
    if (existing?.session === session) return existing
    this.adoptSession(session)
    return this.sessions.get(id)!
  }

  // -------------------------------------------------------------------------
  // private: turn 生命周期
  // -------------------------------------------------------------------------
  private startTurn(state: SessionState, turn: number, startTime: number) {
    if (state.turn !== undefined) {
      this.closeTurn(state, { kind: "interrupted" }, startTime)
    }
    const sessionId = String(state.session.id)
    const traceId = `${sessionId}:${turn}:${Date.now()}`
    const parentCtx =
      state.parentSessionId && this.config.features.linkSubagentTrace
        ? this.rootSpanRegistry.get(state.parentSessionId)
        : undefined
    const subagentName = this.subagentNames.get(sessionId)
    // 是否子会话：与 trace 串联开关无关，用于子 agent span 的命名兜底
    const isSubagent = state.parentSessionId !== undefined
    const rootSpanHandle = this.onTurnStart?.(startTime, parentCtx, subagentName, isSubagent)
    state.turn = {
      session: state.session,
      turn,
      startTimeMs: startTime,
      step: undefined,
      contextMessages: [],
      inputs: [],
      outputs: [],
      usage: usageTotals(),
      events: [],
      traceId,
      ended: false,
      rootSpanHandle
    }
    if (rootSpanHandle) {
      this.rootSpanRegistry.set(sessionId, rootSpanHandle.context)
    }
    const turnEvent = this.createBaseEvent(state.session, turn, "other")
    turnEvent.time_unix_nano = msToNanos(startTime)
    turnEvent["gen_ai.agent.type"] = "dsh"
    Object.assign(turnEvent, scalarAttributes(state.session, turn, this.config.agent_name))
    state.turn.events.push(turnEvent)
    this.debug(`started turn ${sessionId}:${turn}${parentCtx ? " (linked to parent trace)" : ""}`)
  }

  private startStep(state: SessionState, turn: number, step: number, startTime: number) {
    const active = state.turn
    if (active === undefined || active.turn !== turn) return
    if (active.step !== undefined) this.closeStep(active, startTime, "interrupted")
    active.step = {
      turn,
      step,
      startTimeMs: startTime,
      tools: new Map(),
      llms: new Set(),
      nextAttempt: 1,
      lastEndTimeMs: startTime
    }
    this.debug(`started step ${turn}:${step}`)
  }

  private closeStep(turn: TurnState, endTime: number, forcedReason?: string) {
    const step = turn.step
    if (step === undefined) return
    for (const llm of step.llms) {
      if (!llm.ended) this.failLlm(llm, new Error("DSH step ended before the LLM stream"), endTime)
    }
    for (const tool of step.tools.values()) {
      if (!tool.ended) this.failTool(turn, step, tool, new Error("DSH step ended before the tool result"), endTime)
    }
    step.lastFinishReason = forcedReason ?? step.lastFinishReason ?? "completed"
    step.lastEndTimeMs = endTime
    turn.step = undefined
  }

  private closeTurn(state: SessionState, reason: TurnEndReason, endTime: number) {
    const turn = state.turn
    if (turn === undefined || turn.ended) return
    turn.ended = true
    if (turn.step !== undefined) this.closeStep(turn, endTime, "interrupted")
    turn.events[0]["dsh.turn.end_reason"] = reason.kind
    const failure = finishFailure(reason)
    if (failure !== undefined) {
      const llmEvents = turn.events.filter((e) => e["event.name"] === "llm.response")
      if (llmEvents.length > 0) {
        const lastLlm = llmEvents[llmEvents.length - 1]
        lastLlm["error.type"] = failure.code
        lastLlm["error.message"] = failure.message
        lastLlm["gen_ai.call.status"] = false
      }
    }
    const rootEvent = turn.events[0]
    if (this.config.features.captureMessageContent) {
      const inputText = turn.inputs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("")
      const outputText = turn.outputs
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("")
      if (inputText)
        rootEvent["gen_ai.input.messages"] = [{ role: "user", parts: [{ type: "text", content: inputText }] }]
      if (outputText) {
        rootEvent["gen_ai.output.messages"] = [
          { role: "assistant", parts: [{ type: "text", content: outputText }] }
        ]
      } else if (failure !== undefined) {
        rootEvent["gen_ai.output.messages"] = [
          { role: "assistant", parts: [{ type: "text", content: `[${failure.code}] ${failure.message}` }] }
        ]
      }
    }
    rootEvent["gen_ai.usage.input_tokens"] = turn.usage.inputTokens
    rootEvent["gen_ai.usage.output_tokens"] = turn.usage.outputTokens
    rootEvent["gen_ai.usage.total_tokens"] = turn.usage.inputTokens + turn.usage.outputTokens
    if (turn.usage.cacheReadTokens > 0) {
      rootEvent["gen_ai.usage.cache_read.input_tokens"] = turn.usage.cacheReadTokens
    }
    if (turn.usage.cacheWriteTokens > 0) {
      rootEvent["gen_ai.usage.cache_write.input_tokens"] = turn.usage.cacheWriteTokens
    }
    const sessionId = String(state.session.id)
    this.debug(`closed turn ${sessionId}:${turn.turn} with reason ${reason.kind}, events: ${turn.events.length}`)
    state.turn = undefined
    this.reportTurnEvents(turn.events, turn.rootSpanHandle)
    this.rootSpanRegistry.delete(sessionId)
  }

  /** 调 onTurnComplete 上报事件（带提前创建的 root span handle） */
  private reportTurnEvents(events: TurnEventRecord[], handle?: RootSpanHandle) {
    if (!this.onTurnComplete || events.length === 0) return undefined
    try {
      return this.onTurnComplete(events, handle)
    } catch (error) {
      logError("[dsh-metrics] onTurnComplete callback failed:", error)
      return undefined
    }
  }

  // -------------------------------------------------------------------------
  // private: LLM 生命周期
  // -------------------------------------------------------------------------
  private startLlm(options: any): LlmStreamState | undefined {
    const session = this.sessions.get(String(options.sessionId))
    const turn = session?.turn
    const step = turn?.step
    if (session === undefined || turn === undefined || step === undefined) return undefined
    const attempt = step.nextAttempt++
    const startTimeMs = Date.now()
    const inputMessages = this.config.features.captureMessageContent ? mapInputMessages(turn.contextMessages) : []
    const requestEvent = this.createBaseEvent(session.session, turn.turn, "llm.request")
    requestEvent.time_unix_nano = msToNanos(startTimeMs)
    Object.assign(requestEvent, scalarAttributes(session.session, turn.turn, this.config.agent_name))
    requestEvent["gen_ai.step.id"] = `${String(options.sessionId)}:${turn.turn}:${step.step}`
    requestEvent["dsh.step"] = step.step
    requestEvent["dsh.llm.attempt"] = attempt
    Object.assign(requestEvent, llmRequestAttributes(options))
    if (this.config.features.captureMessageContent) {
      requestEvent["gen_ai.input.messages"] = inputMessages
      requestEvent["gen_ai.system_instructions"] = mapSystemInstruction(options.system)
      requestEvent["gen_ai.tool.definitions"] = mapToolDefinitions(options.tools)
    }
    // 记录工具名到描述的映射：tool/call 事件不含描述，工具 span 的
    // gen_ai.tool.description 只能从这里回查。描述属元数据，不受内容开关影响。
    if (Array.isArray(options.tools)) {
      for (const tool of options.tools) {
        if (typeof tool?.name === "string" && typeof tool?.description === "string" && tool.description) {
          this.toolDescriptions.set(tool.name, tool.description)
        }
      }
    }
    turn.events.push(requestEvent)
    const llm: LlmStreamState = {
      options,
      attempt,
      inputMessages,
      blocks: [],
      ended: false,
      firstTokenSeen: false,
      tokenCount: 0,
      startTimeMs,
      firstTokenMs: null,
      lastTokenMs: null
    }
    step.llms.add(llm)
    this.debug(
      `started LLM attempt ${attempt} for session ${String(options.sessionId)} using ${options.provider}/${options.model}`
    )
    return llm
  }

  private async *observeLlmStream(state: LlmStreamState, stream: AsyncIterable<any>) {
    try {
      for await (const chunk of stream) {
        try {
          this.observeLlmChunk(state, chunk)
        } catch (error) {
          this.warn(`failed to process an LLM chunk: ${errorMessage(error)}`)
        }
        yield chunk
      }
      if (!state.ended) {
        this.failLlm(state, new Error("LLM stream ended without a finish chunk"), Date.now())
      }
    } catch (error) {
      if (!state.ended) this.failLlm(state, error, Date.now())
      throw error
    } finally {
      if (!state.ended) {
        const aborted = state.options.signal?.aborted === true
        this.failLlm(
          state,
          new Error(aborted ? "LLM stream was aborted" : "LLM stream consumer stopped early"),
          Date.now()
        )
      }
    }
  }

  private observeLlmChunk(state: LlmStreamState, chunk: any) {
    if (state.ended) return
    if (isVisibleToken(chunk)) {
      if (!state.firstTokenSeen) {
        state.firstTokenSeen = true
        state.firstTokenMs = Date.now()
        state.lastTokenMs = state.firstTokenMs
        state.tokenCount = 1
      } else {
        state.lastTokenMs = Date.now()
        state.tokenCount++
      }
    }
    if (chunk.type === "block-end") {
      const block = chunk.block
      state.blocks.push(block)
      return
    }
    if (chunk.type === "usage") {
      state.usage = chunk.usage
      return
    }
    if (chunk.type !== "finish") return
    const reason = chunk.reason
    this.finishLlm(state, reason, Date.now())
  }

  private finishLlm(state: LlmStreamState, reason: LlmFinishReason, endTime: number) {
    if (state.ended) return
    state.ended = true
    const finishReason = mapFinishReason(reason.kind)
    this.completeLlm(state, finishReason, reason, endTime)
  }

  private failLlm(state: LlmStreamState, error: unknown, endTime: number) {
    if (state.ended) return
    state.ended = true
    const aborted = state.options.signal?.aborted === true
    const finishReason = aborted ? "cancelled" : "error"
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      code: aborted ? "ABORTED" : "ERROR"
    }
    this.completeLlm(state, finishReason, { kind: finishReason, failure }, endTime)
  }

  private completeLlm(state: LlmStreamState, finishReason: string, reason: LlmFinishReason, endTime: number) {
    const session = this.sessions.get(String(state.options.sessionId))
    const turn = session?.turn
    const step = turn?.step
    if (turn === undefined || step === undefined || !step.llms.has(state)) return
    const responseEvent = this.createBaseEvent(session!.session, turn.turn, "llm.response")
    responseEvent.time_unix_nano = msToNanos(endTime)
    Object.assign(responseEvent, scalarAttributes(session!.session, turn.turn, this.config.agent_name))
    responseEvent["gen_ai.step.id"] = `${String(state.options.sessionId)}:${turn.turn}:${step.step}`
    responseEvent["dsh.step"] = step.step
    responseEvent["gen_ai.provider.name"] = state.options.provider
    responseEvent["gen_ai.request.model"] = state.options.model
    responseEvent["gen_ai.response.model"] = state.options.model
    responseEvent["gen_ai.response.finish_reasons"] = [finishReason]
    responseEvent["dsh.llm.attempt"] = state.attempt
    const usage = state.usage ?? { inputTokens: 0, outputTokens: 0 }
    applyUsageToRecord(responseEvent, usage)
    addUsage(turn.usage, usage)
    if (state.firstTokenMs !== null) {
      const ttftSec = (state.firstTokenMs - state.startTimeMs) / 1e3
      responseEvent["gen_ai.response.ttft"] = ttftSec
      const ttftMs = Math.round(ttftSec * 1e3)
      responseEvent["gen_ai.response.time_to_first_token"] = ttftMs
    }
    if (state.firstTokenMs !== null && state.lastTokenMs !== null && state.tokenCount > 1) {
      const tbtSec = (state.lastTokenMs - state.firstTokenMs) / 1e3 / (state.tokenCount - 1)
      responseEvent["gen_ai.response.tbt"] = tbtSec
    }
    if (this.config.features.captureMessageContent) {
      const contentBlocks = mapContent(state.blocks)
      if ((reason.kind === "error" || reason.kind === "aborted") && contentBlocks.length === 0) {
        const failure = reason.failure ?? { message: `LLM ${reason.kind}`, code: reason.kind.toUpperCase() }
        contentBlocks.push({ type: "text", content: `[${failure.code}] ${failure.message}` })
      }
      const outputMessage = {
        role: "assistant",
        parts: contentBlocks,
        finish_reason: finishReason
      }
      responseEvent["gen_ai.output.messages"] = [outputMessage]
      if (state.inputMessages.length > 0) {
        responseEvent["gen_ai.input.messages"] = state.inputMessages
      }
    }
    if (reason.kind === "error" || reason.kind === "aborted") {
      const failure = reason.failure ?? { message: `LLM ${reason.kind}`, code: reason.kind.toUpperCase() }
      responseEvent["error.type"] = failure.code
      responseEvent["error.message"] = failure.message
      responseEvent["gen_ai.call.status"] = false
    }
    turn.events.push(responseEvent)
    step.lastFinishReason = finishReason
    step.lastEndTimeMs = endTime
    this.debug(`finished LLM for session ${String(state.options.sessionId)}: ${finishReason}`)
  }

  // -------------------------------------------------------------------------
  // private: Tool 生命周期
  // -------------------------------------------------------------------------
  private startTool(state: SessionState, data: any, startTime: number) {
    const turn = state.turn
    const step = turn?.step
    if (turn === undefined || turn.turn !== data.turn || step === undefined || step.step !== data.step) return
    const callEvent = this.createBaseEvent(state.session, data.turn, "tool.call")
    callEvent.time_unix_nano = msToNanos(startTime)
    Object.assign(callEvent, scalarAttributes(state.session, data.turn, this.config.agent_name))
    callEvent["gen_ai.step.id"] = `${String(state.session.id)}:${data.turn}:${data.step}`
    callEvent["dsh.step"] = data.step
    callEvent["gen_ai.tool.name"] = data.name
    callEvent["gen_ai.tool.call.id"] = data.callId
    // 工具描述不在 tool/call 事件里（DSH 的负载只有 name/arguments），
    // 只能从 LLM 请求携带的工具定义中按名字回查
    const description = this.toolDescriptions.get(data.name)
    if (description) callEvent["gen_ai.tool.description"] = description
    if (this.config.features.captureMessageContent) {
      callEvent["gen_ai.tool.call.arguments"] = data.arguments
    }
    turn.events.push(callEvent)
    step.tools.set(data.callId, {
      callId: data.callId,
      name: data.name,
      startTimeMs: startTime,
      arguments: data.arguments,
      ended: false
    })
  }

  private endTool(state: SessionState, data: any, endTime: number) {
    const turn = state.turn
    const step = turn?.step
    if (turn === undefined || turn.turn !== data.turn || step === undefined || step.step !== data.step) return
    if (this.config.features.captureMessageContent) turn.contextMessages.push(data.message)
    const callId = typeof data.message.source.callId === "string" ? data.message.source.callId : undefined
    if (callId === undefined) return
    const tool = step.tools.get(callId)
    if (tool === undefined || tool.ended) return
    tool.ended = true
    const durationMs = endTime - tool.startTimeMs
    const isError = data.error !== undefined
    const resultText = extractToolResultText(data.message)
    const resultEvent = this.createBaseEvent(state.session, data.turn, "tool.result")
    resultEvent.time_unix_nano = msToNanos(endTime)
    Object.assign(resultEvent, scalarAttributes(state.session, data.turn, this.config.agent_name))
    resultEvent["gen_ai.step.id"] = `${String(state.session.id)}:${data.turn}:${data.step}`
    resultEvent["dsh.step"] = data.step
    resultEvent["gen_ai.tool.name"] = tool.name
    resultEvent["gen_ai.tool.call.id"] = callId
    resultEvent["gen_ai.tool.call.duration"] = durationMs
    resultEvent["gen_ai.call.status"] = !isError
    if (this.config.features.captureMessageContent) {
      resultEvent["gen_ai.tool.call.result"] = resultText
    }
    if (isError) {
      resultEvent["error.type"] = data.error?.code ?? "TOOL_ERROR"
      resultEvent["error.message"] = data.error?.name ?? "Tool execution failed"
    }
    turn.events.push(resultEvent)
    this.debug(`ended tool ${tool.name} (${callId}): ${isError ? "error" : "success"}`)
  }

  private failTool(turn: TurnState, step: StepState, tool: ToolCallState, error: unknown, endTime: number) {
    if (tool.ended) return
    tool.ended = true
    const session = turn.session
    const message = error instanceof Error ? error.message : String(error)
    const resultEvent = this.createBaseEvent(session, turn.turn, "tool.result")
    resultEvent.time_unix_nano = msToNanos(endTime)
    Object.assign(resultEvent, scalarAttributes(session, turn.turn, this.config.agent_name))
    resultEvent["gen_ai.step.id"] = `${String(session.id)}:${turn.turn}:${step.step}`
    resultEvent["dsh.step"] = step.step
    resultEvent["gen_ai.tool.name"] = tool.name
    resultEvent["gen_ai.tool.call.id"] = tool.callId
    resultEvent["gen_ai.tool.call.duration"] = endTime - tool.startTimeMs
    resultEvent["gen_ai.call.status"] = false
    if (this.config.features.captureMessageContent) {
      resultEvent["gen_ai.tool.call.result"] = `[TOOL_ERROR] ${message}`
    }
    resultEvent["error.type"] = "TOOL_ERROR"
    resultEvent["error.message"] = message
    turn.events.push(resultEvent)
    this.debug(`failed tool ${tool.name} (${tool.callId}): ended without result`)
  }

  // -------------------------------------------------------------------------
  // private: turn input/output 捕获
  // -------------------------------------------------------------------------
  private captureTurnInput(state: SessionState, message: any) {
    if (state.turn === undefined) return
    if (this.config.features.captureMessageContent) state.turn.contextMessages.push(message)
    if (message.source.kind !== "user") return
    state.turn.inputs.push(mapInputMessage(message))
  }

  private captureTurnOutput(state: SessionState, turn: number, step: number, message: any) {
    const active = state.turn
    if (active === undefined || active.turn !== turn) return
    const stepState = active.step
    const finish = stepState?.step === step ? stepState.lastFinishReason ?? "unknown" : "unknown"
    if (this.config.features.captureMessageContent) active.contextMessages.push(message)
    active.outputs.push(mapOutputMessage(message, finish))
  }

  // -------------------------------------------------------------------------
  // private: EventRecord 创建
  // -------------------------------------------------------------------------
  private createBaseEvent(session: DshSession, turn: number, eventName: string): TurnEventRecord {
    const otel = this.config.otel
    return {
      "time_unix_nano": nowNanos(),
      "trace_id": `${String(session.id)}:${turn}`,
      "gen_ai.session.id": String(session.id),
      "gen_ai.turn.id": `${String(session.id)}:${turn}`,
      "user.id": this.userId,
      "gen_ai.agent.type": "dsh",
      "gen_ai.agent.name": this.config.agent_name || "deepseek-harness",
      "domain.id": otel?.agent_domain_id ?? "",
      "gen_ai.resource.id": otel?.agent_resource_id ?? "",
      "gen_ai.resource.type": otel?.resource_type ?? "",
      "gen_ai.project.id": otel?.agentarts_project_id ?? "",
      "resource_version": otel?.resource_version ?? "default",
      "gen_ai.call.status": true,
      "event.name": eventName
    }
  }

  // -------------------------------------------------------------------------
  // private: 日志
  // -------------------------------------------------------------------------
  /** turn 开始回调：由 plugin.ts 注入 otel-reporter 的 beginRootSpan（提前创建 root span，返回句柄；subagentName 为子 agent 独立名称） */
  onTurnStart: ((startTime: number, parentContext: RootSpanContext | undefined, subagentName: string | undefined, isSubagent: boolean) => RootSpanHandle | undefined) | null = null
  /** turn 完成回调：由 plugin.ts 注入 otel-reporter 的 reportEvents（带提前创建的 handle，返回 root context） */
  onTurnComplete: ((events: TurnEventRecord[], handle: RootSpanHandle | undefined) => any) | null = null

  private debug(message: string) {
    if (this.config.features.debug) this.logger.debug?.(`[dsh-metrics] ${message}`)
    logDebug("[dsh-metrics]", message)
  }

  private warn(message: string) {
    this.logger.warn(`[dsh-metrics] ${message}`)
    logError("[dsh-metrics]", message)
  }
}

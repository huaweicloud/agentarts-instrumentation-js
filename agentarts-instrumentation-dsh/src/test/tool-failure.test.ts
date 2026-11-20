// 集成测试：工具调用失败时，TOOL / STEP 的 span 状态必须是 ERROR。
//
// 复现用户实际遇到的场景：模型发起了 tool_call，但 step 在工具结果返回前就结束了
// （coordinator 会走 failTool，写入 gen_ai.call.status=false + error.type=TOOL_ERROR）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { SpanStatusCode } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { DshTraceCoordinator } from "../coordinator.js"
import { initOtel, reportEvents, shutdownOtel } from "../otel-reporter.js"

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} }

initOtel(
  {
    agentarts_agentops_otel_agent_apm_enable: true,
    agentarts_agentops_otel_agent_aom_enable: false,
    agentarts_agentops_apm_token: "t",
    agentarts_agentops_apm_exporter_endpoint: "http://127.0.0.1:14317",
    agent_domain_id: "d",
    agent_resource_id: "r",
    resource_type: "agent",
    resource_version: "test"
  } as any,
  provider
)

type Collected = { events: any[] }

async function driveTurn(
  opts: { toolResult?: "ok" | "error" | "none" }
): Promise<Collected> {
  const collected: Collected = { events: [] }
  const coordinator = new DshTraceCoordinator(
    {
      agent_name: "test-agent",
      features: { debug: false, captureMessageContent: true, linkSubagentTrace: true },
      otel: { agent_domain_id: "d", agentarts_project_id: "p", agent_resource_id: "r" }
    },
    "u",
    silentLogger
  )
  coordinator.onTurnComplete = (turnEvents) => {
    collected.events = turnEvents
    return undefined
  }

  const session = { id: "s-fail", header: {} }
  coordinator.adoptSession(session)
  coordinator.onSessionEvent(session, { type: "turn/start", time: 1, data: { turn: 1 } })
  coordinator.onSessionEvent(session, { type: "step/start", time: 2, data: { turn: 1, step: 1 } })

  // 走一次 LLM 流，让 step 具备完整的 LLM 事件
  async function* stream() {
    yield { type: "text-delta", text: "ok" }
    yield { type: "block-end", block: { type: "text", id: "b1", text: "ok" } }
    yield { type: "tool-call", call: { id: "c-1", name: "plugin_manager", arguments: "{}" } }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: "finish", reason: { kind: "tool_calls" } }
  }
  for await (const _ of coordinator.interceptLlm(
    { sessionId: "s-fail", provider: "p", model: "m", tools: [] },
    stream
  )) {
    // drain
  }

  coordinator.onSessionEvent(session, {
    type: "tool/call",
    time: 3,
    data: { turn: 1, step: 1, name: "plugin_manager", callId: "c-1", arguments: "{}" }
  })

  if (opts.toolResult === "ok" || opts.toolResult === "error") {
    // 通过 tool/result 事件回填结果（scheduleToolResult 之外的等价入口）
    const state: any = (coordinator as any).sessions.get("s-fail")
    const tool = state?.turn?.step?.tools?.get("c-1")
    if (tool) {
      const resultEvent: any = {
        "time_unix_nano": String(4_000_000_000),
        "event.name": "tool.result",
        "trace_id": "s-fail:1",
        "gen_ai.session.id": "s-fail",
        "gen_ai.turn.id": "s-fail:1",
        "gen_ai.step.id": "s-fail:1:1",
        "gen_ai.tool.name": "plugin_manager",
        "gen_ai.tool.call.id": "c-1",
        "gen_ai.tool.call.duration": 500,
        "gen_ai.tool.call.result": opts.toolResult === "ok" ? "done" : "[TOOL_ERROR] boom",
        "gen_ai.call.status": opts.toolResult === "ok",
        ...(opts.toolResult === "error" ? { "error.type": "TOOL_ERROR", "error.message": "boom" } : {})
      }
      state.turn.events.push(resultEvent)
      tool.ended = true
    }
  }

  // step 结束时若还没结果，coordinator 会调用 failTool —— 正是用户遇到的场景
  coordinator.onSessionEvent(session, { type: "step/end", time: 5, data: { turn: 1, step: 1 } })
  coordinator.onSessionEvent(session, {
    type: "turn/end",
    time: 6,
    data: { turn: 1, reason: { kind: "stop" } }
  })
  return collected
}

function spansByKind() {
  const spans = exporter.getFinishedSpans()
  const map = new Map<string, (typeof spans)[number]>()
  for (const s of spans) {
    const kind = s.attributes["gen_ai.span.kind"]
    if (typeof kind === "string") map.set(kind, s)
  }
  return map
}

test("step 结束前没有工具结果：TOOL 与 STEP 为 ERROR，AGENT 仍为 OK", async () => {
  exporter.reset()
  const { events } = await driveTurn({ toolResult: "none" })
  reportEvents(events, undefined)

  const spans = spansByKind()
  const tool = spans.get("TOOL")
  assert.ok(tool, "应有 TOOL span")
  assert.equal(tool!.status.code, SpanStatusCode.ERROR, "工具失败时 TOOL span 必须为 ERROR")
  assert.match(String(tool!.status.message), /step ended before the tool result/)

  const step = spans.get("STEP")
  assert.equal(step!.status.code, SpanStatusCode.ERROR, "step 内有工具失败时应为 ERROR")
  assert.ok(String(step!.status.message).length > 0, "STATUS 消息不能为空")

  const llm = spans.get("LLM")
  assert.equal(llm!.status.code, SpanStatusCode.OK, "LLM 调用本身成功，应为 OK")

  const agent = spans.get("AGENT")
  assert.equal(agent!.status.code, SpanStatusCode.OK, "turn 本身没有 LLM 错误，AGENT 应为 OK")
})

test("工具结果显式失败：TOOL 与 STEP 为 ERROR，error.message 透传", async () => {
  exporter.reset()
  const { events } = await driveTurn({ toolResult: "error" })
  reportEvents(events, undefined)

  const spans = spansByKind()
  const tool = spans.get("TOOL")
  assert.equal(tool!.status.code, SpanStatusCode.ERROR)
  assert.match(String(tool!.status.message), /boom/)

  const step = spans.get("STEP")
  assert.equal(step!.status.code, SpanStatusCode.ERROR)
})

test("工具成功：TOOL / STEP / LLM / AGENT 全部为 OK", async () => {
  exporter.reset()
  const { events } = await driveTurn({ toolResult: "ok" })
  reportEvents(events, undefined)

  const spans = spansByKind()
  for (const kind of ["TOOL", "STEP", "LLM", "AGENT"]) {
    assert.equal(spans.get(kind)!.status.code, SpanStatusCode.OK, `${kind} 应为 OK`)
  }
})

test.after(async () => {
  await shutdownOtel()
})

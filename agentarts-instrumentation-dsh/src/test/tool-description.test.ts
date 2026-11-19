// 工具描述测试：tool/call 事件不带描述，需从 LLM 请求携带的工具定义回查。
import { test } from "node:test"
import assert from "node:assert/strict"
import { DshTraceCoordinator } from "../coordinator.js"

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} }

function setup(captureMessageContent = true) {
  const events: any[] = []
  const coordinator = new DshTraceCoordinator(
    {
      agent_name: "a",
      features: { debug: false, captureMessageContent, linkSubagentTrace: true },
      otel: {}
    },
    "u",
    silentLogger
  )
  coordinator.onTurnComplete = (turnEvents) => {
    events.push(...turnEvents)
    return undefined
  }
  const session = { id: "s1", header: {} }
  coordinator.adoptSession(session)
  coordinator.onSessionEvent(session, { type: "turn/start", time: 1, data: { turn: 1 } })
  coordinator.onSessionEvent(session, { type: "step/start", time: 2, data: { turn: 1, step: 1 } })
  return { coordinator, session, events }
}

async function runLlm(coordinator: DshTraceCoordinator, session: any, tools: any[]) {
  async function* stream() {
    yield { type: "text-delta", text: "x" }
    yield { type: "block-end", block: { type: "text", id: "b", text: "x" } }
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: "finish", reason: { kind: "stop" } }
  }
  for await (const _ of coordinator.interceptLlm(
    { sessionId: session.id, provider: "p", model: "m", tools },
    stream
  )) {
    // drain
  }
}

test("工具 span 事件带上 gen_ai.tool.description（来自 LLM 工具定义）", async () => {
  const { coordinator, session, events } = setup()
  await runLlm(coordinator, session, [
    { name: "bash", description: "Run a shell command", parameters: { type: "object" } },
    { name: "read", description: "Read a file", parameters: { type: "object" } }
  ])
  coordinator.onSessionEvent(session, {
    type: "tool/call",
    time: 3,
    data: { turn: 1, step: 1, name: "bash", callId: "c1", arguments: "{}" }
  })
  coordinator.onSessionEvent(session, { type: "step/end", time: 4, data: { turn: 1, step: 1 } })
  coordinator.onSessionEvent(session, { type: "turn/end", time: 5, data: { turn: 1, reason: { kind: "stop" } } })

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.ok(call, "应有 tool.call 事件")
  assert.equal(call!["gen_ai.tool.description"], "Run a shell command")
})

test("关闭内容采集时，工具描述仍上报（属元数据而非会话内容）", async () => {
  const { coordinator, session, events } = setup(false)
  await runLlm(coordinator, session, [{ name: "bash", description: "Run a shell command", parameters: {} }])
  coordinator.onSessionEvent(session, {
    type: "tool/call",
    time: 3,
    data: { turn: 1, step: 1, name: "bash", callId: "c1", arguments: "{\"secret\":1}" }
  })
  coordinator.onSessionEvent(session, { type: "step/end", time: 4, data: { turn: 1, step: 1 } })
  coordinator.onSessionEvent(session, { type: "turn/end", time: 5, data: { turn: 1, reason: { kind: "stop" } } })

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.equal(call!["gen_ai.tool.description"], "Run a shell command", "描述不受内容开关影响")
  assert.equal("gen_ai.tool.call.arguments" in call!, false, "参数仍按开关不采集")
})

test("工具定义中没有该名字时，不写描述属性", async () => {
  const { coordinator, session, events } = setup()
  await runLlm(coordinator, session, [{ name: "read", description: "Read a file", parameters: {} }])
  coordinator.onSessionEvent(session, {
    type: "tool/call",
    time: 3,
    data: { turn: 1, step: 1, name: "unknown_tool", callId: "c9", arguments: "{}" }
  })
  coordinator.onSessionEvent(session, { type: "step/end", time: 4, data: { turn: 1, step: 1 } })
  coordinator.onSessionEvent(session, { type: "turn/end", time: 5, data: { turn: 1, reason: { kind: "stop" } } })

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.equal("gen_ai.tool.description" in call!, false)
})

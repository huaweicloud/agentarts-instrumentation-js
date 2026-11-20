// 隐私模式下的技能识别：关闭内容采集后，只有 skill 工具保留"仅含技能名"的参数，
// 其余工具参数一律不采集。
import { test } from "node:test"
import assert from "node:assert/strict"
import { DshTraceCoordinator, extractSkillName, isSkillToolName } from "../coordinator.js"

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} }

function setup(captureMessageContent: boolean) {
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

function emitTool(coordinator: DshTraceCoordinator, session: any, name: string, callId: string, args: string) {
  coordinator.onSessionEvent(session, {
    type: "tool/call",
    time: 3,
    data: { turn: 1, step: 1, name, callId, arguments: args }
  })
}

function finish(coordinator: DshTraceCoordinator, session: any) {
  coordinator.onSessionEvent(session, { type: "step/end", time: 4, data: { turn: 1, step: 1 } })
  coordinator.onSessionEvent(session, { type: "turn/end", time: 5, data: { turn: 1, reason: { kind: "stop" } } })
}

test("isSkillToolName：大小写不敏感，只认 skill", () => {
  assert.equal(isSkillToolName("skill"), true)
  assert.equal(isSkillToolName("SKILL"), true)
  assert.equal(isSkillToolName("bash"), false)
  assert.equal(isSkillToolName(undefined), false)
})

test("extractSkillName：兼容 name 与 skill 字段，非法输入返回 undefined", () => {
  assert.equal(extractSkillName('{"name":"dsh-doc"}'), "dsh-doc")
  assert.equal(extractSkillName('{"skill":"office"}'), "office")
  assert.equal(extractSkillName('{"name":""}'), undefined)
  assert.equal(extractSkillName("not-json"), undefined)
  assert.equal(extractSkillName(undefined), undefined)
})

test("关闭内容采集：skill 工具仍保留参数，但只含技能名", () => {
  const { coordinator, session, events } = setup(false)
  emitTool(coordinator, session, "skill", "c1", '{"name":"dsh-doc","extra":"should-be-dropped"}')
  finish(coordinator, session)

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.ok(call, "应有 tool.call 事件")
  const args = call!["gen_ai.tool.call.arguments"]
  assert.ok(args, "隐私模式下 skill 工具应保留参数（用于识别技能名）")
  assert.deepEqual(JSON.parse(args), { name: "dsh-doc" }, "只保留技能名，其余字段丢弃")
})

test("关闭内容采集：非 skill 工具的参数不采集", () => {
  const { coordinator, session, events } = setup(false)
  emitTool(coordinator, session, "bash", "c2", '{"command":"rm -rf /tmp/x"}')
  finish(coordinator, session)

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.equal("gen_ai.tool.call.arguments" in call!, false, "普通工具参数不得外发")
})

test("开启内容采集：skill 工具保留完整参数（不做裁剪）", () => {
  const { coordinator, session, events } = setup(true)
  emitTool(coordinator, session, "skill", "c3", '{"name":"dsh-doc","extra":"kept"}')
  finish(coordinator, session)

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.deepEqual(JSON.parse(call!["gen_ai.tool.call.arguments"]), { name: "dsh-doc", extra: "kept" })
})

test("关闭内容采集：skill 参数无法解析时不写参数（不会写入原始文本）", () => {
  const { coordinator, session, events } = setup(false)
  emitTool(coordinator, session, "skill", "c4", "not-json-raw-text")
  finish(coordinator, session)

  const call = events.find((e) => e["event.name"] === "tool.call")
  assert.equal("gen_ai.tool.call.arguments" in call!, false, "解析失败时不得回退成原文")
})

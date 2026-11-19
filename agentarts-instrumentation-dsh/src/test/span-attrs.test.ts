// span 公共属性测试：确保子 agent 归属信息真正落到 span 上，
// 而不只是存在于事件记录里（此前就是这样漏掉的）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCommonSpanAttrs } from "../otel-reporter.js"

const baseEvent = {
  "event.id": "e1",
  "event.name": "other",
  "gen_ai.session.id": "child-1",
  "gen_ai.turn.id": "child-1:1",
  "user.id": "u1"
} as any

test("buildCommonSpanAttrs：子 agent 归属信息写入 span 属性", () => {
  const attrs = buildCommonSpanAttrs({
    ...baseEvent,
    "dsh.session.parent_id": "parent-1",
    "dsh.session.delegation_depth": 2,
    "dsh.session.origin": "subagent",
    "dsh.agent.preset": "preset-standard"
  })
  assert.equal(attrs["dsh.session.parent_id"], "parent-1", "父会话 ID 必须出现在 span 上")
  assert.equal(attrs["dsh.session.delegation_depth"], 2)
  assert.equal(attrs["dsh.session.origin"], "subagent")
  assert.equal(attrs["dsh.agent.preset"], "preset-standard")
})

test("buildCommonSpanAttrs：delegation_depth 为 0 时仍然写入（真值判断会漏掉）", () => {
  const attrs = buildCommonSpanAttrs({ ...baseEvent, "dsh.session.delegation_depth": 0 })
  assert.equal("dsh.session.delegation_depth" in attrs, true, "0 是有效深度，不能被省略")
  assert.equal(attrs["dsh.session.delegation_depth"], 0)
})

test("buildCommonSpanAttrs：顶层会话（无父会话）不写这些属性", () => {
  const attrs = buildCommonSpanAttrs({ ...baseEvent })
  assert.equal("dsh.session.parent_id" in attrs, false)
  assert.equal("dsh.session.delegation_depth" in attrs, false)
  assert.equal("dsh.session.origin" in attrs, false)
  assert.equal("dsh.agent.preset" in attrs, false)
})

test("buildCommonSpanAttrs：原有公共属性不受影响", () => {
  const attrs = buildCommonSpanAttrs({
    ...baseEvent,
    "domain.id": "d1",
    "gen_ai.resource.id": "r1",
    "agent.dsh.cwd": "/w"
  })
  assert.equal(attrs["gen_ai.conversation.id"], "child-1", "无 conversation.id 时回退 session.id")
  assert.equal(attrs["gen_ai.turn.id"], "child-1:1")
  assert.equal(attrs["gen_ai.user.id"], "u1")
  assert.equal(attrs["domain.id"], "d1")
  assert.equal(attrs["agent.dsh.cwd"], "/w")
  assert.equal(attrs["probe_version"], "1.0.0")
})

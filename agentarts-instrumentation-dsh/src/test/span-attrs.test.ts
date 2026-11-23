// span 公共属性测试：确认上报的字段集合符合约定。
// 注意区分两类字段：
//   - 纯展示属性：不应出现在 span 上（如 cwd、preset、call.type、event.id/name）
//   - 内部处理键（turn.id / step.id / tool.call.duration / event.name）：
//     仍存在于事件记录中，用于分组与指标计算，只是不再作为 span 属性上报
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCommonSpanAttrs } from "../otel-reporter.js"
import { PROBE_VERSION } from "../probe-version.generated.js"

const baseEvent = {
  "event.name": "other",
  "gen_ai.session.id": "child-1",
  "gen_ai.turn.id": "child-1:1",
  "user.id": "u1"
} as any

test("buildCommonSpanAttrs：子 agent 归属中只保留 parent_id 与 origin", () => {
  const attrs = buildCommonSpanAttrs({
    ...baseEvent,
    "dsh.session.parent_id": "parent-1",
    "dsh.session.origin": "subagent"
  })
  assert.equal(attrs["dsh.session.parent_id"], "parent-1", "父会话 ID 仍需上报，便于过滤聚合")
  assert.equal(attrs["dsh.session.origin"], "subagent")
})

test("buildCommonSpanAttrs：已移除的属性不再出现在 span 上", () => {
  const attrs = buildCommonSpanAttrs({
    ...baseEvent,
    "agent.dsh.cwd": "/w",
    "dsh.agent.preset": "preset-standard",
    "dsh.session.delegation_depth": 2,
    "event.id": "e1"
  })
  for (const key of [
    "agent.dsh.cwd",
    "dsh.agent.preset",
    "dsh.session.delegation_depth",
    "event.id",
    "event.name",
    "gen_ai.turn.id",
    "gen_ai.call.type"
  ]) {
    assert.equal(key in attrs, false, `${key} 不应再作为 span 属性上报`)
  }
})

test("buildCommonSpanAttrs：保留的公共属性不受影响", () => {
  const attrs = buildCommonSpanAttrs({
    ...baseEvent,
    "domain.id": "d1",
    "gen_ai.resource.id": "r1",
    "gen_ai.resource.type": "deepseekharness",
    "gen_ai.project.id": "p1",
    "resource_version": "1.0.0"
  })
  assert.equal(attrs["gen_ai.conversation.id"], "child-1", "无 conversation.id 时回退 session.id")
  assert.equal(attrs["gen_ai.user.id"], "u1")
  assert.equal(attrs["domain.id"], "d1")
  assert.equal(attrs["gen_ai.resource.id"], "r1")
  assert.equal(attrs["gen_ai.resource.type"], "deepseekharness")
  assert.equal(attrs["gen_ai.project.id"], "p1")
  assert.equal(attrs["resource_version"], "1.0.0")
  assert.equal(attrs["probe_version"], PROBE_VERSION)
})

test("buildCommonSpanAttrs：conversation.id 存在时优先于 session.id", () => {
  const attrs = buildCommonSpanAttrs({ ...baseEvent, "gen_ai.conversation.id": "conv-9" })
  assert.equal(attrs["gen_ai.conversation.id"], "conv-9")
})

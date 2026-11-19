// 根 span 命名规则测试：子 agent 拿不到名称时不能与父 span 同名。
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveRootSpanName } from "../otel-reporter.js"
import { DshTraceCoordinator } from "../coordinator.js"

test("resolveRootSpanName：有明确名称时优先使用", () => {
  assert.equal(resolveRootSpanName("researcher", false), "invoke_agent researcher")
  assert.equal(resolveRootSpanName("researcher", true), "invoke_agent researcher", "子 agent 有名字也用名字")
})

test("resolveRootSpanName：子 agent 无名时兜底为 subagent", () => {
  assert.equal(resolveRootSpanName(undefined, true), "invoke_agent subagent")
  assert.equal(resolveRootSpanName("", true), "invoke_agent subagent")
})

test("resolveRootSpanName：顶层会话无名时保持原有兜底", () => {
  const name = resolveRootSpanName(undefined, false)
  assert.match(name, /^invoke_agent /)
  assert.notEqual(name, "invoke_agent subagent", "顶层会话不应被标成 subagent")
})

test("coordinator：向 onTurnStart 传递 isSubagent 标志（与串联开关无关）", () => {
  const seen: Array<{ isSubagent: boolean; hasParent: boolean }> = []
  const coordinator = new DshTraceCoordinator(
    {
      agent_name: "root",
      features: { debug: false, captureMessageContent: false, linkSubagentTrace: false },
      otel: {}
    },
    "u",
    { info: () => {}, warn: () => {}, debug: () => {} }
  )
  coordinator.onTurnStart = (_t, parent, _n, isSubagent) => {
    seen.push({ isSubagent, hasParent: !!parent })
    return undefined
  }

  const parent = { id: "p", header: {} }
  const child = { id: "c", header: { parentSession: "p", delegationDepth: 1 } }
  coordinator.adoptSession(parent)
  coordinator.adoptSession(child)
  coordinator.onSessionEvent(parent, { type: "turn/start", time: 1, data: { turn: 1 } })
  coordinator.onSessionEvent(child, { type: "turn/start", time: 2, data: { turn: 1 } })

  assert.equal(seen[0].isSubagent, false, "父会话不是 subagent")
  assert.equal(seen[1].isSubagent, true, "子会话是 subagent")
  assert.equal(seen[1].hasParent, false, "关闭串联时无 parent，但仍应标记为 subagent")
})

// 子 agent 场景测试：验证父 trace 串联、名称注入、开关行为与生命周期边界。
// 这些逻辑依赖 coordinator 的会话注册表，容易在并发与交错时序下出错。
import { test } from "node:test"
import assert from "node:assert/strict"
import { DshTraceCoordinator } from "../coordinator.js"

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} }
const features = (link: boolean) => ({
  debug: false,
  captureMessageContent: false,
  linkSubagentTrace: link
})

function makeCoordinator(link = true) {
  const starts: Array<{ parent: any; name: string | undefined }> = []
  const completes: number[] = []
  const renames: string[] = []
  const coordinator = new DshTraceCoordinator(
    { agent_name: "root-agent", features: features(link), otel: {} },
    "u1",
    silentLogger
  )
  let seq = 0
  coordinator.onTurnStart = (startTime, parentContext, subagentName) => {
    starts.push({ parent: parentContext, name: subagentName })
    seq += 1
    const span = { updateName: (n: string) => renames.push(n) }
    return { span: span as any, context: { traceId: "trace-" + seq, spanId: "span-" + seq } }
  }
  coordinator.onTurnComplete = (events) => {
    completes.push(events.length)
    return undefined
  }
  return { coordinator, starts, completes, renames }
}

const parentSession = { id: "parent-1", header: { cwd: "/w" } }
const childSession = { id: "child-1", header: { cwd: "/w", parentSession: "parent-1", delegationDepth: 1 } }

test("子 agent：孩子 turn 以父 root span 为 parent（tracing 串联）", () => {
  const { coordinator, starts } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })

  assert.equal(starts.length, 2)
  assert.equal(starts[0].parent, undefined, "父 turn 无 parent")
  assert.deepEqual(starts[1].parent, { traceId: "trace-1", spanId: "span-1" }, "子 turn 应链接到父 root span")
})

test("子 agent：关闭 linkSubagentTrace 后子 turn 独立成 trace", () => {
  const { coordinator, starts } = makeCoordinator(false)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })

  assert.equal(starts[1].parent, undefined, "关闭串联后不应有 parent")
})

test("子 agent：subagent/catalog 提供名称，子 turn 的 root span 名称取自该名称", () => {
  const { coordinator, starts } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  // catalog 先于孩子 turn 到达
  coordinator.onSessionEvent(parentSession, {
    type: "subagent/catalog",
    time: 1100,
    data: { childId: "child-1", name: "researcher" }
  })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })

  assert.equal(starts[1].name, "researcher", "子 turn 应带上 catalog 注册的名称")
})

test("子 agent：catalog 晚于孩子 turn 到达时，改名作用到已建 span", () => {
  const { coordinator, renames } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })
  coordinator.onSessionEvent(parentSession, {
    type: "subagent/catalog",
    time: 1300,
    data: { childId: "child-1", name: "coder" }
  })

  assert.deepEqual(renames, ["invoke_agent coder"], "已存在的 root span 应被改名")
})

test("子 agent：父子 turn 各自独立完成上报（不合并）", () => {
  const { coordinator, completes } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/end", time: 1300, data: { turn: 1, reason: { kind: "stop" } } })
  coordinator.onSessionEvent(parentSession, { type: "turn/end", time: 1400, data: { turn: 1, reason: { kind: "stop" } } })

  assert.equal(completes.length, 2, "父子各上报一次")
})

test("子 agent：父 turn 已结束后再启动的子 turn 无法串联（已知边界）", () => {
  const { coordinator, starts } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(parentSession, { type: "turn/end", time: 1100, data: { turn: 1, reason: { kind: "stop" } } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })

  assert.equal(starts[1].parent, undefined, "父 turn 结束后其 root context 已从注册表移除")
})

test("子 agent：dispose 父会话不影响子会话继续串联自己的上下文", () => {
  const { coordinator, starts } = makeCoordinator(true)
  coordinator.adoptSession(parentSession)
  coordinator.adoptSession(childSession)

  coordinator.onSessionEvent(parentSession, { type: "turn/start", time: 1000, data: { turn: 1 } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1200, data: { turn: 1 } })

  coordinator.disposeSession(parentSession)
  // 子会话的第二轮 turn 应以自己的上一轮为参照（父已不可用）
  coordinator.onSessionEvent(childSession, { type: "turn/end", time: 1300, data: { turn: 1, reason: { kind: "stop" } } })
  coordinator.onSessionEvent(childSession, { type: "turn/start", time: 1400, data: { turn: 2 } })

  assert.equal(starts.length, 3)
  assert.equal(starts[2].parent, undefined, "父会话已 dispose，第二轮不再串联")
})

// span 状态测试：成功必须显式 OK（否则停留在 UNSET），失败必须 ERROR 且带消息。
import { test } from "node:test"
import assert from "node:assert/strict"
import { SpanStatusCode } from "@opentelemetry/api"
import { applySpanStatus, eventsHaveFailure, toolCallSucceeded } from "../otel-reporter.js"
import type { TurnEventRecord } from "../coordinator.js"

/** 记录 setStatus 调用的假 span（只测状态逻辑，不依赖 OTel SDK）。 */
function fakeSpan() {
  const calls: any[] = []
  return {
    calls,
    setStatus(status: any) {
      calls.push(status)
    }
  } as any
}

test("applySpanStatus：成功显式置 OK（避免停留在 UNSET）", () => {
  const span = fakeSpan()
  applySpanStatus(span, true)
  assert.equal(span.calls.length, 1)
  assert.equal(span.calls[0].code, SpanStatusCode.OK)
  assert.equal("message" in span.calls[0], false, "OK 不带 message")
})

test("applySpanStatus：失败置 ERROR 并带截断后的消息", () => {
  const span = fakeSpan()
  applySpanStatus(span, false, "DSH step ended before the tool result")
  assert.equal(span.calls[0].code, SpanStatusCode.ERROR)
  assert.match(span.calls[0].message, /step ended before the tool result/)
})

test("applySpanStatus：错误消息超过 500 字符时截断", () => {
  const span = fakeSpan()
  applySpanStatus(span, false, "x".repeat(800))
  assert.equal(span.calls[0].message.length, 500)
})

test("applySpanStatus：失败但无消息时仍置 ERROR", () => {
  const span = fakeSpan()
  applySpanStatus(span, false, undefined)
  assert.equal(span.calls[0].code, SpanStatusCode.ERROR)
  assert.equal("message" in span.calls[0], false)
})

/** 构造最小事件记录（TurnEventRecord 有 index signature，测试只需关心的字段）。 */
function ev(fields: Record<string, any>): TurnEventRecord {
  return { "time_unix_nano": "0", "event.name": "other", ...fields } as TurnEventRecord
}

test("toolCallSucceeded：无结果事件视为成功", () => {
  assert.equal(toolCallSucceeded(undefined), true)
})

test("toolCallSucceeded：结果显式失败或带 error.type 视为失败", () => {
  assert.equal(toolCallSucceeded(ev({ "gen_ai.call.status": false })), false)
  assert.equal(toolCallSucceeded(ev({ "gen_ai.call.status": "false" })), false)
  assert.equal(toolCallSucceeded(ev({ "error.type": "TOOL_ERROR" })), false)
  assert.equal(toolCallSucceeded(ev({ "gen_ai.call.status": true })), true)
})

test("toolCallSucceeded：step 结束前没有工具结果（failTool 造的事件）判为失败", () => {
  // coordinator.failTool 生成的结果事件：call.status=false + error.type=TOOL_ERROR
  const synthetic = ev({
    "gen_ai.call.status": false,
    "error.type": "TOOL_ERROR",
    "error.message": "DSH step ended before the tool result"
  })
  assert.equal(toolCallSucceeded(synthetic), false, "用户遇到的就是这个场景，必须判失败")
})

test("eventsHaveFailure：任一带 error.type 即失败", () => {
  assert.equal(eventsHaveFailure([ev({ "event.name": "other" })]), false)
  assert.equal(
    eventsHaveFailure([ev({ "event.name": "llm.response" }), ev({ "event.name": "tool.result", "error.type": "TOOL_ERROR" })]),
    true
  )
})

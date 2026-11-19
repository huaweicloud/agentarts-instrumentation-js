// 导出重试单元测试：验证失败重发、成功即止、重试耗尽后透传失败结果。
import { test } from "node:test"
import assert from "node:assert/strict"
import { exportWithRetry } from "../otel-reporter.js"

const SUCCESS = { code: 0 }
const FAILURE = { code: 1, error: new Error("14 UNAVAILABLE: connect ETIMEDOUT") }

function makeRaw(failures: number) {
  let calls = 0
  const raw = (_payload: unknown, cb: (result: any) => void) => {
    calls++
    cb(calls <= failures ? FAILURE : SUCCESS)
  }
  return { raw, calls: () => calls }
}

test("exportWithRetry：成功后不再重试", async () => {
  const { raw, calls } = makeRaw(0)
  const result = await new Promise<any>((resolve) => {
    exportWithRetry(raw, ["p"], resolve, "TEST", () => ({ n: 1 }))
  })
  assert.equal(result.code, 0)
  assert.equal(calls(), 1)
})

test("exportWithRetry：失败后重试并最终成功", async () => {
  const { raw, calls } = makeRaw(2) // 前两次失败，第三次成功
  const result = await new Promise<any>((resolve) => {
    exportWithRetry(raw, ["p"], resolve, "TEST", () => ({ n: 1 }))
  })
  assert.equal(result.code, 0, "第三次应成功")
  assert.equal(calls(), 3, "应一共调用 3 次")
})

test("exportWithRetry：重试耗尽后透传失败结果", async () => {
  const { raw, calls } = makeRaw(99)
  const result = await new Promise<any>((resolve) => {
    exportWithRetry(raw, ["p"], resolve, "TEST", () => ({ n: 1 }))
  })
  assert.equal(result.code, 1, "应返回最后一次失败结果")
  assert.equal(calls(), 3, "应遵守 3 次上限，不无限重试")
})

test("exportWithRetry：onSuccess 仅在成功时调用", async () => {
  const { raw } = makeRaw(99)
  let successCalls = 0
  await new Promise<void>((resolve) => {
    exportWithRetry(raw, ["p"], () => resolve(), "TEST", () => ({ n: 1 }), () => {
      successCalls++
    })
  })
  assert.equal(successCalls, 0, "全失败时不应触发 onSuccess")
})

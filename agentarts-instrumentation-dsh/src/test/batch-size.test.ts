// 批量大小解析测试。
import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_MAX_EXPORT_BATCH_SIZE, resolveExportBatchSize } from "../otel-reporter.js"

test("resolveExportBatchSize：默认 64", () => {
  assert.equal(DEFAULT_MAX_EXPORT_BATCH_SIZE, 64)
  assert.equal(resolveExportBatchSize(undefined), 64)
  assert.equal(resolveExportBatchSize(""), 64)
  assert.equal(resolveExportBatchSize("   "), 64)
})

test("resolveExportBatchSize：环境变量可覆盖", () => {
  assert.equal(resolveExportBatchSize("128"), 128)
  assert.equal(resolveExportBatchSize("32"), 32)
  assert.equal(resolveExportBatchSize("1"), 1)
})

test("resolveExportBatchSize：非法值回退默认", () => {
  assert.equal(resolveExportBatchSize("abc"), 64)
  assert.equal(resolveExportBatchSize("0"), 64)
  assert.equal(resolveExportBatchSize("-5"), 64)
})

test("resolveExportBatchSize：小数向下取整", () => {
  assert.equal(resolveExportBatchSize("100.9"), 100)
})

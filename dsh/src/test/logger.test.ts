// logger 单元测试（node --test，构建后运行）
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initLogger, isDebugEnabled, setDebugEnabled } from "../logger.js"

function todayLogName() {
  const now = new Date()
  const mo = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `plugin-${now.getFullYear()}-${mo}-${d}.log`
}

test("isDebugEnabled 反映 setDebugEnabled", () => {
  setDebugEnabled(true)
  assert.equal(isDebugEnabled(), true)
  setDebugEnabled(false)
  assert.equal(isDebugEnabled(), false)
})

test("initLogger 按保留天数删除过期日志", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-logger-retention-"))
  const expired = path.join(dir, "plugin-2020-01-02.log")
  fs.writeFileSync(expired, "old")
  const fresh = path.join(dir, todayLogName())
  fs.writeFileSync(fresh, "new")
  const unrelated = path.join(dir, "other-2020-01-02.log")
  fs.writeFileSync(unrelated, "keep")
  initLogger(dir, 14)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fs.existsSync(expired), false, "过期日志应被删除")
  assert.equal(fs.existsSync(fresh), true, "当日日志应保留")
  assert.equal(fs.existsSync(unrelated), true, "非 plugin-*.log 命名文件不动")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("retentionDays=0 关闭清理", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-logger-keep-"))
  const expired = path.join(dir, "plugin-2020-01-02.log")
  fs.writeFileSync(expired, "old")
  initLogger(dir, 0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fs.existsSync(expired), true, "0 应关闭自动清理")
  fs.rmSync(dir, { recursive: true, force: true })
})

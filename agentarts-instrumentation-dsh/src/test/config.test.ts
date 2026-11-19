// config 校验/热重载单元测试（node --test，构建后运行）
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  KNOWN_OTEL_KEYS,
  KNOWN_ROOT_KEYS,
  loadConfig,
  nearestKey,
  readConfigStrict,
  validateConfig,
  watchConfig
} from "../config.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(cond: () => boolean, timeoutMs: number) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms`)
    await sleep(50)
  }
}

/** 字段齐全、类型正确的配置：不应产生任何告警 */
function validConfig(): Record<string, any> {
  return {
    version: "1.0.0",
    enabled: true,
    agent_name: "test-agent",
    outputDir: "/tmp/data",
    "user.id": "u1",
    features: { debug: false, captureMessageContent: true, linkSubagentTrace: true, logRetentionDays: 14 },
    otel: {
      agentarts_agentops_otel_agent_apm_enable: true,
      agentarts_agentops_otel_agent_aom_enable: true,
      agent_domain_id: "d1",
      agentarts_project_id: "p1",
      agent_resource_id: "r1",
      resource_type: "agent",
      resource_version: "default",
      agentarts_agentops_apm_token: "t",
      agentarts_agentops_apm_exporter_endpoint: "https://apm-access.cn-southwest-2.myhuaweicloud.com",
      agentarts_agentops_aom_access_code: "c",
      agentarts_agentops_aom_exporter_endpoint: "https://aom-access.cn-southwest-2.myhuaweicloud.com",
      agentarts_agentops_aom_prometheus_id: "prom1"
    }
  }
}

test("validateConfig：端点缺少协议时告警", () => {
  const config = validConfig()
  config.otel.agentarts_agentops_apm_exporter_endpoint = "apm-access.cn-southwest-2.myhuaweicloud.com"
  const issues = validateConfig(config)
  const issue = issues.find((i) => i.field === "otel.agentarts_agentops_apm_exporter_endpoint")
  assert.ok(issue, "缺少协议的端点应告警")
  assert.match(issue!.message, /https:\/\//)

  // 显式带协议的地址不应告警
  config.otel.agentarts_agentops_apm_exporter_endpoint = "https://apm-access.cn-southwest-2.myhuaweicloud.com"
  const clean = validateConfig(config)
  assert.equal(clean.some((i) => i.field === "otel.agentarts_agentops_apm_exporter_endpoint"), false)
})

test("validateConfig：完整有效配置无告警", () => {
  assert.deepEqual(validateConfig(validConfig()), [])
})

test("validateConfig：otel 缺失告警；enabled=false 时跳过 otel 检查", () => {
  const missing = validConfig()
  delete missing.otel
  const issues = validateConfig(missing)
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /no traces or metrics/)

  const disabled = { enabled: false }
  const disabledIssues = validateConfig(disabled)
  assert.equal(disabledIssues.some((i) => i.field === "otel"), false)
})

test("validateConfig：APM/AOM 开启但必填项缺失分别告警", () => {
  const config = validConfig()
  config.otel.agentarts_agentops_apm_token = ""
  delete config.otel.agentarts_agentops_aom_prometheus_id
  const messages = validateConfig(config)
    .filter((i) => i.field === "otel")
    .map((i) => i.message)
  assert.equal(messages.some((m) => m.includes("APM (traces) is enabled but missing")), true)
  assert.equal(messages.some((m) => m.includes("AOM (metrics) is enabled but missing")), true)
  assert.equal(messages.some((m) => m.includes("agentarts_agentops_apm_token")), true)
  assert.equal(messages.some((m) => m.includes("agentarts_agentops_aom_prometheus_id")), true)
})

test("validateConfig：两个上报通道都关闭时告警", () => {
  const config = validConfig()
  config.otel.agentarts_agentops_otel_agent_apm_enable = false
  config.otel.agentarts_agentops_otel_agent_aom_enable = false
  const issues = validateConfig(config)
  assert.equal(issues.some((i) => i.message.includes("are off; nothing will be reported")), true)
})

test("validateConfig：拼写错误的键给出最近键建议", () => {
  const config = validConfig()
  config.agent_nam = "typo" // 未知根键（距离 agent_name 1）
  config.otel.agentarts_agentops_apm_tokenn = "x" // 未知 otel 键（距离 1）
  const issues = validateConfig(config)
  const root = issues.find((i) => i.field === "config.agent_nam")
  assert.ok(root, "未知根键应告警")
  assert.match(root!.message, /did you mean "agent_name"/)
  const otel = issues.find((i) => i.field === "otel.agentarts_agentops_apm_tokenn")
  assert.ok(otel, "未知 otel 键应告警")
  assert.match(otel!.message, /did you mean "agentarts_agentops_apm_token"/)
})

test("validateConfig：features 类型与取值检查", () => {
  const config = validConfig()
  config.features.debug = "yes"
  config.features.logRetentionDays = -1
  config.features.logRetentionDayss = 3
  const issues = validateConfig(config)
  assert.equal(issues.some((i) => i.field === "features.debug" && /expected boolean/.test(i.message)), true)
  assert.equal(issues.some((i) => i.field === "features.logRetentionDays" && /non-negative integer/.test(i.message)), true)
  assert.equal(issues.some((i) => i.field === "features.logRetentionDayss" && /did you mean "logRetentionDays"/.test(i.message)), true)
})

test("validateConfig：resource_type 非法取值与空 AgentArts 标识告警", () => {
  const config = validConfig()
  config.otel.resource_type = "foo"
  config.otel.agent_domain_id = ""
  const issues = validateConfig(config)
  assert.equal(
    issues.some((i) => i.field === "otel.resource_type" && /agent\|multiagents\|workflow/.test(i.message)),
    true
  )
  assert.equal(issues.some((i) => i.field === "otel.agent_domain_id" && /blank/.test(i.message)), true)
})

test("nearestKey：短键距离 1、长键距离 2 内给出建议，否则不给", () => {
  assert.equal(nearestKey("agent_nam", KNOWN_ROOT_KEYS), "agent_name")
  assert.equal(nearestKey("agentarts_agentops_apm_tokenn", KNOWN_OTEL_KEYS), "agentarts_agentops_apm_token")
  assert.equal(nearestKey("xyzzy", KNOWN_ROOT_KEYS), undefined)
})

test("readConfigStrict：JSONC 解析、坏 JSON 返回 error 不落回默认", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-read-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, '// 注释\n{ "agent_name": "x" }')
  const ok = readConfigStrict(file)
  assert.equal(ok.config!.agent_name, "x")
  assert.equal(ok.config!.features.debug, false, "features 合并默认值")
  assert.equal(ok.error, undefined)
  fs.writeFileSync(file, "{ broken json")
  const bad = readConfigStrict(file)
  assert.equal(bad.config, undefined, "解析失败不应给出配置")
  assert.ok(bad.error)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("watchConfig：变更回调、解析失败回调、dispose 后停止", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-watch-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, JSON.stringify({ agent_name: "v1" }))
  const events: string[] = []
  const errors: unknown[] = []
  const stop = watchConfig(
    file,
    (next) => events.push(next.agent_name),
    (error) => errors.push(error)
  )
  await sleep(400) // watcher 就绪
  fs.writeFileSync(file, JSON.stringify({ agent_name: "v2" }))
  await until(() => events.length === 1, 3000)
  assert.deepEqual(events, ["v2"])
  fs.writeFileSync(file, "{ broken")
  await until(() => errors.length === 1, 3000)
  assert.equal(events.length, 1, "解析失败不应触发 onChange")
  fs.writeFileSync(file, JSON.stringify({ agent_name: "v2" }))
  await sleep(600)
  assert.deepEqual(events, ["v2"], "内容未变不应触发（重复写 v2）")
  stop()
  fs.writeFileSync(file, JSON.stringify({ agent_name: "v3" }))
  await sleep(600)
  assert.deepEqual(events, ["v2"], "dispose 后不再回调")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("loadConfig(path)：带注释文件解析与默认合并", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-load-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(file, '// c\n{ "features": { "debug": true } }')
  const config = loadConfig(file)
  assert.equal(config.features.debug, true)
  assert.equal(config.features.captureMessageContent, true, "未覆盖项取默认值")
  assert.equal(config.enabled, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

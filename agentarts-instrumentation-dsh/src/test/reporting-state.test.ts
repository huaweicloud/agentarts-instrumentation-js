// 上报能力判定测试：未配置 / 半配置 / 完整配置。
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveReportingState } from "../config.js"

const completeApm = {
  agentarts_agentops_otel_agent_apm_enable: true,
  agentarts_agentops_apm_exporter_endpoint: "https://apm.example",
  agentarts_agentops_apm_token: "t"
}

const completeAom = {
  agentarts_agentops_otel_agent_aom_enable: true,
  agentarts_agentops_aom_exporter_endpoint: "https://aom.example",
  agentarts_agentops_aom_access_code: "c",
  agentarts_agentops_aom_prometheus_id: "p"
}

test("resolveReportingState：无 otel 配置时不就绪", () => {
  const state = resolveReportingState({ enabled: true })
  assert.equal(state.ready, false)
  assert.equal(state.apmEnabled, false)
  assert.equal(state.aomEnabled, false)
  assert.deepEqual(state.missing, [])
})

test("resolveReportingState：APM 完整时只启用 APM", () => {
  const state = resolveReportingState({ enabled: true, otel: { ...completeApm } })
  assert.equal(state.ready, true)
  assert.equal(state.apmEnabled, true)
  assert.equal(state.aomEnabled, false)
})

test("resolveReportingState：AOM 完整时只启用 AOM", () => {
  const state = resolveReportingState({ enabled: true, otel: { ...completeAom } })
  assert.equal(state.ready, true)
  assert.equal(state.apmEnabled, false)
  assert.equal(state.aomEnabled, true)
})

test("resolveReportingState：声明启用但缺端点/凭证时不就绪并给出缺失项", () => {
  const state = resolveReportingState({
    enabled: true,
    otel: { agentarts_agentops_otel_agent_apm_enable: true, agentarts_agentops_apm_token: "t" }
  })
  assert.equal(state.ready, false)
  assert.equal(state.apmEnabled, false)
  assert.equal(state.missing.length, 1)
  assert.match(state.missing[0], /APM/)
})

test("resolveReportingState：AOM 缺少 prometheus id 时不就绪", () => {
  const state = resolveReportingState({
    enabled: true,
    otel: { ...completeAom, agentarts_agentops_aom_prometheus_id: "" }
  })
  assert.equal(state.ready, false)
  assert.equal(state.aomEnabled, false)
  assert.match(state.missing[0], /AOM/)
})

test("resolveReportingState：enabled=false 时即使配置完整也不就绪", () => {
  const state = resolveReportingState({ enabled: false, otel: { ...completeApm } })
  assert.equal(state.ready, false)
  assert.equal(state.apmEnabled, true, "通道本身可用，但总开关关闭")
})

test("resolveReportingState：APM 与 AOM 同时完整时两路都启用", () => {
  const state = resolveReportingState({ enabled: true, otel: { ...completeApm, ...completeAom } })
  assert.equal(state.ready, true)
  assert.equal(state.apmEnabled, true)
  assert.equal(state.aomEnabled, true)
})

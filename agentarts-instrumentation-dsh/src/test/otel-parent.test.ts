// OTel 层行为测试：验证初始化与父 trace 串联语义（node --test，构建后运行）
import { test } from "node:test"
import assert from "node:assert/strict"
import { beginRootSpan, initOtel, shutdownOtel } from "../otel-reporter.js"

test("beginRootSpan：无父时新建 root span；有父时沿用父 traceId", async () => {
  // 构造 exporter 不发起连接（仅导出时才连接），endpoint 指向不可达地址即可
  initOtel({
    agentarts_agentops_otel_agent_apm_enable: true,
    agentarts_agentops_otel_agent_aom_enable: false,
    agentarts_agentops_apm_token: "t",
    agentarts_agentops_apm_exporter_endpoint: "http://127.0.0.1:14317",
    agent_domain_id: "d",
    agent_resource_id: "r"
  })

  const root = beginRootSpan(Date.now(), undefined, "parent-agent")
  assert.ok(root, "应创建 root span")
  const rootContext = root!.span.spanContext()
  assert.match(rootContext.traceId, /^[0-9a-f]{32}$/)
  assert.match(rootContext.spanId, /^[0-9a-f]{16}$/)

  // 子 agent：以父 context 为 parent，traceId 必须一致（串联生效）
  const child = beginRootSpan(Date.now(), { traceId: rootContext.traceId, spanId: rootContext.spanId }, "child-agent")
  assert.ok(child, "应创建子 root span")
  const childContext = child!.span.spanContext()
  assert.equal(childContext.traceId, rootContext.traceId, "子 span 应沿用父 traceId")
  assert.notEqual(childContext.spanId, rootContext.spanId, "子 span 应有独立 spanId")

  root!.span.end()
  child!.span.end()
  await shutdownOtel()
})

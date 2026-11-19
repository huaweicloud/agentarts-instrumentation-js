// 映射层单元测试（node --test，构建后运行：npm run build && npm test）
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyUsageToRecord, llmRequestAttributes, mapContentBlock, mapFinishReason } from "../mapping.js"

test("mapFinishReason 对齐 AgentArts 规范", () => {
  assert.equal(mapFinishReason("tool-calls"), "tool_calls")
  assert.equal(mapFinishReason("max-tokens"), "length")
  assert.equal(mapFinishReason("aborted"), "cancelled")
  assert.equal(mapFinishReason("stop"), "stop")
  assert.equal(mapFinishReason("error"), "error")
  assert.equal(mapFinishReason(undefined), "unknown")
})

test("mapContentBlock 覆盖各内容块类型", () => {
  assert.deepEqual(mapContentBlock({ type: "text", text: "hi" }), { type: "text", content: "hi" })
  assert.deepEqual(mapContentBlock({ type: "reasoning", text: "r" }), { type: "reasoning", content: "r" })
  assert.deepEqual(mapContentBlock({ type: "tool-call", id: "c1", name: "pwsh", arguments: "{}" }), {
    type: "tool_call",
    id: "c1",
    name: "pwsh",
    arguments: "{}"
  })
  assert.deepEqual(mapContentBlock({ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }), {
    type: "tool_call_response",
    id: "c1",
    response: "ok"
  })
  assert.deepEqual(mapContentBlock({ type: "image", source: {} }), { type: "image", content: "" })
})

test("applyUsageToRecord 汇总 token（含缓存读写）", () => {
  const record: Record<string, unknown> = {}
  applyUsageToRecord(record, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    reasoningTokens: 7
  })
  assert.equal(record["gen_ai.usage.input_tokens"], 15) // 10 + 3 + 2
  assert.equal(record["gen_ai.usage.output_tokens"], 5)
  assert.equal(record["gen_ai.usage.total_tokens"], 20)
  assert.equal(record["gen_ai.usage.cache_read.input_tokens"], 3)
  assert.equal(record["gen_ai.usage.cache_write.input_tokens"], 2)
  assert.equal(record["gen_ai.usage.cache_creation.input_tokens"], 2)
  assert.equal(record["gen_ai.usage.reasoning_tokens"], 7)
})

test("llmRequestAttributes 可选参数仅在提供时上报", () => {
  const minimal = llmRequestAttributes({ provider: "baidu", model: "glm" })
  assert.equal(minimal["gen_ai.provider.name"], "baidu")
  assert.equal(minimal["gen_ai.request.model"], "glm")
  assert.equal(minimal["gen_ai.request.is_stream"], true)
  assert.equal("gen_ai.request.temperature" in minimal, false)

  const full = llmRequestAttributes({
    provider: "baidu",
    model: "glm",
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: "high",
    stop: ["\n\n"]
  })
  assert.equal(full["gen_ai.request.temperature"], 0.7)
  assert.equal(full["gen_ai.request.max_tokens"], 4096)
  assert.equal(full["gen_ai.request.reasoning_effort"], "high")
  assert.deepEqual(full["gen_ai.request.stop_sequences"], ["\n\n"])
})

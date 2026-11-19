// token 用量提取测试：单次 LLM span 与根 span 累计共用同一口径，
// 尤其要覆盖缓存读写 token——它们只在 llm.response 事件上，曾被漏算。
import { test } from "node:test"
import assert from "node:assert/strict"
import { llmUsageFromEvents, rootUsageAttributes } from "../otel-reporter.js"

const usageEvent = (usage: Record<string, unknown>) => [
  { "event.name": "llm.request", "time_unix_nano": "1" },
  { "event.name": "llm.response", "time_unix_nano": "2", ...usage }
]

test("llmUsageFromEvents：提取 input/output/total", () => {
  const usage = llmUsageFromEvents(
    usageEvent({
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.total_tokens": 120
    }) as any
  )
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
})

test("llmUsageFromEvents：提取缓存读写 token（关键回归点）", () => {
  const usage = llmUsageFromEvents(
    usageEvent({
      "gen_ai.usage.input_tokens": 150,
      "gen_ai.usage.output_tokens": 8,
      "gen_ai.usage.total_tokens": 158,
      "gen_ai.usage.cache_read.input_tokens": 40,
      "gen_ai.usage.cache_write.input_tokens": 10
    }) as any
  )
  assert.equal(usage!.cacheReadTokens, 40, "缓存读取 token 必须被提取")
  assert.equal(usage!.cacheWriteTokens, 10, "缓存写入 token 必须被提取")
})

test("llmUsageFromEvents：无 response 事件时返回 null", () => {
  assert.equal(llmUsageFromEvents([{ "event.name": "llm.request" }] as any), null)
  assert.equal(llmUsageFromEvents([] as any), null)
})

test("llmUsageFromEvents：缺失或非数字字段按 0 处理，不产生 NaN", () => {
  const usage = llmUsageFromEvents(
    usageEvent({
      "gen_ai.usage.input_tokens": "n/a",
      "gen_ai.usage.cache_read.input_tokens": null
    }) as any
  )
  assert.equal(usage!.inputTokens, 0)
  assert.equal(usage!.cacheReadTokens, 0)
  assert.equal(Number.isNaN(usage!.outputTokens), false)
})

test("rootUsageAttributes：缓存 token 与 input/output 一起写入根节点", () => {
  const attrs = rootUsageAttributes({
    inputTokens: 288,
    outputTokens: 15,
    totalTokens: 303,
    cacheReadTokens: 60,
    cacheWriteTokens: 8
  })
  assert.equal(attrs["gen_ai.usage.input_tokens"], 288)
  assert.equal(attrs["gen_ai.usage.output_tokens"], 15)
  assert.equal(attrs["gen_ai.usage.total_tokens"], 303)
  assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 60, "根节点必须带缓存读取累计值")
  assert.equal(attrs["gen_ai.usage.cache_write.input_tokens"], 8)
  assert.equal(attrs["gen_ai.usage.cache_creation.input_tokens"], 8, "cache_creation 与 cache_write 一致")
})

test("rootUsageAttributes：无缓存时不写缓存属性", () => {
  const attrs = rootUsageAttributes({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
  assert.equal("gen_ai.usage.cache_read.input_tokens" in attrs, false)
  assert.equal("gen_ai.usage.cache_write.input_tokens" in attrs, false)
  assert.equal(attrs["gen_ai.usage.input_tokens"], 10)
})

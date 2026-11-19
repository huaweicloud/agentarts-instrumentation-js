// DSH 消息/事件结构 → AgentArts gen_ai 规范字段映射
// （对齐 AgentArts TRACE 规范与 llama-index 参考实现的属性命名）

export function mapContentBlock(block: any) {
  switch (block.type) {
    case "text":
      return { type: "text", content: block.text }
    case "reasoning":
      return { type: "reasoning", content: block.text }
    case "tool-call":
      return {
        type: "tool_call",
        id: block.id,
        name: block.name,
        arguments: block.arguments
      }
    case "tool-result": {
      const nested = Array.isArray(block.content) ? block.content.map(mapContentBlock) : []
      const resultText = nested.map((p: any) => p.content || "").filter(Boolean).join("")
      return {
        type: "tool_call_response",
        id: block.toolCallId,
        response: resultText
      }
    }
    case "image":
      return { type: "image", content: "" }
    default:
      return { type: block.type, content: JSON.stringify(block) }
  }
}

export function mapContent(blocks: any[]) {
  return blocks.map(mapContentBlock)
}

export function mapInputMessage(message: any) {
  return {
    role: message.source.kind === "tool" ? "tool" : message.role,
    parts: mapContent(message.content)
  }
}

export function mapInputMessages(messages: any[]) {
  return messages.map(mapInputMessage)
}

export function mapOutputMessage(message: any, finishReason: string) {
  return {
    role: message.role,
    parts: mapContent(message.content),
    finish_reason: finishReason
  }
}

export function mapToolDefinitions(tools: any[]) {
  if (!tools) return []
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    content: tool.description || "",
    arguments: JSON.stringify(tool.parameters)
  }))
}

export function mapSystemInstruction(system: string) {
  return system === undefined || system === "" ? [] : [{ type: "text", content: system }]
}

export function mapFinishReason(reason: string) {
  switch (reason) {
    case "tool-calls":
      return "tool_calls"
    case "max-tokens":
      return "length"
    case "aborted":
      return "cancelled"
    case "stop":
    case "error":
      return reason
    default:
      return reason ?? "unknown"
  }
}

export function applyUsageToRecord(record: Record<string, unknown>, usage: any) {
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  record["gen_ai.usage.input_tokens"] = usage.inputTokens + cacheReadTokens + cacheWriteTokens
  record["gen_ai.usage.output_tokens"] = usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    record["gen_ai.usage.cache_read.input_tokens"] = usage.cacheReadTokens
  }
  if (usage.cacheWriteTokens !== undefined) {
    record["gen_ai.usage.cache_write.input_tokens"] = usage.cacheWriteTokens
    record["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWriteTokens
  }
  record["gen_ai.usage.total_tokens"] = record["gen_ai.usage.input_tokens"] + usage.outputTokens
  if (usage.reasoningTokens !== undefined) {
    record["gen_ai.usage.reasoning_tokens"] = usage.reasoningTokens
  }
}

export function llmRequestAttributes(options: any) {
  return {
    "gen_ai.provider.name": options.provider,
    "gen_ai.request.model": options.model,
    ...(options.reasoningEffort === undefined
      ? {}
      : { "gen_ai.request.reasoning_effort": options.reasoningEffort }),
    // 对齐 llama-index mapper.py:to_llm_request_attrs — 从 DshGenerateOptions 提取可选请求参数
    ...(options.temperature === undefined ? {} : { "gen_ai.request.temperature": options.temperature }),
    // TRACE 规范可选字段：max_tokens（DSH options.maxTokens 可得即上报）
    ...(options.maxTokens === undefined ? {} : { "gen_ai.request.max_tokens": options.maxTokens }),
    // TRACE 规范可选字段：是否流式 — DSH 经 llm/stream 拦截观测，恒为流式调用
    "gen_ai.request.is_stream": true,
    ...(options.stop === undefined || options.stop.length === 0
      ? {}
      : { "gen_ai.request.stop_sequences": options.stop })
  }
}

export function extractToolResultText(message: any) {
  const resultBlock = message.content.find((block: any) => block.type === "tool-result")
  if (resultBlock?.type === "tool-result") {
    const nested = resultBlock.content
    if (Array.isArray(nested)) {
      return nested.map((b: any) => b.text || "").filter(Boolean).join("")
    }
  }
  return mapContent(message.content).map((p: any) => p.content || "").filter(Boolean).join("")
}

// Bundle 冒烟测试：验证 dist/plugin.mjs 能被 ESM 正常加载且导出插件类。
// 这个测试专门防住"打包产物本身无法在宿主中加载"的问题
//（例如缺 createRequire banner 导致的 "Dynamic require of X is not supported"），
// 层一的脚本级测试不会加载 bundle，覆盖不到这里。
import { test } from "node:test"
import assert from "node:assert/strict"

test("dist/plugin.mjs 可作为 ESM 加载并导出默认插件类", async () => {
  // 用动态 specifier 避免 tsc 对 .mjs 产物做静态模块解析（bundle 无 .d.ts）
  const bundleUrl = new URL("../plugin.mjs", import.meta.url).href
  const mod: any = await import(bundleUrl)
  const Plugin = mod.default
  assert.equal(typeof Plugin, "function", "默认导出应为类/函数")
  assert.deepEqual(Plugin.inject, ["sessions"], "应声明 inject sessions")
  assert.ok(Plugin.Config, "应声明 Config schema")
})

// 构建脚本：注入版本号 → esbuild 打包单文件 ESM 产物 dist/plugin.mjs。
// 依赖全部内联（devDependencies 不进运行时），npm 产物零依赖。
// 产物文件名前缀规则见 scripts/pack.mjs（installer 按该前缀自动探测）。
import { build } from "esbuild"
import fs from "node:fs"

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))

// 1) 把 package.json 的版本写入 src/probe-version.generated.ts（唯一事实来源，勿手改）
fs.writeFileSync(
  new URL("./src/probe-version.generated.ts", import.meta.url),
  `// 探针版本号（构建时由 build.mjs 从 package.json 注入；勿手改）\nexport const PROBE_VERSION = ${JSON.stringify(pkg.version)}\n`
)

// 2) esbuild 打包：src/plugin.ts -> dist/plugin.mjs
// banner 必不可少：打包进来的 CJS 依赖（@grpc/grpc-js、部分 OTel 组件）会调用
// require("async_hooks") 等 Node 内置模块；ESM 产物里没有 require，必须用
// createRequire 注入，否则 DSH 加载 bundle 时报 "Dynamic require of X is not supported"。
const REQUIRE_SHIM = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  outfile: "dist/plugin.mjs",
  banner: { js: REQUIRE_SHIM },
  logLevel: "info"
})

console.log(`[build] dist/plugin.mjs (probe version ${pkg.version})`)

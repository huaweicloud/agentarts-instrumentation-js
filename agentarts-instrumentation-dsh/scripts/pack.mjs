// 打包脚本：npm pack 后把产物重命名为 installer 可自动探测的形态。
//
// npm pack 的默认产物名规则：
//   scoped 包 @scope/name  → scope-name-<version>.tgz（带 scope 前缀）
//   非 scoped 包 name      → name-<version>.tgz
//
// 本包当前是非 scoped（huaweicloud-agentarts-observation-dsh-plugin），
// 产物名已符合要求；脚本保留 scoped 分支，便于将来若重新加 scope 时继续工作。
import fs from "node:fs"

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const unscopedName = pkg.name.replace(/^@[^/]+\//, "")
const target = `${unscopedName}-${pkg.version}.tgz`

// npm pack 实际输出的文件名
const scopeMatch = pkg.name.match(/^@([^/]+)\//)
const packed = scopeMatch
  ? `${scopeMatch[1]}-${unscopedName}-${pkg.version}.tgz`
  : `${unscopedName}-${pkg.version}.tgz`

if (!fs.existsSync(packed)) {
  // 可能已经重命名过（重复运行）
  if (fs.existsSync(target)) {
    console.log(`[pack] 产物已是目标文件名: ${target}`)
    process.exit(0)
  }
  console.error(`[pack] 未找到 npm pack 产物: ${packed}（请先运行 npm pack）`)
  process.exit(1)
}

if (packed === target) {
  console.log(`[pack] 产物名已符合要求，无需重命名: ${target}`)
} else {
  fs.renameSync(packed, target)
  console.log(`[pack] ${packed} -> ${target}`)
}

// 打包脚本：npm pack 后把 scoped 包的 cloud- 前缀产物重命名为无前缀形态
// （huaweicloud-agentarts-observation-dsh-plugin-<version>.tgz），
// 与 installer/ 安装脚本的自动探测规则（$PluginTarballPrefix-*.tgz）对齐。
import fs from "node:fs"
import path from "node:path"

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const scopedPrefix = pkg.name.replace(/^@([^/]+)\/.*$/, "$1") + "-" // npm pack 对 @cloud/* 产出 cloud- 前缀
const unscopedName = pkg.name.replace(/^@[^/]+\//, "")
const expected = `${scopedPrefix}${unscopedName}-${pkg.version}.tgz`
const target = `${unscopedName}-${pkg.version}.tgz`

if (!fs.existsSync(expected)) {
  console.error(`[pack] npm pack output not found: ${expected}（先运行 npm pack）`)
  process.exit(1)
}
fs.renameSync(expected, target)
console.log(`[pack] ${expected} -> ${path.resolve(target)}`)

#!/usr/bin/env node
// 发布流水线：构建 → 产物漂移校验 → 测试 → 打包清单校验 → 生成插件市场索引。
//
// 用法（在 dsh/ 包目录下）：
//   node scripts/release.mjs                  # 完整流水线
//   node scripts/release.mjs --dry-run        # 只检查与报告，不写文件
//   node scripts/release.mjs --commit <sha>   # 指定索引引用的 commit（打 tag 后重跑时用）
//
// 退出码：0 通过；非 0 表示有一步失败，按提示修复后重跑。
//
// 为什么要做"产物漂移校验"：dist/plugin.mjs 是入库的分发产物，DSH 从 Git 安装时
// 直接使用它、不会构建。如果改了 src/ 却忘记重新构建提交，用户装到的就是旧逻辑，
// 而这种不一致用肉眼极难发现。
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const commitArg = (() => {
  const i = args.indexOf("--commit")
  return i >= 0 ? args[i + 1] : undefined
})()

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const info = (m) => console.log(`  ${m}`)
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`)
const fail = (m) => {
  console.error(`\x1b[31m✗\x1b[0m ${m}`)
  process.exit(1)
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: PKG_DIR, stdio: "inherit", ...opts })
}
function capture(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { cwd: PKG_DIR, encoding: "utf8" }).trim()
}
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"))
const bundlePath = path.join(PKG_DIR, pkg.main)

console.log(`\n== 发布 ${pkg.name}@${pkg.version} ==\n`)

// ── 1. Git 环境 ───────────────────────────────────────────────────────────
let repoRoot, commit, remoteUrl
try {
  repoRoot = capture("git", ["rev-parse", "--show-toplevel"])
  commit = commitArg ?? capture("git", ["rev-parse", "HEAD"])
  remoteUrl = capture("git", ["remote", "get-url", "origin"])
} catch {
  fail("无法读取 git 信息（需要是 git 仓库并配置了 origin 远端）")
}
const pkgSubdir = path.relative(repoRoot, PKG_DIR).split(path.sep).join("/")
ok(`git 仓库: ${repoRoot}`)
info(`包目录: ${pkgSubdir || "(仓库根)"}`)
info(`commit: ${commit}`)

// 规范化远端地址为 https 形式
function normalizeRepoUrl(url) {
  const m = url.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+?)(?:\.git)?$/)
  if (m) return `https://${m[1]}/${m[2].replace(/\.git$/, "")}`
  return url.replace(/\.git$/, "")
}
const repoUrl = normalizeRepoUrl(remoteUrl)
info(`仓库: ${repoUrl}`)

// ── 2. 构建（含 tsc 类型检查）─────────────────────────────────────────────
// dry-run 同样执行构建：漂移校验与测试都依赖编译产物，而 dist/ 下除
// plugin.mjs 外都是 gitignore 的中间产物，不构成仓库改动。
const beforeHash = fs.existsSync(bundlePath) ? sha256(bundlePath) : null
console.log("\n[1/5] 构建")
// 直接调用 tsc 的 JS 入口与 build.mjs，不经过 npm/.cmd 包装：
// Windows 下 Node 拒绝 spawn .cmd（EINVAL），而这两个入口都是纯 JS，跨平台一致。
const tscEntry = path.join(PKG_DIR, "node_modules", "typescript", "bin", "tsc")
if (!fs.existsSync(tscEntry)) fail("未安装依赖：请先在包目录执行 npm install")
run(process.execPath, [tscEntry])
run(process.execPath, [path.join(PKG_DIR, "build.mjs")])

// ── 3. 产物漂移校验 ───────────────────────────────────────────────────────
console.log("\n[2/5] 产物漂移校验")
if (!fs.existsSync(bundlePath)) fail(`构建产物不存在: ${pkg.main}`)
const afterHash = sha256(bundlePath)
if (beforeHash === null) {
  warn("仓库中原本没有产物，本次构建生成的版本需一并提交")
} else if (beforeHash !== afterHash) {
  warn("产物与源码不一致，已重新生成 dist/plugin.mjs")
  info("这通常意味着改了 src/ 但忘了重新构建并提交产物。")
  info("请检查 diff 后提交，再重跑本脚本。")
  fail("产物漂移：请先提交重新生成的 dist/plugin.mjs")
} else {
  ok("产物与已提交版本一致")
}

// ── 4. 测试 ───────────────────────────────────────────────────────────────
console.log("\n[3/5] 测试")
const testDir = path.join(PKG_DIR, "dist", "test")
const testFiles = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort()
  : []
if (testFiles.length === 0) fail("未找到编译后的测试文件（dist/test/*.test.js）")
let total = 0
for (const file of testFiles) {
  // 逐个文件运行：node --test 的 glob 在部分平台不会被展开，显式枚举最稳妥
  const out = execFileSync(process.execPath, [path.join(testDir, file)], {
    cwd: PKG_DIR,
    encoding: "utf8"
  })
  const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? 0)
  const failed = Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? 0)
  if (failed > 0) fail(`${file} 有 ${failed} 个用例失败`)
  total += pass
  info(`${file}: ${pass} 通过`)
}
ok(`测试全部通过（共 ${total} 个用例）`)

// ── 5. 打包清单校验 ───────────────────────────────────────────────────────
console.log("\n[4/5] 打包清单校验")
const missing = []
for (const entry of pkg.files ?? []) {
  if (entry.includes("*")) {
    const dir = path.join(PKG_DIR, path.dirname(entry))
    const suffix = entry.slice(entry.lastIndexOf("*") + 1)
    const prefix = path.basename(entry).slice(0, path.basename(entry).lastIndexOf("*"))
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith(suffix))
      : false
    if (!hit) missing.push(entry)
  } else if (!fs.existsSync(path.join(PKG_DIR, entry))) {
    missing.push(entry)
  }
}
if (missing.length > 0) fail(`files 中列出的路径不存在: ${missing.join(", ")}`)
ok(`files 清单 ${pkg.files.length} 项均存在`)

const firstLine = fs.readFileSync(bundlePath, "utf8").split("\n")[0]
if (!firstLine.includes("createRequire")) {
  fail("产物缺少 createRequire banner：ESM 中 CJS 依赖的 require() 会抛错，插件无法被宿主加载")
}
ok("产物包含 createRequire banner")

if (!pkg.dsh?.bundle?.patch) fail("package.json 缺少 dsh.bundle.patch 声明")
if (!fs.existsSync(path.join(PKG_DIR, pkg.dsh.bundle.patch))) {
  fail(`dsh.bundle.patch 指向的文件不存在: ${pkg.dsh.bundle.patch}`)
}
ok(`bundle patch: ${pkg.dsh.bundle.patch}`)

if (!pkg.engines?.dsh) warn("package.json 未声明 engines.dsh，安装时不校验 DSH 版本兼容性")

// ── 6. 生成插件市场索引 ───────────────────────────────────────────────────
console.log("\n[5/5] 生成插件市场索引")
const marketDir = path.join(PKG_DIR, "market")
const indexPath = path.join(marketDir, "index.json")

// 从 locale 读取显示文本（与 DSH 插件管理器使用的字段一致）
const localeDir = path.join(PKG_DIR, "locale")
const titles = {}
const descriptions = {}
for (const file of fs.readdirSync(localeDir).filter((f) => f.endsWith(".json"))) {
  const lang = path.basename(file, ".json")
  const meta = JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8")).meta ?? {}
  if (meta.title) titles[lang] = meta.title
  if (meta.description) descriptions[lang] = meta.description
}
if (!titles.en) fail("locale/en.json 缺少 meta.title（索引的 title 必须包含 en）")

const iconRel = path
  .relative(marketDir, path.join(PKG_DIR, "icon.svg"))
  .split(path.sep)
  .join("/")

const index = {
  format: 1,
  title: { en: "Huawei Cloud AgentArts", zh: "华为云 AgentArts" },
  plugins: [
    {
      name: pkg.name,
      title: titles,
      description: descriptions,
      icon: iconRel,
      author: "Huawei Cloud",
      repository: {
        url: repoUrl,
        ...(pkgSubdir ? { directory: pkgSubdir } : {})
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: {
            type: "git",
            url: repoUrl,
            commit,
            ...(pkgSubdir ? { path: pkgSubdir } : {})
          },
          ...(pkg.engines?.dsh ? { engines: { dsh: pkg.engines.dsh } } : {})
        }
      ]
    }
  ]
}

if (dryRun) {
  info(`dry-run：索引内容将写入 ${path.relative(PKG_DIR, indexPath)}（本次不写）`)
} else {
  fs.mkdirSync(marketDir, { recursive: true })
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8")
  ok(`索引已写入 ${path.relative(PKG_DIR, indexPath)}`)
  info(`source: git ${repoUrl} @ ${commit.slice(0, 8)}${pkgSubdir ? ` (${pkgSubdir})` : ""}`)
}

// ── 完成 ──────────────────────────────────────────────────────────────────
console.log("\n== 完成 ==\n")
if (dryRun) {
  console.log("dry-run 结束，未写入任何文件。")
} else {
  console.log("后续步骤：")
  console.log(`  1. 提交产物与索引：git add -A && git commit -m "chore: 发布 v${pkg.version}"`)
  console.log(`  2. 打标签：        git tag v${pkg.version}`)
  console.log("  3. 推送：          git push origin HEAD --tags")
  console.log("")
  console.log("注意：索引中的 commit 指向生成索引时的 HEAD。若先打标签再生成索引，")
  console.log(`可用 --commit $(git rev-parse v${pkg.version}) 让索引精确指向发布提交。`)
}

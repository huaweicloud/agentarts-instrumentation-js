<#
.SYNOPSIS
  DSH AgentArts Observation Plugin - single entry installer/uninstaller (Windows).

.DESCRIPTION
  Subcommands (first positional argument; default: install):
    install    Install / re-install the plugin into profile(s):
                 1. locates the dsh CLI (PATH -> DSH checkout via node+tsx / pnpm)
                 2. installs the plugin package (dsh plugin --profile add;
                    tarball source auto-detected: script dir -> repo root -> repo dist/)
                 3. registers the bundle in the profile's dsh.profile.bundles
                    (backup -> modify -> verify; official bundle registration)
                 4. generates/merges ~/.dsh/plugins/<插件包名>/config.json (backup ->
                    merge; unrelated fields are kept)
                 5. verifies the composition via --dump-config (exactly 1 entry)
               Idempotent: safe to re-run. Install-only parameters are
               ignored by the other subcommands.
    configure  Write/merge ~/.dsh/plugins/<插件包名>/config.json only, without
               touching any profile. Use it when the plugin was installed some
               other way (Plugins UI, or dsh plugin add from a Git repository),
               so installation and configuration stay decoupled.
    uninstall  Remove the plugin (per profile): bundle registration (backup ->
               modify -> verify), plugin dependency (dsh plugin --profile remove),
               and ~/.dsh/plugins/<插件包名>/config.json (backed up first) unless -KeepConfig.
    status     Show registration state per profile: bundle in
               dsh.profile.bundles, dependency spec, installed package version,
               config presence, and composition entry count (--dump-config).
               Exit code 0 when every listed profile has the bundle registered
               (and the composition verifies when the dsh CLI is available).
    help       Show this help.

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 -AgentId <id> -DomainId <id> -ProjectId <id> `
    -Endpoint https://apm-access.<region>.myhuaweicloud.com -Token <token> `
    -AomEndpoint https://aom-access.<region>.myhuaweicloud.com `
    -AomAccessCode <code> -AomPrometheusId <id> `
    -ResourceType agent

  # In-cluster plaintext gRPC is also supported: -Endpoint http://10.x.x.x:4317

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 install -AgentId <id> ...   # same, explicit subcommand

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 status

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 uninstall -Yes -KeepConfig
#>
param(
    # Subcommand (first positional argument; default: install)
    [string]$Command = 'install',

    # Shared: DSH profile(s), comma-separated (default: web; e.g. "web,headless")
    [string]$Profile = "web",

    # Shared: DSH source checkout used when dsh is not on PATH
    [string]$DshRoot,

    # install: plugin package (local dir or tarball; auto-detected when omitted)
    [string]$PackagePath,

    # install: AgentArts business parameters (written into config.json)
    [string]$AgentId,
    [string]$DomainId,
    [string]$ProjectId,
    [string]$AgentName,
    [string]$ResourceType = "agent",
    [string]$ResourceVersion,
    [string]$UserId,
    [string]$Endpoint,
    [string]$Token,
    [string]$AomEndpoint,
    [string]$AomAccessCode,
    [string]$AomPrometheusId,

    # install: link sub-agent traces to parent trace (default true)
    [bool]$LinkSubagentTrace = $true,

    # install: skip config.json generation/merge
    [switch]$SkipConfig,

    # uninstall: keep ~/.dsh/plugins/<插件包名>/config.json (still backed up otherwise)
    [switch]$KeepConfig,

    # uninstall: skip the confirmation prompt
    [switch]$Yes,

    [switch]$Help
)

$ErrorActionPreference = "Stop"
# PS 7.3+: native stderr would otherwise raise a terminating error under Stop
# (pnpm/dsh write progress/warnings to stderr); harmless no-op on PS 5.1.
$PSNativeCommandUseErrorActionPreference = $false

$script:PluginName = "huaweicloud-agentarts-observation-dsh-plugin"
$script:PluginId = "huaweicloud-agentarts-observation-dsh"
# tgz 产物文件名前缀（npm pack 对 scoped 包默认产出 cloud- 前缀，build_dsh.sh 重命名为无前缀形态）
$script:PluginTarballPrefix = "huaweicloud-agentarts-observation-dsh-plugin"
# 配置/数据目录用的目录名（不带 scope，scope 是 npm 分发概念不影响本地路径）
$script:PluginDirName = "huaweicloud-agentarts-observation-dsh-plugin"
$script:ProfilesHome = Join-Path $env:USERPROFILE ".dsh\profiles"
# 配置/数据目录：~/.dsh/plugins/<目录名>/（DSH 插件归属区，pnpm 不管理，重装不丢）
$script:PluginHome = Join-Path $env:USERPROFILE ".dsh\plugins\$($script:PluginDirName)"
$script:MetricsConfig = Join-Path $script:PluginHome "config.json"
# 旧版配置目录（一次性迁移源；仅 install 读取复制，运行时不再写入）
$script:LegacyMetricsConfig = Join-Path $env:USERPROFILE ".dsh-metrics\config.json"
$script:LegacyMetricsHome = Join-Path $env:USERPROFILE ".dsh-metrics"
$script:SummarySteps = [System.Collections.Generic.List[string]]::new()

# 已知 profile 的基础 bundle（创建缺失 profile 时使用；对齐 DSH 内置 profile）
$script:BaseBundles = @{
    "web"      = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")
    "headless" = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless")
    "sdk"      = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app")
    "desktop"  = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")
}

# ── 内嵌 node 脚本（原 merge-config.mjs / profile-edit.mjs 整合；ps1/sh 需同步修改） ──
# 用单引号 here-string 避免 PS 变量展开；写临时 .mjs 执行后删除（PS 5.1 兼容）。

$script:NodeProfileBundles = @'
const fs = require('fs')
const [pkgPath, pluginName] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const before = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : []
const bundles = before.filter(name => name !== pluginName)
const added = !before.includes(pluginName)
if (!bundles.includes(pluginName)) bundles.push(pluginName)
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(JSON.stringify({ mode: 'bundles', added, removed: before.length - bundles.length, bundles }))
'@

$script:NodeProfileRemove = @'
const fs = require('fs')
const [pkgPath, pluginName] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const before = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : []
const bundles = before.filter(name => name !== pluginName)
let dependenciesChanged = false
if (pkg.dependencies && pkg.dependencies[pluginName] !== undefined) {
  delete pkg.dependencies[pluginName]
  dependenciesChanged = true
}
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(JSON.stringify({ mode: 'remove-bundle', added: false, removed: before.length - bundles.length, dependenciesChanged, bundles }))
'@

$script:NodeMergeConfig = @'
const fs = require('fs')
const path = require('path')
const os = require('os')
const [configPath, updatesPath] = process.argv.slice(2)
function readNoBom(f) { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); return t }
let updates = {}
if (fs.existsSync(updatesPath)) { const t = readNoBom(updatesPath); if (t.trim()) updates = JSON.parse(t) }
function stripComments(s) { let o = '', inStr = false, i = 0
  while (i < s.length) { const c = s[i], n = s[i+1]
    if (inStr) { o += c; if (c === '\\') { o += n || ''; i += 2; continue } if (c === '"') inStr = false; i++; continue }
    if (c === '"') { inStr = true; o += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i+1] === '/')) i++; i += 2; continue }
    o += c; i++ }
  return o }
function deepMerge(d, s) { for (const k of Object.keys(s)) { const v = s[k]
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && d[k] !== null && typeof d[k] === 'object' && !Array.isArray(d[k])) deepMerge(d[k], v)
  else d[k] = v } }
function readExisting(f) { const raw = fs.readFileSync(f, 'utf8'); try { return JSON.parse(raw) } catch { return JSON.parse(stripComments(raw)) } }
fs.mkdirSync(path.dirname(configPath), { recursive: true })
const existed = fs.existsSync(configPath)
if (existed) { const backup = configPath + '.bak.' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  fs.copyFileSync(configPath, backup); console.log('backup: ' + backup) }
const config = existed ? readExisting(configPath) : {}
deepMerge(config, updates)
if (!existed) {
  const defaults = {
    version: '1.0.0', enabled: true,
    outputDir: path.join(os.homedir(), '.dsh', 'plugins', 'huaweicloud-agentarts-observation-dsh-plugin', 'data').replaceAll('\\\\', '/'),
    agent_name: '', 'user.id': '',
    features: { debug: false, captureMessageContent: true, linkSubagentTrace: true, logRetentionDays: 14 },
    otel: { agentarts_agentops_otel_agent_apm_enable: true, agentarts_agentops_otel_agent_aom_enable: true,
      agent_domain_id: '', agentarts_project_id: '', agent_resource_id: '', resource_type: 'agent', resource_version: 'default',
      agentarts_agentops_apm_token: '', agentarts_agentops_apm_exporter_endpoint: '',
      agentarts_agentops_aom_access_code: '', agentarts_agentops_aom_exporter_endpoint: '', agentarts_agentops_aom_prometheus_id: '' }
  }
  const merged = JSON.parse(JSON.stringify(defaults))
  deepMerge(merged, JSON.parse(JSON.stringify(updates)))
  Object.assign(config, merged)
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
console.log('written: ' + configPath + ' (' + (existed ? 'merged' : 'generated') + ')')
'@

# 写临时 .mjs 执行（PS 5.1 Set-Content 会写 BOM，用 .NET API 写无 BOM UTF-8）
function Invoke-NodeScript([string]$Script, [string[]]$NodeArgs) {
    $tmp = [System.IO.Path]::GetTempFileName() + ".cjs"
    [System.IO.File]::WriteAllText($tmp, $Script, [System.Text.UTF8Encoding]::new($false))
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & node $tmp @NodeArgs 2>&1
        } finally {
            $ErrorActionPreference = $prev
        }
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Write-Info($msg) { Write-Host "[dsh-observation] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[dsh-observation] WARN: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[dsh-observation] ERROR: $msg" -ForegroundColor Red }

# PS 5.1 对无 BOM 的 UTF-8 文件按系统 ANSI 代码页读取会乱码（JSON 解析失败、
# 中文路径变乱码）；统一显式 UTF-8 读（pwsh 7/5.1 通用）。
function Read-JsonFile([string]$Path) {
    [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

# 运行原生命令并取退出码：Stop 偏好下原生命令写 stderr（pnpm/dsh 警告）会触发
# NativeCommandError，把成功安装误判为失败；这里局部放宽并只在失败时打印末尾几行。
function Invoke-Native([string]$Exe, [string[]]$CmdArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $Exe @CmdArgs 2>&1
        $code = $LASTEXITCODE
        if ($code -ne 0 -and $out) { Write-Host ($out | Select-Object -Last 4) }
        return $code
    } finally {
        $ErrorActionPreference = $prev
    }
}

# ── dsh CLI 定位：PATH -> checkout（node+tsx -> pnpm dsh） ───────────────
$script:DshMode = $null
$script:DshRootResolved = $null
$script:LastDshExit = 0

function Resolve-DshCli {
    if (Get-Command dsh -ErrorAction SilentlyContinue) {
        $script:DshMode = "path"
        Write-Info "dsh CLI: PATH"
        return
    }
    $roots = @()
    if ($DshRoot) { $roots += $DshRoot }
    if ($env:DSH_ROOT) { $roots += $env:DSH_ROOT }
    $roots += "D:\AGENT\deepseek-harness"
    foreach ($root in $roots) {
        if (-not (Test-Path (Join-Path $root "apps\cli\src\bin.ts"))) { continue }
        if (Get-Command node -ErrorAction SilentlyContinue) {
            $script:DshMode = "tsx"
            $script:DshRootResolved = $root
            Write-Info "dsh CLI: checkout via node+tsx ($root)"
            return
        }
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            $script:DshMode = "pnpm"
            $script:DshRootResolved = $root
            Write-Info "dsh CLI: checkout via pnpm dsh ($root)"
            return
        }
    }
    Write-Err "dsh CLI not found: install dsh on PATH or pass -DshRoot <DSH checkout>."
    exit 1
}

# 调 dsh CLI：输出进管道；退出码存 $script:LastDshExit
function Invoke-Dsh([string[]]$DshArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        switch ($script:DshMode) {
            "path" { & dsh @DshArgs 2>&1 }
            "tsx" {
                Push-Location $script:DshRootResolved
                try { & node --import tsx/esm apps/cli/src/bin.ts @DshArgs 2>&1 }
                finally { Pop-Location }
            }
            "pnpm" {
                Push-Location $script:DshRootResolved
                try { & pnpm dsh @DshArgs 2>&1 }
                finally { Pop-Location }
            }
        }
        $script:LastDshExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 上报地址不做校验、不改写：域名 / IP / 端口 / 协议各种写法都原样写入，
# 由插件的 toGrpcUrl 统一归一化。脚本擅自补端口或协议会改变语义。
function Normalize-EndpointInput([string]$Value) {
    if (-not $Value) { return $Value }
    return $Value.Trim()
}

function Split-Profiles([string]$Value) {
    $list = @($Value.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($list.Count -eq 0) { $list = @("web") }
    return $list
}

# ── install：包源探测（-PackagePath → tgz（脚本旁/仓库 dist）→ 仓库根） ──
function Resolve-PackageSource {
    if ($PackagePath) {
        if (-not (Test-Path $PackagePath)) { Write-Err "-PackagePath not found: $PackagePath"; exit 1 }
        return ((Resolve-Path $PackagePath).Path -replace '\\', '/')
    }
    # 优先官方构建产物 tgz：脚本旁 → 仓库根 → 仓库 dist/（npm pack 输出；scoped 包产物名为 cloud- 前缀）
    $parent = Split-Path $PSScriptRoot -Parent
    $roots = @($PSScriptRoot, $parent, (Join-Path $parent "dist"))
    foreach ($root in $roots) {
        $tarballs = @(Get-ChildItem $root -Filter "$($script:PluginTarballPrefix)-*.tgz" -File -ErrorAction SilentlyContinue)
        if ($tarballs.Count -eq 1) { return ($tarballs[0].FullName -replace '\\', '/') }
        if ($tarballs.Count -gt 1) { Write-Err "multiple plugin tarballs under ${root}; pass -PackagePath to pick one."; exit 1 }
    }
    # 回退：脚本所在仓库根（开发态 link: 安装）
    $pkgJson = Join-Path $parent "package.json"
    if (Test-Path $pkgJson) {
        try {
            $name = (Read-JsonFile $pkgJson).name
            if ($name -eq $script:PluginName) { return ($parent -replace '\\', '/') }
        } catch { }
    }
    Write-Err "plugin package not found: pass -PackagePath <dir|tarball> (or run from the repository / next to a built tarball)."
    exit 1
}

# ── install：缺失 profile 的基础文件（对齐 dsh 内置 profile 结构） ────────
function Ensure-Profile([string]$Name) {
    $dir = Join-Path $script:ProfilesHome $Name
    if (Test-Path $dir) { return $dir }
    Write-Info "profile '$Name' missing; creating base files"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $bundles = $script:BaseBundles[$Name]
    if (-not $bundles) { $bundles = @("@deepseek-ai/dsh-base"); Write-Warn "  unknown profile '$Name'; using dsh-base only" }
    $pkg = [ordered]@{
        name         = "dsh-profile-$Name"
        private      = $true
        dependencies = @{}
        dsh          = @{ profile = @{ bundles = $bundles } }
    }
    $pkg | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $dir "package.json") -Encoding utf8
    Set-Content (Join-Path $dir "cordis.yml") "# dsh profile root - an empty entry list. The tree is composed as patches: `n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any`n# --patch overlays. Edit cordis.patch.yml, not this file.`n[]" -Encoding utf8
    Set-Content (Join-Path $dir "pnpm-workspace.yaml") "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n" -Encoding utf8
    Set-Content (Join-Path $dir "cordis.patch.yml") "# Your patch layer for this dsh profile, applied after every bundle layer:`n# a top-level YAML array of loader patch entries (id-targeted config`n# overrides, disables, and insert lists; !!js expressions allowed).`n" -Encoding utf8
    return $dir
}

# ── 凭据与敏感文件处理 ────────────────────────────────────────────────
# 凭据支持从环境变量读取，避免出现在命令行（会进入 shell 历史与进程列表）。
function Resolve-CredentialInputs {
    $fromParam = @()
    if (-not $script:Token -and $env:DSH_AGENTARTS_APM_TOKEN) {
        $script:Token = $env:DSH_AGENTARTS_APM_TOKEN
        Write-Info "token: from env DSH_AGENTARTS_APM_TOKEN"
    } elseif ($script:Token) { $fromParam += "-Token" }
    if (-not $script:AomAccessCode -and $env:DSH_AGENTARTS_AOM_ACCESS_CODE) {
        $script:AomAccessCode = $env:DSH_AGENTARTS_AOM_ACCESS_CODE
        Write-Info "aom access code: from env DSH_AGENTARTS_AOM_ACCESS_CODE"
    } elseif ($script:AomAccessCode) { $fromParam += "-AomAccessCode" }
    if ($fromParam.Count -gt 0) {
        Write-Warn ("credentials on the command line ({0}) are visible in shell history and process list; prefer DSH_AGENTARTS_APM_TOKEN / DSH_AGENTARTS_AOM_ACCESS_CODE" -f ($fromParam -join ', '))
    }
}

# 收紧含明文凭据的文件权限：移除继承，仅当前用户、SYSTEM、Administrators。
# 用 SID 而非组名，避免多语言系统上组名不匹配。
function Protect-SecretFile([string]$Path) {
    if (-not $Path -or -not (Test-Path $Path)) { return }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $me = "$env:USERDOMAIN\$env:USERNAME"
        $null = icacls $Path /inheritance:r /grant:r "${me}:(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -eq 0) { Write-Info "  permissions restricted: $(Split-Path $Path -Leaf)" }
    else { Write-Warn "  could not restrict permissions on $(Split-Path $Path -Leaf) (continue)" }
}

# ── 配置写入（install 与 configure 共用）───────────────────────────────
# 只生成/合并 config.json，不触碰 profile。已通过 DSH 插件界面或 dsh plugin add
# 从 Git 安装插件的用户，可单独运行 configure 子命令写入接入信息。
function Write-PluginConfig {
    # 旧版配置一次性迁移（新路径无 config.json 且旧 ~/.dsh-metrics/ 存在 → 复制，旧文件保留）
    if (-not (Test-Path $script:MetricsConfig) -and (Test-Path $script:LegacyMetricsConfig)) {
        New-Item -ItemType Directory -Path $script:PluginHome -Force | Out-Null
        Copy-Item $script:LegacyMetricsConfig $script:MetricsConfig -Force
        Write-Info "config migrated from legacy location (original kept): $script:LegacyMetricsConfig -> $script:MetricsConfig"
        $legacyData = Join-Path $script:LegacyMetricsHome "data"
        $newData = Join-Path $script:PluginHome "data"
        if ((Test-Path $legacyData) -and -not (Test-Path $newData)) {
            Copy-Item $legacyData $newData -Recurse -Force
            Write-Info "historical logs migrated from legacy location (original kept): $legacyData"
        }
        $script:SummarySteps.Add("config: migrated from legacy ~/.dsh-metrics/")
    }

    $configExists = Test-Path $script:MetricsConfig

    # DSH 版本探测（resource_version 自动取运行中 DSH 版本；探测失败兜底 "default"）
    if (-not $ResourceVersion) {
        $dshVer = ""
        if ($script:DshMode) {
            $verOut = Invoke-Dsh @("--version")
            if ($script:LastDshExit -eq 0) { $dshVer = ($verOut | Select-Object -Last 1 | Out-String).Trim() }
        } elseif (Get-Command dsh -ErrorAction SilentlyContinue) {
            $verOut = & dsh --version 2>&1
            if ($LASTEXITCODE -eq 0) { $dshVer = ($verOut | Select-Object -Last 1 | Out-String).Trim() }
        }
        if (-not $dshVer) { $dshVer = "default" }
        $ResourceVersion = $dshVer
        Write-Info "resource_version (auto-detected DSH version): $ResourceVersion"
    }

    if ($SkipConfig) {
        Write-Info "config: skipped (-SkipConfig)"
        $script:SummarySteps.Add("config: skipped")
        return
    }

    $otel = [ordered]@{}
    foreach ($pair in @(
        @{ p = "AgentId"; k = "agent_resource_id" }, @{ p = "DomainId"; k = "agent_domain_id" },
        @{ p = "ProjectId"; k = "agentarts_project_id" }, @{ p = "ResourceType"; k = "resource_type" },
        @{ p = "ResourceVersion"; k = "resource_version" }, @{ p = "Token"; k = "agentarts_agentops_apm_token" },
        @{ p = "AomAccessCode"; k = "agentarts_agentops_aom_access_code" },
        @{ p = "AomPrometheusId"; k = "agentarts_agentops_aom_prometheus_id" }
    )) {
        $value = Get-Variable $pair.p -ValueOnly
        if ($value) { $otel[$pair.k] = $value }
    }
    if ($Endpoint) { $otel["agentarts_agentops_apm_exporter_endpoint"] = Normalize-EndpointInput $Endpoint }
    if ($AomEndpoint) { $otel["agentarts_agentops_aom_exporter_endpoint"] = Normalize-EndpointInput $AomEndpoint }
    $updates = [ordered]@{}
    if ($UserId) { $updates["user.id"] = $UserId }
    if ($AgentName) { $updates["agent_name"] = $AgentName }
    if ($LinkSubagentTrace -ne $null) { $updates["features"] = [ordered]@{ linkSubagentTrace = $LinkSubagentTrace } }
    if ($otel.Count -gt 0) { $updates["otel"] = $otel }

    $updatesFile = Join-Path $env:TEMP "dsh-observation-updates-$PID.json"
    try {
        # PS 5.1 的 Set-Content -Encoding utf8 会写 BOM，node JSON.parse 会因 \uFEFF 报
        # "is not valid JSON"；用 .NET API 显式写无 BOM UTF-8（pwsh 7/5.1 通用）。
        [System.IO.File]::WriteAllText(
            $updatesFile,
            ($updates | ConvertTo-Json -Depth 10),
            (New-Object System.Text.UTF8Encoding($false)))
        $out = Invoke-NodeScript $script:NodeMergeConfig @($script:MetricsConfig, $updatesFile)
        if ($LASTEXITCODE -ne 0) { Write-Err "config generation failed: $out"; exit 1 }
        Write-Info "config: $($out -join ' ')"
        $script:SummarySteps.Add("config: $script:MetricsConfig ($($(if ($configExists) { 'merged' } else { 'generated' })))")
    } finally {
        # 该临时文件含明文凭据：任何退出路径（含失败 exit）都必须删除
        Remove-Item $updatesFile -Force -ErrorAction SilentlyContinue
    }

    # 收紧 config.json 与历史备份的权限（备份同样含明文凭据）
    Protect-SecretFile $script:MetricsConfig
    Get-ChildItem "$($script:MetricsConfig).bak.*" -ErrorAction SilentlyContinue | ForEach-Object { Protect-SecretFile $_.FullName }
}

# ── configure 子命令（只写配置，不安装、不改 profile）──────────────────
function Invoke-Configure {
    Write-Info "configure mode: writes $($script:MetricsConfig) only; the plugin must already be installed"
    Resolve-CredentialInputs
    $configExists = Test-Path $script:MetricsConfig
    $required = @("AgentId", "DomainId", "ProjectId", "Endpoint", "Token", "AomEndpoint", "AomAccessCode", "AomPrometheusId")
    if (-not $configExists) {
        $missing = @($required | Where-Object { -not (Get-Variable $_ -ValueOnly) })
        if ($missing.Count -gt 0) {
            Write-Err "missing required parameters (no existing $($script:MetricsConfig)): $($missing -join ', ')"
            exit 1
        }
    }
    $script:SummarySteps.Clear()
    Write-PluginConfig
    Write-Host ""
    Write-Info "== Configure complete =="
    foreach ($step in $script:SummarySteps) { Write-Info "  $step" }
    Write-Info "restart dsh to apply: the plugin reads config.json only at load time"
}

# ── install 子命令 ──────────────────────────────────────────────────────
function Invoke-Install {
    Resolve-DshCli
    $packageSource = Resolve-PackageSource
    Write-Info "plugin package: $packageSource"

    Resolve-CredentialInputs

    # 业务参数校验（config.json 不存在时必填）
    $configExists = Test-Path $script:MetricsConfig
    $required = @("AgentId", "DomainId", "ProjectId", "Endpoint", "Token", "AomEndpoint", "AomAccessCode", "AomPrometheusId")
    if (-not $configExists -and -not $SkipConfig) {
        $missing = @($required | Where-Object { -not (Get-Variable $_ -ValueOnly) })
        if ($missing.Count -gt 0) {
            Write-Err "missing required parameters (no existing $($script:MetricsConfig)): $($missing -join ', ')"
            exit 1
        }
    }

    foreach ($name in (Split-Profiles $Profile)) {
        Write-Info "--- profile '$name' ---"
        $profileDir = Ensure-Profile $name
        if (-not $profileDir) { $script:SummarySteps.Add("profile '$name': skipped"); continue }
        $isDesktop = $name -eq "desktop"

        # 1) 安装依赖（desktop 受 Electron 管理，跳过 dsh plugin 命令，直接 pnpm）
        #    依赖已存在时先 remove：pnpm 对已链接的包名会跳过安装（"Already up to date"）
        $depFile = Join-Path $profileDir "package.json"
        if ($isDesktop) {
            Write-Info "  desktop profile: using direct pnpm (Electron-managed)"
            # 必须在 profile 目录内执行 pnpm：否则 pnpm 会把当前目录当成项目根，
            # 新建 package.json/node_modules 并把包装到那里，profile 完全不会被更新。
            if (Test-Path $depFile) {
                $depObj = (Read-JsonFile $depFile).dependencies
                if ($depObj -and $null -ne $depObj.PSObject.Properties[$script:PluginName]) {
                    Push-Location $profileDir
                    try { $null = Invoke-Native "pnpm" @("remove", $script:PluginName) } finally { Pop-Location }
                    if ($LASTEXITCODE -eq 0) { Write-Info "  removed existing dependency first" }
                    else { Write-Warn "  pre-add remove returned $LASTEXITCODE (continue)" }
                }
            }
            Push-Location $profileDir
            try { $null = Invoke-Native "pnpm" @("add", $packageSource) } finally { Pop-Location }
            if ($LASTEXITCODE -ne 0) { Write-Err "pnpm add failed for desktop profile."; exit 1 }
        } else {
            if (Test-Path $depFile) {
                $depObj = (Read-JsonFile $depFile).dependencies
                if ($depObj -and $null -ne $depObj.PSObject.Properties[$script:PluginName]) {
                    $null = Invoke-Dsh @("plugin", "--profile", $name, "remove", $script:PluginName)
                    if ($script:LastDshExit -eq 0) { Write-Info "  removed existing dependency first (re-install)" }
                    else { Write-Warn "  pre-add remove returned $($script:LastDshExit) (continue)" }
                }
            }
            $null = Invoke-Dsh @("plugin", "--profile", $name, "add", $packageSource)
            if ($script:LastDshExit -ne 0) { Write-Err "dsh plugin add failed for profile '$name'."; exit 1 }
        }
        Write-Info "  installed dependency: $script:PluginName"
        $script:SummarySteps.Add("profile '$name': dependency installed ($script:PluginName)")

        # 2) bundle 注册：备份 -> 修改 -> 验证
        $backup = "$depFile.bak.$(Get-Date -Format yyyyMMddHHmmss)"
        Copy-Item $depFile $backup -Force
        $result = Invoke-NodeScript $script:NodeProfileBundles @($depFile, $script:PluginName)
        if ($LASTEXITCODE -ne 0) { Write-Err "bundle registration failed: $result"; exit 1 }
        $verified = Read-JsonFile $depFile
        if ($verified.dsh.profile.bundles -notcontains $script:PluginName) { Write-Err "bundle registration verify failed."; exit 1 }
        Write-Info "  registered bundle in dsh.profile.bundles (backup: $backup)"
        $script:SummarySteps.Add("profile '$name': bundle registered in dsh.profile.bundles")

        # 3) 组合验证：--dump-config 中插件条目恰好 1 条
        if ($isDesktop) {
            # desktop profile 由 Electron 独占管理，CLI 的 --dump-config 必然被拒绝，
            # 这里跳过组合检查（不是安装失败），改由 status 子命令或 App 内确认。
            Write-Info "  composition check skipped (desktop profile is Electron-managed)"
            $script:SummarySteps.Add("profile '$name': composition check skipped (Electron-managed)")
        } else {
            $dump = Invoke-Dsh @("--profile", $name, "--dump-config")
            if ($script:LastDshExit -ne 0) {
                Write-Warn "  --dump-config failed; verify manually later"
            } else {
                $entries = @($dump | Where-Object { $_ -match "^- id: $($script:PluginId)$" })
                if ($entries.Count -eq 1) { Write-Info "  composition verified: exactly 1 '$($script:PluginId)' entry" }
                else { Write-Warn "  composition check: expected 1 entry, found $($entries.Count); inspect --dump-config" }
            }
        }
    }

    # 4) config.json 生成/合并（configure 子命令复用同一函数）
    Write-PluginConfig

    Write-Host ""
    Write-Info "== Install complete =="
    foreach ($step in $script:SummarySteps) { Write-Info "  $step" }
    Write-Info "plugin: $script:PluginName (bundle id: $script:PluginId)"
    Write-Info "restart dsh when convenient (or wait for HMR) to load the new bundle."
    Write-Info "logs: ~/.dsh/plugins/<插件包名>/data/logs/plugin-YYYY-MM-DD.log"
}

# ── uninstall 子命令 ────────────────────────────────────────────────────
function Invoke-Uninstall {
    # install-only 参数提示（分组校验：uninstall 忽略业务参数）
    $ignored = @("AgentId", "DomainId", "ProjectId", "Endpoint", "Token", "AomEndpoint", "AomAccessCode", "AomPrometheusId", "ResourceType", "ResourceVersion", "UserId") |
        Where-Object { $v = Get-Variable $_ -ValueOnly; $v -and $_ -ne 'ResourceType' }
    if (@($ignored).Count -gt 0) { Write-Warn "install-only parameters ignored by uninstall: $($ignored -join ', ')" }

    Resolve-DshCli

    Write-Info "This will remove:"
    Write-Info "  1. bundle registration ($($script:PluginName)) in each profile's dsh.profile.bundles"
    Write-Info "  2. the plugin dependency in each profile"
    Write-Info "  3. $script:MetricsConfig (unless -KeepConfig; backup kept either way)"
    Write-Host ""

    if (-not $Yes) {
        $confirm = Read-Host "Proceed with uninstall? [y/N]"
        if ($confirm -ne "y" -and $confirm -ne "Y") { Write-Info "Uninstall cancelled."; exit 0 }
    }

    foreach ($name in (Split-Profiles $Profile)) {
        Write-Info "--- profile '$name' ---"
        $profileDir = Join-Path $script:ProfilesHome $name
        if (-not (Test-Path $profileDir)) { Write-Warn "profile directory missing; skipped"; continue }

        # 备份（后续 pnpm remove / bundle 注册移除都会改写 package.json）
        $pkgFile = Join-Path $profileDir "package.json"
        if (Test-Path $pkgFile) {
            $backup = "$pkgFile.bak.$(Get-Date -Format yyyyMMddHHmmss)"
            Copy-Item $pkgFile $backup -Force
            Write-Info "  package.json backup: $backup"
        }

        # 1) 依赖移除（dsh plugin remove -> pnpm remove：package.json 依赖 + node_modules 链接）
        if (Test-Path $pkgFile) {
            $deps = (Read-JsonFile $pkgFile).dependencies
            if ($deps -and $deps.PSObject.Properties[$script:PluginName]) {
                if ($name -eq "desktop") {
                    # desktop profile 由 Electron 独占管理，dsh plugin 命令会被拒绝，必须直接 pnpm
                    Push-Location $profileDir
                    try { $null = Invoke-Native "pnpm" @("remove", $script:PluginName) } finally { Pop-Location }
                    if ($LASTEXITCODE -eq 0) { Write-Info "  removed dependency: $script:PluginName" }
                    else { Write-Warn "  pnpm remove failed for desktop profile" }
                } elseif ($script:DshMode) {
                    $null = Invoke-Dsh @("plugin", "--profile", $name, "remove", $script:PluginName)
                    if ($script:LastDshExit -eq 0) { Write-Info "  removed dependency: $script:PluginName" }
                    else { Write-Warn "  dsh plugin remove returned $($script:LastDshExit)" }
                } else {
                    Write-Warn "  dependency left in place (no dsh CLI); remove manually"
                }
            }
        }

        # 2) bundle 注册移除（修改 -> 验证；依赖已由 pnpm 处理，此处兜底清理残余键）
        if (Test-Path $pkgFile) {
            $result = Invoke-NodeScript $script:NodeProfileRemove @($pkgFile, $script:PluginName)
            if ($LASTEXITCODE -ne 0) { Write-Warn "  bundle removal failed: $result" }
            else {
                $verified = Read-JsonFile $pkgFile
                if (@($verified.dsh.profile.bundles) -notcontains $script:PluginName) {
                    Write-Info "  removed bundle registration"
                } else { Write-Warn "  bundle entry still present after edit; inspect $pkgFile" }
            }
        } else { Write-Warn "  package.json missing; skipped" }
    }

    # 3) config.json 移除（默认备份后删除；-KeepConfig 跳过）
    if ($KeepConfig) {
        Write-Info "config kept (-KeepConfig): $script:MetricsConfig"
    } elseif (Test-Path $script:MetricsConfig) {
        $backup = "$($script:MetricsConfig).bak.$(Get-Date -Format yyyyMMddHHmmss)"
        Copy-Item $script:MetricsConfig $backup -Force
        Remove-Item $script:MetricsConfig -Force
        Write-Info "config removed (backup: $backup)"
    } else {
        Write-Info "no config to remove: $script:MetricsConfig"
    }

    Write-Host ""
    Write-Info "== Uninstall complete =="
    Write-Info "restart dsh when convenient; the plugin will no longer be loaded."
    Write-Info "kept: ~/.dsh/plugins/<插件包名>/data logs and every .bak backup."
}

# ── status 子命令 ──────────────────────────────────────────────────────
function Invoke-Status {
    $allRegistered = $true
    foreach ($name in (Split-Profiles $Profile)) {
        Write-Info "--- profile '$name' ---"
        $profileDir = Join-Path $script:ProfilesHome $name
        if (-not (Test-Path $profileDir)) { Write-Info "  profile directory missing"; $allRegistered = $false; continue }

        $pkgFile = Join-Path $profileDir "package.json"
        $pkg = $null
        if (Test-Path $pkgFile) { try { $pkg = Read-JsonFile $pkgFile } catch { } }
        if (-not $pkg) { Write-Info "  package.json missing/unreadable"; $allRegistered = $false; continue }

        # bundle 注册状态
        $bundles = @($pkg.dsh.profile.bundles)
        $registered = $bundles -contains $script:PluginName
        Write-Info ("  bundle registered : {0}" -f $(if ($registered) { "yes" } else { "no" }))
        if (-not $registered) { $allRegistered = $false }

        # 依赖形态（卸载后 pnpm 会整键移除空 dependencies，需 null 守卫）
        $depSpec = $null
        if ($pkg.dependencies) {
            $depMember = @($pkg.dependencies.PSObject.Properties | Where-Object { $_.Name -eq $script:PluginName })
            if ($depMember.Count -gt 0) { $depSpec = $depMember[0].Value }
        }
        if ($depSpec) { Write-Info "  dependency         : $depSpec" }
        else { Write-Info "  dependency         : (not recorded)" }

        # 已安装包版本（node_modules 副本）
        $installedJson = Join-Path $profileDir "node_modules\$($script:PluginName)\package.json"
        if (Test-Path $installedJson) {
            try {
                $inst = Read-JsonFile $installedJson
                Write-Info "  installed package  : $($inst.version) (engines.dsh $($inst.engines.dsh))"
            } catch { Write-Info "  installed package  : (unreadable)" }
        } else { Write-Info "  installed package  : (not installed in node_modules)" }

        # 配置状态（不显示敏感值）
        if (Test-Path $script:MetricsConfig) {
            try {
                $cfg = Read-JsonFile $script:MetricsConfig
                $apm = if ($cfg.otel.agentarts_agentops_otel_agent_apm_enable) { "on" } else { "off" }
                $aom = if ($cfg.otel.agentarts_agentops_otel_agent_aom_enable) { "on" } else { "off" }
                Write-Info "  config.json        : exists (APM $apm / AOM $aom)"
            } catch { Write-Info "  config.json        : exists (unreadable)" }
        } else { Write-Info "  config.json        : missing" }

        # 组合验证（需要 dsh CLI）
        if (-not $script:DshMode) { Resolve-DshCli }
        if ($script:DshMode) {
            $dump = Invoke-Dsh @("--profile", $name, "--dump-config")
            if ($script:LastDshExit -eq 0) {
                $entries = @($dump | Where-Object { $_ -match "^- id: $($script:PluginId)$" })
                Write-Info "  composition        : $($entries.Count) '$($script:PluginId)' entry(ies) (expect 1)"
                if ($entries.Count -ne 1) { $allRegistered = $false }
            } else {
                Write-Warn "  composition        : --dump-config failed"
                $allRegistered = $false
            }
        } else {
            Write-Warn "  composition        : not checked (dsh CLI not found)"
        }
    }
    if ($allRegistered) { Write-Info "status: registered"; exit 0 } else { Write-Info "status: not fully registered"; exit 1 }
}

function Show-Help {
    @'
DSH AgentArts Observation Plugin - single entry installer/uninstaller.

Usage:
  .\dsh-agentarts-plugin.ps1 -AgentId <id> -DomainId <id> -ProjectId <id> `
      -Endpoint https://apm-access.<region>.myhuaweicloud.com -Token <token> `
      -AomEndpoint https://aom-access.<region>.myhuaweicloud.com -AomAccessCode <code> -AomPrometheusId <id> [options]
      # no subcommand = install

  .\dsh-agentarts-plugin.ps1 install   [same parameters]      # explicit
  .\dsh-agentarts-plugin.ps1 configure [same parameters]      # 只写配置，不安装
  .\dsh-agentarts-plugin.ps1 status    [-Profile "web,headless"]
  .\dsh-agentarts-plugin.ps1 uninstall [-Yes] [-KeepConfig] [-Profile "web,headless"]
  .\dsh-agentarts-plugin.ps1 help

install - required when ~/.dsh/plugins/<插件包名>/config.json does not exist (merge mode
          keeps unrelated fields when it does):
  -AgentId <id>                 AgentArts agent resource ID
  -DomainId <id>                AgentArts tenant/domain ID
  -ProjectId <id>               AgentArts project ID
  -Endpoint <addr>              APM OTLP gRPC endpoint. Any form accepted:
                                https://apm-access.<region>.myhuaweicloud.com
                                apm-access.<region>.myhuaweicloud.com:443
                                10.x.x.x:4317 (in-cluster plaintext gRPC)
  -Token <token>                APM authentication token
  -AomEndpoint <addr>           AOM OTLP gRPC endpoint; same forms as -Endpoint
  -AomAccessCode <code>         AOM access code
  -AomPrometheusId <id>         AOM prometheus instance ID

install - optional:
  -AgentName <name>              Agent name (span name / gen_ai.agent.name; default dsh_agent)
  -ResourceType (default agent; agent|multiagents|workflow),
  -ResourceVersion (default: auto-detect DSH version),
  -UserId, -Profile "web,headless" (default web), -PackagePath <dir|tarball>,
  -DshRoot <DSH checkout>, -SkipConfig

uninstall:
  -Yes          Skip the confirmation prompt
  -KeepConfig   Keep ~/.dsh/plugins/<插件包名>/config.json (backed up otherwise)
  -Profile, -DshRoot as above

status:
  Shows bundle registration, dependency spec, installed package version,
  config presence, and composition entry count per profile.
  Exit code 0 when every profile has the bundle registered.

Notes:
  - dsh CLI lookup: PATH -> -DshRoot -> D:\AGENT\deepseek-harness (node+tsx,
    falling back to `pnpm dsh` when node cannot run the checkout CLI).
  - Bundle registration: the plugin's own cordis.patch.yml is composed once
    the package name is listed in the profile's dsh.profile.bundles.
  - config.json is backed up before merge; rewrites drop // comments (keep
    config.example.json as the annotated template).
'@ | Write-Host
}

# ── 子命令分发 ─────────────────────────────────────────────────────────
switch ($Command) {
    'install'   { if ($Help) { Show-Help; exit 0 }; Invoke-Install }
    'configure' { if ($Help) { Show-Help; exit 0 }; Invoke-Configure }
    'uninstall' { if ($Help) { Show-Help; exit 0 }; Invoke-Uninstall }
    'status'    { if ($Help) { Show-Help; exit 0 }; Invoke-Status }
    'help'      { Show-Help; exit 0 }
    default     { Write-Err "unknown subcommand: $Command (expected install | uninstall | status | help)"; Show-Help; exit 1 }
}

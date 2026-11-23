<#
.SYNOPSIS
  DSH AgentArts Observation Plugin - configuration script (Windows).

.DESCRIPTION
  Writes / merges the plugin's runtime configuration at
    ~/.dsh/plugins/agentarts-instrumentation-dsh/config.json
  and hardens its file permissions.

  It does NOT install the plugin and never touches a DSH profile.
  Install the plugin first via the DSH plugin market, or in a web profile with:
    dsh plugin --profile web add agentarts-instrumentation-dsh

  Subcommands (first positional argument; default: configure):
    configure  Write or merge the reporting configuration (backup -> merge).
    status     Show the current configuration summary (no secrets printed).
    help       Show this help.

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 -AgentId <id> -DomainId <id> -ProjectId <id> `
    -Endpoint https://apm-access.<region>.myhuaweicloud.com -Token <token> `
    -AomEndpoint https://aom-access.<region>.myhuaweicloud.com `
    -AomAccessCode <code> -AomPrometheusId <id> -AgentName <name>

.EXAMPLE
  .\dsh-agentarts-plugin.ps1 status

.EXAMPLE
  # 凭据通过环境变量提供，避免进入 shell 历史
  $env:DSH_AGENTARTS_APM_TOKEN = "<token>"
  $env:DSH_AGENTARTS_AOM_ACCESS_CODE = "<code>"
  .\dsh-agentarts-plugin.ps1 -AgentId <id> -ProjectId <id> -Endpoint <url> -AomEndpoint <url> -AomPrometheusId <id>
#>
param(
    # Subcommand (first positional argument; default: configure)
    [string]$Command = 'configure',

    # AgentArts 业务参数（写入 config.json）
    [string]$AgentId,
    [string]$DomainId,
    [string]$ProjectId,
    [string]$AgentName,
    # 资源类型：agent（默认）/ deepseekharness / multiagents / workflow
    [string]$ResourceType,
    [string]$UserId,
    [string]$Endpoint,
    [string]$Token,
    [string]$AomEndpoint,
    [string]$AomAccessCode,
    [string]$AomPrometheusId,

    # 子 agent trace 是否串联到父 trace：true / false（不传则保持现状）
    [string]$LinkSubagentTrace,
    # 是否上报输入输出等会话内容：true / false（不传则保持现状）
    [string]$CaptureMessageContent,
    # 等价于 -CaptureMessageContent false
    [switch]$NoMessageContent,

    [switch]$Help
)

$ErrorActionPreference = "Stop"
# PS 7.3+: native stderr would otherwise raise a terminating error under Stop
# (node writes progress/warnings to stderr); harmless no-op on PS 5.1.
$PSNativeCommandUseErrorActionPreference = $false

$script:PluginName = "agentarts-instrumentation-dsh"
# 配置/数据目录用的目录名（不带 scope，与包名一致）
$script:PluginDirName = "agentarts-instrumentation-dsh"
# 配置/数据目录：~/.dsh/plugins/<目录名>/（DSH 插件归属区，pnpm 不管理，重装不丢）
$script:PluginHome = Join-Path $env:USERPROFILE ".dsh\plugins\$($script:PluginDirName)"
$script:MetricsConfig = Join-Path $script:PluginHome "config.json"
# config.json 的历史备份保留份数（备份含明文凭据，无限累积会扩大暴露面）
$script:MaxConfigBackups = 5
$script:SummarySteps = [System.Collections.Generic.List[string]]::new()

# ── 内嵌 node 脚本：配置合并（ps1/sh 需同步修改） ──────────────────────
# 用单引号 here-string 避免 PS 变量展开；写临时 .mjs 执行后删除（PS 5.1 兼容）。
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
    enabled: true,
    outputDir: path.join(os.homedir(), '.dsh', 'plugins', 'agentarts-instrumentation-dsh', 'data').replaceAll('\\\\', '/'),
    agent_name: '', 'user.id': '',
    features: { debug: false, captureMessageContent: true, linkSubagentTrace: true, logRetentionDays: 14 },
    otel: { agentarts_agentops_otel_agent_apm_enable: true, agentarts_agentops_otel_agent_aom_enable: false,
      agent_domain_id: '', agentarts_project_id: '', agent_resource_id: '',
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

function Write-Info($msg) { Write-Host "[agentarts-config] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[agentarts-config] WARN: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[agentarts-config] ERROR: $msg" -ForegroundColor Red }

# PS 5.1 对无 BOM 的 UTF-8 文件按系统 ANSI 代码页读取会乱码；统一显式 UTF-8 读。
function Read-JsonFile([string]$Path) {
    [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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

# 解析可选的布尔参数：接受 true/false/1/0（大小写不限）；空值表示不修改，返回 $null。
function ConvertTo-OptionalBool([string]$Value, [string]$Name) {
    if (-not $Value) { return $null }
    switch ($Value.Trim().ToLowerInvariant()) {
        "true"  { return $true }
        "false" { return $false }
        "1"     { return $true }
        "0"     { return $false }
        default {
            Write-Err "$Name must be true or false (got '$Value')"
            exit 1
        }
    }
}

# ── 配置写入 ──────────────────────────────────────────────────────────
function Write-PluginConfig {
    # 清理超出保留份数的旧备份（备份同样含明文凭据），再收紧剩余文件权限
    $backups = @(Get-ChildItem "$($script:MetricsConfig).bak.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    $configExists = Test-Path $script:MetricsConfig


    $otel = [ordered]@{}
    foreach ($pair in @(
        @{ p = "AgentId"; k = "agent_resource_id" }, @{ p = "DomainId"; k = "agent_domain_id" },
        @{ p = "ProjectId"; k = "agentarts_project_id" }, @{ p = "ResourceType"; k = "resource_type" },
        @{ p = "Token"; k = "agentarts_agentops_apm_token" },
        @{ p = "AomAccessCode"; k = "agentarts_agentops_aom_access_code" },
        @{ p = "AomPrometheusId"; k = "agentarts_agentops_aom_prometheus_id" }
    )) {
        $value = Get-Variable $pair.p -ValueOnly
        if ($value) { $otel[$pair.k] = $value }
    }
    if ($Endpoint) { $otel["agentarts_agentops_apm_exporter_endpoint"] = $Endpoint.Trim() }
    if ($AomEndpoint) { $otel["agentarts_agentops_aom_exporter_endpoint"] = $AomEndpoint.Trim() }
    $updates = [ordered]@{}
    if ($UserId) { $updates["user.id"] = $UserId }
    if ($AgentName) { $updates["agent_name"] = $AgentName }
    $features = [ordered]@{}
    $linkValue = ConvertTo-OptionalBool $LinkSubagentTrace "-LinkSubagentTrace"
    $captureValue = ConvertTo-OptionalBool $CaptureMessageContent "-CaptureMessageContent"
    if ($NoMessageContent) { $captureValue = $false }
    if ($null -ne $linkValue) { $features["linkSubagentTrace"] = $linkValue }
    if ($null -ne $captureValue) { $features["captureMessageContent"] = $captureValue }
    if ($features.Count -gt 0) { $updates["features"] = $features }
    if ($otel.Count -gt 0) { $updates["otel"] = $otel }

    $updatesFile = Join-Path $env:TEMP "agentarts-config-updates-$PID.json"
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

    if ($backups.Count -gt $script:MaxConfigBackups) {
        $backups | Select-Object -Skip $script:MaxConfigBackups | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Info "  removed old backup: $($_.Name)"
        }
        $backups = @(Get-ChildItem "$($script:MetricsConfig).bak.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    }
    Protect-SecretFile $script:MetricsConfig
    foreach ($bak in $backups) { Protect-SecretFile $bak.FullName }
}

# ── configure 子命令 ──────────────────────────────────────────────────
function Invoke-Configure {
    Write-Info "configuration script for $($script:PluginName)"
    Write-Info "target: $($script:MetricsConfig)"
    Resolve-CredentialInputs

    $configExists = Test-Path $script:MetricsConfig
    $required = @("AgentId", "Endpoint", "Token")
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
    Write-Info "restart DSH to apply: otel settings are bound when the plugin loads"
}

# ── status 子命令 ─────────────────────────────────────────────────────
function Invoke-Status {
    Write-Host "config file : $($script:MetricsConfig)"
    if (-not (Test-Path $script:MetricsConfig)) {
        Write-Warn "missing: run this script with your AgentArts parameters to create it"
        exit 1
    }
    try {
        $cfg = Read-JsonFile $script:MetricsConfig
    } catch {
        Write-Err "unreadable (JSONC with comments is fine for the plugin, but this script could not parse it)"
        exit 1
    }
    $otel = $cfg.otel
    Write-Host ("enabled      : {0}" -f $(if ($cfg.enabled -eq $false) { "false" } else { "true" }))
    Write-Host ("agent_name   : {0}" -f $(if ($cfg.agent_name) { $cfg.agent_name } else { "(not set)" }))
    if ($otel) {
        Write-Host ("APM (traces) : {0}  endpoint={1}" -f $(if ($otel.agentarts_agentops_otel_agent_apm_enable -eq $true) { "on" } else { "off" }), $(if ($otel.agentarts_agentops_apm_exporter_endpoint) { $otel.agentarts_agentops_apm_exporter_endpoint } else { "(not set)" }))
        Write-Host ("token        : {0}" -f $(if ($otel.agentarts_agentops_apm_token) { "(set, " + $otel.agentarts_agentops_apm_token.Length + " chars)" } else { "(not set)" }))
        # 指标上报默认关闭：仅在开启时展示相关行，避免与默认配置产生歧义
        if ($otel.agentarts_agentops_otel_agent_aom_enable -eq $true) {
            Write-Host ("AOM (metrics): on  endpoint={0}" -f $(if ($otel.agentarts_agentops_aom_exporter_endpoint) { $otel.agentarts_agentops_aom_exporter_endpoint } else { "(not set)" }))
            Write-Host ("access code  : {0}" -f $(if ($otel.agentarts_agentops_aom_access_code) { "(set, " + $otel.agentarts_agentops_aom_access_code.Length + " chars)" } else { "(not set)" }))
        }
    } else {
        Write-Warn "otel section missing: nothing will be reported"
    }
    $features = $cfg.features
    if ($features) {
        Write-Host ("content      : {0}  subagent-link: {1}" -f $(if ($features.captureMessageContent -eq $false) { "off" } else { "on" }), $(if ($features.linkSubagentTrace -eq $false) { "off" } else { "on" }))
    }
    Write-Host ""
    Write-Info "logs: $($script:PluginHome)\data\logs\plugin-YYYY-MM-DD.log"
}

function Show-Help {
    @'
DSH AgentArts Observation Plugin - configuration script.

This script only writes the plugin configuration:
  ~/.dsh/plugins/agentarts-instrumentation-dsh/config.json
It does not install the plugin and does not modify any DSH profile.

Install the plugin first:
  desktop : DSH 客户端 -> Plugins -> Discover / Add plugin
  web     : dsh plugin --profile web add agentarts-instrumentation-dsh

Usage:
  .\dsh-agentarts-plugin.ps1 -AgentId <id> -ProjectId <id> `
      -Endpoint https://apm-access.<region>.myhuaweicloud.com -Token <token> `
      -AomEndpoint https://aom-access.<region>.myhuaweicloud.com `
      -AomAccessCode <code> -AomPrometheusId <id> [options]
      # no subcommand = configure

  .\dsh-agentarts-plugin.ps1 configure [same parameters]
  .\dsh-agentarts-plugin.ps1 status
  .\dsh-agentarts-plugin.ps1 help

Required when config.json does not exist (merge mode keeps existing fields):
  -AgentId <id>          AgentArts agent resource ID
  -Endpoint <addr>       APM OTLP gRPC endpoint
  -Token <token>         APM authentication token

Optional:
  -DomainId <id>         AgentArts tenant/domain ID
  -ProjectId <id>        Huawei Cloud project ID (written as gen_ai.project.id)
  -AomEndpoint <addr>    AOM OTLP gRPC endpoint (required for AOM)
  -AomAccessCode <code>  AOM access code (required for AOM)
  -AomPrometheusId <id>  AOM Prometheus instance ID (required for AOM)
  -AgentName <name>      Agent name (gen_ai.agent.name)
  -ResourceType <type>   Resource type: agent (default) | deepseekharness |
                         multiagents | workflow
  -UserId <id>                    User identifier (user.id; hostname when empty)
  -LinkSubagentTrace <true|false>       Link subagent traces to the parent trace
  -CaptureMessageContent <true|false>   Report conversation content: messages, system
                                        instructions, tool arguments and results
  -NoMessageContent                     Shorthand for -CaptureMessageContent false

Leaving -LinkSubagentTrace / -CaptureMessageContent out keeps the current value.

Credential inputs:
  Prefer the environment variables DSH_AGENTARTS_APM_TOKEN and
  DSH_AGENTARTS_AOM_ACCESS_CODE over command-line arguments.

Notes:
  - Endpoint accepts any of: https://host, host:443, 10.x.x.x:4317
  - After writing the configuration, restart DSH (otel settings load at startup).
  - config.json is backed up before merge; only the latest 5 backups are kept.
'@ | Write-Host
}

# ── 子命令分发 ─────────────────────────────────────────────────────────
switch ($Command) {
    'configure' { if ($Help) { Show-Help; exit 0 }; Invoke-Configure }
    'status'    { if ($Help) { Show-Help; exit 0 }; Invoke-Status }
    'help'      { Show-Help; exit 0 }
        default     {
        Write-Err "unknown subcommand: $Command (expected configure | status | help)"
        Write-Warn "if a parameter value contains spaces, wrap it in quotes, e.g. -AgentName ""my agent name"""
        Show-Help
        exit 1
    }
}

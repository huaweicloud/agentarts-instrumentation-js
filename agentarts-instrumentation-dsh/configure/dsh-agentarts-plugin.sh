#!/usr/bin/env bash
#
# DSH AgentArts Observation Plugin - configuration script (Linux / macOS / WSL).
#
# Writes / merges the plugin configuration at
#   ~/.dsh/plugins/agentarts-instrumentation-dsh/config.json
# and hardens its file permissions.
#
# It does NOT install the plugin and never touches a DSH profile.
# Install the plugin first:
#   desktop : DSH 客户端 -> Plugins -> Discover / Add plugin
#   web     : dsh plugin --profile web add agentarts-instrumentation-dsh
#
# Subcommands (first positional argument; default: configure):
#   configure  Write or merge the reporting configuration (backup -> merge).
#   status     Show the current configuration summary (no secrets printed).
#   help       Show this help.
#
# Usage:
#   ./dsh-agentarts-plugin.sh --agent-id <id> --project-id <id> \
#     --endpoint https://apm-access.<region>.myhuaweicloud.com --token <token> \
#     --aom-endpoint https://aom-access.<region>.myhuaweicloud.com \
#     --aom-access-code <code> --aom-prometheus-id <id> [--agent-name <name>]
#     # no subcommand = configure
#   ./dsh-agentarts-plugin.sh status
#   ./dsh-agentarts-plugin.sh help

set -euo pipefail

PLUGIN_NAME="agentarts-instrumentation-dsh"
# 配置/数据目录用的目录名（不带 scope，与包名一致）
PLUGIN_DIR_NAME="agentarts-instrumentation-dsh"
# 配置/数据目录：~/.dsh/plugins/<目录名>/（DSH 插件归属区，pnpm 不管理，重装不丢）
PLUGIN_HOME="$HOME/.dsh/plugins/$PLUGIN_DIR_NAME"
CONFIG_PATH="$PLUGIN_HOME/config.json"
# config.json 的历史备份保留份数（备份含明文凭据，无限累积会扩大暴露面）
MAX_CONFIG_BACKUPS=5

# ── 子命令解析（首个非 - 开头参数；缺省 configure） ──────────────────────
SUBCOMMAND="configure"
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
    SUBCOMMAND="$1"
    shift
fi

AGENT_ID=""
AGENT_NAME=""
# 资源类型：agent（默认）/ deepseekharness / multiagents / workflow
RESOURCE_TYPE=""
DOMAIN_ID=""
PROJECT_ID=""
USER_ID=""
ENDPOINT=""
TOKEN=""
AOM_ENDPOINT=""
AOM_ACCESS_CODE=""
AOM_PROMETHEUS_ID=""
# 空字符串 = 不修改配置中的现有值
LINK_SUBAGENT_TRACE=""
CAPTURE_MESSAGE_CONTENT=""

info() { echo "[agentarts-config] $*"; }
warn() { echo "[agentarts-config] WARN: $*"; }
err()  { echo "[agentarts-config] ERROR: $*" >&2; }

usage() {
cat <<'EOF'
DSH AgentArts Observation Plugin - configuration script.

This script only writes the plugin configuration:
  ~/.dsh/plugins/agentarts-instrumentation-dsh/config.json
It does not install the plugin and does not modify any DSH profile.

Install the plugin first:
  desktop : DSH 客户端 -> Plugins -> Discover / Add plugin
  web     : dsh plugin --profile web add agentarts-instrumentation-dsh

Usage:
  ./dsh-agentarts-plugin.sh --agent-id <id> --project-id <id> \
      --endpoint https://apm-access.<region>.myhuaweicloud.com --token <token> \
      --aom-endpoint https://aom-access.<region>.myhuaweicloud.com \
      --aom-access-code <code> --aom-prometheus-id <id> [options]
      # no subcommand = configure

  ./dsh-agentarts-plugin.sh configure [same options]
  ./dsh-agentarts-plugin.sh status
  ./dsh-agentarts-plugin.sh help

Required when config.json does not exist (merge mode keeps existing fields):
  --agent-id <id>            AgentArts agent resource ID
  --endpoint <addr>          APM OTLP gRPC endpoint
  --token <token>            APM authentication token

Optional:
  --domain-id <id>           AgentArts tenant/domain ID
  --project-id <id>          Huawei Cloud project ID (written as gen_ai.project.id)
  --aom-endpoint <addr>      AOM OTLP gRPC endpoint (required for AOM)
  --aom-access-code <code>   AOM access code (required for AOM)
  --aom-prometheus-id <id>   AOM Prometheus instance ID (required for AOM)
  --agent-name <name>        Agent name (gen_ai.agent.name)
  --resource-type <type>     agent (default) | deepseekharness | multiagents | workflow
  --user-id <id>
  --link-subagent-trace <true|false>      Link subagent traces to the parent trace
  --capture-message-content <true|false>  Report conversation content (messages,
                                          system instructions, tool arguments/results)
  --no-message-content                    Shorthand for --capture-message-content false

Credential inputs:
  Prefer the environment variables DSH_AGENTARTS_APM_TOKEN and
  DSH_AGENTARTS_AOM_ACCESS_CODE over command-line arguments.

Notes:
  - Endpoint accepts any of: https://host, host:443, 10.x.x.x:4317
  - After writing the configuration, restart DSH (otel settings load at startup).
  - config.json is backed up before merge; only the latest 5 backups are kept.
EOF
}

# ── 参数解析 ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --agent-id)            AGENT_ID="${2:-}"; shift 2 ;;
        --agent-name)          AGENT_NAME="${2:-}"; shift 2 ;;
        --resource-type)       RESOURCE_TYPE="${2:-}"; shift 2 ;;
        --domain-id)           DOMAIN_ID="${2:-}"; shift 2 ;;
        --project-id)          PROJECT_ID="${2:-}"; shift 2 ;;

        --user-id)             USER_ID="${2:-}"; shift 2 ;;
        --endpoint)            ENDPOINT="${2:-}"; shift 2 ;;
        --token)               TOKEN="${2:-}"; shift 2 ;;
        --aom-endpoint)        AOM_ENDPOINT="${2:-}"; shift 2 ;;
        --aom-access-code)     AOM_ACCESS_CODE="${2:-}"; shift 2 ;;
        --aom-prometheus-id)   AOM_PROMETHEUS_ID="${2:-}"; shift 2 ;;
        --link-subagent-trace) LINK_SUBAGENT_TRACE="${2:-}"; shift 2 ;;
        --capture-message-content) CAPTURE_MESSAGE_CONTENT="${2:-}"; shift 2 ;;
        --no-message-content)  CAPTURE_MESSAGE_CONTENT="false"; shift ;;
        -h|--help)             usage; exit 0 ;;
        *)
            err "unknown option: $1"
            err "if a parameter value contains spaces, wrap it in quotes, e.g. --agent-name \"my agent name\""
            usage >&2
            exit 1
            ;;
    esac
done

# 布尔开关只接受 true / false（空 = 不修改）
case "$LINK_SUBAGENT_TRACE" in
    ""|true|false) ;;
    *) err "--link-subagent-trace must be true or false (got '$LINK_SUBAGENT_TRACE')"; exit 1 ;;
esac
case "$CAPTURE_MESSAGE_CONTENT" in
    ""|true|false) ;;
    *) err "--capture-message-content must be true or false (got '$CAPTURE_MESSAGE_CONTENT')"; exit 1 ;;
esac

# 凭据支持从环境变量读取，避免出现在命令行（会进入 shell 历史与进程列表）
if [ -z "$TOKEN" ] && [ -n "${DSH_AGENTARTS_APM_TOKEN:-}" ]; then
    TOKEN="$DSH_AGENTARTS_APM_TOKEN"; info "token: from env DSH_AGENTARTS_APM_TOKEN"
fi
if [ -z "$AOM_ACCESS_CODE" ] && [ -n "${DSH_AGENTARTS_AOM_ACCESS_CODE:-}" ]; then
    AOM_ACCESS_CODE="$DSH_AGENTARTS_AOM_ACCESS_CODE"; info "aom access code: from env DSH_AGENTARTS_AOM_ACCESS_CODE"
fi
if [ -n "$TOKEN" ] && [ -z "${DSH_AGENTARTS_APM_TOKEN:-}" ]; then
    warn "credentials on the command line are visible in shell history and process list; prefer DSH_AGENTARTS_APM_TOKEN / DSH_AGENTARTS_AOM_ACCESS_CODE"
fi

# ── 配置写入 ──────────────────────────────────────────────────────────
cmd_configure() {
    info "configuration script for $PLUGIN_NAME"
    info "target: $CONFIG_PATH"

    CONFIG_EXISTS=0
    [ -f "$CONFIG_PATH" ] && CONFIG_EXISTS=1
    if [ "$CONFIG_EXISTS" -eq 0 ]; then
        missing=()
        [ -n "$AGENT_ID" ] || missing+=(--agent-id)
        [ -n "$ENDPOINT" ] || missing+=(--endpoint)
        [ -n "$TOKEN" ] || missing+=(--token)
        if [ "${#missing[@]}" -gt 0 ]; then
            err "missing required parameters (no existing $CONFIG_PATH): ${missing[*]}"
            exit 1
        fi
    fi


    # 清理超出保留份数的旧备份（备份同样含明文凭据）
    _old_baks="$(ls -1t "$CONFIG_PATH".bak.* 2>/dev/null | tail -n +$((MAX_CONFIG_BACKUPS + 1)) || true)"
    if [ -n "$_old_baks" ]; then
        printf '%s\n' "$_old_baks" | while IFS= read -r _old; do
            [ -f "$_old" ] || continue
            rm -f "$_old" && info "  removed old backup: $(basename "$_old")"
        done
    fi

    updates_file="$(mktemp)"
    # 该临时文件含明文凭据：即使后续失败退出也要删除
    trap 'rm -f "$updates_file"' EXIT
    AGENT_ID="$AGENT_ID" AGENT_NAME="$AGENT_NAME" RESOURCE_TYPE="$RESOURCE_TYPE" LINK_SUBAGENT_TRACE="$LINK_SUBAGENT_TRACE" CAPTURE_MESSAGE_CONTENT="$CAPTURE_MESSAGE_CONTENT" DOMAIN_ID="$DOMAIN_ID" PROJECT_ID="$PROJECT_ID" \
    TOKEN="$TOKEN" ENDPOINT="$ENDPOINT" AOM_ACCESS_CODE="$AOM_ACCESS_CODE" \
    AOM_ENDPOINT="$AOM_ENDPOINT" AOM_PROMETHEUS_ID="$AOM_PROMETHEUS_ID" \
    USER_ID="$USER_ID" node --input-type=commonjs - "$updates_file" <<'EOF'
const fs = require('fs')
const v = {
    agent_resource_id: process.env.AGENT_ID,
    agent_domain_id: process.env.DOMAIN_ID,
    agentarts_project_id: process.env.PROJECT_ID,
    resource_type: process.env.RESOURCE_TYPE,
    agentarts_agentops_apm_token: process.env.TOKEN,
    agentarts_agentops_apm_exporter_endpoint: process.env.ENDPOINT,
    agentarts_agentops_aom_access_code: process.env.AOM_ACCESS_CODE,
    agentarts_agentops_aom_exporter_endpoint: process.env.AOM_ENDPOINT,
    agentarts_agentops_aom_prometheus_id: process.env.AOM_PROMETHEUS_ID,
}
const otel = {}
for (const [k, val] of Object.entries(v)) if (val) otel[k] = val
const updates = {}
if (process.env.USER_ID) updates['user.id'] = process.env.USER_ID
if (process.env.AGENT_NAME) updates['agent_name'] = process.env.AGENT_NAME
const features = {}
if (process.env.LINK_SUBAGENT_TRACE) features.linkSubagentTrace = process.env.LINK_SUBAGENT_TRACE === 'true'
if (process.env.CAPTURE_MESSAGE_CONTENT) features.captureMessageContent = process.env.CAPTURE_MESSAGE_CONTENT === 'true'
if (Object.keys(features).length) updates.features = features
if (Object.keys(otel).length) updates.otel = otel
// 脚本经 stdin（node - 参数）执行时 argv[1] 是 "-"，真实参数从 argv[2] 开始
fs.writeFileSync(process.argv[2], JSON.stringify(updates))
EOF
    # merge-config（内嵌 node 脚本；与 ps1 同步维护）
    out="$(node --input-type=commonjs - "$CONFIG_PATH" "$updates_file" 2>&1 <<'NODE_MERGE'
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
NODE_MERGE
)" || { err "config generation failed: $out"; exit 1; }
    rm -f "$updates_file"
    trap - EXIT
    info "config: $out"

    # 收紧含明文凭据的文件权限（含历史备份）；Windows/MSYS 下 chmod 可能无效，忽略失败
    chmod 700 "$PLUGIN_HOME" 2>/dev/null || true
    chmod 600 "$CONFIG_PATH" 2>/dev/null || true
    for _bak in "$CONFIG_PATH".bak.*; do [ -f "$_bak" ] && chmod 600 "$_bak" 2>/dev/null; done

    echo ""
    info "== Configure complete =="
    info "restart DSH to apply: otel settings are bound when the plugin loads"
}

# ── status 子命令 ─────────────────────────────────────────────────────
cmd_status() {
    echo "config file : $CONFIG_PATH"
    if [ ! -f "$CONFIG_PATH" ]; then
        warn "missing: run this script with your AgentArts parameters to create it"
        exit 1
    fi
    node --input-type=commonjs - "$CONFIG_PATH" "$PLUGIN_HOME" <<'NODE_STATUS'
const fs = require('fs')
const [configPath, pluginHome] = process.argv.slice(2)
function stripComments(s) { let o = '', inStr = false, i = 0
  while (i < s.length) { const c = s[i], n = s[i+1]
    if (inStr) { o += c; if (c === '\\') { o += n || ''; i += 2; continue } if (c === '"') inStr = false; i++; continue }
    if (c === '"') { inStr = true; o += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i+1] === '/')) i++; i += 2; continue }
    o += c; i++ }
  return o }
const raw = fs.readFileSync(configPath, 'utf8')
let cfg
try { cfg = JSON.parse(raw) } catch { cfg = JSON.parse(stripComments(raw)) }
// 上报开关：只有显式 true 才算开启（与插件 initOtel 的 === true 一致）
const onIfTrue = (v) => (v === true ? 'on' : 'off')
// 功能开关：默认开启，只有显式 false 才算关闭
const offIfFalse = (v) => (v === false ? 'off' : 'on')
const dash = (v) => (v ? v : '(not set)')
console.log('enabled      : ' + (cfg.enabled === false ? 'false' : 'true'))
console.log('agent_name   : ' + dash(cfg.agent_name))
const otel = cfg.otel
if (otel) {
  console.log('APM (traces) : ' + onIfTrue(otel.agentarts_agentops_otel_agent_apm_enable) + '  endpoint=' + dash(otel.agentarts_agentops_apm_exporter_endpoint))
  console.log('token        : ' + (otel.agentarts_agentops_apm_token ? '(set, ' + String(otel.agentarts_agentops_apm_token).length + ' chars)' : '(not set)'))
  // 指标上报默认关闭：仅在开启时展示相关行，避免与默认配置产生歧义
  if (otel.agentarts_agentops_otel_agent_aom_enable === true) {
    console.log('AOM (metrics): on  endpoint=' + dash(otel.agentarts_agentops_aom_exporter_endpoint))
    console.log('access code  : ' + (otel.agentarts_agentops_aom_access_code ? '(set, ' + String(otel.agentarts_agentops_aom_access_code).length + ' chars)' : '(not set)'))
  }
} else {
  console.log('WARN: otel section missing, nothing will be reported')
}
const f = cfg.features
if (f) console.log('content      : ' + offIfFalse(f.captureMessageContent) + '  subagent-link: ' + offIfFalse(f.linkSubagentTrace))
console.log('')
console.log('[agentarts-config] logs: ' + pluginHome + '/data/logs/plugin-YYYY-MM-DD.log')
NODE_STATUS
}

# ── 子命令分发 ─────────────────────────────────────────────────────────
case "$SUBCOMMAND" in
    configure) cmd_configure ;;
    status)    cmd_status ;;
    help)      usage; exit 0 ;;
    *)
         err "unknown subcommand: $SUBCOMMAND (expected configure | status | help)"
         err "if a parameter value contains spaces, wrap it in quotes, e.g. --agent-name \"my agent name\""
         usage >&2
         exit 1
         ;;
esac

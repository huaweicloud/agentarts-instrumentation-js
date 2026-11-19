#!/usr/bin/env bash
#
# DSH AgentArts Observation Plugin - single entry installer/uninstaller
# (Linux / macOS / WSL).
#
# Subcommands (first positional argument; default: install):
#   install    Install / re-install the plugin into profile(s):
#                1. locates the dsh CLI (PATH -> DSH checkout via node+tsx / pnpm)
#                2. installs the plugin package (dsh plugin --profile add;
#                   tarball source auto-detected: script dir -> repo root ->
#                   repo dist/)
#                3. registers the bundle in the profile's dsh.profile.bundles
#                   (backup -> modify -> verify; official bundle registration)
#                4. generates/merges ~/.dsh/plugins/<插件包名>/config.json (backup ->
#                   merge; unrelated fields are kept)
#                5. verifies the composition via --dump-config (exactly 1
#                   entry) and prints an install summary
#              Idempotent: safe to re-run. Install-only options are ignored
#              by the other subcommands.
#   configure  Write/merge ~/.dsh/plugins/<插件包名>/config.json only, without
#              touching any profile. Use it when the plugin was installed some
#              other way (Plugins UI, or dsh plugin add from a Git repository),
#              so installation and configuration stay decoupled.
#   uninstall  Remove the plugin (per profile): bundle registration (backup ->
#              modify -> verify), plugin dependency (dsh plugin --profile
#              remove), and ~/.dsh/plugins/<插件包名>/config.json (backed up first)
#              unless --keep-config is given.
#   status     Show registration state per profile: bundle in
#              dsh.profile.bundles, dependency spec, installed package
#              version, config presence, and composition entry count
#              (--dump-config). Exit code 0 when every listed profile has
#              the bundle registered (and the composition verifies when the
#              dsh CLI is available).
#   help       Show this help.
#
# Usage:
#   ./dsh-agentarts-plugin.sh --agent-id <id> --domain-id <id> \
#     --project-id <id> --endpoint https://apm-access.<region>.myhuaweicloud.com \
#     --token <token> --aom-endpoint https://aom-access.<region>.myhuaweicloud.com \
#     --aom-access-code <code> \
#     --aom-prometheus-id <id> [--resource-type agent]
#     # no subcommand = install
#   ./dsh-agentarts-plugin.sh install   [same options]   # explicit
#   ./dsh-agentarts-plugin.sh status    [--profile "web,headless"]
#   ./dsh-agentarts-plugin.sh uninstall [--yes] [--keep-config]
#   ./dsh-agentarts-plugin.sh help

set -euo pipefail

PLUGIN_NAME="@cloud/huaweicloud-agentarts-observation-dsh-plugin"
PLUGIN_ID="huaweicloud-agentarts-observation-dsh"
# tgz 产物文件名前缀（npm pack 对 scoped 包默认产出 cloud- 前缀，build_dsh.sh 重命名为无前缀形态）
PLUGIN_TARBALL_PREFIX="huaweicloud-agentarts-observation-dsh-plugin"
# 配置/数据目录用的目录名（不带 scope，scope 是 npm 分发概念不影响本地路径）
PLUGIN_DIR_NAME="huaweicloud-agentarts-observation-dsh-plugin"
PROFILES_HOME="$HOME/.dsh/profiles"
# 配置/数据目录：~/.dsh/plugins/<目录名>/（DSH 插件归属区，pnpm 不管理，重装不丢）
PLUGIN_HOME="$HOME/.dsh/plugins/$PLUGIN_DIR_NAME"
CONFIG_PATH="$PLUGIN_HOME/config.json"
# 旧版配置目录（一次性迁移源；仅 install 读取复制，运行时不再写入）
LEGACY_METRICS_CONFIG="$HOME/.dsh-metrics/config.json"
LEGACY_METRICS_HOME="$HOME/.dsh-metrics"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 子命令解析（首个非 - 开头参数；缺省 install） ────────────────────────
SUBCOMMAND="install"
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
    SUBCOMMAND="$1"
    shift
fi

PKG_PATH=""
PROFILE="web"
DSH_ROOT_OVERRIDE=""
AGENT_ID=""
AGENT_NAME=""
LINK_SUBAGENT_TRACE=""
DOMAIN_ID=""
PROJECT_ID=""
RESOURCE_TYPE="agent"
RESOURCE_VERSION=""
USER_ID=""
ENDPOINT=""
TOKEN=""
AOM_ENDPOINT=""
AOM_ACCESS_CODE=""
AOM_PROMETHEUS_ID=""
SKIP_CONFIG=0
KEEP_CONFIG=0
ASSUME_YES=0

info() { echo "[dsh-observation] $*"; }
warn() { echo "[dsh-observation] WARN: $*"; }
err()  { echo "[dsh-observation] ERROR: $*" >&2; }

usage() {
cat <<'EOF'
DSH AgentArts Observation Plugin - single entry installer/uninstaller.

Usage:
  ./dsh-agentarts-plugin.sh --agent-id <id> --domain-id <id> --project-id <id> \
      --endpoint <host:port> --token <token> \
      --aom-endpoint <host:port> --aom-access-code <code> \
      --aom-prometheus-id <id> [options]
      # no subcommand = install

  ./dsh-agentarts-plugin.sh install   [same options]      # explicit
  ./dsh-agentarts-plugin.sh configure [same options]      # 只写配置，不安装
  ./dsh-agentarts-plugin.sh status    [--profile "web,headless"]
  ./dsh-agentarts-plugin.sh uninstall [--yes] [--keep-config] [--profile "..."]
  ./dsh-agentarts-plugin.sh help

install - required when ~/.dsh/plugins/<插件包名>/config.json does not exist (merge mode
          keeps unrelated fields when it does):
  --agent-id <id>                AgentArts agent resource ID
  --domain-id <id>               AgentArts tenant/domain ID
  --project-id <id>              AgentArts project ID
  --endpoint <addr>              APM OTLP gRPC endpoint. Any form accepted:
                                 https://apm-access.<region>.myhuaweicloud.com
                                 apm-access.<region>.myhuaweicloud.com:443
                                 10.x.x.x:4317 (in-cluster plaintext gRPC)
  --token <token>                APM authentication token
  --aom-endpoint <addr>          AOM OTLP gRPC endpoint; same forms as --endpoint
  --aom-access-code <code>       AOM access code
  --aom-prometheus-id <id>       AOM prometheus instance ID

install - optional:
  --resource-type (default agent; agent|multiagents|workflow)
  --resource-version, --user-id, --profile "web,headless" (default web),
  --package-path <dir|tarball>, --dsh-root <DSH checkout>, --skip-config

uninstall:
  --yes            Skip the confirmation prompt
  --keep-config    Keep ~/.dsh/plugins/<插件包名>/config.json (backed up otherwise)
  --profile, --dsh-root as above

status:
  Shows bundle registration, dependency spec, installed package version,
  config presence, and composition entry count per profile.
  Exit code 0 when every profile has the bundle registered.

Notes:
  - dsh CLI lookup: PATH -> --dsh-root -> DSH_ROOT -> /opt/deepseek-harness
    (node+tsx, falling back to `pnpm dsh` when node cannot run the CLI).
  - config.json is backed up before merge; rewrites drop // comments (keep
    config.example.json as the annotated template).
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --package-path)      PKG_PATH="$2"; shift 2 ;;
        --profile)          PROFILE="$2"; shift 2 ;;
        --dsh-root)         DSH_ROOT_OVERRIDE="$2"; shift 2 ;;
        --agent-id)         AGENT_ID="$2"; shift 2 ;;
        --agent-name)      AGENT_NAME="$2"; shift 2 ;;
        --link-subagent-trace) LINK_SUBAGENT_TRACE="$2"; shift 2 ;;
        --domain-id)        DOMAIN_ID="$2"; shift 2 ;;
        --project-id)       PROJECT_ID="$2"; shift 2 ;;
        --resource-type)    RESOURCE_TYPE="$2"; shift 2 ;;
        --resource-version) RESOURCE_VERSION="$2"; shift 2 ;;
        --user-id)          USER_ID="$2"; shift 2 ;;
        --endpoint)         ENDPOINT="$2"; shift 2 ;;
        --token)           TOKEN="$2"; shift 2 ;;
        --aom-endpoint)    AOM_ENDPOINT="$2"; shift 2 ;;
        --aom-access-code) AOM_ACCESS_CODE="$2"; shift 2 ;;
        --aom-prometheus-id) AOM_PROMETHEUS_ID="$2"; shift 2 ;;
        --skip-config)     SKIP_CONFIG=1; shift ;;
        --keep-config)     KEEP_CONFIG=1; shift ;;
        --yes)             ASSUME_YES=1; shift ;;
        --help)            usage; exit 0 ;;
        *)                  err "unknown option: $1"; usage >&2; exit 1 ;;
    esac
done

# ── dsh CLI 定位：PATH -> checkout（node+tsx -> pnpm dsh） ──────────────
DSH_MODE=""
DSH_ROOT_RESOLVED=""
run_dsh() {
    case "$DSH_MODE" in
        path) dsh "$@" 2>&1 ;;
        tsx)  (cd "$DSH_ROOT_RESOLVED" && node --import tsx/esm apps/cli/src/bin.ts "$@" 2>&1) ;;
        pnpm) (cd "$DSH_ROOT_RESOLVED" && pnpm dsh "$@" 2>&1) ;;
    esac
}
resolve_dsh_cli() {
    if command -v dsh > /dev/null 2>&1; then DSH_MODE="path"; info "dsh CLI: PATH"; return; fi
    local roots=()
    [ -n "$DSH_ROOT_OVERRIDE" ] && roots+=("$DSH_ROOT_OVERRIDE")
    [ -n "${DSH_ROOT:-}" ] && roots+=("$DSH_ROOT")
    roots+=("/opt/deepseek-harness" "$HOME/deepseek-harness")
    local root
    for root in "${roots[@]}"; do
        [ -f "$root/apps/cli/src/bin.ts" ] || continue
        if command -v node > /dev/null 2>&1; then
            DSH_MODE="tsx"; DSH_ROOT_RESOLVED="$root"; info "dsh CLI: checkout via node+tsx ($root)"; return
        fi
        if command -v pnpm > /dev/null 2>&1; then
            DSH_MODE="pnpm"; DSH_ROOT_RESOLVED="$root"; info "dsh CLI: checkout via pnpm dsh ($root)"; return
        fi
    done
    err "dsh CLI not found: install dsh on PATH or pass --dsh-root <DSH checkout>."
    exit 1
}

# ── install：包源探测（--package-path → tgz（脚本旁/仓库 dist）→ 仓库根） ─
resolve_package_source() {
    if [ -n "$PKG_PATH" ]; then
        [ -e "$PKG_PATH" ] || { err "--package-path not found: $PKG_PATH"; exit 1; }
        printf '%s' "$PKG_PATH"
        return
    fi
    # 优先官方构建产物 tgz：脚本旁 → 仓库根 → 仓库 dist/（npm pack 输出；scoped 包产物名为 cloud- 前缀）
    local root parent tarball count
    parent="$(dirname "$SCRIPT_DIR")"
    for root in "$SCRIPT_DIR" "$parent" "$parent/dist"; do
        tarball="$(ls -1 "$root/${PLUGIN_TARBALL_PREFIX}"-*.tgz 2>/dev/null || true)"
        if [ -n "$tarball" ]; then
            count="$(printf '%s\n' "$tarball" | grep -c .)"
            if [ "$count" -gt 1 ]; then
                err "multiple plugin tarballs under $root; pass --package-path to pick one."
                exit 1
            fi
            printf '%s' "$tarball"
            return
        fi
    done
    # 回退：脚本所在仓库根（开发态 link: 安装）
    local pkg_name
    if [ -f "$parent/package.json" ]; then
        pkg_name="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")' "$parent/package.json" 2>/dev/null || true)"
        if [ "$pkg_name" = "$PLUGIN_NAME" ]; then printf '%s' "$parent"; return; fi
    fi
    err "plugin package not found: pass --package-path <dir|tarball> (or run from the repository / next to a built tarball)."
    exit 1
}

# 上报地址不做校验、不改写：域名 / IP / 端口 / 协议各种写法都原样写入，
# 由插件的 toGrpcUrl 统一归一化。脚本擅自补端口或协议会改变语义。
normalize_endpoint_input() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

split_profiles() {
    local IFS=','
    # shellcheck disable=SC2086
    printf '%s\n' $PROFILE | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true
}

# ── install：缺失 profile 的基础文件（对齐 dsh 内置 profile 结构） ────────
base_bundles_of() {
    case "$1" in
        web)      printf '%s\n' "@deepseek-ai/dsh-base" "@deepseek-ai/dsh-web-app" ;;
        headless) printf '%s\n' "@deepseek-ai/dsh-base" "@deepseek-ai/dsh-headless" ;;
        sdk)      printf '%s\n' "@deepseek-ai/dsh-base" "@deepseek-ai/dsh-sdk-app" ;;
        desktop)  printf '%s\n' "@deepseek-ai/dsh-base" "@deepseek-ai/dsh-web-app" ;;
        *)        printf '%s\n' "@deepseek-ai/dsh-base" ;;
    esac
}

ensure_profile() {
    local dir="$PROFILES_HOME/$1"
    if [ -d "$dir" ]; then printf '%s' "$dir"; return; fi
    info "profile '$1' missing; creating base files"
    mkdir -p "$dir"
    local bundles_json
    bundles_json="$(base_bundles_of "$1" | node -e '
        const items = require("fs").readFileSync(0, "utf8").trim().split(/\n+/).filter(Boolean)
        process.stdout.write(JSON.stringify(items))')"
    node --input-type=commonjs - "$dir/package.json" "$1" "$bundles_json" <<'EOF'
const fs = require('fs')
const [file, name, bundles] = process.argv.slice(1)
fs.writeFileSync(file, JSON.stringify({
    name: `dsh-profile-${name}`, private: true, dependencies: {},
    dsh: { profile: { bundles: JSON.parse(bundles) } },
}, null, 2) + '\n')
EOF
    printf '# dsh profile root - an empty entry list. The tree is composed as patches:\n# each bundle in the profile package.json dsh.profile.bundles, then the\n# profile cordis.patch.yml, then any --patch overlays. Edit cordis.patch.yml,\n# not this file.\n[]\n' > "$dir/cordis.yml"
    printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$dir/pnpm-workspace.yaml"
    printf '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; !!js expressions allowed).\n' > "$dir/cordis.patch.yml"
    printf '%s' "$dir"
}

# ── 配置写入（install 与 configure 共用）───────────────────────────────
# 只生成/合并 config.json，不触碰 profile。已通过 DSH 插件界面或 dsh plugin add
# 从 Git 安装插件的用户，可单独运行 configure 子命令写入接入信息。
write_plugin_config() {
    # config.json 生成/合并（备份 -> 合并，不动无关字段）
    # 旧版配置一次性迁移（独立于 --skip-config）：新路径无 config.json 且旧 ~/.dsh-metrics/
    # 存在 → 复制（旧文件保留）。配置是用户数据；data/ 历史日志一并复制，保持排查记录连续。
    if [ ! -f "$CONFIG_PATH" ] && [ -f "$LEGACY_METRICS_CONFIG" ]; then
        mkdir -p "$PLUGIN_HOME"
        cp "$LEGACY_METRICS_CONFIG" "$CONFIG_PATH"
        info "config migrated from legacy location (original kept): $LEGACY_METRICS_CONFIG -> $CONFIG_PATH"
        if [ -d "$LEGACY_METRICS_HOME/data" ] && [ ! -d "$PLUGIN_HOME/data" ]; then
            cp -r "$LEGACY_METRICS_HOME/data" "$PLUGIN_HOME/data"
            info "historical logs migrated from legacy location (original kept): $LEGACY_METRICS_HOME/data"
        fi
        SUMMARY+=("config: migrated from legacy ~/.dsh-metrics/")
    fi

    # DSH 版本探测（resource_version 自动取运行中 DSH 版本；探测失败兜底 "default"）
    if [ -z "$RESOURCE_VERSION" ]; then
        dsh_ver=""
        if [ -n "$DSH_MODE" ]; then
            dsh_ver="$(run_dsh --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
        elif command -v dsh > /dev/null 2>&1; then
            dsh_ver="$(dsh --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
        fi
        if [ -n "$dsh_ver" ]; then
            RESOURCE_VERSION="$dsh_ver"
        else
            RESOURCE_VERSION="default"
        fi
        info "resource_version (auto-detected DSH version): $RESOURCE_VERSION"
    fi
    [ -z "$RESOURCE_VERSION" ] && RESOURCE_VERSION="default"

    if [ "$SKIP_CONFIG" -eq 1 ]; then
        info "config: skipped (--skip-config)"
        SUMMARY+=("config: skipped")
    else
        ENDPOINT_PORT=""; [ -n "$ENDPOINT" ] && ENDPOINT_PORT="$(normalize_endpoint_input "$ENDPOINT")"
        AOM_ENDPOINT_PORT=""; [ -n "$AOM_ENDPOINT" ] && AOM_ENDPOINT_PORT="$(normalize_endpoint_input "$AOM_ENDPOINT")"
        updates_file="$(mktemp)"
        AGENT_ID="$AGENT_ID" AGENT_NAME="$AGENT_NAME" LINK_SUBAGENT_TRACE="$LINK_SUBAGENT_TRACE" DOMAIN_ID="$DOMAIN_ID" PROJECT_ID="$PROJECT_ID" \
        RESOURCE_TYPE="$RESOURCE_TYPE" RESOURCE_VERSION="$RESOURCE_VERSION" \
        TOKEN="$TOKEN" ENDPOINT_PORT="$ENDPOINT_PORT" AOM_ACCESS_CODE="$AOM_ACCESS_CODE" \
        AOM_ENDPOINT_PORT="$AOM_ENDPOINT_PORT" AOM_PROMETHEUS_ID="$AOM_PROMETHEUS_ID" \
        USER_ID="$USER_ID" node --input-type=commonjs - "$updates_file" <<'EOF'
const fs = require('fs')
const v = {
    agent_resource_id: process.env.AGENT_ID,
    agent_domain_id: process.env.DOMAIN_ID,
    agentarts_project_id: process.env.PROJECT_ID,
    resource_type: process.env.RESOURCE_TYPE,
    resource_version: process.env.RESOURCE_VERSION,
    agentarts_agentops_apm_token: process.env.TOKEN,
    agentarts_agentops_apm_exporter_endpoint: process.env.ENDPOINT_PORT,
    agentarts_agentops_aom_access_code: process.env.AOM_ACCESS_CODE,
    agentarts_agentops_aom_exporter_endpoint: process.env.AOM_ENDPOINT_PORT,
    agentarts_agentops_aom_prometheus_id: process.env.AOM_PROMETHEUS_ID,
}
const otel = {}
for (const [k, val] of Object.entries(v)) if (val) otel[k] = val
const updates = {}
if (process.env.USER_ID) updates['user.id'] = process.env.USER_ID
if (process.env.AGENT_NAME) updates['agent_name'] = process.env.AGENT_NAME
if (process.env.LINK_SUBAGENT_TRACE !== undefined && process.env.LINK_SUBAGENT_TRACE !== '') updates.features = { linkSubagentTrace: process.env.LINK_SUBAGENT_TRACE === 'true' }
if (Object.keys(otel).length) updates.otel = otel
fs.writeFileSync(process.argv[1], JSON.stringify(updates))
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
    if (inStr) { o += c; if (c === '\\\\') { o += n || ''; i += 2; continue } if (c === '"') inStr = false; i++; continue }
    if (c === '"') { inStr = true; o += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\\n') i++; continue }
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
    features: { debug: false, captureMessageContent: true, linkSubagentTrace: true },
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
NODE_MERGE
)" || { err "config generation failed: $out"; exit 1; }
        rm -f "$updates_file"
        info "config: $out"
        SUMMARY+=("config: $CONFIG_PATH ($([ "$CONFIG_EXISTS" -eq 1 ] && echo merged || echo generated))")
    fi

    echo ""
}

# ── configure 子命令（只写配置，不安装、不改 profile）──────────────────
cmd_configure() {
    info "configure mode: writes $CONFIG_PATH only; the plugin must already be installed"
    CONFIG_EXISTS=0
    [ -f "$CONFIG_PATH" ] && CONFIG_EXISTS=1
    if [ "$CONFIG_EXISTS" -eq 0 ]; then
        missing=()
        [ -n "$AGENT_ID" ] || missing+=(--agent-id)
        [ -n "$DOMAIN_ID" ] || missing+=(--domain-id)
        [ -n "$PROJECT_ID" ] || missing+=(--project-id)
        [ -n "$ENDPOINT" ] || missing+=(--endpoint)
        [ -n "$TOKEN" ] || missing+=(--token)
        [ -n "$AOM_ENDPOINT" ] || missing+=(--aom-endpoint)
        [ -n "$AOM_ACCESS_CODE" ] || missing+=(--aom-access-code)
        [ -n "$AOM_PROMETHEUS_ID" ] || missing+=(--aom-prometheus-id)
        if [ "${#missing[@]}" -gt 0 ]; then
            err "missing required parameters (no existing $CONFIG_PATH): ${missing[*]}"
            exit 1
        fi
    fi
    SUMMARY=()
    SKIP_CONFIG=0
    write_plugin_config
    echo ""
    info "== Configure complete =="
    for line in "${SUMMARY[@]}"; do info "  $line"; done
    info "restart dsh to apply: the plugin reads config.json only at load time"
}

cmd_install() {
    resolve_dsh_cli
    PACKAGE_SOURCE="$(resolve_package_source)"
    info "plugin package: $PACKAGE_SOURCE"
    SUMMARY=()

    # 业务参数校验（config.json 不存在时必填）
    CONFIG_EXISTS=0
    [ -f "$CONFIG_PATH" ] && CONFIG_EXISTS=1
    if [ "$CONFIG_EXISTS" -eq 0 ] && [ "$SKIP_CONFIG" -eq 0 ]; then
        missing=()
        [ -n "$AGENT_ID" ] || missing+=(--agent-id)
        [ -n "$DOMAIN_ID" ] || missing+=(--domain-id)
        [ -n "$PROJECT_ID" ] || missing+=(--project-id)
        [ -n "$ENDPOINT" ] || missing+=(--endpoint)
        [ -n "$TOKEN" ] || missing+=(--token)
        [ -n "$AOM_ENDPOINT" ] || missing+=(--aom-endpoint)
        [ -n "$AOM_ACCESS_CODE" ] || missing+=(--aom-access-code)
        [ -n "$AOM_PROMETHEUS_ID" ] || missing+=(--aom-prometheus-id)
        if [ "${#missing[@]}" -gt 0 ]; then
            err "missing required parameters (no existing $CONFIG_PATH): ${missing[*]}"
            exit 1
        fi
    fi

    while IFS= read -r name; do
        info "--- profile '$name' ---"
        profile_dir="$(ensure_profile "$name")" || { SUMMARY+=("profile '$name': skipped"); continue; }
        pkg_file="$profile_dir/package.json"
        is_desktop=$([ "$name" = "desktop" ] && echo 1 || echo 0)

        # 1) 安装依赖（desktop 受 Electron 管理，跳过 dsh plugin 命令，直接 pnpm；
        #    依赖已存在时先 remove：pnpm 对已链接的包名会跳过安装"Already up to date"）
        if [ "$is_desktop" -eq 1 ]; then
            info "  desktop profile: using direct pnpm (Electron-managed)"
            if [ -f "$pkg_file" ] && node -e '
                const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
                process.exit(pkg.dependencies && pkg.dependencies[process.argv[2]] ? 0 : 1)
            ' "$pkg_file" "$PLUGIN_NAME" 2> /dev/null; then
                (cd "$profile_dir" && pnpm remove "$PLUGIN_NAME" > /dev/null 2>&1) && info "  removed existing dependency first" || warn "  pre-add remove returned $? (continue)"
            fi
            (cd "$profile_dir" && pnpm add "$PACKAGE_SOURCE" > /dev/null 2>&1) || { err "pnpm add failed for desktop profile."; exit 1; }
        else
            if [ -f "$pkg_file" ] && node -e '
                const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
                process.exit(pkg.dependencies && pkg.dependencies[process.argv[2]] ? 0 : 1)
            ' "$pkg_file" "$PLUGIN_NAME" 2> /dev/null; then
                if run_dsh plugin --profile "$name" remove "$PLUGIN_NAME" > /dev/null; then
                    info "  removed existing dependency first (re-install)"
                else
                    warn "  pre-add remove failed (continue)"
                fi
            fi
            if ! run_dsh plugin --profile "$name" add "$PACKAGE_SOURCE" > /dev/null; then
                err "dsh plugin add failed for profile '$name'."
                exit 1
            fi
        fi
        info "  installed dependency: $PLUGIN_NAME"
        SUMMARY+=("profile '$name': dependency installed ($PLUGIN_NAME)")

        # 2) bundle 注册：备份 -> 修改 -> 验证（内嵌 node 脚本；与 ps1 同步维护）
        backup="$pkg_file.bak.$(date +%Y%m%d%H%M%S)"
        cp "$pkg_file" "$backup"
        if ! node --input-type=commonjs - "$pkg_file" "$PLUGIN_NAME" > /dev/null <<'NODE_BUNDLES'
const fs = require('fs')
const [pkgPath, pluginName] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const before = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : []
const bundles = before.filter(name => name !== pluginName)
if (!bundles.includes(pluginName)) bundles.push(pluginName)
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
NODE_BUNDLES
        then
            err "bundle registration failed."
            exit 1
        fi
        node --input-type=commonjs - "$pkg_file" "$PLUGIN_NAME" <<'EOF' || { err "bundle registration verify failed."; exit 1; }
const [file, plugin] = process.argv.slice(1)
const pkg = JSON.parse(require('fs').readFileSync(file, 'utf8'))
if (!(pkg.dsh?.profile?.bundles ?? []).includes(plugin)) process.exit(1)
EOF
        info "  registered bundle in dsh.profile.bundles (backup: $backup)"
        SUMMARY+=("profile '$name': bundle registered in dsh.profile.bundles")

        # 3) 组合验证：--dump-config 中插件条目恰好 1 条
        #    desktop profile 由 Electron 独占管理，CLI 的 --dump-config 必然被拒绝，
        #    这里跳过组合检查（不是安装失败），改由 status 子命令或 App 内确认。
        if [ "$is_desktop" -eq 1 ]; then
            info "  composition check skipped (desktop profile is Electron-managed)"
            SUMMARY+=("profile '$name': composition check skipped (Electron-managed)")
            dump=""
            skip_composition=1
        else
            skip_composition=0
            dump="$(run_dsh --profile "$name" --dump-config)" || dump=""
        fi
        if [ "$skip_composition" -eq 1 ]; then
            : # 已跳过
        elif [ -n "$dump" ]; then
            count="$(printf '%s\n' "$dump" | grep -c "^- id: $PLUGIN_ID$" || true)"
            if [ "$count" = "1" ]; then
                info "  composition verified: exactly 1 '$PLUGIN_ID' entry"
            else
                warn "  composition check: expected 1 entry, found ${count:-0}; inspect --dump-config"
            fi
        else
            warn "  --dump-config failed; verify manually later"
        fi
    done < <(split_profiles)

    # 4) config.json 生成/合并（configure 子命令复用同一函数）
    write_plugin_config

    info "== Install complete =="
    for line in "${SUMMARY[@]}"; do info "  $line"; done
    info "plugin: $PLUGIN_NAME (bundle id: $PLUGIN_ID)"
    info "restart dsh when convenient (or wait for HMR) to load the new bundle."
    info "logs: ~/.dsh/plugins/<插件包名>/data/logs/plugin-YYYY-MM-DD.log"
}

cmd_uninstall() {
    # install-only 参数提示（分组校验：uninstall 忽略业务参数）
    ignored=()
    [ -n "$AGENT_ID" ] && ignored+=(--agent-id)
    [ -n "$DOMAIN_ID" ] && ignored+=(--domain-id)
    [ -n "$PROJECT_ID" ] && ignored+=(--project-id)
    [ -n "$ENDPOINT" ] && ignored+=(--endpoint)
    [ -n "$TOKEN" ] && ignored+=(--token)
    [ -n "$AOM_ENDPOINT" ] && ignored+=(--aom-endpoint)
    [ -n "$AOM_ACCESS_CODE" ] && ignored+=(--aom-access-code)
    [ -n "$AOM_PROMETHEUS_ID" ] && ignored+=(--aom-prometheus-id)
    if [ "${#ignored[@]}" -gt 0 ]; then
        warn "install-only options ignored by uninstall: ${ignored[*]}"
    fi

    resolve_dsh_cli
    info "This will remove:"
    info "  1. bundle registration ($PLUGIN_NAME) in each profile's dsh.profile.bundles"
    info "  2. the plugin dependency in each profile"
    info "  3. $CONFIG_PATH (unless --keep-config; backup kept either way)"
    echo ""

    if [ "$ASSUME_YES" -ne 1 ]; then
        read -r -p "Proceed with uninstall? [y/N] " confirm
        case "$confirm" in y|Y) ;; *) info "Uninstall cancelled."; exit 0 ;; esac
    fi

    while IFS= read -r name; do
        info "--- profile '$name' ---"
        profile_dir="$PROFILES_HOME/$name"
        if [ ! -d "$profile_dir" ]; then warn "profile directory missing; skipped"; continue; fi
        pkg_file="$profile_dir/package.json"

        # 备份（后续 pnpm remove / profile-edit 都会改写 package.json）
        if [ -f "$pkg_file" ]; then
            backup="$pkg_file.bak.$(date +%Y%m%d%H%M%S)"
            cp "$pkg_file" "$backup"
            info "  package.json backup: $backup"
        fi

        # 1) 依赖移除（desktop 直接 pnpm；其他走 dsh plugin remove -> pnpm remove）
        if [ -f "$pkg_file" ] && node -e '
            const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
            process.exit(pkg.dependencies && pkg.dependencies[process.argv[2]] ? 0 : 1)
        ' "$pkg_file" "$PLUGIN_NAME" 2> /dev/null; then
            if [ "$name" = "desktop" ]; then
                (cd "$profile_dir" && pnpm remove "$PLUGIN_NAME" > /dev/null 2>&1) && info "  removed dependency: $PLUGIN_NAME" || warn "  pnpm remove failed for desktop profile"
            elif [ -n "$DSH_MODE" ]; then
                if run_dsh plugin --profile "$name" remove "$PLUGIN_NAME" > /dev/null; then
                    info "  removed dependency: $PLUGIN_NAME"
                else
                    warn "  dsh plugin remove failed"
                fi
            else
                warn "  dependency left in place (no dsh CLI); remove manually"
            fi
        fi

        # 2) bundle 注册移除（修改 -> 验证；依赖已由 pnpm 处理，此处兜底清理残余键）
        if [ -f "$pkg_file" ]; then
            # 内嵌 node 脚本（与 ps1 同步维护）
            if ! node --input-type=commonjs - "$pkg_file" "$PLUGIN_NAME" > /dev/null <<'NODE_REMOVE'
const fs = require('fs')
const [pkgPath, pluginName] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const before = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : []
const bundles = before.filter(name => name !== pluginName)
if (pkg.dependencies && pkg.dependencies[pluginName] !== undefined) {
  delete pkg.dependencies[pluginName]
}
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
NODE_REMOVE
            then
                warn "  bundle removal failed; inspect $pkg_file"
            else
                if node --input-type=commonjs - "$pkg_file" "$PLUGIN_NAME" <<'EOF'
const [file, plugin] = process.argv.slice(1)
const pkg = JSON.parse(require('fs').readFileSync(file, 'utf8'))
process.exit((pkg.dsh?.profile?.bundles ?? []).includes(plugin) ? 1 : 0)
EOF
                then
                    info "  removed bundle registration"
                else
                    warn "  bundle entries still present; inspect $pkg_file"
                fi
            fi
        else
            warn "  package.json missing; skipped"
        fi
    done < <(split_profiles)

    # 3) config.json 移除（默认备份后删除；--keep-config 跳过）
    if [ "$KEEP_CONFIG" -eq 1 ]; then
        info "config kept (--keep-config): $CONFIG_PATH"
    elif [ -f "$CONFIG_PATH" ]; then
        backup="$CONFIG_PATH.bak.$(date +%Y%m%d%H%M%S)"
        cp "$CONFIG_PATH" "$backup"
        rm -f "$CONFIG_PATH"
        info "config removed (backup: $backup)"
    else
        info "no config to remove: $CONFIG_PATH"
    fi

    echo ""
    info "== Uninstall complete =="
    info "restart dsh when convenient; the plugin will no longer be loaded."
    info "kept: ~/.dsh/plugins/<插件包名>/data logs and every .bak backup."
}

cmd_status() {
    ALL_REGISTERED=1
    while IFS= read -r name; do
        info "--- profile '$name' ---"
        profile_dir="$PROFILES_HOME/$name"
        if [ ! -d "$profile_dir" ]; then info "  profile directory missing"; ALL_REGISTERED=0; continue; fi
        pkg_file="$profile_dir/package.json"
        if [ ! -f "$pkg_file" ]; then info "  package.json missing"; ALL_REGISTERED=0; continue; fi

        # bundle 注册状态
        if node -e '
            const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
            process.exit((pkg.dsh?.profile?.bundles ?? []).includes(process.argv[2]) ? 0 : 1)
        ' "$pkg_file" "$PLUGIN_NAME" 2> /dev/null; then
            info "  bundle registered : yes"
        else
            info "  bundle registered : no"
            ALL_REGISTERED=0
        fi

        # 依赖形态
        dep_spec="$(node -e '
            const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
            process.stdout.write(pkg.dependencies?.[process.argv[2]] || "")
        ' "$pkg_file" "$PLUGIN_NAME" 2> /dev/null || true)"
        if [ -n "$dep_spec" ]; then info "  dependency         : $dep_spec"
        else info "  dependency         : (not recorded)"; fi

        # 已安装包版本（node_modules 副本）
        installed_json="$profile_dir/node_modules/$PLUGIN_NAME/package.json"
        if [ -f "$installed_json" ]; then
            node --input-type=commonjs - "$installed_json" <<'EOF'
const inst = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))
console.log(`  installed package  : ${inst.version} (engines.dsh ${inst.engines?.dsh})`)
EOF
        else
            info "  installed package  : (not installed in node_modules)"
        fi

        # 配置状态（不显示敏感值；JSONC 手写注释时降级提示）
        if [ -f "$CONFIG_PATH" ]; then
            node --input-type=commonjs - "$CONFIG_PATH" <<'EOF' || info "  config.json        : exists (JSONC or unreadable)"
const fs = require('fs')
let raw = fs.readFileSync(process.argv[1], 'utf8'), cfg
try { cfg = JSON.parse(raw) } catch { process.exit(1) }
const o = cfg.otel ?? {}
console.log(`  config.json        : exists (APM ${o.agentarts_agentops_otel_agent_apm_enable ? 'on' : 'off'} / AOM ${o.agentarts_agentops_otel_agent_aom_enable ? 'on' : 'off'})`)
EOF
        else
            info "  config.json        : missing"
        fi

        # 组合验证（需要 dsh CLI）；desktop 由 Electron 独占，CLI 必然拒绝，跳过
        if [ "$name" = "desktop" ]; then
            info "  composition        : skipped (Electron-managed)"
        else
        [ -n "$DSH_MODE" ] || resolve_dsh_cli
        if [ -n "$DSH_MODE" ]; then
            dump="$(run_dsh --profile "$name" --dump-config)" || dump=""
            if [ -n "$dump" ]; then
                count="$(printf '%s\n' "$dump" | grep -c "^- id: $PLUGIN_ID$" || true)"
                info "  composition        : ${count:-0} '$PLUGIN_ID' entry(ies) (expect 1)"
                [ "$count" = "1" ] || ALL_REGISTERED=0
            else
                warn "  composition        : --dump-config failed"
                ALL_REGISTERED=0
            fi
        else
            warn "  composition        : not checked (dsh CLI not found)"
        fi
        fi
    done < <(split_profiles)

    if [ "$ALL_REGISTERED" -eq 1 ]; then info "status: registered"; exit 0
    else info "status: not fully registered"; exit 1; fi
}

# ── 子命令分发 ─────────────────────────────────────────────────────────
case "$SUBCOMMAND" in
    install)   cmd_install ;;
    configure) cmd_configure ;;
    uninstall) cmd_uninstall ;;
    status)    cmd_status ;;
    help)      usage; exit 0 ;;
    *)         err "unknown subcommand: $SUBCOMMAND (expected install | uninstall | status | help)"; usage >&2; exit 1 ;;
esac

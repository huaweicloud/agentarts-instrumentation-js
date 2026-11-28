// 配置加载：~/.dsh/plugins/agentarts-instrumentation-dsh/config.json
// 支持 // 与 /* */ 注释（JSONC）。
// 启动时经 validateConfig 校验并输出告警；运行期 watchConfig 监听变更，
// 轻量字段（features/agent_name 等）热生效，otel/enabled 变更提示需重启。
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

const PLUGIN_HOME = path.join(
  os.homedir(),
  ".dsh",
  "plugins",
  "agentarts-instrumentation-dsh"
)
export const CONFIG_PATH = path.join(PLUGIN_HOME, "config.json")

const DEFAULT_CONFIG = {
  // 基础配置
  version: "1.0.0-rc.7",
  enabled: true,
  agent_name: "",
  outputDir: path.join(PLUGIN_HOME, "data"),
  // 功能开关
  features: {
    debug: false, // debug 日志开关（默认关闭）
    captureMessageContent: true, // 采集 trace 输入/输出消息内容（默认开启；false 时不上报内容属性）
    linkSubagentTrace: true, // 串联子 agent trace 到父 trace（默认开启；false 时子独立上报）
    logRetentionDays: 14 // 日志保留天数：自动删除更早的 plugin-YYYY-MM-DD.log（0 关闭清理）
  },
  // OpenTelemetry 上报配置（默认不启用，需要用户配置）
  otel: undefined
}

// ── 已知字段表（校验用；新增字段时同步 config.example.json 与安装脚本） ──
export const KNOWN_ROOT_KEYS = [
  "version",
  "enabled",
  "agent_name",
  "outputDir",
  "user.id",
  "features",
  "otel"
] as const

export const KNOWN_FEATURES_KEYS = [
  "debug",
  "captureMessageContent",
  "linkSubagentTrace",
  "logRetentionDays"
] as const

export const KNOWN_OTEL_KEYS = [
  "agentarts_agentops_otel_agent_apm_enable",
  "agentarts_agentops_otel_agent_aom_enable",
  "agent_domain_id",
  "agentarts_project_id",
  "agent_resource_id",
  "resource_type",
  // 已废弃：资源版本改由运行中的 DSH 版本提供，此键仅为兼容旧配置而保留识别
  "resource_version",
  "agentarts_agentops_apm_token",
  "agentarts_agentops_apm_exporter_endpoint",
  "agentarts_agentops_aom_access_code",
  "agentarts_agentops_aom_exporter_endpoint",
  "agentarts_agentops_aom_prometheus_id"
] as const

/** 已废弃的配置键：识别但忽略，出现时给出可删除的提示 */
const DEPRECATED_OTEL_KEYS = ["resource_version"] as const

const OTel_BOOLEAN_KEYS = [
  "agentarts_agentops_otel_agent_apm_enable",
  "agentarts_agentops_otel_agent_aom_enable"
] as const

// 资源类型默认 agent（平台通用取值），可在配置中通过 otel.resource_type 覆盖；
// 需要标识新产品时填 deepseekharness —— 便于新旧版本共存。
export const DEFAULT_RESOURCE_TYPE = "agent"
/** 平台已知的资源类型取值（其余取值会给出告警，但不阻止运行） */
export const KNOWN_RESOURCE_TYPES = ["agent", "deepseekharness", "multiagents", "workflow"] as const

/**
 * 探测运行中的 DSH 版本，用于 resource_version。
 *
 * DSH 没有对外暴露版本服务，DSH_INSTALL_DIR 也只注入给 shell 子进程，
 * 因此按以下顺序尝试，全部失败时回退 "unknown"：
 *   1. 环境变量 DSH_INSTALL_DIR 指向的包目录（部分启动方式会注入）
 *   2. CLI 入口 node <dsh>/lib/bin.js
 *   3. Electron 桌面的 resources 路径（app.asar 或 asar 解包目录）
 */
let cachedDshVersion: string | null = null

export function detectDshVersion(): string {
  if (cachedDshVersion !== null) return cachedDshVersion

  const candidates: string[] = []
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir) candidates.push(path.join(installDir, "package.json"))

  const entry = process.argv[1]
  if (entry) {
    candidates.push(path.join(path.dirname(path.dirname(entry)), "package.json"))
  }

  const resourcesPath = (process as any).resourcesPath
  if (typeof resourcesPath === "string" && resourcesPath) {
    for (const appDir of ["app.asar", "app"]) {
      candidates.push(
        path.join(resourcesPath, appDir, "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json")
      )
    }
  }

  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, "utf-8"))
      if (manifest?.name === "@deepseek-ai/dsh" && typeof manifest.version === "string") {
        cachedDshVersion = manifest.version
        return cachedDshVersion
      }
    } catch {
      // 该来源不可用，继续下一个
    }
  }
  cachedDshVersion = "unknown"
  return cachedDshVersion
}

/** 配置问题（仅告警级；不阻止插件运行） */
export interface ConfigIssue {
  field: string
  message: string
}

function stripJsonComments(json: string): string {
  let result = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let i = 0
  while (i < json.length) {
    const ch = json[i]
    const next = json[i + 1]
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false
        result += ch
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false
        result += "  "
        i += 2
      } else {
        result += " "
        i++
      }
      continue
    }
    if (inString) {
      result += ch
      if (ch === "\\") {
        result += next ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true
      i += 2
      continue
    }
    result += ch
    i++
  }
  return result
}

/** 合并用户配置与默认值（features 浅合并；其余键整体覆盖） */
function mergeConfig(userConfig: Record<string, any>) {
  const merged = { ...DEFAULT_CONFIG, ...userConfig }
  if (userConfig.features) {
    merged.features = { ...DEFAULT_CONFIG.features, ...userConfig.features }
  }
  return merged
}

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 展开字符串值中的 ${VAR}。
 *
 * 未定义的变量**保留原样**并记录，避免静默变成空值导致上报悄悄失效。
 */
export function expandEnvPlaceholders(value: any, missing: Set<string> = new Set()): any {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER, (whole, name: string) => {
      const env = process.env[name]
      if (env === undefined) {
        missing.add(name)
        return whole
      }
      return env
    })
  }
  if (Array.isArray(value)) return value.map((entry) => expandEnvPlaceholders(entry, missing))
  if (value !== null && typeof value === "object") {
    const out: Record<string, any> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = expandEnvPlaceholders(entry, missing)
    return out
  }
  return value
}

/** 支持用配置键名直接覆盖的环境变量（otel 段，键名与环境变量名完全一致） */
export const DIRECT_ENV_OTEL_KEYS = KNOWN_OTEL_KEYS.filter(
  (key) => !(DEPRECATED_OTEL_KEYS as readonly string[]).includes(key)
) as readonly string[]

/** 支持用同名环境变量覆盖的 features 布尔项（含输入输出采集开关） */
export const DIRECT_ENV_FEATURE_KEYS = ["debug", "captureMessageContent", "linkSubagentTrace"] as const

/** 布尔型环境变量解析：true/false/1/0/yes/no（大小写不敏感），无法识别返回 undefined */
function parseEnvBoolean(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true
    case "false":
    case "0":
    case "no":
    case "off":
      return false
    default:
      return undefined
  }
}

/**
 * 按「配置键名即环境变量名」覆盖 otel 段。
 *
 * 例：export agentarts_agentops_otel_agent_apm_enable=true
 *     export agentarts_agentops_apm_token=xxx
 * 布尔键做类型转换；无法识别的值告警并忽略该键，避免静默写错。
 */
export function applyDirectEnvOverrides(config: Record<string, any>): Record<string, any> {
  const otel = { ...(config.otel ?? {}) }
  const features = { ...(config.features ?? {}) }
  let otelChanged = false
  let featuresChanged = false

  for (const key of DIRECT_ENV_OTEL_KEYS) {
    const raw = process.env[key]
    if (raw === undefined || raw === "") continue
    if (key.endsWith("_enable")) {
      const parsed = parseEnvBoolean(raw)
      if (parsed === undefined) {
        console.warn(`[agentarts-dsh] env ${key} expects true/false, got "${raw}"; ignored`)
        continue
      }
      otel[key] = parsed
    } else {
      otel[key] = raw
    }
    otelChanged = true
  }

  for (const key of DIRECT_ENV_FEATURE_KEYS) {
    const raw = process.env[key]
    if (raw === undefined || raw === "") continue
    const parsed = parseEnvBoolean(raw)
    if (parsed === undefined) {
      console.warn(`[agentarts-dsh] env ${key} expects true/false, got "${raw}"; ignored`)
      continue
    }
    features[key] = parsed
    featuresChanged = true
  }

  if (!otelChanged && !featuresChanged) return config
  const next: Record<string, any> = { ...config }
  if (otelChanged) next.otel = otel
  if (featuresChanged) next.features = features
  return next
}

/** 配置中布尔语义的字段路径（文件或 JSON 里可能被写成字符串） */
const BOOLEAN_CONFIG_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["otel", "agentarts_agentops_otel_agent_apm_enable"],
  ["otel", "agentarts_agentops_otel_agent_aom_enable"],
  ["features", "debug"],
  ["features", "captureMessageContent"],
  ["features", "linkSubagentTrace"]
]

/**
 * 归一化布尔字段。
 *
 * - 字符串 "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off"（大小写不敏感）转成 boolean
 * - 无法识别的值告警并删除该键（回退到默认值），避免 "false" 被当作真值
 *   导致内容采集或上报开关行为与预期相反
 */
export function normalizeBooleanConfig<T extends Record<string, any>>(config: T): T {
  const out: Record<string, any> = { ...config }
  for (const [section, key] of BOOLEAN_CONFIG_PATHS) {
    const source = out[section]
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue
    const target: Record<string, any> = { ...source }
    if (!(key in target)) continue
    const value = target[key]
    if (typeof value === "boolean") continue
    if (typeof value === "string") {
      const parsed = parseEnvBoolean(value)
      if (parsed !== undefined) {
        target[key] = parsed
        out[section] = target
        continue
      }
    }
    const fallback = (DEFAULT_CONFIG as Record<string, any>)[section]?.[key]
    console.warn(
      `[agentarts-dsh] ${section}.${key} expects a boolean, got ${JSON.stringify(value)}; using ${JSON.stringify(fallback)}`
    )
    if (typeof fallback === "boolean") target[key] = fallback
    else delete target[key]
    out[section] = target
  }
  return out as T
}

/** 应用环境变量层：单键环境变量（同名配置项）→ 占位符展开 → 布尔归一化 */
function applyEnvLayer<T extends Record<string, any>>(config: T): T {
  const withDirect = applyDirectEnvOverrides(config) as T
  const missing = new Set<string>()
  const expanded = expandEnvPlaceholders(withDirect, missing) as T
  if (missing.size > 0) {
    console.warn(`[agentarts-dsh] undefined env placeholder(s) kept as-is: ${[...missing].join(", ")}`)
  }
  // 占位符可能展开成 "true"/"false" 字符串，展开后再归一化
  return normalizeBooleanConfig(expanded as Record<string, any>) as T
}

/** 上报能力判定结果 */
export interface ReportingState {
  /** APM（trace）是否具备完整配置 */
  apmEnabled: boolean
  /** AOM（metric）是否具备完整配置 */
  aomEnabled: boolean
  /** 是否应该真正启用采集（enabled 且至少一路可用） */
  ready: boolean
  /** 声明启用但缺少必填项的描述，用于日志 */
  missing: string[]
}

/**
 * 判断当前配置是否真的能上报。
 *
 * `_enable` 为 true 但缺少必填项（端点/凭证）时不视为可用——
 * 否则插件会注册一堆钩子却永远发不出去，白白增加运行时开销。
 */
export function resolveReportingState(config: Record<string, any> | undefined): ReportingState {
  const otel = (config?.otel ?? {}) as Record<string, any>
  const missing: string[] = []

  const apmWanted = otel.agentarts_agentops_otel_agent_apm_enable === true
  const apmEnabled =
    apmWanted &&
    typeof otel.agentarts_agentops_apm_exporter_endpoint === "string" &&
    otel.agentarts_agentops_apm_exporter_endpoint !== "" &&
    typeof otel.agentarts_agentops_apm_token === "string" &&
    otel.agentarts_agentops_apm_token !== ""
  if (apmWanted && !apmEnabled) missing.push("APM (endpoint + token)")

  const aomWanted = otel.agentarts_agentops_otel_agent_aom_enable === true
  const aomEnabled =
    aomWanted &&
    typeof otel.agentarts_agentops_aom_exporter_endpoint === "string" &&
    otel.agentarts_agentops_aom_exporter_endpoint !== "" &&
    typeof otel.agentarts_agentops_aom_access_code === "string" &&
    otel.agentarts_agentops_aom_access_code !== "" &&
    typeof otel.agentarts_agentops_aom_prometheus_id === "string" &&
    otel.agentarts_agentops_aom_prometheus_id !== ""
  if (aomWanted && !aomEnabled) missing.push("AOM (endpoint + access code + prometheus id)")

  const enabled = config?.enabled !== false
  return { apmEnabled, aomEnabled, ready: enabled && (apmEnabled || aomEnabled), missing }
}

/**
 * 去掉 UTF-8 BOM（\uFEFF）。
 *
 * Windows 记事本等编辑器保存 UTF-8 时会写入 BOM，而 JSON.parse 不接受它；
 * 若不处理，整份配置会被当作解析失败并回退默认值，表现为"配置被清空"。
 */
function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 启动加载：解析失败或文件缺失时回退默认配置（保持原有行为）。
 */
export function loadConfig(configPath = CONFIG_PATH) {
  try {
    if (fs.existsSync(configPath)) {
      const content = stripBom(fs.readFileSync(configPath, "utf-8"))
      const userConfig = JSON.parse(stripJsonComments(content))
      return applyEnvLayer(mergeConfig(userConfig))
    }
  } catch (error) {
    console.warn("[agentarts-dsh] Failed to load config, using defaults:", error)
  }
  // 文件不存在时仍允许完全由环境变量提供配置
  return applyEnvLayer(DEFAULT_CONFIG)
}

/**
 * 严格读取（热重载用）：解析失败返回 error 而不落回默认配置，
 * 避免写入一半的文件被误当成「配置被清空」。
 */
export function readConfigStrict(configPath = CONFIG_PATH): { config?: Record<string, any>; error?: unknown } {
  let content: string
  try {
    content = stripBom(fs.readFileSync(configPath, "utf-8"))
  } catch (error) {
    return { error }
  }
  try {
    return { config: applyEnvLayer(mergeConfig(JSON.parse(stripJsonComments(content)))) }
  } catch (error) {
    return { error }
  }
}

// ── 拼写建议：Levenshtein 编辑距离 ─────────────────────────────────────
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Infinity
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/** 在候选键中找最近的已知键（长键容忍距离 2，短键 1；找不到返回 undefined） */
export function nearestKey(candidate: string, keys: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const key of keys) {
    const distance = editDistance(candidate, key)
    if (distance < bestDistance) {
      bestDistance = distance
      best = key
    }
  }
  if (best === undefined) return undefined
  const threshold = best.length >= 12 ? 2 : 1
  return bestDistance <= threshold ? best : undefined
}

function unknownKeyIssues(section: string, obj: Record<string, any>, knownKeys: readonly string[]): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  for (const key of Object.keys(obj)) {
    if (knownKeys.includes(key)) continue
    const suggestion = nearestKey(key, knownKeys)
    issues.push({
      field: `${section}.${key}`,
      message: suggestion
        ? `unknown config key (ignored); did you mean "${suggestion}"?`
        : `unknown config key (ignored)`
    })
  }
  return issues
}

/**
 * 校验配置（纯函数，无副作用）。返回告警列表；空数组表示配置有效。
 * 所有问题均为告警级：拼错字段静默失效是当前排障的最大痛点，这里集中提示。
 */
export function validateConfig(config: Record<string, any>): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  issues.push(...unknownKeyIssues("config", config, KNOWN_ROOT_KEYS))

  // ── 类型与取值检查（根字段） ──
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    issues.push({ field: "enabled", message: `expected boolean, got ${typeof config.enabled}` })
  }
  if (config.agent_name !== undefined && typeof config.agent_name !== "string") {
    issues.push({ field: "agent_name", message: `expected string, got ${typeof config.agent_name}` })
  }
  if (config.outputDir !== undefined && typeof config.outputDir !== "string") {
    issues.push({ field: "outputDir", message: `expected string, got ${typeof config.outputDir}` })
  }

  // ── features ──
  if (config.features !== undefined) {
    if (typeof config.features !== "object" || config.features === null) {
      issues.push({ field: "features", message: `expected object, got ${typeof config.features}` })
    } else {
      issues.push(...unknownKeyIssues("features", config.features, KNOWN_FEATURES_KEYS))
      for (const key of ["debug", "captureMessageContent", "linkSubagentTrace"]) {
        const value = config.features[key]
        if (value !== undefined && typeof value !== "boolean") {
          issues.push({ field: `features.${key}`, message: `expected boolean, got ${typeof value}` })
        }
      }
      const retention = config.features.logRetentionDays
      if (
        retention !== undefined &&
        (typeof retention !== "number" || !Number.isInteger(retention) || retention < 0)
      ) {
        issues.push({
          field: "features.logRetentionDays",
          message: `expected a non-negative integer, got ${JSON.stringify(retention)}`
        })
      }
    }
  }

  // ── 采集未开启时，otel 问题无运行意义 ──
  if (config.enabled === false) return issues

  // ── otel ──
  const otel = config.otel
  if (otel === undefined || otel === null) {
    issues.push({ field: "otel", message: "missing: no traces or metrics will be reported" })
    return issues
  }
  if (typeof otel !== "object") {
    issues.push({ field: "otel", message: `expected object, got ${typeof otel}` })
    return issues
  }
  issues.push(...unknownKeyIssues("otel", otel, KNOWN_OTEL_KEYS))

  for (const key of OTel_BOOLEAN_KEYS) {
    const value = otel[key]
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({ field: `otel.${key}`, message: `expected boolean, got ${typeof value}` })
    }
  }
  for (const key of KNOWN_OTEL_KEYS) {
    if ((OTel_BOOLEAN_KEYS as readonly string[]).includes(key)) continue
    const value = otel[key]
    if (value !== undefined && value !== null && typeof value !== "string") {
      issues.push({ field: `otel.${key}`, message: `expected string, got ${typeof value}` })
    }
  }

  // 上报地址不做校验：域名、IP、域名:端口、IP:端口、带 http/https 协议都可接受，
  // 由 otel-reporter 的 toGrpcUrl 统一归一化。强制某种格式只会挡住合法部署形态。

  const apmEnabled = otel.agentarts_agentops_otel_agent_apm_enable === true
  const aomEnabled = otel.agentarts_agentops_otel_agent_aom_enable === true
  if (!apmEnabled && !aomEnabled) {
    issues.push({
      field: "otel",
      message: "both agentarts_agentops_otel_agent_apm_enable and agentarts_agentops_otel_agent_aom_enable are off; nothing will be reported"
    })
  }
  if (apmEnabled) {
    const missing: string[] = []
    if (!otel.agentarts_agentops_apm_token) missing.push("agentarts_agentops_apm_token")
    if (!otel.agentarts_agentops_apm_exporter_endpoint) missing.push("agentarts_agentops_apm_exporter_endpoint")
    if (missing.length > 0) {
      issues.push({
        field: "otel",
        message: `APM (traces) is enabled but missing: ${missing.join(", ")}`
      })
    }
  }
  if (aomEnabled) {
    const missing: string[] = []
    if (!otel.agentarts_agentops_aom_access_code) missing.push("agentarts_agentops_aom_access_code")
    if (!otel.agentarts_agentops_aom_exporter_endpoint) missing.push("agentarts_agentops_aom_exporter_endpoint")
    if (!otel.agentarts_agentops_aom_prometheus_id) missing.push("agentarts_agentops_aom_prometheus_id")
    if (!otel.agentarts_project_id) missing.push("agentarts_project_id")
    if (missing.length > 0) {
      issues.push({
        field: "otel",
        message: `AOM (metrics) is enabled but missing: ${missing.join(", ")}`
      })
    }
  }
  // 已废弃的键：资源类型改由配置提供、资源版本取运行中的 DSH 版本，
  // 配置里写了也不会生效，提示用户删除
  for (const key of DEPRECATED_OTEL_KEYS) {
    if (otel[key] !== undefined) {
      issues.push({
        field: `otel.${key}`,
        message: "ignored: resource version uses the running DSH version; you can remove this key"
      })
    }
  }
  // 资源类型：可配置（新旧平台取值不同），只对未知取值告警
  if (typeof otel.resource_type === "string" && otel.resource_type !== "") {
    if (!(KNOWN_RESOURCE_TYPES as readonly string[]).includes(otel.resource_type)) {
      issues.push({
        field: "otel.resource_type",
        message: `unknown resource type "${otel.resource_type}"; known: ${KNOWN_RESOURCE_TYPES.join(" | ")}`
      })
    }
  } else if (otel.resource_type !== undefined) {
    issues.push({ field: "otel.resource_type", message: "empty: falling back to the default resource type" })
  }
  for (const key of ["agent_domain_id", "agentarts_project_id", "agent_resource_id"]) {
    if (otel[key] !== undefined && !otel[key]) {
      issues.push({ field: `otel.${key}`, message: "empty: the corresponding reported attribute will be blank" })
    }
  }
  return issues
}

/**
 * 监听配置文件变更（300ms 防抖）。仅在内容真正变化且解析成功时回调 onChange；
 * 解析失败回调 onError（保持当前配置不动）。返回停止函数。
 */
export function watchConfig(
  configPath: string,
  onChange: (nextConfig: Record<string, any>) => void,
  onError?: (error: unknown) => void
): () => void {
  let last = JSON.stringify(readConfigStrict(configPath).config ?? loadConfig(configPath))
  let timer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(configPath, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const { config, error } = readConfigStrict(configPath)
        if (error) {
          onError?.(error)
          return
        }
        const serialized = JSON.stringify(config)
        if (serialized === last) return
        last = serialized
        onChange(config!)
      }, 300)
    })
  } catch {
    // 文件不存在或平台不支持：不监听
    return () => {}
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}

export function resolveOutputDir(config: { outputDir: string }) {
  let outputDir = config.outputDir
  if (outputDir.startsWith("~")) {
    outputDir = path.join(os.homedir(), outputDir.slice(1))
  }
  if (process.platform === "win32") {
    const msysMatch = outputDir.match(/^\/+([a-zA-Z])\/(.*)$/)
    if (msysMatch) {
      outputDir = path.join(`${msysMatch[1].toUpperCase()}:\\`, msysMatch[2])
    } else {
      const driveMatch = outputDir.match(/^([a-zA-Z]):\/(.*)$/)
      if (driveMatch) {
        outputDir = path.join(`${driveMatch[1].toUpperCase()}:\\`, driveMatch[2])
      }
    }
  }
  return outputDir
}

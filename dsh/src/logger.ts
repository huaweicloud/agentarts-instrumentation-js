// 文件日志：输出到 <outputDir>/logs/plugin-YYYY-MM-DD.log（按日切分），
// 支持按天保留（retentionDays：删除更早的日志文件；0 关闭清理）。
import * as fs from "node:fs"
import * as path from "node:path"

let logsDir: string | null = null
let currentLogDate: string | null = null
let logFilePath: string | null = null
let debugEnabled = false
let logRetentionDays = 0

function localDate() {
  const now = new Date()
  const mo = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${mo}-${d}`
}

function refreshLogFile() {
  if (!logsDir) return
  const date = localDate()
  if (date !== currentLogDate) {
    currentLogDate = date
    logFilePath = path.join(logsDir, `plugin-${date}.log`)
    cleanupOldLogs()
  }
}

export function initLogger(dir: string, retentionDays = 0) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    logsDir = dir
    logRetentionDays = retentionDays
    refreshLogFile()
  } catch {
    // 忽略：日志目录创建失败时静默降级（仅 logger.warn 到 dsh 主日志）
  }
}

export function setDebugEnabled(enabled: boolean) {
  debugEnabled = enabled
}

export function setLogRetentionDays(days: number) {
  logRetentionDays = days
}

export function isDebugEnabled() {
  return debugEnabled
}

/** 删除超过保留天数的按日日志文件（plugin-YYYY-MM-DD.log）；失败静默 */
function cleanupOldLogs() {
  if (!logsDir || logRetentionDays <= 0) return
  try {
    const cutoff = Date.now() - logRetentionDays * 86_400_000
    const files = fs.readdirSync(logsDir)
    for (const file of files) {
      const m = file.match(/^plugin-(\d{4})-(\d{2})-(\d{2})\.log$/)
      if (!m) continue
      const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (Number.isFinite(fileDate) && fileDate < cutoff) {
        fs.promises.rm(path.join(logsDir, file), { force: true }).catch(() => {})
      }
    }
  } catch {
    // 清理失败不影响日志写入
  }
}

function localTimestamp() {
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  const h = String(now.getHours()).padStart(2, "0")
  const mi = String(now.getMinutes()).padStart(2, "0")
  const s = String(now.getSeconds()).padStart(2, "0")
  const ms = String(now.getMilliseconds()).padStart(3, "0")
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`
}

function formatArg(a: unknown) {
  if (a instanceof Error) return a.stack || a.message
  if (typeof a === "object") {
    return JSON.stringify(a).replace(/\\{2,}/g, "\\")
  }
  return String(a)
}

function appendLog(line: string) {
  if (!logsDir) return
  refreshLogFile()
  if (!logFilePath) return
  fs.promises.appendFile(logFilePath, line).catch(() => {})
}

export function log(...args: unknown[]) {
  if (!logsDir) return
  const message = args.map(formatArg).join(" ")
  appendLog(`[${localTimestamp()}] ${message}\n`)
}

export function logError(...args: unknown[]) {
  if (!logsDir) return
  const message = args.map(formatArg).join(" ")
  appendLog(`[${localTimestamp()}] [ERROR] ${message}\n`)
}

export function logDebug(...args: unknown[]) {
  if (!logsDir || !debugEnabled) return
  const message = args.map(formatArg).join(" ")
  appendLog(`[${localTimestamp()}] [DEBUG] ${message}\n`)
}

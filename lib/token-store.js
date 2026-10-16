/**
 * YUQUE_TOKEN 的解析、判定与落盘。
 *
 * 语雀 MCP 服务端要求进程环境里必须有 YUQUE_TOKEN（上游 \`cli.ts\` 缺令牌时直接 exit 1），
 * 所以「令牌从哪来」是本插件的第一等问题。解析优先级（高 → 低）：
 *
 *   1. profile 里 \`yuque-mcp\` 的 \`config.token\`（显式配置：CI、多账号、临时排查）
 *   2. 环境变量 \`YUQUE_TOKEN\` / \`YUQUE_PERSONAL_TOKEN\`（与上游 server.json 一致）
 *   3. 令牌文件（默认 \`$DSH_HOME/yuque-mcp/token.json\`，0600，由弹窗写入）
 *
 * 在没有真令牌时，插件用一个**占位令牌**先把服务端拉起来：上游只在启动时检查
 * 「有没有令牌」，\`tools/list\` 不需要鉴权，因此工具列表照常可见，等第一次真正调用
 * 语雀工具时再弹窗要令牌（见 lib/index.js 的 tools/execute 闸门）。
 *
 * 本模块是纯逻辑，不 import cordis，scripts/smoke.mjs 可直接单测。
 *
 * @module dsh-yuque-mcp/token-store
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 环境变量名，顺序即优先级。 */
export const TOKEN_ENV_NAMES = ['YUQUE_TOKEN', 'YUQUE_PERSONAL_TOKEN']

/** 令牌文件相对 \`$DSH_HOME\` 的位置。 */
export const TOKEN_FILE_RELATIVE = join('yuque-mcp', 'token.json')

/** 没有真令牌时喂给服务端的占位值；服务端启动不校验，工具列表因此始终可用。 */
export const PLACEHOLDER_TOKEN = 'dsh-yuque-mcp-pending-token'

/** 语雀令牌的长度区间（实测形如 \`yq_xxxxxxxx...\`，这里只做保守的范围校验）。 */
const MIN_TOKEN_LENGTH = 8
const MAX_TOKEN_LENGTH = 512

/** Harness home：优先 DSH_HOME，否则 ~/.dsh（与 dsh-unity-mcp 一致）。 */
export function dshHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** 默认令牌文件路径。 */
export function defaultTokenFile(env = process.env) {
  return join(dshHome(env), TOKEN_FILE_RELATIVE)
}

/**
 * 把用户/配置里的原始输入整理成令牌：
 * 去掉首尾空白与包裹引号、去掉误粘贴的 \`Bearer \` 前缀、去掉换行。
 *
 * @returns 规范化后的令牌；不像令牌时返回 undefined。
 */
export function normalizeToken(raw) {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/^bearer\s+/i, '').trim()
  value = value.replace(/\s+/g, '')
  return value === '' ? undefined : value
}

/** 令牌是否形似合法（长度区间 + 无内部空白，规范化后判断）。 */
export function isPlausibleToken(raw) {
  const value = normalizeToken(raw)
  if (value === undefined) return false
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) return false
  // 语雀令牌是可见 ASCII；中文/全角字符基本都是从别处粘错了
  return /^[\x21-\x7e]+$/.test(value)
}

/** 打码后的令牌，可安全写进日志与工具输出。 */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return ''
  if (token.length <= 10) return '*'.repeat(token.length)
  return token.slice(0, 4) + '…' + token.slice(-4)
}

/** 令牌文件是否就是占位值（说明还没拿到真令牌）。 */
export function isPlaceholderToken(token) {
  return normalizeToken(token) === PLACEHOLDER_TOKEN
}

/**
 * 读令牌文件。同时容忍两种格式：\`{"token": "..."}\` 或整份文件就是令牌。
 *
 * @returns \`{ path, exists, token, host, state }\`，state ∈ ok / missing / malformed / unreadable。
 */
export function readTokenFile(file) {
  const result = { path: file, exists: false, token: undefined, host: undefined, state: 'missing', error: undefined }
  if (typeof file !== 'string' || file === '') return result
  if (!existsSync(file)) return result
  result.exists = true
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    result.state = 'unreadable'
    result.error = String(error?.message ?? error)
    return result
  }
  const trimmed = text.trim()
  let token
  let host
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      token = parsed?.token
      host = typeof parsed?.host === 'string' ? parsed.host : undefined
    } catch (error) {
      result.state = 'malformed'
      result.error = 'JSON 解析失败：' + String(error?.message ?? error)
      return result
    }
  } else {
    token = trimmed
  }
  const normalized = normalizeToken(token)
  if (normalized === undefined) {
    result.state = 'malformed'
    result.error = '令牌为空'
    return result
  }
  if (!isPlausibleToken(normalized)) {
    result.state = 'malformed'
    result.error = '令牌格式不像语雀令牌（长度 ' + normalized.length + '）'
    result.token = normalized
    return result
  }
  result.token = normalized
  result.host = host
  result.state = 'ok'
  return result
}

/**
 * 写令牌文件（原子写 + 0600）。目录不存在时先建（0700）。
 *
 * @returns 写入后的路径。
 */
export function writeTokenFile(file, token, options = {}) {
  const normalized = normalizeToken(token)
  if (normalized === undefined) throw new Error('writeTokenFile: 令牌为空')
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  ensurePrivateDir(dir)
  const payload = {
    token: normalized,
    ...(typeof options.host === 'string' && options.host !== '' ? { host: options.host } : {}),
    updatedAt: new Date().toISOString(),
    note: '由 dsh-yuque-mcp 弹窗写入；删除本文件即等于清除令牌。',
  }
  const temp = file + '.' + process.pid + '.tmp'
  writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
  return file
}

/** 删除令牌文件（不存在也算成功）。 */
export function removeTokenFile(file) {
  if (typeof file !== 'string' || file === '') return false
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 按优先级解析令牌。
 *
 * @param options.explicit - \`config.token\`
 * @param options.env - 环境变量表
 * @param options.file - 令牌文件路径
 * @returns \`{ token, source, path, file, state, error }\`
 *   - \`token === undefined\` 表示没有可用令牌（占位/缺失/格式错都在 state 里说明）
 *   - source ∈ config / env:NAME / file / undefined
 */
export function resolveToken(options = {}) {
  const env = options.env ?? process.env
  const file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : defaultTokenFile(env)
  const fileRecord = readTokenFile(file)

  const explicit = normalizeToken(options.explicit)
  if (explicit !== undefined) {
    return {
      token: isPlausibleToken(explicit) ? explicit : undefined,
      source: 'config',
      path: file,
      file: fileRecord,
      state: isPlausibleToken(explicit) ? 'ok' : 'malformed',
      error: isPlausibleToken(explicit) ? undefined : 'config.token 不像语雀令牌',
    }
  }

  for (const name of TOKEN_ENV_NAMES) {
    const value = normalizeToken(env?.[name])
    if (value === undefined) continue
    return {
      token: isPlausibleToken(value) ? value : undefined,
      source: 'env:' + name,
      path: file,
      file: fileRecord,
      state: isPlausibleToken(value) ? 'ok' : 'malformed',
      error: isPlausibleToken(value) ? undefined : name + ' 不像语雀令牌',
    }
  }

  if (fileRecord.state === 'ok' && fileRecord.token !== undefined) {
    return { token: fileRecord.token, source: 'file', path: file, file: fileRecord, state: 'ok', error: undefined }
  }
  return {
    token: undefined,
    source: undefined,
    path: file,
    file: fileRecord,
    state: fileRecord.state === 'missing' ? 'missing' : fileRecord.state,
    error: fileRecord.error,
  }
}

/** 目录权限收紧到 0700（已存在时 chmod，失败忽略）。 */
function ensurePrivateDir(dir) {
  try {
    const mode = statSync(dir).mode & 0o777
    if (mode !== 0o700) chmodSync(dir, 0o700)
  } catch {
    /* 忽略：权限收紧是尽力而为 */
  }
}

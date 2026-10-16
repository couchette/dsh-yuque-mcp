/**
 * 语雀开放 API 的最小客户端：只做「令牌能不能用」这一件事。
 *
 * 为什么不复用内置服务端的 axios 客户端：插件跑在 Harness 进程里，只想知道
 * 令牌有效 / 失效 / 网络不通（三种结论对应三种完全不同的处置），因此直接打一次
 * \`GET /api/v2/user\`，用 HTTP 状态码判定，不引入任何依赖。
 *
 * @module dsh-yuque-mcp/yuque-api
 */

/** 语雀 SaaS 默认站点。 */
export const DEFAULT_HOST = 'https://www.yuque.com'

/** 校验结果状态。 */
export const VERIFY_STATES = ['ok', 'invalid', 'unreachable', 'unknown', 'skipped', 'unverified']

/**
 * 把「站点根 / API 根」统一成 API 根，规则与上游 \`src/config.ts\` 的
 * \`normalizeYuqueBaseURL\` 保持一致（含路径就用路径，不含就补 \`/api/v2\`）。
 */
export function normalizeBaseURL(host) {
  const raw = typeof host === 'string' ? host.trim() : ''
  if (raw === '') return DEFAULT_HOST + '/api/v2'
  const withoutTrailingSlash = raw.replace(/\/+$/, '')
  try {
    const url = new URL(withoutTrailingSlash)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (pathname === '') {
      url.pathname = '/api/v2'
      return url.toString().replace(/\/+$/, '')
    }
    return withoutTrailingSlash
  } catch {
    return withoutTrailingSlash
  }
}

/** 合并「超时信号」与「调用方信号」，任一触发即中断（Node 18 兼容，不依赖 AbortSignal.any）。 */
function combineSignals(signals) {
  const usable = signals.filter((signal) => signal !== undefined && signal !== null)
  if (usable.length === 0) return { signal: undefined, dispose: () => {} }
  if (usable.length === 1) return { signal: usable[0], dispose: () => {} }
  const controller = new AbortController()
  const onAbort = (event) => controller.abort(event?.target?.reason)
  for (const signal of usable) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of usable) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 校验令牌：打一次 \`GET {baseURL}/user\`。
 *
 * @param options.baseURL - 已规范化的 API 根（含 /api/v2）
 * @param options.token - 待校验令牌
 * @param options.timeoutMs - 超时（毫秒）
 * @param options.signal - 调用方取消信号
 * @param options.fetchImpl - 便于测试注入
 * @returns \`{ state, status, login, name, message, latencyMs, baseURL }\`
 *   state ∈ ok（令牌可用） / invalid（401、403） / unreachable（网络层失败）
 *          / unknown（其它状态码） / skipped（没有令牌，没发请求）
 */
export async function verifyToken(options) {
  const baseURL = typeof options.baseURL === 'string' && options.baseURL !== '' ? options.baseURL : normalizeBaseURL(options.host)
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const started = Date.now()

  if (token === '') {
    return { state: 'skipped', message: '没有令牌，未发起校验', latencyMs: 0, baseURL }
  }
  if (typeof doFetch !== 'function') {
    return { state: 'unknown', message: '运行环境没有 fetch，无法校验令牌', latencyMs: 0, baseURL }
  }

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs)
  const combined = combineSignals([timeout.signal, options.signal])
  try {
    const response = await doFetch(baseURL + '/user', {
      method: 'GET',
      headers: {
        'X-Auth-Token': token,
        Accept: 'application/json',
        'User-Agent': 'dsh-yuque-mcp',
      },
      signal: combined.signal,
    })
    const latencyMs = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { state: 'invalid', status: response.status, message: '令牌被语雀拒绝（HTTP ' + response.status + '）', latencyMs, baseURL }
    }
    if (!response.ok) {
      return { state: 'unknown', status: response.status, message: '语雀返回 HTTP ' + response.status, latencyMs, baseURL }
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    const user = payload?.data
    return {
      state: 'ok',
      status: response.status,
      login: typeof user?.login === 'string' ? user.login : undefined,
      name: typeof user?.name === 'string' ? user.name : undefined,
      message: '令牌可用',
      latencyMs,
      baseURL,
    }
  } catch (error) {
    const aborted = combined.signal?.aborted === true
    return {
      state: aborted && options.signal?.aborted === true ? 'skipped' : 'unreachable',
      message: aborted && options.signal?.aborted === true
        ? '调用已取消'
        : '无法连接语雀（' + String(error?.message ?? error) + '）',
      latencyMs: Date.now() - started,
      baseURL,
    }
  } finally {
    clearTimeout(timer)
    combined.dispose()
  }
}

/**
 * 令牌闸门：所有「调用语雀工具之前，先保证令牌可用」的策略都集中在这里。
 *
 * 为什么要单独一层：这段逻辑要在四种时机上做同一件事——首次调用、令牌失效（401）、
 * 用户主动换令牌（yuque_status）、并发调用——而它依赖的四个副作用（弹窗、在线校验、
 * 落盘、重挂服务端）都必须由插件主体提供。注入之后这段策略可以完全离线单测，
 * 见 scripts/smoke.mjs 的「令牌闸门」一节。
 *
 * 状态机（state）只由调用方持有：
 *   state.token        当前认为可用的令牌（可能是占位值）
 *   state.source       令牌来源：config / env:NAME / file / prompt
 *   state.verification 最近一次在线校验 \`{ state, token, at, ... }\`
 *   state.prompting    进行中的弹窗（并发去重）
 *
 * @module dsh-yuque-mcp/token-gate
 */

/** 网络层不通时的校验结论：不是令牌问题，因此不弹窗，直接放行让上游报真实错误。 */
const PASSTHROUGH_STATES = new Set(['unreachable', 'unknown', 'skipped', 'unverified'])

/**
 * @param deps.settings - 运行时设置（interactive / maxPromptAttempts / verifyCacheMs / ...）
 * @param deps.state - 可变状态对象（见模块注释）
 * @param deps.verify - \`async (token, signal) => verdict\`，打一次语雀接口
 * @param deps.saveToken - \`(token) => void\`，令牌落盘（失败应由调用方吞掉）
 * @param deps.ensureMounted - \`async (token) => void\`，确保服务端跑在该令牌上
 * @param deps.mountedToken - \`() => string | undefined\`，当前挂载用的令牌
 * @param deps.askUser - \`async ({ reason, attempt, exec }) => {kind:'token',token} | {kind:'declined'|'unavailable',message}\`
 * @param deps.isPlaceholder - \`(token) => boolean\`
 * @param deps.logger - 可选，cordis logger
 * @param deps.now - 可选，注入时钟（测试用）
 */
export function createTokenGate(deps) {
  const { settings, state } = deps
  const logger = deps.logger
  const now = deps.now ?? (() => Date.now())
  const isPlaceholder = deps.isPlaceholder ?? (() => false)

  /** 当前「像样的」令牌；占位值不算。 */
  function usableToken() {
    const token = state.token
    if (typeof token !== 'string' || token === '') return undefined
    return isPlaceholder(token) ? undefined : token
  }

  /** 缓存判定：同一令牌且未过期。 */
  function verdictFresh(token) {
    const verification = state.verification
    if (verification?.token !== token) return false
    if (!(settings.verifyCacheMs > 0)) return false
    return now() - (verification.at ?? 0) <= settings.verifyCacheMs
  }

  /** 打一次语雀接口并把结论写进 state。 */
  async function refresh(token, signal) {
    const verdict = await deps.verify(token, signal)
    state.verification = { ...verdict, token, at: now() }
    if (verdict.state === 'invalid') {
      logger?.warn?.('yuque-mcp: 令牌校验失败（' + verdict.message + '）')
    }
    return verdict
  }

  /**
   * 调用前保证「令牌可用且已挂载」。
   * @returns \`{ kind: 'ready', warning? }\` 或 \`{ kind: 'blocked', message }\`
   */
  async function ensureReady(exec) {
    const token = usableToken()
    if (token !== undefined) {
      const verdict = verdictFresh(token) ? state.verification : await refresh(token, exec?.signal)
      if (verdict.state === 'ok') {
        await deps.ensureMounted(token)
        return { kind: 'ready' }
      }
      if (verdict.state === 'invalid') {
        return acquire(exec, '语雀拒绝了当前令牌：' + (verdict.message ?? '令牌无效或已过期') + '。')
      }
      // 网络层问题：放行，让上游给出真实报错
      await deps.ensureMounted(token)
      return PASSTHROUGH_STATES.has(verdict.state) ? { kind: 'ready', warning: verdict.message } : { kind: 'ready' }
    }
    return acquire(exec, '还没有配置语雀令牌（YUQUE_TOKEN）。')
  }

  /**
   * 弹窗索取令牌 → 在线校验 → 落盘 → 重挂。
   * 并发调用共用一个进行中的弹窗（state.prompting）。
   */
  async function acquire(exec, reason) {
    if (state.prompting !== undefined) return state.prompting
    const task = (async () => {
      let why = reason
      for (let attempt = 1; attempt <= settings.maxPromptAttempts; attempt++) {
        const asked = await deps.askUser({ reason: why, attempt, exec })
        if (asked?.kind === 'unavailable') return { kind: 'blocked', message: asked.message }
        if (asked?.kind === 'declined') return { kind: 'blocked', message: asked.message }
        if (asked?.kind !== 'token') return { kind: 'blocked', message: '没有拿到令牌。' }

        const verdict = await deps.verify(asked.token, exec?.signal)
        const accepted = verdict.state === 'ok' || verdict.state === 'unreachable' || verdict.state === 'unknown'
        if (accepted) {
          deps.saveToken(asked.token)
          state.token = asked.token
          state.source = 'prompt'
          state.verification = { ...verdict, token: asked.token, at: now() }
          await deps.ensureMounted(asked.token)
          if (verdict.state === 'ok') {
            logger?.info?.(
              'yuque-mcp: 令牌校验通过' + (verdict.login === undefined ? '' : '（用户 ' + verdict.login + '）'),
            )
          } else {
            logger?.warn?.('yuque-mcp: 收到令牌但暂时无法校验（' + verdict.message + '），先按可用处理')
          }
          return { kind: 'ready', saved: true, verdict }
        }
        why = '刚才这个令牌不可用（' + (verdict.message ?? '校验失败') + '）。'
      }
      return { kind: 'blocked', message: '连续 ' + settings.maxPromptAttempts + ' 次提供的令牌都无法通过校验。' }
    })()
    state.prompting = task
    try {
      return await task
    } finally {
      state.prompting = undefined
    }
  }

  return { ensureReady, acquire, refresh, verdictFresh, usableToken, mountedToken: () => deps.mountedToken() }
}

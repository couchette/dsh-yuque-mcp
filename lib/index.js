/**
 * dsh-yuque-mcp —— DeepSeek Harness × 语雀（Yuque）知识库桥接插件。
 *
 * 工作方式：
 *
 *   DSH Agent ──MCP(stdio)──> 内置 yuque-mcp 服务端 ──HTTPS──> 语雀开放 API
 *                                   ▲
 *                    YUQUE_TOKEN / YUQUE_HOST（由本插件注入）
 *
 * 相比「自己写一个 mcpServers 配置跑 npx yuque-mcp」，本插件只多解决一件事：
 * **令牌从哪来、坏了怎么办**。上游在缺令牌时直接 exit 1，MCP 客户端只会看到
 * 「服务端起不来」；这里把它变成可自助修复的闭环：
 *
 * 1. 令牌三级解析：\`config.token\` → 环境变量 \`YUQUE_TOKEN\` / \`YUQUE_PERSONAL_TOKEN\`
 *    → 令牌文件（默认 \`$DSH_HOME/yuque-mcp/token.json\`，0600）。
 * 2. 没有真令牌时用**占位令牌**先把服务端拉起来（上游只在启动时检查「有没有令牌」，
 *    \`tools/list\` 不需要鉴权），因此 \`mcp__yuque__*\` 工具列表始终可见；
 *    等第一次真正调用语雀工具时，由 \`tools/execute\` 闸门做一次在线校验，
 *    校验不过就**弹窗**（\`ctx.userQuestions\`）让用户粘贴令牌，校验通过后落盘并
 *    热替换 mcp-client，让同一次调用直接用上新令牌。
 * 3. 令牌中途失效（工具返回 401）由 \`tools/post-execute\` 捕获并标记失效，
 *    下一次调用重新弹窗——用户不需要知道令牌文件在哪。
 * 4. \`yuque_status\` 提供随时可用的诊断与手动重填入口（对 Agent 与人都可读）。
 *
 * 令牌策略本身在 lib/token-gate.js（可离线单测），本文件只做 DSH 侧的接线。
 *
 * @module dsh-yuque-mcp
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as defaultMcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  PLACEHOLDER_TOKEN,
  TOKEN_ENV_NAMES,
  defaultTokenFile,
  isPlaceholderToken,
  isPlausibleToken,
  maskToken,
  normalizeToken,
  readTokenFile,
  resolveToken,
  writeTokenFile,
} from './token-store.js'
import { createTokenGate } from './token-gate.js'
import { normalizeBaseURL, verifyToken } from './yuque-api.js'

/** 内置（vendored）yuque-mcp 服务端目录与入口。 */
const SERVER_DIR = fileURLToPath(new URL('../vendor/yuque-mcp-server/', import.meta.url))
const SERVER_ENTRY = join(SERVER_DIR, 'build', 'index.js')
/** 内置服务端版本（读打包时保留的上游 package.json）。 */
const SERVER_VERSION = readServerVersion()

/** 本插件注册的本地诊断工具名（不带 mcp__ 前缀）。 */
export const STATUS_TOOL_NAME = 'yuque_status'
/** cordis 插件名。 */
export const name = 'yuque-mcp'
/** 需要工具注册服务（自身注册 yuque_status；子客户端 mcp-client 也依赖它）。 */
export const inject = ['tools']

/**
 * 上游服务端暴露的工具名（v1.0.0 与 main 一致，共 19 个）。
 * 用途：重挂 mcp-client 后轮询「注册好了没」，以及 yuque_status 的工具清单。
 */
export const UPSTREAM_TOOL_NAMES = [
  'yuque_get_user',
  'yuque_list_books', 'yuque_get_book', 'yuque_create_book', 'yuque_update_book',
  'yuque_list_docs', 'yuque_get_doc', 'yuque_create_doc', 'yuque_update_doc',
  'yuque_get_toc', 'yuque_update_toc',
  'yuque_search',
  'yuque_list_notes', 'yuque_get_note', 'yuque_create_note', 'yuque_update_note',
  'yuque_get_resource', 'yuque_create_resource', 'yuque_update_resource',
]

/** 语雀鉴权失败的文本特征（覆盖上游 YUQUE_TOKEN / YUQUE_PERSONAL_TOKEN 两代文案）。 */
const AUTH_FAILURE_PATTERN = /(401|403|unauthorized|forbidden|invalid or expired|令牌|鉴权)/i

/** 默认重连策略：与 dsh-unity-mcp 保持一致（指数退避 1s → 30s，10 次）。 */
const DEFAULT_RECONNECT = { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 }

/**
 * mcp-client 模块（可被测试替换）。
 * 生产路径永远是官方 \`@deepseek-ai/dsh-mcp-client\`；scripts/smoke.mjs 用替身
 * 验证「挂载 → 换令牌 → 重挂」的时序，不需要真的拉起子进程。
 */
let mcpClientModule = defaultMcpClient

/** 仅供 scripts/smoke.mjs 注入 mcp-client 替身；返回旧的模块以便还原。 */
export function setMcpClientForTesting(module) {
  const previous = mcpClientModule
  mcpClientModule = module ?? defaultMcpClient
  return previous
}

/** 配置 schema：非法值在插件加载期直接报错，而不是带病运行。 */
export const Config = z.object({
  /** MCP 工具命名空间，工具名形如 mcp__yuque__yuque_list_docs。 */
  serverName: z.string().default('yuque'),
  /** 显式指定令牌（优先级最高；适合 CI / 多账号，注意它会进 profile 配置文件）。 */
  token: z.string().default(''),
  /** 语雀站点或 API 根，例如 https://www.yuque.com、https://your-space.yuque.com。留空用默认站点。 */
  host: z.string().default(''),
  /** 令牌文件路径；留空用 \`$DSH_HOME/yuque-mcp/token.json\`。 */
  tokenFile: z.string().default(''),
  /** 单次 MCP 工具调用超时（毫秒）。 */
  toolCallTimeoutMs: z.number().min(1).default(60000),
  /** 在线校验令牌的超时（毫秒）。 */
  verifyTimeoutMs: z.number().min(100).default(8000),
  /** 校验结果缓存时长（毫秒）：缓存期内不再重复打语雀接口。 */
  verifyCacheMs: z.number().min(0).default(60000),
  /** 是否允许在令牌缺失/失效时弹窗。关掉后只报错，不打扰用户（headless / CI）。 */
  interactive: z.boolean().default(true),
  /** 单次「弹窗 → 校验」最多重试几轮（用户连续贴错时不会无限问）。 */
  maxPromptAttempts: z.number().step(1).min(1).max(5).default(3),
  /** 重挂 mcp-client 后等待工具注册的上限（毫秒）。 */
  remountTimeoutMs: z.number().min(100).default(20000),
  /** 传给服务端进程的额外环境变量，可覆盖 YUQUE_HOST 等；同名覆盖默认注入。 */
  env: z.dict(String).default({}),
  /** 覆盖启动服务端所用的 Node 可执行文件；留空用当前进程（Electron 下自动加 ELECTRON_RUN_AS_NODE）。 */
  nodePath: z.string().default(''),
  /** 重连策略（语雀侧限流/网络抖动导致的断连会自动恢复）。 */
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      initialDelayMs: z.number().min(1).default(1000),
      maxDelayMs: z.number().min(1).default(30000),
      maxAttempts: z.number().min(1).default(10),
    })
    .default(DEFAULT_RECONNECT),
})

/**
 * 挂载插件：解析令牌 → 拉起内置服务端 → 注册 yuque_status 与令牌闸门。
 *
 * @param ctx - cordis 上下文。
 * @param config - 经 Config 校验/补全后的配置。
 */
export async function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const state = {
    /** 当前认为可用的令牌（可能是占位值）。 */
    token: undefined,
    /** 令牌来源：config / env:NAME / file / prompt。 */
    source: undefined,
    /** 最近一次在线校验结果 \`{ state, token, at, ... }\`。 */
    verification: { state: 'unverified', at: 0 },
    /** 当前挂载的 mcp-client：\`{ token, fiber }\`。 */
    mounted: undefined,
    /** 进行中的弹窗（并发去重），由 token-gate 读写。 */
    prompting: undefined,
  }

  const resolved = resolveToken({ explicit: settings.explicitToken, env: process.env, file: settings.tokenFile })
  state.token = resolved.token
  state.source = resolved.source
  settings.resolution = resolved

  const gate = createTokenGate({
    settings,
    state,
    logger: ctx.logger,
    isPlaceholder: isPlaceholderToken,
    mountedToken: () => state.mounted?.token,
    verify: (token, signal) => verifyToken({
      baseURL: settings.baseURL,
      token,
      timeoutMs: settings.verifyTimeoutMs,
      signal,
    }),
    saveToken: (token) => {
      try {
        writeTokenFile(settings.tokenFile, token, { host: settings.host })
      } catch (error) {
        ctx.logger?.warn?.('yuque-mcp: 令牌落盘失败（' + describeError(error) + '），本次会话内仍然可用')
      }
    },
    ensureMounted: async (token) => {
      if (state.mounted !== undefined && state.mounted.token === token) return
      await remountClient(ctx, settings, state, token)
    },
    askUser: (request) => askUserForToken(ctx, settings, request),
  })

  const initialToken = resolved.token ?? PLACEHOLDER_TOKEN
  await mountClient(ctx, settings, state, initialToken)

  ctx.tools.register(buildStatusTool(ctx, settings, state, gate))
  registerTokenGate(ctx, settings, state, gate)

  const summary = resolved.token === undefined
    ? '尚无可用令牌（' + describeResolution(resolved) + '），首次调用 mcp__' + settings.serverName + '__* 时会弹窗索取。'
    : '令牌来源：' + resolved.source + '（' + maskToken(resolved.token) + '）。'
  ctx.logger?.info?.(
    'yuque-mcp: 内置 yuque-mcp 服务端 ' + SERVER_VERSION + '，站点 ' + settings.baseURL + '；' + summary,
  )

  // 有真令牌就顺手后台校验一次，让首次工具调用的延迟低一点（失败不影响加载）。
  if (resolved.token !== undefined) {
    void gate.refresh(resolved.token, undefined).catch(() => {})
  }

  // 给 scripts/smoke.mjs 留一个只读探针：cordis 不消费 apply 的返回值，
  // 生产路径也不会读它，但测试需要断言内部状态（令牌来源、校验结论、挂载令牌）。
  __testing.last = { settings, state, gate }
}

/** 仅供 scripts/smoke.mjs 读取最近一次 apply 的内部状态；生产路径不使用。 */
export const __testing = { last: undefined }

/** 把配置整理成运行时设置（含 host 规范化与默认令牌文件路径）。 */
function resolveSettings(config) {
  const explicitToken = normalizeToken(config.token)
  const host = firstString(config.host) ?? firstString(process.env.YUQUE_HOST) ?? ''
  return {
    serverName: config.serverName ?? 'yuque',
    explicitToken,
    host,
    baseURL: normalizeBaseURL(host === '' ? undefined : host),
    tokenFile: firstString(config.tokenFile) ?? defaultTokenFile(process.env),
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60000,
    verifyTimeoutMs: config.verifyTimeoutMs ?? 8000,
    verifyCacheMs: config.verifyCacheMs ?? 60000,
    interactive: config.interactive !== false,
    maxPromptAttempts: config.maxPromptAttempts ?? 3,
    remountTimeoutMs: config.remountTimeoutMs ?? 20000,
    env: config.env ?? {},
    reconnect: config.reconnect ?? DEFAULT_RECONNECT,
    nodePath: firstString(config.nodePath),
    resolution: undefined,
  }
}

// ────────────────────────────── mcp-client 挂载 ──────────────────────────────

/** 组装 mcp-client 子插件配置；令牌只走进程环境，不写进任何配置或日志。 */
function clientSpec(settings, token) {
  const env = {
    // 两个名字都给：上游 main 认 YUQUE_TOKEN，tag v1.0.0 只认 YUQUE_PERSONAL_TOKEN
    YUQUE_TOKEN: token,
    YUQUE_PERSONAL_TOKEN: token,
  }
  if (settings.host !== '') env.YUQUE_HOST = settings.host
  // Electron 宿主里 process.execPath 是 Electron 本体，必须显式声明按 Node 运行
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'

  return {
    transport: 'stdio',
    serverName: settings.serverName,
    command: settings.nodePath ?? process.execPath,
    args: [SERVER_ENTRY],
    env: { ...env, ...settings.env },
    cwd: SERVER_DIR,
    toolCallTimeoutMs: settings.toolCallTimeoutMs,
    failOnStartupError: false,
    reconnect: settings.reconnect,
  }
}

/** 首次挂载：等一小会儿工具注册；失败只告警（闸门与 yuque_status 仍可救场）。 */
async function mountClient(ctx, settings, state, token) {
  if (!existsSync(SERVER_ENTRY)) {
    ctx.logger?.error?.('yuque-mcp: 内置服务端缺失：' + SERVER_ENTRY + '（请先执行 node scripts/vendor-server.mjs）')
    return false
  }
  try {
    const fiber = ctx.plugin(mcpClientModule, clientSpec(settings, token))
    state.mounted = { token, fiber }
    // 加载期不赌满 remountTimeoutMs：服务端起不来时最多拖 8s，剩下的交给闸门与 yuque_status
    const ready = await waitForTools(ctx, settings, Math.min(settings.remountTimeoutMs, 8000))
    if (!ready) {
      ctx.logger?.warn?.('yuque-mcp: 内置服务端尚未注册工具（等 ' + settings.remountTimeoutMs + 'ms 超时）')
    }
    return ready
  } catch (error) {
    ctx.logger?.error?.('yuque-mcp: 挂载内置服务端失败：' + describeError(error))
    return false
  }
}

/**
 * 换令牌：先拆旧挂载再挂新的，然后等新工具注册完成。
 *
 * 期间同名的 \`mcp__<serverName>__*\` 工具会短暂消失又回来——调用方（tools/execute 闸门）
 * 正是在 \`next()\` 之前等这里返回，所以同一次调用能直接用上新令牌。
 */
async function remountClient(ctx, settings, state, token) {
  const previous = state.mounted
  ctx.logger?.info?.('yuque-mcp: 用新令牌重新挂载内置服务端（' + maskToken(token) + '）')
  try {
    if (previous !== undefined) await previous.fiber?.dispose?.()
  } catch (error) {
    ctx.logger?.warn?.('yuque-mcp: 卸载旧服务端失败：' + describeError(error))
  }
  const ok = await mountClient(ctx, settings, state, token)
  if (!ok) ctx.logger?.warn?.('yuque-mcp: 新服务端未在 ' + settings.remountTimeoutMs + 'ms 内就绪')
  return ok
}

/** 工具命名空间前缀。 */
function toolPrefix(settings) {
  return 'mcp__' + settings.serverName + '__'
}

/** 轮询等待任意一个内置工具重新出现（重挂后的就绪判据）。 */
async function waitForTools(ctx, settings, timeoutMs, signal) {
  const prefix = toolPrefix(settings)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const name of UPSTREAM_TOOL_NAMES) {
      if (ctx.tools?.get?.(prefix + name) !== undefined) return true
    }
    if (Date.now() >= deadline) return false
    if (signal?.aborted === true) return false
    await delay(100)
  }
}

// ────────────────────────────── 令牌闸门 ──────────────────────────────

/** 注册 \`tools/execute\`（调用前保证令牌可用）与 \`tools/post-execute\`（401 识别）。 */
function registerTokenGate(ctx, settings, state, gate) {
  const prefix = toolPrefix(settings)

  ctx.on('tools/execute', async (exec, next) => {
    if (typeof exec?.name !== 'string' || !exec.name.startsWith(prefix)) return next()
    let readiness
    try {
      readiness = await gate.ensureReady(exec)
    } catch (error) {
      // 自检本身出问题不应该拦住工具调用：放行，让上游给出真实错误
      ctx.logger?.warn?.('yuque-mcp: 令牌自检失败：' + describeError(error))
      readiness = { kind: 'ready' }
    }
    if (readiness.kind === 'blocked') return blockedResult(exec.name, readiness.message, settings)
    return next()
  })

  ctx.on('tools/post-execute', (exec, result, next) => {
    if (typeof exec?.name === 'string' && exec.name.startsWith(prefix) && result?.isError === true) {
      const text = contentText(result.content)
      if (AUTH_FAILURE_PATTERN.test(text)) {
        state.verification = {
          state: 'invalid',
          token: state.token,
          at: Date.now(),
          message: '语雀接口返回鉴权失败：' + text.slice(0, 200),
        }
        ctx.logger?.warn?.('yuque-mcp: 检测到鉴权失败，下次调用会重新索取令牌')
      }
    }
    return next()
  })
}

/** 弹窗本体：通过 ctx.userQuestions 问用户要令牌（UI 上是输入框 + 选项）。 */
async function askUserForToken(ctx, settings, request) {
  const { reason, attempt, exec } = request
  if (!settings.interactive) {
    return { kind: 'unavailable', message: '已关闭交互式弹窗（interactive: false）。' }
  }
  const userQuestions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
  if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
    return { kind: 'unavailable', message: '当前运行环境没有用户问答服务（ctx.userQuestions），无法弹窗。' }
  }
  if (exec?.agent === undefined) {
    return { kind: 'unavailable', message: '本次调用没有 Agent 上下文，无法弹窗。' }
  }

  let answer
  try {
    answer = await userQuestions.ask({
      questions: [{
        id: 'yuque_token',
        header: '语雀 YUQUE_TOKEN',
        question: [
          attempt > 1 ? '（第 ' + attempt + ' 次）' + reason : reason,
          '',
          '请粘贴语雀个人令牌：语雀 → 头像 → 账号设置 → 令牌 → 新建（权限勾「读取」即可）。',
          '把令牌粘贴到下方输入框后提交；令牌会保存到 ' + settings.tokenFile + '（仅本机，权限 0600）。',
        ].join('\n'),
        options: [
          { label: '暂时不用语雀', description: '跳过本次；之后再次调用语雀工具时还会询问。' },
        ],
      }],
      agent: exec.agent,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    })
  } catch (error) {
    const code = error?.code
    if (code === 'NO_PROVIDER') {
      return {
        kind: 'unavailable',
        message: '当前会话没有可用的问答通道（headless / 无 UI），请在启动前设置 ' + TOKEN_ENV_NAMES[0] + '。',
      }
    }
    if (code === 'ASK_ABORTED' || exec?.signal?.aborted === true) {
      return { kind: 'declined', message: '用户取消了令牌输入。' }
    }
    if (code === 'DELEGATED_CALLER') {
      return { kind: 'unavailable', message: '当前是子 Agent，无法直接向用户提问。' }
    }
    return { kind: 'unavailable', message: '弹窗失败：' + describeError(error) }
  }

  const token = pickToken(answer)
  if (token === undefined) return { kind: 'declined', message: '用户没有提供语雀令牌。' }
  return { kind: 'token', token }
}

/** 从问答结果里取出令牌：优先自由输入，其次被选中的选项文本。 */
export function pickToken(answer) {
  for (const item of answer?.answers ?? []) {
    const custom = normalizeToken(item?.custom)
    if (custom !== undefined && isPlausibleToken(custom)) return custom
    for (const label of item?.selected ?? []) {
      const value = normalizeToken(label)
      if (value !== undefined && isPlausibleToken(value)) return value
    }
  }
  return undefined
}

/** 闸门拦下调用时给模型的错误结果（附可执行的修复路径）。 */
function blockedResult(toolName, message, settings) {
  const text = [
    'Error: ' + toolName + ' 未执行 —— 语雀令牌（YUQUE_TOKEN）不可用：' + message,
    '',
    '可选修复方式（任选其一，改完重试）：',
    '1) 让用户在弹窗里粘贴令牌（推荐，自动保存到 ' + settings.tokenFile + '）；',
    '2) 启动 Harness 前设置环境变量 ' + TOKEN_ENV_NAMES[0] + '；',
    '3) 在 profile 的 cordis.patch.yml 里给 yuque-mcp 配置 token；',
    '4) 调用 ' + STATUS_TOOL_NAME + '（prompt: true）主动触发一次令牌弹窗。',
    '',
    '令牌获取：语雀 → 头像 → 账号设置 → 令牌 → 新建（权限勾「读取」即可）。',
  ].join('\n')
  return {
    isError: true,
    error: { message: '语雀令牌不可用：' + message },
    content: [{ type: 'text', text }],
  }
}

// ────────────────────────────── yuque_status ──────────────────────────────

/** 组装 yuque_status 工具定义。 */
function buildStatusTool(ctx, settings, state, gate) {
  return defineTool({
    name: STATUS_TOOL_NAME,
    description:
      '诊断语雀（Yuque）集成：报告令牌来源与在线校验结果、站点地址、内置服务端版本与工具清单。'
      + '令牌缺失或失效时本工具会弹窗让用户粘贴 YUQUE_TOKEN（默认行为）。'
      + '调用任何 mcp__' + settings.serverName + '__* 工具之前先调用它；也可以用它换令牌（prompt: true）。',
    parameters: {
      prompt: {
        type: 'boolean',
        description: '不传：令牌缺失/失效时才弹窗；true：无论当前令牌是否可用都弹窗重填；false：只诊断，不弹窗。',
      },
      verify: {
        type: 'boolean',
        description: '是否打一次语雀接口做在线校验。默认 true；false 时只报告本地状态（不发网络请求）。',
      },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    // 弹窗要等人输入，给足预算（上层工具超时仍可能更早中止）
    timeoutMs: Math.max(10 * 60 * 1000, settings.verifyTimeoutMs + 1000),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const promptMode = args?.prompt
      const doVerify = args?.verify !== false
      let prompted

      if (promptMode === true) {
        prompted = await gate.acquire(exec, '用户要求重新填写语雀令牌。')
      } else if (promptMode === undefined) {
        const current = gate.usableToken()
        if (current === undefined) {
          prompted = await gate.acquire(exec, '还没有配置语雀令牌（YUQUE_TOKEN）。')
        } else if (doVerify) {
          const verdict = await gate.refresh(current, exec?.signal)
          if (verdict.state === 'invalid') {
            prompted = await gate.acquire(exec, '语雀拒绝了当前令牌：' + (verdict.message ?? '') + '。')
          }
        }
      }

      const current = state.token
      const usable = typeof current === 'string' && current !== '' && !isPlaceholderToken(current)
      if (doVerify && usable && state.verification?.token !== current) {
        await gate.refresh(current, exec?.signal)
      }

      const verification = state.verification ?? {}
      const mounted = state.mounted
      return prune({
        token: {
          state: usable ? 'present' : 'missing',
          source: state.source ?? settings.resolution?.source ?? 'none',
          path: settings.tokenFile,
          fileExists: existsSync(settings.tokenFile),
          fileState: readTokenFile(settings.tokenFile).state,
          masked: maskToken(current ?? ''),
          placeholder: isPlaceholderToken(current ?? ''),
        },
        verify: doVerify
          ? {
            state: verification.state ?? 'unverified',
            httpStatus: verification.status,
            login: verification.login,
            name: verification.name,
            message: verification.message,
            latencyMs: verification.latencyMs,
            checkedAt: verification.at === undefined || verification.at === 0
              ? undefined
              : new Date(verification.at).toISOString(),
          }
          : { state: 'skipped', message: '按参数要求跳过了在线校验' },
        server: {
          name: 'yuque-mcp',
          version: SERVER_VERSION,
          entry: SERVER_ENTRY,
          serverName: settings.serverName,
          toolPrefix: toolPrefix(settings),
          toolCount: UPSTREAM_TOOL_NAMES.length,
          tools: UPSTREAM_TOOL_NAMES,
          mounted: mounted !== undefined,
          mountedTokenMasked: maskToken(mounted?.token ?? ''),
          host: settings.host === '' ? undefined : settings.host,
          baseURL: settings.baseURL,
        },
        prompt: prompted === undefined
          ? undefined
          : {
            kind: prompted.kind,
            saved: prompted.saved === true,
            message: prompted.message,
          },
        hints: hintsFor({ settings, state, usable, prompted, verification }),
      })
    },
  })
}

/** 面向 Agent 的下一步建议：只给可执行的结论。 */
function hintsFor(input) {
  const { settings, state, usable, prompted, verification } = input
  const hints = []
  if (!usable) {
    hints.push(
      '没有可用的语雀令牌：请让用户在弹窗里粘贴，或设置环境变量 ' + TOKEN_ENV_NAMES[0]
      + '，或在 profile 的 cordis.patch.yml 里给 yuque-mcp 配置 token。'
    )
  }
  if (prompted?.kind === 'blocked') {
    hints.push('弹窗没有拿到可用令牌：' + prompted.message + '在用户处理之前，不要重复调用语雀工具。')
  }
  if (verification?.state === 'unreachable') {
    hints.push('连不上语雀（' + (verification.message ?? '') + '）：检查网络/代理后重试；这不是令牌问题。')
  }
  if (verification?.state === 'ok') {
    hints.push(
      '令牌可用' + (verification.login === undefined ? '' : '（用户 ' + verification.login + '）')
      + '，可以直接调用 mcp__' + settings.serverName + '__* 工具。'
    )
  }
  if (state.mounted === undefined) {
    hints.push(
      '内置服务端未挂载：请检查 ' + SERVER_ENTRY + ' 是否存在（缺失时执行 node scripts/vendor-server.mjs 重新打包）。'
    )
  }
  if (hints.length === 0) hints.push('一切正常：可以直接调用 mcp__' + settings.serverName + '__* 工具。')
  return hints
}

/** 渲染成给模型看的中文摘要。 */
function renderStatus(value) {
  const lines = []
  const token = value.token
  lines.push(
    '令牌：' + (token.state === 'present' ? '已配置' : '未配置')
    + (token.masked !== '' ? '（' + token.masked + '）' : '')
    + '，来源 ' + token.source
    + '，文件 ' + token.path + (token.fileExists ? '（存在，' + token.fileState + '）' : '（不存在）')
  )
  const verify = value.verify
  const verifyText = verify.state === 'ok'
    ? '可用' + (verify.login === undefined ? '' : '（' + (verify.name ?? '') + ' / ' + verify.login + '）')
    : verify.state === 'invalid'
      ? '被拒绝（HTTP ' + (verify.httpStatus ?? '?') + '）'
      : verify.state === 'unreachable'
        ? '无法连接语雀'
        : verify.state === 'skipped'
          ? '已跳过'
          : verify.state
  lines.push(
    '校验：' + verifyText + (verify.message === undefined ? '' : ' - ' + verify.message)
    + (verify.latencyMs === undefined ? '' : '（' + verify.latencyMs + ' ms）')
  )
  const server = value.server
  lines.push('站点：' + server.baseURL + (server.host === undefined ? '（默认站点）' : ''))
  lines.push(
    '服务端：内置 yuque-mcp ' + server.version + '，已挂载 ' + server.toolCount + ' 个工具'
    + '（' + server.toolPrefix + '*）' + (server.mounted ? '' : '，当前未挂载')
  )
  if (value.prompt !== undefined) {
    lines.push(
      '弹窗：' + value.prompt.kind + (value.prompt.saved === true ? '（已保存令牌）' : '')
      + (value.prompt.message === undefined ? '' : ' - ' + value.prompt.message)
    )
  }
  for (const hint of value.hints ?? []) lines.push('- ' + hint)
  return lines.join('\n')
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    token: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        state: { type: 'string', required: true, description: 'present / missing。' },
        source: { type: 'string', required: true, description: 'config / env:NAME / file / prompt / none。' },
        path: { type: 'string', required: true, description: '令牌文件路径。' },
        fileExists: { type: 'boolean', required: true },
        fileState: { type: 'string', required: true, description: 'ok / missing / malformed / unreadable。' },
        masked: { type: 'string', required: true, description: '打码后的令牌。' },
        placeholder: { type: 'boolean', required: true, description: 'true 表示当前跑在占位令牌上。' },
      },
    },
    verify: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        state: {
          type: 'string',
          required: true,
          description: 'ok / invalid / unreachable / unknown / skipped / unverified。',
        },
        httpStatus: { type: 'number' },
        login: { type: 'string' },
        name: { type: 'string' },
        message: { type: 'string' },
        latencyMs: { type: 'number' },
        checkedAt: { type: 'string' },
      },
    },
    server: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        name: { type: 'string', required: true },
        version: { type: 'string', required: true },
        entry: { type: 'string', required: true },
        serverName: { type: 'string', required: true },
        toolPrefix: { type: 'string', required: true },
        toolCount: { type: 'number', required: true },
        tools: { type: 'array', required: true, items: { type: 'string' } },
        mounted: { type: 'boolean', required: true },
        mountedTokenMasked: { type: 'string', required: true },
        host: { type: 'string' },
        baseURL: { type: 'string', required: true },
      },
    },
    prompt: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, description: 'ready / blocked。' },
        saved: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    hints: { type: 'array', required: true, items: { type: 'string' } },
  },
}

// ────────────────────────────── 小工具 ──────────────────────────────

/** 读取内置服务端版本（vendor/yuque-mcp-server/package.json）。 */
function readServerVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
  } catch {
    /* 落到兜底常量 */
  }
  return '1.0.0'
}

/** 拼接结果里的纯文本（用于识别鉴权失败）。 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** 令牌解析结果的一句话描述。 */
function describeResolution(resolved) {
  if (resolved.state === 'malformed') return '令牌格式不对：' + (resolved.error ?? resolved.state)
  if (resolved.file?.state === 'unreadable') return '令牌文件读不了：' + (resolved.file.error ?? '')
  return '没有令牌文件，也没有环境变量'
}

/** 工具结果必须是 lossless JSON：这里递归剔除 undefined 属性。 */
function prune(value) {
  if (Array.isArray(value)) return value.map((entry) => prune(entry))
  if (value === null || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    result[key] = prune(entry)
  }
  return result
}

function firstString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function describeError(error) {
  return String((error && error.message) || error)
}

#!/usr/bin/env node
/**
 * smoke.mjs —— dsh-yuque-mcp 离线自检。
 *
 * 覆盖四层：
 *   1. vendor 产物完整性（sha256 / 无外部裸依赖 / 版本对账）；
 *   2. 内置服务端真的能跑：手写 JSON-RPC 做 stdio 握手，tools/list 必须正好是
 *      上游 19 个工具；再对着**本地语雀桩**跑一次 yuque_get_user，验证令牌确实
 *      从环境变量一路走到 HTTP 请求头（好令牌 200、坏令牌 401）；
 *   3. 纯逻辑单测：token-store（解析优先级 / 落盘权限 / 打码）、yuque-api
 *      （状态码映射 / baseURL 规范化）、token-gate（弹窗、重试、并发去重、缓存）；
 *   4. 插件接线（假 ctx + mcp-client 替身）：apply 之后 yuque_status 与
 *      tools/execute 闸门都挂上了，模拟一次 mcp__yuque__* 调用会「弹窗 → 校验 →
 *      落盘 → 重挂 → 放行」，用户拒绝时变成带修复指引的错误结果。
 *
 * 全部用例都跑在 127.0.0.1 的本地桩上，不访问外网（--online 时才额外做一次真实
 * 语雀探测，且失败只算跳过）。
 *
 * 用法：
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --online     # 额外探测 https://www.yuque.com
 *
 * @module scripts/smoke
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { builtinModules } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const VENDOR = join(PLUGIN_ROOT, 'vendor', 'yuque-mcp-server')
const ENTRY = join(VENDOR, 'build', 'index.js')
const online = process.argv.includes('--online')

/**
 * 上游工具清单（手写在测试里，故意不从插件常量读——否则实现改了测试会跟着一起错）。
 * 来源：https://github.com/yuque/yuque-mcp-server 的 src/tools/*.ts。
 */
const EXPECTED_TOOLS = [
  'yuque_get_user',
  'yuque_list_books', 'yuque_get_book', 'yuque_create_book', 'yuque_update_book',
  'yuque_list_docs', 'yuque_get_doc', 'yuque_create_doc', 'yuque_update_doc',
  'yuque_get_toc', 'yuque_update_toc',
  'yuque_search',
  'yuque_list_notes', 'yuque_get_note', 'yuque_create_note', 'yuque_update_note',
  'yuque_get_resource', 'yuque_create_resource', 'yuque_update_resource',
]

// ────────────────────────────── 迷你断言框架 ──────────────────────────────

let passed = 0
const failures = []
const skips = []

/** 断言；detail 会在失败时打印，便于定位。 */
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push({ name, detail })
  return false
}

function checkEqual(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  return check(name, ok, ok ? undefined : '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}

function skip(name, why) {
  skips.push(name + '（' + why + '）')
}

/** 跑一个用例组，异常转换成失败而不是中断整轮。 */
async function group(title, fn) {
  process.stdout.write('\n▸ ' + title + '\n')
  try {
    await fn()
  } catch (error) {
    failures.push({ name: title + ' 抛异常', detail: String(error?.stack ?? error) })
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * 粗略剥掉字符串字面量与注释，避免把 ajv 里 `equal.code = 'require("ajv/...")'`
 * 这类**字符串里的假 require** 当成真依赖（启发式，宁可漏报不误报）。
 */
function stripLiterals(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source.charCodeAt(index) !== 10) index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      out += '""'
      continue
    }
    out += char
    index += 1
  }
  return out
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── DSH peer 依赖 ──────────────────────────────

/**
 * lib/index.js 会 import @deepseek-ai/*（profile 提供）。在工作区里直接跑 smoke
 * 时这些包不在解析路径上，这里补一个 node_modules/@deepseek-ai 软链（.gitignore 已忽略）。
 * @returns 找到的 peer 目录；没找到返回 undefined。
 */
function ensurePeerResolution() {
  const candidates = [
    process.env.DSH_PLUGIN_NODE_MODULES,
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules'),
    join(homedir(), 'Documents', 'GitHub', 'deepseek-harness', 'node_modules'),
  ].filter((entry) => typeof entry === 'string' && entry !== '')

  const found = candidates.find((dir) => existsSync(join(dir, '@deepseek-ai', 'dsh-tools')))
  if (found === undefined) return undefined

  const link = join(PLUGIN_ROOT, 'node_modules', '@deepseek-ai')
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true })
    try {
      symlinkSync(join(found, '@deepseek-ai'), link, 'dir')
      process.stdout.write('（已建立 peer 软链 ' + link + ' -> ' + join(found, '@deepseek-ai') + '）\n')
    } catch (error) {
      return found
    }
  }
  return found
}

// ────────────────────────────── 本地语雀桩 ──────────────────────────────

/**
 * 起一个只实现 \`GET /api/v2/user\` 的语雀桩：令牌正确 200，其余 401。
 * 这样「令牌 → 环境变量 → 服务端 → HTTP 头 → 状态码」这条链可以离线验证。
 */
async function startFakeYuque(goodToken) {
  const requests = []
  const server = createServer((req, res) => {
    const token = req.headers['x-auth-token']
    requests.push({ url: req.url, token })
    if (req.url !== '/api/v2/user') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    if (token === goodToken) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { id: 1, login: 'critter-survivor', name: '小动物幸存者' } }))
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'unauthorized' }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const baseURL = 'http://127.0.0.1:' + port
  return {
    port,
    baseURL,
    // 上游 normalizeYuqueBaseURL 会给站点根补上 /api/v2，这里同步给测试用
    apiBaseURL: baseURL + '/api/v2',
    requests,
    close: () => new Promise((done) => server.close(done)),
  }
}

// ────────────────────────────── MCP stdio 客户端 ──────────────────────────────

/** 手写的最小 MCP 客户端：足够 initialize / tools/list / tools/call。 */
function startMcpServer(env, entry = ENTRY) {
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  const pending = new Map()
  const notifications = []

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      } else {
        notifications.push(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  let nextId = 1
  function rpc(method, params, timeoutMs = 20000) {
    const id = nextId++
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error('MCP ' + method + ' 超时'))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        done(message)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  return {
    child,
    rpc,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    stderr: () => stderr,
    notifications,
    async handshake() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-yuque-mcp-smoke', version: '1.0.0' },
      })
      this.notify('notifications/initialized', {})
    },
    close: () => {
      child.kill()
    },
    async exited(timeoutMs = 10000) {
      if (child.exitCode !== null) return child.exitCode
      return await Promise.race([
        new Promise((done) => child.once('exit', (code) => done(code))),
        delay(timeoutMs).then(() => 'timeout'),
      ])
    },
  }
}

/** 干净的子进程环境：只给必要的 PATH/HOME 与显式传入的 YUQUE_*。 */
function cleanEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
  }
  return { ...env, ...extra }
}

// ────────────────────────────── 假 ctx（插件接线测试） ──────────────────────────────

/** mcp-client 替身：真身会真的拉子进程，这里只用来观察挂载时序。 */
const stubClient = { name: 'mcp-client-stub', apply() {} }

/**
 * 造一个够用的假 cordis ctx：工具注册表、事件表、plugin 记录、userQuestions。
 * plugin() 命中替身时按真实命名规则注册 mcp__<serverName>__*，dispose 时撤销。
 */
function createFakeCtx() {
  const tools = new Map()
  const listeners = new Map()
  const specs = []
  const questions = []
  const logs = []
  let answer

  const userQuestions = {
    async ask(request) {
      questions.push(request)
      if (answer === undefined) {
        throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
      }
      return answer(request, questions.length)
    },
  }

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    plugin(module, spec) {
      const owned = []
      specs.push({ module, spec })
      if (module === stubClient) {
        for (const name of EXPECTED_TOOLS) {
          const full = 'mcp__' + spec.serverName + '__' + name
          tools.set(full, { name: full, stub: true })
          owned.push(full)
        }
      }
      return {
        async dispose() {
          for (const name of owned) tools.delete(name)
        },
      }
    },
    get(name) {
      return name === 'userQuestions' ? userQuestions : undefined
    },
    effect() {},
  }

  return {
    ctx,
    tools,
    listeners,
    specs,
    questions,
    logs,
    setAnswer(fn) {
      answer = fn
    },
    /** 触发某个事件的第一个监听器。 */
    fire(event, ...args) {
      const list = listeners.get(event) ?? []
      return list.map((handler) => handler(...args))
    },
    has(event) {
      return (listeners.get(event) ?? []).length > 0
    },
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────

const work = mkdtempSync(join(tmpdir(), 'dsh-yuque-smoke-'))
const GOOD_TOKEN = 'yq_smoke_good_token_0123456789'
const BAD_TOKEN = 'yq_smoke_bad_token_9876543210'
const fake = await startFakeYuque(GOOD_TOKEN)

const peerRoot = ensurePeerResolution()
const tokenStore = await import('../lib/token-store.js')
const yuqueApi = await import('../lib/yuque-api.js')
const tokenGate = await import('../lib/token-gate.js')
let plugin
if (peerRoot === undefined) {
  skip('插件接线测试', '没找到 @deepseek-ai/* peer（设置 DSH_PLUGIN_NODE_MODULES 后重跑）')
} else {
  plugin = await import('../lib/index.js')
}

try {
  // ── 1. vendor 产物 ───────────────────────────────────────────────
  await group('1. vendor 产物完整性', async () => {
    check('内置服务端存在', existsSync(ENTRY), ENTRY)
    const provenance = JSON.parse(readFileSync(join(VENDOR, 'PROVENANCE.json'), 'utf8'))
    const bundle = readFileSync(ENTRY)
    checkEqual('sha256 与 PROVENANCE 一致', sha256(bundle), provenance.bundle.sha256)
    checkEqual('体积与 PROVENANCE 一致', bundle.byteLength, provenance.bundle.bytes)

    const vendorManifest = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'))
    checkEqual('vendor package.json 版本与上游一致', vendorManifest.version, provenance.upstream.version)

    const source = bundle.toString('utf8')
    check('带有 createRequire 互操作垫片', source.includes('__dshCreateRequire') && source.includes('createRequire'))
    check('带打包署名 banner', source.includes('vendor-server.mjs'))

    // 静态 import / require 只允许 Node 内建：产物必须是零外部依赖
    const code = stripLiterals(source)
    const specifiers = new Set()
    for (const match of code.matchAll(/\bimport\s[^;]*?from\s*["']([^"']+)["']/g)) specifiers.add(match[1])
    for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) specifiers.add(match[1])
    for (const match of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1])
    const builtins = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)])
    // 相对/绝对路径（例如 createRequire("../package.json")）不算外部依赖，只拦裸模块名
    const external = [...specifiers].filter((spec) => !builtins.has(spec)
      && !spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/'))
    checkEqual('没有外部裸模块依赖', external, [])
  })

  // ── 2. 上游前提：没有令牌就不启动（这正是本插件要用占位令牌的理由）────
  await group('2. 上游服务端的启动前提', async () => {
    const server = startMcpServer(cleanEnv())
    const code = await server.exited()
    checkEqual('缺令牌时退出码为 1', code, 1)
    check('stderr 提到 token', /token/i.test(server.stderr()), server.stderr().slice(0, 200))
  })

  // ── 3. 真 stdio 握手 + 本地语雀桩 ────────────────────────────────
  await group('3. 内置服务端 stdio 握手（对本地语雀桩）', async () => {
    const env = cleanEnv({ YUQUE_TOKEN: GOOD_TOKEN, YUQUE_HOST: fake.baseURL })
    const server = startMcpServer(env)
    try {
      await server.handshake()
      const list = await server.rpc('tools/list', {})
      const names = (list.result?.tools ?? []).map((tool) => tool.name).sort()
      checkEqual('tools/list 正好是上游 19 个工具', names, [...EXPECTED_TOOLS].sort())

      const call = await server.rpc('tools/call', { name: 'yuque_get_user', arguments: {} })
      const text = call.result?.content?.[0]?.text ?? ''
      check('好令牌能拿到当前用户', text.includes('critter-survivor'), text.slice(0, 200))
      check('语雀桩收到了 X-Auth-Token', fake.requests.some((entry) => entry.token === GOOD_TOKEN))
    } finally {
      server.close()
    }

    const badServer = startMcpServer(cleanEnv({ YUQUE_TOKEN: BAD_TOKEN, YUQUE_HOST: fake.baseURL }))
    try {
      await badServer.handshake()
      const call = await badServer.rpc('tools/call', { name: 'yuque_get_user', arguments: {} })
      const text = call.result?.content?.[0]?.text ?? ''
      check('坏令牌返回鉴权错误', /401|unauthorized/i.test(text), text.slice(0, 200))
      check('坏令牌结果是 isError', call.result?.isError === true, JSON.stringify(call.result)?.slice(0, 200))
    } finally {
      badServer.close()
    }
  })

  // ── 4. token-store ──────────────────────────────────────────────
  await group('4. token-store：解析优先级 / 落盘 / 打码', async () => {
    checkEqual('去引号', tokenStore.normalizeToken('"abc12345"'), 'abc12345')
    checkEqual('去 Bearer 前缀', tokenStore.normalizeToken('Bearer  abc12345'), 'abc12345')
    checkEqual('去换行', tokenStore.normalizeToken('abc\n12345\n'), 'abc12345')
    checkEqual('空值返回 undefined', tokenStore.normalizeToken('   '), undefined)
    check('短令牌不合法', tokenStore.isPlausibleToken('abc') === false)
    check('中文不合法', tokenStore.isPlausibleToken('这是一段中文令牌内容') === false)
    check('正常令牌合法', tokenStore.isPlausibleToken(GOOD_TOKEN) === true)
    checkEqual('打码保留首尾', tokenStore.maskToken(GOOD_TOKEN), GOOD_TOKEN.slice(0, 4) + '…' + GOOD_TOKEN.slice(-4))
    check('占位令牌可识别', tokenStore.isPlaceholderToken(tokenStore.PLACEHOLDER_TOKEN) === true)

    const file = join(work, 'token', 'token.json')
    checkEqual('文件不存在时 state=missing', tokenStore.readTokenFile(file).state, 'missing')
    tokenStore.writeTokenFile(file, GOOD_TOKEN, { host: 'https://www.yuque.com' })
    const mode = statSync(file).mode & 0o777
    checkEqual('落盘权限 0600', mode.toString(8), '600')
    checkEqual('往返读到令牌', tokenStore.readTokenFile(file).token, GOOD_TOKEN)

    writeFileSync(file, '{ 坏 JSON')
    checkEqual('坏 JSON 判为 malformed', tokenStore.readTokenFile(file).state, 'malformed')
    writeFileSync(file, 'short')
    checkEqual('不像令牌的内容判为 malformed', tokenStore.readTokenFile(file).state, 'malformed')
    tokenStore.writeTokenFile(file, GOOD_TOKEN)

    const env = { DSH_HOME: work, YUQUE_TOKEN: BAD_TOKEN }
    checkEqual('config 优先于 env', tokenStore.resolveToken({ explicit: GOOD_TOKEN, env, file }).source, 'config')
    checkEqual('env 优先于文件', tokenStore.resolveToken({ env, file }).source, 'env:YUQUE_TOKEN')
    checkEqual('没有 env 时回落文件', tokenStore.resolveToken({ env: { DSH_HOME: work }, file }).source, 'file')
    checkEqual('缺省路径在 $DSH_HOME 下', tokenStore.defaultTokenFile({ DSH_HOME: work }),
      join(work, 'yuque-mcp', 'token.json'))
  })

  // ── 5. yuque-api ────────────────────────────────────────────────
  await group('5. yuque-api：状态码映射与 baseURL 规范化', async () => {
    checkEqual('默认站点补 /api/v2', yuqueApi.normalizeBaseURL(undefined), 'https://www.yuque.com/api/v2')
    checkEqual('站点根补 /api/v2', yuqueApi.normalizeBaseURL('https://www.yuque.com/'), 'https://www.yuque.com/api/v2')
    checkEqual('已带路径时原样', yuqueApi.normalizeBaseURL('https://x.yuque.com/api/v2'), 'https://x.yuque.com/api/v2')
    checkEqual('没有路径的站点根补 /api/v2', yuqueApi.normalizeBaseURL(fake.baseURL), fake.apiBaseURL)

    const ok = await yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token: GOOD_TOKEN, timeoutMs: 3000 })
    checkEqual('好令牌 → ok', ok.state, 'ok')
    checkEqual('ok 带 login', ok.login, 'critter-survivor')

    const bad = await yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token: BAD_TOKEN, timeoutMs: 3000 })
    checkEqual('坏令牌 → invalid', bad.state, 'invalid')
    checkEqual('invalid 带 HTTP 状态', bad.status, 401)

    const skipped = await yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token: '', timeoutMs: 3000 })
    checkEqual('没有令牌 → skipped', skipped.state, 'skipped')

    const dead = await yuqueApi.verifyToken({ baseURL: 'http://127.0.0.1:1', token: GOOD_TOKEN, timeoutMs: 1500 })
    check('连不上 → unreachable', dead.state === 'unreachable', dead.state)

    const fetchImpl = async () => {
      throw new Error('boom')
    }
    const broken = await yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token: GOOD_TOKEN, fetchImpl })
    check('fetch 抛错 → unreachable', broken.state === 'unreachable', broken.state)
  })

  // ── 6. token-gate ───────────────────────────────────────────────
  await group('6. token-gate：弹窗 / 重试 / 并发去重 / 缓存', async () => {
    const baseSettings = {
      interactive: true,
      maxPromptAttempts: 3,
      verifyCacheMs: 60000,
      tokenFile: join(work, 'gate.json'),
      baseURL: fake.apiBaseURL,
      verifyTimeoutMs: 3000,
    }
    const exec = { agent: { id: 'fake-agent' }, signal: new AbortController().signal }

    // 6.1 无令牌 → 弹窗 → 校验 → 落盘 → 重挂 → 放行
    {
      const state = { token: undefined, source: undefined, verification: { state: 'unverified', at: 0 }, prompting: undefined }
      const calls = { verify: 0, save: [], mount: [], ask: 0 }
      const gate = tokenGate.createTokenGate({
        settings: baseSettings,
        state,
        verify: async (token) => {
          calls.verify += 1
          return yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token, timeoutMs: 3000 })
        },
        saveToken: (token) => calls.save.push(token),
        ensureMounted: async (token) => calls.mount.push(token),
        mountedToken: () => undefined,
        isPlaceholder: tokenStore.isPlaceholderToken,
        askUser: async () => {
          calls.ask += 1
          return { kind: 'token', token: GOOD_TOKEN }
        },
      })
      const result = await gate.ensureReady(exec)
      checkEqual('无令牌 → ready', result.kind, 'ready')
      checkEqual('弹窗 1 次', calls.ask, 1)
      checkEqual('令牌落盘 1 次', calls.save, [GOOD_TOKEN])
      checkEqual('按新令牌重挂', calls.mount, [GOOD_TOKEN])
      checkEqual('state.token 更新', state.token, GOOD_TOKEN)
      checkEqual('state.source=prompt', state.source, 'prompt')
    }

    // 6.2 用户拒绝 → blocked
    {
      const state = { token: undefined, verification: { state: 'unverified', at: 0 } }
      const gate = tokenGate.createTokenGate({
        settings: baseSettings,
        state,
        verify: async () => ({ state: 'invalid', message: 'nope' }),
        saveToken: () => {},
        ensureMounted: async () => {},
        mountedToken: () => undefined,
        askUser: async () => ({ kind: 'declined', message: '用户没有提供语雀令牌。' }),
      })
      const result = await gate.ensureReady(exec)
      checkEqual('用户拒绝 → blocked', result.kind, 'blocked')
      check('blocked 带原因', /没有提供/.test(result.message ?? ''), result.message)
    }

    // 6.3 连续贴错 → 最多问 maxPromptAttempts 次
    {
      const state = { token: undefined, verification: { state: 'unverified', at: 0 } }
      let asked = 0
      const gate = tokenGate.createTokenGate({
        settings: baseSettings,
        state,
        verify: async () => ({ state: 'invalid', message: '令牌被语雀拒绝（HTTP 401）' }),
        saveToken: () => {},
        ensureMounted: async () => {},
        mountedToken: () => undefined,
        askUser: async () => {
          asked += 1
          return { kind: 'token', token: BAD_TOKEN }
        },
      })
      const result = await gate.ensureReady(exec)
      checkEqual('贴错 3 次后放弃', asked, 3)
      checkEqual('结论 blocked', result.kind, 'blocked')
      checkEqual('没有落盘坏令牌', state.token, undefined)
    }

    // 6.4 并发调用只弹一次
    {
      const state = { token: undefined, verification: { state: 'unverified', at: 0 } }
      let asked = 0
      const gate = tokenGate.createTokenGate({
        settings: baseSettings,
        state,
        verify: async (token) => yuqueApi.verifyToken({ baseURL: fake.apiBaseURL, token, timeoutMs: 3000 }),
        saveToken: () => {},
        ensureMounted: async () => {},
        mountedToken: () => undefined,
        askUser: async () => {
          asked += 1
          await delay(50)
          return { kind: 'token', token: GOOD_TOKEN }
        },
      })
      const results = await Promise.all([gate.ensureReady(exec), gate.ensureReady(exec), gate.ensureReady(exec)])
      checkEqual('并发都放行', results.map((entry) => entry.kind), ['ready', 'ready', 'ready'])
      checkEqual('并发只弹一次', asked, 1)
    }

    // 6.5 缓存命中：不重复校验，也不弹窗
    {
      const state = {
        token: GOOD_TOKEN,
        source: 'file',
        verification: { state: 'ok', token: GOOD_TOKEN, at: Date.now() },
      }
      let verified = 0
      let mounted = 0
      const gate = tokenGate.createTokenGate({
        settings: baseSettings,
        state,
        verify: async () => {
          verified += 1
          return { state: 'ok' }
        },
        saveToken: () => {},
        ensureMounted: async () => {
          mounted += 1
        },
        mountedToken: () => undefined,
        askUser: async () => ({ kind: 'declined', message: '不该被问到' }),
      })
      const result = await gate.ensureReady(exec)
      checkEqual('缓存命中直接放行', result.kind, 'ready')
      checkEqual('缓存期不重复校验', verified, 0)
      checkEqual('仍会确保挂载', mounted, 1)
    }

    // 6.6 网络不通：不弹窗（不是令牌问题）
    {
      const state = { token: GOOD_TOKEN, verification: { state: 'unverified', at: 0 } }
      let asked = 0
      const gate = tokenGate.createTokenGate({
        settings: { ...baseSettings, verifyCacheMs: 0 },
        state,
        verify: async () => ({ state: 'unreachable', message: '无法连接语雀' }),
        saveToken: () => {},
        ensureMounted: async () => {},
        mountedToken: () => GOOD_TOKEN,
        askUser: async () => {
          asked += 1
          return { kind: 'declined', message: '不该被问到' }
        },
      })
      const result = await gate.ensureReady(exec)
      checkEqual('unreachable 放行', result.kind, 'ready')
      checkEqual('unreachable 不弹窗', asked, 0)
    }
  })

  // ── 7. 插件接线（假 ctx + mcp-client 替身）───────────────────────
  if (plugin !== undefined) {
    await group('7. 插件接线：apply / 闸门 / yuque_status', async () => {
      const previous = plugin.setMcpClientForTesting(stubClient)
      try {
        const tokenFile = join(work, 'plugin', 'token.json')
        const harness = createFakeCtx()
        await plugin.apply(harness.ctx, {
          tokenFile,
          host: fake.baseURL,
          verifyTimeoutMs: 3000,
          remountTimeoutMs: 2000,
          verifyCacheMs: 0,
        })
        const internal = plugin.__testing.last
        const state = internal.state

        check('注册了 yuque_status', harness.tools.has('yuque_status'))
        check('注册了 tools/execute 闸门', harness.has('tools/execute'))
        check('注册了 tools/post-execute 观察者', harness.has('tools/post-execute'))
        checkEqual('首次挂载用占位令牌', harness.specs[0]?.spec?.env?.YUQUE_TOKEN, tokenStore.PLACEHOLDER_TOKEN)
        checkEqual('同时给出 YUQUE_PERSONAL_TOKEN', harness.specs[0]?.spec?.env?.YUQUE_PERSONAL_TOKEN,
          tokenStore.PLACEHOLDER_TOKEN)
        checkEqual('默认命名空间是 yuque', harness.specs[0].spec.serverName, 'yuque')

        const executeHandler = (harness.listeners.get('tools/execute') ?? [])[0]
        const fakeExec = { name: 'mcp__yuque__yuque_list_docs', agent: { id: 'agent-1' }, signal: new AbortController().signal }

        // 7.1 无令牌 → 弹窗 → 落盘 → 重挂 → 放行
        harness.setAnswer(() => ({ answers: [{ id: 'yuque_token', selected: [], custom: GOOD_TOKEN }] }))
        let nextCalled = 0
        const next = async () => {
          nextCalled += 1
          return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'stub' }] }
        }
        const passedThrough = await executeHandler(fakeExec, next)
        checkEqual('闸门放行并执行原工具', nextCalled, 1)
        checkEqual('放行结果是原工具结果', passedThrough.value, { ok: true })
        checkEqual('弹窗问了 1 次', harness.questions.length, 1)
        checkEqual('新挂载用上了新令牌', harness.specs.at(-1).spec.env.YUQUE_TOKEN, GOOD_TOKEN)
        checkEqual('令牌已落盘', tokenStore.readTokenFile(tokenFile).token, GOOD_TOKEN)
        checkEqual('闸门后状态为 ok', state.verification.state, 'ok')

        // 7.2 非语雀工具不受影响
        nextCalled = 0
        await executeHandler({ ...fakeExec, name: 'bash' }, next)
        checkEqual('非语雀工具直接放行', nextCalled, 1)
        checkEqual('不会为无关工具弹窗', harness.questions.length, 1)

        // 7.3 令牌失效（工具返回 401）→ 标记 invalid → 下次调用重新弹窗
        const postHandler = (harness.listeners.get('tools/post-execute') ?? [])[0]
        postHandler(
          fakeExec,
          { isError: true, content: [{ type: 'text', text: 'Tool execution failed: Unauthorized - the API token may be invalid or expired (401)' }] },
          async () => ({ kind: 'accept' }),
        )
        checkEqual('401 之后标记为 invalid', state.verification.state, 'invalid')

        // 让上下文里的令牌变成坏令牌，模拟「用户换过令牌/令牌被吊销」
        state.token = BAD_TOKEN
        state.source = 'file'
        state.verification = { state: 'unverified', at: 0 }
        harness.setAnswer(() => ({ answers: [{ id: 'yuque_token', selected: [], custom: GOOD_TOKEN }] }))
        const askedBefore = harness.questions.length
        nextCalled = 0
        await executeHandler(fakeExec, next)
        checkEqual('失效后重新弹窗', harness.questions.length, askedBefore + 1)
        checkEqual('重新弹窗后依旧放行', nextCalled, 1)
        checkEqual('重挂已切回好令牌', harness.specs.at(-1).spec.env.YUQUE_TOKEN, GOOD_TOKEN)

        // 7.4 用户拒绝 → 错误结果 + 修复指引，且不执行工具
        const denyHarness = createFakeCtx()
        await plugin.apply(denyHarness.ctx, {
          tokenFile: join(work, 'plugin-deny', 'token.json'),
          host: fake.baseURL,
          verifyTimeoutMs: 3000,
          remountTimeoutMs: 2000,
        })
        denyHarness.setAnswer(() => ({ answers: [{ id: 'yuque_token', selected: ['暂时不用语雀'] }] }))
        const denyExec = { name: 'mcp__yuque__yuque_search', agent: { id: 'agent-2' }, signal: new AbortController().signal }
        let denyNext = 0
        const denied = await denyHarness.fire('tools/execute', denyExec, async () => {
          denyNext += 1
          return { isError: false, value: {}, content: [] }
        })[0]
        checkEqual('拒绝后不执行工具', denyNext, 0)
        check('拒绝返回 isError', denied?.isError === true)
        check('错误里带修复指引', /环境变量|cordis\.patch\.yml/.test(denied?.content?.[0]?.text ?? ''), denied?.content?.[0]?.text?.slice(0, 200))

        // 7.5 yuque_status：诊断快照
        const statusHarness = createFakeCtx()
        await plugin.apply(statusHarness.ctx, {
          tokenFile,
          host: fake.baseURL,
          verifyTimeoutMs: 3000,
          remountTimeoutMs: 2000,
        })
        const statusTool = statusHarness.tools.get('yuque_status')
        const value = await statusTool.execute({}, { agent: { id: 'agent-3' }, signal: new AbortController().signal })
        checkEqual('诊断：令牌可用', value.verify.state, 'ok')
        checkEqual('诊断：来源为 file', value.token.source, 'file')
        checkEqual('诊断：工具数 19', value.server.toolCount, 19)
        checkEqual('诊断：站点指向桩', value.server.baseURL, fake.apiBaseURL)
        check('诊断输出是 lossless JSON', JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value))
        const rendered = statusTool.output.render({}, value)
        check('诊断能渲染成文本', typeof rendered?.[0]?.text === 'string' && rendered[0].text.includes('令牌'))

        // 7.6 Config（真 schemastery 校验）+ pickToken
        const defaults = plugin.Config({})
        checkEqual('Config 默认 serverName', defaults.serverName, 'yuque')
        checkEqual('Config 默认 interactive', defaults.interactive, true)
        checkEqual('Config 默认 toolCallTimeoutMs', defaults.toolCallTimeoutMs, 60000)
        let rejected = false
        try {
          plugin.Config({ toolCallTimeoutMs: 0 })
        } catch {
          rejected = true
        }
        check('Config 拒绝非法超时', rejected)
        checkEqual('pickToken 取自由输入', plugin.pickToken({ answers: [{ id: 'yuque_token', selected: [], custom: GOOD_TOKEN }] }), GOOD_TOKEN)
        checkEqual('pickToken 忽略中文选项', plugin.pickToken({ answers: [{ id: 'yuque_token', selected: ['暂时不用语雀'] }] }), undefined)
      } finally {
        plugin.setMcpClientForTesting(previous)
      }
    })
  }

  // ── 8. 可选：真实语雀探测 ───────────────────────────────────────
  if (online) {
    await group('8. 在线探测（--online）', async () => {
      const probe = await yuqueApi.verifyToken({
        baseURL: yuqueApi.normalizeBaseURL(undefined),
        token: GOOD_TOKEN,
        timeoutMs: 5000,
      })
      if (probe.state === 'unreachable' || probe.state === 'unknown') {
        skip('真实语雀探测', '当前网络到 api.yuque.com 不通：' + probe.message)
      } else {
        checkEqual('假令牌被真实语雀拒绝', probe.state, 'invalid')
      }
    })
  }
} finally {
  await fake.close()
  rmSync(work, { recursive: true, force: true })
}

// ────────────────────────────── 汇总 ──────────────────────────────

process.stdout.write('\n' + '─'.repeat(60) + '\n')
for (const item of skips) process.stdout.write('○ 跳过：' + item + '\n')
for (const item of failures) {
  process.stdout.write('✗ ' + item.name + (item.detail === undefined ? '' : '\n    ' + item.detail) + '\n')
}
process.stdout.write((failures.length === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + passed + ' 项断言'
  + (failures.length === 0 ? '' : '，' + failures.length + ' 项失败') + '\n')
process.exit(failures.length === 0 ? 0 : 1)

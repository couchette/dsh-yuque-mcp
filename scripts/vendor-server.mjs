#!/usr/bin/env node
/**
 * vendor-server.mjs —— 把上游 yuque-mcp（https://github.com/yuque/yuque-mcp-server）
 * 打成零依赖单文件，放进 vendor/yuque-mcp-server/build/index.js。
 *
 * 为什么不用 npm 包直接跑：
 *   1. 插件的 profile 安装走 pnpm，任何第三方依赖的 postinstall 都可能被 pnpm 拦截，
 *      安装当场失败（dsh-unity-mcp 踩过同样的坑）；
 *   2. 单文件打包后本插件 dependencies 为空，安装不联网、不执行第三方脚本，
 *      只需要 profile 提供 @deepseek-ai/* 的 peer；
 *   3. 打包产物里不含任何外部 import，scripts/smoke.mjs 会校验这一点。
 *
 * 用法：
 *   node scripts/vendor-server.mjs            # 用 PROVENANCE.json 里的 gitRef（默认 v1.0.0）
 *   node scripts/vendor-server.mjs v1.0.0     # 指定 tag / commit
 *   node scripts/vendor-server.mjs --keep     # 保留临时工作目录（排错用）
 *
 * 需要：git、npm（走临时 npm cache，不会碰 ~/.npm）。
 *
 * @module scripts/vendor-server
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'yuque-mcp-server')
const BUILD_DIR = join(VENDOR_DIR, 'build')
const OUT_FILE = join(BUILD_DIR, 'index.js')
const PROVENANCE_FILE = join(VENDOR_DIR, 'PROVENANCE.json')

const UPSTREAM_REPO = 'https://github.com/yuque/yuque-mcp-server.git'
/**
 * 默认钉在上游 main 的具体 commit。
 *
 * 说明：npm 上的 `yuque-mcp@1.0.0`（tag v1.0.0）**只认 `YUQUE_PERSONAL_TOKEN`**，
 * `YUQUE_TOKEN` / `YUQUE_HOST` 是 v1.0.0 之后才加到 main 的（上游没再发版）。
 * 而 GitHub README 与 server.json 对外宣传的就是 `YUQUE_TOKEN`，因此这里钉 main 的
 * commit（可复现），并同时把两个环境变量都传给子进程（见 lib/index.js）。
 */
const DEFAULT_REF = '757a408c29cb21ba493a22de2ac99126d2460f75'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const refArg = argv.find((arg) => !arg.startsWith('--'))

const pluginManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const esbuildVersion = pluginManifest.devDependencies?.esbuild ?? '0.25.12'
const previous = existsSync(PROVENANCE_FILE) ? JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8')) : undefined

const ref = refArg ?? previous?.upstream?.gitRef ?? DEFAULT_REF
const work = mkdtempSync(join(tmpdir(), 'dsh-yuque-vendor-'))
const srcDir = join(work, 'src')
const npmEnv = { ...process.env, npm_config_cache: join(work, 'npm-cache'), npm_config_update_notifier: 'false' }

/** 跑一条命令，失败时抛出带完整输出的错误。 */
function run(command, args, options = {}) {
  process.stderr.write('$ ' + [command, ...args].join(' ') + '\n')
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: npmEnv, ...options })
}

/** 命令是否存在（缺 git / npm 时给出可读报错）。 */
function which(command) {
  try {
    execFileSync('sh', ['-c', 'command -v ' + command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

try {
  for (const tool of ['git', 'npm']) {
    if (!which(tool)) throw new Error('缺少 ' + tool + '：请先安装后再执行本脚本')
  }

  process.stderr.write('上游：' + UPSTREAM_REPO + ' @ ' + ref + '\n')
  // tag / 分支 / 裸 commit 都能取：init + fetch <ref> + checkout FETCH_HEAD
  // （`clone --branch <sha>` 对裸 commit 不成立）
  mkdirSync(srcDir, { recursive: true })
  run('git', ['init', '--quiet', srcDir])
  run('git', ['-C', srcDir, 'remote', 'add', 'origin', UPSTREAM_REPO])
  run('git', ['-C', srcDir, 'fetch', '--quiet', '--depth', '1', 'origin', ref])
  run('git', ['-C', srcDir, 'checkout', '--quiet', 'FETCH_HEAD'])
  const commit = run('git', ['-C', srcDir, 'rev-parse', 'HEAD']).trim()
  const described = run('git', ['-C', srcDir, 'describe', '--tags', '--always']).trim()
  const upstreamManifest = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'))

  // 只要运行时依赖：打包不需要 typescript / vitest / eslint
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: srcDir })
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', 'esbuild@' + esbuildVersion], { cwd: srcDir })

  // node_modules/.bin/esbuild 是 JS 启动器；node_modules/esbuild/bin/esbuild 是原生二进制，
  // 用 node 直接执行它会报 SyntaxError，所以这里走 .bin 里的启动器。
  const esbuildBin = join(srcDir, 'node_modules', '.bin', 'esbuild')
  if (!existsSync(esbuildBin)) throw new Error('esbuild 未安装成功：' + esbuildBin)

  mkdirSync(BUILD_DIR, { recursive: true })
  run(esbuildBin, [
    join(srcDir, 'src', 'cli.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node18',
    '--legal-comments=eof',
    // 两个 banner：署名注释 + CJS 互操作垫片。
    // 上游的 axios / form-data 等依赖是 CJS，esbuild 会把它们的 require 收进 __require 垫片，
    // 而 ESM 里没有模块级 require，缺了下面这行就会在运行时抛
    // "Dynamic require of \"util\" is not supported"。垫片必须出现在 esbuild 自己的
    // __require 定义之前，所以只能靠 banner 注入。
    '--banner:js=/* 本文件由 dsh-yuque-mcp/scripts/vendor-server.mjs 从上游源码打包生成，请勿手工修改。 */'
      + ' import { createRequire as __dshCreateRequire } from "node:module";'
      + ' const require = __dshCreateRequire(import.meta.url);',
    '--outfile=' + OUT_FILE,
  ])

  // 上游 server.js 顶层 createRequire('../package.json') 读的是「产物上一级」的 package.json
  writeFileSync(join(VENDOR_DIR, 'package.json'), JSON.stringify({
    name: upstreamManifest.name,
    version: upstreamManifest.version,
    description: upstreamManifest.description,
    license: upstreamManifest.license,
    private: true,
    type: 'module',
    main: 'build/index.js',
    note: '上游 package.json 的最小副本：只用于满足打包产物里的 createRequire("../package.json")。',
  }, null, 2) + '\n')

  const licenseCandidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
  const licenseName = licenseCandidates.find((name) => existsSync(join(srcDir, name)))
  if (licenseName !== undefined) cpSync(join(srcDir, licenseName), join(VENDOR_DIR, 'LICENSE'))

  const bundle = readFileSync(OUT_FILE)
  const sha256 = createHash('sha256').update(bundle).digest('hex')
  const provenance = {
    upstream: {
      repo: UPSTREAM_REPO,
      homepage: upstreamManifest.homepage ?? 'https://github.com/yuque/yuque-mcp-server',
      gitRef: ref,
      commit,
      describe: described,
      version: upstreamManifest.version,
    },
    bundle: {
      entry: 'src/cli.ts',
      file: 'vendor/yuque-mcp-server/build/index.js',
      format: 'esm',
      interop: 'createRequire banner（CJS 依赖的动态 require 垫片）',
      platform: 'node',
      target: 'node18',
      bytes: bundle.byteLength,
      sha256,
    },
    build: {
      script: 'scripts/vendor-server.mjs',
      esbuild: esbuildVersion,
      node: process.version,
    },
    license: upstreamManifest.license ?? 'MIT',
    vendoredAt: new Date().toISOString(),
  }
  writeFileSync(PROVENANCE_FILE, JSON.stringify(provenance, null, 2) + '\n')

  process.stderr.write(
    '完成：' + OUT_FILE + '\n'
    + '  上游版本 ' + upstreamManifest.version + '（' + commit.slice(0, 12) + '，' + described + '）\n'
    + '  产物体积 ' + (bundle.byteLength / 1024).toFixed(1) + ' KiB，sha256 ' + sha256.slice(0, 16) + '…\n',
  )
} finally {
  if (keep) process.stderr.write('保留临时目录：' + work + '\n')
  else rmSync(work, { recursive: true, force: true })
}

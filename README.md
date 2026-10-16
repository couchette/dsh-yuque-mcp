# dsh-yuque-mcp

> 把 [语雀（Yuque）](https://www.yuque.com) 知识库接进 DeepSeek Harness：Agent 直接读写你的文档 / 知识库 / 目录 / 小记。
> 内置上游 [yuque-mcp-server](https://github.com/yuque/yuque-mcp-server) 服务端，并在**首次运行或令牌失效时弹窗**向用户索取 YUQUE_TOKEN。

~~~
DSH Agent ──MCP(stdio)──> 内置 yuque-mcp 服务端 ──HTTPS──> 语雀开放 API (api/v2)
                                 ▲
                    YUQUE_TOKEN / YUQUE_HOST（由本插件注入）
~~~

## 它比「手写 mcpServers 配置」多做了什么

上游服务端在缺 YUQUE_TOKEN 时**直接 exit 1**（src/cli.ts），MCP 客户端只会看到「服务端起不来」。
本插件把「令牌从哪来、坏了怎么办」做成了闭环：

| 场景 | 上游 npx 直接跑 | 本插件 |
| --- | --- | --- |
| 没有令牌 | 进程退出，工具全不可见 | 用**占位令牌**先拉起服务端（tools/list 不需要鉴权），19 个工具照常可见；第一次真正调用时弹窗要令牌 |
| 用户不知道令牌是什么 | 只有一行 stderr | 弹窗里逐步说明「语雀 → 头像 → 账号设置 → 令牌 → 新建」，并给出令牌文件路径 |
| 令牌过期 / 被吊销 | 每次调用返回 401 | tools/post-execute 识别 401 → 标记失效 → 下次调用**再次弹窗** |
| 令牌存哪 | 由使用者自己配环境变量 | 弹窗输入后落盘 $DSH_HOME/yuque-mcp/token.json（0600）；也支持 config.token 与环境变量 |
| 校验一次要打网络 | — | 校验结果缓存 60s；连不上语雀时**不弹窗**（不是令牌问题） |

## 环境要求

| 组件 | 要求 |
| --- | --- |
| DeepSeek Harness | 0.1.5 及以上（插件只依赖 @deepseek-ai/dsh-tools、dsh-mcp-client、schemastery 三个 peer） |
| Node.js | 无需单独安装（用 Harness 自带运行时；Electron 下自动加 ELECTRON_RUN_AS_NODE=1） |
| 语雀账号 | 需要一个**个人令牌**：语雀 → 头像 → 账号设置 → 令牌 → 新建（权限勾「读取」即可；要写文档再勾「读写」） |

## 安装

~~~sh
# 1) 安装到 profile（Agent 受 DSH 文件沙箱限制写不了 ~/.dsh，请在终端执行）
sh dsh-yuque-mcp/scripts/install-into-profile.sh              # 装进 desktop
sh dsh-yuque-mcp/scripts/install-into-profile.sh desktop web  # 装进 desktop 与 web
~~~

脚本内部执行的就是桌面端自带 CLI 的官方命令：

~~~sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "file:/绝对路径/dsh-yuque-mcp"
~~~

> GUI 方式：桌面端侧边栏 **插件** 页 → 安装组合包 → 填本目录的绝对路径。
> 卸载：dsh plugin --profile desktop remove dsh-yuque-mcp。
> 本插件**零运行时依赖**（服务端已打成单文件），安装不联网、不执行任何第三方构建脚本。

重启 Harness 后，Agent 会看到本地工具 yuque_status 与 19 个 mcp__yuque__* 工具。

## 第一次运行：令牌弹窗

1. 让 Agent 调一次 yuque_status（或直接让它读你的语雀文档）；
2. 插件发现没有可用令牌 → 弹出问答卡片，标题「语雀 YUQUE_TOKEN」；
3. 把令牌**粘贴到卡片下方的输入框**并提交（卡片上还有一个「暂时不用语雀」的选项，选它只是跳过本次）；
4. 插件立刻打一次 GET /api/v2/user 校验：通过就写进 $DSH_HOME/yuque-mcp/token.json（0600）并热替换服务端，
   **同一次工具调用继续执行**，不需要重试。

> 建议先调 yuque_status 再调语雀工具：yuque_status 的调用预算给了 10 分钟，用户慢慢找令牌也不会超时；
> 直接调 mcp__yuque__* 触发弹窗时，可用时间受该 MCP 工具的 toolCallTimeoutMs 限制（默认 60 秒）。

令牌三级来源（优先级从高到低）：

1. profile 配置里的 token（适合 CI / 多账号；会写进配置文件，注意别提交）；
2. 环境变量 YUQUE_TOKEN 或 YUQUE_PERSONAL_TOKEN（后者是上游 v1.0.0 的旧名字，两个都认）；
3. 令牌文件 $DSH_HOME/yuque-mcp/token.json（弹窗自动写入）。

删除令牌文件 = 清除令牌；下次调用会重新弹窗。

## 配置

在 profile 的 cordis.patch.yml 里按 id 覆盖（**不要**改插件自带的 cordis.patch.yml）：

~~~yaml
- id: yuque-mcp
  config:
    serverName: yuque                  # 工具命名空间 mcp__<serverName>__*
    host: https://your-space.yuque.com # 团队版/独立站点；留空用 https://www.yuque.com
    tokenFile: /Users/me/.dsh/yuque-mcp/token.json
    interactive: true                  # false = 不弹窗（headless / CI 用环境变量喂令牌）
    toolCallTimeoutMs: 60000           # 单次 MCP 调用超时
    verifyTimeoutMs: 8000              # 令牌在线校验超时
    verifyCacheMs: 60000              # 校验结果缓存时长，0 = 每次都校验
    maxPromptAttempts: 3               # 连续贴错几次后放弃
    env:
      YUQUE_HOST: https://your-space.yuque.com
~~~

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| serverName | yuque | MCP 工具命名空间，合法字符 [A-Za-z0-9_-]，长度 ≤32 |
| token | 空 | 显式令牌，优先级最高 |
| host | 空 | 语雀站点 / API 根；留空用官方站点。团队令牌必须配对应的空间域名 |
| tokenFile | $DSH_HOME/yuque-mcp/token.json | 令牌文件路径 |
| toolCallTimeoutMs | 60000 | 单次 MCP 工具调用超时（毫秒） |
| verifyTimeoutMs | 8000 | 令牌在线校验超时 |
| verifyCacheMs | 60000 | 校验结果缓存；0 表示每次调用前都校验 |
| interactive | true | 是否允许弹窗索取令牌 |
| maxPromptAttempts | 3 | 单次弹窗流程里最多让用户试几次 |
| remountTimeoutMs | 20000 | 换令牌后等新服务端注册工具的上限 |
| env | {} | 追加给服务端进程的环境变量，同名覆盖默认注入 |
| nodePath | 空 | 覆盖启动服务端所用的 Node 可执行文件 |
| reconnect | 1s→30s、10 次 | 服务端断连后的自动重连 |

非法值（例如 toolCallTimeoutMs: 0）会在插件加载期被 schema 直接拒绝。

## 工具

- **yuque_status**（本地工具，无 mcp__ 前缀）：令牌来源 / 在线校验结果（含当前用户）/ 站点 / 内置服务端版本 / 工具清单 / 可执行建议。
  - 不传参数：令牌缺失或失效时**弹窗**；
  - prompt: true：无论当前令牌是否可用都弹窗重填（换令牌走这里）；
  - prompt: false：只诊断，不弹窗；
  - verify: false：跳过在线校验（不发网络请求）。
- **mcp__yuque__***（19 个，来自上游）：
  - 用户：yuque_get_user
  - 知识库：yuque_list_books、yuque_get_book、yuque_create_book、yuque_update_book
  - 文档：yuque_list_docs、yuque_get_doc、yuque_create_doc、yuque_update_doc
  - 目录：yuque_get_toc、yuque_update_toc
  - 搜索：yuque_search
  - 小记：yuque_list_notes、yuque_get_note、yuque_create_note、yuque_update_note
  - 资源（附件/画板）：yuque_get_resource、yuque_create_resource、yuque_update_resource

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 第一次调用语雀工具弹窗 | 还没有令牌 | 粘贴令牌；或改用 YUQUE_TOKEN 环境变量 |
| 提示「没有可用的问答通道（headless / 无 UI）」 | headless / 无 UI 会话，或当前是子 Agent | 启动前设置 YUQUE_TOKEN，或在 profile 里配 token |
| 提示「连不上语雀」 | 网络 / 代理问题（Node 的 fetch 默认不读 HTTP_PROXY） | 检查网络；这类情况插件**不会**弹窗误导你重填令牌 |
| 工具返回 401 / Unauthorized | 令牌过期、被吊销，或 host 与令牌所属空间不匹配 | yuque_status（prompt: true）重填；团队令牌记得配 host |
| 工具列表里没有 mcp__yuque__* | 内置服务端缺失或起不来 | node dsh-yuque-mcp/scripts/vendor-server.mjs 重新打包；再看 Harness 日志 |
| 弹窗输入后仍报权限错误 | 令牌权限不足 | 语雀令牌权限勾「读取」（写文档再加「读写」） |
| 调用一直超时 | 语雀侧限流 / 网络抖动 | 调大 toolCallTimeoutMs；插件自带指数退避重连 |

## 开发

~~~sh
node scripts/vendor-server.mjs        # 按 PROVENANCE.json 的 ref 重新拉取上游并打包（需要 git / npm）
node scripts/vendor-server.mjs main   # 升级到新的 tag / 分支 / commit
node scripts/smoke.mjs                # 离线自检：94 项断言（vendor 完整性 / 真 stdio 握手 / 单测 / 插件接线）
node scripts/smoke.mjs --online       # 额外探测一次真实 api.yuque.com（失败只算跳过）
~~~

目录结构：

~~~
dsh-yuque-mcp/
├── lib/index.js              # 插件入口：Config、挂载 mcp-client、yuque_status、tools/execute 闸门
├── lib/token-store.js        # 令牌解析（三级优先级）/ 落盘（0600）/ 打码
├── lib/token-gate.js         # 令牌策略状态机：弹窗 → 校验 → 落盘 → 重挂（依赖注入，可离线单测）
├── lib/yuque-api.js          # GET /api/v2/user 在线校验 + baseURL 规范化
├── vendor/yuque-mcp-server/  # 内置上游服务端（esbuild 单文件 + PROVENANCE.json + LICENSE）
├── scripts/vendor-server.mjs # 拉上游 → npm ci --omit=dev → esbuild 单文件
├── scripts/smoke.mjs         # 自检（含本地语雀桩，不依赖外网）
├── scripts/install-into-profile.sh
└── cordis.patch.yml          # bundle 层：按 id: yuque-mcp 插入
~~~

### 为什么内置服务端是「零依赖单文件」

pnpm 会拦截第三方依赖的构建脚本，一旦上游依赖树里有未获批准的 postinstall，dsh plugin add 会直接失败。
scripts/vendor-server.mjs 用 esbuild 把服务端打成**单个 ESM 文件**（并用 createRequire banner 兼容 axios 这些
CJS 依赖的动态 require），因此本插件 dependencies 为空，安装不联网、不跑第三方脚本。

### 上游版本

内置的是上游 main 的 commit（见 vendor/yuque-mcp-server/PROVENANCE.json），而不是 npm 上的 1.0.0 tag：
tag v1.0.0 **只认 YUQUE_PERSONAL_TOKEN**，YUQUE_TOKEN / YUQUE_HOST 是之后才进 main 的（上游尚未再发版）。
插件把两个环境变量都传给子进程，因此两代上游都能跑。

> 开发时 node scripts/smoke.mjs 会在插件目录下建一个 node_modules/@deepseek-ai 软链（指向 profile 的 peer 依赖），
> 仅供本机跑测试用，已在 .gitignore 中忽略。

## 许可

本插件以 [BSD 2-Clause](LICENSE) 分发（仓库根目录的 LICENSE 即该许可证）。
内置的 yuque-mcp 服务端来自 [yuque/yuque-mcp-server](https://github.com/yuque/yuque-mcp-server)（MIT），
其许可证随产物保留在 vendor/yuque-mcp-server/LICENSE，来源与构建信息见 vendor/yuque-mcp-server/PROVENANCE.json。

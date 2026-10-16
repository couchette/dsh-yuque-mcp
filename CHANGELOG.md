# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-10-16

### 新增

- 内置 yuque-mcp 服务端（上游 main @ 757a408，esbuild 单文件、零运行时依赖）。
- 19 个 mcp__yuque__* 工具（用户 / 知识库 / 文档 / 目录 / 搜索 / 小记 / 资源）。
- 本地诊断工具 yuque_status：令牌来源与在线校验、站点、服务端版本、工具清单、可执行建议。
- **令牌弹窗**：首次运行或令牌失效（401）时通过 ctx.userQuestions 弹窗索取 YUQUE_TOKEN，
  校验通过后落盘 $DSH_HOME/yuque-mcp/token.json（0600）并热替换 mcp-client，同一次调用直接生效。
- 令牌三级解析：config.token → YUQUE_TOKEN / YUQUE_PERSONAL_TOKEN → 令牌文件。
- tools/execute 闸门 + tools/post-execute 401 识别；网络不通时不弹窗（不是令牌问题）。
- 校验结果缓存、并发弹窗去重、连续贴错 N 次后放弃。
- scripts/vendor-server.mjs：钉住上游 commit 重新打包；scripts/smoke.mjs：94 项离线断言。

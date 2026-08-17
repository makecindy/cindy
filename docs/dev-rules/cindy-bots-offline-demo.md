# Cindy Bots 离线验收沙箱

固定沙箱名：`cindy-bots-offline-demo`。

先在 Cindy Bots 分支根目录生成全新、无需登录的隔离 profile：

```bash
pnpm demo:bots-offline
```

脚本使用当前 checkout 的完整 migration 链创建最新 schema，不复制任何现有 userData，
并写入本地模式 `app-session.json` 与 `CindyDev` 身份标记。默认目录是：

```text
~/Library/Application Support/CindyGlobal-dev2-cindy-bots-offline-demo
```

沙箱预置三种 Bot 状态（正常总控、暂停助理、可恢复异常 PR 总管），以及已处理／失败／
待处理的事件收件箱、成功／终态失败／可重试的投递历史、一个已归档历史任务。总控 Bot
的身份与能力直接取产品内置 `control` 模板，避免演示数据和真实创建向导漂移。演示订阅
使用 `inbox-only`，所以应用启动时只展示持久数据，不会自动唤起真实 Agent turn。

目标已存在时脚本默认拒绝覆盖；`--replace` 也只接受带有本脚本所有权标记的演示目录，
不会覆盖同名的陌生目录。确认只需重建这份演示沙箱时使用：

```bash
pnpm demo:bots-offline -- --replace
```

后续由 Chris 或总控在明确授权后启动，开发 agent 不自行执行：

```bash
pnpm restart:desktop:remote -- --isolated=cindy-bots-offline-demo --region=global
```

离线可验：Bot 目录、三种状态、内置模板身份、真实任务输入框、事件时间线、历史任务、
投递成功／失败／恢复状态及 Light/Dark UI。真实 Telegram／飞书收发、活账号连接、真实
Automation fire 和真实 Bot 委派仍需活账号或 Chris 在场。

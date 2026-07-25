# Desktop 开发、启动与验证

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

Agent 启动 Desktop 只使用仓库根的安全包装命令，并显式选择目标区域：

```bash
pnpm restart:desktop:remote --region=cn
pnpm restart:desktop:remote --region=global
```

Desktop 连接的是你自己的 Cindy 云端账号（remote）。这与登录页中免 Cindy 账号的
「本地模式」（无需账号即可使用本机 agent）不是同一个概念。Agent 不得自行改用
`pnpm dev:desktop` 或 `pnpm dev:desktop:remote` 绕过包装脚本。

启动包装可能停止已有 Desktop dev 进程。必须尊重宿主提供的并行或保活工作流；如果
脚本因为当前 Agent 运行在 Cindy 内部而拒绝重启，不要换命令绕过，应把提示交给用户。

## 可选启动参数

两个 restart 命令都支持下列参数；**用户没提就不要主动加**（不带 = 共库 + 正常调度）。
这些参数只对 dev 生效，不影响用户机器上的正式版。

- `--region=cn|global`（默认 `cn`）：切换构建身份与仓内端点清单（`global` 读
  `config/endpoint.global.json`）。
- `--isolated` / `--isolated=<名字>`：使用独立 userData 沙箱，数据库、登录态、会话、定时
  任务与设备身份都与正式版彻底隔离（首次需重新登录）；命名沙箱每个名字一条独立沙箱，
  名字限 `A-Za-z0-9_-`、≤32 字符。用户说「独立数据库／隔离数据／沙箱启动／不要动正式版
  数据」时用。**未合入主干的 migration 必须在 `--isolated` 沙箱里跑，不得连共享 userData**
  （见 [`database-and-migrations.md`](database-and-migrations.md)）。沙箱（及任何 dev
  userData 覆写）内不触发首登旧数据迁移（mToc）：不探测老目录、不弹确认窗、不把正式
  数据复制进沙箱。
- `--passive`：定时任务被动模式，本实例不自动触发 schedule，但数据仍与其它实例共享；
  多开导致定时任务重复、需要让位给 primary 时用。共享 userData 的 passive 实例对
  userData 布局保持只读：不执行 owner-namespace 迁移（claim 推迟到下次独占启动），
  legacy 数据导入（`hasLegacyOwnerNamespaceClaim` 门控的 secret／IM／brain 搬账）
  一并等待。非 passive 实例执行该迁移前也会先查 `.dev-instances` 实例注册表
  （dev 与 packaged 实例都登记——dev 与正式版共库双开受支持），发现其它存活实例
  共享同一 userData 时同样推迟——搬家式迁移必须独占 userData 才能执行，否则会打断
  还在运行的旧版本实例（2026-07-23 slack-hook.json／网关凭证被搬走事故）。
- `--preserve-running`：并行 dev，不停止任何已有 Cindy dev 进程，每个新实例强制 passive
  并共享当前 userData／登录态；仅供能证明实例归属的上层编排，或用户明确「不要关当前
  实例／不要重新登录」时用。仅支持 remote，禁止与 `--isolated` 组合。

已手动设 `XDT_USER_DATA_DIR` 时尊重用户值，不覆盖。

### 并行多开 dev

restart 命令默认会停掉本 checkout 能识别到的全部 Cindy dev 进程，所以**用同一 checkout 的
restart 无法同时多开**。真要并行多个 dev 实例，走下面三条之一：

- 由能证明实例归属的上层编排调用 `--preserve-running`（不停已有实例，共享 userData／
  登录态，可从多个 worktree 重复启动）；
- 让用户在自己终端直跑 human-only 的 `pnpm dev:desktop:remote --isolated=<名字>`（不杀旧
  进程，每个名字一条完全独立的沙箱）；
- 使用多个 checkout。

Agent 自身仍只走 restart 命令，不直接调 human-only 的 `dev:desktop*`。共享同一 userData
多开时，非 primary 实例用 `--passive` 让出定时任务调度（见上）。

## 何时需要重启

- 修改 main、preload、MCP、原生依赖或 package 运行时代码后需要重启。
- 只修改 renderer 时优先使用现有实例的热更新，不重复重启。
- 不确定运行实例来自哪个 checkout 时，先运行 `pnpm desktop:whoami -- --all` 核对。

## 分层验证

本节指导**开发过程中的增量验证**；提交（commit／PR）前的强制门禁以
`development-workflow.md` 的「提交前测试门禁」为准（仓库根 `pnpm test:unit` 与相关
package 的 typecheck 全部通过）。开发过程中根据实际改动选择最小但充分的检查：

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop lint
pnpm --filter desktop exec vitest run <测试文件路径>
pnpm --filter desktop test
pnpm build
pnpm test:unit
```

- 改 TypeScript 至少运行相关类型检查和定向测试。
- 跨模块、共享 package、构建链或广泛重构再扩大到 Desktop 全量测试、构建或根级单测。
- 数据库 migration、协议、更新器、权限与用户数据另有高风险专项规则；命中时先读取
  对应规则，不以本页命令替代专项验证。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

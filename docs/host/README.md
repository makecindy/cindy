# Cindy Host

当前先基于 PR #9246 提供主动启用的实验性基础网页版，让用户从浏览器操作 Host 上的基础任务。
普通桌面启动保持原状；不以完整迁移桌面功能为第一版前提。
当前范围与未完成验收见 [基础网页版](basic-web.md)，实际修复记录见 [本地完善与验收](pr-9246-completion.md)。
下一阶段目标已扩展为支持桌面、手机、网页及无图形 Linux 的共用后台，见
[完整无界面 Cindy 计划](headless-runtime-plan.md)；该目标尚未全部实现。

## 目标

这项工作要实现下面四点，目前尚未全部实现：

- **可以在服务器上无头运行**：不需要桌面窗口，无图形的 Linux 上也能运行。
- **后台不依赖 Electron**：任务、账号、插件、调度等逻辑从 Electron 主进程里解出来，由桌面和 Host 共用。
- **界面与后台分离**：以后换性能更好的前端，不用重写任务逻辑。
- **升级不中断任务**：任务跑在后台，界面升级、重启时任务不停。

顺带的好处：逻辑只有一份，桌面与后台不会各改各的；手机、网页和其他设备可以连接同一个后台。
底线：迁移过程中桌面版的行为不变。

现在所处的一步：自 2026-11-25 起处于阶段 0（收口）：已完成的独立修复走小 PR，现有分支和设计逐项归档。
之后先做云端常开的新部署，最后才迁移现有用户，各阶段的内容和完成标志见
[分阶段路线](headless-runtime-plan.md#分阶段路线2026-11-25-起)。
[个人版迁移放行表](personal-migration-release-table.md)暂停更新，作为阶段 5 的素材保留。

代码中的两个入口：

- **`cindy-host`**：按需启动的后台服务，提供任务、消息与模型调用等已接通的接口。
- **客户端**：浏览器复用现有 renderer，通过 HTTP/SSE API 使用 Host；Electron 连接 Host 是显式可选模式。

## 文档

| 文档 | 内容 |
|---|---|
| [自有电脑验证 Host](owned-machine-verification.md) | 三个平台的任务内工具链、Host 门禁，以及发布前的 macOS 文件监听和桌面测试 |
| [headless-runtime-plan.md](headless-runtime-plan.md) | 当前架构目标、分阶段路线、能力缺口、分批交付与完整无界面验收 |
| [phase0-sealed-work.md](phase0-sealed-work.md) | 阶段 0 封存清单：2026-11 封存的工作线、已证实的发现、已进入主线的独立修复与重启前提 |
| [architecture-and-status.md](architecture-and-status.md) | 原 PR 阶段的模块分析与实验记录；现状以基础网页版和当前计划为准 |
| [maintenance-plan.md](maintenance-plan.md) | PR #9246 合并后的维护计划与逐批验收边界 |
| [feature-parity.md](feature-parity.md) | 原 PR 阶段的逐项功能记录与审计，保留历史验证范围 |
| [personal-migration-release-table.md](personal-migration-release-table.md) | 个人版迁移放行表：每项应保留能力的现状、与桌面的差异和证据（M1 起随检查点更新） |
| [electron-client-mode.md](electron-client-mode.md) | Electron 以客户端模式运行：通道代理表、安全边界、未迁移清单 |
| [client-mode-account-switch.md](client-mode-account-switch.md) | 客户端模式下的账号切换与添加账号：定稿方案（Host 执行、窗口只当界面；安全小节、默认行为、改动与测试清单，未实现） |
| [channel-coverage.md](channel-coverage.md) | 脚本生成：桌面主进程全部 IPC 通道的归属（A 后台／B 窗口／W 窗口设置／S 同步／R 回执／C 待定）、要 Host 做的总数与真实使用排行、客户端模式行为 |
| [systemd.md](systemd.md) | user unit 安装与运维 |
| [maker-assembly-extraction-plan.md](maker-assembly-extraction-plan.md) | Runtime 装配抽离计划 |
| [evidence/](evidence) | 脱敏的端到端证据（阶段 2 / 阶段 4） |

## 快速开始

本地基础版试用优先使用 `pnpm preview:host`，它固定使用独立测试目录并自动打开浏览器。
首次登录与验收情况见 [本机试用](basic-web.md#本机试用2026-11-07)。下面是底层 Host 命令。

```bash
# 1) 启动 Host（首次可用 login 子命令复用现有 OAuth）
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_OWNER=<owner> pnpm start-host
#   单独登录：
node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts login --method=google

# 登录状态（脱敏，只输出 authenticated / realm）
node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts status --json

# 2) 浏览器客户端（Host 直接托管现有 renderer 构建产物）
pnpm --filter desktop exec vite build --config vite.renderer.config.ts
pnpm host:open

# 注意：渲染产物 apps/desktop/.vite/renderer/main_window 会被 Desktop 构建清理；
# Host 每收到请求时才解析该目录，重建后无需重启 Host。`pnpm dev:host` 会先补建它。

# 3) 显式选择 Electron 客户端模式：脚本复用已有 Host，没有则先拉起
pnpm dev:host -- --mock
#    也可以显式指定目标：
CINDY_HOST_API=http://127.0.0.1:3456 pnpm --filter desktop dev
```

企业内测使用中国区账号体系。用开发环境的桌面渲染产物构建 Host 时，在 `--region cn` 后加 `--dev-endpoints`，并通过 `--web-dir` 指定 dev 渲染目录。构建器将发布仓提供的 `config/endpoint.dev.json` 装入中国区配置，同时核对渲染环境以及认证、设备、模型和 CDN 的独立 HTTPS 地址。

用企业账号登录时，执行 `cindy-host login --org=<企业标识>`，会同时在国内区和国际区查找 SSO。一侧请求失败或超时、另一侧找到企业时，命令会说明本次使用的区域。两区都找到企业时，命令会提示加 `--region=cn` 或 `--region=global` 重试。已知企业区域时，可以直接指定，只查该区。用源码启动时，把相同参数加在上方 `login` 后，换掉个人账号示例里的 `--method=google`。详见[登录流程](architecture-and-status.md#登录流程阶段-2)。

## Linux 发布包

无图形 Linux 用的 Host 发布包由工作流 [Host release (Linux)](../../.github/workflows/host-release.yml) 构建。在 Actions 页手动运行，「Use workflow from」选要构建的发布标签，或用 `gh workflow run host-release.yml --ref v<版本>`。工作流构建它所在的那个提交，版本号取自标签，所以只能构建已经包含这条工作流的标签。从分支运行得到不带版本号的包。

- 每次运行在 Ubuntu 24.04 x64 上从同一个提交构建国内版和国际版，各自装入对应区域的网页客户端，内含 Node、Agent 运行时和 Chromium。两份都要先通过打包验收（`apps/host/scripts/release-region.e2e.mjs`）才会归档。
- 产物是 `cindy-host-<版本>-linux-x64-<cn|global>.tar.gz`，作为该次运行的 artifact 保留 90 天，用 `gh run download <运行编号>` 取回。工作流只读仓库，不写 GitHub Release 和 CDN；对外发布是另一步。
- 运行摘要列出提交、每个压缩包的 SHA-256，以及包内清单 `SHA256SUMS.json` 的 SHA-256。安装方按清单逐个文件校验，并固定清单本身的摘要；云主机的 Host 镜像用的就是这个摘要。
- 修改构建脚本或这个工作流的 PR 会自动构建一份不带版本号的包（文件名里是 `unversioned`，保留 7 天），用来在评审时发现构建问题。

## 当前边界

- Host 只监听 `127.0.0.1`，所有数据接口要求 profile bearer 或本机 cookie。
- Device Link 的项目目录浏览复用桌面 `fsBrowse` 的纯 Node 实现，支持 `fs:list-dir`、`fs:stat-path` 和 `fs:mkdir-p`；目录始终按执行端文件系统解析。`maker:send` 复用完整 turn executor，运行设置复用 Host 现有 sessions 路由。`maker:get-new-maker-defaults` 复用桌面默认值镜像，首次读取时从当前账号目录恢复草稿与 worktree 偏好，文件名为 `host-new-maker-defaults.json`，分支偏好复用桌面持久化。`maker:git-safety:get` 读取同一份 Git safety 设置，`maker:set-extra-dirs` 复用桌面授权校验、冲突排除和失败回滚。wire channel、payload 与 relay 不变，写操作在桌面占用 profile 时拒绝。回归入口：`apps/host/src/device-link.test.mjs`、`apps/host/src/agent/remote-draft-preferences.test.mjs`。
- Device Link 的远端新建 Worktree 流程支持 `worktree:detect-cwd`、`list-branches`、`suggest-name`、`create`、`discard-precreated` 和 `cancel-precreated`。Git 编排、分支冲突避让、后台 checkout 租约、脏改动/保留标记/活动引用保护、取消 tombstone 和分支删除 expected-tip 检查复用 Desktop 同一份 `WorktreeManager`；registry 使用同一 profile 的 `worktrees.json` 与跨进程锁。正式会话创建后回写 `sessions.worktree_path`，已落库或已有 live runtime 的会话拒绝补偿回收。这里不开放通用删除、主 checkout 切换或 archive/recovery，`supportsCheckout` 返回 false。回归入口：`apps/host/scripts/worktree-lifecycle.git-integration.mjs`（`pnpm --filter @cindy/host test:git-integration`）与 Desktop WorktreeManager/Store 测试。
- 当前已完成 macOS 上真实文本任务、刷新、停止、允许一次、Host 重启续接与受控事件断线恢复；
  手机、三平台实机与真实网络切换仍待验收，见 [本地人工验收](basic-web.md#本地人工验收2026-11-10)。
- Electron 客户端模式覆盖任务、消息、供应商、能力、Agent 命令/技能、输入队列、交互与告警；
  插件执行、MCP、scheduler、device-link、记忆/文件工具仍由 Desktop Runtime 承担（见上表 TODO）。

## 验证

```bash
pnpm --filter @cindy/host test          # Host 单元/集成测试
npx vitest run src/main/__tests__/hostDelegation.test.ts   # 客户端代理
pnpm --filter desktop run typecheck
```

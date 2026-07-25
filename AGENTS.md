# Cindy 客户端仓：Agent 工作入口

> 本文件是 Codex 与 Claude Code 共用的项目指令正本。`CLAUDE.md` 只保留
> `@AGENTS.md`，不要在两处重复维护规则。

## 仓库边界

- 本仓库只负责 desktop、mobile 及其共享 packages。
- 服务端位于独立仓库；除非用户明确要求，不要跨仓修改服务端。
- 开始工作前先检查工作区状态和相关源码，不覆盖、不回退用户已有改动。

## 规则组织

- 开发与工程规则统一放在 `docs/dev-rules/`。
- 产品行为与体验规则统一放在 `docs/product-rules/`。
- UI 视觉、交互与内容设计规则统一放在 `docs/design-rules/`，权威视觉规范正文为
  `docs/design-rules/DESIGN.md`（根目录 `DESIGN.md` 仅为跳转入口），目录索引为
  `docs/design-rules/cindy-design-system.md`。
- 根 `AGENTS.md` 只保留所有任务都适用的规则、风险入口和文档索引。
- 目录或模块专属规则优先放到对应目录的嵌套 `AGENTS.md`；需要跨目录复用的
  专题说明放在 `docs/`，并由本文件写明触发条件。

## 当前规则索引

- 首次接触本仓、需要定位功能代码位置或判断新代码归属模块时，先读仓库地图
  `docs/dev-rules/repo-map.md`。
- 首次安装、修复依赖或准备新 worktree 时，必须先读
  `docs/dev-rules/environment-setup.md`。
- 启动、调试或验证 Desktop 时，必须先读 `docs/dev-rules/desktop-development.md`。
- 修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、导航或 Electron
  特权能力前，必须先读 `docs/dev-rules/electron-security-and-process-boundaries.md`。
- 修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件或测试目录前，必须
  先读 `docs/dev-rules/credentials-and-local-storage.md`。
- 新增或修改媒体生成、导入、缓存、附件、持久化、协议解析或回收逻辑前，必须先读
  `docs/dev-rules/media-storage-and-protocols.md`。
- 修改 Desktop 数据库 schema、migration、companion script 或运行期数据库访问前，必须
  先读 `docs/dev-rules/database-and-migrations.md`。
- 开发、调试或验证 Mobile 时，必须先读 `docs/dev-rules/mobile-development.md`。
- 新增或调整产品功能、判断能力应进入 Core / Skill / 插件、设计人机交互或多端体验
  前，必须先读 `docs/product-rules/core-product-principles.md`。
- 新增或修改任何界面、组件、布局、样式、动效或 UI 文案前，必须先读权威设计规范
  `docs/design-rules/DESIGN.md`；设计文档索引见
  `docs/design-rules/cindy-design-system.md`。
- 所有新增或修改的 UI 必须同时完成 Light 与 Dark 两种模式；只实现或只验证一种模式，
  视为未完成。具体实现与验收要求以 `docs/design-rules/DESIGN.md` 的双模式交付门槛
  为准。
- 修改 Orca 多 Agent 协同时，必须先读
  `docs/dev-rules/orca-team-architecture.md`。
- 修改 `packages/maker-core` 的 Agent 编排、prompt 组装、tool／MCP 暴露、translator、
  model 映射、usage 计量，或任何进入模型 system 段的提示词前，必须先读
  `docs/dev-rules/maker-core-and-agent-behavior.md`。
- 修改插件（`.cindy`）运行时、沙箱、权限、能力 slot、面板供片、网络／凭证／文件交接，
  或身份卡、管子协议、打包与编写手册前，必须先读
  `docs/dev-rules/plugin-security-and-authoring.md`。
- 修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）前，必须先读
  `docs/dev-rules/cindy-updater.md`。
- 新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、跨平台（macOS／
  Windows）行为，或任何 UI 文案的 i18n 落地前，必须先读
  `docs/dev-rules/engineering-conventions.md`。
- 升级 `cindy-protocol`、修改插件分发来源边界或 device-link 协议／relay／隧道
  payload／IPC allowlist，或任何改动跨端 wire protocol 前，必须先读
  `docs/dev-rules/protocol-and-submodules.md`。
- 修改 package 依赖方向、main 进程模块加载方式，或主界面布局树结构前，必须先读
  `docs/dev-rules/architecture-invariants.md`。
- 新增或修改 Settings UI、配置文件、本地偏好、运行时 profile，或 agent／MCP／provider
  开关前，必须先读 `docs/dev-rules/configuration-and-overrides.md`。
- 新增或修改涉及 workdir 文件、agent 进程、会话数据的功能，或新增 IPC channel／推送事件
  前，必须先读 `docs/dev-rules/remote-and-mobile-adaptation.md`。
- 在 Cindy 内嵌 worktree 会话里工作、准备提交或直推、或做 code review 前，必须先读
  `docs/dev-rules/development-workflow.md`。

## 通用工作流程

1. 先确认用户目标、仓库边界、当前分支、worktree 和工作区状态。
2. 尊重开发者或宿主已经提供的 Git 工作流。已有任务分支或 worktree 时直接复用，
   不嵌套创建；没有隔离方案时，可以建议新功能使用独立分支或 worktree，但不要
   擅自搬动或混用现有工作区。
3. 根据任务类型读取 `docs/dev-rules/`、`docs/product-rules/` 与
   `docs/design-rules/` 中相关规则。
4. 先读实际代码和测试，再决定实现；不要只依赖文档猜测现状。
5. 修改时保持范围最小，保护用户已有改动，不使用破坏性 Git 命令。
6. 完成后运行与风险匹配的检查，并 review 整体 diff。
7. 如实报告已验证、未验证、风险和需要用户决定的事项。

## Git 与交付

- 本仓默认 PR-first。代码和文档通常从非默认分支通过 PR 进入 `main`；只有仓库
  维护者明确选择例外时才允许直推主干。
- commit、push 和创建 PR 的执行时机由开发者或 Codex、Claude Code、Cindy 等宿主
  工作流决定；仓库规则本身不额外授权外部写操作。
- 提交 PR 时遵循 `.github/PULL_REQUEST_TEMPLATE.md`，如实说明改动、验证和风险。
- **DCO 签名（硬性要求）**：本仓每个 commit 都必须带 `Signed-off-by` trailer，且其中的
  名字与邮箱都要与 commit 的 author（或 committer）一致，用 `git commit -s` 生成；
  agent 的自动提交同样适用。PR 上的 DCO check（DCO GitHub App，配置见
  `.github/dco.yml`）会拦下漏签的 commit。`git commit` 没有自动签名的配置项，一次配好
  可跑 `pnpm dco:install-hook` 装 `.githooks/prepare-commit-msg`；提交前自查用
  `pnpm check:dco`。DCO 全文见根目录 `DCO`，贡献者说明见 `CONTRIBUTING.md`。
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地
  跑完仓库根 `pnpm test:unit`（全部单元测试），并对本次改动涉及的每个 package 跑
  `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。细则与唯一例外（防丢数据的兜底保存）见
  `docs/dev-rules/development-workflow.md`。
- 在上述门禁之上按风险追加验证：跨模块、高风险或基础设施改动追加更广泛验证（如
  `pnpm test:all`），最终以 CI 门禁为准。不得通过跳过、删除或弱化测试制造通过。

## 绝对安全底线

- 用户凭证、令牌、授权文件和密钥不得写入仓库或任何可能被 Git 跟踪的路径。
- 未经用户明确授权，不执行删除数据、覆盖改动、推送、发布、合并等外部或难以
  恢复的操作。
- 发现任务会触及系统提示词、更新器、协议兼容、数据库历史 migration、权限边界
  或用户数据安全时，必须先停下来核对专项规则，并在动手前向用户说明风险或
  请求确认。

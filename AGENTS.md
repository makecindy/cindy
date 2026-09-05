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
- 新增模型、更新模型窗口／价格／推理档位／默认值，或排查模型信息显示错误前，必须先读
  `docs/dev-rules/model-catalog-maintenance.md`：先确认实际下发目录与数据归属；Server
  目录和客户端内置兜底需协调更新，不能只改本仓快照就认定线上已生效。
- 启动、调试或验证 Desktop 时，必须先读 `docs/dev-rules/desktop-development.md`。
- 修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、导航或 Electron
  特权能力前，必须先读 `docs/dev-rules/electron-security-and-process-boundaries.md`。
- 新增或修改 Desktop 独立窗口、辅助窗口或弹出型 `BrowserWindow` 前，必须遵守
  `docs/dev-rules/electron-security-and-process-boundaries.md` 的「独立辅助窗口统一生命周期
  基线」：复用既有控制器／基础设施，不得另造平行的预热、就绪握手、隐藏复用与崩溃恢复
  状态机。
- 修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件或测试目录前，必须
  先读 `docs/dev-rules/credentials-and-local-storage.md`。
- 新增或修改媒体生成、导入、缓存、附件、持久化、协议解析或回收逻辑前，必须先读
  `docs/dev-rules/media-storage-and-protocols.md`。
- 修改 Desktop 数据库 schema、migration、companion script 或运行期数据库访问前，必须
  先读 `docs/dev-rules/database-and-migrations.md`。
- 开发、调试或验证 Mobile 时，必须先读 `docs/dev-rules/mobile-development.md`。
- 修改 `apps/mobile` 的原生配置、原生依赖、config plugin 或原生模块（`app.json`、
  `app.config.js`、`eas.json`、`apps/mobile/package.json`、`plugins/`、`modules/` 等会
  进入 runtime fingerprint 的输入）前，必须先读 `docs/dev-rules/mobile-development.md`
  的「冷更边界」：**除非必要，不得提交会改变指纹的改动**；会触发冷更的 PR 与技术框架
  变动同级，必须由仓库指定的把关人针对冷更明确确认后才能合并——不看改动大小，也不看谁
  提的，提交者身份不构成例外。
- 新增或调整产品功能、判断能力应进入 Core / Skill / 插件、设计人机交互或多端体验
  前，必须先读 `docs/product-rules/core-product-principles.md`。
- 新增或修改 `/review`、Reviewer 任务、成果快照、Finding 协议、复核入口、结果呈现或
  复核生命周期前，必须先读 `docs/product-rules/review-product-direction.md`。
- 新增或修改按区域（`cn` / `global`）分支的逻辑、构建身份与命名、端点选择、区域相关
  UI 标注，或涉及两个版本关系的对外文案前，必须先读
  `docs/product-rules/region-and-editions.md`：**无限定词身份归 Global，未显式指定
  区域一律落在 `global`，只标注中国大陆版**。
- 新增或修改任何界面、组件、布局、样式、动效或 UI 文案前，必须先读权威设计规范
  `docs/design-rules/DESIGN.md`；设计文档索引见
  `docs/design-rules/cindy-design-system.md`。
- 新增或修改设计 Token、主题系统、标准 UI 组件（primitive / pattern）、视觉类门禁脚本，
  或参与设计系统迁移 PR 前，必须先读治理合同
  `docs/design-rules/design-governance.md`：真相源边界、兼容红线、两级证据合同与
  PR 风险分类均以它为准；视觉规则本身仍以 `DESIGN.md` 为准。
- 新增或修改任何 UI 文案里的**产品术语**前，必须先查术语表 `i18n/GLOSSARY.md`：已裁决
  的术语照用，不自造译法；表里没有或拿不准的，在 `i18n/glossary.json` 加
  `status: "proposed"` 条目再讨论。门禁为 `pnpm check:i18n-glossary`，规则见
  `docs/dev-rules/engineering-conventions.md` §5.1。
- 新增或修改**任一 Telegram bot 的用户可见行为**（命令、消息呈现、收口策略、群行为、
  权限口径、附件与表情）前，必须先读能力台账 `docs/product-rules/telegram-bot-parity.md`：
  两个 bot 是两套架构，差异可以有但必须登记在表里；表里标「有意不同」的行**不要去
  "统一"**，动它要先推翻对应裁决。改完记得把对应行写回去。
- 文案里出现**任务 / 对话 / 消息**这几个词时，必须先读
  `docs/product-rules/task-and-conversation-naming.md`：`session` 面向用户叫「任务」，
  「对话」只用于任务内的交流过程与内容，单条往来叫「消息」；**「任务」与 `task` 同句出现
  时必须消解歧义**。这三个词的边界拿不准会直接做出用户能看见的不一致。
- 所有新增或修改的 UI 必须同时**实现** Light 与 Dark 两种模式（颜色一律走语义 token，
  禁止只适配一种模式的硬编码或条件补丁）；只实现一种模式视为未完成。**两种模式的实机
  目检不是硬性门槛**——能目检更好，做不到时如实写明哪种模式未验证，不得把「复用了 themed
  样式」当成「双模式已验证」。具体要求以 `docs/design-rules/DESIGN.md` 的双模式交付门槛
  为准。
- 修改 Orca 多 Agent 协同时，必须先读
  `docs/dev-rules/orca-team-architecture.md`。
- 修改 `packages/maker-core` 的 Agent 编排、prompt 组装、tool／MCP 暴露、translator、
  model 映射、usage 计量，或任何进入模型 system 段的提示词前，必须先读
  `docs/dev-rules/maker-core-and-agent-behavior.md`。
- 修改 PI harness 集成（`packages/maker-core/src/agents/pi/**`、`pi-host.ts`、
  `piEnvironment.ts`）、PI 会话权限／配置／system prompt／桥接，或 PI 相关的上线判断前，
  必须先读 `docs/dev-rules/pi-harness.md`（含设计原则、维护不变量与上线清单）。其中
  **Pi 原生能力非退化是红线**：Pi 原生允许的安装、更新、扩展加载与 Agent 自助修复，Cindy
  不得以静态分析、TUI／RPC 兼容提示、内容指纹、宿主审批或新增的“安全增强”为由拒绝、停用
  或变成不可逆流程；显式用户命令即授权。Cindy 只能增加可跳过的提示和更顺畅的 GUI，不能让
  Cindy Pi 比同版本原生 Pi 更难用。完整裁决见 `docs/dev-rules/pi-harness.md`「Pi 上游 GUI
  非退化红线」。
- 修改插件（`.cindy`）运行时、沙箱、权限、能力 slot、面板供片、网络／凭证／文件交接，
  或身份卡、管子协议、打包与编写手册前，必须先读
  `docs/dev-rules/plugin-security-and-authoring.md`。其中**存量插件兼容是红线**：任何
  插件系统改动（含批准状态 schema、指纹格式、manifest 校验、安装布局、包格式）都必须
  向下兼容——用户升级后什么都不做，已装、已批准、已启用的插件必须照旧可用，**绝不允许
  要求用户重新安装、重新确认权限或重新配置**。做不到就必须自带从旧版数据的自动迁移；
  自动迁移也做不到时，必须有明确提示 + 一次性批量恢复入口，且不丢用户已存的凭证与偏好。
  漏迁移 = P0，规则正文见该文件第 5 节。**改到插件基座**（运行时／沙箱、批准状态记录、
  能力 slot、打包与内容判据、manifest 契约、装入与权限确认 UI、已装列表投影）的 PR 一律
  走白名单确认门，需放行人明确 Approve 才能合并，不看 diff 大小、不因「是 bugfix／纯技术
  改动」豁免。
- 修改插件发现链（花名册注入、`ghost_list` / `ghost_info` / `ghost_call`）、插件运行期
  可见性门禁或 FORGE_GUIDE 作者契约前，必须先读 `docs/ghost-progressive-discovery.md`。
- 新增或修改插件持久 Library（library 槽、binding / 目录选择、随时迁移、
  回收站删除、SQLite 语句门或 `/library/` 面板投影）前，必须先读
  `docs/dev-rules/plugin-library-storage.md`。
- 修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）前，必须先读
  `docs/dev-rules/cindy-updater.md`。
- 新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、跨平台（macOS／
  Windows）行为，或任何 UI 文案的 i18n 落地前，必须先读
  `docs/dev-rules/engineering-conventions.md`。
- 修改客户端日志采集／脱敏／上报链路（`apps/desktop/src/main/log-upload/**`）、`logger.ts`
  的 main 日志行格式、崩溃判定或待补传标记前，必须先读
  `docs/dev-rules/log-upload-and-redaction.md`。其中三条是**不变量**：**记录边界**（写侧
  续行转义与读侧切分是同一条不变量的两半，破坏任一侧即隐私逃逸）、**白名单方向**
  （deny-by-default，不得改成黑名单——调试级别的功能日志是用户内容的主要泄漏源）、
  **标记代次 + 原子清除**（并发实例下仅靠时间戳会误删另一实例刚写的新崩溃标记）。
  脱敏规则**只增不减**，放宽任一条视为隐私变更、需重新评审。
- 修改本地协议 package、插件分发来源边界或 device-link 协议／relay／隧道
  payload／IPC allowlist，或任何改动跨端 wire protocol 前，必须先读
  `docs/dev-rules/protocol-compatibility.md`。
- 修改 package 依赖方向、main 进程模块加载方式，或主界面布局树结构前，必须先读
  `docs/dev-rules/architecture-invariants.md`。
- 新增或修改 Settings UI、配置文件、本地偏好、运行时 profile，或 agent／MCP／provider
  开关前，必须先读 `docs/dev-rules/configuration-and-overrides.md`。
- 新增或修改涉及 workdir 文件、agent 进程、会话数据的功能，新增 IPC channel／推送事件，
  或修改 device-link 的重试／超时／断链恢复逻辑前，必须先读
  `docs/dev-rules/remote-and-mobile-adaptation.md`；其中恢复路径改动必须回答该文件的
  「故障半径三问」。
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
- 非 fork 的非 draft PR 会触发自动 code review（`.github/workflows/pr-code-review.yml`），
  审阅口径见根目录 `REVIEW.md`。它是**建议性**检查，不替代人工 review，也不替代
  `client-ci` 的机器门禁；改动上述两份文件前先读 `REVIEW.md` 开头的说明。
- **DCO 签名（硬性要求）**：本仓每个 commit 都必须带 `Signed-off-by` trailer，且其中的
  名字与邮箱都要与 commit 的 author（或 committer）一致，用 `git commit -s` 生成；
  agent 的自动提交同样适用。PR 上的 DCO check（DCO GitHub App，配置见
  `.github/dco.yml`）会拦下漏签的 commit。`git commit` 没有自动签名的配置项，一次配好
  可跑 `pnpm dco:install-hook` 装 `.githooks/prepare-commit-msg`；提交前自查用
  `pnpm check:dco`。DCO 全文见根目录 `DCO`，贡献者说明见 `CONTRIBUTING.md`。
  对自动 code review 环境的说明：review 沙箱 checkout 出的 HEAD 可能是平台合成的
  瞬时 commit（不存在于本仓库、GitHub 上查不到该 SHA）；对这类合成 SHA 跑
  `check:dco` 的失败结果不构成缺签证据，不要据此报告 DCO 问题。判定 DCO 是否通过，
  一律以 PR 上的 DCO App check 与真实提交范围（`origin/main..PR head`）的结果为准。
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地
  跑完仓库根 `pnpm test:unit:related`（只跑这次改动能影响到的单测；改到测试调度、
  依赖清单、workspace 配置、Vitest 配置或单测 CI 时会自动退回全量 `pnpm test:unit`），
  并对本次改动涉及的每个 package 跑
  `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。GitHub CI 仍跑完整 `pnpm test:unit`。细则与唯一例外（防丢数据的兜底保存）见
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

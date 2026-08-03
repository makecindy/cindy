# Docs 规范索引

本索引用于发现 `docs/` 下仍保留的产品规则、设计规则、开发规则、运维与合规文档。

**状态含义**：`authoritative` = 权威、对治理模块有约束力；`参考` = 设计 / 记录 / spike，非约束、仅供背景参考（不区分是否完成，要看正文）。

| 文档 | 类型 | 状态 | 治理/相关代码 | owner |
|---|---|---|---|---|
| [README.md](./README.md) | 索引 | — | `docs/` 文档目录 | — |
| [product-rules/README.md](./product-rules/README.md) | 产品规则索引 | authoritative | Cindy 产品行为、体验与边界 | — |
| [core-product-principles.md](./product-rules/core-product-principles.md) | 产品原则 | authoritative | Cindy Core、Agent、Skill、插件与多端产品边界 | — |
| [design-rules/README.md](./design-rules/README.md) | 设计规则索引 | authoritative | Cindy UI 视觉、交互与内容设计 | — |
| [design-rules/DESIGN.md](design-rules/DESIGN.md) | 设计规范 | authoritative | Desktop 与 Mobile 的视觉语言、Token、组件和交互约定 | — |
| [dev-rules/README.md](./dev-rules/README.md) | 开发规则索引 | authoritative | Cindy 客户端工程规则 | — |
| [environment-setup.md](./dev-rules/environment-setup.md) | 开发环境 | authoritative | 公共依赖、submodule 与首次安装 | — |
| [desktop-development.md](./dev-rules/desktop-development.md) | Desktop 开发规则 | authoritative | Desktop 启动、重启与验证 | — |
| [electron-security-and-process-boundaries.md](./dev-rules/electron-security-and-process-boundaries.md) | Electron 安全规则 | authoritative | Renderer、preload、BrowserWindow、WebView、IPC、CSP 与进程边界 | — |
| [credentials-and-local-storage.md](./dev-rules/credentials-and-local-storage.md) | 本地数据安全规则 | authoritative | 凭证、用户持久数据、临时文件与测试目录 | — |
| [media-storage-and-protocols.md](./dev-rules/media-storage-and-protocols.md) | 媒体存储规则 | authoritative | Desktop 媒体入库、协议、引用与回收 | — |
| [database-and-migrations.md](./dev-rules/database-and-migrations.md) | 数据库规则 | authoritative | Desktop SQLite schema、migration、companion 与运行期访问 | — |
| [mobile-development.md](./dev-rules/mobile-development.md) | Mobile 开发规则 | authoritative | Mobile 模拟器、验证与专项入口 | — |
| [orca-team-architecture.md](./dev-rules/orca-team-architecture.md) | 契约/规范 | authoritative | `apps/desktop` 的 `maker-ipc/orca*` 服务 + `mcp-integrations` codex MCP、`packages/lizi-mcps` 的 `orca`、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context | — |
| [maker-core-and-agent-behavior.md](./dev-rules/maker-core-and-agent-behavior.md) | maker-core 规则 | authoritative | `packages/maker-core` 的 Agent 编排、prompt 组装、translator、model 映射、缓存率/性能/准确性指标与 system prompt 门禁 | — |
| [plugin-security-and-authoring.md](./dev-rules/plugin-security-and-authoring.md) | 插件安全规则 | authoritative | 插件（`.cindy`）运行时沙箱、权限 slot、网络/凭证/资源交接、存量插件向下兼容与无感升级、作者契约与编写手册同步 | — |
| [cindy-updater.md](./dev-rules/cindy-updater.md) | 更新器规则 | authoritative | 客户端自动更新链路（`cindy-updater` + Electron 更新服务）的 owner 确认门禁 | — |
| [engineering-conventions.md](./dev-rules/engineering-conventions.md) | 通用工程规范 | authoritative | Desktop 日志、IPC 错误协议、main 侧测试、跨平台双端兼容与 UI 文案 i18n | — |
| [protocol-and-submodules.md](./dev-rules/protocol-and-submodules.md) | 协议/submodule 规则 | authoritative | `cindy-protocol` 权威源、device-link relay 层、内建插件来源与 wire protocol 兼容 | — |
| [architecture-invariants.md](./dev-rules/architecture-invariants.md) | 架构不变量 | authoritative | package 解耦、main 静态依赖、主界面布局树（`layoutTree`/`LayoutStore`/panel registry） | — |
| [configuration-and-overrides.md](./dev-rules/configuration-and-overrides.md) | 配置契约 | authoritative | 配置可见性分层、默认值+override 分离、迁移与恢复默认语义 | — |
| [remote-and-mobile-adaptation.md](./dev-rules/remote-and-mobile-adaptation.md) | 远程/手机版门禁 | authoritative | SSH 远程工作区、device-link allowlist、`apps/mobile` 入口与功能类 PR 三选一门禁 | — |
| [development-workflow.md](./dev-rules/development-workflow.md) | 开发工作流 | authoritative | worktree dogfooding 契约、提 PR/直推 main 门禁、Review P0/P1/P2 口径 | — |
| [plugin-setup-runtime.md](./plugin-setup-runtime.md) | 技术设计 | 参考 | `ghost_list` / `ghost_call` 插件配置前置检查、Ask-shell Setup 卡片、配置变更回调与原调用恢复 | — |
| [desktop-login-hosted-callback.md](./desktop-login-hosted-callback.md) | 跨仓契约 | 参考 | Desktop 系统浏览器登录的托管回调链路：auth-server 路由契约、结果页模板交付、灰度开关与回滚 | — |
| [auth-realm-routing.md](./auth-realm-routing.md) | 跨仓契约 | 参考 | 组织 SSO 双区域发现、会话区域持久化与 token 消费端点路由 | — |
| [legal/README.md](./legal/README.md) | 法律/合规索引 | authoritative | 法律合规资料归档边界与固定路径例外 | — |
| [legal/notices/README.md](./legal/notices/README.md) | 第三方许可/SBOM | generated | `pnpm licenses:generate`、Desktop/Mobile 随包声明 | — |

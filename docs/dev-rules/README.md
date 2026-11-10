# 工程专题

[架构原则](architecture-invariants.md)解释职责与状态如何划分，下列文档保存具体契约与操作
入口。修改相关路径前先读正文，涉及专项确认的变更尤其如此。模块内约束就近写在嵌套
`AGENTS.md` 或实现旁，跨模块契约在这里维护，不两处复述。

文档保留产品特有的工程选择、原因与契约，验证由类型、测试和脚本负责；整理原则见
[开发工作流](development-workflow.md) §5，测试的价值与预算见工程约定。

| 主题 | 正文 |
| --- | --- |
| Desktop、Mobile、maker-core 模块内的触发条件 | [Desktop](../../apps/desktop/AGENTS.md)、[Mobile](../../apps/mobile/AGENTS.md)、[maker-core](../../packages/maker-core/AGENTS.md) 的嵌套 AGENTS.md；专题正文不在模块内重复 |
| 目录职责、按用户行为定位公共入口与测试、开发环境 | [仓库地图](repo-map.md)、[环境准备](environment-setup.md) |
| 通用个人开发版：组合自己的 PR、插件源码与验证报告 | [个人开发版脚本](personal-build.md) |
| 已发生过的任务体验回归、测试入口与运行命令 | [任务回归台账](session-regressions.md) |
| Desktop 启动、重启与验证 | [桌面开发](desktop-development.md) |
| 免登录 UI 模拟数据、`--mock` 启动、数据正本与写入边界 | [UI 模拟数据](ui-mock-data.md) |
| Mobile 开发、模拟器、原生配置／依赖与冷更边界 | [手机开发](mobile-development.md) |
| Renderer、preload、窗口、IPC、CSP 与特权边界 | [Electron 进程边界](electron-security-and-process-boundaries.md) |
| 凭证、持久数据、临时文件与测试目录 | [本地存储](credentials-and-local-storage.md) |
| 媒体生成、导入、附件、缓存、协议与回收 | [媒体存储](media-storage-and-protocols.md) |
| Browser Use 工具层、配方目录、外链处理与三种浏览器后端 | [Browser Use](browser-use.md) |
| 数据库 schema、migration、companion 与运行期访问 | [数据库](database-and-migrations.md) |
| 模型配置架构、下发、覆盖、价格与默认值 | [模型配置入口](model-catalog-maintenance.md)、[运行细则](model-catalog-runtime.md) |
| Agent 编排、prompt、tool / MCP、事件、model 映射与 usage | [maker-core 与 system prompt 确认](maker-core-and-agent-behavior.md) |
| Pi 集成、权限、配置、桥接与原生能力非退化 | [Pi harness](pi-harness.md) |
| Orca 多 Agent 协同 | [Orca 架构](orca-team-architecture.md) |
| 个人 IM 与官方 hook 的入站、排队、插话、交互与收尾 | [IM 轮次](im-turn-flow.md) |
| 插件基座、沙箱、权限、slot、打包、manifest、安装与作者契约 | [插件安全、兼容与合并确认](plugin-security-and-authoring.md) |
| 插件花名册、ghost 发现链、可见性与作者契约 | [渐进式发现](../ghost-progressive-discovery.md) |
| 插件持久 Library、binding、迁移、回收站与面板投影 | [插件 Library](plugin-library-storage.md) |
| 客户端自动更新 | [更新器与 owner 确认](cindy-updater.md) |
| 日志、IPC 错误、main 业务、测试价值／性能预算、跨平台与 i18n | [工程约定](engineering-conventions.md) |
| 日志采集、脱敏、上报、行格式与崩溃标记 | [日志上报](log-upload-and-redaction.md) |
| 本地协议包、插件分发来源、device-link、relay、wire protocol 与 allowlist | [协议兼容](protocol-compatibility.md) |
| 服务器请求、订阅、同步、轮询与重试的调用方式、共享压力及缺陷审查 | [服务器通道调用审查](server-channel-review.md) |
| package 依赖、Main 模块加载、共用主体与桌面／Host 装配、布局树 | [架构原则与不变量](architecture-invariants.md) |
| Settings、配置文件、偏好、运行时 profile 与能力开关 | [配置与 override](configuration-and-overrides.md) |
| workdir、Agent 进程、任务数据、IPC／推送与断链恢复 | [远程与手机适配](remote-and-mobile-adaptation.md) |
| 托管 worktree、提交、PR、直推、review、项目知识归属与文档整理原则 | [开发工作流](development-workflow.md) |

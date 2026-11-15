# Desktop：Agent 工作入口

本文件适用于 `apps/desktop/`；[根 AGENTS](../../AGENTS.md) 的跨仓、数据、授权、
插件兼容、协议与交付规则仍然适用。本文只维护模块触发条件，专题正文继续使用同一正本。
代码、共享判据与测试入口见[仓库地图](../../docs/dev-rules/repo-map.md#按用户行为定位)。

## 开发与进程边界

- 启动、调试或验证 Desktop 时，必须先读[Desktop 开发](../../docs/dev-rules/desktop-development.md)。
- 修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、导航或 Electron
  特权能力前，必须先读[Electron 安全与进程边界](../../docs/dev-rules/electron-security-and-process-boundaries.md)。
- 新增或修改 Desktop 独立窗口、辅助窗口或弹出型 `BrowserWindow` 前，必须遵守
  [Electron 安全与进程边界](../../docs/dev-rules/electron-security-and-process-boundaries.md)的「独立辅助窗口统一生命周期
  基线」：复用既有控制器／基础设施，不得另造平行的预热、就绪握手、隐藏复用与崩溃恢复
  状态机。
- 修改 Desktop 数据库 schema、migration、companion script 或运行期数据库访问前，必须
  先读[数据库与迁移](../../docs/dev-rules/database-and-migrations.md)。

## 界面与渠道

- 改完 Desktop renderer 界面（组件、样式、布局、文案、深浅色、多语言）后自检，先运行
  `pnpm ui:check --changed --theme all` 并查看输出的 `overview.png`，无需为此启动完整
  Desktop；输出中 `UNCOVERED` 的文件未被验证。发 PR 时运行 `pnpm ui:check:publish`，把输出的
  带图内容写进「UI 变化」。按改动类型选择验证方式见
  [Desktop 开发](../../docs/dev-rules/desktop-development.md)「按改动选择验证方式」。
- 修改个人 IM 渠道（`src/main/im/**`）或官方 hook（`src/main/hook-control/**`）的
  找/建任务、命令、排队与插话、输入拼装、事件观察、交互、收尾或停止逻辑前，必须先读
  [IM 轮次流程](../../docs/dev-rules/im-turn-flow.md)（入口账本、状态清单、不变量与迁移批次）。

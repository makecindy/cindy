---
name: cindy-plugin-creator
description: Create, edit, debug, package, or publish Cindy plugins (.cindy packages with ghost.json). Use for plugin authoring and host API questions; not for creating standalone Skills or simply using an installed plugin.
metadata:
  short-description: Create or update a Cindy plugin
---

# Cindy Plugin Creator

Build a Cindy plugin from the user's request, or update an existing plugin. This Skill and its references are the authoring documentation shipped with the current Cindy host. Start by identifying the plugin's execution host and pinning its source to a verified tag or commit; use the shipped contracts and matching source together. Keep the user's language for discussion.

## Workflow

1. Read [host version and source verification](references/plugin-source-verification.md). Identify the Cindy computer that will execute the plugin, obtain its version through available read-only host information, and resolve that release's tag or the build's source commit in the official repository. Inspect the relevant public API and its host implementation at that exact commit before relying on a capability. Do not substitute latest main or an unrelated local checkout. If the version or source cannot be verified, follow the reference's fallback and state the limitation.
2. Read the [authoring overview](references/plugin-overview.md), [design alignment](references/plugin-design.md), [structure](references/plugin-structure.md), and [manifest and capabilities](references/plugin-manifest.md). For an existing plugin, inspect its ghost.json and source first. Ask only about decisions the request leaves open; use option cards when available. Summarize the intended behavior, UI, permissions and acceptance criteria before implementation, following the design reference.
3. Before writing code, read the [sandbox boundaries](references/plugin-sandbox.md) and [packaging workflow](references/plugin-packaging.md). Read the capability references below as needed; do not load the whole manual at once.
4. For a new plugin, prefer ghost_forge_scaffold with the appropriate plain, agent-action, node-json-rpc or node-mcp template, then edit the generated files. For an existing plugin, preserve its identity, data and compatible behavior. Use schemaVersion: 3 for new manifests and declare the first stable Cindy version actually required.
5. Implement and validate the requested behavior, including Light and Dark modes for any UI. Separate current Agent tool-call operations from autonomous plugin capabilities, as described in the manifest and Agent-call references. Use [tool discovery](references/plugin-tool-discovery.md) and [manuals](references/plugin-manual.md) for authoring the plugin's own discovery and workflow documentation.
6. Call ghost_forge_pack to validate and produce the .cindy artifact. Report what was tested and what remains unverified. Packaging does not install or publish: use ghost_forge_install only when installation is requested, and follow [public marketplace publication and attribution (§7.3–7.4)](references/plugin-packaging.md) for community publication, or [publishing signatures and review (§8)](references/plugin-publishing.md) as applicable. Read the releaseNotes contract in [manifest (§2)](references/plugin-manifest.md) before submitting a version.

Cindy supplies the Forge tools. If they are unavailable in the current environment, explain the missing capability and continue any local source work that is possible; do not claim to have packaged, installed or published. The legacy ghost_forge_guide tool serves these same references by section number or title when needed. It is a compatibility entry point, not a second source of documentation.

## Reference index

These references describe Cindy plugin contracts and host APIs available to plugins. Read only the topics needed for the plugin being built. Existing section numbers are preserved for ghost_forge_guide callers and cross-references; files are named by plugin capability rather than reading order.

### 插件基础与工具设计

Start here to define the plugin's behavior, package and Agent-facing tools.

- [先按宿主版本定位开源源码：tag / commit（§0a）](references/plugin-source-verification.md)
- [插件创作总览](references/plugin-overview.md)
- [插件需求与交互设计（§0）](references/plugin-design.md)
- [插件源码与包目录结构（§1）](references/plugin-structure.md)
- [插件身份卡与能力声明 ghost.json（§2）](references/plugin-manifest.md)
- [插件工具定义 tools（§3）](references/plugin-tools.md)
- [插件工具发现与两段式目录（§3.5）](references/plugin-tool-discovery.md)
- [插件使用手册 manual（§3.6）](references/plugin-manual.md)

### 插件运行与宿主接口

Use when implementing plugin code, calling host APIs or declaring access to resources.

- [插件后台 main.js 与基础模型调用（§4）](references/plugin-runtime.md)
- [插件沙箱边界（§6）](references/plugin-sandbox.md)
- [插件读取宿主公开上下文（§4.1）](references/plugin-host-context.md)
- [插件处理 Agent 在途调用：网络与工作目录（§4.2）](references/plugin-agent-call-context.md)
- [插件读取可用 Agent 模型列表（§4.0.3a）](references/plugin-agent-models.md)
- [插件打开宿主统一模型选择器 pickModel（§4.0.3b）](references/plugin-agent-models.md)
- [插件接入媒体模型与生成结果（§4.0.4）](references/plugin-media.md)
- [插件联网与凭证代发 network（§4.7）](references/plugin-network.md)
- [插件文件操作与持久作品库 fs / library（§4.10）](references/plugin-files-and-library.md)
- [插件随包 Node 工作进程、CLI 与 stdio MCP（§4.12）](references/plugin-node-worker.md)

### 插件界面与用户交互

Use for the UI surfaces and interactions the plugin actually exposes; mobile pages are optional.

- [插件交互页面：生成首屏、SDK 交互与完整示例（§4.23）](references/plugin-interactive-pages.md)
- [插件面板与主题适配（§5）](references/plugin-panels.md)
- [官方视频播放器内嵌（新增接口，尚未发布）](references/plugin-video-player.md)
- [插件一级主视图 mainView（§4.20）](references/plugin-main-view.md)
- [插件跟对话的任务页 taskView（§4.22）](references/plugin-task-view.md)
- [插件移动端页面接入与操作来源（§5.1）](references/plugin-mobile-pages.md)
- [插件聊天卡片 card（§4.5）](references/plugin-chat-cards.md)
- [插件设置页与自定义参数 settingsHtml / kv（§4.8）](references/plugin-settings.md)
- [插件轻提示与未读角标 notify / badge（§4.9）](references/plugin-notifications.md)
- [插件目录选择 pick（§4.14）](references/plugin-directory-picker.md)
- [插件面板预览 preview（§4.15）](references/plugin-panel-preview.md)
- [插件随包浏览器扩展 browserExtension（§4.23）](references/plugin-browser-extension.md)
- [插件确认弹窗 confirm（§4.18）](references/plugin-confirm-dialog.md)
- [插件推荐任务（§4.21）](references/plugin-recommendations.md)

### 插件事件与任务协作

Use when the plugin listens for events, supplies routine triggers or interacts with Agent tasks.

- [插件提交例行任务事件 routineEvents](references/plugin-routine-events.md)
- [插件事件订阅 subscribe（§4.6）](references/plugin-event-subscriptions.md)
- [插件处理 Agent 回复的消息钩子（§4.6.1）](references/plugin-message-hooks.md)
- [插件控制节点：自动化与例行任务运行前先问插件（§4.6.2）](references/plugin-control-points.md)
- [插件发起 Agent 任务与请求自动化（§4.11）](references/plugin-agent-tasks.md)
- [插件读取当前任务上下文 sessionContext（§4.13）](references/plugin-session-context.md)
- [插件创建工作区任务入口 workspace（§4.17）](references/plugin-workspace-sessions.md)

### 插件打包、发布与兼容

Read packaging before implementation and delivery. Read publishing only for publication, and bundled Skills only when maintaining an older plugin.

- [插件打包、安装与验证（§7）](references/plugin-packaging.md)
- [插件发布签名与审核（§8）](references/plugin-publishing.md)
- [插件版本兼容与拒装排查（§9）](references/plugin-compatibility.md)
- [旧插件捆绑 Skill 的维护与迁移（§4.16）](references/plugin-bundled-skills-legacy.md)

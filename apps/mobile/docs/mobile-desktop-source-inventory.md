# Cindy Mobile Desktop Source Inventory

> 日期: 2026-06-17
> 目标: 从桌面版源码逐项反推手机版远程控制需要覆盖的界面、内容、状态和测试条件。
> V1 边界: 除完整协作 / Orca 编排外,把普通单会话远程控制和非协作附属能力做完整。协作会话 V1 只识别、只读、安全降级。

## 1. 使用方式

这份文档是实现清单,不是产品愿望清单。后续手机版开发按每个模块的“桌面源码真相 -> 手机实现方式 -> 验收条件”推进。

- `desktop-interaction-audit.md`: 详细审计背景和桌面行为说明。
- `mobile-v1-source-plan.md`: 里程碑、开发顺序和自动化测试计划。
- `shared-core-migration-plan.md`: 共享展示模型、迁移顺序和跨端 fixture 测试门槛。
- 本文档: 面向开发执行的功能矩阵,覆盖消息交互、选项卡、计划、文件页、协作模式和测试调优。

V1 的判断标准:

- 手机端看到的 session、message、queue、interaction、schedule 都来自电脑端真相源。
- 手机端不新建一套状态机,只做远程 invoke、topic subscribe、移动端 UI state 和短期缓存。
- 可复用的 session/message render model、pending interaction model、queue/input projection model、session controls/runtime options、file browser model、automation/schedule model 要沉到 `packages/maker-shared`,再由桌面端和手机版各自渲染。
- 桌面端已有的业务语义不改,只把 hover、右栏、split pane、侧边栏、tab bar 改成 stack、sheet、full-screen modal、segmented control。
- 遇到 Orca lead / worker / collaboration session 不崩溃,但不提供完整多 worker 编排。

## 2. 桌面源码入口总表

| 领域 | 桌面源码 | 手机版用途 |
| --- | --- | --- |
| 路由和壳层 | `router.tsx`, `CCAgentFeatureLayout.tsx`, `CCAgentSessionView.tsx` | 定义登录、新建、会话、文件、计划、协作的一级结构。 |
| 设备远程 | `useDeviceLinkRemoteProjects.ts`, `remoteProjectsStore.ts`, `refreshRemoteSessions.ts` | 定义同账号电脑、可控状态、sessions bootstrap、reseed 和撤权。 |
| 远程传输 | `makerTransport.ts`, `dispatch.ts`, `allowlist.ts`, `topics.ts` | 定义手机可以调用什么、订阅什么、哪些能力必须拒绝。 |
| 会话头部 | `SessionContentHeader.tsx`, `RemoteSessionBanner.tsx`, `ErrorBanner.tsx`, `UpgradeBanner.tsx` | 定义连接状态、标题、置顶、归档、删除、错误、升级提示。 |
| 消息流 | `MessageStream.tsx`, `MessageItem.tsx`, `UserMessage.tsx`, `AssistantMessage.tsx` | 定义 raw messages 如何转成可渲染条目。 |
| 工作过程 | `WorkGroupBlock.tsx`, `AgentActionsBlock.tsx`, `AgentActionRow.tsx`, `ThinkingCard.tsx`, `TodoListCard.tsx` | 定义 thinking、tool、todo、work group 的折叠和内容展示。 |
| System cards | `SystemCard.tsx` | 定义 `/context`, `/status`, `/cost`, `/pwd`, `/cmd`, `/compact`, `/help` 的显示。 |
| 媒体和 payload | `ChatImageView.tsx`, `ChatVideoView.tsx`, `ChatAudioCard.tsx`, `ImageLightbox.tsx`, `VideoLightbox.tsx`, `ToolPayloadLightbox.tsx` | 定义图片、视频、音频、长 payload、文件 payload 的移动端映射。 |
| 输入器 | `ChatInput.tsx`, `PendingQueuePanel.tsx`, `ModelSelector.tsx`, `PermissionSelector.tsx`, `FastModeToggle.tsx`, `ExtraDirsButton.tsx` | 定义发送、停止、队列、附件、语音、slash、@、模型、权限、fast、extra dirs。 |
| Pending interactions | `PermissionPrompt.tsx`, `AskUserQuestionPrompt.tsx`, `PlanViewerCard.tsx`, `PlanActionCard.tsx`;`IssueConfirmCard.tsx` 仅作桌面反馈链路参考 | 定义权限、提问、计划确认的决策 shape;Issue 确认在 mobile V1 只做 desktop-only 降级识别。 |
| 自动化计划 | `SchedulerPage.tsx`, `TaskListPane.tsx`, `RunHistoryPane.tsx`, `ScheduleFormDialog.tsx`, `TemplateGallery.tsx` | 定义 schedules 列表、运行历史、运行/暂停/恢复/删除、创建/编辑。 |
| 文件和选项卡 | `WorkdirBrowseRoute.tsx`, `FileBodyView.tsx`, `WorkdirBrowseSidebar.tsx`, `FileTabsBar.tsx`, `SessionTabsBar.tsx` | 定义文件树、文件预览、文件 tab、同目录 session tab、chat rail。 |
| 协作 / Orca | `ExtraDirsButton.tsx`（「+」菜单协同项）, `OrcaWorkflowRoute.tsx`, `OrcaSplitView.tsx`, `CreateWorkerPopover.tsx`, `useWorkers.ts` | 定义 lead + worker + focus + split/toggle 的真实协作模型。 |

## 3. V1/V1B/V2 分层

| 模块 | V1A | V1B | V2 |
| --- | --- | --- | --- |
| 设备 | 可控电脑发现、离线/撤权/同步失败、重新同步 | 设备详情和调试信息 | 多设备批量管理 |
| 会话列表 | 普通 session 列表、搜索、状态、归档/置顶/删除 | 自动化分组、项目分组、批量操作 | 桌面级侧边栏完整 parity |
| 会话详情 | 消息流、发送、停止、队列、pending interactions、基础会话动作 | diff、context/cost detail、fork/rewind、媒体增强 | 多窗/多 pane 级能力 |
| 新会话 | 选择远程电脑、工作区、agent/model/permission/fast、首条消息 | extra dirs、附件、slash、@、语音 | 项目模板和高级工作流 |
| 文件 | 工具引用文件卡、只读文件预览 | 文件树、文件 tabs、同目录 session tabs | 完整编辑器、dirty/conflict/save |
| 自动化 | 查看 schedules、运行历史、run now、pause/resume | 创建/编辑普通 schedule、模板参数 | project automation 完整管理 |
| 协作 | 识别 lead/worker,安全只读提示 | worker 快速跳转 | 完整 Orca 移动编排 |

## 4. 手机信息架构

### 4.1 一级入口

| 手机入口 | 桌面对应 | V1 设计 |
| --- | --- | --- |
| Home | desktop sidebar + remote projects | 默认首页。直接合并展示所有可控电脑的 Pinned / Projects / Chats / sessions;电脑只作为轻量筛选、online/offline 归属和调试上下文。 |
| Devices | remote projects / controllable computers | 二级/调试入口。展示同账号电脑、不可控原因、撤权、同步失败和重新同步,不作为进入会话的必经路径。 |
| Session | `/cc-agent/:sessionId` | 主控制面。消息流常驻,底部根据 pending interaction 或 composer 切换。 |
| New | `/cc-agent/new` | 从选中电脑创建远程会话。手机不选择本机 cwd,只选择电脑端可用工作区。 |
| Automations | `/cc-agent/scheduled` | 移动版计划任务。V1 先看和运行,V1B 创建/编辑。 |
| Files | `/cc-agent/files/:sessionId` | V1B 只读文件页。完整编辑留 V2。 |
| Settings | 登录、设备、relay、debug | mock login / Feishu login / 退出、设备名、日志导出。手机版第一刀已拆成独立 `/settings` 主窗口;被控权限开关仍归桌面端设置。 |

### 4.2 会话详情层级

桌面 `CCAgentSessionView` 的真实层级需要被手机保留为语义,但改成交互更轻的移动形态。

| 桌面层 | 手机实现 |
| --- | --- |
| `RemoteSessionBanner` | 顶部窄条: reconnecting、host offline、revoked、resync。不能挤掉消息流。 |
| `MessageStream` | 主体虚拟列表。保持旧消息 anchor、自动跟随和 unread 语义。 |
| Running status bar | 贴近 composer 的运行态条,显示正在生成、停止、继续、token/context 简讯。 |
| `ErrorBanner` | inline banner,保留 retry/cancel/sync auth 等可行动作。 |
| `UpgradeBanner` | 移动端低优先级卡片,不挡住输入。 |
| `InteractionPromptHost` | bottom sheet / full-screen modal,优先级高于 composer。 |
| `ChatInput` | 底部输入区。只在没有 pending interaction 和阻塞态时可编辑。 |
| Diff panel | full-screen route 或 sheet,不做桌面右栏。 |
| TopRightChipStack | header 更多菜单 + 状态 chips。 |

Pending 区域优先级:

1. Plan Review。
2. Permission。
3. Ask User。
4. Issue Confirm。
5. Takeover / Worktree creating 阻塞。
6. Composer。

## 5. 消息流源码语义

### 5.1 Raw message 到 render item

桌面 `MessageStream.tsx` 不是简单按 message 渲染,而是先构造 render items。

| 桌面规则 | 手机必须对齐 |
| --- | --- |
| `RENDER_WINDOW_INITIAL_ITEMS = 80`, `RENDER_WINDOW_GROWTH_ITEMS = 80` | 手机同样按 render item 窗口增长,不要按 raw message 数量简单分页。 |
| 未回答的 `ask_user` 不直接出现在消息流 | 手机只通过 pending interaction 展示待回答问题。 |
| `AskUserQuestion` 和 `ExitPlanMode` tool call 被过滤 | 手机不能把这些内部工具当普通 tool 卡片显示。 |
| `TodoWrite` tool input 提取为 `todo` render item | 手机要展示 Todo 卡,不要显示原始 Tool JSON。 |
| tool_use 和 tool_result 通过 `toolUseId` 配对,必要时用相邻 fallback | 手机端数据 reducer 要保留配对逻辑,否则 tool result 会错位。 |
| tool result 中媒体被提取为 `tool_media` | 手机端媒体卡应从同一 payload 提取,不能只显示文本。 |
| thinking/tool/todo/intermediate assistant 会被折进 `work_group` | 手机要有工作过程折叠卡,否则长工具链会淹没正文。 |

### 5.2 Message item 类型

| 类型 | 桌面显示 | 手机实现 |
| --- | --- | --- |
| user | 用户消息 + action bar | 普通气泡,消息结束处轻量 action bar 提供复制、分叉、撤销、时间;完成态正文尽量在可见文本上直接选择。 |
| assistant | Markdown、代码块、引用、action bar | Markdown 渲染、代码横向滚动、消息结束处轻量 action bar;完成态正文尽量在可见文本上直接选择。 |
| thinking | `ThinkingCard` streaming/final/redacted/aborted | 默认折叠,流式时显示短摘要和时间。 |
| tool_use/result | `AgentActionsBlock` / `AgentActionRow` | 默认折叠为“工作过程”,点开看每个工具。 |
| todo | `TodoListCard` | 对齐桌面 inline checklist:completed/total + active item + 三态图标,不做单独 Todo sheet。 |
| system | `SystemCard` | 系统卡,按 card type 显示不同内容。 |
| media | `ChatImageView`, `ChatVideoView`, `ChatAudioCard` | inline 缩略卡 + full-screen viewer/player。 |
| work_group | `WorkGroupBlock` | 一个折叠块承载 thinking/tools/todo/intermediate 输出。 |

### 5.3 滚动、窗口和未读

桌面滚动语义:

- 增量加载旧消息时保持 key anchor。
- 只有接近底部时自动跟随。
- 新 assistant / ask_user / plan_review 才计入 unread。
- 点击 jump-to-bottom 才清 unread。
- loading older 只在顶部补旧数据时出现。

手机验收:

- 长会话 1000+ render items 不能卡顿。
- 用户向上读旧消息时新消息不能把列表拉到底。
- 远程 reconnect 后 messages reseed 不应产生明显跳动。
- unread 计数和 jump 行为与桌面一致。

## 6. 消息内容和 payload

### 6.1 Assistant 内容

手机端要复用桌面 assistant message 的语义:

- Markdown 段落、列表、引用。
- fenced code block,支持复制。
- inline code。
- 链接打开确认或系统浏览器。
- 文件 path chip / mention chip。
- 中间态 assistant 内容如果属于 work group,按桌面规则折叠。

### 6.2 Tool row

`AgentActionRow.tsx` 说明 tool row 不是纯文本日志。

| Tool payload | 手机实现 |
| --- | --- |
| `Edit`, `Write`, `MultiEdit`, `Read` 文件路径 | 文件 chip,点开移动文件预览或 payload 详情。 |
| diff/patch | full-screen diff viewer,支持文件头、统计、分段、复制。 |
| 长 input/result | 默认折叠,点开 `ToolPayloadLightbox` 等价详情。 |
| error result | 高亮错误,保留在工作过程里,不打断消息流。 |
| 非文件工具 | 展示工具名、状态、摘要、输入/输出详情。 |

### 6.3 媒体 payload

`AgentActionRow` 从 tool result 中提取这些字段:

- `xdt_image_url`, `xdt_image_urls`。
- `xdt_video_url`, `xdt_video_urls`。
- `xdt_audio_url`, `xdt_audio_urls`。
- `_xdt_audio_tracks`。
- `_xdt_model_files`。
- `_xdt_render_image`。
- `_xdt_actions`。

手机实现:

- 图片: 缩略图、全屏预览、保存/分享、基础缩放。真 pinch zoom 作为后续增强。
- 视频: inline poster + 全屏播放。
- 音频: track card、播放/暂停、进度、标题/封面/lyrics 元数据。
- model 文件: V1 显示文件卡和“不支持手机预览”提示,V2 再评估 3D preview。
- `_xdt_actions`: V1 先安全展示为不可用或二次确认按钮;V1B/V2 再接远程 UI trigger,并且必须有 inflight 锁避免重复触发。

### 6.4 Todo

`TodoListCard` 语义:

- 从 `TodoWrite` tool input 提取 todo。
- 展示 completed/total。
- 展示当前 `in_progress`。
- 状态包括 `pending`, `in_progress`, `completed`。
- 折叠时显示进度条和 active item。

手机实现:

- 消息内对齐桌面 `TodoListCard`:completed/total、active item、三态图标和 inline list。
- 不做独立 Todo sheet、“查看全部任务”按钮或状态文字标签。
- 流式更新时保持 card 高度尽量稳定。

### 6.5 System cards

`SystemCard.tsx` 包含这些 card type:

| Card type | 手机显示 |
| --- | --- |
| `help` | 简短帮助,移动端可折叠。 |
| `cost` | 本轮/会话费用摘要,详情进 sheet。 |
| `context` | context usage、categories、mcpTools、memoryFiles、agents、skills、slashCommands、messageBreakdown、apiUsage。 |
| `pwd` | 当前工作目录。 |
| `status` | agent/runtime 状态。 |
| `compact` | compact 结果和提示。 |
| `cmd` | slash command 运行结果。 |

V1 最低要求是能显示所有 system card,不能丢弃 `/context` 这类内容。复杂详情可以收进 sheet。

## 7. 输入器和发送链路

### 7.1 ChatInput 真实能力

`ChatInput.tsx` 不是 textarea,它包含:

- TipTap plain text。
- mention chip node。
- 附件: file、folder、clipboard image。
- 草稿存储。
- slash palette。
- `@` resource panel。
- model selector。
- effort selector。
- permission mode selector。
- fast mode toggle。
- extra dirs。
- folder/workdir picker。
- pending queue。
- voice input。
- collaboration toggle。

手机 V1:

- 输入框、发送、停止、继续。
- 多行文本和粘贴。
- 底部常驻入口使用桌面同族图标:附件/更多、输入框、语音、发送/停止;语音放在发送左侧。
- 附件先支持图片/文件引用,folder 作为 V1B。
- 模型、effort、permission、fast 放进“会话设置”sheet。
- slash 和 @ 放在 composer 上方的快捷入口。
- voice input 保留按钮,失败时不影响文本发送。
- collaboration toggle V1 只显示只读提示,不触发完整 Orca。

### 7.2 发送路径

桌面 `CCAgentSessionView` 发送前会处理:

- navigation command。
- `/context` 本地 system card。
- desktop slash command dispatch。
- auth gate。
- folder picker / workingDir。
- archived session auto-unarchive。
- queue / send / steer。

手机实现:

- 普通文本发送走远程 `makerApiFor(sessionId).send` 等价能力。
- `/context` 可走远程 context usage 并插入/展示 system card,不要手机本地伪造。
- 其它 slash command 走被控电脑的 command dispatch,不在手机本机执行。
- archived session 发送前确认并远程 unarchive。
- running 时发送要走 queue 或 steer 语义,不能强行打断。

### 7.3 Queue

`PendingQueuePanel.tsx` 的产品规则:

- FIFO。
- 4 条以内完整显示。
- 5 条以上默认显示前 3 条,可 show more。
- Stop 负责 paused state。
- paused 状态提供 Continue 和 steer。
- 排序时安装全局 lock。
- 编辑某行时安装 row lock。
- `resolveSingleMove` 把最终 index 转成 makerChatStore insertion index。

手机实现:

- composer 上方显示 queue strip 或 chip。
- 点开 queue sheet。
- 支持删除、编辑、重排、继续、steer。
- 拖拽排序可先用上下移动按钮替代,但语义必须对应桌面排序。
- queue 操作要走远程 queue API,不能只改手机本地列表。

## 8. Pending interactions

### 8.1 Permission

`PermissionPrompt.tsx` 决策 shape:

- Allow once: `{ behavior: 'allow' }`。
- Always allow for session: `{ behavior: 'allow', updatedPermissions, decisionClassification: 'user_permanent' }`。
- Deny: `{ behavior: 'deny', message: 'User denied', decisionClassification: 'user_reject' }`。

手机实现:

- 底部 sheet。
- 展示工具名、说明、关键 input。
- Allow once / Always allow / Deny 三个动作。
- 默认聚焦风险说明,但不改变桌面权限模型。
- resolve 后立即锁按钮,直到远程 interaction 更新。

### 8.2 Ask User

`AskUserQuestionPrompt.tsx` 语义:

- 多步骤 wizard。
- single-select 点击后立即进入下一步或提交。
- multi-select 最终编码为 JSON array string。
- Skip 是空字符串。
- draft 由 requestId 维度持久化。
- viewer 可 expand/minimize。

手机实现:

- full-screen 或 tall sheet wizard。
- 单选点击即前进。
- 多选有明确提交按钮。
- Skip 保持空字符串语义。
- 退出再进不丢当前 request 草稿。

### 8.3 Plan Review

`PlanViewerCard.tsx` 和 `PlanActionCard.tsx` 语义:

- viewer 状态: expanded、half、minimized、edit。
- outline 从 Markdown h1-h3 DOM 生成。
- edit 通过 `onPlanContentChange` 写回。
- approve row 和 feedback row 分开。
- approve 支持 Enter。
- feedback 支持 Enter with text。
- submit 后冻结,避免重复响应。

手机实现:

- 默认 full-screen review。
- outline 用目录 sheet 或顶部 segmented。
- 编辑计划需要明确“编辑”模式,保存后回到 review。
- Approve 和 Send feedback 固定底部。
- 发送后冻结按钮,等待远程消息推进。

### 8.4 Issue Confirm

`IssueConfirmCard.tsx` 语义:

- title/body/type 可编辑。
- env info 只读。
- Confirm 发送 `{ confirmed: true, title, body, type, uiLanguage }`。
- Cancel 发送 `{ confirmed: false }`。
- Ctrl/Cmd+Enter 提交,Esc 取消。

手机实现:

- V1 不实现 GitHub Issue 表单。
- 只识别 `issue_confirm` pending interaction 并显示 desktop-only 降级说明。
- 不在手机端提交 `{ confirmed: true }`,避免把桌面反馈链路误做成手机版主流程。

## 9. 会话列表和会话管理

### 9.1 Sidebar 语义

桌面 `CCAgentSidebarUpper.tsx` / `SessionItem.tsx` 提供:

- New session。
- Automations entry。
- pinned/dialogue/projects/date 分组。
- filters: archived/all 等。
- search。
- selection / bulk archive/delete。
- remote project sessions 合并显示。
- Orca worker 隐藏或按 lead 关系处理。
- session title、vendor icon、running/attached、attention、draft、PR tooltip、schedule badge、worktree badge。
- double click rename。
- context menu: pin/unpin、archive、delete、copy id/deep link 等。

手机 V1:

- 列表默认按 pinned、running/waiting、recent 分组。
- 搜索和 archived filter 必做。
- running、waiting permission/question/plan、draft、schedule badge 必须可见。
- 单条 swipe 或更多菜单支持 pin/archive/delete/rename。
- bulk operation 可 V1B。
- Orca worker V1 不直接混在普通列表里造成误点,至少标注“协作会话,手机版暂不支持完整操作”。

### 9.2 Header action

`SessionContentHeader.tsx` 行为:

- title inline rename。
- pin/unpin。
- copy deep link。
- copy XDT ID / SDK ID。
- open in new window。
- archive/delete/unarchive。
- running/attached 时阻止 archive。

手机实现:

- Header 显示 title,更多菜单承载操作。
- rename 用 sheet。
- copy id/deep link 可 V1B。
- open in new window 手机不需要,可隐藏。
- archive/delete/unarchive 需要遵守 running/attached 阻止规则。

## 10. 新建会话

桌面新建来自 `NewMakerDraftRoute` + `ChatInput`。

手机新建必须以被控电脑为上下文:

- 先选设备。
- 选工作区/项目,来源是被控电脑,不是手机文件系统。
- 选择 agent。
- 选择 model、effort、permission、fast。
- 输入首条消息。
- 可附加图片/文件。
- 发送后进入新 session detail。

V1 最小闭环:

- 默认使用电脑端最近工作区或项目。
- 允许切换工作区。
- 允许选择 agent/model/permission。
- 支持首条消息创建 session。

V1B:

- extra dirs。
- slash command。
- @ resource。
- project automation context。

## 11. 文件页和选项卡

### 11.1 WorkdirBrowseRoute

桌面 `/cc-agent/files/:sessionId` 的结构:

- file body + chat rail。
- sidebar 切换为 file tree。
- `?file` 表示选中文件。
- remote SSH session 会 redirect 回普通 session。
- Orca worker redirect 到 lead。
- 同 workdir session tabs。
- file tabs open/close/reorder。
- dirty save/discard/cancel。
- chat rail resizable/collapsible。

手机 V1B 只读方案:

- 从 session 进入 Files。
- 文件树是 stack page。
- 文件内容全屏预览。
- chat rail 不并排,改为底部“回到会话”或分屏切换。
- file tabs 显示为顶部横向 tabs 或最近文件列表。
- session tabs 显示为“同目录会话”列表。
- dirty/edit/save/conflict 全部 V2。

### 11.2 FileBodyView

桌面支持:

- empty。
- text markdown/code/plain。
- image。
- PDF/drawio/binary unsupported。
- search。
- edit mode。
- auto save / dirty / external change。
- Ctrl/Cmd+S。

手机 V1B:

- text/code 只读,代码横向滚动。
- markdown 只读预览。
- image 预览。
- binary unsupported card。
- search 可 V1B。
- edit mode V2。

## 12. 自动化 / 计划

### 12.1 SchedulerPage

桌面计划页真实行为:

- master-detail。
- `selectedId` 会根据 focus/pending/current/first 维护。
- 切换 schedule 时 `RunHistoryPane` 不 remount,避免空白跳变。
- 不靠轮询,靠 schedule event refresh。
- `statusFilter` active 包含 active + expired,paused 分开。
- 排序: active/expired 优先,paused 其次,再按 `lastFiredAt`、`updatedAt`。
- run now。
- pause/resume,有 inflight confirmation。
- create/edit dialog。
- project automation clone/promote/reload/upsert/remove。

手机实现:

- Automations 首页为任务列表。
- Detail page 显示任务配置和运行历史。
- 切换任务保留旧历史直到新数据到达,避免白屏。
- active/paused/expired 分段筛选。
- run now、pause/resume、delete 放在 detail action menu。
- project automation 高级管理先只读或 V2。

### 12.2 TaskListPane

桌面任务分组:

- workingDir group。
- dialogue group。
- other group。
- project group actions: create/open config/reload。
- user/project schedules 的 action route 不同。

手机实现:

- 按 Project / Dialogue / Other 分组。
- 每条显示 name、next run、last run、status、agent/model、workdir。
- project automation 显示“项目自动化”标签。
- create/open config/reload V1B/V2,不要 V1A 挤进主闭环。

### 12.3 RunHistoryPane

桌面运行历史:

- schedule 切换时先保留旧 runs。
- 同一个 sessionId 的重复 run 会 fold。
- mark attention read。
- runNow/edit/pause/delete。
- delete run。
- restart interrupted。

手机实现:

- history list。
- 每个 run 展示时间、状态、session title、错误摘要、费用/时长。
- 点 run 跳到对应 session。
- failed/interrupted 提供 retry/restart。
- fold 重复 session run。

### 12.4 ScheduleFormDialog

桌面创建/编辑字段:

- create/edit/project automation mode。
- blank/template segmented。
- template gallery / params。
- name。
- schedule: cron/manual/once。
- run mode: fresh/persistent/bound。
- agent/model/effort/fast。
- notify。
- worktree。
- project chip。
- fast 只在 model 支持时可切。
- bound 隐藏 workspace fields。

手机 V1B:

- 基础 create/edit 支持 name、schedule、prompt、agent/model/effort、run mode。
- template gallery 作为独立 step。
- cron 输入需要预设 + raw cron advanced。
- worktree/project automation 高级字段可后置。

## 13. 协作 / Orca

桌面源码说明协作不是一个开关:

- `ExtraDirsButton` 中的协同模式项只是 controlled 入口。
- `OrcaSplitView` 承载 lead + worker 双会话。
- workerRatio 持久化。
- split/toggle layout。
- max pane。
- create worker popover。
- worker toolbar。
- worker focus。
- archive worker。
- stop collaboration。
- attention clear。
- `orcaWorkflowsFor` 区分 local/remote。
- `CreateWorkerPopover` 有 role/custom role、agent tabs、model/effort/fast、initial task、记忆偏好。
- `useWorkers` 依赖 listWorkersByLead 和 `ORCA_WORKER_CHANGED` 刷新。

V1 策略:

- 会话列表识别 lead/worker。
- 打开 worker 时给只读提示,提供“回到主会话/lead”。
- 普通消息流仍能展示,但不提供 create worker、focus、split、archive worker、stop collab。
- 不允许手机端误把 worker 当普通 session 做破坏性操作。

V2 需要单独设计:

- 手机端如何在 lead 和多个 worker 间切换。
- worker focus 的移动交互。
- create worker 表单。
- stop collaboration 的风险确认。
- worker attention 聚合。

## 14. 远程传输和权限边界

### 14.1 makerTransport

`makerTransport.ts` 的关键结论:

- `makerApiFor(sessionId)` 根据 session 是否远程选择 local/remote。
- remote 支持 send、setModel、setEffort、setPermissionMode、setFastMode。
- remote 支持 resolveInteraction、getPendingInteractions。
- remote 支持 fork、rewind、context、extraDirs、closeSession。
- remote 支持 enable/disableOrca/input queue。
- remote 支持 `getSessionFor`, `listMessagesFor`, `aroundMessagesFor`。
- `orcaWorkflowsFor` 单独路由 Orca API。

手机实现:

- 建一个 typed mobile client,不要在组件里散落 string invoke。
- 每个 invoke 统一 timeout、错误码、重试、revoked/offline 映射。
- 对 session 级别操作全部带 `deviceId/sessionId`。
- 对 Orca API V1 只读或禁用。

### 14.2 Controlled dispatch

`dispatch.ts` 被控侧规则:

- 处理 `link-open/close/invoke`。
- 管理 subscription registry。
- topic-scoped push。
- 二次检查 `remoteControlEnabled`。
- 检查 revoked controllers。
- 检查 allowlist。
- `maker:create-session` 有 workingDir guard。
- remote set model/effort/permission/fast 会回写 DB 并 broadcast。

手机验收:

- remote disabled 时所有控制动作都显示明确错误。
- controller revoked 后立即回到设备不可控状态。
- set model/effort/permission/fast 后桌面和手机列表都同步。
- create session 不能绕过电脑端 workingDir guard。

### 14.3 Allowlist

当前 allowlist 允许:

- agent lifecycle。
- input queue。
- interactions。
- runtime settings。
- capabilities。
- DB reads。
- patch meta。
- media/voice。
- scheduler。
- project automation。
- Orca。
- rewind/fork/context。
- usage。
- memory read。
- command/skill list。
- scan-at。
- plugin list。
- fs browse/stat/mkdir。
- text-file preview。

明确不应暴露给手机:

- window/UI 本机控制。
- shell / open external。
- account/global settings raw writes。
- local-db raw writes。
- updater。
- skillhub writes。

## 15. 自动化测试和调优

### 15.1 单元测试

优先补这些纯函数/状态测试:

- raw messages -> render items。
- tool/result pairing。
- media payload extraction。
- todo extraction。
- queue reorder index conversion。
- pending interaction decision shape。
- remote error mapping。
- schedule grouping/sort。
- Orca lead/worker safe degrade。

### 15.2 集成测试

需要一个本地三件套 harness:

- local relay/server mock。
- controlled desktop mock 或真实 desktop dev。
- mobile app。

覆盖:

- mock login。
- 设备上线。
- session list reseed。
- session detail subscribe。
- send message。
- streaming update。
- permission resolve。
- ask user resolve。
- plan approve/feedback。
- issue confirm/cancel。
- queue edit/reorder/continue。
- host offline/reconnect。

### 15.3 原生 E2E

目标工具:

- iOS Simulator。
- Android Emulator。
- Maestro 或 Detox。当前如果 Maestro CLI 不可用,先保留 smoke script 和 checklist。

核心用例:

1. 登录 mock account。
2. 看到本机电脑。
3. 进入会话列表。
4. 打开已有会话。
5. 发送一条消息。
6. 被控桌面收到消息并更新同一 session。
7. 手机收到 assistant 流式消息。
8. 触发 permission,手机 allow once。
9. 触发 ask user,手机回答。
10. 触发 plan review,手机 approve。
11. 切后台再回来,订阅恢复。
12. 断开桌面,手机显示 offline。
13. 桌面恢复,手机 resync 后不丢状态。

### 15.4 视觉和性能

视觉基线:

- 对齐桌面黑白反色、低装饰、信息密度高的设计语言。
- 手机不做营销式 hero。
- 卡片只用于消息、工具、modal、列表项,不要卡片套卡片。
- 所有长文本、长路径、长按钮文案必须在小屏不溢出。

性能基线:

- 1000+ render items 会话可滚动。
- 远程 streaming 每秒多次更新时不重建全列表。
- 图片/视频懒加载。
- payload lightbox 延迟解析长 JSON。
- reconnect reseed 不造成整屏跳变。

调优指标:

- session list 首次可交互时间。
- session detail 首屏 message 可见时间。
- send tap 到 controlled desktop 收到 invoke 的延迟。
- streaming event 到手机渲染延迟。
- queue 操作 round trip。
- reconnect 后 resync 完成时间。

## 16. 实现顺序

### Phase 1: 固化远程协议和测试基座

- typed mobile device-link client。
- mock login / mock account。
- local relay + desktop harness。
- remote error mapping。
- subscription lifecycle。
- smoke test 脚本。

验收:

- 不依赖飞书 secret 可本地登录。
- iOS Simulator 能看到本机 controlled desktop。
- host offline/reconnect 可复现并自动化验证。

### Phase 2: 会话列表和会话详情骨架

- devices。
- sessions list。
- session detail。
- connection strip。
- message history load。
- basic send / stop。

验收:

- 手机和桌面打开同一 session,消息一致。
- running/offline/revoked 状态一致。
- 发送后桌面 session 实际收到。

### Phase 3: 消息渲染 parity

- render item builder。
- assistant/user/system。
- thinking/work group/tool/todo。
- media extraction。
- payload/detail viewer。

验收:

- 用 fixture 覆盖每种 render item。
- 长工具链折叠后仍能展开查看完整输入/输出。
- `/context` system card 不丢字段。

### Phase 4: Composer 和 Queue

- composer。
- model/effort/permission/fast settings。
- attachments。
- slash/@ 初版。
- pending queue sheet。
- edit/reorder/delete/continue/steer。

验收:

- running 时新输入进入 queue。
- queue 操作后桌面和手机顺序一致。
- set model/permission 后桌面 DB 和手机 UI 同步。

### Phase 5: Pending interactions

- Permission。
- Ask User。
- Plan Review。
- Issue Confirm。

验收:

- 每种 interaction 的 resolve payload 与桌面源码一致。
- 提交后按钮冻结,不会重复 resolve。
- interaction 消失后 composer 恢复。

### Phase 6: 非协作附属能力

- fork / rewind。
- diff。
- context/cost detail。
- file preview。
- automations read/run/pause/resume。
- schedule create/edit basic。

验收:

- 非协作常用桌面能力在手机端有入口。
- 文件编辑、完整 project automation、完整 Orca 明确降级。

### Phase 7: 自动化回归和调优

- render fixtures。
- local integration harness。
- iOS/Android smoke。
- performance budget。
- visual screenshots。

验收:

- 常用远程控制路径无需手工点。
- 每次改消息渲染、queue、interaction、schedule 都能跑对应测试。

## 17. V1 完成定义

V1 完成不是“能发消息”,而是以下条件全部成立:

- 手机能通过 mock login 和正式登录进入同账号设备。
- 手机能发现、进入、重新同步可控电脑。
- 会话列表可搜索、筛选、展示运行态和等待态。
- 会话详情能渲染桌面普通会话的所有核心 message item。
- 手机可发送、停止、排队、编辑队列、重排队列、继续队列。
- Permission / Ask User / Plan Review 都可完成;Issue Confirm 提示回桌面端处理。
- 模型、effort、permission、fast 与桌面 session 状态同步。
- fork/rewind/diff/context/cost 有移动入口或明确 V1B 完成项。
- 自动化计划至少可查看、运行、暂停、恢复;创建/编辑进入 V1B。
- 文件引用可查看;完整编辑器明确 V2。
- 协作 session 可识别并安全降级。
- iOS Simulator 和 Android Emulator 至少各有一条自动 smoke 路径。
- host offline、revoked、reconnect、resync 都有自动或半自动验证。

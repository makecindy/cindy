# Cindy Desktop Interaction Audit for Mobile Remote Control

> 版本: 2026-06-17
> 目标: 按桌面版现有源码完整盘点消息交互过程、界面内容、选项卡、计划、自动化、文件页和协作模式,并转成手机版远程控制的实现清单。
> 原则: 桌面端仍是数据真相源,手机版只做远程控制端。除协作模式 / Orca 的完整编排外,V1 应尽量补齐所有单会话远程控制能力。

执行计划补充:

- [mobile-desktop-source-inventory.md](./mobile-desktop-source-inventory.md) 将桌面源码行为整理成手机版功能矩阵、V1/V1B/V2 边界和验收条件。
- [mobile-v1-source-plan.md](./mobile-v1-source-plan.md) 将本审计拆成手机版 V1 的实现阶段、验收条件和测试矩阵。

## 1. 源码审计范围

这份文档不是重新设计产品,而是从桌面版源码反推手机版要对齐的行为。当前审计覆盖这些入口:

| 桌面能力 | 关键源码 |
| --- | --- |
| 路由与全局信息架构 | `apps/desktop/src/renderer/router.tsx`, `apps/desktop/src/renderer/features/cc-agent/CCAgentFeatureLayout.tsx` |
| 设备远程镜像 | `features/device-link/useDeviceLinkRemoteProjects.ts`, `features/device-link/remoteProjectsStore.ts`, `features/device-link/refreshRemoteSessions.ts` |
| 远程传输与权限 | `apps/desktop/src/preload/preload.ts`, `apps/desktop/src/main/device-link/dispatch.ts`, `packages/device-link/src/allowlist.ts`, `packages/device-link/src/topics.ts` |
| 会话主页面 | `features/cc-agent/CCAgentSessionView.tsx`, `SessionContentHeader.tsx`, `NewMakerDraftRoute.tsx` |
| 消息流 | `components/chat/MessageStream.tsx`, `UserMessage.tsx`, `AssistantMessage.tsx`, `AgentActionsBlock.tsx`, `AgentActionRow.tsx`, `ThinkingCard.tsx`, `WorkGroupBlock.tsx`, `TodoListCard.tsx`, `SystemCard.tsx` |
| 输入器 | `components/new-chat/ChatInput.tsx`, `PendingQueuePanel.tsx`, `PermissionSelector.tsx`, `ExtraDirsButton.tsx`, `FastModeToggle.tsx`, `ModelSelector.tsx`, `VoiceInputButton.tsx` |
| Pending interactions | `PermissionPrompt.tsx`, `AskUserQuestionPrompt.tsx`, `PlanViewerCard.tsx`, `PlanActionCard.tsx`;`IssueConfirmCard.tsx` 仅作为桌面 `/issue` 反馈链路参考 |
| 自动化 / 计划 | `features/scheduler/SchedulerPage.tsx`, `TaskListPane.tsx`, `RunHistoryPane.tsx`, `ScheduleFormDialog.tsx`, `TemplateGallery.tsx` |
| 文件页 / 选项卡 | `features/cc-agent/workdir-browse/WorkdirBrowseRoute.tsx`, `FileBodyView.tsx`, `SessionTabsBar.tsx`, `FileTabsBar.tsx` |
| 协作模式 / Orca | `ExtraDirsButton.tsx`（「+」菜单协同项）, `OrcaWorkflowRoute.tsx`, `OrcaSplitView.tsx`, `CreateWorkerPopover.tsx`, `WorkerListToolbar.tsx` |

## 2. 产品边界

### 2.1 不重做桌面产品逻辑

手机版不应有独立的会话数据库、独立计划引擎、独立权限状态机或独立 agent runtime。正确边界是:

- 桌面端: 会话、消息、队列、权限请求、计划、文件、worker、自动化、媒体资源的真相源。
- 服务端: 账号与设备中继,不保存 Cindy 业务状态。
- 手机端: 通过 `device-link` 订阅和调用桌面能力,只保存 UI 状态、最近设备、短期缓存和本地草稿。

### 2.2 V1 范围

V1 要做“除完整 Orca 协作编排外的单会话远程控制面”:

- 设备列表和可控电脑发现。
- 会话列表、会话详情、会话创建、会话管理。
- 消息流完整渲染: user / assistant / thinking / tool / todo / media / system。
- 输入器完整远程控制: 发送、停止、排队、附件、模型、权限、fast mode、语音输入。
- Pending interactions: Permission、Ask User、Plan Review;Issue Confirm 只做 desktop-only 降级识别。
- 基础会话操作: rename、archive、pin、fork、rewind、retry、cancel。
- 自动化 / 计划: 查看、运行、暂停、恢复、基础创建和编辑。
- 文件页: V1 先做只读预览和与会话相关的文件引用,不做完整桌面级编辑器。

### 2.3 V2 范围

V2 再做完整协作模式 / Orca:

- Lead + Worker 双会话编排。
- worker 列表、focus、create worker、archive worker、stop collaboration。
- split/toggle pane 的移动端重构。
- worker attention、worker 会话跳转、跨 worker 上下文同步。

V1 必须能识别协作会话并安全展示,但不提供完整操作。不能因为遇到 worker / lead / Orca session 崩溃。

## 3. 桌面端信息架构与路由

桌面版核心路由:

- `/login`: 登录。
- `/cc-agent/new`: 新会话草稿页。
- `/cc-agent/scheduled`: 自动化 / 计划页。
- `/cc-agent/files/:sessionId`: 文件浏览和会话选项卡页。
- `/cc-agent/orca/:sessionId`: Orca 协作工作流。
- `/cc-agent/:sessionId`: 普通会话页。

手机版对应的信息架构建议:

| 手机入口 | 对应桌面语义 | V1 |
| --- | --- | --- |
| 首页 | 桌面左侧会话列表 + remote origin | 必做。直接聚合所有可控电脑的 Pinned / Projects / Chats / sessions。 |
| 设备 | 远程可控电脑列表,同账号在线且开启 remote control | 二级/调试。只承载不可控原因、撤权、同步失败和重新同步。 |
| 会话详情 | `/cc-agent/:sessionId` 的移动版 | 必做 |
| 新建 | `/cc-agent/new` 的移动版 | 必做 |
| 自动化 | `/cc-agent/scheduled` 的移动版 | V1B 必做 |
| 文件 | `/cc-agent/files/:sessionId` 的移动只读版 | V1B 只读,V2 编辑 |
| 协作 | `/cc-agent/orca/:sessionId` 的移动版 | V2 |

桌面的大屏侧边栏不适合按布局直接移植到手机,但它的信息层级必须作为手机版首页母版。手机版首页直接承载桌面侧边栏的会话列表语义;设备只作为筛选、归属和调试上下文,不作为进入会话前的必经 push navigation。会话详情内部用底部 sheet / full-screen route 承载设置、队列、计划详情、文件引用等次级面板。

## 4. Device Link 远程控制层

### 4.1 设备发现

桌面源码里的远程设备镜像规则:

- 只有同账号设备才可见。
- 当前设备自己不应出现在可控列表。
- 被控电脑必须在线。
- 被控电脑必须开启 `remoteControlEnabled`。
- 设备下线、关闭远控、连接断开时,控制端要移除对应 remote shard。

手机版实现:

- `DeviceListScreen`: 展示可控电脑,状态包括 online、offline、disabled、revoked、connecting、syncing。
- 列表项显示电脑名、平台、最近在线、会话数量、当前活跃状态。
- 进入设备后订阅 `sessions` topic,并做一次 bootstrap。
- WS reconnect 后必须重新 subscribe + bootstrap,不能只相信本地缓存。

### 4.2 订阅主题

`packages/device-link/src/topics.ts` 定义当前核心 topic:

- `sessions`: 会话列表级别的 created / patched / removed。
- `session:<id>`: 单会话消息、状态、pending interaction、queue、metadata。

手机版实现:

- 会话列表页订阅 `sessions`。
- 进入会话详情后订阅 `session:<id>`。
- 离开会话时 unsubscribe,但允许短时间延迟释放以支持快速返回。
- 后台时保持最小订阅,前台恢复后强制 resync。

### 4.3 调用通道和 allowlist

桌面被控端通过 allowlist 限制远程调用,避免控制端直接写全局设置或绕过业务层。手机版所有操作都必须走统一 transport,不能在 UI 中散落 raw channel 字符串。

需要封装:

- `mobileDeviceLinkClient.invoke(channel, payload)`
- `mobileSessionApi.listSessions(deviceId)`
- `mobileSessionApi.getSession(deviceId, sessionId)`
- `mobileSessionApi.sendMessage(...)`
- `mobileSessionApi.stopSession(...)`
- `mobileInteractionApi.resolvePermission / resolveAskUser / resolvePlan / resolveIssue`
- `mobileScheduleApi.list / create / update / runNow / pause / resume / delete`

实现要求:

- 每个 API 必须有 typed request / response。
- channel 字符串集中定义。
- 对 `ACCESS_REVOKED`、offline、timeout、allowlist denied 做统一错误映射。
- revoked 的真相源在被控电脑端,手机只展示结果。

### 4.4 撤销与恢复

桌面端 revoke 逻辑是被控电脑侧的 source of truth:

- 被控电脑把 controller 加入 revoked blacklist。
- link open 会被 close reason `revoked` 拒绝。
- invoke 会返回 `ACCESS_REVOKED`。
- 控制端要清空该设备的 remote shard 并展示“访问已撤销”。

手机版实现:

- 设备卡片状态改为 `revoked`。
- 清空会话列表和会话详情缓存。
- 不自动重试 invoke。
- 给出重新授权说明,但不在手机端伪造“恢复授权”。

## 5. 会话列表与侧边栏语义

桌面侧边栏承担的语义很多,手机版需要拆成可扫描的列表和筛选面板。

### 5.1 会话列表内容

每个 session item 至少要支持:

- 标题。
- 所属工作目录 / 项目名。
- agent 类型: Claude Code / Codex。
- 状态: running、waiting for permission、waiting for plan、waiting for answer、idle、error、archived。
- 最后一条消息摘要。
- 更新时间。
- pinned 标记。
- scheduled / automation 关联标记。
- worker / lead / orca 标记。
- remote host 标记。
- unread / attention 状态。

### 5.2 桌面侧边栏交互

桌面版侧边栏包含:

- 新会话入口。
- 搜索会话。
- pinned 分组。
- 普通会话按项目、时间或状态分组。
- 项目菜单。
- session context menu: rename、pin/unpin、archive、delete、fork、open files 等。
- running / attached / pending 时的保护性确认。
- 远程设备会话与本地会话合并显示。

手机版落地:

- 顶部: 当前设备 selector + 搜索。
- Tab / segmented filter: 全部、进行中、等待我处理、已归档、自动化。
- Sort sheet: 最近更新、项目、pinned 优先、agent 类型。
- Swipe actions: pin、archive。
- Long press menu: rename、fork、delete、open files、copy session id。
- 等待我处理必须聚合 permission / ask user / plan review / issue confirm。

### 5.3 V1 必做

- 会话列表实时同步。
- 搜索标题、项目、最近摘要。
- 状态筛选。
- pinned、archive、rename。
- 进入 session。
- pending interaction attention。

### 5.4 V1 可后置但要留接口

- 多选批量操作。
- 复杂项目菜单。
- 本地文件页的 sidebar swap。
- 全量 history grouping 动画。

## 6. 新会话与草稿页

桌面 `NewMakerDraftRoute` 和 `ChatInput` 共同决定新会话体验。

### 6.1 桌面新会话能力

新会话要覆盖:

- agent 选择: Claude Code / Codex。
- 工作模式: dialogue / project / remote project。
- 工作目录选择。
- 最近项目。
- worktree 开关。
- 初始 prompt。
- 附件。
- @ mention 文件 / 目录。
- slash command。
- 模型选择。
- effort 选择。
- permission mode。
- fast mode。
- extra directories。
- voice input。
- collaboration mode toggle。

### 6.2 手机版 V1 实现

手机版新建页不应做成桌面表单压缩版,建议分三段:

1. 目标: 选择远程电脑、项目 / 目录、agent。
2. 设置: 模型、effort、权限、fast mode、worktree、extra dirs。
3. 输入: prompt、附件、@ mention、语音。

交互要求:

- 默认继承该设备上最近一次会话偏好。
- 项目选择优先展示最近项目和已知工作目录。
- 远程目录选择必须通过被控电脑的 file browse API,不能假设手机本地路径。
- 未选目录时允许 dialogue 会话,但 project 会话必须有 remote workingDir。
- collaboration toggle 在 V1 显示为不可用说明或隐藏,V2 再启用。

## 7. 会话详情页

桌面 `CCAgentSessionView` 的结构:

- 顶部 `SessionContentHeader`。
- 中间 `MessageStream`。
- 底部 sticky input overlay。
- `RunningStatusBar`。
- `ErrorBanner`。
- `UpgradeBanner`。
- pending interaction host。
- `TakeoverMask`。
- worktree creating overlay。
- `ChatInput`。

### 7.1 手机版布局

建议结构:

- Header: 返回、设备名、session title、状态、更多菜单。
- Status strip: running / waiting / error / syncing / revoked。
- Message list: 与桌面语义一致的虚拟列表。
- Floating pending card: 当有 pending interaction 时替代输入器。
- Composer: 底部输入栏。
- Bottom sheets: 模型、权限、队列、附件、计划、更多操作。

### 7.2 Interaction 优先级

桌面优先级是:

1. Plan Review。
2. Permission。
3. Ask User。
4. Issue Confirm。

手机版必须保持同样优先级。任何 pending interaction 出现时:

- 隐藏普通输入器。
- 隐藏 takeover / worktree overlay。
- 展示对应操作卡。
- 操作完成后重新拉取 session snapshot,避免本地 optimistic state 漂移。

### 7.3 错误与连接状态

需要状态:

- sync failed: 支持 retry。
- device offline: 只读展示,禁止 send/resolve。
- revoked: 退出会话或回到设备页。
- session attached / takeover: 展示桌面正在接管,手机不能重复接管。
- worktree preparing: 展示不可输入状态。
- unsupported collaboration: 展示只读降级说明。

## 8. 消息流渲染清单

桌面 `MessageStream` 会把原始事件折叠成几类 render item:

- `message`: user / assistant / system。
- `todo`: TodoWrite 状态组。
- `tool_segment`: tool use 和 tool result。
- `tool_media`: 从 tool result 中提取出来的图片、视频、音频、模型文件。
- `work_group`: thinking、tool、todo、intermediate assistant 的折叠工作组。

手机版要保留这个 render model,否则桌面和手机看到的会话会不一致。

### 8.1 滚动和分页

桌面语义:

- 初始只渲染最近窗口。
- 向上滚动触发加载更多。
- prepend 旧消息时保持 scroll anchor。
- 用户在底部附近时自动跟随新消息。
- 用户不在底部时显示 unread / jump to bottom。
- 新 user message 发送后强制 follow。
- 支持 focus message / search jump。
- 支持 previous user question jump。

手机版实现:

- 用 `FlashList` 或等价虚拟列表。
- 按 session snapshot + incremental events 维护稳定 key。
- 加载更多不能导致列表跳动。
- 新消息到达时若用户在底部 120px 内自动跟随。
- 否则显示“新消息”浮层。
- 支持从会话列表的 pending attention 直接跳到对应消息。

### 8.2 User message

桌面展示:

- 文本气泡。
- 长文本折叠和展开。
- 图片预览。
- 文件 chips。
- action bar: time、copy、rewind / undo、fork。
- 图片 lightbox。
- 文本 lightbox。
- rewind preview dialog。

手机版:

- 文本、图片、文件必须完整展示。
- 完成态正文尽量支持在当前可见文本上直接选择复制;长文本 full-screen text view 只能作为阅读兜底。
- 图片点开全屏预览,并支持当前消息窗口 gallery 上一张/下一张。
- 文件 chip 点开走文件预览或下载到临时缓存。
- copy、fork、rewind、time 放在消息结束处轻量 action bar,图标语义和顺序对齐桌面。
- 第一条 user message 不显示 rewind。

### 8.3 Assistant message

桌面展示:

- Markdown renderer。
- streaming body。
- 非 streaming 才显示 action bar。
- copy、fork、time、cost。
- remote cc fork 在部分场景会被 capability gate 禁用。

手机版:

- Markdown 支持代码块、表格、列表、引用、链接。
- streaming 时保持低延迟增量渲染。
- 完成态正文尽量支持在当前可见文本上直接选择复制。
- copy、fork、time 放在消息结束处轻量 action bar;token/cost 等细节进入详情 sheet。
- cost 信息不应挤在主消息上,放进详情 sheet。

### 8.4 Thinking / Work group

桌面会把 thinking、tool、todo 和中间 assistant 合并为 work group,避免长链路刷屏。

手机版:

- 默认折叠工作组。
- 折叠态展示 summary、工具数量、耗时、是否有错误。
- 展开后按桌面顺序展示 thinking、tool、todo、intermediate assistant。
- streaming 中的 work group 要能实时更新。

### 8.5 Tool actions

桌面 tool row 涵盖:

- Bash / command。
- Read / Write / Edit / MultiEdit。
- Grep / Glob / LS。
- WebFetch / WebSearch。
- TodoWrite。
- MCP tool。
- command result。
- diff payload。
- error payload。

手机版:

- 默认 compact card。
- command 类显示命令、状态、退出码、耗时。
- 文件类显示路径、操作类型、diff 摘要。
- diff 进入专门 diff view,全屏展示文件头、统计、多段 Edit 和旧/新横向对照。
- 长 payload 默认折叠。
- error tool 高亮但不要打断消息流。

### 8.6 Tool media

桌面 `AgentActionRow` 会从 tool result 中提取:

- `xdt_image_url` / `xdt_image_urls`。
- `xdt_video_url` / `xdt_video_urls`。
- `xdt_audio_urls` / `_xdt_audio_tracks`。
- `_xdt_model_files`。
- `_xdt_render_image`。
- `_xdt_actions`。

手机版:

- 图片、视频、音频从远程电脑 fetch,本地短期缓存。
- 图片已支持详情预览、当前窗口 gallery 和跨平台缩放控制;真 pinch zoom 后续再评估是否引入手势库。
- 视频支持播放和全屏。
- 音频支持播放队列。
- 3D/model 文件 V1 可显示文件卡 + 下载/打开提示,V2 再做预览。
- `_xdt_actions` V1 先安全展示为不可用或二次确认按钮;V1B/V2 再通过远程 UI trigger 触发。
- 同一 action 一旦接入触发,必须在 inflight 时锁住,避免重复触发。

### 8.7 Todo list

桌面 TodoWrite 会被聚合成 `TodoListCard`。

手机版:

- 支持 pending / in_progress / completed 状态。
- 展示 completed/total 和当前 in_progress。
- 用桌面同族图标表达三态。
- 内联展示列表,不做完整 Todo sheet 或“查看全部任务”按钮。
- 流式更新时保持列表稳定,不能闪烁。

### 8.8 System cards

桌面 system cards 用于提示会话状态、工具结果、错误等。

手机版:

- 低视觉权重。
- 不抢占 pending interaction。
- 错误可展开详情。

## 9. 输入器与队列

桌面 `ChatInput` 是一个复杂组合组件,手机版必须拆成底部 composer + sheets。

### 9.1 输入器内容

桌面输入器包含:

- TipTap editor。
- 拖拽文件 / 文件夹。
- 图片缩略条。
- slash command palette。
- @ mention panel。
- permission selector。
- extra dirs。
- fast mode toggle。
- collaboration mode toggle。
- model selector。
- voice input button。
- send / stop 双态按钮。
- folder picker row。

手机版 V1:

- 多行文本输入。
- 底部常驻入口 icon-first:附件/更多、输入框、语音、发送/停止;语音放在发送左侧。
- 附件面板展开后再显示被控电脑路径、本机文件、相册多选图片、拍照图片。
- @ mention 按钮。
- slash command 入口。
- 权限模式 sheet。
- 模型/effort sheet。
- fast mode toggle。
- 语音输入。
- send / stop 主按钮。
- extra dirs sheet。

V1 不启用 collaboration toggle,但要在 session 设置中显示“协作模式暂不支持手机版完整控制”。

### 9.2 Pending queue

桌面 `PendingQueuePanel` 与输入器 fused:

- 当前 session running 时,新输入进入 pending queue。
- 可以查看排队消息。
- 可以编辑、删除、继续发送。
- stop/resume 有锁。
- 队列状态影响 send button。

手机版:

- 输入器上方显示队列 chip,如“3 条排队”。
- 点击打开 queue sheet。
- queue sheet 支持查看、编辑、删除、清空。
- running 时发送默认入队。
- 用户长按 send 可选择“立即尝试发送 / 排队”,具体是否允许由桌面状态决定。
- stop 按钮必须有 loading / disabled 状态,避免重复停止。

### 9.3 语音输入

桌面 voice input 支持:

- 点击开始/停止。
- 长按录音。
- 松手在发送区域可 stop and send。
- listening / refining / submitting 状态。

手机版:

- 已接 `expo-audio` 原生录音能力。
- 支持按住说话和点击录音两种模式。
- 录音后先通过 `/api/device-link/media/presign-put` 上传 OSS,再走 `device-link:voice:transcribe` 让被控桌面端下载音频并复用桌面 voice-input batch ASR 配置转写。
- 转写中输入框不可编辑;结果只插入当前 draft,不自动发送,避免误识别直接进队列。
- 用户取消录音不发送空消息。
- 录音权限被拒时展示明确错误,并提供系统设置跳转。

## 10. Pending Interactions

### 10.1 Permission prompt

桌面语义:

- 工具执行前请求授权。
- 可允许、拒绝,可能有一次性 / 本次会话 / 总是允许等模式。
- 展示工具名、风险、参数摘要。

手机版:

- 展示工具名、文件路径/命令、风险摘要。
- 主按钮: 允许。
- 次按钮: 拒绝。
- 更多: 本次会话允许、总是允许,具体取决于桌面返回的 option。
- 对高风险命令用确认二次弹层。

### 10.2 Ask User

桌面语义:

- agent 明确向用户提问。
- 可能有自由文本输入。
- 可能有 2-3 个互斥选项。

手机版:

- 用 sheet 或卡片展示问题。
- 选项用 segmented/list buttons。
- 自由输入用 text area。
- 提交后禁用,直到桌面确认。
- 支持返回消息位置。

### 10.3 Plan Review

桌面语义:

- `PlanViewerCard` 展示计划。
- `PlanActionCard` 提供接受、修改、拒绝等操作。
- Plan Review 优先级最高。

手机版:

- 全屏 plan review。
- 计划项支持展开。
- 操作: 通过、要求修改、拒绝。
- 要求修改时必须输入反馈。
- 决策提交后等待 session snapshot 更新。

### 10.4 Issue Confirm

桌面语义:

- 创建 issue / 外部记录前需要确认。
- 展示标题、正文、目标等。

手机版:

- V1 只识别并提示“回电脑端处理”。
- 不展示可编辑 issue 表单,不从手机端提交 confirmed true。

## 11. 自动化与计划

这里的“计划”有两层: 会话内的 Plan Review,以及桌面 `SchedulerPage` 的自动化计划。两者都要覆盖。

### 11.1 Scheduler 桌面语义

`SchedulerPage` 是 master-detail:

- 左侧 `TaskListPane`: 任务列表。
- 右侧 `RunHistoryPane`: 运行历史。
- active / expired 一组,paused 一组。
- 按最近运行时间排序。
- 支持 status filter。
- 支持新建、编辑、运行一次、暂停、恢复、重命名、删除。
- 支持 project automation。
- 支持 clone to user、promote to project、reload project automation。
- 通过 `maker.schedule.onEvent` 订阅事件,不是轮询。

### 11.2 Schedule form 桌面能力

`ScheduleFormDialog` 包含:

- 新建 / 编辑 / project automation 模式。
- 空白 / 模板 segmented。
- 模板库。
- 名称。
- 模板参数。
- cron / schedule 设置。
- once checkbox。
- manually checkbox。
- session mode: fresh / persistent / bound。
- bound session picker。
- prompt textarea。
- Feishu notify 配置。
- worktree toggle。
- agent tabs。
- fast mode。
- model / effort。
- project chip。

### 11.3 手机版 V1B

手机版自动化建议分两步:

1. 查看和控制:
   - 任务列表。
   - 状态筛选。
   - 运行历史。
   - run now。
   - pause / resume。
   - delete with confirm。
2. 创建和编辑:
   - name。
   - prompt。
   - schedule。
   - session mode。
   - agent/model/effort/fast。
   - worktree。
   - template。

暂缓:

- project automation 的高级管理。
- Feishu notify 配置编辑。
- promote / clone / reload 的完整工作流。

但接口和 UI 架构要预留,避免后续重写。

## 12. 文件页与选项卡

桌面文件页不是普通文件浏览器,而是“文件内容 + 会话 rail + session tabs”的组合。

### 12.1 Workdir browse 桌面语义

`WorkdirBrowseRoute`:

- 路由 `/cc-agent/files/:sessionId`。
- 中间是文件内容。
- 右侧是 chat rail。
- sidebar 替换成 file tree。
- selected file 存在 URL `?file=<relPath>`。
- file tabs 与 sidebar 共享 selected file。
- remote session 当前会 redirect 回普通会话页。
- Orca worker 会 redirect 到 lead。
- session tabs 是同 workdir/project 的活跃普通会话。
- closing session tab 需要处理 running/attached 确认。
- dirty file close 有 save / discard / cancel。

`FileBodyView`:

- markdown / code / plain text。
- image preview。
- drawio / PDF。
- binary unsupported placeholder。
- edit mode。
- markdown autosave。
- Ctrl/Cmd+S。
- local search。
- external file change handling。

### 12.2 手机版 V1B

V1B 不做完整编辑器,但需要支持:

- 从 tool result 或 message file chip 打开文件预览。
- 文本 / markdown / code 只读查看。
- 图片预览。
- PDF / drawio 可先用外部或降级卡片。
- 文件路径复制。
- 与 session 关联的“打开文件”动作。

当前已落地:

- `.md` / text/code 文件通过 `text-file:read-preview` 按需读取,保留 oversize / forbidden / not_found / read_failed 状态。
- PDF / drawio / Office / binary / unknown 文件只显示降级说明和路径复制,不暴露文本读取按钮。
- `file_preview.yaml` 用 mock host 覆盖 `.md` 文本读取、PDF/drawio 降级、路径复制和 diff 当前文件预览。

暂缓到 V2:

- 完整 file tree。
- 多 file tabs。
- session tabs rail。
- 手机端编辑、保存、dirty conflict。
- 文档模式下 Orca split/toggle。

## 13. 协作模式 / Orca

### 13.1 桌面语义

协作模式不是一个简单开关。桌面 Orca 由这些部分组成:

- `ExtraDirsButton` 的协同模式项:在输入器「+」菜单里开启协作模式偏好。
- `OrcaWorkflowRoute`: lead session 的协作路由。
- `OrcaSplitView`: Lead + Worker 双 pane。
- `WorkerListToolbar`: worker 列表、focus、active count。
- `CreateWorkerPopover`: 创建 worker。
- `useWorkers`: worker 列表和 focused worker。
- `useStopOrcaCollab`: 停止协作。
- worker archive / switch focus / settings。
- split mode: Lead 和 Worker 并排。
- toggle mode: Lead / Worker 单 pane 切换。
- localStorage 保存 split ratio 和 collapsed 状态。

### 13.2 Create worker 能力

`CreateWorkerPopover` 支持:

- 预设角色: developer、designer、reviewer、tester、merger。
- custom role,最长 32,不能与预设重复。
- agent 选择: Codex / Claude Code。
- model / effort / fast mode。
- 初始任务。
- worker creation prefs 持久化。

### 13.3 手机版策略

V1:

- 识别 lead / worker / orca session。
- 会话列表展示协作标记。
- 打开协作会话时进入只读或单会话降级视图。
- 展示“手机版暂不支持完整协作编排”。
- 允许查看 lead 的消息流。
- 不允许 create worker / switch focus / archive worker / stop collaboration。

V2:

- 重新设计 mobile Orca。
- 顶部 worker selector 替代桌面 split pane。
- Lead / Worker 用 segmented 或 pager 切换。
- Worker list 做 bottom sheet。
- Create worker 做 full-screen form。
- Attention worker 用 badge。
- Stop collaboration 做危险操作确认。

## 14. 手机版实现矩阵

| 能力 | 桌面来源 | 手机版实现 | 阶段 |
| --- | --- | --- | --- |
| 设备发现 | `useDeviceLinkRemoteProjects`, `settings-store`, `dispatch` | Device list + bootstrap + reconnect resync | V1A |
| 会话列表 | `remoteProjectsStore`, sidebar session list | Session list, filter, search, attention | V1A |
| 会话详情 | `CCAgentSessionView` | Header + status + message list + composer | V1A |
| 消息虚拟列表 | `MessageStream` | FlashList, anchor, unread, load more | V1A |
| User message | `UserMessage` | text/image/file/action sheet | V1A |
| Assistant message | `AssistantMessage` | markdown/streaming/copy/cost | V1A |
| Tool actions | `AgentActionRow`, `AgentActionsBlock` | compact tool cards + details | V1A |
| Tool media | `extractToolResultMedia`, media cards | image/video/audio preview + cache | V1A |
| Todo | `TodoListCard` | compact todo + full sheet | V1A |
| Work group | `WorkGroupBlock` | folded thinking/tool group | V1A |
| Composer | `ChatInput` | mobile composer + settings sheets | V1A |
| Queue | `PendingQueuePanel` | queue chip + queue sheet | V1A |
| Permission | `PermissionPrompt` | permission card + resolve API | V1A |
| Ask User | `AskUserQuestionPrompt` | answer sheet/card | V1A |
| Plan Review | `PlanViewerCard`, `PlanActionCard` | full-screen plan review | V1A |
| Issue Confirm | `IssueConfirmCard` | desktop-only unsupported hint on mobile | Deferred |
| Stop / retry / cancel | `CCAgentSessionView`, error banner | header/status actions | V1A |
| Rename / archive / pin | sidebar/session handlers | list/menu actions | V1A |
| Fork / rewind | message action bar | message action sheet | V1B |
| Model / effort / fast | `ModelSelector`, `FastModeToggle` | session settings sheet | V1A |
| Extra dirs | `ExtraDirsButton` | remote directory picker sheet | V1B |
| Slash / @ mention | palettes in `ChatInput` | command / mention sheets | V1B |
| Voice input | `VoiceInputButton` | native recording + desktop ASR transcribe into draft | V1B 已完成首版 |
| Scheduler list | `SchedulerPage`, `TaskListPane` | automation list + history | V1B |
| Scheduler run control | schedule actions | run now / pause / resume / delete | V1B |
| Scheduler create/edit | `ScheduleFormDialog` | mobile form | V1B |
| File preview | `WorkdirBrowseRoute`, `FileBodyView` | read-only preview from session | V1B |
| Full file editor | `FileBodyView` edit mode | mobile editor | V2 |
| File/session tabs | `SessionTabsBar`, `FileTabsBar` | mobile tabs/pager | V2 |
| Orca collaboration | `OrcaSplitView` | full mobile collaboration | V2 |

## 15. 测试计划

用户不应该再承担主测试。需要建立自动化测试链路。

### 15.1 单元测试

覆盖:

- remote topic parser。
- device eligibility。
- revoked / offline / reconnect state reducer。
- session list merge。
- message render item builder。
- tool media extraction fixtures。
- pending interaction priority。
- queue reducer。
- scheduler form serialization。
- mobile route guards for Orca / file editor unsupported paths。

### 15.2 集成测试

建立本地 mock topology:

- mock server。
- mock desktop host。
- mock mobile client。
- device link relay。

测试场景:

- 手机登录 mock user。
- 发现电脑。
- subscribe sessions。
- 创建 session。
- 收到 streaming assistant。
- 发送消息。
- running 中继续发送进入 queue。
- permission prompt 到达并 resolve。
- plan review 到达并 approve。
- media tool result fetch。
- 设备 offline 后 UI 禁用 send。
- revoked 后清空设备 shard。
- reconnect 后 resubscribe + bootstrap。

### 15.3 原生 E2E

建议用 Maestro 或 Detox。优先 Maestro,脚本更轻,AI 维护成本低。

核心 flow:

- iOS simulator 打开 app,进入本地 mock 登录。
- 选择电脑。
- 进入会话。
- 发送消息。
- 等待 mock assistant streaming。
- 处理 permission。
- 处理 ask user。
- 打开媒体。
- 打开 queue。
- 停止 running session。
- 切到自动化页 run now。

Android 跑同样 flow,保持脚本共用。

### 15.4 视觉回归

需要保存关键截图:

- 设备列表空态 / 有设备 / revoked。
- 会话列表全部 / waiting / archived。
- 会话详情 idle / streaming / pending。
- tool group 折叠 / 展开。
- media lightbox。
- plan review。
- permission prompt。
- automation list。

每次 UI 改动后跑 simulator screenshot diff。

### 15.5 性能指标

V1 验收指标:

- 1000 条消息列表可滚动,无明显掉帧。
- 进入会话首屏小于 1s,不含网络慢请求。
- streaming token 到 UI 小于 200ms。
- send 点击到桌面 ACK 小于 2s。
- reconnect 后 5s 内恢复 sessions snapshot。
- 图片预览先显示占位,不阻塞消息列表。
- 小屏宽度 375px 无文字重叠。
- 动态岛 / 刘海 / Android gesture nav 不遮挡输入器。

## 16. 调优计划

### 16.1 数据同步调优

- 所有 session state 变更先落到 normalized store。
- message event 用 append-only + snapshot reconcile。
- 对 streaming 文本做节流渲染,避免每 token 重排。
- 列表页只订阅 `sessions`,详情页再订阅 `session:<id>`。
- 图片、视频、音频按需 fetch。

### 16.2 交互调优

- pending interaction 永远比输入器优先。
- 底部 composer 高度变化必须平滑,不能跳动。
- 键盘弹出时保持最后消息可见。
- 桌面 hover action 迁到手机时优先放到消息结束处轻量 action bar 或真实 row action;长按菜单只承载次级动作和兜底。
- 大块内容进入 full-screen sheet,不在消息气泡内挤压。

### 16.3 可靠性调优

- 每个 invoke 都有 request id 和 timeout。
- timeout 后允许 retry,但 resolve 类操作必须防重复提交。
- revoke / offline / allowlist denied 统一进入只读状态。
- 本地草稿按 deviceId + sessionId 保存。
- app 进入后台时保存 scroll anchor 和 draft。

## 17. 第一版执行顺序

建议按下面顺序做,每一步都有可自动验证的结果:

1. Remote store 和 typed API: 设备、sessions、session snapshot、invoke 错误映射。
2. 会话列表: 设备选择、session filter/search、attention。
3. 会话详情只读: message render item、虚拟列表、media fetch。
4. Composer: send/stop/queue。
5. Pending interactions: permission、ask user、plan、issue。
6. 会话管理: rename、pin、archive、fork、rewind。
7. 新会话: remote workdir、agent/model/permission/fast、初始 prompt。
8. 自动化 V1B: list/history/run/pause/resume/delete。
9. 自动化表单: create/edit。
10. 文件预览: 从消息和 tool result 打开。
11. E2E 和视觉回归接入 CI 或本地一键脚本。
12. Orca 只读降级检查。

完成这 12 项后,手机版才算达到“非协作功能基本对齐桌面”的第一版标准。

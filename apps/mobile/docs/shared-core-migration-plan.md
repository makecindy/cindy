# Cindy Mobile Shared Core Migration Plan

> 反馈范围修订（2026-11-11）：本文旧有的 Issue Confirm「desktop-only／不做手机表单」限制及全屏表单方案仅作历史记录，已由[当前反馈卡片范围](remote-control-plan.md#反馈卡片当前范围)替代。

> 日期: 2026-06-18
> 目标: 把桌面端和手机版共同依赖的会话展示语义沉到 shared core,让 `apps/mobile` 专注 iOS / Android 原生能力和触控交互。
> 当前状态: `packages/maker-shared` 已建立,并已迁入 queue/input projection、queue row action model、device list presentation、session controls overview、session action strip/identity model、session list / bulk selection model、system card presentation、agent capability projection、composer palette model、pending interaction model、pending resolve guard、message normalize content preview / stable sort / tool_use parse / tool_result pairing model、message render grouping model、message presentation model、message window/search/load-earlier action model、file browser/preview model、automation/schedule/form/session-mode/event/display-summary/action capability model、device-link controller contract、payload summary/body/preview model 第一刀,以及 C2 session operation/composer action model 第一刀。C2.5 keyboard/native visual check 已开始,远端不可用时的 session read-only state / disabled reason 已补进 shared operation model;键盘、SafeArea、sheet 高度、相机/语音/文件选择、主窗口 screen-width 布局、主窗口 action hierarchy 和真实 native 生命周期仍留在 mobile native shell。

## 1. 架构结论

手机版不应该复制桌面端业务状态机,也不应该强行共享桌面 React 组件。正确边界是:

- `apps/mobile` 继续作为 iOS / Android 原生壳:登录、深链、相机、相册、文件选择、语音、触控、离线安全存储和 RN 视觉实现都留在这里。
- 桌面端继续作为被控端和数据真相源:会话、消息、队列、pending interaction、计划、文件、媒体和运行设置由电脑端产生和裁决。
- `packages/maker-shared` 承载纯 TypeScript 展示模型和协议模型:输入是桌面端原始数据或 device-link payload,输出是桌面/移动端都能消费的 render model、interaction model、queue model 和 fixture。
- 桌面端和手机版不共享 UI 组件,只共享“展示模型”和测试 fixture。桌面渲染成大屏布局,RN 渲染成手机 stack / sheet / full-screen modal。
- device-link 仍然是传输层 contract,不承载业务状态。shared core 可以定义 channel/payload 类型和错误映射,但不做网络连接、订阅生命周期或存储。

## 2. 分层边界

| 层 | 归属 | 可以做 | 不可以做 |
| --- | --- | --- | --- |
| Desktop truth source | `apps/desktop` main / renderer / localDb / maker-core | 产生会话、消息、pending interaction、schedule、file/media 真相;通过 device-link 暴露受控能力。 | 为手机写单独业务分支或绕开已有 handler。 |
| Shared core | `packages/maker-shared` | 纯函数、类型、展示模型、序列化、排序、折叠、fixture、跨端快照测试。 | 引入 React、React Native、Electron、Expo、DOM、storage、network、logger。 |
| Mobile native shell | `apps/mobile` | 登录、深链、相机/相册/文件/语音、安全存储、触控 UI、RN navigation、device-link 连接生命周期。 | 自己裁决桌面业务真相,或复制一套不可复用状态机。 |
| Desktop renderer adapter | `apps/desktop/src/renderer` | 把 shared model 渲染成桌面布局,逐步替换重复的纯函数。 | 让 shared core 依赖桌面组件或 IPC。 |
| Device-link package | `packages/device-link` | 传输协议、topic、allowlist、连接状态。 | 处理会话展示、队列 UI、计划表单等产品语义。 |

## 3. Shared Core 模块清单

| 模块 | shared core 内容 | mobile 保留内容 | desktop 对齐方式 | 当前状态 |
| --- | --- | --- | --- | --- |
| session/message normalize/render model | 已迁入 raw content preview、raw message stable sort、stable key、tool_use parse、tool_result by-id / legacy adjacency pairing、Orca 空通信结果隐藏、render item 分组、tool group、TodoWrite 卡、thinking/work group、duration、stable group key,并已迁入 message window / scroll anchor / load-earlier action 决策和 message search 命中模型。完整 normalized message shape、附件读取、system card metadata、media resolver 仍留在 mobile adapter。 | RN `MessageRenderer`、WebView Mermaid/media player、手势和 sheet;mobile 只做 role-specific adapter 和 native payload 承载。 | 后续把 `MessageStream.buildRenderItems` 的纯语义抽到 shared,桌面组件消费同一模型。 | 已迁入 `packages/maker-shared/src/messageNormalize.ts`、`messageRender.ts`、`messageWindow.ts`、`messageSearch.ts`;shared fixture 已覆盖分组行为;raw desktop-like message fixture 已接入 mobile parity 单测。 |
| message presentation model | bubble density/role label、desktop-style fold header、todo progress/summary/status、错误识别、diff 计数;不产出 mobile-only badge/signals。 | RN 消息气泡样式、折叠面板、tool row / todo sheet 触控布局。 | 桌面消费前先补 fixture parity;短期由 mobile adapter re-export 保持兼容。 | 第一刀已迁入 `packages/maker-shared/src/messagePresentation.ts`;mobile `messagePresentation.ts` 已改为 re-export;shared + mobile 测试覆盖。 |
| pending interaction model | Permission / Ask User / Plan Review 的展示模型、优先级、decision serialization、计划目录提取;`issue_confirm` 仅保留桌面协议兼容和降级识别。 | bottom sheet / full-screen wizard、离线本地 draft 存储;Issue Confirm 不做手机表单。 | 桌面 prompt 组件和手机 prompt 组件后续使用同一 permission/ask/plan decision fixture;Issue Confirm 留在桌面反馈链路。 | 已迁入 `packages/maker-shared/src/interaction.ts`;桌面消费待接入。 |
| queue/input projection model | stop options、queue summary、move target index、Orca queue item 识别、只读提示。C2 已补 queue row action availability、move target、busy/read-only/steering/edit-lock/interaction-lock/Orca disabled reason。 | composer 输入、附件 materialize、图片/语音上传、触控编辑 UI。 | 桌面 `PendingQueuePanel` 后续可消费同一 summary / move 规则。 | 已迁入 `packages/maker-shared/src/queue.ts`;C2 queue row guard 第一刀已完成。 |
| composer palette model | slash/@ 触发检测、命令合并/过滤、@ 资源排序、slash 插入和 desktop-compatible @ 序列化。 | RN 候选面板、远程命令/skills/@ 扫描调用、键盘高度、触控行。 | 桌面 `SlashCommandPalette` / `AtMentionPanel` 后续可用同一触发和序列化 fixture 对齐。 | 已迁入 `packages/maker-shared/src/composerPalette.ts`;mobile 会话页和新建会话页通过 adapter re-export 消费。 |
| session controls/runtime options | model/effort/permission/fast/extraDirs/context/spend 的 overview、只读/归档提示、capability projection。 | bottom sheet 表单、设备调用、toast、copy/share。 | 桌面 header/sidebar/settings 后续可消费同一 overview。 | overview 已迁入 `sessionControls.ts`;capability projection 已迁入 `agentCapabilities.ts`;C2 已补入口/disabled 状态。 |
| session action strip model | 会话身份/Worktree/用量摘要、header title/subtitle、state chips、settings/usage/files/queue/search action、active/attention/disabled reason。 | RN action pill 排版、sheet 打开、SafeArea、触控反馈和 platform visual polish。 | 桌面 `SessionContentHeader` / `TopRightChipStack` 后续可消费同一 action/disabled fixture。 | 已迁入 `sessionActionStrip.ts` 和 `sessionIdentity.ts`;mobile header 消费 action 数组并保留 Maestro literal testID。 |
| device list presentation | 同账号设备的可控性、撤权/离线/未开启远控分类、排序、平台标签、列表可见性、header/filter/empty/toggle 文案。 | RN `FlatList`、设置入口、重新同步调用、设备详情导航、状态点视觉。 | 桌面 remote devices 设置页后续可复用同一状态/文案 fixture。 | 已迁入 `deviceList.ts`;mobile `device-link/devices.ts` 保持兼容 re-export。 |
| session list / bulk selection model | 远程会话筛选、搜索、project/date 分组、自动化会话聚合、列表上下文/空状态、批量选择和 archive/pin/restore/delete patch projection。 | RN `SectionList`、长按选择、确认卡、远程 `patchSessionMeta` 调用、导航和刷新。 | 桌面 sidebar 后续可消费同一列表 fixture,先用 shared unit 锁排序/聚合/批量 patch 语义。 | 已迁入 `sessionList.ts` 和 `sessionSelection.ts`;mobile 保持兼容 re-export。 |
| system card presentation | `/help`、`/context`、`/cost`、`/pwd`、`/status`、桌面 `/compact`、`/cmd` system card 的标题、正文、行模型和 context usage 摘要。 | 本地 slash command 注入、RN card 样式、复制/展开等触控能力。 | 桌面 `SystemCard.tsx` 后续可复用同一 context/card presentation,避免 `/context` 详情漂移。 | 已迁入 `systemCard.ts`;`summarizeContextUsage` 已迁到 `sessionControls.ts`;mobile `systemCard.ts` 只保留 adapter。 |
| device-link transport contract | mobile controller 使用的 invoke channel、媒体/语音特判 channel、错误 code 分类、retry policy、relay status 文案、allowlist drift fixture。topic payload 类型待继续抽象。 | WS 连接、subscribe 生命周期、App foreground rehydrate、撤权后的本地 store 清理。 | desktop allowlist 和 mobile transport 已用 drift test 锁住;桌面消费待接入。 | 已迁入 `deviceLinkContract.ts`;mobile transport/error wrapper 已接入。 |
| file browser model | directory entry sort、path crumbs、directory summary、selected file panel、file preview kind/status/failure 文案、文本/非文本预览候选判断。 | RN 文件页、复制路径、分享、移动端 viewer、真实远程读取调用。 | 桌面 file route 和手机只读 file route 后续共用 fixture。 | 已迁入 `packages/maker-shared/src/fileBrowser.ts` 和 `filePreview.ts`。 |
| automation/schedule model | schedule sort/filter、run grouping、run history display summary/action capability、delete policy、form serialization、template defaults、fresh/persistent/bound session mode、run-session summary label/detail、SchedulerEvent normalize/projection、list/runs/session-index/unread refresh intent。 | mobile automations navigation、表单 UI、远程调用、事件订阅 store 和页面刷新调度。 | 桌面 scheduler 和手机 scheduler 后续共用排序/表单/event fixture。 | 已迁入 `scheduleTypes.ts`、`scheduleModel.ts`、`scheduleForm.ts`、`scheduleDelete.ts`、`scheduleEvents.ts`;运行会话三态、摘要可见性、run history meta 和单条 run action capability 已先由 mobile 消费,桌面消费待接入。 |
| payload summary model | payload kind、title、subtitle、copyable text、source/open target、diff formatter、tool_use summary / Edit / Write / MultiEdit diff projection、media action notice、tool_result media extraction、file/media/mermaid/text payload 构造、attachment -> file/media payload projection、viewer body presentation、preview severity、primary action 和 compact meta。更细的 diff/file/media body layout 仍按 C1 增量。 | RN full-screen payload viewer、复制/打开按钮状态、媒体播放器、远程取件生命周期。 | 桌面 payload/lightbox 消费前先补 fixture parity,避免一次性重写桌面 UI。 | 第一刀已迁入 `packages/maker-shared/src/payloadSummary.ts`;mobile payload viewer header/body/preview、tool input diff、tool result media 和 attachment payload 入口已消费;测试覆盖 diff/media/file/mermaid/text summary/body/preview、tool_use summary / diff projection、tool_result media extraction 和 attachment projection。 |
| fixtures | shared remote-control baseline fixture,覆盖普通会话、消息/工具/todo、pending interaction、queue、schedule、file/media、Orca safe-degrade、raw desktop-like message 样本和 schedule/file raw payload。 | Maestro / simulator 场景组装。 | desktop vitest 和 mobile vitest 消费同一 fixture;桌面 UI 逐步接入 shared projection。 | 初版已建立 `fixtures.ts`;shared fixture test、mobile parity test 和 desktop renderer parity test 已覆盖消息/schedule/file 主链路。 |

## 4. 迁移顺序

1. 已完成:创建 `packages/maker-shared`,加入 workspace,跑通 build/test。
2. 已完成:迁移 queue/input projection 的共享纯函数,手机版继续 re-export 兼容旧 import。
3. 已完成:迁移 session controls overview,手机版保留 context、copy、archive/delete 等移动端行为。
4. 已完成:迁移 pending interaction decision serializers、优先级模型、计划目录提取和 Issue 归一;手机版继续 re-export 兼容旧 import。
5. 已完成:迁移 message render model 的稳定分组层和 shared fixtures;手机版保留 role-specific normalize adapter。
6. 已完成:迁移 file browser / file preview 展示模型,保留 RN 文件页面和真实远程读取 adapter 在 mobile。
7. 已完成:迁移 automation/schedule model,把 schedule types、sort/filter/form/delete policy 从 mobile 纯函数变成 shared,并保留 mobile re-export 兼容。
8. 已完成:迁移 device-link controller contract,把 mobile transport 里散落的 channel 和错误分类沉到 shared,并用 allowlist drift test 锁住桌面 dispatch。
9. 已完成:建立 shared remote-control fixture baseline,覆盖普通会话、消息/工具/todo、pending interaction、queue、schedule、file/media 和 Orca safe-degrade。
10. 已完成:扩展 raw desktop-like message fixture,并用 mobile parity test 锁住 normalize + render 分组主链路。
11. 已完成:扩展 schedule / file raw payload,补 desktop renderer parity test,锁住绑定会话自动化的桌面 form 语义和文件分类 parity。
12. 已进入 mobile shell / session detail UI 重构:RN primitives、Session Action Strip、会话页 chrome/main/bottom 层级、Queue sheet、Search sheet、Usage 直达入口、登录页 debug surface、pending interaction bottom surface 和 payload full-screen viewer shell 已落地。
13. 已完成 payload summary 第一刀:diff/media/file/mermaid/text 的 kind/title/subtitle/copy/open target 和 body presentation 进入 shared core,mobile payload viewer header/body 已消费。
14. 已完成 message presentation 第一刀:bubble density/role label、desktop-style fold header、todo progress/summary/status、错误识别和 diff 计数进入 shared core,mobile message bubble / tool row / todo card / work group 已消费;mobile-only badge/signals 字段已移除。
15. 已完成 C2 session operation / composer action 第一刀:`sessionOperation.ts` 输出 slot priority、message history mode、composer availability、send/stop/attachment/voice label、disabled reason、read-only reason 和 primary action;mobile `sessionComposerLayout` / `sessionOperationLayout` 改为兼容 re-export。
16. 已完成 C2 queue row action 第一刀:`buildQueueRowPresentation` 输出 row title/hint、move target、move/edit/remove/steer availability、busy/read-only/steering/edit-lock/interaction-lock/Orca disabled reason;mobile QueuePanel 改为消费 row presentation。
17. 已完成 C2 pending resolve guard 第一刀:`buildInteractionResolveActionPresentation` 输出 resolve button disabled reason / busy label / confirm label,`canStartInteractionResolve` 锁 requestId duplicate guard;mobile InteractionPanel 的 permission / ask / plan / issue resolve 按钮统一消费该模型。
18. 已完成 C2 keyboard/native visual check 第一轮稳定化:键盘、SafeArea、composer/sheet 高度和 iOS native visual 重跑留在 mobile native shell;相册/拍照、本机文件上传、语音录制/转写和 SecureStore 也继续留在 mobile adapter,首版链路已接入。只有发现新的排序、状态优先级或 disabled reason 时才补 shared model。桌面端继续逐步接入 shared core,优先接测试 fixture 和纯 projection,避免一次性重写桌面 UI。
19. 已完成 message window model 第一刀:`messageWindow.ts` 输出 near-bottom 判断、initial/tail/prepend/expanded/replaced 窗口变化、锚点保持、auto-follow 和 new-message indicator 决策;mobile `messageScroll.ts` 保持兼容 re-export。
20. 已完成 message search model 第一刀:`messageSearch.ts` 输出命中 item/source、折叠 work group 父 key、todo/diff/attachment/media/system card 可搜索文本、preview 和 active index wrap;mobile `messageSearch.ts` 保持兼容 re-export。
21. 已完成 capability projection 第一刀:`agentCapabilities.ts` 输出远端能力归一、model/effort/permission/fast 可用性、draft reconciliation 和跨模型类别切换确认;mobile `agentCapabilities.ts` 保持兼容 re-export。
22. 已完成 session action strip 第一刀:`sessionActionStrip.ts` 输出会话 header、state chips、action labels、active/attention/disabled reason;`sessionIdentity.ts` 输出协作、Worktree 和 workspace title 语义;mobile `sessionOverview` / `collaboration` / `sessionWorktree` 保持兼容 re-export。
23. 已完成 scheduler event projection 第一刀:`scheduleEvents.ts` 输出 desktop `SchedulerEvent` 归一、list/runs/session-index/unread refresh intent、run patch hint 和 unread impact;mobile `remoteScheduleEvents` store 消费 projection,自动化页和设备详情页按 intent 分别刷新。
24. 已完成 payload preview/severity 第一刀:`payloadSummary.ts` 输出 diff/file/media/mermaid/text 的 severity、primary action、compact meta、preview text、inline preview / remote fetch flags;mobile message renderer 的 tool result、media、file、diff 入口和 payload header 已消费。
25. 已完成 message load-earlier action 第一刀:`messageWindow.ts` 输出顶部加载更早按钮和搜索 sheet 继续向前搜索按钮的 visible / disabled / label / accessibilityLabel;mobile `MessageRenderer` 和 `SessionSearchSheet` 只负责 RN 渲染和真实分页调用。
26. 已完成 attachment payload projection 第一刀:`payloadSummary.ts` 输出 image/file attachment 到 media/file payload 的转换;mobile `messagePayload.ts` 只保留兼容薄封装。
27. 已完成 tool_result media extraction 第一刀:`payloadSummary.ts` 输出 xdt image/video/audio、Mivo action metadata、render false guard 和 URL dedupe;mobile `messageNormalize.ts` 只保留兼容转发。
28. 已完成 tool input diff / summary projection 第一刀:`payloadSummary.ts` 输出 ToolCallCard 同款 summary 和 Edit / Write / MultiEdit diff projection。
29. 已完成 raw message normalize content preview / stable sort / tool pairing 第一刀:`messageNormalize.ts` 输出 desktop content preview、message stable key、createdAt stable sort、tool_use parse、tool_result by-id / legacy adjacency pairing、Orca 空通信结果隐藏;mobile `utils/contentPreview.ts` 改为 shared re-export,`messageNormalize.ts` 只保留 role-specific adapter、附件读取、system card metadata 和 native media 承载。
30. 已完成 payload body touch layout 第一刀:`payloadBodyLayout.ts` 留在 mobile shell,只把 diff/file/media/mermaid/text 的屏宽相关尺寸、滚动高度和按钮触控尺寸做成平台无关纯模型;payload kind/body/diff/media/file 语义仍由 shared `payloadSummary.ts` 输出。
31. 已完成 message hierarchy touch layout 第一刀:`messageHierarchyLayout.ts` 留在 mobile shell,只把 FoldablePanel、tool row、todo row、todo detail sheet 的屏宽/density 尺寸做成平台无关纯模型;work/tool/todo title、badge、summary、status 语义仍由 shared `messagePresentation.ts` 输出。
32. 已完成 message content touch layout 第一刀:`messageContentLayout.ts` 留在 mobile shell,只把 markdown code/table/list、Mermaid preview、附件、媒体、diff preview 和 tool result preview 的屏宽尺寸做成平台无关纯模型;markdown parser、payload summary、media/file 语义仍由 shared 或现有 adapter 输出。
33. 已完成 main window layout 第一刀:`mainWindowLayout.ts` 留在 mobile shell,只把设备列表、设备详情、新建会话、文件浏览、自动化窗口的 summary、toolbar、content、block、list、empty 和 inline action 尺寸做成 screen width + window kind 模型;设备/会话/文件/schedule 业务语义仍由 shared model 或桌面源码 adapter 输出。
34. 已完成 main window primitives 第二刀:`MainWindowMetric` / `MainWindowEmptyState` 留在 `apps/mobile/src/components/MobilePrimitives.tsx`,只统一 mobile 主窗口的 metric / empty UI 表达;不沉入 shared core,不改变设备/会话/文件/schedule 业务语义。
35. 已完成 main window action primitives 第三刀:`MainWindowActionGroup` / `MainWindowActionButton` 留在 `apps/mobile/src/components/MobilePrimitives.tsx`,只统一 mobile 主窗口的主操作、次级操作和危险操作层级;自动化详情已接入,不改变 schedule run/pause/edit/delete 语义。
36. 已完成 main window action primitives 第四刀:新建会话提交区、文件浏览目录操作区和选中文件预览操作区接入 `MainWindowActionGroup`;只统一 mobile 主窗口操作层级和 Maestro 容器锚点,不改变新建会话 create、文件目录加载、文本预览或复制路径的业务语义。
37. 已完成 main window action primitives 第五刀:`MainWindowActionGroup` 支持 compact density 和 secondary active state,设备详情 toolbar、批量选择操作和批量确认操作接入统一 action hierarchy;只统一 mobile 主窗口操作层级,不改变搜索/筛选状态、批量 session patch 或确认逻辑。
38. 已完成 main window action primitives 第六刀:自动化空态创建、表单保存/取消、删除确认和暂停确认接入 `MainWindowActionGroup`;只统一 mobile 操作层级和 Maestro 容器锚点,不改变 schedule write/delete/pause 的序列化、预览或远程调用语义。
39. 已完成 main window action primitives 第七刀:设备列表顶部不可用设备切换和空态重新同步接入 `MainWindowActionGroup`;只统一 mobile 操作层级和 Maestro 容器锚点,不改变 device visibility 过滤或同步请求语义。
40. 已完成 main window action primitives 第八刀:新建会话远程目录浏览的打开/刷新/上级/使用当前目录动作接入 `MainWindowActionGroup`;只统一 mobile 主窗口操作层级和 Maestro 容器锚点,不改变 remote workdir browse 调用、目录选择或新建会话序列化语义。
41. 已完成 main window action primitives 第九刀:文件页当前目录复制和前往路径动作改用 `MainWindowActionButton`,并继续消费 `mainWindowLayout` 的 inline action 尺寸;只统一 mobile 文件主窗口操作层级,不改变远程路径 stat、目录加载、文件选择或复制路径语义。
42. 已完成 main window action primitives 第十刀:自动化运行历史的打开会话动作改用 `MainWindowActionButton`;只统一 mobile 自动化主窗口行级操作层级,不改变 run grouping、mark read、session index 或打开会话路由语义。
43. 已完成 main window action primitives 第十一刀:设备详情 summary 的自动化入口改用 `MainWindowActionButton`;只统一 mobile 设备主窗口导航入口层级,不改变自动化路由、session 筛选或 schedule 数据语义。
44. 已完成 controls sheet action primitives 第二刀:`SessionControlsPanel` 的重命名、复制、置顶、归档/恢复、删除确认、模型切换、Fast、extraDirs、远程目录和 context 刷新动作统一到局部 `ControlActionButton`;只统一 controls sheet 内的 tone/active/disabled/pressed 表达,不改变 rename/pin/archive/delete/model/effort/permission/fast/extraDirs/context 的远程协议语义。
45. 已完成 payload body action primitives 第二刀:`MessageRenderer` payload body 的远程媒体重试/打开、文件预览加载、diff 当前文件读取和复制远程路径动作统一到局部 `PayloadActionButton`,并给路径动作行补 `message.payloadPathActions` 锚点;只统一 mobile payload viewer 的触控表达和路径切换反馈复位,不改变 payload summary/body、远程媒体取件或文件预览协议语义。
46. 已完成 message content open primitive 第二刀:`MessageRenderer` 消息流里的媒体 preview、file chip、diff preview、tool result preview 和 Mermaid source 打开详情动作统一到局部 `MessageContentOpenButton`;这属于 mobile shell 的触控 owner 收口,不沉入 shared core,也不改变 payload summary/body、markdown parser、文件预览或媒体取件协议语义。
47. 已完成 pending wizard action primitive 第二刀:`InteractionPanel` 内 Ask 选项/自定义入口/上一步、Plan 折叠/模式/尺寸/目录/反馈、Issue 类型切换和 resolve 按钮统一到底层 `InteractionTouchButton`;shared core 仍只负责 decision serialization、resolve guard 和展示模型,mobile shell 负责触控反馈、disabled/selected accessibility 和表单局部状态。
48. 已完成 queue sheet action primitive 第二刀:`QueuePanel` 内继续、错误重试/清除、编辑保存/取消、上移/下移、插话、编辑、删除和展开/收起统一到底层 `QueueTouchButton`;shared core 仍只负责 queue projection、row action availability 和 move target,mobile shell 负责触控反馈、disabled accessibility、edit lock UI 和真实远程调用。
49. 已完成 rewind preview layout/action 第二刀:`rewindPreviewLayout.ts` 留在 mobile shell,只把 rewind preview 面板的屏宽/density 尺寸、可见文件行数和 action 触控尺寸做成纯模型;`RewindPreviewPanel` 的取消/确认/关闭统一到局部 `RewindActionButton`;rewind preview payload 归一、commit-ready 判断和远程 commit 协议不变。
50. 已完成 payload header action primitive 第二刀:`MessageRenderer` payload full-screen header 内复制、打开、上一张、下一张和关闭统一到底层 `PayloadHeaderActionButton`;shared core 仍只负责 payload summary/preview/body 和 gallery payload 输入,mobile shell 负责触控反馈、copy 状态复位和 native `Linking`。
51. 已完成主窗口 controls / connection 入口 action primitive 第三刀:`SessionControlsPanel` 的 inline 运行设置入口、sheet section tabs、远程目录进入行补齐局部 primitive 和 accessibility state;`ConnectionBanner` 的重新同步入口后续已升级为 `MainWindowActionButton` busy state;这属于 mobile shell 的触控/a11y 收口,不改变连接错误映射、重订阅、rename/pin/archive/model/extraDirs/context 或远程目录 browse 协议语义。
52. 已完成 message auxiliary action primitive 第三刀:`MessageRenderer` 的加载更早、新消息跳转、Todo 详情打开/关闭/backdrop、payload 图片缩放按钮统一到局部 `MessageListActionButton` / `TodoActionButton` / `TodoSheetBackdrop` / `ImageZoomControlButton`;同时给 `MessageActionButton` 补 disabled accessibility state;shared core 仍只负责 message window/search/load-earlier action、todo presentation 和 image zoom step 模型,mobile shell 负责触控反馈、modal 关闭和 native image scroll。
53. 已完成 foldable message header primitive 第三刀:`MessageRenderer` 的 Work/Tool/Todo/Thinking 折叠头统一到底层 `FoldableHeaderButton`,补齐展开/收起 accessibility label 并保留原 `message.toolGroupToggle` / `message.workGroupToggle` 锚点;shared core 仍只负责 render item、message presentation 和 hierarchy layout,mobile shell 负责触控反馈和本地展开状态。
54. 已完成 session route action primitive 第一刀:`app/sessions/[sessionId].tsx` 的 composer 附件/语音/停止/发送、搜索上一条/下一条/加载更早、未同步重新同步、历史消息展开和 settings/queue/search backdrop 统一到 `RouteActionButton` / `SheetBackdropButton`;shared core 仍只负责 composer/search/window/session operation 模型,mobile route 负责触控反馈、a11y state、sheet 关闭和 native 输入能力。
55. 已完成 main window option/row primitives 第十二刀:`MobilePrimitives.tsx` 新增 `MainWindowOptionButton` / `MainWindowRowButton`,并让 `MainWindowActionButton` 暴露 active/disabled accessibility state;设备详情筛选/分组/session row/自动化子 row 和新建会话最近项目/运行选项/远程目录行已接入。业务筛选、会话分组、新建会话序列化和远程目录 browse 仍由现有 shared model / adapter 负责。
56. 已完成 main window option/row primitives 第十三刀:文件页路径面包屑、文件/目录行、自动化 segment 和 schedule row 继续接入 `MainWindowOptionButton` / `MainWindowRowButton`;file browser model、schedule model、远程读取、schedule 写入和路由语义仍由 shared model / adapter 负责,mobile shell 只统一触控反馈和 accessibility state。
57. 已完成 main window card/action primitives 第十四刀:`MobilePrimitives.tsx` 新增 `MainWindowCardButton`,并让 option/row primitive 可显式传入 accessibility role/state;设备列表行、自动化删除单选、模板刷新、模板卡片和 boolean toggle 已接入统一 primitive。设备可见性、schedule delete disposition、template 参数和 schedule write 序列化仍由 shared model / adapter 负责,mobile shell 只统一 pressed / selected / checked / disabled 表达。
58. 已完成 connection banner action primitive 第十五刀:`MainWindowActionButton` 新增 busy state,`ConnectionBanner` 的重新同步入口改为消费同一 action primitive。连接错误映射、重订阅、device-link status 和真实 sync 调用不变,mobile shell 只统一 loading spinner、disabled/busy accessibility 和 pressed 表达。
59. 已完成 login action primitive 第十六刀:登录页 Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback URL 兜底和 Web 关闭入口改为消费 `MainWindowActionButton`;OAuth、mock login、callback 解析、本地联调和透明 backdrop 关闭语义不变,mobile shell 只统一可见动作的 pressed、disabled、busy 和 accessibility 表达。
60. 已完成 screen header action primitive 第十七刀:`ScreenHeader` 的右侧 action 从旧 `PillButton` 收敛到 compact `MainWindowActionButton`,并删除无调用方的旧 `PillButton`;设备列表退出、设备详情新会话和自动化新建等头部动作的 testID、onPress、路由和远程调用语义不变,mobile shell 只统一 header action 的 pressed、disabled、busy、tone 和 accessibility 表达。
61. 已完成 session route action primitive 第二刀:`ActionPill` 补齐 selected/disabled accessibility state,queue/search sheet header 关闭入口从 `ActionPill` 改为 `RouteActionButton`;`queue.closeButton` / `session.searchCloseButton` 锚点、onClose 行为、队列模型和搜索模型不变,mobile route 只统一 sheet 关闭动作的触控和 accessibility owner。
62. 已完成 queue/controls state polish:`QueueTouchButton` 支持 busy accessibility state,队列继续、错误重试/清除、编辑保存、行级移动/插话/编辑/删除和展开收起在 busy 时标记同步中;`ControlActionButton` 补齐 selected/disabled accessibility state。queue projection、controls overview、远程调用和 testID 不变,mobile shell 只补齐触控状态表达。
63. 已完成 session route action primitive 第三刀:`RouteActionButton` 把 busy 视为不可交互状态,忙碌期间移除 press / long-press / press-out handler 并应用 disabled 表达;发送、附件、语音、同步、pending resolve 和 sheet 操作的 testID、文案、shared model 与远程调用协议不变,mobile route 只防止处理中重复触发。
64. 已完成 pending interaction action primitive 第四刀:`InteractionTouchButton` 把 busy 视为不可交互状态,权限确认、Ask wizard、Plan review 和 Issue confirm 的局部动作在提交中会移除 press handler 并暴露 disabled/busy accessibility state。shared `buildInteractionResolveActionPresentation` / `canStartInteractionResolve` 继续负责提交状态、文案和 requestId 去重,mobile shell 只做触控防重复。
65. 已完成 message payload action accessibility polish:`MessageContentOpenButton` / `PayloadActionButton` 补齐 disabled accessibility state,并让 disabled 样式跟真实不可点击状态一致。payload summary/body、远程媒体取件、文件预览、路径复制和消息打开详情协议不变,mobile shell 只收口消息主窗口动作状态表达。
66. 已完成 main window primitive interaction-state polish:`MainWindowActionButton` / `MainWindowOptionButton` / `MainWindowRowButton` / `MainWindowCardButton` 把缺少 press/long-press handler 的入口也视为不可交互,并统一 disabled 样式、handler gating 和 accessibility state。设备、会话、新建、文件、自动化、登录的业务语义、路由、远程调用和 testID 不变,mobile shell 只收口主窗口触控状态事实源。
67. 已完成 main window metric selected-state polish:`MainWindowMetric` 作为可点击统计筛选入口时暴露 selected accessibility state。设备详情 summary、自动化 summary、新建会话 summary 的统计值、筛选/导航语义和 testID 不变,mobile shell 只补齐选中态表达。
68. 已完成 shared pill / route action no-handler polish:`ActionPill` 与会话详情 `RouteActionButton` 把缺少 handler 的入口视为 disabled,并统一移除 press / long-press handler。session action strip、sheet close、composer/search/sync 入口的 shared model、远程调用和 testID 不变,mobile shell 只补齐不可交互状态事实源。
69. 已完成 controls action no-handler polish:`ControlActionButton` 把缺少 handler 的入口视为 disabled,并统一 disabled 样式、handler gating 和 accessibility state。controls overview、capability projection、远程调用和 testID 不变,mobile shell 只补齐 controls sheet action 的不可交互事实源。
70. 已完成 shared composer input/remove state polish:`sessionOperation.ts` 的 composer layout 新增 `input` 与 `attachment.remove` presentation,发送中、附件处理中和语音转写中的输入锁定、附件移除锁定和语音入口 disabled reason 都由 shared model 输出;mobile 会话页只负责 TextInput / chip / action 渲染。enqueue、附件上传、语音转写和 device-link 协议不变。
71. 已完成 screen header back action polish:`ScreenHeader` 的左侧返回入口抽成内部 `ScreenBackButton`,统一 pressed、disabled、handler gating 和 accessibility state。设备详情、新建会话、会话详情、文件和自动化 header 的 testID、`router.back()` 和视觉箭头不变,mobile shell 只收口主窗口 navigation primitive。
72. 已完成 schedule form run-session 第一刀:`scheduleForm.ts` 输出 mobile fresh / persistent / bound 派生、切换、pending 绑定占位、真实绑定校验和绑定会话 ID 更新语义;mobile 自动化表单只消费 shared model 渲染三态和绑定会话选择,不再在页面里散落维护 persistentSession / targetSessionId / useWorktree 的互斥规则。桌面 `scheduleFormLogic` 是语义来源,后续可反向合并到 shared core。
73. 已完成 schedule summary run-session 第一刀:`scheduleModel.ts` 的 `summarizeSchedule` 输出 `runSessionLabel` / `runSessionDetail`,把 fresh / persistent / bound 保存结果投影到列表 detail 和详情摘要;mobile 自动化详情只渲染 shared summary 并新增 `automations.runSessionDetail` 锚点。schedule 排序、run grouping、暂停/删除/打开会话和写入协议不变。
74. 已完成 schedule run history summary 第一刀:`scheduleModel.ts` 的 `summarizeRun` 输出运行耗时 meta、session short label、打开会话 label 和无 session interrupted/aborted 的 restart capability。mobile 运行历史新增 `automations.runMeta` 展示 meta 行,先只补齐摘要展示。
75. 已完成 schedule run history action 第二刀:`summarizeRun` 继续输出 `canMarkRead`、`canDelete`、`canRestart` 和动作 label,并在 shared model 中统一处理 legacy session run 与 running run 的动作限制。mobile 行内动作区新增 `automations.runActions`、标已读、重跑、删除按钮和单条 run 删除确认卡;`deviceLinkContract.ts` / mobile transport 补齐 `maker:schedule:delete-run`,mock host 支持本地删除和 schedule event 广播。
76. 已完成 composer palette model 第一刀:`composerPalette.ts` 输出 slash/@ trigger、命令合并/过滤、@ 资源排序、slash 插入和 desktop-compatible @ 序列化;mobile `session/composerPalette.ts` 保持兼容 re-export,只额外保留 remote session agentKind adapter。新建会话首条 payload 也接入该模型和附件-only 验证,避免 new session 与 session composer 形成两套输入规则。
77. 已完成 Settings 主窗口第一刀:`/settings` 作为 mobile shell 主窗口承载登录态、手机设备名、Relay 状态、调试信息和退出登录;这不是 shared core 业务语义,但手机设备名生成已从 settings model 拆到 `device-link/mobileDeviceIdentity.ts`,由 DeviceLink hello 和 Settings 共同消费,避免两个事实源。
78. 已完成 payload full-screen viewer visual gate: `visual-session-payload` 已进入 iOS 默认 baseline 清单,当前 `ios-iphone-17-pro-expo-go` 校验 12 张截图;`buildPayloadModalSafeArea` 留在 mobile shell layout model,只处理 Modal safe area/status bar 避让,不改变 shared payload summary/body 语义。
79. 已完成 data image payload display polish: `packages/maker-shared/src/payloadSummary.ts` 对 `data:image/*` 输出短摘要,不把 base64 长串作为 body/preview 展示;mobile viewer 只消费 shared body presentation,复制/openTarget 仍保留原始 URL。mock host 视觉图片 fixture 改为可见 160x90 PNG,由 Maestro 静态检查防止回退成 1x1。
78. 已完成 system card presentation 第一刀:`systemCard.ts` 输出 help/context/cost/pwd/status/compact/cmd 的 shared presentation,`summarizeContextUsage` 迁入 shared `sessionControls.ts`;mobile adapter 继续负责本地 slash 命令注入和 RN 渲染。System card 是桌面消息语义,不再作为 mobile 私有纯函数维护。

## 5. 实现规则

- shared core 只接受 plain object,不接 React node、class instance、IPC handle、WS client 或 platform API。
- shared core 输出必须可序列化、可快照、可跨端稳定比较。
- shared core 不能包含中文 UI 长文案的最终样式决策;可以输出语义 label/value/notice,具体布局和密度由端上决定。
- 手机端 native 能力只在 `apps/mobile` adapter 层实现,包括 SecureStore、ImagePicker、Audio、DocumentPicker、Linking、Navigation 和 AppState。
- 桌面端 Electron 能力只在 `apps/desktop` adapter 层实现,包括 IPC、localDb、Electron protocol、window focus、菜单和文件打开。
- 每次迁移先保持 mobile 原 import 通过 re-export 不变,降低 UI 改动风险;第二步再清理 import。

## 6. 测试门槛

每迁移一个模块,至少要有三层验证:

- Shared unit: `pnpm --filter @cindy/maker-shared build` 和 `pnpm --filter @cindy/maker-shared test`。
- Mobile adapter: `pnpm --filter mobile typecheck` 和对应 `apps/mobile/src/__tests__/*`。
- Parity fixture:同一份 fixture 在 shared 输出稳定,移动端 UI 测试只断言布局/交互,不再重复断言业务语义。

模块进入桌面消费后,再补:

- Desktop adapter unit:桌面组件或纯函数消费 shared fixture。
- Cross-app parity:同一 raw message / schedule / interaction fixture 在 desktop 和 mobile 的 model 输出关键字段一致。
- E2E smoke:只验证端到端传输和 UI 操作,不把所有语义断言堆到 Maestro 里。

## 7. 近期验收目标

近期不再继续堆移动端本地纯函数,而是按 `mobile-v1-source-plan.md` 的 C/D/E 批次收口:

- `packages/maker-shared` 至少覆盖 queue、session controls、pending interactions、message render model、file browser/preview、automation/schedule model 和 device-link controller contract;当前已覆盖。
- mobile 现有相关测试迁移后仍全绿,并保留兼容 re-export。
- shared fixtures 已覆盖一条远程控制 baseline:用户消息、assistant、thinking、tool、todo、media、permission、ask、plan、issue、queue、schedule、file、Orca 只读;raw desktop-like message fixture、schedule/file raw payload 和 desktop renderer parity 已接入。当前已切到 mobile shell 和 session detail 交互重构,shared core 后续只按新业务语义增量抽取。
- 每个新增移动 UI 优化必须说明它消费哪个 shared model,只有相机/语音/触控/安全存储这类 native 能力例外。
- C 阶段只做 iOS 会话页产品化 polish 和必要 shared model 增量;D 阶段再回到桌面源码矩阵补 parity;E 阶段补双平台发布级自动化门禁。Android 当前只保留 profile/脚本护栏,不提前消耗主线精力。

## 8. 当前执行队列

原型跑通后,shared core 的优先级高于继续扩 UI。当前队列按风险和复用收益排序:

| 顺序 | 模块 | 迁移内容 | 保留在 mobile 的内容 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | `schedule-types` | `RemoteSchedule*`, `RemoteScheduleRun*`, `ScheduleListFilter`, template/write input 类型。 | API 调用、navigation params、RN 表单状态。 | 已完成;shared build/test 和 mobile typecheck 通过。 |
| 2 | `schedule-model` | schedule/run normalize、排序、overview、summary、run-session label/detail、run history meta/action capability、pause confirmation、status label。 | 列表/详情页面、pull refresh、toast。 | 已完成;`packages/maker-shared/src/__tests__/scheduleModel.test.ts` 覆盖。 |
| 3 | `schedule-form` | draft defaults、template params、validation、write input serialization、agent/run-mode/workspace-kind 更新、fresh/persistent/bound 运行会话状态机。 | TextInput、picker、template gallery UI、本地草稿保存。 | 已完成;`packages/maker-shared/src/__tests__/scheduleForm.test.ts` 覆盖。 |
| 4 | `schedule-delete` | generated session 收集、delete preview、disposition patch、project automation 判断、删除文案语义。 | 确认 sheet、远程 delete invoke、列表刷新。 | 已完成;shared patch 类型不再依赖 mobile `RemoteSession`。 |
| 5 | `device-link-contract` | mobile 用到的 maker channel、媒体/语音特判 channel、错误 code 分类、retry policy、allowlist drift fixture。 | WS client、subscribe registry、foreground rehydrate、SecureStore、撤权 store 清理。 | 已完成;shared contract test、mobile transport allowlist drift test、device-link package test 通过。 |
| 6 | `fixtures` | shared remote-control baseline fixture,覆盖 session/message/interaction/queue/schedule/file/media/Orca safe-degrade;raw desktop-like message fixture 和 schedule/file raw payload 已扩展。 | Maestro 场景组装、截图 profile、iOS/Android baseline 文件。 | 已完成第一版;`fixtures.test` 使用同一 fixture 驱动 message render、queue、interaction、schedule、file 和 raw payload models;`sharedFixtureParity.test` 覆盖 mobile raw message normalize/render parity;`makerSharedFixtureParity.test` 覆盖 desktop schedule/file parity。B4 已在 mobile mock host 补 Session 六态 visual scenario,`ios-iphone-17-pro-expo-go` 已接受并校验 12 张截图基线,包括 Settings 和 payload full-screen viewer;local visual suite 会隔离 mock host 并清理 stale e2e 设备记录。截图采集、设备 profile 和 baseline 文件仍留在 mobile。 |

接下来继续移动端 UI/交互重构。重构时禁止把新的排序、摘要、决策序列化写回 `apps/mobile` 组件内部;如果发现需要新语义,先补 shared model 和 fixture。

UI 重构期间的 shared core 增量队列:

| 顺序 | 候选 | 触发条件 | shared 输出 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | session operation/composer touch model | C2 composer、pending、queue、controls 触控重构 | composer slot priority、message history mode、show queue/pending、send/stop/attachment/voice label、disabled reason、busy/read-only reason。 | 已完成第一刀;shared unit + mobile composer/operation adapter tests 通过。 |
| 2 | queue row guard model | C2 queue sheet 继续细化时 | queue row action availability、move target、edit lock、interaction lock、steering、Orca read-only reason。 | 已完成第一刀;shared queue test + mobile input projection adapter test 通过。 |
| 3 | pending resolve guard model | C2 pending wizard 继续细化时 | pending resolve busy/confirm state、requestId 去重、重复提交 disabled reason。 | 已完成第一刀;shared interaction test + mobile interaction adapter test 通过。 |
| 4 | keyboard/native visual check | C2 末尾检查键盘、附件 picker、语音录制、sheet 打开/关闭 | 已完成第一轮稳定化:mobile native shell layout 统一 KeyboardAvoidingView、composer/sheet/palette 高度;透明 Modal 统一 overFullScreen;session 详情同步失败但设备在线时做受控重试;远端不可用的 read-only composer / disabled reason 已进入 shared `sessionOperation.ts`。后续只有发现新的通用 disabled reason / state priority 才继续补 shared。 | iOS native visual flow + visual baseline 已稳定通过;Android 保持 profile/doctor/dry-run 护栏,最终 release 前补 baseline。 |
| 5 | message search/window model | 搜索 sheet、加载更早、new message indicator 或滚动锚点继续调整时 | window range、anchor update、new-message indicator、load-earlier action、search hit、preview 和 index wrap 已完成第一刀。 | shared `messageWindow` / `messageSearch` 单测 + mobile scroll/search adapter 单测已通过。 |
| 6 | capability projection | controls sheet 或 new session model/effort/permission/fast 继续细化时 | 已完成第一刀:model options、effort options、permission options、fast availability、draft reconciliation、incompatibility warning。 | shared `agentCapabilities` 单测 + mobile controls/new session adapter 单测已通过。 |
| 7 | session action strip model | 会话 header / action pill / status chip 继续细化时 | 已完成第一刀:title/subtitle、state chips、action labels、active/attention/disabled reason、协作/Worktree/Dialogue 标识。 | shared `sessionActionStrip` 单测 + mobile typecheck/anchor smoke 已通过。 |
| 8 | scheduler event projection | automations tab 独立化、badge、runs 刷新策略调整时 | 已完成第一刀:event -> list/runs/session-index/unread refresh intent、run patch hint、unread impact。 | shared `scheduleEvents` 单测 + mobile `remoteScheduleEvents` 单测已通过。 |
| 9 | payload summary model | 已完成 summary/body/preview、tool input diff/summary projection、tool_result media extraction 和 attachment projection 第一刀;payload body viewer 已补 mobile-only touch layout,后续只有新增业务语义才继续扩 shared | payload kind、title、subtitle、copyable text、source/open target、body presentation、diff view、tool_use summary / Edit / Write / MultiEdit diff projection、media action notice、tool_result media extraction、attachment -> file/media payload projection、file/media/mermaid/text 构造、preview severity、primary action 和 compact meta。 | `packages/maker-shared/src/__tests__/payloadSummary.test.ts` + mobile `messagePayload.test.ts` / `messageNormalize.test.ts` / `payloadBodyLayout.test.ts`;后续桌面消费前补 desktop parity。 |
| 10 | message presentation model | 已完成 bubble/tool/work/todo presentation 第一刀;message hierarchy/content viewer 已补 mobile-only touch layout,后续只有新增业务语义才继续扩 shared | bubble density/role、desktop-style fold header、todo progress/summary/status、错误识别和 diff 计数;不产出 mobile-only badge/signals。 | `packages/maker-shared/src/__tests__/messagePresentation.test.ts` + mobile `messagePresentation.test.ts` / `messageHierarchyLayout.test.ts` / `messageContentLayout.test.ts`;后续桌面消费前补 desktop parity。 |
| 11 | session visual state fixture | 会话页 polish 需要跨端复用稳定状态输入时 | idle/running/pending/queue/offline/revoked 的状态对象、message/pending/queue/payload 组合 fixture。 | 第一版已落在 mobile mock host + Maestro flow + iOS baseline;如后续需要桌面 parity 或 shared payload/message 视觉模型,再把状态对象提升到 shared fixture。 |

UI 重构期间的执行规则:

- 如果只是换 RN 布局、spacing、sheet route 或 SafeArea,可以只改 `apps/mobile`。
- 如果新增排序、摘要、状态优先级、disabled reason、payload kind、decision serialization、queue projection 或 schedule projection,必须先进入 `packages/maker-shared`。
- 如果同一 fixture 未来需要同时驱动桌面 parity 和手机截图,fixture 放 shared;截图文件名、设备 profile、Maestro flow 和模拟器控制留 mobile。
- 桌面 renderer 接入 shared core 不作为每个手机 UI 任务的前置条件,但新增 shared 模型必须至少有桌面来源说明和后续 parity 入口。

## 9. 迁移后的开发方式

第一轮 shared core 迁移完成后,后续开发不再把 `packages/maker-shared` 当一次性重构任务,而是作为所有跨端语义的默认落点。

### 9.1 新增功能的判断顺序

每个新增或重做的移动端功能都按下面顺序判断:

1. **桌面已有语义**:先找到桌面源码入口,确认排序、状态优先级、payload shape、decision shape 或错误语义。
2. **能否纯模型化**:只要能用 plain object 输入输出表达,就先进入 `packages/maker-shared`。
3. **端上只做承载**:`apps/mobile` 只做 RN navigation、touch layout、sheet/full-screen route、SecureStore、ImagePicker、Audio、DocumentPicker、Linking、AppState 和 device-link lifecycle。
4. **桌面不被迫重写**:桌面端先用 parity test 消费同一 fixture;真正替换桌面 renderer 逻辑可以分阶段做,不在手机版 UI 重构里强行完成。

### 9.2 下一批 shared core 候选

移动端 UI 重构过程中如果遇到下面语义,优先补 shared model:

| 候选 | 来源 | shared 输出 | mobile 承载 |
| --- | --- | --- | --- |
| session operation/composer touch model | `CCAgentSessionView`、`ChatInput`、`InteractionPromptHost`、`PendingQueuePanel` | bottom slot priority、composer availability、send/stop/queue/attachment/voice state、disabled reason、inflight/read-only reason。 | bottom composer、pending bottom surface、queue sheet、keyboard/SafeArea 承载。 |
| session action strip model | `SessionContentHeader`、`TopRightChipStack`、`ChatInput` control state | 已完成第一刀:当前会话可见 action、disabled reason、attention/status chip、协作/Worktree/Dialogue 标识、session spend 摘要。 | 顶部 action pill、bottom sheet 入口、不可用提示。 |
| session list / bulk selection model | desktop sidebar session list、pinned/dialogue/project/date grouping、archived/all/search/batch action、automation group | 已完成第一刀:筛选、搜索、project/date 分组、自动化组行、列表上下文/空状态和批量 patch projection。 | 设备详情 `SectionList`、长按选择、确认卡、远程调用和刷新。 |
| message search/window model | `MessageStream` window、search、prev user jump | 已完成 window range、anchor 策略、new message indicator、load-earlier action、search hit、preview 和 index wrap。 | `FlatList` 滚动、命中高亮、真实分页调用和按钮触控反馈。 |
| capability projection | `ChatInput` model/effort/permission/fast controls | 已完成第一刀:model options、effort options、permission options、fast mode availability、draft reconciliation、incompatibility warning。 | controls sheet 和 new session 表单。 |
| scheduler event projection | `schedulesStore`、`RunHistoryPane` | 已完成第一刀:event -> list/runs/session-index/unread refresh intent、read/all-read impact、run patch hint。 | automations list/detail refresh 和 badge。 |
| payload summary model | `AgentActionRow`、`ToolPayloadLightbox`、`FileBodyView` | 已完成第一刀:payload kind/title/subtitle/copy/open target、body presentation、preview severity、primary action、compact meta、diff formatter、media action notice、file/media/mermaid/text payload 构造。payload body 的屏宽/触控尺寸已作为 mobile shell layout 落在 `payloadBodyLayout.ts`;后续只有新增 payload 语义才回 shared。 | full-screen payload viewer、file preview route、media viewer。 |
| session visual state fixture | `CCAgentSessionView`、`RemoteSessionBanner`、`PendingQueuePanel`、`InteractionPromptHost` | idle/running/pending/queue/offline/revoked 的组合状态和可复用 mock data。 | visual baseline flow、session state screenshot、回归用 mock host scenario。 |

### 9.3 UI 重构验收规则

- 新 UI 不新增业务判断到组件里;组件只消费 shared model 或 mobile adapter model。
- 新 UI 不共享桌面 React 组件,但状态命名和 fixture 必须能和桌面源码对齐。
- 新 UI 每个主要状态至少有一个自动化锚点或截图基线:empty、loading-preserved、ready、running、pending、offline、revoked、error。
- 如果一个移动端交互只因为手机特性存在,例如相机、语音录制、安全存储、App 前后台恢复,可以留在 `apps/mobile`,但要用 typed adapter 把它和 shared/session model 分开。

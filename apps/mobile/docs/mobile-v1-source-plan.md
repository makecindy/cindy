# Cindy Mobile V1 Source-Based Implementation Plan

> 日期: 2026-06-18
> 目标: 按桌面版源码逐项对齐手机版远程控制能力。
> 边界: V1 做完除完整协作 / Orca 编排外的单会话远程控制能力;协作模式 V1 只识别、只读、安全降级。
> 原则: 桌面端是业务真相源,手机端只做控制端和移动交互承载;跨端展示语义沉到 `packages/maker-shared`。
> 范围修订: 桌面 `/issue` / `submit_github_issue` 的 Issue Confirm 是反馈提交链路,不属于 mobile V1 主功能。mobile 只识别 `issue_confirm` 并提示回桌面端处理,不实现 GitHub Issue 表单。
> 最新修订: 当前执行以 [mobile-current-execution-plan.md](./mobile-current-execution-plan.md) 为准。本文保留源码审计、能力矩阵和历史计划背景,不再作为唯一排期入口。
> 当前执行合同: 先把 iOS 的 Home、Session、Composer 做到产品化;Android 只保留兼容护栏。所有主层 UI 必须能指回 Cindy 桌面源码,不能只因为参考图或 mobile 现状而新增桌面没有的信息、图标或动作。

## 0. 当前执行合同

当前目标不是“把远程控制功能入口继续铺满”,而是先把三个主要窗口打磨到能代表 Cindy 手机版第一版质量:

1. **Home = 桌面左侧栏的手机形态**
   对齐 `ProjectNode`、`SessionItem`、`PinnedSection`、`DialogueSection` 的主层信息。设备只做轻量筛选和来源,不是第一层选择页;Relay 正常态、同步成功态、调试说明和额外统计不进入主层。

2. **Session = 桌面会话窗口的手机形态**
   对齐 `MessageStream`、`UserMessage`、`AssistantMessage`、`WorkGroupBlock`、`MessageActionBar`、`SystemCard`。消息阅读是主任务;工作过程、工具、payload、diff、queue、controls 只按桌面层级折叠或进入 sheet/full-screen。

3. **Composer = 桌面 `ChatInput` 的触控形态**
   附件/更多、输入框、语音、发送/停止使用桌面同族图标和 shared action state。语音在发送左侧;可见控制不使用“附件 / 语音 / 发送”这类文字按钮。

4. **视觉尺寸按桌面,触控尺寸按手机**
   消息动作条这类桌面轻量 action 仍保持小图标、小视觉按钮;手机通过 hitSlop / 外层命中区域补触控,不能把可见按钮做大。

5. **shared core 优先**
   排序、分组、摘要、状态优先级、动作 availability、pending / queue / controls / file / schedule projection 进入 `packages/maker-shared`;`apps/mobile` 只做 native shell、触控布局、sheet/full-screen、深链、相机/图片/语音和安全存储。

## 1. 结论

手机版不能做成一个“简化聊天壳”。桌面版的会话过程实际包含设备连接、会话镜像、消息渲染、工具过程、媒体取件、文件引用、队列、权限请求、计划评审、自动化计划、文件页、费用和上下文容量等一整套状态机;Issue 确认属于桌面反馈提交链路,在 mobile V1 中只做降级识别。

V1 的定义应是:

- 必须完整支持普通单会话远程控制。
- 必须保持桌面协议 shape、状态优先级和业务语义一致。
- 必须把桌面 hover、右栏、侧边栏、split pane 等大屏交互改成手机可用的 stack、sheet、full-screen modal、segmented control。
- 必须遇到协作 / Orca 会话时不崩溃、不误操作,但不做完整 lead + worker 编排。

V1 不应做:

- 完整 Orca lead / worker split 或 focus 编排。
- 手机端完整文件编辑器和 dirty conflict 处理。
- 手机端直接触发被控电脑 reveal/open/exec 这类远程执行入口。
- project automation 的高级管理闭环,除非后续专门补移动端设计。

### 1.1 Shared Core 架构修正

计划需要按 shared core 路线更新。`apps/mobile` 继续作为 iOS / Android 原生壳,负责登录、深链、相机、相册、文件、语音、触控和安全存储;不继续堆一套只属于手机端的业务纯函数。

可共享的会话展示语义进入 `packages/maker-shared`:

- session/message render model。
- pending interaction model。
- queue/input projection model。
- session controls/runtime options。
- device-link transport contract。
- file browser model。
- automation/schedule model。

桌面端和手机版不共享 UI 组件,但共享 model 输出和测试 fixture。桌面端把 model 渲染为 sidebar / right rail / hover action / split pane,手机版把同一份 model 渲染为 stack / sheet / full-screen modal / touch action。

详细迁移顺序见 [shared-core-migration-plan.md](./shared-core-migration-plan.md)。当前已完成 `@cindy/maker-shared` 包 scaffold,并已迁入 queue summary / move index / Orca queue item 判断、device list presentation、session controls overview、session list / bulk selection model、agent capability projection、pending interaction serializers / priority / plan outline / issue normalization、message normalize content preview / stable sort / tool pairing model、message render grouping model、message window/search model、system card presentation、file browser / file preview model、automation/schedule model、device-link controller contract、composer palette model、payload summary/body/preview/tool-input-diff/tool-result-media/attachment projection model,以及 shared remote-control fixture baseline。raw desktop-like message fixture、schedule/file raw payload 和 desktop renderer parity 已接入;下一步继续 iOS session detail 产品化 polish 和失败态调优。

### 1.2 Mobile Design Parity Gate

首页这次调整后,手机版 UI 优化不再以“做一个手机首页 / 手机页面”为目标,而是以 **桌面版现有界面为核心母版,首页列表原则作为移动端降噪标准**。所有后续页面都必须先回答三个问题:

1. **桌面对应界面是什么**:列出真实桌面组件、store、model 和关键样式语义。例如首页对应 `CCAgentSidebarUpper`、`PinnedSection`、`ProjectsSection`、`DialogueSection`、`ProjectNode`、`SessionItem`,而不是“设备列表页”。
2. **桌面主层展示什么**:只迁移桌面主层信息。桌面需要 hover、右键、tooltip、右栏、drawer 才出现的信息,手机版不能直接塞进主列表或主消息流,应转成长按菜单、sheet、full-screen viewer 或二级详情。
3. **手机必须删掉什么**:每个页面改造前都列“降噪清单”。如果某个信息在桌面同级主界面不出现,手机主层默认也不出现。

首页成为移动端主窗口的视觉标准:

- **列表不做信息流**:一行一个主体,左侧状态/来源,中间标题,右侧只放桌面同级的时间 / 小 badge / 必要状态。
- **不强迫先选电脑**:首页直接合并展示所有可控电脑的 Projects / Chats / Pinned,设备只作为轻量筛选 chip 和 remote origin 标记。
- **不展示成功态噪音**:Relay 正常、同步成功、调试说明、本地联调提示都不占主层;只在错误、连接中、离线、撤权时显示可操作提示。
- **图标跟桌面同源**:优先复用桌面同一 lucide 图标和自定义 vendor mark path;不能用临时字符、emoji 或近似图标替代。
- **动作必须真实可用**:桌面 hover action 到手机后要么变成长按 / action sheet / 明确按钮,要么暂不显示;不能放没有 handler 的假按钮。
- **手机只因触控调整尺寸**:可以增加命中区域、换成 sheet/full-screen,但不能增加桌面主层没有的信息密度。
- **会话页不是控制台**:主层只保留 header、消息流、消息结束处动作、pending/composer。队列、控制项、payload、diff、媒体、文件、context/cost 都按需进入 sheet 或 full-screen,不能常驻堆卡片。
- **消息正文可直接选择**:完成态 user/assistant 正文必须尽量使用平台可选择文本路径,用户应能在当前可见文字上拖选部分内容。整条复制按钮和弹窗选择只能作为兜底,不能成为唯一选择方式。
- **工作过程只做桌面同级摘要**:`已工作` 收起态不显示错误/工具/思考/消息等额外分类 chip。展开后按桌面顺序看 thinking/tool/todo,但不在手机端增加新的解释性分类。
- **输入区 icon-first**:附件、语音、发送、停止、搜索、目录、更多使用桌面同族图标;语音位于发送左侧;文字只保留 placeholder、必要错误和不可用原因。

页面级改造统一使用这个映射:

| 桌面形态 | 手机承载 | 禁止做法 |
| --- | --- | --- |
| sidebar row | full-screen list row,保留同一展示模型 | 加 subtitle/preview/detail 把一行变多行信息流 |
| hover action / context menu | long press / action sheet / row trailing real action | 永久展示所有 hover 操作 |
| right rail / chip stack | top action strip + bottom sheet | 把所有 chip 变成主层说明文字 |
| split pane | segmented / stacked route / full-screen modal | 小屏硬塞左右两栏 |
| tooltip / title | accessible label / action sheet help | 在主界面写说明文案 |
| modal / lightbox | full-screen viewer | 卡片套卡片或半屏裁切长内容 |

后续每个 UI 批次的验收新增一条:提交前必须有“桌面来源截图或源码片段 + 手机截图 / baseline + 降噪清单”。没有这三项,只能算功能可用,不能算产品化完成。

### 1.3 当前计划修订结论

计划需要更新,而且更新点不只是“再补几个功能”。现在手机和电脑端的 mock / local device-link 链路已经跑通,继续按旧的功能矩阵堆入口会把粗糙 UI 和移动端私有纯函数固化下来。当前计划从 **功能补齐型** 调整为 **shared core 约束下的产品化交付型**。

四份文档的职责固定如下:

| 文档 | 职责 |
| --- | --- |
| `mobile-v1-source-plan.md` | 开发顺序、当前批次、完成条件和自动化门槛的主计划。 |
| `mobile-desktop-source-inventory.md` | 按桌面源码入口维护功能矩阵,用于确认手机版是否漏掉桌面语义。 |
| `shared-core-migration-plan.md` | 维护 shared core 边界、候选模块和跨端 fixture 规则。 |
| `remote-control-plan.md` | 保留已有实现记录、阶段历史和测试命令索引,不再作为唯一排期来源。 |

后续每个移动端任务都按这个顺序执行:

1. **先查桌面源码**:明确对应的 desktop component / store / IPC / model,不能凭手机端现状推断业务语义。
2. **提取桌面展示模型**:记录该界面主层行高、字号、图标、状态优先级、动作出现条件和哪些信息只在 hover / 右栏 / modal 出现。
3. **再判断 shared model**:凡是排序、摘要、状态优先级、payload shape、decision serialization、queue projection、schedule projection,先进入 `packages/maker-shared`。
4. **然后做 mobile shell/UI**:`apps/mobile` 只负责 RN navigation、触控布局、sheet/full-screen route、native 能力、device-link 生命周期和本地短期 UI state;手机主层不得展示比桌面同级主层更多的信息。
5. **最后补自动化**:shared unit、mobile adapter/unit、desktop parity fixture、Maestro/static/native、visual baseline、local relay smoke 逐层覆盖;不能把用户手工点测当主回归。

当前主线因此变成: **C 阶段 iOS 主窗口产品化 polish -> D 阶段桌面 parity 缺口收口 -> E 阶段双平台发布级自动化门禁**。Android 当前只保留兼容性护栏,等 iOS 高标准验收后再采集 baseline。协作 / Orca 完整编排继续留到 V2,V1 只做只读安全降级。

### 1.4 当前目标与重新排期

根据首页和会话页的最新反馈,移动端 V1 的目标从“远程控制能力跑通”升级为 **桌面同源的 iOS 优先产品化版本**。当前验收不再以“功能有入口”为准,而以“像 Cindy 自己的移动控制面”为准。

#### 1.4.1 产品目标

1. **主界面等价桌面左侧栏**
   首页不是设备选择页,也不是远程调试台。它直接显示所有可控电脑上的 Pinned / Projects / Chats / sessions,一行一个主体,信息密度不高于桌面侧边栏。电脑只作为筛选 chip、来源标记和调试上下文。

2. **会话页等价桌面会话主窗口**
   会话页主层只保留 header、消息流、消息结束处 action、pending/composer。工作过程、工具、Todo、payload、diff、文件、队列、设置都按桌面信息层级折叠或放进 sheet/full-screen,不能把桌面 hover/右栏/详情信息常驻到手机主层。

3. **输入区等价桌面 `ChatInput` 的触控版**
   底部 composer 只保留附件/更多、输入框、语音、发送/停止这些核心入口。附件、语音、发送、停止必须图标化,语音在发送左侧;文字只用于 placeholder、错误原因和不可用原因。

4. **消息阅读优先**
   手机会话页首先是阅读和接管远程会话。助手和用户正文要尽量支持在当前可见文本上直接选择和部分复制;消息结束处保留桌面语义的复制、分叉、撤回/rewind 等小图标 action,但不能做成比桌面更重的大按钮。

5. **shared core 是硬约束**
   排序、分组、摘要、状态优先级、pending decision、queue projection、session control、file/schedule model 都先进入 `packages/maker-shared`。`apps/mobile` 只做 native shell、触控布局、sheet/full-screen 承载、深链、相机/图片/语音、安全存储和 device-link 生命周期。

#### 1.4.2 当前优先级

| 优先级 | 目标 | 具体内容 | 不做什么 | 验收方式 |
| --- | --- | --- | --- | --- |
| P0 | 首页收口成桌面侧栏移动版 | Projects / Chats / Pinned 合并列表、桌面同源图标、一行 session row、轻量设备筛选、真实可用 action。 | 不展示 Relay 成功态、调试说明、session subtitle/preview/detail;不强迫先选电脑。 | 与 `CCAgentSidebarUpper` / `SessionItem` / `ProjectNode` 源码逐项比对;iOS 截图和 source anchor 通过。 |
| P0 | 会话页主阅读面收口 | header、消息列表、用户/助手消息、work group、tool、todo、system card、消息结束 action。 | 不常驻显示工具/错误/思考/消息分类 chip;不做 Todo 详情 sheet;不把 action 做成大按钮。 | 真实 Cindy fixture 浏览顺畅;message action/source parity 单测;Maestro anchor;视觉 baseline。 |
| P0 | Composer 改成桌面 `ChatInput` 的 icon-first 触控版 | 附件/更多、输入框、语音、发送/停止按桌面顺序和语义渲染,语音在发送左侧。 | 不使用“附件 / 语音 / 发送”大文字按钮;不新增桌面没有的主层说明。 | `sessionComposer*` 单测锁顺序和图标化;typecheck;Maestro source anchor;截图检查。 |
| P1 | Pending / queue / controls sheet 降噪 | 权限、提问、计划、队列、设置进入 sheet,只显示当前必须处理的信息。 | 不把桌面右栏/hover/tooltip 内容展开到主层;Issue confirm 不做手机表单。 | shared interaction/queue/control tests + iOS 主要路径截图。 |
| P1 | 文件、payload、diff 只读承载 | 消息内 file/diff/media chip 进入 full-screen viewer 或只读文件页。 | V1 不做完整文件编辑器、dirty/conflict/save。 | file/payload shared fixture、viewer smoke、source anchor。 |
| P2 | 自动化基础查看和运行 | schedules 列表、run history、run now、pause/resume、基础创建/编辑。 | 不先做 project automation 高级管理闭环。 | schedule shared tests、mobile flow smoke。 |
| P2 | Android 不埋坑 | 所有布局模型平台无关;保留 Android profile/doctor/dry-run。 | iOS 未验收前不把 Android baseline 作为阻断项。 | Android dry-run/profile 通过,不写 iOS-only 协议和布局假设。 |

#### 1.4.3 每个界面的执行模板

后续每改一个移动端界面,都按同一顺序执行:

1. **找桌面母版**:写明对应 desktop component / store / model / 样式语义。
2. **列主层信息**:桌面主层同级显示什么,手机主层才允许显示什么。
3. **列降噪清单**:桌面 hover、右栏、tooltip、modal、debug、成功态、长 meta 在手机主层全部默认移走。
4. **判断 shared model**:任何可共享的排序、摘要、状态、动作 availability 先沉到 `packages/maker-shared`。
5. **实现 mobile shell**:只做触控尺寸、safe area、sheet/full-screen、native 能力和 device-link 生命周期。
6. **补自动化证据**:shared unit、mobile unit、source anchor、Maestro 静态、web smoke、iOS screenshot/visual baseline 按风险选择。

### 1.5 最新反馈后的目标与执行计划

这轮反馈后的目标需要再收紧一层:手机版不是“把所有远程能力都露出来”,而是把桌面版最核心的左侧会话列表和会话窗口做成手机上可长期使用的控制面。功能存在不等于完成;只有信息层级、图标、动作顺序、折叠策略和文字选择都贴近桌面版,并且手机端没有新增主层噪音,才算这一阶段完成。

#### 1.5.1 新目标

1. **以桌面版为产品母版**
   首页参考桌面左侧会话列表,会话页参考桌面会话窗口,输入区参考桌面 `ChatInput`,消息动作参考桌面 `MessageActionBar`。手机版只因为触控和窄屏改变承载方式,不改变业务层级。

2. **手机端主层只做减法**
   桌面主层没有常驻的信息,手机主层也不常驻。Relay 正常态、同步成功态、调试说明、额外统计、分类 chip、桌面 hover/右栏详情,默认全部删除或下沉到 sheet / full-screen / debug surface。

3. **会话阅读优先于控制面板**
   会话页第一目标是顺畅浏览真实 Cindy 消息,然后才是接管输入、队列和 pending interaction。主层结构固定为 header -> message list -> message action -> pending/composer;其它能力只按需打开。

4. **图标和动作语义必须同源**
   复制、分叉、撤销/rewind、附件、语音、发送、停止、目录、搜索、更多等动作使用桌面同族图标和桌面语义顺序。手机可以扩大不可见 hit area,但可见图标不能变成大按钮。

5. **文本选择是核心能力**
   完成态消息正文必须尽量在当前可见文本上直接拖选、复制部分内容。整条复制按钮只作为快速操作兜底,不能替代局部选择。

#### 1.5.2 近期执行顺序

| 顺序 | 任务 | 实现方式 | 验收 |
| --- | --- | --- | --- |
| 1 | 会话页主层减法 | 对照 `CCAgentSessionView` / `MessageStream` / `MessageActionBar` / `ChatInput` 删除手机主层额外卡片、说明、分类 chip 和成功态状态行。 | 主会话页常驻信息不超过桌面版;真实长会话浏览时第一屏主要是消息内容。 |
| 2 | 消息动作轻量化 | 复制、分叉、撤销/rewind 放回消息结束处;可见图标按桌面轻量 action bar 尺寸,hit area 单独保证触控。 | 图标视觉不显重;动作顺序对齐桌面;用户消息不显示“你/Cindy”身份标签。 |
| 3 | 工作过程折叠态减法 | `已工作` 收起态只保留桌面同级摘要,不显示错误/工具/思考/消息分类 chip;展开后才看工具细节。 | 收起态信息少于或等于桌面;不会因为手机端补了更多统计而抢主消息。 |
| 4 | Composer icon-first | 附件/更多、输入框、语音、发送/停止按桌面 `ChatInput` 语义重排;语音紧挨发送左侧;文字按钮改为图标。 | iPhone SE 宽度不挤压;底部不出现“附件 / 语音 / 发送”大文字按钮。 |
| 5 | 可见文本选择 | 复核 RN `Text selectable`、Markdown WebView 和 streaming/finalized 的渲染路径;完成态优先走能直接选择的正文实现。 | iOS 模拟器和真机至少能对长中文/代码/列表消息局部拖选复制;不通过则继续修,不降级为弹窗唯一方案。 |
| 6 | Queue / controls / search 工具动作图标化 | 关闭、上/下条、队列上移/下移等纯工具动作改成桌面同族图标;删除、保存、危险确认保留必要文字。 | 工具动作不占主层文案;业务/危险动作仍然清楚。 |
| 7 | 首页回归桌面侧栏标准 | 重新对照桌面侧栏源码,把首页中无法回指桌面主层的信息删掉或下沉。 | 首页不是设备选择器,不展示 Relay 成功态和调试信息;设备只做轻量筛选/来源。 |

#### 1.5.3 不再进入当前阶段的内容

- 不做手机版 Issue 表单;`issue_confirm` 只做 desktop-only 兜底。
- 不做完整 Orca 协作编排;V1 只读识别和安全降级。
- 不做完整文件编辑器、dirty conflict、远程 reveal/open/exec。
- 不把 Android baseline 作为当前 iOS polish 的阻断项;但实现不能写死 iOS-only 假设。
- 不新增桌面主层不存在的解释卡、分类标签、成功态状态栏或调试入口。

#### 1.5.4 当前阶段 Definition of Done

当前阶段完成的标准不是“能点通”,而是:

- 首页和会话页各有明确桌面源码母版,并且每个常驻信息都有来源。
- iOS 上真实 Cindy 历史会话可顺畅浏览,长文本可局部选择复制。
- 消息动作、composer、header、search、queue 的图标和动作顺序与桌面语义一致。
- 会话主层没有比桌面更多的状态、分类、统计和调试信息。
- shared unit、mobile unit/source guard、typecheck、web smoke、Maestro 静态检查通过;涉及视觉的批次补 iOS screenshot/baseline。

### 1.6 最新交互反馈后的目标重置

这轮反馈后,计划再做一次收敛:当前阶段只围绕 **Home 主窗口** 和 **Session 对话窗口** 做高质量产品化。其它能力可以有入口或降级,但不能抢主窗口的信息层级。移动端的目标不是“桌面能力全部露出”,而是“桌面核心体验在手机上更轻、更少、更顺”。

#### 1.6.1 不变的最高原则

1. **先看桌面版,再写手机版**
   每个手机界面都必须先找到桌面源码母版。首页看桌面左侧会话列表,会话页看桌面会话窗口,输入区看桌面 `ChatInput`,消息动作看桌面消息末尾 action。不能从当前 mobile 粗糙实现继续推设计。

2. **手机只允许更简单,不允许更复杂**
   如果桌面主层没有显示某个信息,手机主层默认不能显示。手机可以把交互换成长按、sheet、full-screen viewer,但不能把桌面 hover / tooltip / 右栏 / 调试信息常驻出来。

3. **图标和动作语义必须跟桌面一致**
   app 内图标要跟桌面版同源。复制、分叉、撤销/rewind、附件、语音、发送、停止、目录、搜索、更多等动作不能用临时图标、文字按钮或近似符号替代。

4. **可见正文选择是硬要求**
   聊天正文必须尽量在当前可见文本上直接选择部分内容。弹窗、整条复制、长按菜单只能是辅助,不能成为唯一复制路径。

5. **主要窗口优先**
   先把首页和会话页打磨到能长期使用,再做文件、自动化、协作、Android baseline 等外围能力。Android 暂时可以简单,但 shared model 和布局不能写死 iOS-only 假设。

#### 1.6.2 Home 主窗口目标

Home 的母版是桌面左侧栏,不是设备选择页。

必须做到:

- 直接展示所有可控电脑的 Pinned / Projects / Chats / sessions。
- 设备只作为轻量 filter chip / remote origin 标记,不是进入前必须选择的一层。
- 列表行遵守桌面侧边栏的信息量:标题、必要状态、轻量来源/时间;不做多行信息流。
- 成功态噪音全部移走:Relay 已连接、同步成功、本地联调提示、调试说明不占主层。
- row action 只显示桌面同级可见动作;桌面 hover 才出现的动作在手机上走长按或 action sheet。

不做:

- 不在首页展示比桌面侧栏更多的 session 详情、工具统计、同步细节。
- 不把电脑列表做成主入口。
- 不为了“远程控制”概念额外加说明卡、状态卡或调试卡。

#### 1.6.3 Session 对话窗口目标

Session 的母版是桌面会话主窗口,不是控制台。

必须做到:

- 主层顺序固定为:header -> message list -> message-end actions -> pending/composer。
- 用户消息和助手消息不显示“你 / Cindy”身份标签。
- 复制、分叉、撤销/rewind 等动作回到消息结束处,视觉上是小图标 action;可点击热区可以大,但图标本身不能做成大按钮。
- `已工作` 收起态只显示桌面同级摘要,不显示错误/工具/思考/消息这些分类 chip。展开后再按桌面顺序看 thinking/tool/todo。
- 工具、diff、payload、文件、媒体、queue、session controls、search 都按需进入 sheet 或 full-screen viewer,不常驻堆卡片。
- 完成态消息正文优先走平台可选择文本路径,必须验证长中文、代码、列表和 mixed markdown 的局部选择。

不做:

- 不做比桌面更多的分类统计。
- 不把消息 action 做成卡片底部大按钮组。
- 不用弹窗选择文本替代当前可见文本选择。
- 不在主消息流里解释功能、快捷键或调试状态。

#### 1.6.4 Composer 目标

Composer 的母版是桌面 `ChatInput`,手机只是触控版。

必须做到:

- 附件/更多、输入框、语音、发送/停止全部图标化。
- 语音按钮紧挨发送按钮左侧。
- 发送不可用时保留必要 disabled 状态,但不把“发送”写成大文字按钮。
- placeholder 可以有文字;控制按钮尽量无文字,靠图标和 accessibility label 表达。
- `/`、`@`、附件、语音、停止、继续发送的业务语义复用桌面/ shared model,不在 mobile 内另起一套判断。

#### 1.6.5 下一阶段实际排期

| 阶段 | 范围 | 实现方式 | 完成标准 |
| --- | --- | --- | --- |
| A | 桌面源码重新核对 | 逐项读取桌面侧栏、会话窗口、消息 action、work group、`ChatInput` 源码,更新 source inventory。 | 每个手机常驻信息都能指回桌面母版;不能指回的默认删除或下沉。 |
| B | shared 展示模型补齐 | 把 home row、message action availability、work summary、composer action state、selection-friendly message block 沉到 `packages/maker-shared`。 | 桌面/mobile fixture 共享;排序、摘要、状态优先级不在 mobile 私有实现。 |
| C | Session 主窗口 polish | 按 1.6.3 删除噪音、缩小 action、简化 work group、修正文案和图标。 | 真实 Cindy 长会话第一屏主要是消息内容;按钮视觉轻;正文可局部选择。 |
| D | Composer polish | 按 1.6.4 重排为 icon-first;语音在发送左边;禁用文字大按钮。 | 小屏不挤压;source guard 锁住图标和顺序。 |
| E | Home 主窗口 polish | 按 1.6.2 回到桌面左侧栏模型,删除远程/Relay/调试主层噪音。 | 首页像桌面侧栏的移动版,不是设备调试页。 |
| F | 自动化验证 | shared unit + mobile source guard + typecheck + web smoke + Maestro static + iOS screenshot/baseline。 | 用户不用反复手工点测基础回归;手工只看主观质感和真实使用反馈。 |

#### 1.6.6 新的验收问题

每次提交移动端 UI 改动前,都必须回答:

1. 这个元素在桌面哪个组件里出现?
2. 它在桌面是主层可见,还是 hover / 右栏 / modal / tooltip 才出现?
3. 手机是否展示了比桌面更多的信息?
4. 如果手机展示更多,这是触控必要,还是应该删除/下沉?
5. 图标、动作顺序、禁用态是否跟桌面语义一致?
6. iOS 上真实消息是否能阅读顺畅、局部选择复制、不卡住输入?

### 1.7 当前执行版: 桌面主窗口的手机化

当前阶段目标只有一个: **把 iOS 上的 Home 和 Session 做成 Cindy 桌面左侧栏与桌面会话窗口的移动版**。远程链路跑通只是底线;真正完成要满足:主层信息不多于桌面,动作和图标同源,消息阅读舒服,正文能在可见位置局部选择复制。

后续开发不再按“远程控制功能入口”排期,改按“桌面主窗口移动化”排期。每个手机常驻元素都要能指回桌面源码;指不回去的,默认删掉、下沉到 sheet/full-screen,或暂缓。

#### 1.7.1 桌面母版锁定

| 手机区域 | 桌面母版 | 手机只允许保留 |
| --- | --- | --- |
| Home 主列表 | `CCAgentSidebarUpper`、`SessionItem`、`ProjectNode` | Pinned / Projects / Chats / sessions、轻量设备筛选、必要状态和时间。 |
| Session header | `CCAgentSessionView`、`SessionContentHeader` | 返回、标题、必要来源/状态、目录、搜索、更多。 |
| 消息流 | `MessageStream`、`UserMessage`、`AssistantMessage`、`WorkGroupBlock`、`SystemCard` | 用户/助手正文、桌面同级 work 摘要、必要 system/pending。 |
| 消息动作 | `MessageActionBar` | 桌面同源顺序和图标:assistant `[copy][fork][time][cost]`,user `[time][copy][undo][fork]`。 |
| 输入区 | `ChatInput` | 附件/更多、输入框、语音、发送/停止、必要 disabled/placeholder。 |
| 二级能力 | desktop right rail / modal / lightbox / panel | queue、controls、payload、diff、file、schedule 只能按需进 sheet/full-screen。 |

#### 1.7.2 当前红线

- **手机只做减法**:桌面主层没有的信息,手机主层也不常驻。Relay 正常态、同步成功、本地联调、调试说明、extra metrics、hover/tooltip 解释默认不显示。
- **消息区不是控制台**:会话第一屏应该主要是消息正文,不能被状态卡、分类 chip、说明文案、操作面板挤掉。
- **图标必须同源且轻量**:复制、分叉、撤销/rewind、附件、语音、发送、停止、目录、搜索、更多用桌面同族图标。可见 icon 尺寸对齐桌面轻量 action bar,触控热区可以另行扩大。
- **按钮不能更重**:复制/撤销/分叉仍在消息结束处,不是大按钮组;底部附件/语音/发送也不是文字胶囊按钮。
- **`已工作` 收起态不加分类**:不显示错误/工具/思考/消息分类 chip。展开后才按桌面顺序看 thinking/tool/todo。
- **正文选择是硬验收**:整条复制只是快捷操作,不能替代局部选择。完成态 user/assistant 正文必须尽量支持在当前可见文字上拖选长中文、代码、列表和 mixed markdown。
- **shared core 优先**:排序、分组、摘要、动作 availability、composer state、pending/queue/control/file/schedule projection 进入 `packages/maker-shared`;`apps/mobile` 只做 native shell、触控布局、sheet/full-screen 和 device-link 生命周期。

#### 1.7.3 当前冲刺顺序

| 顺序 | 批次 | 具体改动 | 完成标准 |
| --- | --- | --- | --- |
| 0 | Source lock | 重新核对上表桌面母版,为 Home / Session 每个常驻元素补 source anchor 和降噪清单。 | 不能指回桌面的元素不进入主层。 |
| 1 | Session 阅读主层 | 删除主层额外状态、分类、说明、调试;用户/助手消息不显示“你 / Cindy”;`已工作` 收起态只保留桌面同级摘要。 | 真实长会话第一屏主要是消息内容,信息量不超过桌面。 |
| 2 | Message action 轻量化 | 按桌面 `MessageActionBar` 顺序渲染小图标;visible icon 保持轻,hit area 单独放大;禁用态和 remote capability 复用 shared model。 | 不再像大按钮;copy/undo/fork 顺序、图标、禁用态由 source guard 锁住。 |
| 3 | Composer icon-first | 对照 `ChatInput` 重排为附件/更多、输入框、语音、发送/停止;语音紧挨发送左侧;去掉“附件 / 语音 / 发送”大文字按钮。 | iPhone SE 宽度不挤压;只保留 placeholder、错误和不可用原因文案。 |
| 4 | 可见文本选择 | 复核 RN selectable、Markdown WebView、必要时 native text view 的实现边界;完成态优先走可直接选择的正文路径。 | iOS 模拟器/真机能局部选择长中文、代码块、列表和 mixed markdown;失败不算完成。 |
| 5 | Home 侧栏化 | 按桌面左侧栏合并展示所有可控电脑的 Pinned / Projects / Chats / sessions;设备只做筛选和来源;删掉重复菜单和 Relay 主层噪音。 | Home 不再像设备选择器或 Relay 控制台。 |
| 6 | 二级 surface 收口 | Queue、search、controls、payload、diff、file、schedule 进入 sheet/full-screen,只在主层保留必要入口。 | 主窗口不堆卡片,二级能力可用但不抢阅读/列表。 |
| 7 | 自动化门禁 | shared unit、mobile source guard、typecheck、web smoke、Maestro static、iOS screenshot/baseline、真实 device-link smoke。 | 基础回归不再依赖用户手点;用户手测只看真实质感。 |

#### 1.7.4 暂缓和禁止项

- 不做手机版 Issue 表单。`issue_confirm` 只做 unsupported / desktop-only 兜底。
- 不做完整 Orca 协作编排。V1 保留只读识别和安全降级,V2 再做 lead / worker / focus。
- 不做完整文件编辑器、dirty conflict、远程 reveal/open/exec。
- 不新增“远程控制”说明卡、成功态状态栏、调试入口或桌面没有的额外统计。
- Android 暂不阻断 iOS polish,但 shared model、布局和协议不能写死 iOS-only 假设。

#### 1.7.5 每个批次的验收材料

- **桌面源码依据**:列出对应 desktop component / store / model,必要时贴源码行号。
- **降噪清单**:说明删掉或下沉了哪些桌面主层没有的信息。
- **shared model 变化**:展示语义变化优先归入 `packages/maker-shared`;如果只留在 mobile,说明它为什么只是 native shell。
- **自动化结果**:`pnpm --filter mobile typecheck`、相关 mobile/shared 单测、web smoke、Maestro static。
- **iOS 视觉/交互证据**:主窗口批次必须补 iOS screenshot/baseline;文本选择批次必须有模拟器或真机选择验证。

### 1.8 本轮收敛后的目标和计划

本轮目标不是继续扩远程控制入口,而是把 **Home 主窗口、Session 对话窗口、Composer 输入区** 做到能代表 Cindy 手机版第一版质量。后续所有功能都服从这三个窗口的信息层级:桌面主层没有的东西,手机主层默认也没有;手机只因为触控、键盘、安全区和窄屏做承载变化。

#### 1.8.1 北极星

**iOS 优先交付一个桌面同源、信息更少、动作更轻、真实可用的 Cindy 远程会话主体验。**

这句话拆成五条硬要求:

1. **桌面同源**:每个常驻 UI 元素必须能指回桌面左侧栏、会话窗口、消息 action 或 `ChatInput` 源码。
2. **信息更少**:手机主层的信息量不得高于桌面同级主层;Relay 成功态、同步成功态、调试说明、额外统计和分类 chip 默认删除或下沉。
3. **动作更轻**:复制、分叉、撤销/rewind、附件、语音、发送、停止、目录、搜索、更多都用桌面同族图标和轻量 action;可见图标小,触控热区单独保证。
4. **真实可用**:消息能读、能发、能继续、能停止、能处理 pending;正文能在当前可见文本上局部选择复制,整条复制只是兜底。
5. **shared core 约束**:排序、分组、摘要、动作 availability、disabled reason、pending/queue/control/file/schedule projection 先走 `packages/maker-shared`;`apps/mobile` 只做 native shell 和触控承载。

#### 1.8.1.1 设计红线

后续所有手机版界面改动先过这四条,过不了就不实现:

1. **桌面左栏 / 会话窗是母版**:Home 只做 `CCAgentSidebarUpper` + `ProjectNode` + `SessionItem` 的手机排版;Session 只做 `SessionContentHeader` + `MessageStream` + `ChatInput` 的手机排版。
2. **手机只能减法,不能加戏**:桌面主层不常驻的状态、统计、调试、分类和说明,手机主层默认不出现;必须出现时放到 sheet / 更多菜单 / debug only。
3. **图标语义完全跟桌面**:优先用桌面同名 lucide 图标;没有同名时再选同语义 lucide,并在 source guard 里说明映射。禁止用文字按钮替代已有图标语义。
4. **视觉尺寸按桌面,触控尺寸按手机**:例如 `MessageActionBar` 桌面是 14px icon / 24px button,手机可见图标仍应接近 14-16px,但外层 hit area 做到 40-44px;不能把可见按钮做成一排大按钮。

#### 1.8.2 P0 范围

P0 只包含主窗口体验,其它都不能抢主线:

| 模块 | 桌面母版 | P0 要做到 | 明确不做 |
| --- | --- | --- | --- |
| Home | `CCAgentSidebarUpper`、`ProjectNode`、`SessionItem` | 合并展示所有可控电脑的 Pinned / Projects / Chats / sessions;设备只是筛选和来源;列表行一行一个主体。 | 不做设备选择器;不展示 Relay 成功态、同步成功、本地联调、调试说明、session preview/detail。 |
| Session header | `SessionContentHeader`、会话顶部 action | 返回、标题、必要来源/状态、目录、搜索、更多;状态只在异常或需要用户处理时出现。 | 不把 controls、queue、cost、context、debug 常驻在 header 或主层。 |
| Message list | `MessageStream`、`UserMessage`、`AssistantMessage`、`WorkGroupBlock`、`SystemCard` | 用户/助手正文、桌面同级 work 摘要、必要 system/pending;不显示“你 / Cindy”。`WorkGroupBlock` 收起时只显示“已工作 Xs / 工作过程”,展开后再看工具和思考详情。 | 不显示比桌面更多的错误/工具/思考/消息分类 chip;不把工具/思考/消息计数塞进收起态;不把工具详情默认铺在主层。 |
| Message actions | `MessageActionBar` | 消息结束处的小图标 action:copy / fork / rewind 等,顺序和桌面语义一致。可见图标 14-16px,按钮视觉 24-28px,手机 hit area 40-44px。 | 不做大按钮组;不把 action 挪成长按菜单的唯一入口;不把复制/撤销/分叉做成比正文更抢眼的控制条。 |
| Text selection | 桌面消息正文可复制语义 + iOS 文本选择习惯 | 完成态正文尽量支持当前可见文本局部拖选复制,覆盖长中文、代码、列表、mixed markdown。 | 不用弹窗选择或整条复制替代局部选择。 |
| Composer | `components/new-chat/ChatInput.tsx` | 图标化附件/更多、输入框、语音、发送/停止;语音在发送左侧;placeholder 保留文字。 | 不用“附件 / 语音 / 发送”文字胶囊按钮;不新增说明文案;不把模型/权限/fast/context 常驻到输入栏主层。 |

#### 1.8.3 P1 / P2 范围

P1 在 P0 稳定后进入,目标是让主窗口的二级能力可用但不喧宾夺主:

- pending interaction sheet:权限、提问、计划评审;`issue_confirm` 只做 desktop-only 兜底。
- queue sheet:排队消息、停止、移位、删除、steering,但主层只给必要入口。
- search / payload / diff / file viewer:全部走 sheet 或 full-screen viewer,不常驻主消息流。
- session controls:模型、权限、fast、context、spend 等进入二级面板,不压住阅读。

P2 继续后移:

- automations 的创建/编辑闭环。
- 完整文件编辑器、dirty conflict、远程 reveal/open/exec。
- 完整 Orca 协作编排。
- Android 视觉 baseline。Android 先保留 profile、doctor、dry-run 和不写死 iOS-only 假设。

#### 1.8.4 执行顺序

| 顺序 | 批次 | 动作 | 完成标准 |
| --- | --- | --- | --- |
| 1 | Source lock | 重新核对 Home / Session / Composer 对应桌面源码,补 source guard 和降噪 guard。 | 每个常驻元素能指回桌面;指不回的主层删除。 |
| 2 | Session reading | 删除主层噪音,收缩 work group,去掉身份标签,保证真实长会话第一屏主要是消息。 | 手机主层信息不超过桌面;真实 fixture 浏览不被卡片和统计打断。 |
| 3 | Message actions | 小图标 action 放回消息结束处,顺序和桌面一致,hit area 与视觉尺寸分离。 | 图标视觉接近桌面 14-16px;触控热区 40-44px;看起来像桌面 action bar 的触控版,不是一排大按钮。 |
| 4 | Text selection | 完成态正文主路径走 RN 原生 `Text selectable` / Markdown block 渲染,保证阅读稳定;WebView 只保留为后续显式选择模式候选,不能挡在普通浏览路径上。 | iOS 模拟器和真机可在当前可见文字上局部选择长中文、代码、列表和 mixed markdown;整条复制只作为 action bar 兜底。 |
| 5 | Composer | 改成 icon-first 的 `ChatInput` 触控版,语音紧挨发送左侧,发送/停止沿用同一个末端 action 位。 | 小屏不挤压,没有“附件 / 语音 / 发送”文字按钮,没有比桌面更多的常驻控制。 |
| 6 | Home polish | 首页最终回归桌面侧边栏模型,删除设备调试和 Relay 主层痕迹。 | Home 像桌面侧栏移动版,不是远程连接控制台。 |
| 7 | P1 sheets | pending、queue、controls、search、payload、file 进入 sheet/full-screen。 | 二级能力可用,但不抢主窗口阅读和列表。 |
| 8 | Automation gate | 补 shared unit、mobile source guard、typecheck、web smoke、Maestro static、iOS screenshot/baseline、真实 device-link smoke。 | 基础回归自动跑,用户只做主观质感和真实业务验收。 |

#### 1.8.5 每次改动的验收问题

每个移动端 UI 改动提交前必须回答:

1. 这个元素来自桌面哪个组件或 shared model?
2. 它在桌面是主层常驻,还是 hover / tooltip / 右栏 / modal 才出现?
3. 手机是否显示了桌面同级主层没有的信息?
4. 如果显示更多,这是触控必须,还是应该删除或下沉?
5. 图标、动作顺序、disabled state 是否和桌面语义一致?
6. 是否新增了 mobile-only 业务判断?如果有,为什么不能进 shared core?
7. iOS 上真实消息是否能阅读、局部选择复制、输入、发送/停止?

#### 1.8.5.1 当前意见对应的硬性整改清单

- **复制 / 撤销 / 分叉**:回到消息结束处,不做长按菜单主入口;可见 icon 14-16px,不要做大按钮。桌面依据:`MessageActionBar`。
- **已工作收起态**:只保留“已工作 Xs / 工作过程 + chevron”,不显示错误、工具、思考、消息分类 chip。桌面依据:`WorkGroupBlock`。
- **已工作展开态**:展开 work group 后子工具/思考一次性展开到可读状态,不要让用户二次展开。桌面依据:`WorkGroupBlock` 的 `expandBlocks` 交互。
- **底部输入栏**:附件、语音、发送/停止全部图标化;语音在发送左边;placeholder 可以有文字。桌面依据:`components/new-chat/ChatInput.tsx`。
- **身份标签**:消息正文里不显示“你 / Cindy”;信息靠对齐、气泡和上下文表达。桌面依据:`UserMessage` / `AssistantMessage`。
- **文本选择**:目标是在当前消息正文上原地局部选择;当前策略是完成态正文默认走 RN 原生 selectable Text,避免 WebView 空白影响阅读。WebView/弹窗只能作为后续显式选择模式或兜底,不能替代主消息流里的可见文本选择。
- **主层降噪**:Relay、同步成功、本地联调、调试入口、额外统计全部退出主层;异常和需要用户处理的状态才出现。

#### 1.8.6 当前不再做的事

- 不做手机版 Issue 表单。
- 不做“远程控制说明卡”、Relay 正常态卡、同步成功卡、调试入口卡。
- 不做比桌面主层更多的 work/category/stat chip。
- 不做弹窗文本选择作为唯一复制方案。
- 不做 Android 视觉优先级高于 iOS polish 的工作。
- 不为了功能完整度把文件、自动化、协作、controls 全部常驻到主窗口。

## 2. 本次源码审计范围

更细的执行清单见 [mobile-desktop-source-inventory.md](./mobile-desktop-source-inventory.md)。那份文档按桌面源码入口列出消息交互、选项卡、计划、文件页和协作模式的 V1/V1B/V2 实现要求。

这份计划基于当前 worktree 的桌面源码读取和检索,关键入口如下。

| 领域 | 桌面源码入口 | 为什么是手机版依据 |
| --- | --- | --- |
| App shell | `apps/desktop/src/renderer/App.tsx`, `router.tsx`, `CCAgentFeatureLayout.tsx` | 决定登录、全局 listener、toast、确认框、右栏、侧边栏和路由层级。 |
| 远程设备 | `features/device-link/useDeviceLinkRemoteProjects.ts`, `remoteProjectsStore.ts`, `refreshRemoteSessions.ts` | 定义同账号设备、可控性、sessions topic、bootstrap、reseed、撤权和远程 session origin。 |
| 远程隧道 | `apps/desktop/src/renderer/lib/makerTransport.ts`, `apps/desktop/src/main/device-link/dispatch.ts`, `packages/device-link/src/allowlist.ts`, `topics.ts` | 定义手机所有 invoke 和 push 订阅必须走的协议边界。 |
| 会话主页面 | `CCAgentSessionView.tsx`, `SessionContentHeader.tsx`, `RemoteSessionBanner.tsx`, `ErrorBanner.tsx`, `UpgradeBanner.tsx` | 定义会话页真实结构、连接状态、错误、升级、pending interaction 优先级和底部输入区行为。 |
| 消息渲染 | `MessageStream.tsx`, `UserMessage.tsx`, `AssistantMessage.tsx`, `WorkGroupBlock.tsx`, `AgentActionsBlock.tsx`, `AgentActionRow.tsx`, `TodoListCard.tsx`, `SystemCard.tsx` | 定义 raw message 到 render item 的模型,以及用户消息、助手消息、工具、todo、system card 的显示规则。 |
| 媒体和 payload | `ChatImageView.tsx`, `ChatVideoView.tsx`, `ChatAudioCard.tsx`, `ToolPayloadLightbox.tsx`, `ImageLightbox.tsx`, `VideoLightbox.tsx` | 定义图片、视频、音频、diff、长 payload、lightbox/gallery 的桌面语义。 |
| Composer | `ChatInput.tsx`, `PendingQueuePanel.tsx`, `ModelSelector.tsx`, `PermissionSelector.tsx`, `FastModeToggle.tsx`, `ExtraDirsButton.tsx`, `SlashCommandPalette.tsx`, `AtMentionPanel.tsx` | 定义发送、停止、队列、附件、语音、slash、@、模型、权限、fast、extra dirs。 |
| Pending interactions | `PermissionPrompt.tsx`, `AskUserQuestionPrompt.tsx`, `PlanViewerCard.tsx`, `PlanActionCard.tsx`;`IssueConfirmCard.tsx` 仅作为桌面反馈链路参考 | 定义权限、提问、计划评审的决策 shape 和 UI 优先级;Issue 确认在 mobile V1 只做 unsupported 兜底。 |
| 自动化计划 | `SchedulerPage.tsx`, `TaskListPane.tsx`, `RunHistoryPane.tsx`, `ScheduleFormDialog.tsx`, `RunHistoryCard.tsx`, `schedulesStore.ts` | 定义自动化任务列表、运行历史、运行/暂停/恢复/删除、模板、fresh/persistent/bound。 |
| 文件页和选项卡 | `workdir-browse/WorkdirBrowseRoute.tsx`, `FileBodyView.tsx`, `WorkdirBrowseSidebar.tsx`, `FileTreeView.tsx`, `FileTabsBar.tsx`, `SessionTabsBar.tsx` | 定义文件树、文件内容、打开文件 tabs、session tabs、chat rail、search、dirty/edit。 |
| 协作 / Orca | `ExtraDirsButton.tsx`（「+」菜单协同项）, `OrcaWorkflowRoute.tsx`, `OrcaSplitView.tsx`, `CreateWorkerPopover.tsx`, `useWorkers.ts`, `useStopOrcaCollab.ts` | 定义协作不是单开关,而是 lead + worker + focus + split/toggle 的多会话系统。 |

## 3. V1 总体信息架构

### 3.1 手机 Tab 和 Stack

| 手机入口 | 桌面来源 | V1 要求 |
| --- | --- | --- |
| Home | desktop sidebar session list + device-link remote project discovery | 默认首页。按桌面左侧栏逻辑直接展示所有可控电脑的 Pinned / Projects / Chats;电脑只作为筛选 chip 和 remote origin,不作为进入会话前必须选择的一级门。 |
| Computer Detail | desktop sidebar filter/search/bulk affordances + remote device state | 二级/调试页。只承载设备级状态、不可用原因、撤权/离线提示、同步失败和高级调试;不再作为打开会话的必经首页。 |
| Session Detail | `CCAgentSessionView` | 单会话完整控制:消息流、输入、队列、pending interaction、会话设置、媒体、diff、fork/rewind。 |
| New Session | `NewMakerDraftRoute` + `ChatInput` | 远程项目/对话工作区、agent/model/effort/permission/fast、extra dirs、首条消息、附件、语音。 |
| Automations | `SchedulerPage` | 查看和基础管理自动化计划;V1B 补创建/编辑普通 schedule。 |
| Settings | desktop settings remote/device/login | 登录态、手机设备名、relay 状态、调试信息、退出登录。 |

### 3.2 手机会话详情结构

桌面 `CCAgentSessionView` 的真实顺序是:

1. 远程连接 banner: reconnecting / host offline / resync。
2. 远程首屏 loading: 只在远程会话拉历史/元信息时延迟显示。
3. handoff source pill: 从自动化或 handoff 回来时的返回提示。
4. `MessageStream`: 主消息流。
5. bottom overlay:
   - Running status bar。
   - Error banner。
   - Upgrade banner。
   - InteractionPromptHost。
   - TakeoverMask / WorktreeCreatingOverlay / ChatInput 三选一。
   - workingDir / worktree / project context / spend / context ring。
6. TopRightChipStack:
   - 右栏开关。
   - DiffPanelToggle。
   - Prev user jump portal。
7. `SessionDiffPanel`。
8. `CreateWorkerPopover`。

手机版 V1 对应:

- Header: 返回、设备名、session title、运行态、更多。
- Connection strip: reconnecting、offline、revoked、sync failed。
- Message list: 常驻,不因 pending interaction 被卸载。
- Floating/inline status: 只保留 running / error / pending 这类必须立即处理的状态;context、cost、diff count 默认进入详情或 sheet。
- Bottom interaction area:
  - pending interaction 优先。
  - takeover/worktree 阻塞其次。
  - composer 默认。
- Secondary surfaces:
  - 队列 sheet。
  - 会话设置 sheet。
  - diff full-screen。
  - payload full-screen。
  - context/cost detail sheet。

## 4. Device Link 和远程真相源

### 4.1 设备可控性

桌面事实:

- 同账号设备才有资格展示。
- 当前设备自己不应进入可控列表。
- 被控电脑必须在线且开启 `remoteControlEnabled`。
- 被撤销的 controller 会收到 `ACCESS_REVOKED` 或 `link-close('revoked')`。
- 控制端只做内存镜像,不把远程 session 写入本地 SQLite。

手机版实现条件:

- `DeviceLinkContext` 维护设备连接和订阅生命周期。
- `remoteSessionStore` 以 `deviceId` 分片保存 sessions、messages、pending interactions 和 input projection。
- `sessionId -> deviceId` 是远程调用路由依据。
- revoked 必须是终态: 清空该设备 shard,禁止自动重试,展示重新授权说明。

自动化验收:

- 单测覆盖 online/offline/disabled/revoked 分类。
- mock host E2E 覆盖设备上线、下线、关闭远控、撤权。
- reconnect flow 覆盖重新 subscribe `sessions` 和当前 `session:<id>`。

### 4.2 Topic 和订阅

桌面事实:

- `sessions` 是轻 topic,只承载列表读模型。
- `session:<id>` 是重 topic,承载消息、pending interaction、队列、turn cost、Orca worker change。
- `sessions:created` 只带 sessionId,控制端必须 reseed。
- `sessions:patched` 可幂等 apply。

手机版实现条件:

- 设备页和会话列表只订阅 `sessions`。
- 打开会话详情后才订阅 `session:<id>`。
- 离开会话详情要 unsubscribe 或短延迟释放。
- App foreground、WS reconnect、手动刷新都要 reconcile snapshot。
- created push 必须触发设备级 list sessions,不能凭空创建 row。

自动化验收:

- store 单测覆盖 snapshot epoch、防旧 snapshot 覆盖新 snapshot、created reseed、patched merge、archived removal。
- E2E 覆盖会话在桌面端新建后手机端出现。

### 4.3 Invoke allowlist

桌面事实:

- allowlist 阻止控制端调用裸 DB 写、全局设置和未授权文件/执行能力。
- 订阅控制帧 `device-link:subscribe/unsubscribe` 由 dispatch 特判。
- 媒体取件和语音转写也是 device-link 特判 channel,不经普通 ipcMain handler。

手机版实现条件:

- UI 层禁止散落原始 channel 字符串。
- 所有远程调用集中在 `mobileMakerTransport`。
- transport 必须保留错误 code,尤其 `ACCESS_REVOKED`、offline、timeout、not allowed。
- 文件相关只允许只读 list/stat/read-preview 和受控 upload/download。

自动化验收:

- `mobileMakerTransport.test` 锁 channel 和参数。
- allowlist drift test 断言手机用到的 channel 都在协议 allowlist。

## 5. 会话列表和状态

桌面侧边栏事实:

- 会话可按 pinned、dialogue、project、date、scheduled group 组织。
- 支持 archived/all、搜索、多选、rename、pin、archive、delete。
- 自动化生成会话可聚合,有 unread run。
- Orca lead/worker 需要特殊路由和标记。

手机版 V1:

- 每条 session 显示 title、project/dialogue、agent、model、status、last activity、pending attention、pinned、archived、schedule/orca/worktree 标记。
- 筛选: 全部、进行中、等待我处理、已归档、自动化。
- 搜索: title、project path、last message preview、worktree name。
- 操作: 打开、rename、pin/unpin、archive/unarchive、delete、copy id。
- 对 running/attached/pending 的 destructive 操作走二次确认。

自动化验收:

- 1000 session fixture 的列表性能和分组单测。
- `sessionList.test` 覆盖 title、project path、model、schedule、worktree、Orca label 和 last message preview 搜索。
- Maestro 覆盖搜索、筛选、置顶、归档、删除确认、打开 waiting session。

## 6. 新建会话

桌面事实:

- 新会话入口由 `NewMakerDraftRoute` 收敛。
- `ChatInput` 负责首条消息、附件、slash、@、语音、模型、effort、permission、fast、extra dirs。
- 远程 device-link 项目创建必须通过被控端 `maker:create-session`。
- 对话 workspace 的 cwd 由被控桌面端分配,手机不能猜本机路径。
- worktree 创建在桌面本地 FS 上完成,V1 手机不做远程创建入口。

手机版 V1:

- 目标: 选择设备、workspace type、项目目录或 dialogue。
- 项目路径: 最近项目 quick pick + 远程目录浏览 + 手动路径。
- Agent 设置: Claude Code / Codex、model、effort、permission、fast。
- 上下文: extra dirs。
- 输入: 首条 prompt、附件、slash、@、语音。
- 创建成功后先 refresh 设备 sessions,再跳转详情页,避免 sessionId 尚未注册导致 404。

自动化验收:

- 单测覆盖 create args: project/dialogue、extra dirs、agent defaults、capability correction。
- E2E 覆盖手机创建会话、桌面侧出现会话、首条消息入队/发送。

## 7. 消息流

### 7.1 Render model

桌面事实:

`MessageStream.buildRenderItems` 会把 raw messages 转成:

- `message`: user / assistant / system。
- `thinking`: 模型思考。
- `tool_segment`: 连续 tool use/result。
- `tool_media`: 从 tool result 抽出的媒体。
- `todo`: TodoWrite 聚合卡。
- `work_group`: thinking/tool/todo/中间 assistant 的折叠工作过程。

手机版实现条件:

- UI 只消费结构化 render item,不能直接按 raw message 渲染。
- render key 必须稳定,prepend 旧消息和 streaming append 不能导致整列表重排。
- 当前窗口外的历史图片不进入 gallery,加载更早后再纳入。

自动化验收:

- fixture 覆盖 user、assistant、thinking、tool、orphan result、todo、media、system、work group。
- key stability 测试覆盖 prepend 和 tool segment 合并。

### 7.2 滚动和分页

桌面事实:

- 初始渲染最近窗口。
- 顶部扩窗和 DB load more 分离。
- prepend 旧消息要保持 anchor。
- near-bottom 自动跟随,离底显示 new message。
- 支持 focus message、search jump、prev user jump。

手机版 V1:

- `FlatList` 或 `FlashList` 窗口化。
- 最近 80 条首屏。
- 上拉加载更早并保持视觉锚点。
- 离底出现“新消息”chip。
- 搜索命中能滚到消息并高亮。

自动化验收:

- 1000 message 性能测试。
- 单测覆盖 `evaluateMessageWindowUpdate`、near bottom、search index。
- 视觉 smoke 覆盖新消息 chip 和加载更早无空白帧。

### 7.3 User message

桌面事实:

- 支持文本、图片、文件 chip、链接、Orca 通信标记。
- action bar 支持 time、copy、fork、rewind。
- 第一条 user message 不显示 rewind。
- 附件可进入图片/text lightbox 或系统打开。

手机版 V1:

- 右侧气泡。
- 文本、Markdown-lite、链接、图片和文件 chip。
- 消息结束处保留轻量 action bar: copy、fork、rewind、time,顺序和图标语义对齐桌面 `MessageActionBar`。
- 图标视觉尺寸克制,触控热区可比图标大;不要把 action 做成比桌面更重的大按钮。
- 完成态正文必须尽量支持在可见文本上直接选择部分内容;长按菜单或 copy 整条消息只是兜底。
- file chip 打开只读预览或降级卡片。
- 第一条 user message 禁用 rewind。

自动化验收:

- copy/fork/rewind 单测和 smoke。
- 附件 fixture 覆盖图片、本机上传、远程路径。

### 7.4 Assistant message

桌面事实:

- 使用 Markdown renderer。
- streaming 未完成时不显示完整 action bar。
- 完成后支持 copy、fork、time、turn cost。
- Mermaid、table、code、diff、media 都可能出现在消息或工具结果中。

手机版 V1:

- 左侧气泡。
- 支持 paragraph、list、blockquote、inline code、bold、em、strike、link、code fence、table。
- Mermaid 用 WebView 预览并可打开源码/图表详情。
- 完成态正文必须尽量支持在可见文本上直接拖选复制;如果某类复杂 Markdown 暂时需要降级,也要保留 copy 整条消息并继续跟踪直接选择缺口。
- turn cost 放动作行或详情 sheet,避免主消息拥挤。

自动化验收:

- Markdown parser fixture。
- Mermaid WebView smoke。
- turn cost push + historical meta 双路径测试。

### 7.5 Thinking / work group

桌面事实:

- thinking 可 redacted、aborted、streaming duration、final duration。
- 工作过程默认折叠成“已工作 Xs”。
- 正在 streaming 的尾部工作过程可以保持展开,turn 结束再折叠。

手机版 V1:

- Thinking 卡默认折叠。
- Work group 默认折叠,只显示桌面同级的“已工作 + 耗时/必要错误态”摘要;不常驻显示错误/工具/思考/消息分类 chip。
- 展开后保持桌面顺序。

自动化验收:

- fixture 覆盖 redacted、aborted、duration、streaming update。

### 7.6 Tool actions 和 payload

桌面事实:

- `AgentActionsBlock` 聚合连续工具。
- `AgentActionRow` 根据 toolName 生成 verb、path/command 摘要、inline input、result detail。
- Edit/Write/MultiEdit 生成 diff payload。
- 长 payload 进入 `ToolPayloadLightbox`。

手机版 V1:

- 工具组默认折叠。
- 收起态只保留桌面同级摘要;不要显示比桌面更多的信号 chip 或解释文案。
- 展开后每个 tool row 展示工具名、核心参数、状态、错误。
- Bash 显示命令、退出码、stderr/stdout 摘要。
- Read/Write/Edit/MultiEdit 显示路径和 diff 摘要。
- MCP tool 显示格式化后的 tool 名。
- payload 用 full-screen modal 展示,支持复制。

自动化验收:

- fixture 覆盖 Bash、Read、Write、Edit、MultiEdit、Grep、Glob、TodoWrite、MCP、error。
- diff parser 单测覆盖多段 edit。

### 7.7 媒体

桌面事实:

- tool result 支持 `xdt_image_url`、`xdt_image_urls`、`xdt_video_url`、`xdt_video_urls`、`xdt_audio_url`、`xdt_audio_urls`、`_xdt_audio_tracks`、`_xdt_model_files`、`_xdt_render_image`、`_xdt_actions`。
- 桌面通过 Electron protocol 和本地缓存读取媒体。
- 图片有 lightbox/gallery,视频和音频有专门组件。

手机版 V1:

- 远程本地媒体必须通过 `device-link:media:fetch` 上传到 OSS 中转区,手机拿 presigned URL。
- 图片详情支持缩放、gallery 上一张/下一张、缓存释放。
- 视频/音频用 WebView 播放器,关闭/切换/后台要暂停。
- 3D/model 文件 V1 显示文件卡和 metadata,V2 再做预览。
- `_xdt_actions` V1 至少展示为不可用或安全按钮,V1B 再接 UI trigger。

自动化验收:

- 单测覆盖 media extraction、presign、release、播放器 command。
- Maestro 覆盖图片、视频、音频 mock fixture。
- 后续增加真实 OSS 视频/音频 fixture。

### 7.8 Todo

桌面事实:

- `TodoListCard` 显示 completed/total、active todo、三态 progress。
- completed / in_progress / pending 有不同视觉权重。

手机版 V1:

- 卡片对齐桌面 `TodoListCard`:header 显示 completed/total 和当前 active todo,默认内联展示列表。
- 状态用桌面同族图标表达 completed / in_progress / pending,不额外显示状态文字标签。
- 不做单独 Todo sheet 或“查看全部任务”按钮;如果列表过长,按消息流自然滚动和折叠策略处理。
- streaming update 保持稳定。

自动化验收:

- TodoWrite fixture 覆盖三态和增量更新。

### 7.9 System cards

桌面事实:

- `/help`、`/cost`、`/context`、`/pwd`、`/status`、compact boundary、cmd card 都走 `SystemCard`。
- `/context` 包含 categories、MCP tools、memory files、agents、skills、slash commands、message breakdown、API usage。

手机版 V1:

- system card 低视觉权重。
- `/context` 必须保留核心结构,用折叠 section 展示。
- `/cost`、`/pwd`、`/status` 走轻量卡片。
- compact/cmd 如果协议侧没有完整数据,必须可识别并降级。

自动化验收:

- system card formatter 单测覆盖全部 card type。

## 8. Composer 和队列

### 8.1 Composer

桌面事实:

- `ChatInput` 包含 TipTap、附件、图片、drag/drop、slash、@、model、effort、permission、fast、extra dirs、voice、send、stop、collaboration toggle。
- send button 在 streaming 且无内容时变 stop;有内容时可以 queue。
- 语音有 click 和 long press,支持 release-to-send。

手机版 V1:

- 文本输入 + 键盘安全区。
- 底部常驻入口 icon-first:附件/更多、输入框、语音、发送/停止。语音放在发送左侧,附件、语音、发送、停止不使用大号文字按钮。
- 附件面板展开后再显示:
  - 被控电脑路径。
  - 手机文件。
  - 相册多选。
  - 拍照。
- slash palette。
- @ resource picker。
- session settings sheet: model、effort、permission、fast、extra dirs。
- 语音录音 -> OSS -> 被控桌面 ASR -> draft,不自动发送。
- send / stop 主按钮和忙态。

自动化验收:

- 单测覆盖附件序列化、图片 metadata、语音状态、slash/@ 插入。
- E2E 覆盖发送、stop、附件、语音转写回填 draft。

### 8.2 Queue

桌面事实:

- queue 是 FIFO。
- 4 条以内全显,5 条以上折叠。
- running 时新输入进入 queue。
- 支持 remove、edit、steer、move、resume。
- 编辑有 edit lock;拖拽/移动有 interaction lock。

手机版 V1:

- composer 上方显示 queue chip。
- queue sheet 支持查看、编辑、删除、上移/下移、暂停/继续、插话、retry/clear error。
- 移动排序遵守桌面 insertion index 语义。
- 任何本地乐观更新必须以被控端 projection 回流为准。

自动化验收:

- queue reducer 单测覆盖边界 index。
- Maestro 覆盖 enqueue、stop、resume、edit、move、remove、steer。

## 9. Pending Interactions

桌面 `CCAgentSessionView` 的优先级是:

1. Plan Review。
2. Permission。
3. Ask User。
4. Issue Confirm。
5. TakeoverMask。
6. WorktreeCreatingOverlay。
7. ChatInput。

手机版必须保持这个优先级。

### 9.1 Permission

桌面事实:

- decision shape 包含 `behavior`、`updatedPermissions`、`decisionClassification`。
- Allow once、Always allow for session、Deny。
- Always allow 只接收 session scoped suggestions。
- 必须展示 title、description、tool input。

手机版 V1:

- 展示工具名、风险描述、关键参数。
- 主按钮允许,次按钮拒绝,更多里放本会话允许。
- 高风险命令必须二次确认。

测试:

- serialization 单测。
- E2E 覆盖 allow、deny、always。

### 9.2 Ask User

桌面事实:

- 多步 wizard。
- single-select 点击即前进。
- multi-select 最终答案是 JSON array string。
- skip 是空字符串。
- draft 按 requestId 恢复,陈旧 draft 忽略。

手机版 V1:

- 全屏或底部 wizard。
- 支持单选、多选、自定义文本、跳过、返回。
- 草稿按 `sessionId + requestId` 保存。

测试:

- 答案编码和 draft 恢复单测。
- E2E 覆盖多问题、多选、自定义。

### 9.3 Plan Review

桌面事实:

- `PlanViewerCard` 有 expanded / half / minimized / edit 四态。
- outline 从 h1-h3 生成。
- 编辑后通过 `onPlanContentChange` 写回。
- `PlanActionCard` 支持 approve 或带 feedback revise。

手机版 V1:

- 半屏/全屏计划页。
- Markdown 预览、h1-h3 目录、编辑。
- Approve 回传 edited plan。
- Feedback 必须有文本。

测试:

- outline parser、edit/approve/feedback 单测。
- E2E 覆盖编辑后 approve。

### 9.4 Issue Confirm

桌面事实:

- 用户可编辑 title、body、type。
- 确认结果附 `uiLanguage`。
- 取消返回 `{ confirmed: false }`。
- 环境信息只读,最终由 main 附进 issue body。

手机版 V1:

- 不实现 GitHub Issue 表单。
- 只识别 `issue_confirm` pending interaction,显示 desktop-only 安全兜底,提示回电脑端处理。
- 取消或忽略必须保持协议安全,不能在手机端伪造提交。

测试:

- unsupported fallback 单测。
- E2E 覆盖遇到 issue confirm 不崩溃、不展示表单、不误提交。

## 10. Session Controls

桌面事实:

- Header/Sidebar/ChatInput 分散管理 rename、pin、archive、delete、model、effort、permission、fast、extra dirs、deep link、SDK id、context、cost。
- 远程会话设置不能本地乐观作为最终态,被控端 patch 回流才是真相。
- `maker:get-capabilities` 决定 model、effort、permission、fast 是否可用。

手机版 V1:

- 一个 session settings sheet 承载:
  - title rename。
  - pin/unpin。
  - archive/unarchive。
  - delete。
  - model、effort、permission、fast。
  - extra dirs。
  - copy session id、SDK id、deep link。
  - context usage。
  - spend/cost。
  - worktree/path 只读信息。
- destructive 操作二次确认。
- 设置提交后等待 session patch 或主动 refresh。

测试:

- settings model 单测覆盖 capability correction。
- E2E 覆盖修改 model/effort/permission/fast 后 UI 回流。

## 11. Fork / Rewind

桌面事实:

- `MessageActionBar` 和 `useForkAtMessage` 提供 fork。
- rewind 有 preview dialog,首条 user 不显示。
- commit 后用被控端消息快照替换当前会话并回填 composer draft。

手机版 V1:

- 用户消息和助手消息动作里提供 fork。
- 非首条 user 提供 rewind。
- rewind 先 full-screen preview,列出删除/保留范围和风险。
- commit 后刷新 messages + pending interactions + input projection。

测试:

- preview state 单测。
- E2E 覆盖 fork 跳转和 rewind commit。

## 12. 自动化 / Scheduler

### 12.1 桌面事实

`SchedulerPage` 的关键语义:

- master-detail 布局。
- task list 宽 300,run history flex。
- 切换 task 时 `RunHistoryPane` 不 remount,旧 runs 保留到新 runs 到达,避免空白帧。
- 不轮询,通过 schedule event `changed` 刷新。
- 排序: active 和 expired 同 rank,paused 下沉;组内按 lastFiredAt desc,再 updatedAt。
- filter: active 桶包含 active + expired,paused 是 paused,all 是全部。
- URL 支持 `?workingDir=<dir>` 和 `?focus=<id>`。
- run now 对 expired/once 也允许 force-fire,不改变 schedule 状态。
- pause 如果有 inflight 要合并确认。
- run card 可以 mark read、open session、restart interrupted/aborted、delete non-running run。

### 12.2 Schedule form 桌面事实

`ScheduleFormDialog` 包含:

- create/edit/project automation mode。
- blank/template segmented。
- TemplateGallery 和 TemplateParamForm。
- name、cron/manual/once。
- run mode: fresh / persistent / bound。
- bound session picker。
- prompt。
- Feishu notify。
- worktree。
- agent tabs。
- fast mode。
- model / effort。
- project chip。

### 12.3 手机版 V1

V1A:

- 自动化入口可以只显示“计划能力准备中”或隐藏。

V1B:

- task list: name、status、cron/manual、next/last fire、agent、destination、unread count。
- detail: prompt、run history、status、next/last fire、session mode、model/effort/fast。
- actions: run now、pause/resume、delete、open generated session、mark read。
- create/edit 普通 schedule:
  - name。
  - prompt。
  - schedule/manual/once。
  - fresh/persistent/bound。
  - agent/model/effort/fast。
  - worktree。
  - template。

V1 暂缓:

- project automation promote/clone/reload/open config 的完整管理。
- Feishu notify 编辑。
- 复杂 URL focus 行为。

测试:

- 当前已有 `scheduleModel.test` 覆盖 sort/filter/summary/run folding。
- 当前已有 `scheduleFormModel.test` 覆盖 create/update/template input serialization。
- 当前已有 `scheduleDelete.test` 覆盖生成会话 keep/archive/delete 删除策略。
- 当前已有 `automations.yaml` 覆盖 run now、pause/resume、open session。
- 当前已有 `automations_create_edit.yaml` 覆盖 template gallery、create/edit、delete dialog。

## 13. 文件页和选项卡

### 13.1 桌面事实

`WorkdirBrowseRoute` 不是单独文件浏览器:

- 路由 `/cc-agent/files/:sessionId`。
- 中间是文件内容。
- 右侧是 chat rail。
- sidebar 替换成 file tree/search。
- URL `?file=<relPath>` 是选中文件。
- selected file、expanded folders、open tabs、scroll positions 都持久化。
- session tabs 是同 workdir/project 的活跃普通会话。
- file tabs 支持关闭、重排、dirty 拦截。
- remote session 当前会 redirect 回普通会话页。
- Orca lead 会 fallback/redirect 到 lead 语义。

`FileBodyView` 支持:

- markdown live preview/edit。
- code/plain text edit。
- image preview。
- PDF preview。
- drawio preview。
- binary unsupported placeholder。
- in-file search。
- project-search jump `?search&line`。
- save、autosave、dirty chip、external change handling。

### 13.2 手机版 V1

V1 不做完整 doc mode,但必须做“会话相关文件只读预览”:

- 从 message file chip 打开。
- 从 tool result Read/Edit/Write/MultiEdit path 打开。
- 文本/Markdown/code 只读预览。
- 图片预览。
- PDF/drawio 显示降级卡片或系统打开提示。
- 文件路径复制。
- 超大文件显示 oversize reason。
- not found/forbidden 显示明确状态。

V2 再做:

- 完整 file tree。
- project search。
- file tabs。
- session tabs。
- 编辑保存。
- dirty conflict。
- chat rail 与文件预览同屏。

测试:

- file preview 单测覆盖 text、oversize、not_found、forbidden。
- file preview 单测覆盖 PDF / drawio / office / binary / unknown 降级文案,确保非文本文件不会暴露远程文本读取入口。
- `file_preview.yaml` 覆盖点 file chip -> 文本预览 -> 复制路径 -> 关闭,并覆盖 PDF / drawio 降级卡片。
- `file_preview.yaml` 同时覆盖展开工具组 -> 点 diff -> 读取当前文件预览。

## 14. 协作 / Orca

### 14.1 桌面事实

协作模式由多个模块组成:

- `ExtraDirsButton` 的协同模式项:输入器「+」菜单中的入口和关闭入口。
- `CreateWorkerPopover`: 创建 worker,角色、agent、model、effort、fast、initial task。
- `OrcaWorkflowRoute`: `/cc-agent/orca/:sessionId` 路由薄壳。
- `OrcaSplitView`: lead + worker split/toggle。
- `useWorkers`: 读 worker 列表、focused worker、active count、soft/hard limits。
- `useStopOrcaCollab`: 二次确认后 disableOrca。
- `orcaWorkflowsFor`: 本地/远程分流 worker list/create/focus/archive。

关键语义:

- lead 和 worker 是多个真实 session。
- generic navigation 需要 `resolveSessionRoute`,lead/worker 都进入 Orca route。
- worker selection 优先级: search jump worker -> focusedWorker -> URL worker -> first worker。
- split layout 支持左右 pane、比例、maximize。
- toggle layout 支持 Lead/Worker tabs。
- worker attention 要在 worker pane 可见时 clear。

### 14.2 手机版 V1 安全降级

V1 只做:

- 会话列表展示 lead/worker 标记。
- 打开 lead 时可看 lead 消息流。
- 打开 worker 时可看 worker 单会话消息流。
- 顶部显示“协作模式手机版暂不支持完整编排”。
- 会话页进入只读安全降级:禁用发送、pending interaction 决策、queue 编辑、fork/rewind 和会话写操作。
- 禁用 create worker、switch focus、archive worker、stop collaboration。
- 禁用在 worker 会话里再次开启 collaboration。

V2 再做:

- Lead/Worker segmented。
- Worker list bottom sheet。
- Focus worker。
- Create worker full-screen form。
- Archive worker。
- Stop collaboration。
- Attention badges。

当前状态:

- 已有 `collaboration.test` 覆盖 lead/worker/未知角色标识、降级文案和只读 reason。
- 已有 `sessionList.test` 覆盖 lead/worker 在列表 subtitle/search 中可识别。
- 已有 `inputProjection.test` 覆盖 `origin.kind === 'orca'` 队列项识别。
- 会话页已接 `session.collaborationReadOnlyComposer`、`interaction.readOnlyCard`、`queue.readOnlyNotice`、`session.controlsReadOnlyNotice` 源码锚点。
- V2 单独建立 Orca E2E。

## 15. 测试和调优体系

用户不应承担主测试。V1 必须有自动化链路。

### 15.1 单元测试

必测:

- shared core build/test。
- device eligibility。
- topic subscribe/replay。
- revoked/offline/reconnect reducer。
- remote session shard merge。
- message normalize/render model。
- markdown parser。
- media extraction/presign/release。
- queue projection和 move index。
- interaction serialization。
- schedule sort/filter/form serialization。
- file preview result model。
- collaboration safe-degrade model。

shared core 迁移后的单元测试不只跑 mobile。每次迁移必须同时跑:

```bash
pnpm --filter @cindy/maker-shared build
pnpm --filter @cindy/maker-shared test
pnpm --filter mobile typecheck
pnpm --filter mobile test -- <对应 mobile adapter 测试>
```

当桌面端开始消费 shared model 后,再补桌面 adapter 测试和 cross-app fixture parity。

### 15.2 本地集成 smoke

拓扑:

- local server。
- mock desktop host。
- Expo / iOS simulator / Android emulator。
- mock login。
- Maestro flow。

必测场景:

- 登录。
- 发现电脑。
- 同步 sessions。
- 打开会话。
- 发送消息。
- streaming assistant。
- queue。
- stop/resume。
- permission。
- ask user。
- plan review。
- issue confirm。
- media image/video/audio。
- fork/rewind。
- automations run now。
- device offline。
- revoked。
- reconnect rehydrate。

### 15.3 视觉回归

截图矩阵:

- Devices: empty、available、offline、disabled、revoked。
- Sessions: all、running、waiting、archived、search。
- Session: idle、streaming、pending、queue、error、offline。
- Message: user、assistant、tool collapsed/expanded、todo、work group、system。
- Payload: media、diff、tool result、file preview、Mermaid。
- Interactions: permission、ask、plan、issue。
- Automations: list、detail、form。

检查点:

- iPhone SE 宽度不重叠。
- iPhone 17 Pro 动态岛不遮挡。
- Android gesture nav 不遮挡 composer。
- 键盘弹出后最后消息可见。
- 打开/关闭 sheet 不产生空白帧。

### 15.4 性能指标

V1 验收线:

- 1000 条消息可滚动。
- 进入会话首屏小于 1s,不含网络慢请求。
- streaming event 到 UI 小于 200ms。
- send 点击到被控端 ACK 小于 2s。
- reconnect 后 5s 内恢复 sessions snapshot。
- 图片/视频/音频取件不阻塞消息列表。
- payload modal 关闭时释放远程中转对象。

### 15.5 调优原则

- 所有远程状态先进 normalized store,UI 不直接拼临时状态。
- streaming 文本节流渲染。
- 列表页只订阅轻 topic。
- 详情页才订阅重 topic。
- 大 payload、媒体、文件按需加载。
- resolve 类操作防重复提交。
- offline/revoked 统一进入只读态。
- app 后台保存 draft、scroll anchor,并暂停媒体。

## 16. V1 执行顺序

| 阶段 | 内容 | 完成条件 |
| --- | --- | --- |
| 0 | Shared core foundation | `packages/maker-shared` 建立;queue/input projection、device list presentation、session controls overview、session list / bulk selection model、pending interaction model、message render grouping model、file browser/preview model、automation/schedule model、device-link controller contract、shared fixture baseline、raw desktop-like message parity、schedule/file raw payload parity 已迁移;后续新增共享语义先进入 shared core,再由 mobile/desktop adapter 消费。 |
| 1 | Device/session transport | 设备发现、sessions 镜像、reconnect/revoked、typed transport 全测过。 |
| 2 | Session list | 搜索、筛选、pending attention、rename/pin/archive/delete 完成。 |
| 3 | Session detail read-only | message render、分页、滚动、search、tool/todo/work/system 完成。 |
| 4 | Composer/queue | send、stop、queue、edit/move/remove/steer、draft 完成。 |
| 5 | Pending interactions | permission、ask、plan、issue 全部自动化覆盖。 |
| 6 | Session controls | model/effort/permission/fast/extraDirs/context/cost/deep link 完成。 |
| 7 | Media/diff/payload | 图片/视频/音频/diff/tool payload/Mermaid 完成。 |
| 8 | Fork/rewind | fork、preview、commit、回填 draft 完成。 |
| 9 | New session | project/dialogue、remote dir、agent settings、首条消息、附件/语音完成。 |
| 10 | Automations V1B | list/detail/run/pause/resume/delete/create/edit 普通 schedule 已完成基础闭环;fresh/persistent/bound 运行会话编辑第一刀已对齐桌面语义;project automation 完整编辑仍按 V2 级别继续对齐。 |
| 11 | File preview V1B | message file chip、diff 当前文件按需读取、独立 `/files/[sessionId]` 只读远程文件页、目录浏览、手动文件路径预览、路径复制、oversize/not_found/forbidden/read_failed 文案、PDF/drawio 降级卡片和 `file_preview.yaml` / `file_browser.yaml` 自动化锚点已完成;真实 native Maestro 点击运行待 CLI 可用后补。 |
| 12 | Collaboration safe degrade | lead/worker 识别、会话只读、pending interaction 只读、queue 只读、session controls 写操作禁用已完成;真实 Orca fixture 点击流待 Maestro 可用后补。 |
| 13 | E2E/visual/perf | web smoke、Maestro 静态锚点、本地 relay preflight、native doctor、local full preflight、1000 message 和 1000 session 性能门禁已跑通;`ios-iphone-17-pro-expo-go` 当前已接受 12 张视觉基线并可严格 hash 校验,包括 `visual-settings` 和 `visual-session-payload`;Android 设备 profile 后补。 |

Shared core 迁移并不是额外阶段,而是 1-13 每个阶段的实现约束:凡是能用纯模型表达的协议、排序、折叠、展示摘要、决策序列化和 fixture,都先沉到 `packages/maker-shared`;`apps/mobile` 只保留 native shell、UI layout 和 device-link 生命周期。

### 16.1 当前开发计划修订

基础链路已经跑通后,阶段顺序需要从“补功能矩阵”切到“收口质量”。下一步不应该继续在 `apps/mobile` 里叠更多本地纯函数或临时 UI,而是按下面的顺序推进:

本轮判断:计划需要继续更新。当前代码已经证明手机和电脑端可以通过 mock / local device-link 连起来,继续按“能用就补一个入口”的方式开发会把粗糙 UI 固化下来。新的执行顺序是 **视觉基线先行 -> 会话页产品化 polish -> 桌面 parity 缺口 -> 发布级自动化**。其中 shared core 不再是一个已结束的重构阶段,而是每个 UI/功能任务的入口条件。

当前计划版本: `2026-06-18-AV`。版本含义是:V1 能力骨架和本地联调链路已成立,C1 的消息 / payload shared presentation 第一刀已完成,C2 已继续把 composer、pending interaction、queue、controls、session action strip、scheduler event、message normalize content preview / stable sort / tool pairing、payload preview/severity、tool input diff/summary projection、tool_result media extraction、attachment payload projection 和 message load-earlier action 的触控语义沉到 shared model;队列行的五动作触控节奏已补 `queueTouchLayout.ts`,队列 resume/retry/clear/edit/save/move/steer/remove/toggle 动作已收敛到局部 `QueueTouchButton`,controls sheet 的 overview / tabs / input rows / action buttons 已补 `sessionControlsTouchLayout.ts`,pending interaction 的 permission / ask / plan / issue 动作行、队列 chip 和 plan 预览尺寸已补 `interactionTouchLayout.ts`,pending wizard 内的 Ask 选项、Plan tab/目录/反馈、Issue 类型和 resolve 按钮已收敛到局部 `InteractionTouchButton`,并已补齐 busy 期间不可重复触发的统一触控状态;fork/rewind 的 rewind preview 已补 `rewindPreviewLayout.ts` 和局部 `RewindActionButton`,payload 全屏 viewer header 的复制/打开/图库翻页/关闭动作已收敛到局部 `PayloadHeaderActionButton`,payload 全屏 viewer body 的 diff/file/media/mermaid/body 尺寸已补 `payloadBodyLayout.ts`,payload body 内部的远程媒体/文件预览/路径复制动作已收敛到局部 `PayloadActionButton`,并已补齐 disabled accessibility state,work/tool/todo 折叠层级和 sheet 节奏已补 `messageHierarchyLayout.ts`,markdown/附件/媒体/diff preview/tool result preview 的内容尺寸已补 `messageContentLayout.ts`,消息内容里的媒体、文件、diff、tool result 和 Mermaid source 打开详情动作已收敛到局部 `MessageContentOpenButton`,并已补齐 disabled accessibility state,消息列表辅助入口的加载更早/新消息、Todo 详情、payload 图片缩放和 Work/Tool/Todo/Thinking 折叠头动作已收敛到局部 action primitive;当前按“重要主窗口优先”补 `mainWindowLayout.ts`,把设备列表、设备详情、新建会话、文件浏览、自动化窗口的 summary、toolbar、content、empty 和 block spacing 统一到 screen width + density 输出,并把这些主窗口的 metric / empty / action 表达收进 `MobilePrimitives.tsx` 的 `MainWindowMetric` / `MainWindowEmptyState` / `MainWindowActionGroup` / `MainWindowActionButton`;第十二刀已新增 `MainWindowOptionButton` / `MainWindowRowButton`,设备详情筛选/分组/session row/自动化子 row 和新建会话最近项目/运行选项/远程目录行已接入统一触控/a11y owner;第十三刀继续把文件页面包屑/文件行和自动化 segment/schedule row 接入同一套 option/row primitive;第十四刀新增 `MainWindowCardButton`,并把设备列表行、自动化删除选项、模板刷新、模板卡片和模板 boolean toggle 也收口到主窗口 primitive;第十五刀让 `MainWindowActionButton` 支持 busy state,并把全局 `ConnectionBanner` 重新同步入口接入同一 action primitive;第十六刀把登录页可见动作入口接入同一 `MainWindowActionButton`;第十七刀把 `ScreenHeader` 右侧 action 从旧 `PillButton` 收敛到 `MainWindowActionButton`;第二十一刀把自动化表单的 fresh/persistent/bound 运行会话状态机沉到 shared schedule form model,移动端表单只消费共享模型渲染三态切换和绑定会话选择;第二十二刀把自动化列表/详情的运行会话标签和详情也沉到 shared schedule summary,第二十三刀把自动化运行历史的耗时 meta 和会话短标识沉到 shared run summary,第二十四刀继续把单条 run 的打开会话、标已读、无会话异常重跑和删除确认动作接到 shared action capability + mobile 行内 action 区,会话详情 route action 第三刀补齐 `ActionPill` active/disabled accessibility state、queue/search sheet 关闭入口和 busy 防重复触发;queue/controls 状态 polish 继续给 `QueueTouchButton` 补 busy accessibility state、给 `ControlActionButton` 补 selected/disabled accessibility state,C2.9 第四刀已把 controls sheet 的 inline 入口、section tabs、远程目录进入行和连接 banner 的重新同步入口补齐局部 action primitive / accessibility state。当前重点是 iOS 先收口高标准视觉和失败态,Android 可以后置到 iOS 验收后,但所有新增布局/协议/脚本都必须保持平台无关,不能写死 iOS-only 假设。

本轮补充:会话详情 route 层新增 `RouteActionButton` / `SheetBackdropButton`,把 composer 附件/语音/停止/发送、搜索上一条/下一条/加载更早、未同步重新同步、历史消息展开和 settings/queue/search backdrop 收敛到同一触控/a11y owner。这属于 mobile shell 承载层,不改变 shared composer/search/window/session operation 语义。

本轮补充 2:`MobilePrimitives.tsx` 新增 `MainWindowOptionButton` / `MainWindowRowButton`,并补齐 `MainWindowActionButton` 的 active/disabled accessibility state。设备详情和新建会话的高频筛选、分组、列表行、最近项目、运行选项和远程目录行已消费同一套 mobile shell primitive,业务语义仍留在 shared model / typed adapter。

本轮补充 3:文件页的路径面包屑和文件/目录行、自动化页的分段筛选和计划行继续接入 `MainWindowOptionButton` / `MainWindowRowButton`。这只是把一级主窗口的触控、选中态、展开态和 accessibility state 收口到同一 mobile shell owner,不改变 file browser model、schedule model、远程读取或 schedule 写入协议。

本轮补充 4:`MobilePrimitives.tsx` 新增 `MainWindowCardButton`,并让 option/row primitive 接受明确的 accessibility role/state。设备列表行、自动化删除单选、模板刷新、模板卡片和 boolean toggle 已接入统一 primitive;这只统一 pressed/selected/checked/disabled 表达,不改变设备可见性、schedule delete disposition、template 参数或 schedule write 序列化。

本轮补充 5:`MainWindowActionButton` 新增 busy state,`ConnectionBanner` 的重新同步按钮改为消费同一 action primitive。这个入口横跨设备列表、设备详情、新建会话、会话详情、文件页和自动化页;改动只统一 loading spinner、disabled/busy accessibility 和 pressed 表达,不改变连接错误映射、重订阅或任何远程同步调用。

本轮补充 6:登录页的 Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback URL 兜底和 Web 关闭入口已接入 `MainWindowActionButton`;登录页仅保留 debug modal 透明背景命中区使用 `Pressable`。该改动只统一可见动作的 pressed、disabled、busy 和 accessibility 表达,不改变 OAuth、mock login、callback 解析或本地联调语义。

本轮补充 7:`ScreenHeader` 的右侧 action 已从旧 `PillButton` 收敛到 compact `MainWindowActionButton`,并删除无调用方的旧 `PillButton` 分支。设备列表退出、设备详情新会话和自动化新建等头部主动作保留原 testID / onPress / 路由语义,只统一 pressed、disabled、busy、tone 和 accessibility 表达。

本轮补充 8:会话详情 route action 第二刀已补齐 `ActionPill` 的 selected/disabled accessibility state,并把 queue/search sheet header 的关闭入口从 `ActionPill` 改为 `RouteActionButton`。`queue.closeButton` / `session.searchCloseButton` 锚点、onClose 行为、队列模型和搜索模型保持不变,只统一 route 层触控和 accessibility owner。

本轮补充 9:queue/controls 状态 polish 已让 `QueueTouchButton` 支持 busy accessibility state,并把队列继续、错误重试/清除、编辑保存、行级移动/插话/编辑/删除和展开收起在 busy 时标记为同步中;`ControlActionButton` 补齐 selected/disabled accessibility state。queue projection、controls overview、远程调用和 testID 保持不变。

本轮补充 10:会话详情 `RouteActionButton` 现在把 busy 视为不可交互状态,会在 busy 期间移除 press/long-press/press-out handler 并应用 disabled 表达。发送、附件、语音、同步、pending resolve 和 sheet 操作的 testID、文案、shared model 和远程调用协议不变;改动只防止处理中重复触发。

本轮补充 11:pending interaction 的 `InteractionTouchButton` 也把 busy 视为不可交互状态,覆盖权限确认、Ask wizard、Plan review 和 Issue confirm 的局部动作入口。shared `buildInteractionResolveActionPresentation` / `canStartInteractionResolve` 仍是提交状态和 requestId 去重的事实源;mobile shell 只负责在处理中移除 press handler、暴露 disabled/busy accessibility state,避免用户在窄屏触控下重复提交。

本轮补充 12:消息窗口的 `MessageContentOpenButton` 和 payload body 的 `PayloadActionButton` 已补齐 disabled accessibility state,并让 disabled 样式与真实不可点击状态一致。媒体、文件、diff、tool result、Mermaid source、远程媒体重试、文件预览和路径复制的 payload 构造 / 远程读取协议 / testID 都不变;mobile shell 只统一消息主窗口里打开详情和 payload 动作的可达状态表达。

本轮补充 13:`MainWindowActionButton` / `MainWindowOptionButton` / `MainWindowRowButton` / `MainWindowCardButton` 现在都会把缺少 handler 的入口视为不可交互,并让 disabled 样式、press handler 和 accessibility state 保持一致。设备列表、设备详情、新建会话、文件页、自动化页和登录页的业务排序、路由、远程调用和 testID 不变;mobile primitive 只统一主窗口“可点/不可点”的事实源。

本轮补充 14:`MainWindowMetric` 作为可点击统计筛选入口时会暴露 selected accessibility state,覆盖设备详情 summary、自动化 summary 和新建会话 summary 的统计入口。metric 数值、筛选逻辑、导航和 testID 不变;mobile primitive 只补齐选中态表达。

本轮补充 15:`ActionPill` 和会话详情 `RouteActionButton` 现在也会把缺少 handler 的入口视为 disabled,并移除 press / long-press handler。设置/文件/搜索等 action strip、queue/search sheet 关闭、composer、搜索和同步入口的业务语义、远程调用、testID 不变;mobile shell 只补齐共享 pill 与 route action 的不可交互事实源。

本轮补充 16:`ControlActionButton` 现在会把缺少 handler 的入口视为 disabled,避免 controls sheet 中的重命名、复制、置顶、归档、删除确认、模型切换、Fast、extraDirs 和 context 刷新动作出现“可点但无动作”的状态。controls overview、远程调用、capability projection 和 testID 不变;mobile shell 只收口 controls sheet action 的不可交互事实源。

本轮补充 17:shared `buildSessionComposerLayout` 已新增 `input` 与 `attachment.remove` presentation,让发送中/附件处理中/语音转写中的输入框、附件工具、附件移除和语音入口都由同一 composer model 输出 disabled reason。移动端会话页只消费该模型渲染 TextInput、附件 chip 和 route action,避免发送中继续编辑或调整附件后被完成态清空;远程 enqueue、附件上传、语音转写、testID 和 device-link 协议不变。

本轮补充 18:`ScreenHeader` 的左侧返回入口已抽成内部 `ScreenBackButton`,与主窗口 action primitive 使用同一套 pressed / disabled / accessibility state 规则,覆盖设备详情、新建会话、会话详情、文件和自动化这些主窗口 header。返回箭头视觉、原 testID、`router.back()` 路由语义和右侧 header action 保持不变;mobile shell 只消除 header navigation 的裸 `Pressable` 分叉。

本轮补充 19:shared `scheduleForm.ts` 已新增 mobile 运行会话状态机,输出 fresh / persistent / bound 派生、切换、pending 绑定占位、真实绑定校验和绑定会话 ID 更新语义;移动端自动化表单消费该模型渲染三态切换、当前设备可绑定会话选项和 ID 输入兜底,绑定态隐藏项目目录 / worktree / Fast 等由会话决定的无效控件。schedule write channel、模板创建、run list、删除策略和原有 testID 不变。

本轮补充 20:shared `scheduleModel.ts` 的 `summarizeSchedule` 已输出 `runSessionLabel` / `runSessionDetail`,自动化列表和详情可直接显示 fresh / persistent / bound 的运行会话结果;移动端详情新增 `automations.runSessionDetail` 锚点,列表 detail 同步带上“新会话 / 持续会话 / 绑定会话”。该改动只补保存后的可见性,不改变 schedule 排序、run grouping、写入、暂停、删除或打开会话语义。

本轮补充 21:shared `scheduleModel.ts` 的 `summarizeRun` 已输出 run history meta、session short label、打开会话 label 和无会话 interrupted/aborted 的 restart capability。移动端运行历史新增 `automations.runMeta` 行展示“已运行/耗时 + 会话短标识/未创建会话/可重新执行”;这一刀只补展示摘要,不扩大单条 run 远程操作。

本轮补充 22:自动化运行历史单条动作已继续对齐桌面 `RunHistoryCard` / `RunHistoryPane`。shared `summarizeRun` 现在输出 `canMarkRead` / `canDelete` / `canRestart` 和对应 label,legacy session run 与 running run 的限制在 shared model 中判定;mobile 行内动作区新增 `automations.runActions`、`automations.markRunReadButton`、`automations.restartRunButton`、`automations.deleteRunButton` 和 `automations.runDelete*` 确认卡锚点。transport 和 shared contract 补齐 `maker:schedule:delete-run`,mock host 支持删除单条 run 并广播 schedule event。

本轮补充 23:新建会话按 `NewMakerDraftRoute` + `ChatInput` 的预启动态处理,不再把它当成单纯创建表单。`packages/maker-shared` 新增 composer palette model,移动端会话页继续通过 adapter re-export 消费;`newSession` draft model 新增首条 payload 状态,允许“文本或附件”构成首条消息。mobile 新建会话页新增 slash/@ 候选、远程文件附件 chip、附件路径面板和对应锚点,创建后仍通过同一个 `buildQueuedTextMessage` input projection 入队,不引入新发送协议。

本轮补充 24:Settings 独立为正式主窗口,不再把退出登录挂在 Devices header 上。Devices header 右侧入口改为 `devices.settingsButton`;`/settings` 使用主窗口 summary/metric/action primitives 展示账号、手机设备名、Relay 状态、调试信息和退出登录。手机设备名事实源拆到 `device-link/mobileDeviceIdentity.ts`,DeviceLink hello 和 Settings 共用;被控端允许远程控制、撤销和恢复权限仍在桌面 Settings。

本轮补充 25:System Card 展示语义沉到 shared core。`packages/maker-shared/src/systemCard.ts` 现在统一输出 `/help`、`/context`、`/cost`、`/pwd`、`/status`、桌面 `/compact` 和 `/cmd` 结果卡的 presentation;`summarizeContextUsage` 也从 mobile 本地函数迁到 shared `sessionControls.ts`。mobile `systemCard.ts` 只保留本地 slash 命令 adapter 和类型桥接,避免会话消息里的 system card 形成手机私有展示模型。

本轮补充 26:payload full-screen viewer 进入正式 iOS 视觉门禁。`visual-session-payload` 已从只输出截图升级为 baseline checker 默认清单的一部分,`ios-iphone-17-pro-expo-go` 现在校验 12 张截图;同时补 `buildPayloadModalSafeArea` 处理 iOS Modal 内 safe-area context 可能为 0 的情况,避免 payload 标题和状态栏重叠。Android 使用同一模型消费 status bar height,不写 iOS-only 分支。

本轮补充 27:payload 图片视觉 fixture 和 data URL 展示语义补强。mock host 的 `MOCK_IMAGE_DATA_URL` 从 1x1 PNG 改为可见的 160x90 稳定测试图,`maestro-flow-smoke` 会拒绝回退到 1x1 空白图;shared `summarizeMessagePayloadBody` / preview 对 `data:image/*` 输出“内联图片数据 · PNG · 大小”摘要,复制和打开仍保留原始 data URL,避免手机 payload 详情铺满 base64。

1. **先迁共享语义**:schedule list/run overview、schedule form serialization、delete policy、device-link channel/error contract、allowlist drift fixture、shared fixture baseline、raw desktop-like message parity、schedule/file raw payload parity 已迁到 `packages/maker-shared`;后续新增业务语义仍先进入 shared core。
2. **再重构移动端壳层**:保留 React Native 原生壳,但重新组织一级入口、详情页层级、sheet/full-screen route 和 debug surface。所有正式页面都只消费 shared model 或 typed mobile adapter,不直接解析桌面 raw payload。
3. **然后做会话页视觉和触控 pass**:按 `docs/design-rules/cindy-design-system.md` 的黑白灰、无阴影、12px container、pill interactive、克制字重整理 header、消息、工具、队列、pending interaction、composer 和状态提示。手机端只因触控和窄屏调整布局,不改变桌面业务语义。
4. **最后补功能缺口和调优**:在 UI 层级稳定后,再补 project automation 完整编辑、worktree 创建设计、Orca V2、native share extension、真实 OSS 媒体播放 fixture 这些后续项。

当前下一批具体任务按产品化重构排序:

| 优先级 | 内容 | 桌面来源 | 实现方式 | 完成条件 |
| --- | --- | --- | --- | --- |
| P0 | mobile design parity gate | `CCAgentSidebarUpper`、`SessionItem`、`ProjectNode`、`CCAgentSessionView`、`ChatInput`、`SchedulerPage`、`WorkdirBrowseRoute`、`docs/design-rules/cindy-design-system.md` | 所有 UI 任务先写桌面来源、主层信息、降噪清单和手机承载方式。首页列表作为第一份标准样板:桌面侧栏展示模型不变,手机只改导航、触控和 sheet/full-screen 承载。 | 每个页面 PR / 批次记录必须能说明“桌面主层显示什么、手机主层删掉什么、二级信息去了哪里”;没有记录不进入视觉 baseline。 |
| P0 | Home/sidebar parity baseline | `PinnedSection`、`ProjectsSection`、`DialogueSection`、`ProjectNode`、`SessionItem`、`VendorIcon`、`formatSidebarTime` | 首页继续作为全局主窗口样板:保留 Projects / Chats / Pinned 层级、一行 session row、桌面同源图标、右侧短时间、attention dot 和真实可用 action;设备筛选 chip 只做筛选,不把“选电脑”变成一级流程。 | iOS 首页截图与桌面侧栏源码规则逐项对齐;不出现 Relay 成功态、debug 说明、session subtitle/preview/detail 这类桌面侧栏主层没有的信息。 |
| P0 | shared core 第一轮收口 | `MessageStream`、`PendingQueuePanel`、`PermissionPrompt`、`ScheduleFormDialog`、`WorkdirBrowseRoute`、device-link dispatch | 已完成 automation/schedule、device-link contract、fixture baseline、raw message parity、schedule/file raw payload parity;后续新增业务语义仍先进入 shared model。 | shared build/test、mobile typecheck/test、desktop parity、web smoke、Maestro 静态检查、local full check-only 全部可跑。 |
| P0 | shared core 剩余抽取边界 | tool input diff/summary projection、tool_result media extraction、attachment -> file/media payload projection、message normalize content preview / stable sort / tool_use parse / tool_result pairing、`MessageStream` search/window、`ChatInput` capability projection、scheduler event projection 和 payload preview/severity 第一刀已完成 | 只抽纯模型:后续若出现新的排序、状态优先级、disabled reason、payload body presentation 或 decision serialization,继续先进入 shared。纯触控尺寸、SafeArea、WebView、Audio、ImagePicker、SecureStore 留在 mobile。 | 每个抽取都有 shared fixture;mobile 保留 re-export 兼容;桌面消费前至少有 parity test。 |
| P1 | mobile shell 信息架构 | `App.tsx`、`router.tsx`、`CCAgentFeatureLayout`、desktop sidebar/settings | 重排 Home/Computer Detail/Session/New/Automations/Files/Settings;debug/local test 移入 dev panel;正式路径只显示真实远程控制任务。 | web smoke 和 Maestro anchor 可区分正式路径和 debug 路径;首次进入不出现本地联调说明、mock 表单或成功态连接噪音。 |
| P1 | 重要主窗口产品化 | `CCAgentFeatureLayout`、`NewMakerDraftRoute`、`SchedulerPage`、`WorkdirBrowseRoute`、desktop sidebar/session list | 以首页为样板逐一重做 Computer Detail、New Session、Session Detail、Files、Automations、Settings 的主层信息密度。每个主窗口只保留桌面同级主层信息;其它状态进入 sheet/full-screen/detail。 | iOS 主要路径窗口在 320/393 宽度下无挤压、无多余卡片嵌套、testID 不断;每个窗口有降噪清单和截图;Android 只消费同一布局模型和 dry-run profile。 |
| P1 | RN 视觉 primitives | `docs/design-rules/cindy-design-system.md`、桌面按钮/卡片/状态 chip 语义 | 在 `apps/mobile` 建轻量 touch primitives:screen header、status strip、action pill、segmented control、bottom sheet container。只共享语义,不共享桌面 React 组件。 | iPhone SE 宽度按钮文字不挤压;所有新增颜色可回指到 mobile token;不引入阴影和装饰性渐变。 |
| P1 | session detail shell | `CCAgentSessionView`、`SessionContentHeader`、`RemoteSessionBanner`、`TopRightChipStack` | 固定 header、connection strip、message list、bottom composer/interaction 四层;controls/queue/search/files/diff/context/cost 转为 action strip + sheet/full-screen。 | idle、running、pending、queue、offline、revoked 六个状态截图无重叠;消息列表不因打开 sheet 被卸载。 |
| P1 | composer/pending 触控重构 | `ChatInput`、`PendingQueuePanel`、`PermissionPrompt`、`AskUserQuestionPrompt`、`PlanViewerCard`;`IssueConfirmCard` desktop-only | composer 保持底部主入口;pending interaction 优先占用底部面板;queue 和 controls 用 sheet;resolve 操作防重复提交;Issue Confirm 只提示回桌面端处理。 | permission/ask/plan/queue/send/stop/resume 都有 mock host flow 或 unit;键盘弹出后最后消息仍可见。 |
| P2 | message/payload 视觉重构 | `UserMessage`、`AssistantMessage`、`AgentActionsBlock`、`TodoListCard`、`ToolPayloadLightbox` | 按 shared render item 渲染;tool/work/todo 默认折叠;payload、diff、media、Mermaid、file preview 全屏查看。 | 1000 message fixture 可滚动;长 tool result 和大 diff 不撑爆消息列表;媒体关闭释放中转对象。 |
| P2 | feature parity hardening | `NewMakerDraftRoute`、`SessionControlsPanel`、`SchedulerPage`、`WorkdirBrowseRoute`、`MessageActionBar` | UI 稳定后补 new session、session controls、automations、file preview、fork/rewind 的细节缺口;不在粗糙壳层上继续加入口。fork/rewind 已先把 preview 面板触控布局补成可测 mobile shell 模型。 | 每个缺口至少一个 unit 或 E2E;桌面协议 shape 用 shared fixture 或 desktop parity 锁定。 |
| P2 | release-grade gate | desktop remote runner、mock host、Maestro、visual baseline、performance fixture | iOS profile 先固定为主回归;Android 保留 profile/doctor/dry-run 防坑,最终 release 前补同级 native flow / visual baseline。 | 用户复测前脚本给出明确通过/失败原因;不能把手工点测当主回归。 |

当前执行进展和下一步:

1. **RN primitives 和 Session Action Strip 第一刀已完成**:已新增 `ActionPill` / `InfoPill`,把会话页散落的设置、文件、搜索按钮和状态 chip 收成统一触控组件,保留原 Maestro testID。
2. **Session Detail 四层 shell 第一刀已完成**:会话页已拆出 `session.chrome`、`session.mainLayer`、`session.bottomLayer`,让 header / connection / action strip、消息主区、composer/palette 有明确层级。
3. **Queue sheet 第一刀已完成**:队列从消息主区移入 `queue.sheet`,通过 `session.queueButton` 打开,保留 `queue.panel` 等原有 Maestro 锚点。
4. **Search sheet 第一刀已完成**:搜索从 `session.chrome` 内联区域迁入 `search.sheet`,保留 `session.searchPanel` / input / counter / navigation 等原有锚点。
5. **Controls/Usage 入口第一刀已完成**:`SessionControlsPanel` 支持指定初始 tab,action strip 新增 `session.usageButton`,可直接打开用量/context/cost tab。
6. **B1 Debug/local path 分离第二刀已完成**:正式登录页只保留 Feishu 主路径和轻量 `login.debugButton`;mock login、本地 callback 粘贴和本地联调说明进入 `login.devPanel` modal;Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback 兜底和 Web 关闭入口已统一到 `MainWindowActionButton`;`login.devLoginButton` 自动化锚点保留。
7. **B3 Pending interaction bottom surface 第一刀已完成**:Permission、Ask User、Plan Review 的 `InteractionPanel` 已从 `session.mainLayer` 移到 `session.bottomLayer` 下的 `interaction.bottomSurface`,消息历史继续留在主层;Issue Confirm 只保留桌面端处理提示。
8. **B2 Payload full-screen viewer shell 第一刀已完成**:payload modal 已改成 SafeArea full-screen viewer,固定 `message.payloadViewerHeader`,独立 `message.payloadViewerBody`,并用 `message.payloadKind` 标识 diff/file/media/mermaid/text 类型。
9. **B4 视觉截图基线已进入 iOS 门禁**:已补 visual mock scenario、`visual_session_idle.yaml` / `visual_session_running.yaml` / `visual_session_queue.yaml` / `visual_session_pending.yaml` / `visual_session_payload.yaml` / `visual_session_revoked.yaml` / `visual_session_offline.yaml`、baseline checker 和 local visual smoke 入口;`visual_smoke.yaml` 现在采集设备列表、Settings、设备详情、会话和控制面板,`visual_session_payload.yaml` 采集 payload full-screen viewer,`ios-iphone-17-pro-expo-go` 已接受设备列表、Settings、设备详情、会话、控制面板、payload full-screen viewer、idle/running/pending/queue/offline/revoked 十二张截图,revoked flow 会真实等待“访问已撤销”。多状态截图已拆成独立 flow,local visual suite 会隔离 mock host 生命周期并清理 stale e2e 设备记录,避免一个长 flow 连续切 session 造成同步竞态或设备列表计数漂移。
10. **当前进入 C2 composer / pending / queue polish**:message normalize content preview / stable sort / tool pairing、payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection 和 message presentation 第一刀已沉到 `packages/maker-shared`,mobile payload viewer、消息气泡、tool row、todo card、work group、tool result、media、file、diff 入口和 payload header 已消费。C2.1/C2.2 第一刀已完成:`sessionOperation.ts` 进入 shared core,统一输出 bottom slot priority、composer availability、message history mode、send/stop/attachment/voice label、disabled reason 和 primary action;mobile `sessionComposerLayout` / `sessionOperationLayout` 只保留兼容 re-export。C2.3 第二刀已完成:queue row action availability、move target、busy/read-only/steering/edit-lock/interaction-lock/Orca disabled reason 已进入 shared queue model,QueuePanel 只消费 row presentation 渲染按钮和 accessibility hint;`queueTouchLayout.ts` 继续把五动作队列行的 36px 触控尺寸、compact gap、按钮宽度和容器 padding 做成平台无关布局模型。C2.4 第二刀已完成:pending resolve action presentation 和 requestId duplicate guard 已进入 shared interaction model,InteractionPanel 的 permission / ask / plan / issue resolve 按钮统一消费该模型;`interactionTouchLayout.ts` 继续把动作行按钮、Ask 自定义输入行、plan 模式按钮、队列预览 chip 和 plan preview 高度做成平台无关布局模型。C2.5 第一轮稳定化已完成:键盘/native shell layout、透明 Modal presentation、session 详情在线失败受控重试、远端不可用 read-only composer、附件 picker、相册/拍照、本机文件上传、语音录制/转写和 iOS native visual baseline 已跑通;C2.8 会话 chrome/action strip 已新增 `sessionChromeLayout.ts`,用屏幕宽度和 action 数量输出 padding、gap、pill min-width、单行提示和 overflow 信号,让 iPhone SE/现代 iPhone 宽度内完整露出设置/用量/文件/队列/搜索五个入口,并避免把 Android 后续适配写成 iOS 分支;C2.9 controls sheet 已新增 `sessionControlsTouchLayout.ts`,把 overview 单/双列、section tab 高度、输入行堆叠、action button 宽高、远程目录选择按钮和面板 padding 锁成平台无关模型,第二刀把 sheet 内的重命名、复制、置顶、归档、删除确认、模型切换、Fast、extraDirs 和 context 刷新动作统一到 `ControlActionButton`,第三刀把 inline 运行设置入口、sheet section tabs、远程目录进入行和连接 banner 重新同步按钮补齐局部 action primitive / accessibility state,不再复制局部按钮样式。C1 payload body 第二刀已新增 `payloadBodyLayout.ts`,把 diff pane 宽度、file preview 高度、media/image/mermaid 高度、正文滚动高度和 payload 操作按钮尺寸从 TSX 固定值改为 screen width 输出;C1 message auxiliary 第三刀把 load-earlier/new-message、Todo 详情和图片缩放按钮统一到局部 action primitive,C1 foldable header 第三刀把 Work/Tool/Todo/Thinking 折叠头统一到 `FoldableHeaderButton`,保持 iOS 优先验证同时不写死 iOS-only 分支。offline/read-only 说明文案优先级仍由 shared test 锁住。Android baseline 和真机延迟/失败态调优继续作为后续检查项。
11. **重要主窗口优先第二十四刀已完成**:`mainWindowLayout.ts` 留在 mobile shell,按 screen width + window kind 输出 summary、toolbar、content、block、list、empty、inline action 的 padding/gap/min-size。设备列表、设备详情、新建会话、文件浏览、自动化窗口已接入;summary 指标支持小屏换行,文件路径输入在窄屏自动堆叠,空态和主内容边距统一;第二刀新增 `MainWindowMetric` / `MainWindowEmptyState`,把设备、新建会话、自动化和文件页的重复 metric / empty UI 收敛成移动端 primitives;第三刀新增 `MainWindowActionGroup`,自动化详情把 Run now 放主操作、暂停/恢复与编辑放次级操作、删除放危险操作,并用 `automations.detailActions` 锚点锁住层级;第四刀继续把新建会话底部提交区、文件浏览目录操作区和选中文件预览操作区接入 `MainWindowActionGroup`,新增 `newSession.actions`、`files.directoryActions`、`files.previewActions` 容器锚点;第五刀把设备详情顶部 toolbar、批量选择操作和批量确认操作接入 `MainWindowActionGroup`,新增 `deviceDetail.toolbarActions`、`deviceDetail.selectionHeaderActions`、`deviceDetail.bulkPrimaryActions`、`deviceDetail.bulkDangerActions`、`deviceDetail.bulkConfirmActions` 容器锚点,并给 toolbar/选择头补 compact density;第六刀把自动化空态创建、表单保存/取消、删除确认和暂停确认接入 `MainWindowActionGroup`,新增 `automations.emptyActions`、`automations.form.actions`、`automations.delete.actions`、`automations.pause.actions` 容器锚点;第七刀把设备列表顶部不可用设备切换和空态重新同步接入 `MainWindowActionGroup`,新增 `devices.filterActions`、`devices.emptyActions` 容器锚点;第八刀把新建会话远程目录浏览打开/刷新/上级/使用当前目录接入 `MainWindowActionGroup`,新增 `newSession.remoteBrowseActions`、`newSession.remoteBrowsePanelActions` 容器锚点;第九刀把文件页当前目录复制和路径前往动作改用 `MainWindowActionButton`,新增 `files.locationActions`、`files.pathInputActions` 容器锚点,并继续消费 `mainWindowLayout` 的 inline action 尺寸;第十刀把自动化运行历史打开会话动作改用 `MainWindowActionButton`,新增 `automations.runActions` 容器锚点;第十一刀把设备详情 summary 的自动化入口改用 `MainWindowActionButton`,新增 `deviceDetail.automationActions` 容器锚点;第十二刀新增 `MainWindowOptionButton` / `MainWindowRowButton`,设备详情筛选/分组/session row/自动化子 row 和新建会话最近项目/运行选项/远程目录行已接入统一 pressed / selected / expanded / disabled accessibility state;第十三刀把文件页面包屑/文件行和自动化 segment/schedule row 继续接入同一套 option/row primitive;第十四刀新增 `MainWindowCardButton`,设备列表行、自动化删除单选、模板刷新、模板卡片和 boolean toggle 已接入统一 pressed / selected / checked / disabled accessibility state;第十五刀把全局 `ConnectionBanner` 重新同步入口接入 busy-aware `MainWindowActionButton`;第十六刀把登录页 Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback 兜底和 Web 关闭入口接入同一 action primitive;第十七刀把 `ScreenHeader` 右侧 action 接入 compact `MainWindowActionButton`,并删除旧 `PillButton`;第十八刀让主窗口 action/option/row/card primitive 把缺少 handler 的入口也视为 disabled,统一不可交互事实源;第十九刀给可点击 `MainWindowMetric` 补 selected accessibility state;第二十刀把 `ScreenHeader` 左侧返回入口抽成 `ScreenBackButton`,统一 pressed / disabled / accessibility state;第二十一刀把自动化表单的运行会话三态接入 shared schedule form model,并用当前设备会话选项 + ID 输入兜底承载 bound;第二十二刀让自动化列表/详情消费 shared schedule summary 显示新会话/持续会话/绑定会话,并新增 automations.runSessionDetail 锚点;第二十三刀让运行历史消费 shared run summary 显示耗时 meta 和会话短标识,并新增 automations.runMeta 锚点;第二十四刀让运行历史行消费 shared action capability,补齐打开会话、标已读、无会话异常重跑和删除确认,并新增 `automations.markRunReadButton`、`automations.restartRunButton`、`automations.deleteRunButton`、`automations.runDelete*` 锚点。路由和远程调用仍走现有 typed transport;run action 容器从 `automations.runSessionActions` 收敛为 `automations.runActions`。
12. **Session route action primitive 第四刀已完成**:`app/sessions/[sessionId].tsx` 新增局部 `RouteActionButton` / `SheetBackdropButton`,composer 附件/语音/停止/发送、搜索上一条/下一条/加载更早、未同步重新同步、历史消息展开和 settings/queue/search backdrop 已统一 pressed / disabled / busy / selected accessibility state。第二刀补齐 `ActionPill` 的 selected/disabled accessibility state,并把 queue/search sheet header 的关闭入口接入 `RouteActionButton`;第三刀让 `RouteActionButton` 在 busy 期间不可重复触发;第四刀让 `ActionPill` 和 `RouteActionButton` 在缺少 handler 时也进入 disabled 状态。业务语义仍来自 shared composer/search/window/session operation model,route 只负责触控反馈、sheet 关闭和 native 输入能力。
13. **Android baseline 后置**:Android 当前不作为 C/D 阶段阻断项;只保留 `android-pixel-expo-go` profile、doctor 和 dry-run 防坑。等 iOS 高标准验收后,再采集独立 Android baseline 目录并提升为发布前门禁。
14. **最后补剩余 parity 缺口**:在 shell 和视觉基线稳定后继续补 project automation、share extension、Orca V2 和真实 OSS 媒体 fixture;这些不能插队到 C1 前面。

### 16.2 更新后的下一批执行批次

| 批次 | 目标 | 实现方式 | 验收 |
| --- | --- | --- | --- |
| B1 | Debug/local path 分离 | 第二刀已完成:登录页保留正式 Feishu 主路径和轻量 `login.debugButton`;mock login、callback URL 兜底进入 dev modal;所有可见登录/dev/web 入口统一使用 `MainWindowActionButton`,透明 modal backdrop 仍是背景命中区。后续 fixture 切换、protocol debug 继续进入同一 debug surface。 | `login.devLoginButton` 仍可被 smoke 使用;typecheck、Maestro 静态、unit、web smoke、local full check-only 已通过。 |
| B2 | Session auxiliary surfaces 收口 | queue/search/controls/settings 已完成 sheet owner;context/cost 通过 Usage 入口进入 settings sheet;files 已是独立 route;payload/diff/media/file 已进入统一 full-screen viewer shell。 | `message.payloadViewerHeader` / `message.payloadViewerBody` / `message.payloadKind` 已加入 Maestro 锚点;打开/关闭 viewer 不卸载消息列表。 |
| B3 | Pending interaction bottom surface | 第一刀已完成:Permission、Ask User、Plan Review 固定到底部 `interaction.bottomSurface`,主层保留消息历史和 pending history toggle;Issue Confirm 仅显示桌面端处理提示。 | `interaction.bottomSurface`/`interaction.bottomScroll` 锚点已加入 Maestro 静态;permission/ask/plan 锚点保留。 |
| B4 | Session visual baseline | 已完成 iOS 第一版:visual mock scenario 提供 idle/running/pending/queue/offline/revoked 六态;idle/running/queue/pending/payload 已拆成独立 flow 采集;revoked/offline 用独立 flow 作为最后一步;Settings 已进入 `visual_smoke.yaml` 截图 flow;baseline checker 普通清单包含 12 张已采集图,包括 `visual-settings` 和 `visual-session-payload`。local visual suite 会隔离 mock host 并清理 stale e2e 设备记录。 | static/dry-run/headless relay、native visual flow、`ios-iphone-17-pro-expo-go` baseline update/check;Android 先只保留 profile/dry-run,等 iOS 验收后补真实 baseline。 |
| C0 | Shared UI model increment | message normalize 已完成第一刀:`messageNormalize.ts` 输出 desktop content preview、stable key、createdAt stable sort、tool_use parse、tool_result by-id / legacy adjacency pairing 和 Orca 空通信结果隐藏;payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection 已完成第一刀:`payloadSummary.ts` 输出 payload kind/title/subtitle/copy/open target、body presentation、preview severity、primary action、compact meta、ToolCallCard 同款 summary、Edit/Write/MultiEdit diff projection、tool_result media extraction、attachment -> file/media payload projection、diff/media/file/mermaid/text 构造/格式化;message presentation 已完成第一刀:`messagePresentation.ts` 输出 bubble density/role、desktop-style fold header、todo progress/summary/status、错误识别和 diff 计数,不再产出 mobile-only badge/signals 字段;system card presentation 已完成第一刀:`systemCard.ts` 输出 help/context/cost/pwd/status/compact/cmd 的行、标题和正文模型;message window/search 已完成第一刀:`messageWindow.ts` / `messageSearch.ts` 输出滚动锚点、新消息提示、加载更早 action、搜索命中、preview 和 index wrap;capability projection 已完成第一刀:`agentCapabilities.ts` 输出远端能力归一、运行选项和跨模型切换确认;session action strip 已完成第一刀:`sessionActionStrip.ts` / `sessionIdentity.ts` 输出 header、state chips、action labels、disabled reason、协作/Worktree/Dialogue 标识;device list 已完成第一刀:`deviceList.ts` 输出可控性分类、排序、平台标签、可见性、header/filter/empty/toggle presentation;session list / bulk selection 已完成第一刀:`sessionList.ts` / `sessionSelection.ts` 输出筛选、搜索、分组、自动化组行、列表上下文、空状态和批量 patch projection;scheduler event projection 已完成第一刀:`scheduleEvents.ts` 输出 list/runs/session-index/unread refresh intent;mobile payload viewer、消息流、system card、controls、new session、action strip、device list、session list、schedule event store 和 payload preview 入口已消费。 | shared fixture + mobile adapter test;桌面消费前至少有 desktop parity test 或 fixture 对齐。 |
| C1 | Message/payload polish | 第二刀进行中:payload viewer header 统一使用 shared summary/preview,并提供复制 payload 内容 / 安全打开直接 URL 的触控动作;`payloadHeaderLayout.ts` 已把复制/打开/关闭/图库翻页的窄屏堆叠规则做成平台无关 mobile layout model;header 内复制、打开、上一张、下一张和关闭动作已统一到局部 `PayloadHeaderActionButton`;payload body 使用 shared media/file/text/Mermaid presentation;message bubble 使用 shared density/role;message action bar 已把 copy/more/fork/rewind 的 36px 触控尺寸和小屏宽度纳入 `messageActions.ts` 状态;tool row 使用 shared diff/媒体/输出/错误信号;todo card 使用 shared progress/active/summary/default expanded;work group 固定 `message.workGroupToggle` 锚点。`messageContentLayout.ts` 已把 markdown code/table/list、Mermaid preview、附件图片/file chip、媒体 preview、diff preview、tool result preview 的宽高/gap/行数转成 screen width 模型;媒体、文件、diff、tool result 和 Mermaid source 打开详情动作已统一到局部 `MessageContentOpenButton`,保留原 payload 语义和 testID。payload media viewer 已有 `visual_session_payload.yaml` 视觉 flow,后续 JDK 17 就绪后补 hash baseline。下一步在 iOS visual baseline 保护下继续做 diff/file/media/Mermaid body 的触控细节和视觉截图采集。 | 1000 message fixture 可滚动;长 tool result 和大 diff 不撑爆列表;payload header 在 320/360/393 宽度下不挤压标题或动作;payload header 原 action testID 保持稳定;message action bar 小屏可触达;markdown/附件/媒体 preview 在 320/393 宽度下不出现固定宽度挤压;消息内容打开详情入口保留 `message.mediaPreviewButton` / `message.filePreviewButton*` / `message.diffPreviewButton` / `message.toolPayloadButton` / `message.mermaidSourceButton` 锚点;媒体关闭释放中转对象;视觉 baseline hash 不被无意改动。 |
| C2 | Composer/pending/queue polish | 当前批次。先把 slot priority、send/stop/queue disabled reason、inflight guard、pending resolve 防重复提交和 controls sheet 入口状态整理成 shared model 或 typed mobile adapter;再调整键盘、附件、语音、slash/@、pending wizard、queue sheet、controls sheet 的触控节奏。`composerTouchLayout.ts` 已进入第二刀,把附件快捷动作 gap、远程路径行堆叠/gap、添加按钮宽度和 composer 横向 padding 纳入平台无关布局模型;`queueTouchLayout.ts` 已进入队列触控第二刀,把五动作队列行在 320/393 宽度下的 36px 可触达尺寸、compact gap 和容器 padding 锁成纯模型;`QueuePanel` 已新增局部 `QueueTouchButton`,统一 resume/retry/clear/error/edit/save/move/steer/remove/toggle 的 pressed/disabled accessibility 表达;`sessionControlsTouchLayout.ts` 已进入 controls sheet 第二刀,把 overview / tabs / inputs / actions / remote-dir browser 的窄屏节奏锁成纯模型,第三刀补齐 controls inline 入口、tabs、远程目录进入行和连接 banner sync 的 action primitive / accessibility state;`interactionTouchLayout.ts` 已进入 pending interaction 第二刀,把 permission/ask/plan/issue 动作行、Ask 输入行、plan preview 和 interaction queue chip 的窄屏节奏锁成纯模型;`InteractionPanel` 已新增局部 `InteractionTouchButton`,统一 Ask 选项、Plan 模式/目录/反馈、Issue 类型和 resolve 按钮的 pressed/disabled/selected accessibility 表达。 | send/stop/resume/permission/ask/plan/issue/queue/attachment/voice/controls 都有 unit 或 mock host flow;键盘弹起时最后消息仍可见;附件 picker 在 320/384/393 宽度下不挤压;队列五动作、controls sheet 和 pending interaction 主要按钮在 320/393 宽度下不出现过小触控目标;重复点击不会产生重复 resolve/enqueue。 |
| D1 | Feature parity hardening | 回到桌面源码矩阵,补 new session、session controls、automations、file preview、fork/rewind 的体验细节。 | 每个缺口至少一个 unit、desktop parity 或 E2E flow;不靠人工点测兜底。 |
| E1 | Release-grade gate | iOS 先固定 native profile、visual baseline、reconnect、1000 message/session、日志/截图/残留进程输出;Android 等 iOS 验收后补同级 baseline。 | 用户复测前脚本先给出通过/失败原因;手工点测只做产品体验确认,不做主回归。 |

### 16.3 C/D/E 当前执行拆解

C 阶段只做会话页产品化和必要的 shared model 增量,不插入新的大功能入口。每一项都必须写清桌面来源、shared model 是否需要更新、mobile UI 怎么承载、自动化怎么证明。

| 批次 | 状态 | 桌面来源 | 实现方式 | 验收 |
| --- | --- | --- | --- | --- |
| C1.1 Payload viewer header | 已完成第二刀 | `ToolPayloadLightbox`, `AgentActionRow`, `FileBodyView` | `payloadSummary.ts` 输出 kind/title/subtitle/copy/open target/preview severity/primary action/compact meta;mobile header 消费 shared summary/preview,提供复制和安全打开直接 URL;`payloadHeaderLayout.ts` 按 screen width + copy/open/gallery action density 输出 row/column、padding、gap、button min-width 和 action 对齐,小屏自动堆叠避免标题和动作互相挤压。第二刀把复制、打开、上一张、下一张和关闭统一到局部 `PayloadHeaderActionButton`,header 只负责 summary/gallery 状态和触发对应动作。 | shared payload summary test、mobile payload adapter test、`payloadHeaderLayout.test` 覆盖 320/360/393/未就绪宽度;原 `message.payloadCopyButton` / `message.payloadOpenButton` / `message.galleryPrevButton` / `message.galleryNextButton` / `message.payloadCloseButton` 锚点保持稳定;typecheck、mobile unit、Maestro 静态、iOS/Android visual dry-run。 |
| C1.2 Message visual density | 已完成第二刀 | `MessageStream`, `UserMessage`, `AssistantMessage`, `MessageItem` | 已把 bubble density/role label、desktop-style fold header、错误识别和 diff 计数迁入 `packages/maker-shared/src/messagePresentation.ts`;mobile message bubble 消费 shared density,并保留 user/agent/rich/compact 稳定尺寸。message action bar 已对齐桌面 `MessageActionBar` 的 24px action、14px icon 和 copy/fork/rewind 顺序,触控热区单独扩大。 | shared message presentation test、mobile `messageActions.test` 覆盖 streaming/expanded/small-screen/default width、typecheck、mobile unit、web smoke、Maestro 静态、local full check-only 已通过;真实视觉 hash 待下一次 native 截图采集。 |
| C1.3 Work/tool/todo hierarchy | 已完成第三刀 | `WorkGroupBlock`, `AgentActionsBlock`, `AgentActionRow`, `ThinkingCard`, `TodoListCard` | 保持 shared render item 作为输入;本轮按桌面减法重修:Work group 收起态不再显示错误/工具/思考/消息分类 chip;tool row 不显示手机新增 signals,shared presentation 也不再产出 badge/signals 字段;Todo 对齐桌面 `TodoListCard`,header 显示 completed/total + active item,用图标表达三态,内联展示列表,不做独立 Todo sheet / 查看全部按钮。`messageHierarchyLayout.ts` 只负责 mobile padding、chevron 和触控尺寸,不再保留 badge 布局字段或隐藏的 `MessageBadges` 渲染路径。Maestro source anchor 已从旧 `message.todoSheet*` 更新为 inline `message.todoRow`。 | shared message presentation test、mobile adapter test、`messageHierarchyLayout.test` 覆盖 320/393/未就绪宽度;source anchor 断言不再出现 todo sheet、todo status label、tool row signal chip 或隐藏 badge renderer;typecheck、mobile unit、Maestro 静态、iOS visual dry-run。 |
| C1.4 Message content touch layout | 已完成第二刀 | `MessageStream`, `ChatImageView`, `ToolCallCard`, markdown renderer | `messageContentLayout.ts` 留在 mobile shell,按 screen width 输出 markdown code/table/list padding、Mermaid preview padding、附件图片/file chip、媒体 preview、diff preview 和 tool result preview 的宽高/gap/行数;第二刀把媒体、文件、diff、tool result 和 Mermaid source 的“打开详情”触控语义收敛到局部 `MessageContentOpenButton`,卡片本身只负责展示内容;Markdown parser、payload summary 和 file/media 语义不变。 | `messageContentLayout.test` 覆盖 320/393/未就绪宽度;message markdown/attachment tests 继续覆盖 parser 和分组;原打开入口 testID 保持稳定;typecheck/unit、Maestro 静态和 iOS/Android visual dry-run 捕捉真实截图变化。 |
| C1.5 Payload body polish | 已完成第二刀 | `ToolPayloadLightbox`, `ImageLightbox`, `VideoLightbox`, `ChatAudioCard` | `summarizeMessagePayloadBody` 已进入 shared core,统一输出 media direct/remote/file/text/Mermaid body 展示语义;mobile viewer 消费该模型,远程取件仍由 device-link media flow 和 native player 承载;diff 旧/新对照保留横向滚动容器和 `message.diffCompareScroll` 锚点,窄屏不裁掉右侧 pane。第二刀新增局部 `PayloadActionButton`,统一远程媒体重试/打开、文件预览加载、diff 当前文件读取和复制远程路径动作,并在路径切换时复位复制反馈,避免同一 viewer 切换 payload 后残留旧路径状态。 | shared payload summary/body test、mobile payload adapter/remote media test、`payloadBodyLayout.test`、`message.payloadPathActions` anchor、typecheck/unit、Maestro 静态、iOS/Android visual dry-run;后续继续补真实 native 视觉截图和更细的 diff/file/media body polish。 |
| C2.1 Operation slot model | 已完成第一刀 | `CCAgentSessionView`, `InteractionPromptHost`, `ChatInput`, `PendingQueuePanel` | `packages/maker-shared/src/sessionOperation.ts` 已输出 missing session / pending interaction / read-only / editable / queue visible / message history mode 优先级;mobile 只通过 re-export 消费。 | shared unit + mobile adapter test 已覆盖;后续 UI 接入时继续验证 pending/read-only/queue 三态不卸载消息主列表。 |
| C2.2 Composer action state | 已完成第一刀 | `ChatInput` | send / stop / attachment / voice / draft / queue busy 的 label、disabled reason、primary action priority 已从 mobile 本地纯函数迁入 shared;RN 组件后续只消费展示模型。 | shared `sessionOperation.test` 与 mobile `sessionComposerLayout.test` 覆盖空 draft、附件-only、sending、recording、transcribing、running stop、queue busy。 |
| C2.3 Queue touch rhythm | 已完成第二刀 | `PendingQueuePanel` | `buildQueueRowPresentation` 已进入 shared queue model,统一输出 row title/hint、move target、move/edit/remove/steer action availability、busy/read-only/steering/edit-lock/interaction-lock/Orca disabled reason;QueuePanel 只消费该模型渲染按钮和 accessibility hint。`queueTouchLayout.ts` 负责 mobile-only 触控布局,按 screen width + action density 输出 action button min-height/min-width、icon size、gap、container padding/margin,让 320px 小屏和 393px 常规 iPhone 上的上移/下移/插话/编辑/删除五动作都保持可触达。第二刀把继续、错误重试/清除、编辑保存/取消、上移/下移、插话、编辑、删除和展开/收起统一到局部 `QueueTouchButton`,面板只负责 queue projection 和远程调用。 | shared queue test + mobile input projection adapter test 已覆盖;`queueTouchLayout.test` 覆盖 320/393/未就绪宽度和五动作 compact;原 queue action testID 保持稳定;typecheck/unit、Maestro 静态和 iOS/Android visual dry-run 保护 queue sheet 主路径。 |
| C2.4 Pending wizard guard | 已完成第二刀 | `PermissionPrompt`, `AskUserQuestionPrompt`, `PlanViewerCard`, `PlanActionCard`;`IssueConfirmCard` desktop-only | `buildInteractionResolveActionPresentation` 和 `canStartInteractionResolve` 已进入 shared interaction model;InteractionPanel 的 permission / ask / plan resolve 按钮统一走 shared disabled reason / busy label / confirm label,并用 requestId ref guard 阻止快速双击重复提交。`interactionTouchLayout.ts` 负责 mobile-only 触控布局,按 screen width + action/queue density 输出 root/card padding、action button min-height/min-width、Ask 自定义输入行堆叠、mode button 尺寸、queue chip gap 和 plan preview 高度。第二刀把 Ask 选项/自定义入口/上一步、Plan 折叠/预览编辑 tab/尺寸/目录/反馈和 resolve 按钮统一到局部 `InteractionTouchButton`,卡片只负责 decision 内容和表单状态;Issue Confirm 只走 unsupported 兜底。 | shared interaction test + mobile interaction adapter test 已覆盖;`interactionTouchLayout.test` 覆盖 320/393/未就绪宽度和 dense queue;Ask/Plan 原 testID 保持稳定;typecheck/unit、Maestro 静态和 iOS/Android visual dry-run 保护 pending flow。 |
| C2.5 Keyboard/native visual check | 已完成第二刀 | `ChatInput`, mobile SafeArea / keyboard behavior, `RemoteSessionBanner` | `mobileNativeShellLayout` 统一 KeyboardAvoidingView、composer/sheet/palette 高度和 composer 内部滚动;透明 Modal 统一 `overFullScreen`;session 详情在设备在线但同步失败时做一次受控重试,并修复重试 key 被 loading 清空造成的循环重试;远端不可用时由 shared `sessionOperation.ts` 输出 read-only composer / disabled reason。附件 picker、相册/拍照、本机文件上传和语音录制/转写已完成首版;`composerTouchLayout.ts` 第二刀把小屏附件快捷动作、远程路径行和 composer 外边距做成可测布局规则,后续继续做真机延迟与失败态调优。 | `composerTouchLayout.test` 覆盖 320/384/393/未就绪宽度;iOS native visual flow + visual baseline dry-run 稳定通过;offline 截图保留会话 shell 和只读 composer;Android 当前只做 profile/脚本护栏,不采集阻断 baseline;web smoke 只作为结构检查。 |
| C2.6 Session action strip model | 已完成第一刀 | `SessionContentHeader`, `TopRightChipStack`, `ChatInput` control state | `sessionActionStrip.ts` 已输出 session title/subtitle、state chips、settings/usage/files/queue/search actions、active/attention/disabled reason;`sessionIdentity.ts` 已输出协作/Worktree/Dialogue 标识;mobile `SessionSummaryHeader` 从 action 数组渲染,同时保留 literal Maestro testID。 | shared `sessionActionStrip.test`、shared build/test、mobile typecheck、mobile unit 和 Maestro anchor smoke 已通过;Android 只保留平台无关路径和 profile 护栏。 |
| C2.7 Scheduler event projection | 已完成第一刀 | `schedulesStore`, `RunHistoryPane`, `useAutomationScheduleSessionIndex` | `scheduleEvents.ts` 已输出 desktop SchedulerEvent 归一、schedule list / selected runs / session index / unread summary refresh intent、run patch hint 和 unread impact;mobile `remoteScheduleEvents` store 保存 per-device projection snapshot,自动化页按 list/runs intent 刷新,设备详情按 session-index intent 刷新自动化分组。 | shared `scheduleEvents.test`、mobile `remoteScheduleEvents.test`、shared build/test 和 mobile typecheck 已通过;Android 不涉及平台 API,只消费同一 store。 |
| C2.8 Session chrome compact pass | 已完成第二刀 | `SessionContentHeader`, `RemoteSessionBanner`, `TopRightChipStack` | 会话 action strip 的 mobile padding、action pill min-width 和提示卡高度已收紧,并新增 `sessionChromeLayout.ts` 作为平台无关纯模型,按屏幕宽度/action 数量输出小屏布局和 overflow 信号;五个主入口在 iPhone SE/现代 iPhone 宽度内可完整露出,Android 后续只消费同一模型不需要重写语义;`remoteUnavailableReason` 的 action copy 优先级用 shared test 锁住,避免只读/offline 状态继续显示“输入区可用”。 | mobile `sessionChromeLayout.test` 覆盖 320/393/未就绪宽度/极窄 overflow;shared `sessionActionStrip.test` 覆盖 remote unavailable;mobile unit、Maestro anchor smoke、iOS visual native flow 和 12 张 baseline hash 通过。 |
| C2.9 Controls sheet touch rhythm | 已完成第五刀 | `SessionControlsPanel`, `ConnectionBanner`, `SessionControlsPanel` sheet usage/context entry | `sessionControlsTouchLayout.ts` 已进入 mobile-only 触控布局层,按 screen width + section/overview density 输出 root padding、sheet header gap、overview 单/双列、section tab height/gap、输入行堆叠、action button min-height/min-width、remote-dir browser 选择按钮尺寸;第二刀新增局部 `ControlActionButton`,统一 controls sheet 内动作的 primary/secondary/danger、active、disabled 和 pressed 表达;第三刀新增 `ControlSummaryButton` / `ControlSectionTab` / `RemoteDirectoryEntryButton`,补齐 inline 入口、section tabs、远程目录进入行和重新同步入口的 pressed / disabled / selected / expanded accessibility state;第四刀让 `MainWindowActionButton` 支持 busy state,并把全局 `ConnectionBanner` 重新同步入口改为消费同一 action primitive;第五刀让 `ControlActionButton` 把缺少 handler 的入口也视为 disabled;`SessionControlsPanel` 和 `ConnectionBanner` 只消费布局/动作表达模型,不改变 rename/pin/archive/delete/model/effort/permission/fast/extraDirs/context、连接错误映射、重订阅或远程目录 browse 协议语义。 | mobile `sessionControlsTouchLayout.test` 覆盖 320/393/未就绪宽度和 dense controls;`sessionControls.test` 继续覆盖 overview / spend / context 语义;typecheck/unit、Maestro anchor、iOS/Android visual dry-run 保护 controls sheet 和连接 banner 截图。 |
| C2.10 Main window layout pass | 已完成第二十五刀 | `CCAgentFeatureLayout`, `NewMakerDraftRoute`, `SchedulerPage`, `WorkdirBrowseRoute`, desktop session/device list, mobile login route, `ScreenHeader`, desktop `ScheduleFormDialog` / `scheduleFormLogic`, desktop `RunHistoryCard` / `RunHistoryPane`, desktop settings remote/device/login | `mainWindowLayout.ts` 留在 mobile shell,只把设备列表、设备详情、新建会话、文件浏览、自动化、Settings 这些一级窗口的 summary、toolbar、content、block、list、empty 和 inline action 尺寸统一成 screen width + window kind 输出;`MainWindowMetric` / `MainWindowEmptyState` 统一设备、新建会话、自动化、文件页和 Settings 的主窗口指标与空态表达;`MainWindowActionGroup` / `MainWindowActionButton` 统一主/次级/危险/inline/row/navigation/header 操作层级,`MainWindowOptionButton` / `MainWindowRowButton` / `MainWindowCardButton` 统一主窗口 option、segment、breadcrumb、list row、template card、radio card 和 switch row 的 touched / selected / checked / expanded / disabled state,已覆盖设备列表、设备详情、新建会话、文件页、自动化页和 Settings 高频入口;登录页可见动作、`ScreenHeader` 右侧 action 和 Settings 退出登录也接入 `MainWindowActionButton`,并统一把缺少 handler 的入口视为不可交互;`ScreenHeader` 左侧返回入口已抽成 `ScreenBackButton`,统一 header navigation 的 pressed / disabled / accessibility state;自动化表单运行会话三态已由 shared `scheduleForm.ts` 输出 fresh/persistent/bound 派生、切换和 pending 绑定校验,mobile 只渲染分段控件、会话选项和 ID 兜底;自动化列表/详情的运行会话标签和详情、运行历史耗时 meta、会话短标识、单条 run action capability 均由 shared `scheduleModel.ts` 输出;Settings 的账号、手机设备、Relay 和调试信息留在 mobile shell,手机设备名事实源拆到 `device-link/mobileDeviceIdentity.ts`,由 DeviceLink hello 和 Settings 共用。OAuth/mock/callback/header 路由语义不进入 mobile primitive。业务排序、表单序列化、文件预览、设备可见性过滤、批量 session patch、schedule write/delete/pause、remote workdir browse、远程路径 stat、复制路径、自动化导航、run 打开会话、登录和退出语义仍由 shared model 或现有 adapter 输出。 | `mainWindowLayout.test` 覆盖 320/393/未就绪宽度和 form/browser 节奏;`devices.settingsButton`、`deviceDetail.newSessionButton`、`automations.createButton` 继续由 `ScreenHeader` action 保持锚点;`settings.backButton`、`deviceDetail.backButton`、`newSession.backButton`、`session.backButton`、`files.backButton`、`automations.backButton` 继续由 `ScreenBackButton` 保持锚点;`settings.screen`、`settings.summary`、`settings.section.*`、`settings.row.*`、`settings.copy.*`、`settings.logoutButton` 加入 Maestro/source anchor;`automations.form.sessionMode*`、`automations.form.boundSession*`、`automations.form.targetSessionInput`、`automations.runSessionDetail`、`automations.runMeta`、`automations.runActions`、`automations.markRunReadButton`、`automations.restartRunButton`、`automations.deleteRunButton`、`automations.runDelete*` 加入 Maestro/source anchor;`devices.filterActions`、`devices.emptyActions`、`deviceDetail.automationActions`、`automations.detailActions`、`automations.emptyActions`、`automations.form.actions`、`automations.delete.actions`、`automations.pause.actions`、`newSession.actions`、`newSession.remoteBrowseActions`、`newSession.remoteBrowsePanelActions`、`newSession.workspaceQuickPick`、`newSession.remoteBrowseEntry`、`newSession.remoteBrowseSelectEntry`、`deviceDetail.statusFilter.*`、`deviceDetail.groupMode.*`、`deviceDetail.sessionRow`、`deviceDetail.automationGroupChild`、`files.locationActions`、`files.pathInputActions`、`files.directoryActions`、`files.previewActions`、`deviceDetail.toolbarActions`、`deviceDetail.selectionHeaderActions`、`deviceDetail.bulkPrimaryActions`、`deviceDetail.bulkDangerActions`、`deviceDetail.bulkConfirmActions` 加入 Maestro anchor;mobile settings 单测、mobile typecheck/unit、Maestro anchor、iOS/Android visual dry-run 继续作为护栏。 |
| C2.10b New session pre-composer | 已完成第一刀 | `NewMakerDraftRoute`, `ChatInput`, `SlashCommandPalette`, `AtMentionPanel` | 新建会话首条消息按“预 composer”处理:shared `composerPalette.ts` 输出 slash/@ 触发、过滤、插入和 @ 序列化;mobile adapter 仅保留 session agentKind 映射。`newSession.ts` 的验证/摘要/预览接受首条 payload 状态,允许文本或附件创建。mobile 新建会话页新增 slash/@ 候选、远程文件附件 chip、路径面板和附件-only 入队,创建成功后仍复用 `buildQueuedTextMessage` 和 input projection。 | shared composer palette test、mobile newSession/composerPalette tests、mobile remote flow smoke 覆盖新建会话附件-only 首条 payload;`newSession.slashPalette`、`newSession.atPalette`、`newSession.attachment*` 加入 source anchor;typecheck、Maestro 静态和后续 iOS visual baseline 继续保护。 |
| C2.10c Home/sidebar parity pass | 进行中 | `CCAgentSidebarUpper`, `PinnedSection`, `ProjectsSection`, `DialogueSection`, `ProjectNode`, `SessionItem`, `VendorIcon`, `formatSidebarTime` | 首页不再作为设备选择页,而是手机承载的桌面左侧会话列表:所有可控电脑的 Projects / Chats / Pinned 直接合并展示;电脑只作为 chip 筛选和 remote origin。session row 保持桌面侧栏语义:左侧 vendor/status/attention,中间一行标题,右侧短时间/少量 badge;project row 保持 chevron、标题、remote origin、新建动作;Relay 成功态、debug 说明、session subtitle/preview/detail 不进主层。`MobileVendorIcon` 直接复用桌面 XD/Codex path,`formatRemoteSessionSidebarTime` 复用桌面侧栏短时间规则。 | 首页截图必须与桌面侧栏源码规则逐项比对;`home.projectRow`、`home.projectSessionRow`、`home.chatRow`、`home.pinnedRow`、`home.deviceChip` 锚点保持稳定;mobile typecheck/unit、Maestro anchor、web smoke、iOS screenshot 和后续 visual baseline 保护。 |
| C2.11 Fork / rewind control polish | 已完成第二刀 | `MessageActionBar`, `RewindPreviewDialog`, `useForkAtMessage` | `rewindPreview.ts` 继续负责 preview payload -> commit-ready state;第二刀新增 `rewindPreviewLayout.ts`,按 screen width + file/action density 输出 container padding、可见文件行数、文件行高度和 40px action 触控尺寸;`RewindPreviewPanel` 使用局部 `RewindActionButton` 统一取消/确认/错误关闭的 pressed/disabled/accessibility 表达。fork/rewind 远程协议、commit 后消息替换和 composer draft 回填不变。 | `rewindPreview.test` + `rewindPreviewLayout.test` 覆盖 preview state 和 320/393/未就绪宽度;`fork_rewind.yaml` 和 Maestro anchor 继续覆盖 `rewind.panel` / `rewind.confirmButton`;typecheck/unit、iOS/Android visual dry-run 保护主路径。 |
| D1 Source parity hardening | C 阶段后 | `NewMakerDraftRoute`, `SessionControlsPanel`, `SchedulerPage`, `WorkdirBrowseRoute`, `MessageActionBar` | 回到 `mobile-desktop-source-inventory.md` 逐项查缺补漏;只补桌面已有语义,不把 V2 协作和完整编辑器插入 V1。 | 每个缺口至少一个 shared fixture、desktop parity、mobile unit 或 E2E flow。 |
| E1 Release gate | D 阶段后 | device-link runner、mock host、Maestro、visual baseline、perf fixture | 先固定 iOS profile;Android 保留不埋坑的 profile/doctor/dry-run,等 iOS 验收后再补同级 baseline。 | 用户复测前脚本给出明确通过/失败原因;Android baseline 在最终 release 前补齐。 |

当前 C 阶段的“停止线”:

- 不再新增只属于 mobile 的业务纯函数;发现新语义先补 `packages/maker-shared`。
- 不再让手机主层展示比桌面同级主层更多的信息;额外说明、debug、成功态、长 meta、预览和高级状态必须进入 sheet/detail/debug surface。
- 不再用近似图标、字符图标或临时图标替代桌面同源图标;自定义图标需要复用桌面 path 或明确加入 mobile icon source。
- 不再放没有真实 handler 的按钮;桌面 hover action 未迁移为手机真实动作前,默认隐藏或进入后续清单。
- 不先做 project automation 高级编辑、share extension、完整 Orca、完整文件编辑器。
- 不因为某个页面“能点通”就算完成;必须有对应的 source parity、fixture、视觉或 E2E 证据。
- 不要求桌面 UI 同步重写,但 shared model 新增时必须标明桌面来源和后续 parity 入口。

## 17. Definition of Done

手机版 V1 只有同时满足以下条件才算完成:

- 手机可以不依赖桌面用户手工操作,完成单会话远程控制闭环。
- 桌面端已有的单会话消息交互语义都有移动端承载或明确安全降级。
- 每个正式主窗口都有桌面来源、手机降噪清单和截图 / baseline 证据;手机主层不展示桌面同级主层没有的信息。
- 协作 / Orca 不完整实现,但遇到相关会话不会崩溃、误导或误操作。
- 所有远程调用都有 typed transport 和错误映射。
- 每个关键交互都有单测或 Maestro/集成 smoke。
- iOS simulator、Android emulator 至少各跑一条完整 smoke。
- 关键 UI 状态有视觉截图基线。
- 性能指标达到 V1 验收线。

# Cindy Mobile Current Execution Plan

> 自动化范围修订（2026-09-27）：手机已移除旧 Scheduler 管理页和 Routines，包括「所有任务」下拉及伙伴资料入口；不再把查看、创建、编辑或运行规则列为手机交付、后续计划或验收项。PC 管理与执行、已有任务数据和运行历史保留。本文所有旧自动化管理实现、原型验证和计划记录仅作历史背景，不代表待恢复功能；当前边界以[伙伴运行时合同](../../../docs/product-rules/cindy-bots-runtime.md)为准。

> 日期: 2026-06-19
> 状态: 当前唯一执行合同。其它 mobile 文档保留源码审计、历史背景和长期能力矩阵。
> 北极星: iOS 优先交付一个桌面同源、信息更少、动作更轻、真实可用的 Cindy 远程会话体验。
> 本次修订: 根据最新走查反馈,把“参考桌面版”升级为硬性验收合同:手机主层只能是桌面主层的触控版,只能更简单,不能更复杂。

## 0. 当前结论

手机版当前阶段不再按“远程控制台”或“移动聊天产品”规划。它的目标只有一个:

**把桌面版 Cindy 的左侧会话列表和会话主窗口投影到手机上,但手机主层只能做减法,不能展示比桌面主层更多的信息。**

这条结论是后续所有 UI、交互和测试的优先级来源:

- 桌面版左侧栏是 Home 的母版。
- 桌面版会话窗口是 Session 的母版。
- 桌面 `ChatInput` 是 Composer 的母版。
- 桌面 `MessageActionBar` 是消息动作的母版。
- 桌面 `WorkGroupBlock` / `AgentActionsBlock` 是工作过程折叠的母版。

凡是找不到桌面主层来源的元素,默认不进手机版主层;确实需要时,只能进入 sheet、full-screen viewer、更多菜单或 debug surface。

进一步收紧为三条不可妥协的判断:

1. **不是远程控制台**:首页不再围绕设备选择、Relay 状态或同步状态组织,而是直接给用户看项目和对话。
2. **不是另一个聊天 App**:会话页不借鉴通用聊天产品新增长按菜单、消息身份标签、额外状态卡或大按钮组;只保留桌面会话窗口已有的交互,并为手机触控缩小主层信息。
3. **不是功能罗列页**:队列、权限、payload、diff、文件、运行参数、计划任务等能力必须先问“桌面主层有没有”,没有就下沉到二级层。

## 1. 产品目标

### 1.1 Home 主窗口

Home 只做桌面左侧会话列表的手机形态。

必须做到:

- 直接展示所有可控电脑上的 Pinned、Projects、Chats、sessions。
- 不要求用户先选电脑。电脑只作为轻量筛选 chip、来源标记和异常上下文。
- 列表行信息量不超过桌面侧栏:标题和桌面同级状态优先;时间、来源、运行状态只有在桌面同级主层也展示时才保留。
- 不展示 Relay 正常态、同步成功态、本地联调说明、调试说明、设备控制台解释。
- 图标、状态和 row action 必须能指回桌面侧栏源码或 shared model。

不做:

- 不把首页做成设备选择器。
- 不把 session row 做成多行信息流。
- 不在首页常驻工具统计、同步细节、连接成功文案和调试入口。

### 1.2 Session 对话窗口

Session 只做桌面会话主窗口的手机形态。

必须做到:

- 主层固定为 Header、消息流、工作过程折叠、消息结束处 action、pending/composer。
- 用户消息不显示“你”,助手消息不显示“Cindy”身份标签。
- 完成态消息正文尽量支持在当前可见文本上直接局部选择和复制。
- 复制、撤销/rewind、分叉保留在消息结束处,而不是改成长按菜单的唯一入口。
- 工作过程收起态只显示桌面同级的一行摘要,如 `已工作 Xs` 或 `工作过程` + 展开箭头;不显示错误/工具/思考/消息等分类 chip。展开后才显示工具、思考、todo 细节。
- payload、diff、文件、queue、controls、runtime options 只进二级 sheet / full-screen,不常驻抢阅读流。

不做:

- 不在收起态显示错误/工具/思考/消息数量 chip。
- 不展示比桌面更多的成功态、解释卡、状态卡、调试卡。
- 不用弹窗文本选择替代当前可见正文上的局部选择。

### 1.3 Composer 输入区

Composer 是桌面 `ChatInput` 的触控版。

必须做到:

- 附件/更多、输入框、语音、发送/停止全部图标化。
- 语音按钮放在发送按钮左侧。
- 发送/停止是最右侧主行动。
- 文字只用于 placeholder、必要错误和不可用原因。
- 可见图标轻量,触控热区通过 `hitSlop` 或不可见外层补足。

不做:

- 不出现“附件 / 语音 / 发送”文字胶囊。
- 不为了触控把桌面轻量 action 做成大按钮组。

## 2. 硬性设计规则

1. **桌面源码优先**
   每个主层元素必须有桌面源码锚点。没有锚点的元素默认删除、下沉或暂缓。

2. **手机只做减法**
   桌面主层没有的信息,手机主层也不能常驻。手机可以换承载方式,不能加信息层级。

3. **先映射,再设计**
   每个窗口开工前先列桌面组件、桌面主层展示字段、桌面二级入口和 mobile 对应承载。没有这张映射表,不进入 UI 实现。

4. **图标同源**
   复制、分叉、撤销、附件、语音、发送、停止、目录、搜索、更多等动作使用桌面同族图标和桌面动作语义。不能用文字按钮、emoji、临时符号或近似图标替代。

5. **视觉轻,触控够**
   可见按钮尺寸按桌面轻量标准;触控面积按手机标准。尤其消息 action:可见 icon 约 14-16px,视觉按钮约 24-28px,命中区域约 40-44px。

6. **阅读优先**
   真正的长会话阅读体验优先于功能入口完整度。任何打断消息阅读的成功态、解释态、调试态默认移出主层。

7. **主层负面清单**
   以下内容默认不能出现在主层:Relay 正常态、同步成功态、本地联调说明、debug copy、设备选择说明、工作过程分类 chip、附件/语音/发送文字按钮、消息身份标签、比桌面更大的消息动作按钮、Issue 表单。

8. **shared core 优先**
   排序、分组、摘要、状态优先级、action availability、pending/queue/control/file/schedule projection 优先进入 `packages/maker-shared`;`apps/mobile` 只做 native shell、触控布局、sheet/full-screen、深链、相机/图片/语音、安全存储和 device-link 生命周期。

## 3. 桌面母版锚点

| 手机区域 | 桌面母版 | 手机主层允许保留 | 手机必须下沉/删除 |
| --- | --- | --- |
| Home | `PinnedSection`, `ProjectsSection`, `DialogueSection`, `ProjectNode`, `SessionItem` | Pinned / Projects / Chats / sessions、桌面同级必要状态、多设备时的轻量筛选。 | Relay 正常态、同步成功态、设备选择说明、单设备常驻 chip、调试文案、比桌面更多的 session metadata。 |
| Session header | `CCAgentSessionView`, `SessionContentHeader` | 返回、标题、必要副标题、目录、搜索、更多。 | 设备控制台说明、同步成功说明、额外连接状态。 |
| 消息流 | `MessageStream`, `UserMessage`, `AssistantMessage`, `SystemCard` | 用户/助手正文、必要 system/pending、桌面同级元信息。 | “你”/“Cindy”身份标签、移动端自造解释卡、普通成功态卡。 |
| 工作过程 | `WorkGroupBlock`, `AgentActionsBlock`, `ThinkingCard`, `TodoListCard` | 收起态一行摘要;展开后按桌面顺序显示工具/思考/todo。 | 收起态分类 chip、统计 chip、比桌面更多的工具/错误/消息数量。 |
| 消息动作 | `MessageActionBar` | 消息结束处 copy / rewind / fork 等小图标 action。 | 大号按钮组、只靠长按菜单承载核心动作。 |
| 输入区 | `ChatInput`, `VoiceInputButton`, `SendButton` | 附件/更多、输入框、语音、发送/停止。 | “附件 / 语音 / 发送”文字按钮、额外状态说明行。 |
| 二级能力 | 桌面 right rail / modal / lightbox / panel | queue、controls、payload、diff、file、schedule 只按需打开。 | 主层常驻 payload/debug/control 面板。 |

## 4. 当前阶段范围

当前阶段只做两个主要窗口和一个输入区:Session、Home、Composer。优先级从“用户每天会长时间阅读/输入的面”开始,而不是从能力完整度开始。

### P0.1 Session 主阅读面

目标:把对话页从“粗糙控制台”收敛成桌面会话窗口的手机版本。

实现范围:

- 删除主层中桌面没有的成功态、同步态、联调说明、调试说明、分类 chip 和额外统计。
- 消息正文保持可读,长中文、列表、代码、inline code、文件 chip、媒体摘要都不破坏阅读节奏。
- 完成态正文支持局部选择复制;整条复制按钮只作为兜底。
- copy / rewind / fork 回到消息结束处,尺寸和顺序对齐桌面。
- work group 收起态只保留一行摘要。
- composer 改成图标优先布局。

完成标准:

- iOS 上真实长会话第一屏主要是消息正文,不是状态卡和控制卡。
- 收起态 work group 不显示分类 chip。
- 消息 action 看起来不比桌面更重。
- 底部不再出现“附件 / 语音 / 发送”文字按钮。
- iOS 模拟器或真机能局部选择并复制完成态消息正文。

当前剩余风险:

- 文本选择需要继续用真实长消息验证:必须能在可见正文上进入 iOS 原生局部选择,不能只出现放大镜或只能整条复制。
- 真实长会话里 inline code、列表、文件 chip、代码块、中文长段落的层级还要继续打磨。
- 消息 action 的视觉尺寸需要持续守住“小图标 + 大 hit area”,不能回到大按钮。

### P0.2 Home 左侧栏投影

目标:让首页严格回到桌面侧栏逻辑。

实现范围:

- 合并展示 Pinned / Projects / Chats / sessions。
- 设备只作为筛选和来源,不作为主入口。
- 删除 Relay 正常态、同步成功态、调试说明、本地联调提示。
- row action 只保留桌面同级主层动作;hover 才出现的动作改为长按 / sheet / 更多菜单。

完成标准:

- 首页不再像设备控制台。
- 列表信息量不超过桌面侧栏。
- 所有主层图标和状态都有桌面源码或 shared model 来源。

当前修正方向:

- 如果只有一台可控电脑,首页不常驻设备 chip;多设备时才显示筛选。
- row 不展示桌面侧栏没有的来源、同步、调试和额外状态。
- Projects / Chats 的行高、图标、缩进、折叠关系按桌面侧栏投影,不是按移动端设备列表重新设计。
- 搜索和新建保留为底部主操作,但文案和图标必须对齐桌面动作语义。

### P0.3 二级能力收纳

目标:把必要但不属于主阅读流的能力放到正确层级。

实现范围:

- queue、pending interaction、runtime options、payload、diff、file preview 进入 sheet 或 full-screen。
- issue confirm 只做 desktop-only 降级提示,不做手机版 Issue 表单。
- 协作 / Orca V1 只识别和安全降级,不做完整移动编排。

完成标准:

- 主会话流不常驻 payload/debug/control 信息。
- pending 和 queue 不阻断普通阅读,但需要用户处理时足够明确。
- 二级入口真实可用,没有假按钮。

## 5. 延后范围

这些不进入当前主体验打磨阶段:

- 完整 Orca 协作模式、lead / worker / focus 编排。
- 完整文件编辑器、dirty conflict、远程 reveal/open/exec。
- Scheduler / Routines 管理已移除，不属于延后待做项；PC 功能与已有任务运行历史保留。
- Android 视觉 polish 和真机 baseline。
- 复杂 dashboard、调试控制台、远程设备管理后台。

Android 当前只保留兼容护栏:shared model、协议、布局计算不能写死 iOS-only 假设;等 iOS 主体验过关后再做 Android 视觉和真机调优。

## 6. 下一批执行顺序

1. **会话页降噪**
   对照桌面 `CCAgentSessionView`、`MessageStream`、`WorkGroupBlock`,删除当前 mobile 主层里多余的状态、说明和分类。优先继续修真实长会话阅读层级、正文选择、work group 收起态。

2. **消息动作轻量化**
   对照 `MessageActionBar`,收紧 copy / rewind / fork 的图标、顺序、可见尺寸和触控热区。核心动作继续放在消息结束处,长按菜单只能作为补充,不能替代桌面动作区。

3. **Composer 图标化**
   对照 `ChatInput` / `VoiceInputButton` / `SendButton`,把附件、语音、发送/停止改为桌面同族图标;语音放在发送左侧;主层不再出现“附件 / 语音 / 发送”文字按钮或额外状态说明行。

4. **文本选择专项**
   继续验证 iOS 当前可见正文的局部选择。不能接受“只有放大镜没有选择手柄”,也不能接受“只能弹窗选择”作为最终交互。

5. **真实数据走读**
   接本地真实 Cindy fixture,覆盖长消息、代码块、列表、用户消息、助手消息、工具过程、文件 chip、媒体摘要和继续发送。

6. **首页回归复核**
   Session 过关后回到 Home,按桌面侧栏信息层级删掉剩余多余信息。重点检查单设备 chip、row metadata、Projects / Chats 缩进和图标。

7. **二级 sheet 归位**
   pending、queue、controls、payload、diff、file、schedule 继续按桌面二级层级收纳。第一版不做协作模式完整移动编排。

## 7. 自动化验收

当前阶段不再依赖用户反复手工点基础回归。每个主窗口批次至少覆盖:

- `packages/maker-shared` unit tests:排序、分组、摘要、action availability、projection。
- `apps/mobile` unit/source guard:桌面源码锚点、降噪规则、图标顺序、触控布局。
- `apps/mobile` negative guard:主层不得出现负面清单里的多余 copy、分类 chip、大号动作按钮和文字按钮。
- `pnpm --filter mobile typecheck`。
- `pnpm --filter mobile test:web-smoke`。
- `pnpm --filter mobile test:e2e:maestro:check`。
- iOS Simulator Maestro smoke:Home、Session、Composer、文本选择、发送/停止。
- iOS screenshot / visual baseline:首页、对话页、composer、work group 展开/收起。
- 真实 device-link smoke:本地 mock host + 真实 Cindy DB fixture。

涉及视觉的批次必须留下截图证据,并和桌面同状态源码或截图对照。通过标准不是“能点通”,而是“信息量不超过桌面、动作不比桌面更重、真实消息读起来顺”。

## 8. 每次改动前的检查问题

1. 这个元素来自桌面哪个组件或 shared model?
2. 它在桌面是主层常驻,还是 hover / tooltip / 右栏 / modal 才出现?
3. 手机是否显示了桌面同级主层没有的信息?
4. 如果显示更多,这是触控必须,还是应该删除或下沉?
5. 图标、动作顺序、disabled state 是否和桌面语义一致?
6. 是否新增了 mobile-only 业务判断?如果有,为什么不能进 shared core?
7. iOS 上真实消息是否能阅读、局部选择复制、输入、发送/停止?

## 9. 文档分工

| 文档 | 用途 |
| --- | --- |
| `mobile-current-execution-plan.md` | 当前唯一执行合同。 |
| `mobile-v1-source-plan.md` | 源码审计、长期能力矩阵和历史计划背景。 |
| `mobile-desktop-source-inventory.md` | 按桌面源码入口维护功能矩阵。 |
| `shared-core-migration-plan.md` | shared core 边界、迁移顺序和跨端 fixture 规则。 |
| `remote-control-plan.md` | 已完成实现、联调命令和历史阶段记录。 |

# Cindy Mobile Remote Control Plan

> 版本: 2026-06-16
> 范围: 手机版作为 `device-link` 控制端,远程连接同账号电脑,控制电脑上的 Cindy。
> 分支前提: 手机版工作基于 `feat/device-link-remote-control`;该分支已经实现远程连接必需的桌面端、服务端和 `device-link` 基础能力。
> 当前基线: `codex/mobile-device-link` 已 fast-forward 到 `feat/device-link-remote-control` HEAD `d04e654d0`。
> 基线: 以桌面版现有源码语义为准,只针对手机触控、窄屏、后台/前台切换做交互优化。
> 最近修订: 2026-06-18 原型已跑通基础链路后,开发重点从继续堆功能调整为 shared core 收口、移动端 UI/交互重构和自动化质量门禁;当前 iOS 优先验收,Android 保持兼容护栏但不阻塞 iOS polish。最新产品口径改为“桌面端交互是唯一源头,手机端只做触控适配和信息减法”:手机版不能比桌面端显示更多状态、分类、表单或说明,新增入口必须先能回指到桌面端源码事实。本轮进一步收紧为“首页对齐桌面左侧会话列表,会话页对齐桌面消息流和输入区,所有移动端额外信息默认删除或下沉”。
> 范围修订: 桌面端 `/issue` / `submit_github_issue` 的 Issue Confirm 是反馈提交链路,不是手机版远控 V1 主功能。mobile 只保留 `issue_confirm` 协议识别和“回到电脑端处理”的安全兜底,不提供 GitHub Issue 编辑/提交表单,也不纳入 V1 视觉基线和主流程 E2E。

补充文档:

- [desktop-interaction-audit.md](./desktop-interaction-audit.md) 逐项盘点桌面端消息流、输入器、pending interaction、计划、文件页、选项卡和协作模式源码语义。
- [mobile-desktop-source-inventory.md](./mobile-desktop-source-inventory.md) 将桌面源码行为转成手机版功能矩阵、V1/V1B/V2 边界和验收条件。
- [mobile-v1-source-plan.md](./mobile-v1-source-plan.md) 把桌面源码事实转成手机版 V1 实现计划、边界和自动化验收清单。
- [shared-core-migration-plan.md](./shared-core-migration-plan.md) 记录 shared core 架构边界、迁移顺序和跨端 fixture 测试门槛。

## 1. 结论

手机版不要重做一套产品逻辑。正确架构是:

- **桌面端交互是唯一产品源头**:每个手机端入口、状态、按钮、图标、文案和信息层级都必须能回指到桌面端现有组件/状态机/IPC 语义;没有桌面来源的移动端新增设计默认不做。
- **手机端只能更简单,不能更复杂**:同一桌面语义搬到手机时允许压缩、折叠、放进 sheet/full-screen route、改成图标或减少常驻信息;不允许额外增加桌面端没有的分类 chip、解释卡、调试字段、状态摘要、设备选择前置流程或二级确认流程。
- **手机版信息量不得超过桌面版**:如果桌面端左侧/会话页没有常驻展示某个细节,手机端也不应常驻展示;确实需要保留的细节必须藏进展开、详情或调试面板。
- **图标和动作语义跟桌面端对齐**:复制、分叉、撤销、附件/目录、语音、发送、停止等动作优先使用桌面端同族 lucide 图标和同样语义顺序;能用图标表达的主控不再使用文字按钮。触控热区可以为手机放大,但视觉尺寸不能因此变成比桌面更重的按钮。
- 继续沿用 `feat/device-link-remote-control` 已有能力,手机版主要补移动端控制面、触控交互和自动化测试。
- 桌面端继续作为被控端和数据真相源:会话、消息、队列、权限、计划、文件、自动化都留在电脑端。
- 手机端作为原生控制壳:通过 `device-link` 订阅、读取、发送和 resolve interaction,本地只保留 UI 状态、短期缓存、草稿和 iOS / Android 原生安全存储。
- 可共享的业务展示语义沉到 `packages/maker-shared`:session/message normalize/render model、pending interaction model、queue/input projection model、session controls/runtime options、device-link transport contract、file browser model、automation/schedule model。
- UI 不强行共享组件。桌面端和手机版共享同一份展示模型和测试 fixture,再分别渲染成桌面布局或手机触控布局。
- 远程会话行为必须对齐桌面版:同一条消息、同一个 pending interaction、同一个 queue 操作,手机和桌面看到的是同一个状态。
- 第一版不做协作模式 / Orca 的手机完整操作面,但要能识别并安全显示相关会话,不能因为遇到协作会话崩溃。

第一版目标从“补齐所有能远程调用的功能”调整为“把桌面端主要会话体验做成合格的手机控制面”。功能优先级必须服从信息架构和交互质量。

第一版建议定义为两个连续里程碑:

- V1A: 桌面左侧会话列表 + 单会话控制体验完整可用。首页直接按桌面侧边栏逻辑展示所有可控电脑的会话,不先让用户选择电脑,不额外拆出桌面端没有的 Projects / Chats / Relay 信息层;会话页包含消息流、发送/停止/排队、权限确认、Ask User、Plan Review、基础会话管理;`issue_confirm` 只做桌面端处理提示。
- V1B: 非协作的桌面附属能力以“按需进入详情”的方式补齐。包含 diff/媒体/上下文用量、fork/rewind、模型/权限/fast mode、自动化 schedules 的查看和基础管理;所有附属能力默认不增加主会话页常驻信息。

协作模式 / Orca 单独做 V2,因为它不是单会话控制,而是 Lead + Worker + focus + split/toggle pane 的多会话编排,移动端需要重新设计。

### 1.1 原型跑通后的计划修订

当前手机版已经验证了登录/模拟登录、device-link 连接、设备发现、会话列表、会话详情、发送、队列、pending interaction、媒体、文件预览和自动化的基本链路。问题不再是“能不能连起来”,而是当前实现仍然像功能堆叠的工程原型:UI 信息层级粗、交互入口散、状态表达不稳定,并且多处手机端展示的信息比桌面端更多。后续目标不是继续加入口,而是按桌面端交互做减法和收口。

后续开发计划需要按下面顺序更新:

1. **桌面源码复核先于 UI 设计**:每个页面先找到桌面端对应组件和真实交互,手机端只决定“保留、折叠、放入 sheet、放入 full-screen route、移到 debug surface 或不做”。
2. **Shared core 收口先于继续加 UI**:凡是 session/message、pending interaction、queue/input、session controls、file browser、automation/schedule、device-link contract 这类可用纯对象表达的语义,先迁到 `packages/maker-shared`,mobile 只保留 native shell、navigation、touch UI 和 device-link 生命周期。
3. **移动端 UI 重新按桌面信息架构整理**:首页对齐桌面左侧会话列表,直接展示所有可继续操作的会话;会话详情对齐桌面会话页主阅读流;Automations、Files、Settings 只保留桌面端已有概念的移动承载。调试、本地联调和 mock login 入口只能留在 dev/debug surface。
4. **会话页做一次完整减法重构**:固定 header + message list + bottom interaction/composer 是主干;connection、queue、session controls、payload、diff、context/cost、file preview 只有在需要时进入 sheet/full-screen route,不在页面里常驻堆卡片。
5. **视觉规范按桌面 `docs/design-rules/cindy-design-system.md` 统一**:整体保持黑白灰、无阴影、12px container radius、pill-shaped interactive control、克制字重和层级。React Native 不强制复用桌面组件,但颜色、层级、spacing、图标、状态表达必须可回指到桌面 token / lucide icon 语义。
6. **自动化测试作为每次交付门槛**:用户不再手工承担回归。每次阶段交付至少跑 shared build/test、mobile typecheck/unit、web smoke、Maestro 静态检查、local full check-only;有 Maestro CLI 和固定模拟器时再跑 native flow 和 visual baseline。

### 1.2 本轮意见后的目标重校准

这轮反馈把手机版目标进一步收窄:手机版不是“远程设备控制台”,也不是“桌面信息的移动增强版”,而是**桌面左侧会话列表 + 桌面会话页 + 桌面输入区**的原生触控承载。所有改动先问是否更接近桌面版;如果只是手机端看起来“信息更完整”,但桌面端没有这个层级,就应该删除、折叠或下沉。

新的 V1 成功标准:

1. **首页像桌面左侧栏,不是设备页**:默认只展示可继续操作的会话列表,按桌面侧边栏的信息层级和排序来组织;电脑只作为轻量筛选/归属信息,不作为第一步选择路径。不要常驻 Relay 连接、设备调试、项目/聊天二次分类、等待数量 badge 等桌面左侧栏没有的信息。
2. **会话页像桌面会话主流,不是控制台**:顶部只保留返回、标题、必要上下文和桌面同源动作;中间是消息流;底部是 pending interaction 或 composer。队列、控制项、payload、diff、媒体、文件、context/cost 进入 sheet/full-screen route,不在主流堆卡片。
3. **消息行为对齐桌面且更轻**:复制、分叉、撤销等动作回到消息结束位置;图标视觉尺寸按桌面轻量 action bar 处理,手机只放大不可见 hit area。自己发的消息不显示“你/Cindy”之类身份标签。消息正文必须能在可见文本上直接选择和复制;弹窗只能作为平台兜底,不能成为唯一选择路径。
4. **工作过程默认更克制**:`已工作` 折叠态只保留桌面同级摘要,不显示额外分类 chip 或比桌面更详细的统计。展开后按 Work/Tool/Thinking/Todo 的桌面语义展示,不要给手机端新增解释性分类。
5. **输入区图标化**:附件、语音、发送、停止、目录、搜索、更多都使用桌面同族图标。语音放在发送左侧;文字只保留 placeholder、必要错误和不可用原因。附件面板可以有说明,但默认入口不能是大号文字按钮。
6. **Android 不阻塞,但不能埋坑**:当前 iOS 先验收视觉和交互质量;实现层不写死 iOS-only 安全区、app id、URL scheme、状态栏高度或 WebView 行为。Android 后续用同一 shared model 和同一自动化入口补 baseline。

实现顺序也相应调整:

| 顺序 | 目标 | 实现方式 | 验收条件 |
| --- | --- | --- | --- |
| 1 | 桌面左侧栏复刻审计 | 重新读桌面侧边栏/会话列表源码,列出手机首页允许显示的字段、排序、分组、图标和动作;删除无法回指桌面的首页信息。 | 首页截图与桌面左侧栏相比只少不多;不存在前置设备选择路径。 |
| 2 | 首页重构为会话列表 | `packages/maker-shared` 输出 desktop-sidebar-like list model;mobile 只负责横向设备 filter、空态、搜索和新会话入口。 | Unit fixture 覆盖多电脑、多会话、离线设备、空态;web/native smoke 可直接从首页进会话。 |
| 3 | 会话消息流减法 | 重排 header/message/action/composer;删除主流上的额外状态卡、分类 chip、说明文字和过大的动作按钮。 | 主会话页常驻信息不超过桌面;复制/分叉/撤销在消息结束处,视觉轻、触控可达。 |
| 4 | 可见文本直接选择 | 对完成态 user/assistant message 使用可直接选择的正文渲染路径;streaming 时避免 WebView 频繁重建。 | iOS 模拟器和真机至少有一条长消息能拖选部分文本;失败时保留 copy action 但必须继续修直接选择。 |
| 5 | Composer 桌面化 | 输入区改成 icon-first:附件/语音/发送/停止/更多按桌面语义排布;附件 picker 内再展开相册、拍照、文件、远程路径。 | iPhone SE 宽度不挤压;语音在发送左侧;按钮不出现“附件/语音/发送”大文字。 |
| 6 | Sheet/detail 收口 | queue、controls、pending、payload/diff/media/file/context/cost 统一进 sheet/full-screen,主会话页只保留必要入口。 | 打开/关闭 sheet 不卸载消息列表,不产生空白帧;每个 sheet 有 desktop source 和 shared fixture。 |
| 7 | 自动化回归 | 将首页、会话消息、composer、文本选择、queue/pending/payload 五类场景纳入固定 smoke/visual baseline。 | 用户不需要手工回归基础流程;失败输出截图、日志和具体锚点。 |

近期里程碑改为:

| 顺序 | 状态 | 里程碑 | 交付内容 | 验收 |
| --- | --- | --- | --- | --- |
| A | 已完成第一轮 | Shared core completion pass | automation/schedule model、device-link controller contract、shared fixture baseline、raw desktop-like message parity、schedule/file raw payload parity 已迁;保留 mobile re-export 兼容。 | `@cindy/maker-shared` build/test;mobile adapter 测试全绿;desktop parity 单测覆盖 schedule/file;shared 不依赖 RN/Electron/DOM。 |
| B | iOS baseline 已完成 | Mobile IA and shell baseline | RN primitives、Session Action Strip、会话页 chrome/main/bottom 层级、Queue/Search/Controls sheet、Usage 直达入口、debug/local path 分离、pending bottom surface、payload full-screen viewer shell 已完成;Session 六态 visual scenario / Maestro flow / baseline checker 已落地;payload modal 已补 `visual_session_payload.yaml` flow,Settings 已进入 `visual_smoke.yaml` 截图 flow。 | `ios-iphone-17-pro-expo-go` 下 12 张截图基线已接受并通过 hash 校验,包括设备列表、Settings、设备详情、会话、控制面板、payload full-screen viewer 和 idle/running/pending/queue/offline/revoked;revoked flow 已真实等待到“访问已撤销”。Android 当前只保留 profile/脚本护栏,不阻塞 iOS 高标准 polish。 |
| C | 当前进行 | Home and session desktop-first polish | 在视觉基线保护下先修首页和会话页:首页回到桌面左侧会话列表;会话页重做消息层级、消息动作、可见文本选择、composer、pending、payload/diff/media/file viewer、context/cost、queue/controls 的触控节奏。所有手机端额外统计、说明和调试信息先默认删除或收进详情。新展示语义先进入 shared model,手机只做承载。 | 首页常驻信息不超过桌面左侧栏;长消息可直接选择复制;消息动作在消息结束处且视觉轻量;composer icon-first;长消息、长工具、大 diff、媒体、键盘、sheet 打开/关闭在 iPhone SE 宽度无重叠、无空白帧、消息列表不被卸载。 |
| D | C 后收口 | Desktop parity pruning and hardening | 回到桌面源码矩阵,逐项补 new session、media/file、automations、fork/rewind、settings 的细节缺口;同时删除或下沉手机端比桌面端更多的状态表达。协作模式继续只读安全降级。 | 每个缺口必须有桌面来源、shared model 判断、mobile 承载说明和 unit / E2E / parity fixture 中至少一层验证;每个新增 UI 必须说明为什么没有让手机端更复杂。 |
| E | 发布前 | Release-grade test and tuning | iOS profile 先固定 native flow、visual baseline、reconnect、1000 message/session、性能和残留进程清理;Android 在最终 release 前补同级 baseline 和 smoke。 | 本地 orchestrator 一键跑;失败输出日志、截图、profile、mock host/relay 线索和残留进程检查结果。 |

阶段 gate:

- B4 的 iOS 固定 profile 已经可以作为 UI polish 的回归门禁。Android baseline 等 iOS 高标准验收后再采集;当前只要求所有新增代码不写死 iOS-only 假设。
- C 阶段每改一个会话页展示语义,先判断是否需要 `packages/maker-shared` 新模型;message normalize content preview / stable sort / tool_use parse / tool_result pairing、payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection、message visual、message window / scroll anchor、message search/load-earlier action、capability projection 和 scheduler event projection 第一刀已迁入 shared。后续优先做 iOS 视觉/触控细节和失败态调优,只有出现新的跨端语义再增量抽 shared。
- D 阶段只补桌面源码矩阵里明确存在的 parity 缺口,不把 Orca V2、worktree 创建、native share extension 混进 V1 收口。
- E 阶段才把双平台 native profile 和性能门禁提升为发布阻断;在此之前 web smoke / Maestro 静态 / local full check-only 是每次交付的最低门槛。

### 1.3 更新后的执行口径

从现在开始,开发计划不再按“哪个功能还没堆上去”推进,而按“桌面源码语义 -> 信息减法判断 -> shared model -> 手机触控承载 -> 自动化验证”推进。每个新任务都必须在实现前回答五件事:

1. **桌面来源**:对应桌面源码里的哪个组件、hook、store 或 IPC 语义;图标、按钮顺序、常驻信息层级也要能回指到桌面端。
2. **减法判断**:桌面端是否常驻展示这项信息?手机端是否可以删除、不做、折叠、移入 sheet/full-screen route 或仅放 dev/debug surface?如果手机端展示的信息比桌面端更多,默认打回。
3. **共享模型**:这个语义是否能沉到 `packages/maker-shared`;如果能,先补 shared model 和 fixture,再做移动端渲染。
4. **手机承载**:在手机上是首页列表、会话主流、bottom composer、stack、sheet、full-screen route、临时 toast 还是 dev/debug surface;不能因为手机屏幕小而增加桌面端不存在的解释卡、状态行或确认流程。
5. **验证方式**:用 shared unit、mobile adapter unit、desktop parity、web smoke、Maestro/native flow、visual baseline 或性能 fixture 中的哪几层锁住。

硬性 UI gate:

- **首页不是设备选择器**:手机版首页按桌面左侧栏逻辑直接展示所有可继续操作的会话;设备只作为筛选、轻量归属或调试上下文出现,不是正式路径第一步。Relay 连接、设备等待数、项目/聊天二次分类等信息不能常驻。
- **会话页不堆控制台信息**:主会话页只保留 header、消息流、消息动作、pending/queue 必要入口和底部输入器;连接、队列、控制项、payload、diff、媒体、文件、context/cost 默认进入 sheet 或详情页。
- **消息正文必须可见处直接选择**:完成态消息的正文要能在当前可见文本上拖选并复制。长按菜单、复制整条消息或弹窗只能作为兜底,不能替代直接选中文本。
- **能用图标就不用文字按钮**:附件、语音、发送、停止、复制、分叉、撤销、目录、搜索、更多等动作使用桌面同族图标;语音在发送左侧;文字只用于输入 placeholder、必要状态和不可用原因。
- **调试入口不进正式用户路径**:mock login、本地联调、fixture 切换、protocol debug 只保留在 dev/debug panel,不进入首页、会话主流或正式设置页。

因此下一轮不应该先补大功能,而应该先完成移动端产品化骨架:

- **正式路径**:Home(Desktop Sidebar Session List) -> Session Detail -> New Session -> Automations -> Files -> Settings;Devices 只作为 filter/debug/connection context,除非用户明确需要进入设备详情。
- **辅助面板**:queue、session controls、pending interaction、payload、diff、media、file preview、context/cost 统一进入 sheet 或 full-screen route。
- **调试路径**:mock login、本地联调、fixture 切换、protocol debug 只保留在 dev/debug panel,不进入正式用户操作路径。
- **视觉基线**:先锁首页列表、会话消息流、底部 composer、pending/queue、payload/detail 五类状态,再扩到自动化和文件页。

### 1.4 2026-06-18 当前执行快照

计划需要继续更新,因为我们已经从“证明链路可行”进入“产品化重构”阶段。当前执行口径如下:

| 分类 | 当前状态 | 下一步实现方式 | 验收门槛 |
| --- | --- | --- | --- |
| Shared core | 第一轮完成:queue、queue row action、device list presentation、session controls、session action strip/identity、session list / bulk selection、agent capabilities、pending interaction、pending resolve guard、message normalize content preview / stable sort / tool pairing、message render、message presentation、message window/search/load-earlier action、file browser/preview、automation/schedule/event、device-link contract 和 shared fixtures 已迁入 `packages/maker-shared`;C1 payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection 和 message presentation 第一刀已完成并接入 mobile;C2 session operation/composer action、queue row guard、pending resolve guard、device list、session action strip、session list / selection 和 scheduler event projection 第一刀已完成;C2.5 已补远端不可用 read-only composer / disabled reason。 | 后续 keyboard/native visual check 只在发现新的通用状态优先级、disabled reason、payload body layout 或跨端 action 语义时继续增量抽取。 | shared build/test + mobile adapter test + desktop parity fixture。 |
| Mobile shell | 第四刀完成:RN primitives、Session Action Strip、`session.chrome` / `session.mainLayer` / `session.bottomLayer`、Queue sheet、Search sheet、Usage 直达入口、登录页 debug surface、pending bottom surface、payload full-screen viewer shell;B4 visual flow/checker 已补并在 iOS Expo Go profile 接受;C2.5 iOS visual baseline 已稳定通过;C2.8 已收紧会话 chrome/action strip padding、action pill 宽度和提示卡高度,并新增平台无关 `sessionChromeLayout.ts` 锁住 iPhone SE/现代 iPhone 宽度下的五入口布局和极窄 overflow 信号;C1 payload viewer header 已新增平台无关 `payloadHeaderLayout.ts`,复制/打开/关闭/图库翻页在 320/360/393 宽度下不会挤压标题,并用局部 `PayloadHeaderActionButton` 统一 header 动作反馈;C1 payload body 已新增局部 `PayloadActionButton`,远程媒体、文件预览、diff 当前文件和路径复制动作在同一触控层级表达;C1 message content 已新增局部 `MessageContentOpenButton`,媒体、文件、diff、tool result 和 Mermaid source 打开详情动作共享同一个触控 owner;C1 message action bar 已增强 `messageActions.ts`,copy/more/fork/rewind 使用 36px 可触达 pill 并按小屏/多动作压缩宽度;C1 message auxiliary 已新增 `MessageListActionButton` / `TodoActionButton` / `TodoSheetBackdrop` / `ImageZoomControlButton`,加载更早、新消息、Todo sheet 和图片缩放动作都有 disabled/pressed accessibility 表达;C1 foldable header 已新增 `FoldableHeaderButton`,Work/Tool/Todo/Thinking 折叠头有统一 pressed/expanded accessibility 表达;C2 composer 已增强 `composerTouchLayout.ts`,附件快捷动作、远程路径行和 composer padding 在 320/384/393 宽度下有单测保护;C2 queue row 已新增 `queueTouchLayout.ts`,五动作行在 320/393 宽度下保持 36px 触控目标和 compact gap,并用局部 `QueueTouchButton` 统一 queue sheet 内 resume/retry/clear/edit/save/move/steer/remove/toggle 动作表达;C2 controls sheet 已新增 `sessionControlsTouchLayout.ts`,overview/tabs/input/actions/remote-dir browser 在 320/393 宽度下有触控布局保护,并用局部 `ControlActionButton` 统一 sheet 内动作 tone/active/disabled/pressed 表达,第三刀补齐 inline 入口、section tabs、远程目录进入行和连接 banner sync 的 action primitive / accessibility state;C2 pending interaction 已新增 `interactionTouchLayout.ts`,permission/ask/plan/issue 动作行、Ask 输入行、queue preview chip 和 plan preview 高度在 320/393 宽度下有布局保护,并用局部 `InteractionTouchButton` 统一 wizard 内 Ask/Plan/Issue 动作的 pressed/disabled/selected accessibility 表达;C2 fork/rewind 已新增 `rewindPreviewLayout.ts`,preview 面板在小屏限制文件行数并保持 40px 动作触控高度;offline/read-only action copy 优先级已锁住;附件 picker、相册/拍照、本机文件上传和语音录制/转写已完成首版。 | 接下来先做 desktop-first 信息减法:首页从设备详情入口退回桌面左侧栏模型,会话页删掉或下沉手机端额外状态/说明/统计;再做 iOS 真机/模拟器上的高标准 UI polish 和延迟/失败态调优。Android 保持 profile/脚本护栏,等 iOS 验收后再采集 baseline。 | web smoke、Maestro anchor、首页列表与桌面左侧栏信息层级一致、主会话页常驻信息不超过桌面版、iPhone SE 宽度无挤压、payload header 窄屏无挤压、message content open actions、message action bar 可触达、composer 附件面板窄屏无挤压、queue 五动作行、controls sheet 和 pending interaction 主要按钮不出现过小触控目标、fork/rewind preview 动作可触达、消息列表不因打开 sheet 被卸载、`ios-iphone-17-pro-expo-go` visual baseline hash 通过;Android 不写死 iOS-only app id、URL、状态栏裁剪或安全区假设。 |
| Session UX | pending interaction 已从主消息层移到底部 interaction surface;idle/running/pending/queue/offline/revoked 六态已有 mock scenario、native flow 和截图 baseline;revoked 状态已显示“访问已撤销”;C1 payload/message polish 已进入第三刀,payload header、payload body action、message content open action、message auxiliary action、foldable header 和 message action bar 窄屏布局有单测/锚点保护;C2 composer 附件面板布局已进入第二刀;queue row action、controls sheet 和 pending interaction touch layout 已有 unit 保护;payload header、queue sheet、controls sheet、connection sync 与 pending wizard 内部动作已统一到局部 action primitive。 | 按桌面会话页重排消息流和 bottom composer:消息动作回到消息结束位置,图标尺寸/语义对齐桌面;已工作内容收起时不显示额外分类 chip;附件、语音、发送、停止优先用图标。pending、queue、controls、payload 只在需要时进入 sheet/full-screen route;新增状态先补 shared/mobile fixture。 | Session 六态截图 baseline 文件可校验;payload header、payload path actions、message content open actions、message action bar、message auxiliary actions、foldable headers、composer 附件面板、queue 五动作行、controls sheet、connection banner 和 pending interaction 窄屏无挤压;主消息流不出现桌面端没有的常驻统计/说明卡;后续 polish 不改 baseline 必须解释。 |
| Debug/local test | 第二刀完成:正式登录页只保留 Feishu 主路径和轻量 `login.debugButton`;mock login、callback URL 和本地联调说明已进入 `login.devPanel` modal;Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback 兜底和 Web 关闭入口统一使用 `MainWindowActionButton`。 | 后续如果增加 fixture 切换或 protocol debug,继续放进 dev/debug surface,不回到正式路径。 | `login.devLoginButton` 自动化锚点保留;Maestro 静态、web smoke 和 local full check-only 已通过。 |
| 自动化回归 | 单测、web smoke、Maestro 静态、mock host local preflight 已能覆盖大部分回归;已补 iOS/Android profile resolver 防止后续误用平台参数;payload modal 已进入 visual flow suite。 | 当前固定 iOS native flow 和 visual baseline;payload full-screen viewer 已进入默认 hash baseline。Android 先用 profile dry-run / doctor / 脚本入口护栏,实际截图基线等 iOS 验收后补。 | 用户复测前由脚本给出通过/失败原因,不再把手工点测当主回归。 |

### 1.5 当前优先级重排

按最新产品口径,后续执行顺序调整为:

1. **首页 / 会话列表**:以桌面左侧列表为标准,直接聚合所有可继续操作的会话;桌面端确实存在的 pinned、分组、归档、日期或项目上下文只能按桌面同等层级表达,不能在手机上新增 Projects / Chats / Relay 等额外栏目。设备只做筛选和在线状态,不再作为“先选电脑再选会话”的主路径。
2. **会话详情主阅读流**:优先打磨真实消息阅读、滚动、复制、分叉、撤销、加载更早和长文本选择;消息动作放在消息结束位置,尺寸比当前更克制,不引入桌面端没有的消息标签。
3. **底部输入器**:对齐桌面 `ChatInput` 的语义,附件、语音、发送、停止用图标;输入框是主入口,额外状态只在异常或处理中出现。
4. **Pending / Queue / Controls**:全部作为辅助 sheet 或 full-screen route,不在主会话页常驻展开;只显示当前决策必须的信息。
5. **Payload / Diff / Media / File**:按需打开详情,主消息流只放可识别的轻量预览和入口。
6. **Automations / Files / Settings**:作为二级能力补齐桌面已有语义,不抢首页和会话页优先级。
7. **Android**:iOS 先跑到可验收质量;所有代码保持平台中立,不写死 iOS-only app id、safe area、深链或模拟器行为。

这个优先级意味着接下来每轮实现都先问:这件事是否让首页或会话页更像桌面版、更少信息、更好操作。答案不是“是”的功能,排到后面。

本轮补充:会话详情 route 层已新增 `RouteActionButton` / `SheetBackdropButton`,把 composer、搜索、未同步状态、历史消息切换和 settings/queue/search backdrop 的触控反馈与 accessibility state 收敛到同一 mobile shell primitive。该改动只统一手机承载层,不改变 shared composer/search/window/session operation 模型或远程协议。

本轮补充 2:`MobilePrimitives.tsx` 新增 `MainWindowOptionButton` / `MainWindowRowButton`,并补齐 `MainWindowActionButton` active/disabled accessibility state;设备详情和新建会话的高频筛选、分组、列表行、最近项目、运行选项和远程目录行已接入统一 mobile shell primitive,不改变会话列表筛选、创建参数或远程目录 browse 协议。

本轮补充 3:文件页路径面包屑/文件行和自动化页 segment/schedule row 继续接入 `MainWindowOptionButton` / `MainWindowRowButton`,主窗口的 option、breadcrumb、row 选中态和展开态先统一到 mobile shell primitive。该改动不改变 file browser / schedule shared model,也不改变远程文件读取或 schedule 写入协议。

本轮补充 4:`MobilePrimitives.tsx` 新增 `MainWindowCardButton`,并把设备列表行、自动化删除单选、模板刷新、模板卡片和 boolean toggle 接入主窗口 primitive。该改动只统一 pressed、selected、checked、disabled 和 accessibility state,不改变设备可见性、schedule 删除策略、模板参数或写入序列化。

本轮补充 5:`MainWindowActionButton` 新增 busy state,`ConnectionBanner` 的重新同步按钮改为消费同一 action primitive。该入口横跨设备、会话、新建、文件和自动化主路径;改动只统一 loading spinner、disabled/busy accessibility 和 pressed 表达,不改变连接错误映射、重订阅或远程同步调用。

本轮补充 6:登录页的 Feishu 登录、debug entry、dev modal 关闭、mock 登录、callback URL 兜底和 Web 关闭入口统一接入 `MainWindowActionButton`;透明 debug modal backdrop 仍保留为背景命中区。该改动不改变 OAuth、mock login、callback 解析或本地联调路径,只收口可见登录动作的触控和 accessibility 表达。

本轮补充 7:`ScreenHeader` 右侧 action 已统一使用 compact `MainWindowActionButton`,并移除旧 `PillButton` 分支。设备列表退出、设备详情新会话和自动化新建等一级窗口头部动作继续保留原 testID / onPress / 路由语义,只统一 pressed、disabled、busy、tone 和 accessibility 表达。

本轮补充 8:会话详情 route action 第二刀补齐 `ActionPill` 的 selected/disabled accessibility state,并把 queue/search sheet header 关闭入口接入 `RouteActionButton`。队列关闭、搜索关闭、队列模型和搜索模型语义不变,只统一核心会话窗口的 sheet 关闭触控和 accessibility 表达。

本轮补充 9:queue/controls 状态 polish 已补齐 `QueueTouchButton` busy accessibility state 和 `ControlActionButton` selected/disabled accessibility state。远程队列同步、运行设置写入、queue projection 和 controls overview 语义不变,只让手机版在同步中/选中/禁用状态下的触控表达更准确。

本轮补充 10:`RouteActionButton` 现在会在 busy 期间停止接收 press / long-press / press-out,避免发送、附件、语音、同步和 pending resolve 在处理中重复触发。该改动只作用于 mobile route 触控层,不改变 shared composer/pending model 或任何远程调用协议。

本轮补充 11:`InteractionTouchButton` 现在也会在 busy 期间停止接收 press,覆盖权限确认、Ask、Plan review 和 Issue confirm 的 pending interaction 局部动作。shared model 继续负责 disabled reason、提交中 label 和 requestId 去重;mobile shell 只统一触控防重复和 accessibility state。

本轮补充 12:`MessageContentOpenButton` 和 `PayloadActionButton` 已补 disabled accessibility state,让消息里的打开详情动作和 payload body 里的远程媒体/文件预览/路径复制动作在不可用时对辅助技术也保持一致。该改动不改变 payload 构造、远程读取、复制路径或任何 Maestro 锚点。

本轮补充 13:`MainWindowActionButton` / `MainWindowOptionButton` / `MainWindowRowButton` / `MainWindowCardButton` 会把缺少 handler 的入口统一当作 disabled,避免主窗口出现“看起来可点但没有动作”的入口。该改动只作用于 mobile primitive 的触控和 accessibility 状态,不改变设备、会话、新建、文件、自动化和登录的业务逻辑或锚点。

本轮补充 14:`MainWindowMetric` 作为可点击统计筛选入口时会暴露 selected accessibility state,覆盖设备详情 summary、自动化 summary 和新建会话 summary 的统计入口。该改动只补选中态表达,不改变 metric 数值、筛选逻辑、导航或锚点。

本轮补充 15:`ActionPill` 和会话详情 `RouteActionButton` 现在也会把缺少 handler 的入口当作 disabled,避免 action strip 或 route action 出现“没有动作但看起来可点”的状态。该改动不改变 settings/files/search/queue/search sheet/composer/sync 的业务语义、远程调用或锚点。

本轮补充 16:`ControlActionButton` 现在会把缺少 handler 的入口当作 disabled,避免 controls sheet 动作出现“可点但无动作”的状态。该改动不改变 rename/pin/archive/delete/model/effort/permission/fast/extraDirs/context 的远程协议、capability projection 或锚点。

本轮补充 17:composer 输入框和附件移除状态已回到 shared `buildSessionComposerLayout` 输出,发送中会锁定输入、语音入口和附件调整,附件处理中会锁定附件入口与移除动作。移动端只消费 `composerLayout.input` / `composerLayout.attachment.remove` 渲染原生输入区和附件 chip,不再在页面里分散维护这组状态;enqueue、附件上传、语音转写和 device-link 协议不变。

本轮补充 18:`ScreenHeader` 左侧返回按钮已从裸 `Pressable` 收敛成内部 `ScreenBackButton`,主窗口 header 的返回入口现在也具备统一 pressed / disabled / accessibility state。该改动不改变返回箭头视觉、`deviceDetail.backButton` / `session.backButton` / `files.backButton` 等锚点,也不改变 `router.back()` 行为。

本轮补充 19:自动化表单的 fresh / persistent / bound 运行会话三态已进入 shared `scheduleForm.ts`,mobile 只消费共享模型渲染“新会话 / 持续 / 绑定”、当前设备会话选项和 ID 输入兜底。绑定态会隐藏项目目录、worktree 和 Fast 等由绑定会话决定的控件,并用 pending 占位防止“点了绑定但还没选会话”被误判成 fresh;该改动不改变 schedule channel、模板创建、run history 或删除策略。

本轮补充 20:自动化列表/详情的运行会话可见性已进入 shared `scheduleModel.ts`,mobile 只渲染 `summarizeSchedule` 输出的 `runSessionLabel` / `runSessionDetail`。列表 detail 现在能看到“新会话 / 持续会话 / 绑定会话”,详情页新增 `automations.runSessionDetail` 锚点显示持续/绑定的目标会话摘要;该改动不改变 schedule 排序、run grouping、写入、暂停、删除或打开会话语义。

本轮补充 21:自动化运行历史的耗时和会话摘要已进入 shared `scheduleModel.ts`,mobile 只渲染 `summarizeRun` 输出的 meta、session short label 和打开会话 label。运行行新增 `automations.runMeta` 锚点,显示“已运行/耗时 + 会话短标识/未创建会话/可重新执行”;这一刀只补摘要,不扩大单条 run 远程操作。

本轮补充 22:自动化运行历史动作闭环已对齐桌面 `RunHistoryCard` / `RunHistoryPane`:普通 terminal run 可标已读和删除,无 session 的 interrupted/aborted run 可重跑,running 和 legacy session run 的限制由 shared `summarizeRun` 输出。mobile 新增统一 `automations.runActions` 行内动作区和 `automations.runDelete*` 删除确认卡;transport、shared contract、mock host 和 smoke fixtures 补齐 `maker:schedule:delete-run`。

本轮补充 23:新建会话入口按 `NewMakerDraftRoute` + `ChatInput` 的预 composer 模型收口。shared `composerPalette.ts` 统一 slash/@ trigger、过滤、插入和 @ 序列化;mobile 新建会话页新增 slash/@ 候选、远程文件附件 chip 和路径面板,首条消息验证从“必须有文本”改为“文本或附件 payload”,创建后仍复用 `buildQueuedTextMessage` / input projection,不新增发送协议。

本轮补充 24:Settings 从设备列表头部的“退出”补丁升级成独立主窗口。Devices 右侧入口改为 `devices.settingsButton`,`/settings` 统一展示账号、手机设备名、Relay 状态、调试信息和退出登录;手机设备名由 `device-link/mobileDeviceIdentity.ts` 输出,被 DeviceLink hello 和 Settings 共用,避免协议上报与 UI 展示出现两个事实源。被控权限开关、撤销和恢复仍留在电脑端设置,手机只作为控制端。

本轮补充 25:System Card 不再作为 mobile 私有展示逻辑维护。shared `systemCard.ts` 统一 `/help`、`/context`、`/cost`、`/pwd`、`/status`、桌面 `/compact`、`/cmd` 卡片 presentation,context usage 详情也迁入 shared `sessionControls.ts`;mobile 只做本地 slash 命令注入和 RN 卡片渲染。这保证会话消息主窗口里的系统卡和后续桌面 parity fixture 可以对同一模型验收。

## 2. 桌面端源码基线

这次盘点以这些源码为主要依据:

- 远程设备镜像:
  - `apps/desktop/src/renderer/features/device-link/useDeviceLinkRemoteProjects.ts`
  - `apps/desktop/src/renderer/features/device-link/remoteProjectsStore.ts`
  - `apps/desktop/src/renderer/features/device-link/refreshRemoteSessions.ts`
- 远程会话同步:
  - `apps/desktop/src/renderer/features/cc-agent/hooks/useRemoteSessionConnection.ts`
  - `apps/desktop/src/renderer/features/cc-agent/hooks/useRemoteSessionSync.ts`
  - `apps/desktop/src/renderer/features/cc-agent/RemoteSessionBanner.tsx`
- 远程传输层:
  - `apps/desktop/src/renderer/lib/makerTransport.ts`
- 会话主页面:
  - `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`
- 消息流:
  - `apps/desktop/src/renderer/components/chat/MessageStream.tsx`
  - `apps/desktop/src/renderer/components/chat/UserMessage.tsx`
  - `apps/desktop/src/renderer/components/chat/AssistantMessage.tsx`
  - `apps/desktop/src/renderer/components/chat/AgentActionsBlock.tsx`
  - `apps/desktop/src/renderer/components/chat/AgentActionRow.tsx`
  - `apps/desktop/src/renderer/components/chat/ThinkingCard.tsx`
  - `apps/desktop/src/renderer/components/chat/WorkGroupBlock.tsx`
  - `apps/desktop/src/renderer/components/chat/TodoListCard.tsx`
  - `apps/desktop/src/renderer/components/chat/SystemCard.tsx`
  - `apps/desktop/src/renderer/components/chat/MessageActionBar.tsx`
- 输入和 pending interaction:
  - `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`
  - `apps/desktop/src/renderer/components/new-chat/PendingQueuePanel.tsx`
  - `apps/desktop/src/renderer/components/new-chat/PermissionPrompt.tsx`
  - `apps/desktop/src/renderer/components/new-chat/AskUserQuestionPrompt.tsx`
  - `apps/desktop/src/renderer/components/new-chat/PlanViewerCard.tsx`
  - `apps/desktop/src/renderer/components/new-chat/PlanActionCard.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/IssueConfirmCard.tsx`
- 媒体和 lightbox:
  - `apps/desktop/src/renderer/components/chat/ChatImageView.tsx`
  - `apps/desktop/src/renderer/components/chat/ChatVideoView.tsx`
  - `apps/desktop/src/renderer/components/chat/ChatAudioCard.tsx`
  - `apps/desktop/src/renderer/components/chat/ToolPayloadLightbox.tsx`
- 自动化:
  - `apps/desktop/src/renderer/features/scheduler/SchedulerPage.tsx`
  - `apps/desktop/src/renderer/features/scheduler/components/TaskListPane.tsx`
  - `apps/desktop/src/renderer/features/scheduler/components/ScheduleFormDialog.tsx`
- 协作模式:
  - `apps/desktop/src/renderer/components/new-chat/ExtraDirsButton.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/OrcaWorkflowRoute.tsx`
  - `apps/desktop/src/renderer/features/cc-agent/CreateWorkerPopover.tsx`

### 2.1 桌面源码到手机版实现矩阵

这张矩阵是后续开发的对齐表。手机版不直接复用桌面 React DOM 组件,但每个模块的语义都必须从对应桌面源码迁移过来。

| 模块 | 桌面源码事实 | 手机版实现方式 | 自动化验证 |
|---|---|---|---|
| 设备发现和可控性 | `useDeviceLinkRemoteProjects` 判断同账号、在线、非本机、`remoteControlEnabled`;访问撤销通过 `ACCESS_REVOKED` / `link-close('revoked')` 进入 `revokedDevicesStore`。 | `DeviceLinkContext` 保留所有同账号设备,按可控/运行中/离线/未开启/本机/已撤销分类;不可控设备可见但不可进入。 | `deviceStatus` / `accessRevoked` 单测;本地三端 smoke 断言关闭远控、下线、撤销后 UI 状态不同。 |
| 远程会话列表 | `remoteProjectsStore` 是控制端内存镜像,不写本地 SQLite;`sessions` topic 先订阅再 bootstrap;`sessions:created` 无 row,只触发 reseed。 | `remoteSessionStore` 按 `deviceId` 分片,`sessionId -> deviceId` 建索引;列表页只订阅 `sessions`;push patch 幂等合并,created 触发 refresh。 | store snapshot/patch/reseed/乱序回放单测;手机列表和桌面新建/改名/归档/删除同步 E2E。 |
| 打开会话重订阅 | `useRemoteSessionSync` 打开会话才订阅 `session:<id>`;WS online、presence online、turn end、window focus、手动 resync 触发 reconcile。 | 会话页进入时 `openLink + subscribe(session:<id>) + getSession + getPendingInteractions + getProjection`;退出时 unsubscribe;App foreground 走同样 rehydrate。 | `rehydrateDeviceLinkTopics` 单测;reconnect Maestro flow;server relay E2E 覆盖 push 后补账。 |
| 远程传输层 | `makerTransport.ts` 通过 `getSessionDeviceId(sessionId)` 路由本地 IPC 或 `deviceLink.invoke`。 | 手机版所有远程调用进入 `mobileMakerTransport`;页面组件禁止直接拼 channel;channel drift 由测试锁定。 | `mobileMakerTransport.test` 断言 channel、参数顺序、错误码保留。 |
| 侧边栏/会话列表 | `CCAgentSidebarUpper` + sections 支持 pinned、dialogue、projects、date grouped、archived/all、search、batch、automation group、schedule unread。 | V1 用 `SectionList` 实现设备/置顶/对话/项目分组,已补搜索、archived/all、project/date 切换、长按选择模式和批量归档/删除;同一 schedule 的自动化生成会话已聚合成组行,并显示 running/unread run。筛选、搜索、分组、自动化聚合、列表上下文/空状态和批量操作 patch projection 已迁入 `@cindy/maker-shared/session-list` 与 `session-selection`,mobile 只保留 RN 列表、确认卡、远程 patch 调用和刷新。 | shared + mobile 分组/选择单测;1000 session fixture;E2E 覆盖搜索、置顶、归档、批量操作、切筛选。 |
| 新建会话 | `NewMakerDraftRoute` 远程 device-link 路径调用 `maker:create-session`;`deviceLinkCreateArgs` 负责 workspace、agent、extraDirs 归一;首条消息再走 input queue。桌面本地对话由 main/localDb 分配 `userData/dialogues/<date>/<sessionId>` cwd。 | `/sessions/new` 已支持项目/对话工作区切换、手动远程项目路径、远端目录浏览、最近项目 quick pick、extra dirs、agent/model/effort/permission/fast 和首条消息;运行设置已通过被控端 `maker:get-capabilities` 纠正 model/effort/permission/fast 组合;对话模式不让手机端猜路径,由被控桌面端 `maker:create-session` 分配真实 cwd。会话 composer 已补附件、slash、@ 和语音首版;worktree 创建继续后补。协议仍是 create session 后 enqueue first message。 | `newSession.test` 覆盖 project/dialogue create args、defaults、recent workspaces、extra dirs、无 effort 模型参数省略;`agentCapabilities.test` 覆盖 capability 纠偏;桌面 `sessionRequest/sessionCreateHandler` 覆盖 dialogue cwd 分配;`mobileMakerTransport` 和 smoke 覆盖 `fs:list-dir` 参数形态;E2E 覆盖新建后桌面侧出现会话并收到首条消息。 |
| 会话 Header | `SessionContentHeader` 管 title、pin、schedule badge、deep link、SDK id、archive/delete、right sidebar;远程会话只显示远端路径,不本机 open。 | 手机顶部只放返回、设备、标题、状态;`SessionControlsPanel` 已承载 rename/pin/archive/delete/copy deep link/copy XDT id/copy SDK id/model/effort/permission/fast/context/spend,删除需要二次确认;controls sheet 的 overview、tabs、输入行、按钮和远程目录 browser 已用 `sessionControlsTouchLayout.ts` 做窄屏触控布局,动作按钮统一由局部 `ControlActionButton` 表达,inline 入口 / section tabs / 远程目录进入行补齐 expanded / selected / disabled accessibility state。 | header/control source anchors + smoke 覆盖;`sessionLinks.test` 锁定 deep link 格式;`sessionControlsTouchLayout.test` 锁定 320/393/未就绪宽度。 |
| 连接状态 | `RemoteSessionBanner` 区分 disconnected、host offline、not connected、remote disabled、access revoked,支持 resync。 | 顶部固定连接 banner,错误保留 code;resync 执行重订阅、消息 reconcile、pending interaction 和列表 refresh;重新同步按钮用 busy-aware `MainWindowActionButton` 表达 loading/disabled/busy state。 | remote error formatting 单测;relay 断开/电脑关闭远控/撤权 E2E。 |
| 消息 render pipeline | `MessageStream.buildRenderItems` 将 raw messages 变成 `message`、`thinking`、`tool_segment`、`tool_media`、`todo`;`groupWorkRuns` 把最终回答前工作过程折叠为 work group。 | `messageNormalize` + `messageRenderModel` 生成稳定 render item;UI 只消费结构化 item;Work/Tool/Thinking/Todo 默认折叠,按 session + blockId 记忆展开。 | fixture 覆盖 user/assistant/system/thinking/tool/todo/work/media/orphan result;快照锁 stable keys。 |
| 消息滚动和分页 | 桌面初始最近窗口、顶部 expand/load more、scroll anchor、near-bottom auto-follow、new message indicator、prev user jump、focus search hit。 | 移动端用 `FlatList` 窗口化;最近 80 条首屏;上拉加载更早并保持锚点;离底显示“新消息”;已支持当前窗口内消息搜索、上一条/下一条定位、焦点高亮和显式加载更早继续搜索。自动无限扩窗不作为默认行为,避免手机端误拉大量历史。 | 1000 message 性能测试;滚动锚点/搜索模型单测;E2E 截图检测无跳空白。 |
| User Message | `UserMessage` 支持文本、附件、链接、Orca 通信、action bar: time/copy/fork/rewind。 | 右侧气泡 + Markdown-lite + 轻量动作行;附件只读展示;copy/time/fork/rewind 顺序对齐桌面语义,fork/rewind 用桌面协议,不走路由大参数传长文本。 | fork/rewind/copy smoke;附件 parser 单测。 |
| Assistant Message | `AssistantMessage` + `MarkdownRenderer` 支持 streaming、代码、表格、Mermaid、diff、链接、图片、action bar、turn cost。 | 左侧消息;V1 已支持 paragraph/list/code/fence/link/table、Mermaid WebView 图表预览 + 源码详情、bold/em/code/strike inline、copy/fork/time/cost;turn cost 已从历史 `agentMeta` 和实时 `usage:message-turn-cost` push 双路径接入;diff payload 已可全屏结构化查看,包含文件头、统计、多段 Edit 和旧/新横向对照。 | markdown fixture;stream append 不闪烁测试。 |
| Thinking | `ThinkingCard` 有 streaming duration、final duration、redacted、aborted,默认折叠。 | 一行折叠卡,点开 inline 或 sheet;redacted/aborted 保留状态。 | thinking state fixture。 |
| Tool / Agent Actions | `AgentActionsBlock` 合并连续 tool;`AgentActionRow` 按 Bash/Read/Edit/Write/MultiEdit/media/diff 显示;payload 用 lightbox。 | 工具组默认折叠;摘要显示工具数和状态;Bash/JSON/diff 截断,点开全屏;手机不提供本机 reveal,改为复制路径/请求电脑打开(后续需安全确认)。 | tool result pairing、hide result、diff/media parser 单测;payload modal E2E。 |
| Todo | `TodoListCard` 显示 completed/total、三态、collapsed progress。 | 默认 collapsed,有 in_progress 时自动展开一次;保持 completed/pending/in_progress 三态。 | TodoWrite fixture。 |
| System Cards | `SystemCard` 承载 `/help`、`/cost`、`/context`、`/pwd`、`/status`、compact/cmd。 | V1 已支持手机端本地 `/help`、`/context`、`/cost`、`/pwd`、`/status` system card;`/context` 已显示桌面同形的 categories、MCP tools、memory files、agents、skills、slash commands、message breakdown、API usage 扁平详情;compact/cmd 仍待协议侧事件。 | system card fixture。 |
| 媒体 | `ChatImageView` / `ChatVideoView` / `ChatAudioCard` 依赖 Electron protocol 和 `useRemoteMediaUrl`;gallery 覆盖全会话图片。 | 手机端用 `device-link:media:fetch` + `/api/device-link/media/presign-get` 复刻 Electron protocol 后面的 OSS 取件链路;图片详情内联预览并提供 100% / 150% / 200% / 300% 缩放控制,视频/音频已通过 WebView 内嵌播放器打开并回传 loaded/playing/paused/waiting/ended/error 状态,关闭详情、切换媒体源或 App 进入后台时会向播放器发送暂停命令,并释放 OSS 中转对象;图片详情已支持当前消息窗口 gallery 上一张/下一张,更多历史图片通过加载更早扩窗后进入 gallery;mock host 已提供 direct image + xdt-video + xdt-audio fixture,并有 `media_smoke.yaml` 覆盖图片详情和缩放。后续补真实 OSS 对象播放 fixture 和更完整真机调优。 | `remoteMedia.test` + `mediaPlayerWebView.test` + `messageGallery.test` + `imageZoom.test` + `media_smoke.yaml` + `mobileRemoteFlowSmoke` 覆盖取件编排、播放器 HTML / 状态消息、图片 gallery 收集、缩放档位和 mock 媒体消息;后续补真实 OSS 视频/音频对象和滚动性能。 |
| Composer | `ChatInput` 用 TipTap,支持文本、附件、语音、slash、@、模型/effort/permission/fast、extraDirs、folder picker、协作开关、draft store。 | V1 已支持 text + queue、slash agent command/skill palette、`@` 文件/目录/agent 资源选择;控制项放 session controls panel;已有会话 extraDirs 热更新也放在 controls panel,由被控端校验并回流最终有效目录;附件已支持输入被控电脑文件路径、选择本机文件、相册多选图片和拍照图片,全部复用 presign-put / OSS PUT / `cindy-oss-attach://` 链路;图片附件会写入桌面兼容的 `persistedContent.images[]` / `chatMessage.images`;语音已接 `expo-audio` 原生录音、取消录音、OSS 中转、`device-link:voice:transcribe`、被控桌面 voice-input batch ASR,转写文本只插入 draft,不自动发送。worktree 继续后补。draft 按 `sessionId` 本地保存。 | `composerPalette.test` 覆盖 slash/@ 触发、排序、插入和 mention 序列化;`attachments.test` / `mobileAttachmentUpload.test` / `mobileImageAttachment.test` / `mobileVoiceInput.test` / `inputProjection.test` 覆盖远程路径附件、手机上传 OSS 引用、图片 picker 元数据、语音上传转写编排、取消录音状态、图片/文件持久化分流、队列投影;transport/smoke 覆盖远程 list commands / scan resources / set extraDirs / voice transcribe 回流。 |
| Queue | `PendingQueuePanel` 是 FIFO;4 条内全显,5+ 折叠前三条;Stop 只暂停 drain;编辑/拖拽有 lock;Orca queue 不能编辑/steer。 | 手机已支持查看、编辑、删除、上移/下移、继续/暂停、插话、重试/清除错误;上/下移动沿用桌面 `moveQueueItem` 的“移除前插入位置”协议并禁用越界按钮;编辑行会同步 `maker:input:set-edit-lock` 防止被控端自动 drain 正在编辑的行;`queueTouchLayout.ts` 按屏宽和动作密度输出 36px 触控目标、compact gap、按钮宽度和容器 padding;drag 排序 V1B;Orca origin 只读。 | queueModel 单测;`queueTouchLayout.test` 覆盖 320/393/未就绪宽度;enqueue/stop/resume/edit/move/remove/steer smoke。 |
| Permission | `PermissionPrompt` 展示 tool title/description/input;allow once、always allow session、deny;always 只接收 session scoped suggestions。 | 阻塞卡片/底部面板;高风险字段必须可见;decision serialization 对齐 `{ behavior, updatedPermissions, decisionClassification }`。 | interactionModel 单测;permission E2E。 |
| Ask User | `AskUserQuestionPrompt` 多步 wizard;single-click advance;multi-select JSON array string;skip 空字符串;draft 跨 session 保留。 | 底部全屏 wizard;单选、多选、自定义、跳过、返回、提交;草稿按 `sessionId + requestId` 保存。 | ask serialization 和 draft 单测;多问题 E2E。 |
| Plan Review | `PlanViewerCard` expanded/half/minimized/edit;outline 从 Markdown heading 提取;批准或反馈通过 `PlanActionCard`;编辑会写回 plan file。 | V1 plan review:半屏/全屏高度切换、全文预览、Markdown h1-h3 目录跳转、编辑、approve、feedback,批准回传 `editedPlan`。 | plan decision / outline 单测;编辑后 approve E2E。 |
| Issue Confirm | `IssueConfirmCard` 属于桌面端 `/issue` 反馈提交确认。 | 手机版 V1 不提供 Issue 编辑/提交表单;遇到 `issue_confirm` 只显示“请回到桌面端处理”的 unsupported card。 | shared 协议兼容单测;不纳入 mobile 主流程 E2E。 |
| 会话控制 | `ChatInput` model/effort/permission/fast/extraDirs 是 server-first;远程会话 await 隧道 setX,被控端 patch 回流为真相;跨厂商切换有历史兼容确认。 | 手机 `SessionControlsPanel` 不做乐观最终态;调用 setX 后等待 sessions patch;已通过被控端 `maker:get-capabilities` 渲染模型、effort、permission 和 fast 支持状态;已有历史消息且模型类别不兼容时会先显示跨厂商确认卡;Claude 项目会话支持 extraDirs 文本编辑,提交后以被控端校验结果为准;触控布局由 `sessionControlsTouchLayout.ts` 根据屏宽和控件密度输出,controls sheet 动作由局部 `ControlActionButton` 统一 tone/active/disabled/pressed,inline 入口、section tabs 和远程目录进入行分别由局部 primitive 承载 pressed / expanded / selected / disabled state,Android 后续复用同一模型。 | set model/effort/permission/fast/extraDirs 回流 smoke;能力列表 mock;`sessionControlsTouchLayout.test` 覆盖 320/393/未就绪宽度和 dense controls。 |
| Fork / Rewind | `MessageActionBar` + `useForkAtMessage` + `RewindPreviewDialog`;首条 user 不显示 rewind;commit 后用被控端快照替换。 | 消息动作行;fork 成功 upsert 并跳转;rewind preview 显示风险,commit 后替换消息并回填 composer draft。`rewindPreviewLayout.ts` 按屏宽控制 preview 面板 padding、可见文件行数和 40px action 触控高度,`RewindActionButton` 统一取消/确认/关闭反馈。 | fork/rewind 单测和 smoke;`rewindPreviewLayout.test` 覆盖 320/393/未就绪宽度。 |
| 自动化 | `SchedulerPage` 是 master-detail;`TaskListPane` 按 workingDir/dialogue 分组;active 包含 expired;`RunHistoryPane` 折叠同 session runs;`ScheduleFormDialog` 包含模板、fresh/persistent/bound、project automation。 | V1B 已做任务列表/详情/runs/run now/pause/resume/delete/mark read/open session、新建/编辑普通 schedule、模板创建、生成会话删除三选项;fresh/persistent/bound 运行会话编辑第一刀已对齐桌面状态机;project automation 完整编辑后续继续对齐桌面。 | scheduleModel/remote event/form 单测;Maestro run now/pause/open session/create-edit flow。 |
| 远程设置 | `ControlThisMacPanel` / `ControllableDevicesPanel` / `RemoteControlSection` 管本机允许被控、可控设备、撤销/重命名。 | 手机 Settings 显示登录、当前手机设备名、relay 状态、调试和退出;被控端允许开关仍在电脑端。 | `settings.yaml` + settings model 单测。 |
| 协作 / Orca | `ExtraDirsButton` 的协同模式项、`OrcaSplitView`、`CreateWorkerPopover` 支持 lead/worker split/toggle、worker focus、attention、create/archive/stop;远程 Orca 合并 local + remote sessions。 | V1 只识别 lead/worker 和 worker 通信,只读安全显示,不提供创建/切 focus/停止协作;V2 做手机专属 lead/worker toggle pane。 | V1 Orca fixture 不崩;V2 另建 E2E。 |

Worktree 补充:

- 桌面 `NewMakerDraftRoute` 在 device-link 远程项目路径明确跳过本机 FS worktree 创建;手机版同样不在 V1 加远程创建入口。
- 已完成已有 worktree 会话的只读识别:读取被控端 session row 的 `worktreePath`,会话列表显示 badge、subtitle/search 纳入 worktree 名,会话详情显示 worktree 名称和远端路径。
- 上表早期写到的“后续补 worktree”仅保留为 V2 重新设计项,不属于手机版 V1 的可交付范围。

### 2.2 本次桌面源码复核清单

这轮复核不是按文档猜功能,而是按桌面端实际组件和状态机入口逐项拆交互。后续手机版每补一个功能,都要能回指到这里的桌面源码事实。

| 桌面入口 | 源码事实 | 手机版落地要求 | 第一版范围 |
|---|---|---|---|
| 会话主容器 | `CCAgentSessionView` 的真实布局是 `RemoteSessionBanner` / `MessageStream` / `ErrorBanner` / `UpgradeBanner` / pending interaction / `ChatInput` / `TodaySpendChip` / `TopRightChipStack` / `SessionDiffPanel`;没有另一个“移动端可简化”的并行状态机。 | 手机会话页也必须围绕同一状态顺序组织:连接状态先行,消息流常驻,交互阻塞替换输入区,错误和升级是会话级提示,差异/费用是附属面板。 | V1 做单会话完整闭环;右栏 diff 在手机用全屏面板替代。 |
| 会话 Header | `SessionContentHeaderRegistration` 只在拥有路由的主会话实例挂载;Orca / doc rail 等内嵌实例不注册。 | 手机 Header 不能把内嵌/协作 worker 当普通主会话来做 destructive 操作;详情面板的 rename/pin/archive/delete 只针对当前真实 session。 | V1 已做单会话详情;协作只读提示。 |
| 消息 render item | `MessageStream.buildRenderItems` 先把原始消息变成 `message` / `tool_segment` / `tool_media` / `todo` / `work_group`;连续工具默认折叠,`TodoWrite` 变任务卡,媒体跳出工具折叠块。 | 手机不能直接按 raw message 一条条渲染;必须先 normalizer/render-model,再给 RN 组件消费稳定结构。 | V1 已完成结构化 render;继续补媒体/差异细节。 |
| 滚动窗口 | 桌面首屏只渲染最近 80 个 render item,顶部扩窗,再按需要加载 DB 更早历史;新消息不强拖离底用户。 | 手机必须保留窗口化、anchor、离底新消息 chip,不能因为远程同步直接清空列表。 | V1 继续用 80 条窗口和上拉加载,后续真机像素验证锚点。 |
| 用户消息 | `UserMessage` 展示文本、链接、附件、图片、Orca 通信,并有 action bar: time/copy/rewind/fork。 | 手机右侧气泡动作顺序和行为对齐桌面;附件和 @ chip 是发送内容的一部分,不能只显示纯文本。 | V1 已有 copy/fork/rewind 和附件发送;图片附件按桌面 `images[]` 持久化。 |
| 助手消息 | `AssistantMessage` 使用 `MarkdownRenderer`,完成后 `MessageActionBar` 显示 copy/fork/time/cost。 | 手机左侧消息要支持 streaming 增量、Markdown 基本块、Mermaid、diff、turn cost。 | V1 已覆盖基础 Markdown、Mermaid、turn cost、diff 可读版。 |
| 工具调用 | `AgentActionsBlock` + `AgentActionRow` 按工具名抽摘要;`ToolPayloadLightbox` 看 JSON/diff/完整 payload;媒体由 `extractToolResultMedia` 抽出。 | 手机工具卡默认折叠,摘要可扫读,完整 payload 全屏;复制路径/打开远端媒体要走 device-link 安全通道。 | V1 已有 payload modal 和远程媒体取件首版。 |
| 输入区 | `ChatInput` 是 TipTap editor + 附件 + 语音 + slash + @ + model/effort/permission/fast + extraDirs + folder picker + queue + collaboration toggle。 | 手机不能把输入区只当 textarea;必须拆成触控 composer、资源选择、运行设置面板、队列面板。 | V1 已有 text/queue/slash/@/settings/extraDirs/附件/相册图片/拍照图片/语音首版;share sheet 需要原生 share extension,单独排后续。 |
| 队列 | `PendingQueuePanel` 明确 FIFO、4 条内全显、5+ 折叠前三条;Stop 才拥有 paused;编辑锁只锁单行,拖拽锁全队列;插话不改变队列原始内容。 | 手机队列操作要复用被控端 projection,不要本地乐观改最终态;移动排序必须遵守桌面 move 的 insertion index 语义。 | V1 已有查看/编辑/删除/移动/暂停/继续/插话/error retry;拖拽留 V1B。 |
| Permission | `PermissionPrompt` 展示 title/description/tool input;Allow once、Always allow for session、Deny 的 decision shape 固定;always 只接收 session scoped suggestions。 | 手机卡片必须展示高风险 tool input,不能只给一个“允许”;decision serialization 必须单测。 | V1 已完成。 |
| Ask User | `AskUserQuestionPrompt` 是多步 wizard;单选点击前进、多选 JSON array string、skip 空字符串、draft 跨 session 保留。 | 手机用底部/全屏 wizard,答案编码必须严格一致。 | V1 已完成。 |
| Plan Review | `PlanViewerCard` 有 expanded/half/minimized/edit 四态,outline 从 h1-h3 生成,编辑后由 hook 写回 plan file;`PlanActionCard` 负责 approve/feedback。 | 手机可用半屏/全屏替代桌面四态,但要保留 outline、编辑、approve with `editedPlan`、feedback。 | V1 已完成核心协议和 UI。 |
| Issue Confirm | `IssueConfirmCard` 可编辑 title/body/type,确认结果附 `uiLanguage`,取消是 `{ confirmed: false }`。 | 桌面反馈链路,手机版 V1 不做表单;只识别 `issue_confirm` 并提示回桌面端处理。 | Deferred / desktop-only。 |
| 自动化 | `SchedulerPage` 是 master-detail;切换任务时 RunHistoryPane 不 remount,旧 runs 保留到新数据回来防空白帧;排序是 active/expired 同 rank、paused 下沉、lastFiredAt desc。 | 手机自动化页切换任务也要保留旧数据直到新 runs 到达;排序/筛选/删除生成会话策略照桌面。 | V1B 已完成基础管理和删除三选项;project automation 完整编辑留后续。 |
| 远程设备 | `useDeviceLinkRemoteProjects` 是 subscribe sessions 后 bootstrap,created push 只触发 reseed;不把远程 session 写本地 SQLite。 | 手机只做镜像 store,按设备分片;所有 invoke 经 `mobileMakerTransport`;重连必须 replay topic registry。 | V1 已完成核心镜像和重连。 |
| 协作 / Orca | `CCAgentSessionView` 会自动把 lead 导到 Orca 路由;`ChatInput` 的 collaboration toggle 只负责入口;worker 管理由 `OrcaSplitView` / `CreateWorkerPopover` / `orcaWorkflowsFor` 接管。 | 手机第一版不能半吊子做 split/focus/worker 编排;只识别并安全只读显示。 | V2 独立设计。 |

### 2.3 第一版明确边界

第一版的目标不是“把桌面 UI 缩小”,而是“完整控制一台电脑上的单会话 Cindy”。因此:

- 必做:设备发现、会话列表、新建会话、消息流、发送/停止/队列、pending interactions、会话控制、fork/rewind、context/spend、媒体/diff、基础 automations、断线重连和撤权。
- 必须按桌面源码统一:协议 shape、队列语义、interaction decision、session patch 回流、scheduler 排序和删除策略、远程媒体取件链路。
- 手机优化只允许发生在交互承载层:桌面右栏改全屏面板、hover action 改长按/轻量动作行、master-detail 改 stack、TipTap 复杂 toolbar 改 bottom sheet。
- 暂不做:完整 Orca 协作编排、project automation 完整编辑器、worktree 创建、手机触发被控端升级、请求电脑 reveal/open 的远程执行入口。
- 暂不做不等于忽略:遇到协作会话、project automation、worktree、upgrade/error 时必须可识别、可读、安全退化,不能崩溃或误操作。

## 3. 桌面端远程控制语义

### 3.1 设备和会话真相源

桌面控制端的模式已经很清楚:

- 合格设备 = 同账号 + 在线 + `remoteControlEnabled` + 不是自己。
- 设备变合格后,先订阅 `sessions` topic,再 bootstrap 拉一次 `local-db:sessions:list`。
- 被控端发 `local-db:sessions:patched` 后,控制端只做镜像 patch。
- 被控端发 `local-db:sessions:created` 时没有完整 row,控制端触发 debounce reseed。
- 设备下线、断链、登出、权限撤销时,控制端删除该设备分片。
- 控制端不把远程 session 写进本地 SQLite。

手机版应完全沿用这个语义。当前 `apps/mobile/src/session/remoteSessionStore.ts` 已经有分片、消息、pending interaction、sessionId 到 deviceId 索引,后续要继续往桌面 `remoteProjectsStore` 的语义靠齐。

### 3.2 轻订阅和重订阅

桌面端区分两层订阅:

- 列表层: `sessions`,负责会话列表和会话元信息变化。
- 列表活动: `local-db:sessions:activity` 也走 `sessions`,只带 `{ sessionId, phase, compactDetail }` 级别的 Agent Island 同源摘要,让 Home 行显示执行中的轻量活动;不带 maker event / message / tool payload。
- 会话层: `session:<sessionId>`,负责消息、工具流、pending interaction、Orca worker change 等重 topic。

手机版也要这样做:

- 设备列表页只开 `sessions`。
- 进入某个会话才开 `session:<id>`。
- 退出会话要 unsubscribe。
- App 从后台回前台、WS 重连、设备重新 online、turn 结束、用户下拉刷新时,要 reconcile 最近消息和 pending interactions。

### 3.3 传输层

桌面端 `makerTransport.ts` 的关键点是按 `sessionId -> deviceId` 自动路由:

- 本机会话走 `window.electronAPI.maker` 和本地 DB。
- 远程会话走 `deviceLink.invoke(deviceId, channel, args)`。

手机版本身全是远程控制端,但也要抽一层 `mobileMakerTransport`:

- `send`
- `setModel`
- `setEffort`
- `setPermissionMode`
- `setFastMode`
- `resolveInteraction`
- `getPendingInteractions`
- `fork`
- `rewindPreview`
- `rewindCommit`
- `getContextUsage`
- `setExtraDirs`
- `closeSession`
- `input.enqueue / steer / stop / projection / resume / edit / move / remove / retry`

这样 UI 不直接散落 `link.invoke(...)`,后续补功能不会失控。

## 4. 桌面端交互界面完整盘点

### 4.1 全局信息架构

桌面端主要有这些入口:

- 新建会话: `+ New` / `/cc-agent/new`。
- 会话列表: Pinned、Dialogue、Projects、日期分组、Archived / All。
- 项目文件模式: `/cc-agent/files/:sessionId`。
- 自动化: `/schedules`。
- 设置: 设备、远程控制、登录、模型、协作等。
- 会话主视图: `/cc-agent/:sessionId`。
- 协作主视图: `/cc-agent/orca/:sessionId`。

手机版建议用底部 Tab + Stack:

- `Devices`: 可控制电脑和远程设备状态。
- `Sessions`: 当前可控制会话,默认按设备和项目分组。
- `Automations`: V1B 引入,查看自动化任务和运行记录。
- `Settings`: 登录态、当前手机设备名、调试、退出。

V1A 可以先只有 `Devices/Sessions/Settings`,但路由结构要给 `Automations` 留位置。

### 4.2 侧边栏 / 会话列表

桌面侧边栏能力:

- `+ New` 新建会话。
- Conversation Search,在项目或全局搜索会话。
- Automations 入口,带未读数量,右键可全部标记已读。
- Pinned 会话段。
- Dialogue 会话段。
- Projects 会话段,按项目折叠/展开。
- Date grouped view。
- Filter: status、vendor、project、lastActivity、sortBy、groupBy。
- 多选会话,批量 archive / delete / clear selection。
- project-level archive all。
- schedule 生成会话聚合和未读提示。
- 远程 device-link 会话合并进同一列表,额外带设备标识。
- Doc mode 时侧边栏切换成文件树。

手机版 V1A:

- 会话列表按 `设备 -> 项目 / 对话 -> 会话` 三层展示。
- 每个会话显示 title、agent kind、model、最后活动、运行态、未读/attention、是否 pinned。
- 支持搜索 title / project / last message preview。
- 支持下拉刷新和设备状态横幅。
- 支持置顶、重命名、归档、删除的长按/更多菜单。

手机版 V1B:

- 增加 archived / all filter。
- 增加 project/date 分组切换。
- 已增加自动化生成会话的 schedule binding、running、unread run 提示;同一 schedule 生成多条会话时聚合成一条组行,点开进入 primary session,长按会选择组内全部 session。
- 已增加批量操作:手机端长按会话进入选择模式,支持批量 archive / delete / clear selection,archive 只处理 active 会话并清掉 pinned 状态,delete 跳过已删除会话。

### 4.3 新建会话

桌面新建页能力:

- Vendor segmented switcher: Claude Code / Codex。
- 使用量 dashboard。
- 工作区选择: 对话、项目、其它文件夹、远程项目。
- 远程项目 dialog,支持 SSH remote 和 device-link device。
- Worktree 创建。
- 模型、effort、permission mode、fast mode。
- Extra dirs。
- 附件、图片、@ mention、slash command、语音输入。
- 首条消息 lazy create session。
- 协作模式 toggle。

当前进展:

- 已新增 `/sessions/new` 手机页面,从设备详情页“新建”进入。
- 已接入 `maker:create-session`,复用 `feat/device-link-remote-control` 分支现有 device-link 远程建会话通道,而不是绕开桌面协议自行写库。
- 已按桌面 `deviceLinkCreateArgs` 语义组装 create args:远程项目会话 `workspaceKind` 恒为 `project`,agentKind 归一为 `claude-code` / `codex`,extraDirs 仅非空时透传。
- 已补对话工作区首版:手机端提交 `workspaceKind: dialogue` 且不携带 `workingDir`;被控桌面端 `maker:create-session` 在 main 侧生成 session id 并调用 `ensureDialogueWorkspaceDir` 分配 `userData/dialogues/<date>/<sessionId>` 真实 cwd,再交给 maker-core 启动 agent。
- 已完成“输入被控端项目路径 + agent/model/effort/permission/fast + 首条消息”首版流程:创建会话后 `local-db:sessions:get` 拉取完整 row,upsert 当前设备会话分片,再通过 `maker:input:enqueue` 发送首条消息并跳转会话页。
- 已补最近项目 quick pick:从手机端已有远程会话镜像里按 device / project / last activity 归并最近 workingDir,点选后直接填入新建会话路径,不新增远端目录浏览协议。
- 已补 Extra dirs 首版:多行或逗号输入被控电脑上的附加目录,解析去重后走既有 `extraDirs` create args。
- 已补远端目录浏览首版:手机端通过 `mobileMakerTransport.fs.listDir` 调用被控端 allowlist 内的 `fs:list-dir({path})`,直接使用被控端回传的 native `path` / `parent`,不在手机端拼路径,兼容 macOS / Windows。
- 已用 `newSession.test` 锁定 create args、默认值切换、校验、extra dirs 解析、最近项目归并和 create result 归一;`mobileMakerTransport` 覆盖 `fs:list-dir` / `fs:stat-path` / `fs:mkdir-p` 参数顺序;`mobileRemoteFlowSmoke` 已覆盖 create-session → get-session → upsert → enqueue 首条消息和远端目录列表读取。

手机版 V1A:

- 从某台电脑进入“新建远程会话”。
- 先选工作区: 项目模式支持手动输入路径、最近项目 quick pick、被控端目录浏览;对话模式由被控端分配 Cindy 管理目录。
- 再选 agent、model、effort、permission、fast。
- 输入首条消息后,通过被控端 `maker:create-session` 创建 session,再由手机端 queue coordinator 发送首条消息。桌面 device-link 草稿当前就是这个协议;等被控端支持真正 lazy create 后再收敛。
- 不做 worktree 创建 UI 的复杂分支:桌面 `NewMakerDraftRoute` 在 device-link 远程项目路径也明确跳过 worktree 创建。手机版 V1 只保留已有 session 的 worktree 状态显示,已完成列表 badge、subtitle 搜索和会话详情只读路径。

手机版 V1B:

- 补 Extra dirs。已完成首版文本输入。
- 补图片/文件附件。已完成首版远程路径、本机文件上传、相册多选图片、拍照图片、图片/文件持久化分流;share sheet 入口需要原生扩展,后续单独设计。
- 补 slash command。
- 补 @ mention 资源选择。
- 已补语音输入首版:手机端原生录音上传 OSS,被控桌面端复用 voice-input batch ASR 转写,结果插入当前 draft;首版不自动发送。
- worktree 创建不进 V1;已有 worktree 状态显示已完成。

协作 toggle 不进 V1。

### 4.4 会话 Header

桌面会话 Header 能力:

- 显示 pinned 标识。
- 显示 schedule binding 标识。
- 显示会话标题,双击可重命名。
- 更多菜单:
  - pin / unpin
  - rename
  - copy deep link
  - copy XDT session id
  - copy SDK session id
  - open in new window
  - archive / unarchive
  - delete
- Git context badge。

手机版 V1A:

- 顶部显示返回、设备名、会话标题、运行态。
- 标题点按进入详情页或 bottom sheet,里面做 rename、pin、archive、delete、copy id。
- Git context 用小 badge 显示,点开详情。
- `open in new window` 手机端不需要。

### 4.5 会话连接状态

桌面远程会话状态:

- `local`
- `connected`
- `reconnecting`
- `host-offline`
- `not-connected`
- remote disabled
- channel not allowed
- access revoked

桌面 UI 有 `RemoteSessionBanner`、loading、手动 resync。

手机版 V1A:

- 顶部固定 connection banner。
- 明确区分:
  - 手机到 relay 离线
  - 电脑离线
  - 电脑关闭远程控制
  - 本设备访问被撤销
  - 正在重连 / 正在同步
- 提供“重新同步”按钮,执行: openLink + subscribe session + list recent messages + get pending interactions + refresh sessions。

## 5. 消息流内容显示清单

### 5.1 User Message

桌面显示:

- 右侧气泡。
- 文本、Markdown-ish 内容、链接。
- 附件图片、文件 chip、@ mentioned resource。
- 自动化来源标识。
- Orca 通信特殊 UI。
- Hover action bar: time、copy、rewind、fork。
- 图片 / 文本 lightbox。

手机版 V1A:

- 右侧气泡,显示文本、基础 Markdown、链接。
- 支持复制、fork、rewind 的轻量动作行;动作顺序对齐桌面 `[time][copy][rewind][fork]`。
- 显示相对时间,accessibility label 保留绝对时间。
- 附件先只读展示,上传放 V1B。

手机版 V1B:

- 图片 lightbox。
- 文件 chip。
- @ resource chip。
- 自动化来源。
- rewind preview / commit 完整流程。

### 5.2 Assistant Message

桌面显示:

- 左侧正文。
- Streaming markdown。
- 完成后 action bar: time、copy、fork、turn cost。
- MarkdownRenderer 支持代码块、表格、Mermaid、diff block、链接、图片。

手机版 V1A:

- 左侧消息,支持 streaming 增量合并。
- Markdown 至少支持 paragraph、list、code、code fence、link。已完成 Markdown-lite parser 和 RN 渲染。
- 完成后显示轻量动作行:copy、fork、time、cost;动作顺序对齐桌面 `[copy][fork][time][cost]`。
- 显示相对时间,accessibility label 保留绝对时间。

手机版 V1B:

- turn cost 已支持从桌面 `agentMeta.turnCostUsd` 历史/刷新数据读取,并通过 `usage:message-turn-cost` 转 `session:<id>` topic 实时更新当前会话。
- Mermaid WebView 图表预览和全屏详情已完成;源码仍可在详情里查看。
- diff block。
- 更完整 Markdown 对齐桌面。

### 5.3 Thinking

桌面 `ThinkingCard`:

- 默认折叠。
- streaming 时显示 Thinking + dots + live duration。
- final 时显示 Thought for Xs。
- redacted 显示 Thinking hidden + lock。
- aborted 显示 aborted。

手机版 V1A:

- 默认折叠成一行。
- 点开进入 inline 展开或 bottom sheet。
- 保留 duration、redacted、aborted 状态。

### 5.4 Agent Actions / Tool Calls

桌面:

- 连续 tool_use 合并为 `AgentActionsBlock`,默认折叠。
- `AgentActionRow` 按工具类型显示:
  - Read / Edit / Write / MultiEdit 文件路径 chip。
  - Bash / shell 命令输入和输出。
  - tool_result。
  - diff stats +N / -N。
  - 图像、视频、音频、模型等 tool media。
- `ToolPayloadLightbox` 显示 diff 或 JSON payload。

手机版 V1A:

- Tool block 默认折叠。
- 摘要行显示工具数量、当前/最后工具名、状态。
- 展开后显示每个工具的关键字段和输出 preview。
- Bash 输出、JSON、diff 默认截断,点开 full screen modal。

手机版 V1B:

- 文件 diff viewer。
- copy payload。
- open/reveal 本机文件不适用于手机,改成“复制路径 / 请求电脑打开 / 请求电脑 reveal”。后两项需要新增安全确认,不在 V1A。

### 5.5 Work Group

桌面 `WorkGroupBlock`:

- 把连续 thinking + tool segment 聚成“工作了 Xs”的折叠组。
- 展开组时,子 tool/thinking 一起展开。
- 展开态用 `useExpandedBlockMemory` 记住。

手机版 V1A:

- 直接复用这个交互:默认只显示“工作了 Xs”。
- 点开显示 thinking/tool 子项。
- 展开状态按 session + blockId 本地记忆。

### 5.6 Todo

桌面 `TodoListCard`:

- 显示 completed / total。
- pending / in_progress / completed 三态。
- collapsed 时有 2px progress bar。
- expanded 时显示 todo list。

手机版 V1A:

- 完整支持。
- 手机端高度紧张,默认 collapsed;当前有 in_progress 时可自动展开一次。

### 5.7 System Cards

桌面 `SystemCard`:

- `/help`: commands。
- `/cost`: turn/session cost。
- `/context`: context usage, categories, MCP tools, memory files, skills, slash commands, message breakdown, API usage。
- `/pwd`: working directory。
- `/status`: session / agent status。
- compact / cmd 类型。

手机版 V1A:

- 支持手机端本地 `/help`、`/context`、`/cost`、`/pwd`、`/status` system card。
- `/context` 显示总量、百分比、model、categories、MCP tools、memory files、custom agents、skills、slash commands、message breakdown 和 API usage 扁平详情。
- 其它 slash 不拦截,仍走远程 agent 命令队列。

手机版 V1B:

- cost detail。
- compact / cmd 协议事件。

### 5.8 Media

桌面:

- `ChatImageView`: 用户图 280x180,工具图 `min(50vw, 480px)`;支持 gallery、copy、reveal、3D model lightbox。
- `ChatVideoView`: 封面 + play overlay + video lightbox;本地 copy/reveal。
- `ChatAudioCard`: cover、title、tags、play/pause、progress、scrub、copy description、reveal。
- Sound effect card。
- Missing placeholder。
- 远程媒体通过 `useRemoteMediaUrl` 改写为可取回的远程媒体 URL。

手机版 V1A:

- 图片缩略图 + 全屏预览。
- 视频缩略图 + 全屏播放。
- 音频卡可播放 / 暂停。
- 远程媒体必须走被控端到手机可访问的 relay/OSS URL,不能假设 `xdt-image://` 能在手机打开。

手机版 V1B:

- gallery 左右切换。
- 视频复制/分享。
- 音频 scrub。
- 3D model 预览或下载提示。

### 5.9 Jump / Pagination / Scroll

桌面:

- 初始窗口 80 items。
- 顶部加载更早消息,保持滚动位置。
- 用户不在底部时不强制 auto-scroll。
- JumpToBottomChip。
- NewMessageIndicator。
- PrevMessageJumpChip。
- 搜索跳转 focus message。

手机版 V1A:

- `FlatList` inverted 或普通顺序二选一,但必须支持:
  - 初始最近 80 条。
  - 上拉加载更早消息。
  - 新消息到底部时自动滚动,用户离开底部时显示“新消息”chip。
  - pull-to-resync 不清空当前列表。

## 6. 输入区和控制项清单

### 6.1 Composer

桌面 `ChatInput`:

- TipTap editor。
- 多行文本。
- send / stop。
- pending queue。
- attachments。
- voice input。
- slash command palette。
- @ mention panel。
- model selector。
- permission selector。
- fast mode。
- effort。
- extra dirs。
- folder picker。
- collaboration toggle。
- workdir row。
- spend / context / diff / right sidebar toggles。

手机版 V1A:

- 多行文本输入。
- send / stop。
- queue 状态读取和基础操作。
- slash command palette 首版:读取被控端 agent-builtin 和 agent-skill,并把手机端本地 `/help`、`/context`、`/cost`、`/pwd`、`/status` 放在优先级前列;点选后插入 `/name `。发送时命中本地 system command 会在手机消息流插入本地卡片,其它 slash 仍按远程 agent 命令进队列。
- @ mention panel 首版:通过被控端 `maker:scan-at-resources` 扫描文件、目录和 agent,点选后插入桌面兼容的 `@relPath` / `@relPath/` / `@.claude/agents/name.md`,含空格路径使用 `@"..."`。
- voice input 首版:支持点击开始/停止、长按说话、取消录音和麦克风权限设置跳转;手机端录音上传 OSS,被控桌面端转写,结果插入 draft 且不自动发送。
- model / effort / permission / fast 放到 composer 上方的 session controls bottom sheet。
- workdir 只读显示。
- context/spend 用 header chip 显示。

手机版 V1B:

- attachments。
- voice input 首版已完成;已补取消录音 UI 和麦克风权限设置跳转。后续补语音设置入口和真机延迟调优。
- extra dirs。
- diff panel。

协作 toggle V1 不做。

### 6.2 Pending Queue

桌面 `PendingQueuePanel`:

- FIFO 队列。
- <=4 全显示,5+ 只显示前三条并可展开。
- Stop 暂停队列。
- Continue。
- row edit。
- remove。
- drag reorder。
- steer。
- interaction/edit lock。

手机版 V1A:

- Composer 上方显示“队列 X 条”。
- 点开 bottom sheet:
  - 查看队列。
  - 编辑队列文本。
  - 删除。
  - 上移 / 下移。已按桌面“移除前插入位置”协议实现,首条上移和末条下移直接禁用。
  - 继续 / 暂停。
  - 当前 running 时支持 stop。

手机版 V1B:

- 支持拖拽排序。

## 7. Pending Interaction 清单

### 7.1 Permission

桌面 `PermissionPrompt`:

- 展示工具 title、description、代码块/参数。
- Deny。
- Allow once。
- Always allow for session。
- Enter / Esc / Ctrl+Enter 快捷键。

手机版 V1A:

- 顶部或输入区上方显示阻塞卡片。
- 详情可折叠。
- 操作:
  - 拒绝
  - 允许一次
  - 本会话总是允许
- 允许前要显示 tool name 和高风险字段,不能只有“允许”。

### 7.2 Ask User Question

桌面 `AskUserQuestionPrompt`:

- 作为 wizard 替换 ChatInput。
- 支持 single-select、multi-select、custom input。
- Back。
- Skip。
- Submit。
- minimized / expanded。
- session draft 持久化。

手机版 V1A:

- 用底部面板或全屏表单。
- 支持单选、多选、自定义输入、跳过、提交。
- 多问题时一页一题,顶部显示进度。
- 草稿按 `sessionId + requestId` 暂存。

### 7.3 Plan Review

桌面:

- `PlanViewerCard`: expanded / half / minimized / edit。
- Markdown outline。
- 可编辑 plan markdown,并 debounced 写回 plan file。
- `PlanActionCard`: Approve 或 feedback。

手机版 V1A:

- 收到 plan_review 后进入“计划审核”面板。
- 默认展示计划全文。
- 支持查看全文。
- 支持按 Markdown h1-h3 目录跳转,保持和桌面 `PlanViewerCard` 的 outline 层级一致。
- 支持半屏 / 全屏高度切换,默认半屏,长计划可展开查看或编辑。
- 支持 Approve。
- 支持输入 feedback。
- 支持编辑 plan markdown,批准时通过 `editedPlan` 回传给被控端。

手机版 V1B:

- 后续只做视觉细化,协议和核心交互已完成首版。

### 7.4 Issue Confirm

桌面 `IssueConfirmCard`:

- 提交 GitHub issue 前确认。
- 可编辑 title、body。
- 切换 type: bug / feature。
- 显示环境信息。
- Confirm / Cancel。

手机版 V1A:

- 全屏确认页。
- title/body/type 可编辑。
- 环境信息只读。
- Confirm / Cancel。

### 7.5 Error / Upgrade

桌面:

- `ErrorBanner`: retry、cancel、同步远端 Codex auth、invalid encrypted recovery、budget model hint。
- `UpgradeBanner`: 远端 cc-manager 升级,用户主动触发,升级后可自动 resend in-flight turn。

手机版 V1A:

- Error banner 需要支持 retry / dismiss。
- Codex remote auth missing 先显示“需要在电脑端同步登录态”,手机版不直接推本机 auth。
- Upgrade banner 先只显示“电脑端需要升级/请在电脑端处理”,不在手机端触发升级。

手机版 V1B:

- 如果安全模型确认,再支持手机端触发被控端升级。

## 8. 自动化 Schedules

桌面自动化能力:

- `/schedules` master-detail。
- 左侧任务列表,按工作区分组。
- status filter: active / paused / all。
- 每个任务显示状态、last run、unread run count、cost summary。
- 右侧 run history。
- 新建/编辑 schedule。
- 模板 gallery。
- 参数表单。
- 运行模式: fresh / persistent / bound。
- Agent、model、effort、fast mode。
- project automation: 写 `.cindy/automations/schedules.json`。
- pause / resume / delete / rename / promote to project / clone to user / reload project config。
- schedule 生成的会话会在聊天侧边栏有绑定和未读标识。

手机版 V1B:

- `Automations` tab。
- 查看任务列表、状态、最近运行、未读、累计费用。
- 查看 run history。
- pause / resume。
- delete。
- 手动触发一次。
- 新建/编辑基础 schedule:名称、提示词、手动/周期、cron/间隔、工作区、Agent、model、effort、fast mode、通知。
- 模板 gallery 基础创建:列出被控端模板,选择模板后预填字段和参数,保存走被控端 `maker:schedule:create-from-template`。
- 查看绑定会话并跳转到会话。

手机版 V1 后续:

- project automation 管理。
- 参数化模板编辑增强:复杂 select/boolean 参数、模板分类筛选、模板 prompt 手动编辑后的差异提示。
- fresh / persistent / bound 的完整手机编辑器。

## 9. 协作模式 / Orca 盘点

桌面协作能力:

- `ExtraDirsButton` 的协同模式项:off/on,并打开 Worker 配置。
- Lead session + Worker session。
- `OrcaSplitView`: split 或 toggle layout。
- Worker toolbar:
  - worker list
  - focused worker
  - active worker count
  - create worker
  - switch focus
  - archive worker
  - open collaboration settings
  - maximize / restore pane
  - stop collaboration
- `CreateWorkerPopover`:
  - role
  - agent: Codex / Claude Code
  - model / effort / fast
  - initial task
- worker attention。
- 远程 Orca 通过 `orcaWorkflowsFor(contextSessionId)` 路由到被控端。

V1 处理原则:

- 列表里能识别 Orca lead / worker,显示“协作 Lead / 协作 Worker”标识。已完成。
- 点进 lead / worker 时,先进入普通单会话视图,顶部显示协作只读安全提示。已完成。
- 协作会话在手机端已进入只读安全降级:composer 替换为只读说明,pending interaction 只展示不回传,queue 禁用继续/重试/移动/插话/编辑/删除,session controls 禁用重命名/置顶/归档/删除/模型/权限/fast/extraDirs 写操作,消息 fork/rewind 不展示。
- 如果消息里出现 worker 通信内容,只读展示,不能崩。当前 message normalize/render path 不依赖 Orca 私有 UI,后续还需补专门 fixture。
- 不提供创建 worker、切换 focus、split pane、停止协作。V1 明确不做。

V2 再做:

- 手机版 lead/worker 切换式双 pane。
- Worker 列表和 attention。
- 创建/归档 worker。
- 停止协作。
- 协作设置。

## 10. 手机版实现结构

当前实现结构按 shared core 修订。`apps/mobile` 只放 iOS / Android 原生壳、device-link 生命周期、mobile adapter 和触控 UI;可复用的 session/message render、message presentation、pending interaction、queue/input projection、session controls、file browser、automation/schedule、payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection 等纯模型从 `@cindy/maker-shared` 引入。

建议按这些模块推进:

```text
apps/mobile/src/
  auth/
    LoginScreen.tsx
    authStore.ts
  device-link/
    DeviceLinkContext.tsx
    mobileMakerTransport.ts
    topicRegistry.ts
    remoteRetry.ts
    remoteStatus.ts
  session/
    adapters/
      messageNormalize.ts
      messagePayload.ts
      remoteSessionStore.ts
      sessionControlsAdapter.ts
      interactionAdapter.ts
      queueAdapter.ts
    screens/
      SessionScreen.tsx
      DeviceSessionsScreen.tsx
      NewSessionScreen.tsx
      FilesScreen.tsx
    components/
      MessageList.tsx
      MessageBubble.tsx
      AssistantMessage.tsx
      UserMessage.tsx
      ThinkingBlock.tsx
      ToolBlock.tsx
      WorkGroupBlock.tsx
      TodoCard.tsx
      SystemCard.tsx
      MediaBlock.tsx
      Composer.tsx
      QueueSheet.tsx
      PermissionSheet.tsx
      AskUserSheet.tsx
      PlanReviewSheet.tsx
      IssueConfirmSheet.tsx
  devices/
    DeviceListScreen.tsx
  automations/
    AutomationListScreen.tsx
    AutomationRunsScreen.tsx
  theme/
    tokens.ts
```

关键约束:

- 不直接复用桌面 React DOM 组件。
- 复用桌面 wire protocol 和状态机语义。
- 所有 `deviceLink.invoke` 进入 `mobileMakerTransport`。
- message renderer 先消费 `@cindy/maker-shared` 的 render model;raw desktop payload 只允许在 mobile adapter 层归一,不要在组件里散落 `unknown` 判断。
- pending interaction 的 answer/decision serialization 必须进入 shared core 并有单测锁定;mobile 只负责 sheet / wizard 和本地 draft。
- queue、session controls、file preview、automation/schedule、payload summary/body/preview/tool input diff/summary projection/tool_result media extraction/attachment projection 的排序、摘要、disabled reason、error copy、primary action 等语义先进入 shared core,再由 mobile 渲染。
- 展开态、composer draft、ask draft、queue sheet 状态只存在手机本地。

## 11. 分阶段实施计划

### Phase 0: 把当前骨架收稳

目标: 当前最小联调能力稳定,不再靠人工反复试。

当前进展:

- 已抽出 `mobileMakerTransport`,所有 maker/local-db/input 队列相关远程调用集中在这一层,避免页面组件直接拼 channel。
- 已抽出 `messageNormalize`,按桌面端 `makerChatStore.mapServerMessages` / `MessageStream.buildRenderItems` 的语义恢复移动端可渲染消息:普通 user/assistant、tool_use + tool_result 配对、thinking、answered ask_user、plan_review。
- 已抽出 `rehydrateDeviceLinkTopics`,把前后台/relay 重连后的 openLink、topic subscribe、sessions reseed、session snapshot rebuild 做成可单测的纯流程。
- 已用单测锁定远程 channel 列表、消息排序/去重、工具结果隐藏、交互工具过滤、answered ask_user、thinking/plan_review 恢复、重连订阅恢复。
- 已用 shared raw desktop-like message fixture 锁定移动端 normalize/render parity,覆盖 user/assistant/thinking/tool_result/Edit diff/TodoWrite/Ask/Plan/System/Orca safe-degrade。
- 已用 shared schedule/file raw payload 锁定绑定会话自动化 form 语义、重复 run 折叠、文件列表/stat/preview 降级,并新增 desktop renderer parity test 消费同一 fixture。
- 已加入 `pnpm --filter mobile test:smoke`,用 headless 方式串起设备镜像、设备列表状态、会话分组、历史拉取、发送消息、消息 push、permission resolve、错误 banner 分类,作为不依赖人工点击的本地冒烟。
- 已加入 Maestro native E2E 基础层:
  - `apps/mobile/e2e/maestro/login_mock.yaml`
  - `apps/mobile/e2e/maestro/device_list.yaml`
  - `apps/mobile/e2e/maestro/session_list_controls.yaml`
  - `apps/mobile/e2e/maestro/remote_control_smoke.yaml`
  - `apps/mobile/e2e/maestro/open_session.yaml`
  - `apps/mobile/e2e/maestro/send_message.yaml`
  - `apps/mobile/e2e/maestro/queue.yaml`
  - `apps/mobile/e2e/maestro/permission.yaml`
  - `apps/mobile/e2e/maestro/ask_user.yaml`
  - `apps/mobile/e2e/maestro/plan_review.yaml`
  - `apps/mobile/e2e/maestro/remote_session_smoke.yaml`
  - `pnpm --filter mobile test:e2e:maestro` 调用真实 Maestro CLI。
  - `pnpm --filter mobile test:e2e:doctor` / `test:e2e:doctor:ios` / `test:e2e:doctor:android` 在真实 native flow 前检查 Expo CLI、Maestro CLI、iOS booted simulator、Android adb device、Expo Go URL 和 API base 一致性。
  - `pnpm --filter mobile test:e2e:maestro:check` 在无模拟器/无 Maestro 时先跑 `mobile-scope-guard`,再静态校验 flow 文件和 RN `testID` 锚点;scope guard 会阻止 mobile UI / Maestro / visual baseline 重新引入 desktop-only 的 Issue Confirm 表单。
  - `pnpm --filter mobile test:e2e:local` 作为本地 device-link smoke preflight:检查 local server health、dev-login、device-link REST、可控电脑 presence,条件满足后运行 `remote_session_smoke.yaml`。
  - `pnpm --filter mobile test:e2e:local:fixture` 已接入协议级 mock 被控端:`mock-device-link-host.mjs` 用真实 dev-login + `/api/device-link/ws` 连接本地 relay,以一台开启远控的 Mac 出现在手机设备列表,并响应会话列表、消息、发送、队列、会话控制、自动化基础 channel、远程文件 stat、direct image fixture 和 video/audio/image 取件。
  - 默认 flow 只覆盖 mock login + device list;`remote_session_smoke.yaml` 覆盖打开会话和发送消息。它可跑真实桌面 dev,也可通过 `test:e2e:local:fixture` 跑 mock host。
  - 已新增 `fixture_controls_smoke.yaml` + `pnpm --filter mobile test:e2e:local:controls`:mock host 使用 `controls` 场景,一次制造 pending queue、permission、ask_user、plan_review,并按真实 Maestro 流程验证队列编辑、交互处理和最终继续发送。
  - 已新增 `media_smoke.yaml` + `pnpm --filter mobile test:e2e:local:media`:mock host 在会话里制造 direct image / xdt-video / xdt-audio 媒体消息,Maestro 打开图片 payload 并验证缩放控件。
  - 已新增 `pnpm --filter mobile test:e2e:local:full`:mock host 默认使用 `controls` 场景,把 create、remote session、pending controls、media、file preview、fork/rewind、automations 串进同一个 full flow suite;`--check-only` 可在未安装 Maestro 时验证 local server + relay + mock host preflight。
- 当前验证命令已通过:
  - `pnpm --filter @cindy/maker-shared build`
  - `pnpm --filter @cindy/maker-shared test`
  - `pnpm --filter mobile typecheck`
  - `pnpm --filter mobile test`(63 files / 306 tests)
  - `pnpm --filter desktop test -- src/renderer/__tests__/makerSharedFixtureParity.test.ts`
  - `pnpm --filter mobile test -- src/__tests__/sharedFixtureParity.test.ts`(实际跑完整 mobile suite)
  - `pnpm --filter mobile test -- src/__tests__/sessionList.test.ts src/__tests__/remoteSessionStore.test.ts`(56 files / 249 tests)
  - `pnpm --filter mobile test:web-smoke`(Expo Web route/bundle smoke)
  - `pnpm --filter mobile test:e2e:doctor`(Expo CLI + booted iOS simulator detected;Maestro 缺失为 warning)
  - `pnpm --filter mobile test:e2e:doctor:ios`(预期失败:只缺 Maestro CLI,iOS Simulator 已 booted)
  - `pnpm --filter mobile test:e2e:maestro:check`(scope guard + Maestro flow/static anchor smoke)
  - `pnpm --filter mobile test:e2e:local:file -- --start-server --check-only`(local server + mock host preflight)
  - `pnpm --filter mobile test:e2e:local:full -- --start-server --check-only`(local server + controls mock host preflight)
  - `pnpm --filter mobile test:e2e:local -- --dry-run`(local smoke runner dry run)
  - `pnpm --filter mobile test:e2e:local:fixture -- --dry-run`(mock host fixture dry run)
  - `pnpm --filter @cindy/device-link test`(3 files / 36 tests)
  - `pnpm --filter server exec vitest run src/__tests__/deviceLinkClientRelayE2E.test.ts`(1 file / 8 tests)
- 本轮 schedule/file shared parity 补充验证实际命令:
  - `cd packages/maker-shared && ../../node_modules/.bin/tsc --noEmit --pretty false`
  - `cd packages/maker-shared && ../../node_modules/.bin/vitest run`(11 files / 56 tests)
  - `cd apps/mobile && ../../node_modules/.bin/tsc --noEmit --pretty false`
  - `cd apps/mobile && ../../node_modules/.bin/vitest run`(63 files / 306 tests)
  - `cd apps/desktop && ../../node_modules/.bin/vitest run src/renderer/__tests__/makerSharedFixtureParity.test.ts`(1 file / 2 tests)
  - `cd apps/mobile && node scripts/expo-web-smoke.mjs`
  - `cd apps/mobile && node scripts/maestro-flow-smoke.mjs`
  - `cd apps/mobile && node scripts/local-device-link-smoke.mjs --mock-host --flow-suite full --check-only`

实现:

- 继续补真实 Electron 三端 fixture orchestrator:启动 local server、桌面 dev 被控端、iOS/Android app,并自动创建可打开的远程会话。
- 已先落地协议级 mock host fixture,把 `remote_session_smoke.yaml` 串进可自动探活的 relay + mobile native 回归;mock host 已能制造 direct image / xdt-video / xdt-audio 媒体消息、远程文件附件 stat、基础 schedule 数据和 controls 场景 pending interactions;后续真实桌面 fixture 复用同一 runner。
- 保持 mock login 路径,不依赖 Feishu secret。

验收:

- 不需要手动复制 callback。
- 不需要真实 Feishu。
- server + mock host + mobile native 本地能自动跑一条 smoke;真实 desktop + mobile 三端 smoke 作为下一层加强验收。

### Phase 1: 会话列表和连接状态

当前进展:

- 已把设备列表从“只显示可控设备”升级为“显示同账号设备及不可用原因”:可控制、运行中、离线、未开启远程控制、本机。
- 已锁定 busy 不影响可控性,只作为状态提示;离线 / 未开启远程控制 / 本机不可进入。
- 已接入控制端撤权镜像:收到 `link-close('revoked')` 或 `ACCESS_REVOKED` 后,手机标记该设备“已撤销访问权限”、清掉该设备的远程会话分片;后续 open/subscribe/invoke 成功后自动清除该标记。
- 已把设备列表补齐到可控制、运行中、已撤销访问权限、未开启远程控制、离线、本机,排序基于最终状态而不是原始 presence。
- 设备列表可控性分类、排序、平台标签、不可用设备可见性、header/filter/empty/toggle 文案已迁入 `@cindy/maker-shared/device-list`;mobile 只保留 `FlatList`、设置入口、重新同步、设备详情导航和状态点视觉。
- 已把设备详情页会话列表升级为 `SectionList`,按置顶、对话、项目分组,并显示 agent、model、状态、最近活动、消息数。
- 已接入会话搜索、active/archived/all 状态筛选和 project/date 分组切换;状态筛选透传到被控端 `local-db:sessions:list(limit, status)`,搜索和分组在手机端本地完成。当前搜索覆盖 title / project path / model / agent / status / worktree / schedule / Orca label / last message preview;preview 来源兼容未来 session row 字段和当前已同步 message window。
- 已接入会话列表长按选择模式和批量 archive / delete / clear selection;批量操作复用被控端 `local-db:sessions:patch-meta`,成功后刷新远程镜像。
- 已接入自动化会话组聚合:同一 schedule 的多条生成会话在项目/对话/时间分组内折成一行,聚合 running/unread 状态,组行选择会覆盖组内所有真实 session。
- 已加入 `remoteSyncTask` single-flight 同步 runner,把设备详情页和会话页的手动刷新、重连、reseed 触发合并为“当前同步 + 最多一次补同步”,避免重复请求和竞态覆盖。
- 已统一远程错误格式化,捕获 `DeviceLinkError` 时保留 `[ACCESS_REVOKED]` / `[REMOTE_DISABLED]` / `[NOT_CONNECTED]` 等错误码,确保 `ConnectionBanner` 能显示明确原因。
- 已用单测覆盖设备状态分类、撤权错误/关闭帧、不可用原因、会话分组、排序、展示元信息、撤权后清理 session/message/pending interaction。

实现:

- 会话列表按设备/项目或时间分组。
- 搜索和 active/archived/all 筛选。
- 会话行显示 agent、model、状态、last activity、pinned。
- `sessions` topic bootstrap + push + reseed 完整。
- app foreground / WS reconnect / device online 时自动 resync。
- 会话详情页 header + connection banner。

验收:

- 电脑端新建/改名/置顶/归档/删除会话,手机列表 1 秒内反映。
- 断网重连后列表不会丢会话或重复会话。
- 电脑关闭远程控制后,手机移除该设备并显示明确原因。

### Phase 2: 消息流渲染

当前进展:

- 已基于桌面端 `MessageStream.buildRenderItems` / `groupWorkRuns` / `TodoListCard` / `ThinkingCard` / `WorkGroupBlock` 语义新增移动端 `messageRenderModel`。
- 已把远程历史从“简单 normalize 后直接气泡展示”升级为 render items: `message`、`thinking`、`tool_group`、`todo`、`work_group`。
- 已对齐桌面端关键折叠规则:连续工具调用合并为一个工具组;`TodoWrite` 不显示为普通工具,而是插入稳定 key 的任务卡;最终 assistant 正文前的 thinking/tool/todo/中间 assistant 折叠为“已工作 Xs”;没有最终回答的尾部工作过程保持平铺。
- 已新增移动端 `MessageRenderer`,用触控友好的折叠卡和左侧 rail 展示 Thinking、Tool、Todo、WorkGroup;会话页已接入该 renderer。
- 已接入消息列表新消息提示:用户离开底部阅读历史时,新 tail message 不会硬拽滚动,而是显示“新消息”按钮;仍在底部时自动跟随。
- 已接入顶部“加载更早消息”:初始窗口拉最近 80 条,按钮用当前最早消息 id 作为 `before` 游标读取更早一页,并通过 `remoteSessionStore.mergeMessages` 去重合并。
- 已新增 `evaluateMessageWindowUpdate`,按 initial / appended-tail / prepended-older / expanded-both-ends / replaced 区分消息窗口变化,避免加载更早消息时误触发自动滚到底或“新消息”提示。
- 已新增会话内消息搜索:搜索当前已同步窗口内的 user / assistant / system / thinking / tool / todo / work group / attachment / diff 文本,支持上一条/下一条环绕、滚动到命中 render item 并高亮;折叠 work group 内命中会定位到父组并在搜索面板展示 preview。搜索面板可显式加载更早消息继续搜索,但不默认自动拉完整历史。
- 已接入 Markdown-lite:段落、无序/有序列表、fenced code、未闭合 code fence、表格、http(s) link 和 bold/em/code/strike inline 都在 `messageMarkdown` 里解析为稳定 blocks,`MessageRenderer` 负责触控渲染、横向表格滚动和链接打开。
- 已用 fixture 单测覆盖 User/Assistant/System/Thinking/Tool/Todo/WorkGroup、tool_result 关联、TodoWrite 更新同一张卡、未完成工作不折叠、duration 格式。
- 已新增 `messagePerformance.test.ts`,用 1000 条桌面消息原始形态锁定 normalize/render model 的结构稳定性和基础耗时回归线。

实现:

- message normalizer。已完成首版。
- User / Assistant / System / Thinking / Tool / WorkGroup / Todo。已完成首版结构化渲染。
- System Cards。已完成手机端本地 `/help`、`/context`、`/cost`、`/pwd`、`/status`;其它 slash 仍走远程队列,`/cmd` 和 compact/cmd 事件后续单独接协议。
- Markdown 基础渲染。已完成 paragraph/list/code fence/link/table、Mermaid WebView 图表预览 + 源码详情和 bold/em/code/strike inline;复杂嵌套 Markdown 待后续。
- Assistant turn cost。已完成历史/刷新态读取、动作行展示和实时 `usage:message-turn-cost` device-link topic 更新。
- 分页和滚动保持。新消息 indicator、顶部加载更早、窗口变化纯模型、当前窗口消息搜索、命中定位和显式向前扩展搜索已完成;严格滚动锚点保持仍需真机截图/像素验证。
- 新消息 indicator。已完成。
- copy/time/fork/rewind 动作行。已完成;copy 走 `expo-clipboard` + Web fallback,复制文本按桌面 user attachment 语义拼接。

验收:

- 1000 条历史消息可打开。
- streaming 时不闪空白。
- 工具调用、thinking、todo、system card 不崩且可折叠。

### Phase 3: Composer 和队列

当前进展:

- 已接入被控端 `maker:input:get-projection` / `maker:input:projection` 镜像,手机本地不乐观改队列,以电脑端 input coordinator 为真相源。
- 已新增 `inputProjection` helper,按桌面端 `AgentInputQueuedMessage` 形态构造 text-only queued item: `clientId`、`text`、`persistedContent`、`chatMessage`、`createOpts`。
- 会话页发送已从直调 `maker:send` 改为 `maker:input:enqueue`,由被控端决定立即派发还是进入 pending queue。
- 已按桌面 Stop 语义实现手机停止:队列非空时调用 `{ keepQueue: true, pauseQueue: true }`,即“中止当前 turn + 暂停队列”,Continue 后恢复 drain。
- 已新增移动端 `QueuePanel`,支持查看队列、Continue、插话、编辑、删除、上移/下移、展开/收起;进入/取消/保存编辑时同步被控端 edit lock,操作结果全部用远程返回的 projection 覆盖本地镜像;队列五动作行已通过 `queueTouchLayout.ts` 按屏宽和动作密度压缩间距,保持 36px 可触达目标;queue sheet 内 resume/retry/clear/edit/save/move/steer/remove/toggle 动作已统一到局部 `QueueTouchButton`,保留原 queue action testID 和远程调用语义。
- 已在设备会话列表补自动化生成会话的 schedule badge:通过 `maker:schedule:list + listRuns` 建 sessionId 索引,展示任务名、运行中和未读 run 数;读取失败不影响普通会话列表。
- 已用 headless smoke 覆盖 enqueue、stop、resume、updateText、move、steer、remove 以及 projection push/cleanup。

实现:

- 多行 composer。已完成 text-only 首版。
- send。已走 `maker:input:enqueue`。
- stop。已按队列保留/暂停语义实现。
- input projection。已完成镜像和重连 rebuild。
- queue sheet。已完成首版 `QueuePanel`。
- enqueue / edit / remove / move / resume。已完成首版;插话通过 `maker:input:steer` 完成。
- running / paused / interaction lock 状态。已显示 paused / abort pending / steering;编辑队列行时已主动同步 edit lock;拖拽排序的全局 interaction lock 待 V1B 拖拽一起补。
- error retry / clear。已接入 `maker:input:retry-last-error` / `maker:input:clear-error`,由被控端 typed recovery 决定恢复目标,手机端不自行重发文本。

验收:

- 手机发送消息后,桌面同一会话能看到。
- 桌面发送/排队时,手机 queue 能同步显示。
- 手机 stop 能停止电脑端当前 turn。
- 断线期间不产生重复发送。

### Phase 4: Pending Interactions

当前进展:

- 已新增 `interactionModel` helper,把 permission / ask_user_question / plan_review 的格式化与 decision serialization 从 UI 中抽出;`issue_confirm` 仅作为 shared 协议兼容保留,手机版显示桌面端处理提示。
- `InteractionPanel` 已按桌面源码拆成三类触控卡:
  - Permission:展示 title / description / tool input,支持拒绝、允许一次、按 session-scoped suggestions “本会话总是允许”。
  - Ask User:一页一题 wizard,支持单选、多选、自定义输入、上一步、跳过、提交;多选答案按桌面 `JSON.stringify(string[])` 编码。
  - Plan Review:支持半屏/全屏高度切换、预览、Markdown h1-h3 目录跳转、编辑计划、批准执行、输入 feedback 要求修改;批准时回传 `editedPlan`,反馈时回传 `reason`。
- 会话打开/重连时已通过 `maker:get-pending-interactions` 重建 pending 卡片;实时 push/dismiss 走 `remoteSessionStore` 去重和清理。
- headless smoke 已覆盖 permission / ask / plan 三类 `maker:resolve-interaction` 的 decision 形状和 dismissed 清理;shared 单测保留 `issue_confirm` 的协议兼容。

实现:

- Permission sheet。已完成首版。
- Ask User wizard。已完成首版;同一 App 生命周期内跨 session 切换会按 requestId 恢复当前题、已答内容和当前未提交输入。
- Plan Review approve/feedback。已完成首版;Markdown outline 跳转已按桌面 h1-h3 语义补齐,半屏/全屏高度切换已完成首版。
- Issue Confirm。不属于 mobile V1 主功能;仅保留 unsupported 兜底。
- pending interaction reconcile。已完成首版。

验收:

- 电脑端 agent 请求 permission,手机允许后电脑端继续执行。
- Ask User 多问题、多选、自定义输入正确返回。
- Plan approve/feedback 只提交一次,重复点击无重复 resolve。
- 遇到 `issue_confirm` 时不显示手机表单,提示回桌面端处理。

### Phase 5: 会话控制和信息面板

当前进展:

- 已扩展 `mobileMakerTransport`,补齐 `local-db:sessions:patch-meta` 远程窄口径元数据写入,用于手机端重命名、置顶、归档和删除。
- 会话页现在同时订阅 `sessions` 和 `session:<id>` topic。运行时设置与元数据变更都以被控端回流的 `local-db:sessions:patched` 为收敛来源。
- 已新增 `SessionControlsPanel`,默认收起,展开后提供:
  - title 重命名。
  - pinnedAt 置顶 / 取消置顶。
  - status 归档 / 删除。
  - model 文本设置。
  - effort 分段选项。
  - permission mode 分段选项。
  - fast mode toggle。
  - Claude 项目会话 extraDirs 热更新:手机端多行/逗号输入附加引用目录,被控端校验后回流最终有效列表。
  - context usage 刷新、摘要和桌面同形字段扁平详情展示。
  - session spend 摘要,读取被控端 session row 的 `totalCostUsd` / `totalTokenUsage` / `contextTokens` / `contextWindow`,只展示当前远程会话自身用量。
- 已给会话控制面板补关键 source anchors,并把删除从单击改为二次确认:第一次进入“确认删除”状态,第二次才向被控端提交 `status: deleted`。
- 已按桌面 `ChatInput` 的 `ModelSelector` 分类规则补跨厂商模型切换确认:已有历史消息且从 Anthropic / GPT / Google / China 等不兼容类别切换时,手机端先显示确认卡;GPT 与 `codex/` 低价版 GPT 互切沿用桌面兼容豁免。
- 已按桌面 `SessionContentHeader` / sidebar menu 语义补复制入口:深度链接 `xdt-maker://session/<id>`、XDT session id、底层 SDK session id;SDK id 缺失时按钮禁用。
- 已新增 `sessionControls` helper,统一构造 `maker:get-context-usage` 的 createOpts,并把常见 usage shape、桌面结构化 context usage 和 session spend shape 压成手机可读摘要 / 详情 rows。
- 已新增 `agentCapabilities` helper,按桌面 `AgentCapabilities` / `ModelDescriptor` 结构归一远程 `maker:get-capabilities`,让已有会话和新建会话的 model / effort / permission / fast mode 选项由被控端能力声明驱动。新建会话如果当前模型声明 `efforts: []`,创建参数会省略 `effort`,避免把旧 effort 发给不支持 reasoning 强度的模型。
- headless smoke 已覆盖 `sessions` topic 订阅、model / permission / extraDirs 回流 patch、patch-meta 重命名、context usage 摘要 / 详情 rows 和 session spend 摘要。

实现:

- model / effort / permission / fast mode。已有会话控制和新建会话页均已接入被控端能力声明:当前 model 的 efforts 决定 effort 选项,`hasFastMode + model.supportsFastMode` 决定 fast toggle 是否可用,permission modes 使用远端声明;无 effort 模型创建时不传 `effort`。
- context usage。已完成总量摘要和桌面同形详情 rows。
- spend chip。已完成 session 级首版:折叠态和展开态显示当前会话累计 cost / token / context;账户级今日/月度额度仍保持桌面端能力,手机端后续需要独立远程 usage 协议后再补。
- rename / pin / archive / delete。已完成首版。
- extraDirs 热更新。已完成首版:仅 Claude 项目会话展示入口;手机端提交解析去重后的目录列表,被控端 `maker:set-extra-dirs` 校验路径并通过 session patch 回流最终生效值。
- fork。已完成首版:用户消息和 assistant 消息通过被控端 `maker:fork` 创建新会话,手机端 upsert 当前设备会话分片并跳转;用户消息分叉会把原问题带入新会话 composer 草稿。
- rewind preview / commit。已完成首版:按桌面 `RewindPreviewDialog` 语义区分文件回滚、只截断历史、硬错误;commit 后用被控端快照替换消息列表,并把被回退的用户消息填回 composer。第二刀新增 `rewindPreviewLayout.ts`,小屏只露出 4 条文件变更、常规 iPhone 露出 6 条,并统一取消/确认/错误关闭按钮的触控反馈。
- error retry。已完成首版,见 Phase 3。

验收:

- 手机改 model/permission 后,桌面同一会话立即显示一致。
- 手机改 extraDirs 后,桌面同一 Claude 项目会话只接受被控端校验通过的目录,手机显示回流后的最终列表。
- fork/rewind 后会话列表和消息流一致。
- error retry 不重复发送错误文本。

### Phase 6: 媒体、Diff、附件

当前进展:

- 已在 `messageNormalize` 里抽出用户消息附件结构:JSON persisted content 中的 `images[]` / `files[]` 会被解析为移动端稳定的 `attachments`,并区分可直接预览的 `http(s)` / `data:image` 与需要远程取件的 `xdt-image://`。
- 已抽出工具结果媒体:对齐桌面 `extractToolResultMedia` 的核心字段,识别 `xdt_image_url(s)` / `xdt_video_url(s)` / `xdt_audio_urls` / `_xdt_audio_tracks`,并在工具卡里展示图片/视频/音频产物卡。
- 已接入远程媒体取件首版:手机端通过 `device-link:media:fetch` 让被控桌面上传本机 `xdt-image://` / `xdt-video://` / `xdt-audio://` / `xdt-file://` 到 OSS,再用服务端 `/api/device-link/media/presign-get` 换取手机可访问临时 URL;图片在 payload modal 内联预览,视频/音频通过现有 `react-native-webview` 内嵌播放器播放并回传状态,关闭详情、切换源或 App 进入后台时暂停播放器,同时删除 OSS 中转对象并清掉本地缓存。
- 已接入远程文本文件只读预览:用户消息文件 chip 打开后,手机端通过 allowlist 内的 `text-file:read-preview` 按需读取被控电脑文本内容。该 handler 复用桌面端绝对路径校验、系统目录 blocklist、10MB 上限和 `oversize` / `forbidden` / `not_found` reason,没有开放裸文件读或附件读接口。
- 已补非文本文件安全降级:PDF / Draw.io / Office / binary / unknown 只显示降级说明和路径复制,不展示“加载文本预览”入口,避免手机版第一版误触发远程裸读。
- 已抽出 Edit / Write / MultiEdit diff payload,在工具卡内展示文件路径、插入/删除行数和首段预览。
- 已新增 `messagePayload` + 全屏 payload viewer:用户附件、工具媒体、工具输出、Edit/Write/MultiEdit diff 都能从消息流里点开查看完整内容;长 tool_result 和大 diff 不再直接撑爆消息列表。payload summary/body/preview、tool input diff/summary projection、tool_result media extraction 和 attachment -> file/media payload projection 已由 shared core 输出 kind/title/copy/open target、body presentation、preview severity、primary action 和 compact meta,手机端 tool result、media、file、diff 入口和 payload header 只消费该模型。diff 详情已从纯文本升级为结构化渲染,按文件头 / stats / edit label / 旧内容 / 新内容分别显示;旧/新对照有显式横向滚动容器和 `message.diffCompareScroll` 锚点,窄屏不裁掉右侧 pane;media payload modal 已有 `visual_session_payload.yaml` 截图 flow;diff 详情里也能复制远程文件路径并按需读取当前文件文本预览。payload header 动作已统一到局部 `PayloadHeaderActionButton`,复制、打开、上一张、下一张和关闭保留原锚点和行为;payload body 动作已统一到局部 `PayloadActionButton`,并给路径动作行补 `message.payloadPathActions` 锚点,切换 payload path 时会复位复制反馈。消息流里的媒体、文件、diff、tool result 和 Mermaid source 打开详情动作已统一到局部 `MessageContentOpenButton`,保持原 payload 构造和锚点不变。
- payload full-screen viewer 已进入默认 iOS hash baseline:`visual-session-payload` 和设备/会话/Settings/六态截图一起组成 12 张 `ios-iphone-17-pro-expo-go` baseline。Modal 顶部 safe area 由 `buildPayloadModalSafeArea` 统一计算,覆盖 iOS safe-area context 缺失时的状态栏避让和 Android status bar fallback。
- payload 图片 fixture 已从 1x1 空白 data PNG 改成可见的 160x90 稳定测试图,并在 `maestro-flow-smoke` 里加了防回退检查。`data:image/*` 在 payload body / preview 中显示为“内联图片数据 · PNG · 大小”摘要,复制和打开仍使用原始 data URL,避免手机详情页被 base64 长串污染。
- 已新增 `composerDraftStore`,fork 用户消息时像桌面端一样先保存新会话 draft 再跳转,避免长文本进入路由参数。
- 已用单测覆盖附件解析、工具媒体解析、diff payload、payload viewer 数据构造、draft store、文件预览错误文案和 PDF/drawio 非文本降级;`file_preview.yaml` 覆盖用户文件 chip 文本预览、PDF/drawio 降级、路径复制、工具组展开、diff 当前文件预览;`mobileRemoteFlowSmoke` 继续覆盖 fork/rewind/queue recovery。

实现:

- image/video/audio render。已完成结构化卡片、可直接预览图片、远程图片取件后内联预览和 100% / 150% / 200% / 300% 图片缩放控制;视频/音频已通过 WebView 播放临时 URL,并回传播放器 loaded/playing/paused/waiting/ended/error 状态;mock host + `media_smoke.yaml` 已覆盖 direct image fixture 打开和缩放。真 pinch 手势、离屏暂停和真实 OSS 视频/音频播放 fixture 待补。
- remote media URL。已完成移动端 OSS 取件首版,复用 `feat/device-link-remote-control` 的 `device-link:media:fetch`、服务端 media presign 和同账号鉴权,没有新增平行协议。
- media lightbox。已完成首版:HTTP/data image 可全屏预览,`xdt-*://` 打开详情后自动取件,失败显示可重试占位和原始 URL。
- tool payload full-screen。已完成首版:tool_result、媒体 URL、文件路径/文本预览、diff 全量内容统一走 `MessagePayloadModal`。
- diff viewer。已完成移动端结构化版:全屏分段展示完整 Edit / Write / MultiEdit payload,每段保留旧内容 / 新内容两栏横向对照;后续再补桌面同级 line-level context folding 和更细的语法增强。
- 附件上传:已完成真实发送链路——手机端输入被控电脑上的文件路径,通过被控端 `fs:stat-path` 校验为文件后,构造桌面兼容队列项并随消息发送。手机本机文件已接 `expo-document-picker` + presign-put / OSS PUT / `cindy-oss-attach://` 链路;图片附件现在会写入 `persistedContent.images[]` / `chatMessage.images`,非图片文件写入 `persistedContent.files[]` / `chatMessage.files`,顶层 `files[]` 仍保留全部附件供被控端 `materializeQueuedOssAttachments` 一次性物化和去重。photo/library/share sheet 作为更好的原生入口仍留后续。

验收:

- 被控端工具产出的图片/视频/音频能在手机播放/预览。
- 消息文件 chip 能按需读取被控端文本预览;超 10MB、系统目录、文件缺失分别显示明确失败原因。
- 手机发送图片附件后,桌面端历史重载仍按 `images[]` 渲染图片,非图片附件仍按 file chip 渲染。
- 大媒体不会阻塞消息列表滚动。
- diff 可读,长文件不撑爆 UI。

### Phase 7: Automations

当前进展:

- 已确认 `feat/device-link-remote-control` 分支在 `packages/device-link/src/allowlist.ts` 开放 `maker:schedule:*`,且 `maker:schedule:event` 已进入 push forward allowlist;手机版不需要另起私有协议。
- 已在 `mobileMakerTransport` 增加 `schedule.list/get/listTemplates/createFromTemplate/create/update/listRuns/runNow/pause/resume/delete/markRunRead/markScheduleRunsRead`,参数顺序对齐桌面 preload 的 `window.electronAPI.maker.schedule.*`。
- 已新增 `scheduler/scheduleModel`,复用桌面 `SchedulerPage` 的关键语义:active/expired 同 rank、paused 下沉、组内按 `lastFiredAt` 再 `updatedAt` 倒序;持续会话 runs 按 `sessionId` 折叠;只把终态未读 run 计入 unread。
- 已新增 `/automations/[deviceId]` 手机页面,从设备详情页进入;页面提供任务列表、任务详情、最近 runs、Run now、pause/resume、删除、标记已读、打开 run 对应会话。
- 已新增 `scheduler/scheduleFormModel`,从桌面 `ScheduleFormDialog` / `buildScheduleInput` 迁移基础字段语义:名称、提示词、cron/timezone、手动模式、intervalMs、Agent/model/effort/fast mode、project/dialogue workspace、useWorktree、notify;编辑已有任务时保留 `targetSessionId` / `persistentSession` / `silentWhenIdle` 等桌面高级隐藏语义。当前已继续把 fresh/persistent/bound 运行会话状态机、pending 绑定占位和绑定会话 ID 更新语义迁入 shared core。
- 已在自动化页增加新建/编辑基础表单,保存通过被控端 `maker:schedule:create/update`,成功后重新同步列表和 runs;运行会话现在支持新会话、持续会话和绑定已有会话三态,绑定态使用当前设备会话选项 + ID 输入兜底。
- 已在新建表单增加模板 gallery:打开表单时拉取被控端 `maker:schedule:list-templates`,选择模板后预填字段和参数默认值;用户未手改 prompt 时保存走 `maker:schedule:create-from-template`,让桌面端 main handler 负责最终参数替换和 scheduler.create。
- 已对齐桌面 `useDeleteScheduleWithSessions` 的删除策略:删除前统计最多 10000 条 run 中的生成会话和 in-flight 数量,用户必须选择保留 / 归档 / 删除生成会话;普通 schedule 走 `maker:schedule:delete`,project schedule 带 `projectConfigId` 时走 `maker:project-automation:remove-schedule`,生成会话通过 `local-db:sessions:patch-meta` 更新状态。
- 已新增 schedule push event projection store,收到被控端 `maker:schedule:event` 后用 shared `scheduleEvents.ts` 判断 list/runs/session-index/unread refresh intent;自动化页只刷新受影响的列表或 selected runs,设备详情只在 session-index 相关事件后重拉自动化分组。
- 已用 `scheduleModel.test` 锁定排序/摘要/折叠/未读,用 `scheduleFormModel.test` 锁定 create/update 输入构造、模板参数替换预览、隐藏字段保留和 fresh/persistent/bound 切换,用 `scheduleDelete.test` 锁定生成会话删除策略,用 shared `scheduleEvents.test` 锁定 desktop SchedulerEvent projection,用 `remoteScheduleEvents.test` 锁定 per-device refresh versions,用 `mobileMakerTransport.test` 锁定 schedule channel,并把 schedule list/templates/createFromTemplate/runs/create/update/runNow/pause/resume/mark read/open session/生成会话归档删除串进 `mobileRemoteFlowSmoke`。

实现:

- Automations 入口。已完成设备详情页入口;独立 tab 留到导航结构重整时做。
- schedule list。已完成首版。
- run history。已完成首版,并折叠持续会话重复 run。
- pause/resume/trigger。已完成首版。
- mark read / 打开绑定会话。已完成首版。
- delete。已完成桌面对齐版:手机端确认卡提供“保留生成会话 / 归档生成会话 / 删除生成会话”三选项,删除前显示生成会话数和 in-flight run 数;普通 schedule 删除任务,project schedule 在具备 `projectConfigId` 时删除项目配置,生成会话状态更新失败时保留错误提示。
- 新建/编辑 schedule。已完成基础闭环:手机端可创建/编辑普通 user schedule,保留桌面端高级隐藏字段;fresh/persistent/bound 运行会话编辑第一刀已对齐桌面 `ScheduleFormDialog` / `scheduleFormLogic`;project automation 完整编辑待后续对齐。
- 模板 gallery。已完成基础闭环:手机端可列出模板、选择模板、编辑参数默认值并通过 `create-from-template` 创建 schedule;模板分类筛选和复杂参数体验待后续细化。

验收:

- 桌面 schedule 运行后,手机看到 unread run。
- 手机标记已读/打开 run 后,桌面状态一致。
- 手机 pause/resume 后,电脑端 schedule 状态一致。
- 手机 Run now 后,run history 出现新的 running/terminal run。
- 手机新建/编辑普通 schedule 后,电脑端 schedule 列表和手机端详情一致。
- 手机从模板创建 schedule 后,最终 prompt 参数替换由电脑端完成,手机和电脑端列表一致。

### Phase 8: Collaboration / Orca

- V1 只读识别已完成:手机版读取被控端 session row 的 `orcaRole`,会话列表 subtitle 显示“协作 Lead / 协作 Worker”;会话页不再把协作说明作为消息流上方常驻 banner,只在 composer / pending / queue / controls 等必要阻断位置显示只读安全提示。
- 已补协作安全退化 fixture:列表搜索能命中 lead/worker 标签;队列项如果带 `origin.kind === 'orca'`,手机端显示只读提示并禁用移动、插话、编辑、删除;Orca worker bridge 的空成功结果 `{"ok":true}` 按桌面 `MessageStream` 规则隐藏,带 message/error/detail 的结果仍展示。
- 已把协作会话整体切成只读安全降级:composer、pending interaction、queue、session controls 和 message fork/rewind 都不再允许手机端产生协作流程写操作。
- V1 不提供创建 worker、切换 focus、split/toggle pane、archive worker、stop collaboration 等编排操作;这些保持电脑端完成。
- V2 单独设计和实现完整手机版协作操作面。

## 12. 自动化测试方案

用户不应该手动承担回归测试。测试分四层:

### 12.1 协议和状态单测

范围:

- `remoteSessionStore`
- `topicRegistry`
- `remoteRetry`
- `remoteStatus`
- `accessRevoked`
- `revokedDevicesStore`
- `messageNormalize`
- `interactionModel`
- `queueModel`
- `mobileMakerTransport`

覆盖:

- 去重。
- 排序。
- snapshot + push 合并。
- device remove。
- access revoked 标记、恢复和镜像清理。
- reconnect rehydrate。
- pending interaction serialization。
- transient retry 和 permanent error 区分。
- allowlist channel drift。

命令:

```bash
pnpm --filter mobile test
pnpm --filter mobile test:smoke
pnpm --filter mobile test:web-smoke
pnpm --filter @cindy/device-link test
pnpm --filter server test -- deviceLinkClientRelayE2E
```

### 12.2 本地三端集成测试

测试进程:

- 本地 server,开启 mock login 和 device-link relay。
- 桌面 dev,开启 remote control,使用测试账号和测试 userData。
- iOS Simulator / Android Emulator 上的 mobile app,同一测试账号 mock login。
- 测试脚本统一放到 `apps/mobile/scripts/`,由一个 orchestrator 负责启动/探活/清理,避免用户手工开多个终端。

已落地 / 建议新增:

- `apps/mobile/scripts/local-device-link-smoke.mjs`:编排 local server(可选)、mock host(可选)、mobile simulator。
- 当前已落地 v1 fixture:支持 `--start-server` 启动 local server,支持 `--mock-host` 启动协议级被控端 fixture;先检查 local server、mock auth、device-link REST 和可控电脑 presence,通过后调用 Maestro `remote_session_smoke.yaml`。已新增 `create_session_smoke.yaml` / `flow-suite create`,从手机新建 dialogue 会话并发送首条消息;`flow-suite file` 会制造 `.md` / `.pdf` / `.drawio` 附件,分别覆盖文本读取和非文本降级。真实 desktop smoke 不再依赖已有会话列表。
- `apps/mobile/scripts/mock-device-link-host.mjs`:用真实 device-link WS 协议模拟一台开启远控的 Mac,提供稳定会话、消息、发送回显、基础 queue/session/schedule channel 和 `controls` pending-interaction 场景,不依赖真实 Electron 桌面人工登录。
- `apps/mobile/scripts/mock-login-state.mjs`:写入手机/桌面都能接受的 mock auth token,不依赖 Feishu secret。
- `apps/mobile/scripts/desktop-remote-fixture.mjs`:在被控端创建固定会话、注入消息、pending interaction、schedule run。
- `apps/mobile/e2e/fixtures/`:共享三端测试账号、设备名、会话标题、消息文本。

核心 smoke:

1. mock login。
2. 手机看到电脑设备。
3. 手机订阅 sessions。
4. 电脑端创建测试会话。
5. 手机打开会话。
6. 手机发送消息。
7. 被控端收到 `maker:send`。
8. 被控端追加消息 push。
9. 手机收到消息。
10. 被控端发 permission request。
11. 手机 resolve。
12. 被控端继续。
13. 手机断开 relay,旧数据保留不空白。
14. relay 恢复,手机重订阅并补回断线期间的消息和 pending interaction。
15. 电脑端撤销手机访问,手机设备和会话分片被移除并显示已撤销。

这条用脚本编排,不要靠人工点。

### 12.3 移动端 E2E

当前进展:

- 已新增 `pnpm --filter mobile test:web-smoke`,用 Expo Web export 编译整套 mobile route bundle,并断言 `Device Link` / `Remote Device` / `Remote Session` / `Remote Automations` / `maker:schedule:delete` 等关键路由和能力 marker 存在。它不是替代真机点击 E2E,但能在无模拟器、无 Maestro 的机器上先拦住 route import、bundle compile、关键页面被 tree-shake/路由遗漏这类回归。
- 已接入 Maestro 第一层真实点击流:默认 `remote_control_smoke.yaml` 覆盖 mock login 和设备列表;`remote_session_smoke.yaml` 覆盖打开会话和发送消息;`create_session_smoke.yaml` 覆盖从手机新建 dialogue 会话并发送首条消息;`fixture_controls_smoke.yaml` 覆盖队列和 pending interactions;`media_smoke.yaml` 覆盖媒体图片 payload 和缩放;`file_preview.yaml` 覆盖远程文件文本预览、PDF/drawio 降级、路径复制和 diff 当前文件预览;`test:e2e:local:fixture` / `test:e2e:local:create` / `test:e2e:local:controls` / `test:e2e:local:file` / `test:e2e:local:media` 用 mock host 让它进入可自动回归状态。
- 已新增 native E2E doctor 和 `test:e2e:local:full`:doctor 在真实 Maestro 前统一检查 CLI/模拟器/API base;full suite 用 controls mock host 串起 create、session、pending controls、media、file、fork/rewind、automations,并支持 `--check-only` 先验证本地 relay 和 mock host。
- 已新增 `visual_smoke.yaml`、`visual_session_idle.yaml`、`visual_session_running.yaml`、`visual_session_queue.yaml`、`visual_session_pending.yaml`、`visual_session_payload.yaml`、`visual_session_revoked.yaml`、`visual_session_offline.yaml` 和 `pnpm --filter mobile test:e2e:visual`,用 Maestro `takeScreenshot` 自动采集设备列表、Settings、设备详情、会话、会话控制面板、payload full-screen viewer、idle/running/pending/queue/offline/revoked 十二张关键截图;同时新增 `pnpm --filter mobile test:e2e:visual:update-baseline -- --profile <profile> --actual-dir <dir>` 和 `pnpm --filter mobile test:e2e:visual:baseline -- --profile <profile> --actual-dir <dir>`。local visual suite 会隔离每个 state flow 的 mock host 生命周期并清理 stale e2e 设备记录,避免长 flow 连续切 session 造成同步竞态或设备列表计数漂移。当前 `ios-iphone-17-pro-expo-go` baseline 已接受 12 张并通过裁掉顶部 120px 后的 sha256 严格比对;Android profile 需要单独目录保存。
- 已新增 `fork_rewind.yaml`,覆盖发送一条消息后执行 rewind preview/confirm,再 fork 会话并进入 forked session。
- 已新增 `automations.yaml`,覆盖进入远程自动化页、Run now、pause/resume、打开自动化 run 对应会话。
- 已新增 `automations_create_edit.yaml`,覆盖远程自动化页里的 template gallery 和 create/edit 基础表单锚点。
- 已新增 `pnpm --filter mobile test:e2e:reconnect:local`,用真实本地 device-link relay 建立 mock host/controller 两条 WS,断开 controller 后让 host 发送离线 push,再重连并验证通过 host-authoritative message reload 补回丢失窗口。

优先用 Maestro 做第一版黑盒流程,原因是脚本短、可读、适合 AI 维护。Detox 留给后面需要深层 native assertion 时再引入。

建议文件结构:

```text
apps/mobile/e2e/maestro/
  login_mock.yaml
  device_list.yaml
  create_session_smoke.yaml
  open_session.yaml
  send_message.yaml
  remote_control_smoke.yaml
  remote_session_smoke.yaml
  fixture_controls_smoke.yaml
  queue.yaml
  permission.yaml
  ask_user.yaml
  plan_review.yaml
  visual_smoke.yaml
  fork_rewind.yaml
  automations.yaml
  automations_create_edit.yaml
```

流程:

- `e2e/maestro/login_mock.yaml`
- `e2e/maestro/device_list.yaml`
- `e2e/maestro/create_session_smoke.yaml`
- `e2e/maestro/open_session.yaml`
- `e2e/maestro/send_message.yaml`
- `e2e/maestro/remote_session_smoke.yaml`
- `e2e/maestro/fixture_controls_smoke.yaml`
- `e2e/maestro/queue.yaml`
- `e2e/maestro/permission.yaml`
- `e2e/maestro/ask_user.yaml`
- `e2e/maestro/plan_review.yaml`
- `e2e/maestro/visual_smoke.yaml`
- `e2e/maestro/fork_rewind.yaml`
- `e2e/maestro/automations.yaml`
- `e2e/maestro/automations_create_edit.yaml`

每条 flow 都要输出截图、失败时的 app 日志、relay/desktop/device-link 日志切片。视觉截图先用 `visual_smoke.yaml` / `visual_session_idle.yaml` / `visual_session_running.yaml` / `visual_session_queue.yaml` / `visual_session_pending.yaml` / `visual_session_revoked.yaml` / `visual_session_offline.yaml` 采集,确认目标设备 profile 后运行 `test:e2e:visual:update-baseline`,之后每次回归运行 `test:e2e:visual:baseline`;当前 iOS profile 已把 `visual-settings` 写入 manifest 并纳入普通 baseline check。当前基线脚本使用严格文件 hash,只有在固定模拟器 / 固定系统版本下才应作为阻断门禁,跨设备 profile 必须分目录保存。CI 或本机跑不过模拟器时,至少要跑 `test:web-smoke` 作为降级门禁,但不能把它当最终 E2E。Reconnect 已先用 headless relay smoke 覆盖真实断连补账;后续如果要做 native `reconnect.yaml`,必须复用同样的断连 fixture,不要写一个只点“重新同步”的伪断线 flow。

### 12.4 渲染和性能测试

用固定 fixture 生成会话:

- 纯文本长会话。
- Markdown / code / table。
- thinking + tool + todo。
- permission / ask / plan / issue。
- 图片 / 视频 / 音频。
- 大 diff。
- schedule generated sessions。
- Orca lead / worker / communication tool 只读会话。
- 1000 messages。
- reconnect 后重复 push。

指标:

- 首屏打开最近 80 条 < 1s。
- 上拉加载更早消息不跳位置。
- 发送按钮点击到本地 pending UI < 150ms。
- device-link invoke 到被控端 ack < 2s,超时有明确错误。
- 1000 条消息滚动无明显卡顿。
- 1000 条消息内存不随切入/切出会话持续增长。
- iPhone 小屏和 Android 小屏无文字重叠。

当前状态:

- 已新增 `apps/mobile/src/__tests__/messagePerformance.test.ts`:用 1000 条桌面消息原始形态 fixture 测 normalize/render model 时间、stable key 和折叠结构。
- 已新增 `apps/mobile/src/__tests__/sessionList.test.ts` 的 1000 session fixture:覆盖置顶、归档、对话/项目、自动化分组、schedule unread/running、worktree、Orca 标签、last message preview 搜索和搜索性能,并确认不会重复渲染同一 session。
- 已新增 `apps/mobile/src/__tests__/scrollWindowModel.test.ts`:纯函数锁定分页窗口、锚点和新消息 indicator。
- 已新增 `apps/mobile/src/__tests__/remoteMedia.test.ts`:已覆盖 `xdt-*://` 识别、取件编排、presign URL 缓存有效期和大小格式化;已补 mock-host media fixture 和 `media_smoke.yaml`;后续补真实 OSS 对象播放 fixture。
- 已新增 Maestro screenshot artifact flow:设备列表、Settings、设备详情、会话、会话控制面板、payload full-screen viewer、idle/running/pending/queue/offline/revoked 十二张关键截图;并新增 visual baseline checker,支持按 `profile` 保存 / 校验小屏 iPhone、普通 iPhone、Android Pixel 等设备基线。`ios-iphone-17-pro-expo-go` 已进入裁掉顶部 120px 后的严格 hash diff 门禁,当前 manifest 已接受并校验 12 张。C2.5 native 重跑已校验键盘/sheet/pending 同步重试和 offline read-only 稳定性。后续固定 Android profile 后再补 Android baseline;如动画/时间戳导致误报,再评估是否升级为容忍阈值的 pixel diff。

## 13. 调优策略

优先调这些点:

- 列表虚拟化:先用 `FlatList` + memo + stable key,如果长会话卡顿再引入更强虚拟列表。
- 消息 normalizer 缓存:按 `message.id/clientId + updatedAt` 记忆,避免每次 render 重 parse。
- Markdown 渲染分层:普通文本快速路径,复杂 markdown 才走 markdown renderer。
- Tool / thinking / work group 默认折叠,降低首屏渲染量。
- 大媒体懒加载,离屏暂停音视频。
- App foreground 后先保留旧数据,后台 resync 完再替换,避免空白帧。
- 所有远程错误保留 code,UI 做可操作文案,不要只显示 `Failed to fetch`。

## 14. 验收清单

V1A 完成标准:

- 手机可用 mock login 自动登录。
- 手机能发现同账号电脑。
- 手机能看到可控制会话列表。
- 手机能打开会话并同步最近消息。
- 手机能发送消息、停止当前 turn、处理 queue。
- 手机能处理 permission、ask_user_question、plan_review;遇到 `issue_confirm` 会安全提示回桌面端处理。
- 断线/重连/电脑下线/撤销访问都有明确状态。
- 关键流程有自动化 E2E。
- 不依赖用户手动复制 callback 或手工点完整回归。

V1B 完成标准:

- 手机能改 model/effort/permission/fast。
- 手机能 fork/rewind。
- 手机能查看 context/spend/diff。
- 手机能预览图片/视频/音频。
- 手机能查看和基础管理 automations。
- 1000 条消息和媒体 fixture 通过性能测试。

V2 完成标准:

- 手机完整支持协作模式 / Orca。
- Lead / Worker 切换、创建 worker、switch focus、archive worker、stop collaboration 全部可用。

# 两个 Telegram bot 的能力台账

Cindy 有两个 Telegram bot，用户看到的是同一个产品：

- **官方 bot**——服务端 `telegram-hook-server` 持有 Telegram 连接，桌面端通过
  device-link 帧（`turn.progress` / `turn.end` / `msg.op`）驱动它。桌面侧那一半在
  `apps/desktop/src/main/hook-control/**`。
- **个人 bot**——桌面端自己持有 Telegram 连接（`packages/lizi-im/src/telegram/**`），
  在进程内渲染，状态落本地库。业务侧在 `apps/desktop/src/main/im/**`。

两者是**两套架构**，不是同一份代码的两个开关。所以"统一"不等于"让两条代码路径长得
一样"，而是：**能同源的同源；不能同源的，差异必须写在这张表里、有裁决、有理由。**

> 这张表存在的理由与 `botCommands.ts` 注册表一样：把「散落两个仓、谁也不知道差在哪」
> 变成「表里显式登记」。**新增或修改任一 bot 的用户可见行为时，必须同步更新本表对应
> 行**；差异可以有，但不能没人说得清。
>
> 写这张表时的教训：**不要读模块注释就下结论，要读那条路径最后真正交出去的是什么。**
> 初版据此把「终稿保留过程区」写成了两侧差异，实际两侧**成功收口**时都只交正文。
> （失败收口两侧确有差异——个人侧留「过程区 + 正文 + 错误」，官方侧走独立错误字段，
> 见第二节末行。成功与失败必须分开看。）

判定口径三档：

| 档 | 含义 |
|---|---|
| **同源** | 字面上同一份代码/同一份数据在两侧生效，不可能漂移 |
| **有意不同** | 已经裁决过的差异，**不要去"统一"它**，动它要先推翻裁决 |
| **缺口** | 该有而没有，或两边各写一套。这一列是待办 |

---

## 一、已同源

> **这一节只放两侧真的跑同一份代码/同一份数据的东西。** 一旦列进来，维护者就会跳过
> 双路核对——所以「个人侧独有」「官方侧独有」的能力不能放这里，哪怕它在共享目录下。
>
> 还要写清同源的**是哪一段**：共用一个实现，不等于进入它之前的判定也一样。群历史
> 检索就是这样——检索本身两侧同一份代码，但"这一轮有没有权限查、能查多大范围"是
> 各写各的，私聊上给出的答案还不同（第四节 2e）。

| 能力 | 单一真相源 | 共享到什么程度 |
|---|---|---|
| 过程区与正文的**文本合成** | `im/shared/turnPresenter.ts` + `turnActivity.ts` | 过程区怎么排（工具步骤、思考步骤、耗时行）、过程区与正文怎么拼（`composeProgressView`）。**正文累积不算**——见第三节：`createTurnPresenter` 按 `mode` 实例化两个独立引擎，累积、消息投影、`finalText()` 判据都不同，改一个引擎不影响另一个 |
| 群历史检索**实现** | `im/shared/groupHistoryAccess.ts` | 检索本身与 access scope 这个类型两侧共用。**但产生 scope 的那一步各写各的**——个人是 `im/telegram/adapter.ts` 的 `groupHistoryAccessFor`，官方是 `hook-control/groupHistoryScope.ts` 的 `groupHistoryAccessForExternalKey`。两者在**群轮次**上给出同一档（lane-only，只查当前群/topic），**在私聊上给的不一样**：见第四节 2e |
| 交互卡的**语义层**（`ask_user_question` / `plan_review` / 权限确认） | `im/shared/interactionCardModel.ts` | 选项集与决策模型两侧真跑同一份：至多 6 个选项（`MAX_OPTIONS`）、multiSelect 降级单选、只渲染第一问、plan 正文截断 1500（`MAX_PLAN_LEN`）、按钮文案的**产品级**上限 30（`BTN_LABEL_MAX`）、无选项降级时唯一按钮「继续」，以及 buttonId → 决策对象的构造与 header/body 拆分。官方那条链路由 `hook-control/interactions.ts` 直接 import 本模块（对 `@cindy/maker-core` 刻意只做 type-only 依赖，免得 hook 链路在运行期加载整个 barrel）。**渲染不在这里**——按钮文案来源、标题格式、省略号样式、尺寸上限都是各自渲染侧的事，见第三节 |
| 群消息本地库的**保留策略** | `im/shared/groupWindowCore.ts` | 上限数值（每命名空间 1 GiB 正文 + 500 万行安全阀）、回收低水位（0.9）与回收实现都在这一处；两侧把同一份 `DEFAULT_GROUP_WINDOW_RETENTION` 传进同一个 `recordGroupWindowEntry`。**额度靠 provider 命名空间隔离**：官方 `telegram:<principalId>`、个人 `telegram-personal:<botId>`，统计与回收都按 provider 过滤，两个账号各算各的、消息不串。一个边界要记住：两侧各持有一份 `{ ...DEFAULT }` **可变副本**（为的是测试能用小阈值把回收逼出来），所以共享的是"模块初始化时的那组数字"，运行期改一侧不会传导到另一侧 |

### 放在共享目录、但**只有一侧消费**的

| 东西 | 实际情况 |
|---|---|
| `im/shared/channelToolPolicy.ts` 的 `channelForceConfirmToolCall` | 只被个人 Telegram / 微信 / 钉钉的权限策略引用。**官方 bot 不挂**——见第三节的裁决。放在 `shared/` 下是因为个人侧三个渠道共用，不代表两个 bot 共用 |
| `packages/lizi-im/src/telegram/presentationCapabilities.ts` | 只导出并由**个人 driver** 消费 `TELEGRAM_PERSONAL_CAPABILITIES`，没有官方 bot 共用的契约数据。它的作用是把车道差异写在一处，不是让两侧取同一份值。官方侧同名策略在另一个仓各写一套——具体到链接预览见第四节 2c |
| `PresenterPolicy.intermediateMaxRenderedChars`（长度上限） | **只有官方那条路消费**（`createProgressEmitter`）。个人侧用自己的私有常量 `INTERMEDIATE_EDIT_LIMIT = 3800`（`streamingText.ts`）判断何时停止编辑。**改共享的长度策略只会改到官方 bot**——两处独立维护，改一处必须核对另一处 |
| `PresenterPolicy.intermediateThrottleMs`（节流间隔） | 个人路径是**双层节流**：`turnRunner` 的 `CARD_PATCH_THROTTLE_MS` 确实读共享值，但真正出站的 `streamingText.ts` 还有一份写死的 `TELEGRAM_UPDATE_THROTTLE_MS = 1500`（注释称「双层节流冗余但无害」）。**改共享值只改得动 runner 那层，driver 那层不跟**——所以这个值也不是同源，改它要连 driver 的常量一起核对 |
| `im/shared/botCommands.ts` 的**官方那一半** | 官方 bot 的命令**仍由服务端 `TELEGRAM_COMMANDS` 下发**，本表对官方侧是「声明性镜像、不接线」。测试只用内联清单核对镜像，**服务端改了命令这边完全可能不同步**。个人侧那一半是真的单一真相源（菜单与分发直接读它）；官方那一半是跨仓镜像，**改命令要两个仓一起核对** |

进度帧去重的三槽基线（`shouldEmitProgressFrame` / `createProgressEmitter`）同理：只在注入
`onProgress` 时启用，也就是**只有官方那条路在用**，个人侧不消费。

## 二、消息生命周期——按阶段逐格对照

`turnPresenter` 统一的是"这一刻该显示什么"这段文本。"这段文本发给谁、放在哪、什么时候
变、最后落在哪"由各消费方自己负责（模块注释明写：收口不在 presenter 里）。

| 阶段 | 个人 bot | 官方 bot |
|---|---|---|
| 首帧 | 有真实内容（含工具步骤）就建一条**真实消息**；空内容不建（惰性占位） | 快照进 `turn.progress` 帧发给服务端 |
| 过程中 | **第一帧真实内容用 `sendMessage` 建消息（这一条会推送），之后持续 `editMessageText` 覆盖（编辑不推送）**，用户看着它长大：过程区在上、正文在下 | **私聊**：进 Telegram **草稿**（`sendDraft`）——在输入框那个位置，**不在消息流里**；**群**：一条进度消息，`editMessageText` 覆盖 |
| 终稿内容（**成功收口**） | **只有正文**（`composeStreamingView` 在 `turn.done` 时直接 `return body`，不再合成过程区） | **只有正文**（`presenter.finalText()` 取 body 引擎的缓冲，不经过 `composeProgressView`） |
| 终稿落在哪 | **单段且原位定稿成功时**留在那条消息里。三种情况会新发消息：终稿超长被切成多段（第 2 段起逐段 `send`）、rich 原位编辑不可用或失败（回落 HTML 编辑，仍失败则整条 repost）、带受管图片跳过原位定稿 | **私聊**：新发一条正文消息，草稿随之消失；**群**：编辑那条进度消息 |
| **失败收口** | **过程区保留**：错误路径不置 `turn.done`，`composeStreamingView` 仍走运行中合成——卡片定稿成「过程区 + 正文 + ❌ 错误：…」，用户能看到失败前干到了哪一步 | 终稿正文为**空**，错误信息走独立的 `errorMessage` 字段，由服务端按语言渲染成「任务失败：…」——**不带过程区** |

**成功收口的终稿两侧都只有正文**，过程区消失——这一点没有差异，不要登记成缺口。
这条不变量**只对成功成立**：失败收口两侧形态不同（上表末行），个人 bot 保留故障现场、
官方 bot 只给一句错误。改收口逻辑时不要拿「终稿只有正文」去删失败路径的过程信息——
那是用户排障的唯一线索。

过程阶段的载体差异（个人在聊天记录里、官方私聊在输入框草稿里）已经裁决过，见下节。

## 三、有意不同（已裁决，不要"统一"）

| 差异 | 官方 | 个人 | 裁决与理由 |
|---|---|---|---|
| 群轮次权限档 | 完全按用户配的走 | 所有群轮次强制确认破坏性操作 | Chris 2026-08-03 实踩裁决：用户选了「完全访问」，官方 bot 却在群里静默跑 `ask` 并弹卡，设置与实际对不上。**完全访问就是完全访问**，不得在运行期另起一套隐式权限配置。官方 bot 的群聊定位是引导用户装自己的个人 bot，不承担「群里多人共用一个 bot」的权限模型——那套已在个人 bot 里设计过。见 `hook-control/session-runner.ts` |
| 私聊过程态的载体 | Telegram **草稿**（`sendDraft`），终稿一发草稿自然消失 | 真实消息，原地 `editMessageText` 覆盖 | 草稿只有官方路径拿得到。个人栈**不是零推送**：惰性占位让「没有真实内容就不建消息」，但**第一帧真实内容那次 `sendMessage` 会推送**，之后的编辑才不推送。`presentationCapabilities.ts` 的 `progressSilent: true` 说的是「过程帧不额外推送」，不是「整轮零推送」 |
| `/status` | 有 | 无 | 官方 bot 经服务端中继，链路可断，所以有「关联状态」可看；个人 bot 由桌面直连 Bot API，没有等价概念。见注册表 `parityNote` |
| `/unlink` | 有 | 无 | 官方 bot 的关联由服务端持有；个人 bot 的 token 是用户自填的，解绑入口在桌面设置页 |
| `/workspace` | 独立命令 | `/project` 的**别名** | 服务端两条菜单文案逐字相同。个人 bot 用别名表达同义拼写，不重复占一个菜单位，因此不登记为独立命令——**不是缺口** |
| 正文累积引擎 | `finalized-segments` 引擎：`isFinal` 是**逐条** agent_message 的完成信号，按消息边界切成已定稿段，完成态投影成 normalized messages 走折叠判定，`finalText()` 取定稿段合成 | `buffer-replace` 引擎：`isFinal` 用该条全文整体替换单一缓冲，无消息投影，`finalText()` 即整段缓冲 | 两侧 `isFinal` 的含义本来就不同，presenter 按 `mode` 实例化**两个独立引擎**（`createSegmentsEngine` / `createBufferEngine`）。**改正文累积相关逻辑时两个引擎要分别核对**——它们只共享接口，不共享实现 |
| `/start` | **无** | **有** | Telegram 私聊首次交互必发 `/start`（START 按钮）；官方 bot 的首次交互走服务端 deep-link 绑定流程，不需要这条命令。见注册表 `parityNote`——这是**唯一一条个人侧独有**的命令 |
| typing 保活总上限 | 10 分钟 + 设备在线门控 | 5 分钟（`typingKeepaliveMaxMs`） | 超过即停发，turn 异常悬挂时不无限打 API。官方那档带设备在线门控，跨服务端，本仓兑现不了——已在 `presentationCapabilities.ts` 声明为车道差异 |
| lane 模型 | per-principal | per-chat | 已在 `presentationCapabilities.ts` 声明 |
| `message_thread_id` 的**归属判据在哪一侧** | 在**服务端**：桌面这半拿不到 `is_topic_message`（协议 payload 里没有这个字段），只按服务端下发的 threadId 分桶 | 在**客户端**：入站消息走 `laneThreadIdOf`、卡片回调走 `parseCallbackQuery`，都用 `is_topic_message === true` 门控——不是 forum topic 就记进主群流（threadId 空串） | 这个字段有**两个含义**，混用会出真故障：Telegram 对**普通群的 reply 链**也会给 `message_thread_id`（值 = reply root）。**投递位置**用裸值（带上它消息就投对地方，个人侧的出站与 typing 即如此；服务端 `topicThreadIdOf` 的注释也明写「不要拿归属标识替换投递位置参数」）；**归属**必须靠 `is_topic_message` 门控。而这个门控字段**只有持有 Telegram 连接的那一侧拿得到**——个人 bot 直连拿得到，官方 bot 的桌面这半只拿服务端下发的 payload，所以判据只能在服务端。这是架构决定的车道差异，不是谁漏做，已在 `presentationCapabilities.ts` 声明为 `threadIdDualSemantics`。**曾经的实机故障**：服务端早期把普通群 reply 链的 `message_thread_id` 当 topic 下发，那些发言散进一个个 reply-root 桶，agent 在群里答「我看不到群里的历史消息」（2026-08-03 实测：172 条在主群流、另有若干 reply-root 桶）。服务端现已按 `is_topic_message` 门控（`controller.ts` 的 `topicThreadIdOf`；**是否已上生产未核**），客户端保留一层兜底救存量错桶行——`buildGroupContextPrefix` 的 `fallbackThreadFilter` 让**主群流**额外读所有非空 threadId 的行（宁可多读同群发言、不可漏读），**topic lane 不读兜底集**：topic 之间严格隔离的优先级高于补读，代价是存量错桶行在 topic lane 里仍看不到 |
| 终稿特效 `messageEffectId` | 有 | 无 | 官方装饰位，已声明 |
| 交互卡的**渲染** | 按钮**每行一个**；`plan_review` / 权限卡的按钮文案在服务端硬编码；权限卡的工具入参是**单行 JSON 摘要**、上限 600（`HOOK_PERMISSION_INPUT_SUMMARY_MAX`）；截断用单行省略号（`truncateInline`） | label ≤12 字时**两个按钮并排**（`cardLayout.ts` 的 `pairLabelMax`）；按钮文案走 ui 文案包；权限卡入参是 **pretty JSON 代码块**、上限 800（`IM_PERMISSION_INPUT_PREVIEW_MAX`）；截断用折行「…(已截断)」（`truncateBlock`） | 两处都写着裁决，不是漂移。`interactionCardModel.ts` 的模块注释：**渠道差异不在语义层统一——统一是产品决策，不归那个模块**；`plan_review` 与权限卡的选项在语义层就是 `label: null`，文案本来就由各自渲染侧给。`cardLayout.ts` 更直接：**刻意不采用官方那套渲染参数**，因为那是「待退役的服务端渲染栈」的值，合同明确不得成为共享参数源。另有一条硬约束让分层无法合并：`@cindy/im` 不得依赖 `apps/desktop`，所以语义层（desktop 包）与渲染层（`@cindy/im`）必然是两个包、各持一份。这一档的寿命跟着第四节第 2 行走：msg.op 接线后官方出站改由桌面驱动，服务端那套渲染参数会一起退役。**两侧的按钮字数上限与按钮数上限不在这一档**——见表下说明 |

### 交互卡上：看起来不同、但用户看不见的几个数

这几对数字很容易被下一个人当成差异登记进来，先在这里钉死：

- **按钮文案上限 60（官方）/ 64（个人）——不生效**。两侧 builder 都先按共享的
  `BTN_LABEL_MAX = 30` 截过每个按钮文案（`hook-control/interactions.ts` 与
  `im/shared/cardBuilders.ts` 各自 `truncate(..., BTN_LABEL_MAX)`），传输层那两个数
  永远轮不到它们。**有效上限两侧同为 30。**
- **按钮数上限 20（官方）/ 协议 24——不生效**。选项被共享的 `MAX_OPTIONS = 6` 限死，
  `plan_review` 固定 2 个按钮、权限卡固定 3 个，离 20 差得远。
- **卡片正文 4000 / 3800——几乎不生效**。plan 正文有共享的 `MAX_PLAN_LEN = 1500`、
  权限入参有 600 / 800，都撞不到；只有 `ask_user_question` 的问题正文不受语义层约束，
  超长时才可能被这两个数切到——而它们都在 Telegram 的 4096 之下，差的是约 200 字余量。

上面三条都是**下游传输层的安全阈值**，不是产品差异。真正用户看得见的渲染差异只有
第三节那一行列的：按钮排布、按钮文案来源、权限入参的渲染形态与上限、截断省略号样式。

## 四、缺口（待办）

按用户能感知的程度排序。

| # | 缺口 | 现状 | 归属 |
|---|---|---|---|
| 1 | **个人 bot 缺 3 条命令** | `/unbind`（清当前 chat 的项目映射）、`/effort`（思考强度）、`/agent`（切 Agent）官方有、个人无，目前只能在桌面端改。注册表已显式登记并由 CI 拦住 | 每条各自独立 PR |
| 1b | **官方命令镜像没有跨仓校验** | 注册表里官方那一半是手抄的声明性镜像，服务端单方面加减命令这边不会红 | 待判：把 `TELEGRAM_COMMANDS` 放进 `cindy-protocol` 两侧生成，或在服务端加反向校验。要跨仓改动与一次协议版本推进 |
| 2 | **msg.op 动词只接了一个** | 服务端全套动词在 `xindong/cindy-server#349`（未合）；桌面侧目前只消费 `react`（ack 表情，见 `hook-control/ackReactions.ts` 的 `HOOK_FEATURE_MESSAGE_OPS` 判据）。`send` / `edit` / `delete` / `typing` / `media` 未接线 | #1855 第三刀。**这是把官方 bot 的出站改由桌面驱动的关键一步**——接完之后两侧的发射与收口才可能走同一份代码，而不是各写一套 |
| 2b | **NO_REPLY 哨兵官方只在 ambient 轮次生效** | 个人侧**全轮次**生效（`noReplyScope: 'all-turns'`）：`streamingText.finalize` 的哨兵判定不带 ambient 门控。但**「零出站」只在惰性占位还没建过消息时成立**——哨兵前已经有正文流出的轮次消息已经发出去了，finalize 走的是**尽力撤回**：`deleteMessage` 失败被 `catch` 吞掉，那条停在过程态的消息就留在聊天里。官方只在 ambient 轮次生效，且删不掉时**不吞**——`discardProgressMessage` 返回 false，标 `retainAmbientCleanup` 并留给下一拍重试。`presentationCapabilities.ts` 把范围差异明写为**跨服务端 TODO**，即「想统一但要动服务端」，**不是**已裁决的产品差异，所以只登记在这里、不进第三节 | 待判：要统一得改服务端的哨兵判定。失败出口的差异（吞 vs 重试）一并判 |
| 2c | **链接预览关闭两边各写一套，覆盖面还不一样** | 个人侧读契约 `linkPreviewDisabled: true`，driver 在**答案这条路**上全部消费——正文/过程消息的发送、分段发送、编辑，以及 HTML 解析失败后的纯文本回落；**卡片消息、陌生人提示、主人通知不带**。官方侧**不读这个契约**（在服务端仓 `telegram/client.ts` 里写死 `{ is_disabled: true }`），且只写在两处：`sendAdaptiveMessage` / `editAdaptiveMessage` 的 **HTML 回落**分支；纯文本的 `sendMessage` / `editMessageText`（权限卡、通知、附件转发、续跑提示，以及 adaptive 最后一层纯文本回落）都不带，链接预览按 Telegram 默认开着。两侧的 rich 主路径（`rich_message` payload）都不带这个参数，其预览行为**未核**——非公开 API | 待判：要么把参数补进官方的纯文本出站，要么把这条策略升进 `cindy-protocol` 两侧共用。跨仓 |
| 2d | **行为配置（表情、回复引用、群参与模式）两边各写一套** | 档位形状与默认值两侧**逐字相同**：`emojiReactions` off/minimal/expressive 默认 minimal、`replyQuoteGroup` off/first/all 默认 first、`replyQuoteDm` off/first 默认 off、`groupActivation` per-chat mention/always **默认 mention**（个人 `?? 'mention'`；官方的协议注释写「只列偏离默认值的群，缺席 = mention」）。但声明与正本有两份——官方读 `cindy-protocol` 的 `DEFAULT_TELEGRAM_BEHAVIOR`，**正本存服务端**，桌面只负责写 override（`hook-control/manager.ts` 把 `mention` 表达成 `null` 清除）与投影设置卡的群清单（`hook-control/groupWindow.ts` 把已知群与 activation 合并），且 hydrate 失败时**故意留「未知」而不套基线**；个人读 `@cindy/im` 的 `TELEGRAM_DEFAULT_BEHAVIOR`，正本是本地 owner-scoped JSON（`im/telegram/behaviorStore.ts`）。**判 ambient 的也是不同一侧**：个人在客户端判（`packages/lizi-im/src/telegram/index.ts` 读 activation 打 ambient 标），官方在服务端判（`controller.ts` 算出 `ambient` 再下发）。值现在一样，但没有任何东西拦着它们分叉。注意：`turnPresenter.ts` / `presentationCapabilities.ts` 里「不含 replyQuote」的裁决说的是**不进共享能力契约**，不是「两个 bot 该长得不一样」——别把它读成有意差异 | 待判：个人侧能否直接改读 `cindy-protocol` 的 `DEFAULT_TELEGRAM_BEHAVIOR`（值一样，是最省事的一次真统一），先核 `@cindy/im` 对 `cindy-protocol` 的依赖方向允不允许（`docs/dev-rules/architecture-invariants.md`）。**与第 6 行分工**：那行是「何时打表情」的判据，这行是「档位的声明、默认值与正本存哪」 |
| 2e | **私聊里能不能跨群检索：个人有、官方没有** | **群轮次两侧一致**（都 lane-only，只查当前群/topic）。差别只在私聊。个人：`groupHistoryAccessFor` 在无 lane（即 DM）时给 `access: 'owner'`，owner 可以显式指定别的 lane，跨群查这个 bot 名下全部群历史。官方：私聊的 externalKey 不是群 lane，`groupHistoryAccessForExternalKey` 返回 `undefined`，MCP 直接以 `NO_ACTIVE_TELEGRAM_SCOPE` 拒绝——**官方 bot 私聊里这个工具根本不可用**（MCP 工具自己的说明也写着「只有主人触发的个人 Telegram 轮次可显式指定其它精确 lane」）。个人侧「群轮次一律 lane-only」有 2026-07-30 的明确裁决（群里的可控文本能借 owner 轮次把别的 lane 检索出来回帖泄漏，而检索类调用没有确认卡兜底）；**官方私聊这一档没有对应裁决**——是没接，不是判过，所以归缺口不归第三节 | 待判，**不在本 PR 改代码**。补之前先答一个产品问题：官方 bot 绑的是一个主账号，它的私聊该不该看到该账号名下全部群的历史。答「该」才是接线问题（DM 的 externalKey 里有 principal，能推出 `telegram:<principalId>` 的 owner 档）；答「不该」就把这行升进第三节当有意差异 |
| 2f | **群里开了「全响应」后，一轮失败：个人 bot 会往群里吐错误，官方静默** | 全响应（`always`）本身两侧行为一致：未被召唤的消息也进 turn 并打 ambient 标、**不 typing、不表情**、模型可用 NO_REPLY 闭嘴、纯媒体/无正文消息不进（个人 `if (!plain) return`，官方 `plain.length > 0`）；连 ambient 提示词都逐字相同（各写一份，跨仓无校验）。**分歧只在这一轮失败的时候**：官方不发失败通知（`controller.ts` 的 `finalFailureNoticeSent !== true && !entry.ambient`），并把过程消息删掉、记一句「completed silently」；个人侧的 `im/shared/turnRunner.ts` **完全不认识 ambient**（全文没有这个词），错误一律走 `❌ 错误：…`——惰性占位这时会被真建出来，于是群里凭空多一条错误消息，而这一轮本来连话都不打算说 | 待判，**不在本 PR 改代码**。倾向跟官方一致做静默（与「ambient 不打扰群」的既有取舍同一个方向），但要保证错误不因此彻底消失——至少落桌面端日志与该会话，不能只是吞掉 |
| 3 | **终稿必达只有官方有** | 官方侧终稿先落盘、失败重试到送达或有界放弃（`xindong/cindy-server#348`）。个人 bot 的 `streamingText.finalize` 是进程内尽力而为，桌面进程挂掉那条终稿就没了 | 待判：个人侧是否需要等价保障，还是接受「桌面挂了本来就没人在跑」 |
| 4 | 受保护群内容的隐私边界 | 个人侧已做（出站回流 fail-closed，任一分片带保护标即整条不回流）。官方侧是否等价**待核** | 待核 |
| 5 | 相册失败逐张回落 | 两侧都有实现，判据是否等价**待核** | 待核 |
| 6 | ack / 结果表情 | 两侧都有，判据（何时打、打什么、撤不撤）是否等价**待核** | 待核 |

## 五、怎么用这张表

1. **动任一 bot 的用户可见行为前**，先看这里有没有对应行。
2. 发现新的差异：先判它属于哪一档。是「有意不同」就补进第三节并写清裁决来源；是缺口
   就进第四节并给出归属，**不要在当前 PR 里顺手补**——同族缺口一次覆盖比逐轮补边界
   便宜得多（`xindong/cindy-server#348` 十九轮 review 的教训）。
3. 第四节里标「待核」的行，核完就把结论写回来，不要让它一直挂着。**核出来是同源
   就搬进第一节**——缺口那一档写着「该动它」，而同源的东西不该动；把已经统一好的
   能力留在缺口里，下一个人会去"补"一遍已经有的东西。（群消息保留策略就是这样：
   挂了几轮「待核」，核完发现两侧本来就跑同一份回收实现。）
   **同一件事只能挂一档**——「有意不同」与「缺口」的区别就是「不要动它」和「该动它」，
   两边都放等于同时说了两句相反的话。想让缺口带上现状说明，就把说明写进缺口那一行。
4. 判「同源」之前，**读那条路径最后真正交出去的是什么**，不要读模块注释就下结论。
   成功与失败要分开看——本表初版曾把只对成功收口成立的不变量泛化到失败路径。
   同理，**别把"通常这样"写成无条件**：长终稿会分段新发、原位编辑失败会 repost、
   第一帧建消息会推送、NO_REPLY 在已经建过消息时只是尽力撤回（删不掉就留着），
   这些边界都被本表的早期版本漏掉过。
   反过来也要小心：**两个不一样的数不等于两种用户可见行为**。登记之前先往上游看一眼
   有没有更小的共享上限已经把它挡住了——交互卡的按钮字数 60 / 64 就是这样，看着差
   4 个字，实际都被共享的 30 截过，谁也见不到（第三节表下有专门一段钉这件事）。
   还有一条同族的：**布尔契约字段的名字说的是策略，不是覆盖面**。`linkPreviewDisabled`
   / `progressSilent` 这种字段要数它实际挂在哪几个调用点上——个人侧的链接预览只关在
   答案那条路上，卡片与提示类消息并不带（见第四节 2c），字段名读起来却像"全关"。
5. 命令的**分类**以 `botCommands.ts` 的 `parityNote` 为准——本表只是把它的结论摊开讲，
   两边对不上时改本表、不改注册表。但注意注册表里**官方那一半是跨仓镜像**：改命令时
   服务端的 `TELEGRAM_COMMANDS` 也要一起核对，CI 拦不住它漂移。

## 相关

- 命令注册表：`apps/desktop/src/main/im/shared/botCommands.ts`
- 呈现大脑：`apps/desktop/src/main/im/shared/turnPresenter.ts`
- 呈现能力契约：`packages/lizi-im/src/telegram/presentationCapabilities.ts`
- 任务 / 对话 / 消息的用词：`docs/product-rules/task-and-conversation-naming.md`

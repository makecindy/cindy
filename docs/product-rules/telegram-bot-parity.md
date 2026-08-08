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
> 初版据此把「终稿保留过程区」写成了两侧差异，实际两侧在收口时都只交正文。

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

| 能力 | 单一真相源 | 共享到什么程度 |
|---|---|---|
| 过程区与正文的**文本合成** | `im/shared/turnPresenter.ts` + `turnActivity.ts` | 过程区怎么排（工具步骤、思考步骤、耗时行）、过程区与正文怎么拼（`composeProgressView`）。**正文累积不算**——见第三节：`createTurnPresenter` 按 `mode` 实例化两个独立引擎，累积、消息投影、`finalText()` 判据都不同，改一个引擎不影响另一个 |
| 进度节流**间隔** | `PresenterPolicy.intermediateThrottleMs` | 只有这一个值两侧都读。**长度上限不算**——见下表 |
| 群历史检索核心 | `im/shared/groupHistoryAccess.ts` | 官方侧由 `hook-control/groupHistoryScope.ts` 把官方 externalKey 解析成同一套 access scope，两侧检索走同一实现 |

### 放在共享目录、但**只有一侧消费**的

| 东西 | 实际情况 |
|---|---|
| `im/shared/channelToolPolicy.ts` 的 `channelForceConfirmToolCall` | 只被个人 Telegram / 微信 / 钉钉的权限策略引用。**官方 bot 不挂**——见第三节的裁决。放在 `shared/` 下是因为个人侧三个渠道共用，不代表两个 bot 共用 |
| `packages/lizi-im/src/telegram/presentationCapabilities.ts` | 只导出并由**个人 driver** 消费 `TELEGRAM_PERSONAL_CAPABILITIES`，没有官方 bot 共用的契约数据。它的作用是把车道差异写在一处，不是让两侧取同一份值 |
| `PresenterPolicy.intermediateMaxRenderedChars`（长度上限） | **只有官方那条路消费**（`createProgressEmitter`）。个人侧用自己的私有常量 `INTERMEDIATE_EDIT_LIMIT = 3800`（`streamingText.ts`）判断何时停止编辑。**改共享的长度策略只会改到官方 bot**——两处独立维护，改一处必须核对另一处 |
| `im/shared/botCommands.ts` 的**官方那一半** | 官方 bot 的命令**仍由服务端 `TELEGRAM_COMMANDS` 下发**，本表对官方侧是「声明性镜像、不接线」。测试只用内联清单核对镜像，**服务端改了命令这边完全可能不同步**。个人侧那一半是真的单一真相源（菜单与分发直接读它）；官方那一半是跨仓镜像，**改命令要两个仓一起核对** |

进度帧去重的三槽基线（`shouldEmitProgressFrame` / `createProgressEmitter`）同理：只在注入
`onProgress` 时启用，也就是**只有官方那条路在用**，个人侧不消费。

## 二、消息生命周期——按阶段逐格对照

`turnPresenter` 统一的是"这一刻该显示什么"这段文本。"这段文本发给谁、放在哪、什么时候
变、最后落在哪"由各消费方自己负责（模块注释明写：收口不在 presenter 里）。

| 阶段 | 个人 bot | 官方 bot |
|---|---|---|
| 首帧 | 有真实内容（含工具步骤）就建一条**真实消息**；空内容不建（惰性占位） | 快照进 `turn.progress` 帧发给服务端 |
| 过程中 | **同一条消息持续 `editMessageText` 覆盖**，用户看着它长大：过程区在上、正文在下 | **私聊**：进 Telegram **草稿**（`sendDraft`）——在输入框那个位置，**不在消息流里**；**群**：一条进度消息，`editMessageText` 覆盖 |
| 终稿内容（**成功收口**） | **只有正文**（`composeStreamingView` 在 `turn.done` 时直接 `return body`，不再合成过程区） | **只有正文**（`presenter.finalText()` 取 body 引擎的缓冲，不经过 `composeProgressView`） |
| 终稿落在哪 | **还是那条消息**，原地定稿（编辑失败才 repost） | **私聊**：新发一条正文消息，草稿随之消失；**群**：编辑那条进度消息 |
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
| 私聊过程态的载体 | Telegram **草稿**（`sendDraft`），终稿一发草稿自然消失 | 真实消息，原地 `editMessageText` 覆盖 | 草稿只有官方路径拿得到；个人栈靠惰性占位 + 编辑不推送达到同样的「过程帧零推送」效果 |
| `/status` | 有 | 无 | 官方 bot 经服务端中继，链路可断，所以有「关联状态」可看；个人 bot 由桌面直连 Bot API，没有等价概念。见注册表 `parityNote` |
| `/unlink` | 有 | 无 | 官方 bot 的关联由服务端持有；个人 bot 的 token 是用户自填的，解绑入口在桌面设置页 |
| `/workspace` | 独立命令 | `/project` 的**别名** | 服务端两条菜单文案逐字相同。个人 bot 用别名表达同义拼写，不重复占一个菜单位，因此不登记为独立命令——**不是缺口** |
| 正文累积引擎 | `finalized-segments` 引擎：`isFinal` 是**逐条** agent_message 的完成信号，按消息边界切成已定稿段，完成态投影成 normalized messages 走折叠判定，`finalText()` 取定稿段合成 | `buffer-replace` 引擎：`isFinal` 用该条全文整体替换单一缓冲，无消息投影，`finalText()` 即整段缓冲 | 两侧 `isFinal` 的含义本来就不同，presenter 按 `mode` 实例化**两个独立引擎**（`createSegmentsEngine` / `createBufferEngine`）。**改正文累积相关逻辑时两个引擎要分别核对**——它们只共享接口，不共享实现 |
| lane 模型 | per-principal | per-chat | 已在 `presentationCapabilities.ts` 声明 |
| 终稿特效 `messageEffectId` | 有 | 无 | 官方装饰位，已声明 |

## 四、缺口（待办）

按用户能感知的程度排序。

| # | 缺口 | 现状 | 归属 |
|---|---|---|---|
| 1 | **个人 bot 缺 3 条命令** | `/unbind`（清当前 chat 的项目映射）、`/effort`（思考强度）、`/agent`（切 Agent）官方有、个人无，目前只能在桌面端改。注册表已显式登记并由 CI 拦住 | 每条各自独立 PR |
| 1b | **官方命令镜像没有跨仓校验** | 注册表里官方那一半是手抄的声明性镜像，服务端单方面加减命令这边不会红 | 待判：把 `TELEGRAM_COMMANDS` 放进 `cindy-protocol` 两侧生成，或在服务端加反向校验。要跨仓改动与一次协议版本推进 |
| 2 | **msg.op 动词只接了一个** | 服务端全套动词在 `xindong/cindy-server#349`（未合）；桌面侧目前只消费 `react`（ack 表情，见 `hook-control/ackReactions.ts` 的 `HOOK_FEATURE_MESSAGE_OPS` 判据）。`send` / `edit` / `delete` / `typing` / `media` 未接线 | #1855 第三刀。**这是把官方 bot 的出站改由桌面驱动的关键一步**——接完之后两侧的发射与收口才可能走同一份代码，而不是各写一套 |
| 3 | **终稿必达只有官方有** | 官方侧终稿先落盘、失败重试到送达或有界放弃（`xindong/cindy-server#348`）。个人 bot 的 `streamingText.finalize` 是进程内尽力而为，桌面进程挂掉那条终稿就没了 | 待判：个人侧是否需要等价保障，还是接受「桌面挂了本来就没人在跑」 |
| 4 | 受保护群内容的隐私边界 | 个人侧已做（出站回流 fail-closed，任一分片带保护标即整条不回流）。官方侧是否等价**待核** | 待核 |
| 5 | 相册失败逐张回落 | 两侧都有实现，判据是否等价**待核** | 待核 |
| 6 | ack / 结果表情 | 两侧都有，判据（何时打、打什么、撤不撤）是否等价**待核** | 待核 |
| 7 | 群消息本地库与保留策略 | 个人侧按大小保留；官方侧的群窗口是否共用同一套保留判据**待核** | 待核 |

## 五、怎么用这张表

1. **动任一 bot 的用户可见行为前**，先看这里有没有对应行。
2. 发现新的差异：先判它属于哪一档。是「有意不同」就补进第三节并写清裁决来源；是缺口
   就进第四节并给出归属，**不要在当前 PR 里顺手补**——同族缺口一次覆盖比逐轮补边界
   便宜得多（`xindong/cindy-server#348` 十九轮 review 的教训）。
3. 第四节里标「待核」的行，核完就把结论写回来，不要让它一直挂着。
4. 判「同源」之前，**读那条路径最后真正交出去的是什么**，不要读模块注释就下结论。
   成功与失败要分开看——本表初版曾把只对成功收口成立的不变量泛化到失败路径。
5. 命令的**分类**以 `botCommands.ts` 的 `parityNote` 为准——本表只是把它的结论摊开讲，
   两边对不上时改本表、不改注册表。但注意注册表里**官方那一半是跨仓镜像**：改命令时
   服务端的 `TELEGRAM_COMMANDS` 也要一起核对，CI 拦不住它漂移。

## 相关

- 命令注册表：`apps/desktop/src/main/im/shared/botCommands.ts`
- 呈现大脑：`apps/desktop/src/main/im/shared/turnPresenter.ts`
- 呈现能力契约：`packages/lizi-im/src/telegram/presentationCapabilities.ts`
- 任务 / 对话 / 消息的用词：`docs/product-rules/task-and-conversation-naming.md`

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

判定口径三档：

| 档 | 含义 |
|---|---|
| **同源** | 字面上同一份代码/同一份数据在两侧生效，不可能漂移 |
| **有意不同** | 已经裁决过的差异，**不要去"统一"它**，动它要先推翻裁决 |
| **缺口** | 该有而没有，或两边各写一套。这一列是待办 |

---

## 一、已同源

| 能力 | 单一真相源 | 说明 |
|---|---|---|
| 过程区时间线 / 工具调用与思考步骤渲染 | `im/shared/turnPresenter.ts` + `turnActivity.ts` | 注释里写明两个消费方：官方走 `hook-control/turnObserver`，个人走 `im/shared/turnRunner`。节流（1.5s 尾随 + 5s 低频刷新）、帧去重的三槽基线也在这里 |
| 命令面 | `im/shared/botCommands.ts` | `surfaces` 标注谁有谁没有；单侧独有必须写 `parityNote`，缺了 CI 红 |
| 群历史检索核心 | `im/shared/groupHistoryAccess.ts` | 官方侧由 `hook-control/groupHistoryScope.ts` 把官方 externalKey 解析成同一套 access scope；检索核心不认识协议 key |
| 群轮次破坏性操作的判据 | `im/shared/channelToolPolicy.ts` 的 `channelForceConfirmToolCall` | 个人 Telegram / 微信 / 钉钉共用（**官方 bot 不挂这条策略，见第二节**） |
| 呈现能力契约 | `packages/lizi-im/src/telegram/presentationCapabilities.ts` | typing 续命间隔/上限、link preview、NO_REPLY 生效范围等由 driver 直接消费；车道差异在同一处声明 |

## 二、有意不同（已裁决，不要"统一"）

| 差异 | 官方 | 个人 | 裁决与理由 |
|---|---|---|---|
| 群轮次权限档 | 完全按用户配的走 | 所有群轮次强制确认破坏性操作 | Chris 2026-08-03 实踩裁决：用户选了「完全访问」，官方 bot 却在群里静默跑 `ask` 并弹卡，设置与实际对不上。**完全访问就是完全访问**，不得在运行期另起一套隐式权限配置。官方 bot 的群聊定位是引导用户装自己的个人 bot，不承担「群里多人共用一个 bot」的权限模型——那套已在个人 bot 里设计过。见 `hook-control/session-runner.ts` |
| 正文累积语义 | `finalized-segments`：`isFinal` 是**逐条** agent_message 的完成信号，按消息边界切成已定稿段 | `buffer-replace`：`isFinal` 用该条全文整体替换累积缓冲 | 两侧 `isFinal` 的含义本来就不同，presenter 做成显式 `mode` 参数，不强行统一（`turnPresenter.ts` 开头注释） |
| 私聊过程态的载体 | Telegram **草稿**（`sendDraft`），终稿一发草稿自然消失 | 真实消息，原地 `editMessageText` 覆盖 | 草稿只有 bot API 的官方路径拿得到；个人栈靠惰性占位 + 编辑不推送达到同样的「过程帧零推送」效果 |
| lane 模型 | per-principal | per-chat | 已在 `presentationCapabilities.ts` 声明 |
| 终稿特效 `messageEffectId` | 有 | 无 | 官方装饰位，已声明 |

## 三、缺口（待办）

按用户能感知的程度排序。

| # | 缺口 | 现状 | 归属 |
|---|---|---|---|
| 1 | **个人 bot 缺 6 条命令** | `/workspace` `/unbind` `/effort` `/agent` `/status` `/unlink` 官方有、个人无。注册表已显式登记并由 CI 拦住，功能本身未实现 | 每条各自独立 PR |
| 2 | **msg.op 动词只接了一个** | 服务端全套动词在 `cindy-server#349`（未合）；桌面侧目前只消费 `react`（ack 表情，见 `hook-control/ackReactions.ts` 的 `HOOK_FEATURE_MESSAGE_OPS` 判据）。`send` / `edit` / `delete` / `typing` / `media` 未接线 | #1855 第三刀。**这是把官方 bot 的消息呈现改由桌面驱动的关键一步**——接完之后官方 bot 的出站与个人 bot 走同一套呈现代码，第一节的「已同源」才能从渲染扩展到出站 |
| 3 | **终稿必达只有官方有** | 官方侧终稿先落盘、失败重试到送达或有界放弃（`cindy-server#348`）。个人 bot 的 `streamingText.finalize` 是进程内尽力而为，桌面进程挂掉那条终稿就没了 | 待判：个人侧是否需要等价保障，还是接受「桌面挂了本来就没人在跑」 |
| 4 | 受保护群内容的隐私边界 | 个人侧已做（出站回流 fail-closed，任一分片带保护标即整条不回流）。官方侧是否等价**待核** | 待核 |
| 5 | 相册失败逐张回落 | 两侧都有实现，判据是否等价**待核** | 待核 |
| 6 | ack / 结果表情 | 两侧都有，判据（何时打、打什么、撤不撤）是否等价**待核** | 待核 |
| 7 | 群消息本地库与保留策略 | 个人侧按大小保留；官方侧的群窗口是否共用同一套保留判据**待核** | 待核 |

## 四、怎么用这张表

1. **动任一 bot 的用户可见行为前**，先看这里有没有对应行。
2. 发现新的差异：先判它属于哪一档。是「有意不同」就补进第二节并写清裁决来源；是缺口
   就进第三节并给出归属，**不要在当前 PR 里顺手补**——同族缺口一次覆盖比逐轮补边界
   便宜得多，这是 `#348` 十九轮 review 的教训。
3. 第三节里标「待核」的行，核完就把结论写回来，不要让它一直挂着。

## 相关

- 命令注册表：`apps/desktop/src/main/im/shared/botCommands.ts`
- 呈现大脑：`apps/desktop/src/main/im/shared/turnPresenter.ts`
- 呈现能力契约：`packages/lizi-im/src/telegram/presentationCapabilities.ts`
- 任务 / 对话 / 消息的用词：`docs/product-rules/task-and-conversation-naming.md`

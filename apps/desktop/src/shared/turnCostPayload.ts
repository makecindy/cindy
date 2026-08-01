/**
 * turnCostPayload — `usage:message-turn-cost` 的跨进程 payload 契约。
 *
 * 放在 shared 而不是 main:它是 main → renderer 的协议,两侧都要引用。曾经 main 与
 * preload 声明各写一份,漂移出「main 已放宽为可选、renderer 仍声明必填」的状态,消费方
 * 能在 typecheck 通过的情况下解引用 undefined;而让 renderer 的类型图反向 import main
 * 实现模块又会把 Electron / 数据库 / 调度器副作用拖进 renderer 工具链,违反
 * electron-security-and-process-boundaries.md §2 的分层(shared 只存跨进程协议、类型、
 * 常量和纯函数)。收在这里两个问题一起解决。
 */

import type { RegionalMoney } from './regionalMoney.js';
import type { TurnUsageDetails } from './turnUsageDetails.js';

/**
 * 金额字段整组可选:无报价轮(main 的 recordTurnUsageOnMessage)只带 turnUsageDetails,
 * 消费方据此退回 token 展示;若本用户轮此前已产生费用,则额外带 userTurnMoney 累计
 * (当前无价 segment 不入账,但已花的钱要继续可见)。有金额的轮次这些字段成组出现。
 *
 * ── 不变量:三个事实各自独立 ────────────────────────────────────────────────
 * `turnMoney`(当前 segment 费用)、`userTurnMoney`(本用户轮累计)、
 * `turnUsageDetails`(本轮 token 用量)是**三个互不蕴含的事实**。合法组合包括
 * 「只有 token」「token + 累计金额」「三者齐全」——「有累计金额但当前 segment 无价」
 * 正是自动续跑的收尾轮:前面的 segment 记了账,收尾那个缺报价。
 *
 * 因此每一条消费路径都必须**分别判定**这三个字段,不得把其中一个的解析嵌进另一个
 * 的条件分支里。此前反复踩的就是这一条:把 userTurnMoney 放在 `turnMoney > 0` 之内,
 * 于是收尾轮的操作栏用 token 顶掉了整轮已经花掉的钱。
 *
 * 对称路径共 5 条(改动其中任意一条时,请逐条核对另外四条):
 *   1. Desktop 实时  — renderer/lib/makerChatStore.ts handleUsageMessageTurnCostRaw
 *   2. Desktop 历史  — renderer/lib/makerChatStore.ts buildChatMessages
 *   3. Mobile 实时   — apps/mobile/src/session/remoteSessionStore.ts usage:message-turn-cost
 *   4. Mobile 历史   — apps/mobile/src/session/messageNormalize.ts readTurnCost
 *   5. 展示取值      — MessageActionBar(desktop) / MessageRenderer(mobile):
 *                      金额 = userTurnMoney ?? turnMoney,两者皆无才回退 token
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface MessageTurnCostPayload {
  sessionId: string;
  /** 该轮最后一条 assistant 的 messages.client_id。 */
  clientId: string;
  turnMoney?: RegionalMoney;
  turnCostUsd?: number;
  turnCostIsEstimate?: boolean;
  /** User-visible cumulative cost from the latest real user prompt through this message. */
  userTurnMoney?: RegionalMoney;
  userTurnCostUsd?: number;
  /** True when any segment in userTurnCostUsd is a subscription-value estimate. */
  userTurnCostIsEstimate?: boolean;
  /** 本轮 token/cache 明细;旧消息或取不到 usage 时缺省。 */
  turnUsageDetails?: TurnUsageDetails;
}

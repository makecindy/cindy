/**
 * 目标模式已不在运行时的状态说明(goal inactive note)。
 *
 * 目标运行期间,每个续跑轮都在 user message 后缀里要求模型"每轮末尾吐 goal_status
 * 裁决块"(见 directive.ts)。目标清除 / 完成 / 暂停 / 受阻后不再追加该指令,但历史
 * 轮次仍留在 agent 原生上下文里,模型会照着自己前面的回复继续吐裁决块,还会以为自己
 * 会被自动续跑,向用户承诺"剩下由我继续处理"。
 *
 * 机制与计划对账(maker-ipc/planReconcile.ts)同一条搭车通道:每次普通发送时现查,
 * 若会话没有仍会续跑的目标、而上一条 assistant 回复末尾仍带裁决块,就在 wire payload
 * 前插一段说明。不落库、不新增状态:模型一旦不再吐块,条件自然失效;重启后照样生效。
 * goal controller 自己发起的续跑轮直接走 session.send,不经过这些入口。
 */

import { eq } from "drizzle-orm";
import { sessionGoals } from "@cindy/runtime-db/schema";

import {
  shouldPrependGoalInactiveNote,
  buildGoalInactiveNote,
} from "@cindy/im-runtime/goalInactiveNote";
export {
  hasTrailingGoalVerdictBlock,
  shouldPrependGoalInactiveNote,
  buildGoalInactiveNote,
  type GoalContinuationState,
} from "@cindy/im-runtime/goalInactiveNote";
import type { DbClient } from "@cindy/runtime-db";
import type { createLatestMessageText } from "../latestMessageText.js";

export function createGoalInactiveNote(host: {
  getDbClient(): DbClient;
  latestNonEmptyMessageText: ReturnType<
    typeof createLatestMessageText
  >["latestNonEmptyMessageText"];
}) {
  const { getDbClient, latestNonEmptyMessageText } = host;

  /** 发送入口调用:命中条件返回说明文本,否则 null。读库失败由调用方静默跳过。 */
  async function peekGoalInactiveNote(
    sessionId: string,
  ): Promise<string | null> {
    const [goalRows, latestAssistantText] = await Promise.all([
      getDbClient()
        .drizzle.select({
          status: sessionGoals.status,
          usageResetAt: sessionGoals.usageResetAt,
        })
        .from(sessionGoals)
        .where(eq(sessionGoals.sessionId, sessionId))
        .limit(1),
      // 目标达成 / 用量恢复会落空正文的 assistant 记录,要跳过它们看真正的上一条回复。
      latestNonEmptyMessageText(sessionId, "assistant"),
    ]);
    return shouldPrependGoalInactiveNote({
      goal: goalRows[0] ?? null,
      latestAssistantText,
    })
      ? buildGoalInactiveNote()
      : null;
  }
  return {
    peekGoalInactiveNote,
  };
}

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

import { eq } from 'drizzle-orm';

import { stripGoalVerdictBlock } from '@cindy/maker-shared/goal-verdict';

import { getDbClient } from '../localDb/client/current.js';
import { latestNonEmptyMessageText } from '../localDb/latestMessageText.js';
import { sessionGoals } from '../localDb/schema.js';

/** 末尾围栏块的内文;回复不以围栏收尾时为 null。 */
function trailingFenceBody(text: string): string | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('```')) return null;
  const body = trimmed.slice(0, -3);
  const open = body.lastIndexOf('```');
  if (open < 0) return null;
  return body.slice(open + 3).replace(/^(?:jsonc?)?\s*/i, '');
}

function isGoalProtocolObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      ('goal_status' in parsed || 'goal_setup' in parsed)
    );
  } catch {
    return false;
  }
}

/**
 * 回复**末尾**是否带 goal_status / goal_setup 块。末尾围栏块按 JSON 解析(reason 含花括号
 * 也能认出),其余形态沿用显示层剥离的判据。
 */
export function hasTrailingGoalVerdictBlock(text: string): boolean {
  if (text === '') return false;
  const fenced = trailingFenceBody(text);
  if (fenced !== null && isGoalProtocolObject(fenced)) return true;
  return stripGoalVerdictBlock(text) !== text;
}

export interface GoalContinuationState {
  status: string;
  usageResetAt: number | null;
}

/** 目标仍会续跑:active 正在跑;usageLimited 且有重置时刻会到点自动恢复(controller 排的 timer)。 */
function goalStillContinues(goal: GoalContinuationState | null): boolean {
  if (!goal) return false;
  return goal.status === 'active' || (goal.status === 'usageLimited' && goal.usageResetAt != null);
}

export function shouldPrependGoalInactiveNote(input: {
  goal: GoalContinuationState | null;
  latestAssistantText: string;
}): boolean {
  return !goalStillContinues(input.goal) && hasTrailingGoalVerdictBlock(input.latestAssistantText);
}

export function buildGoalInactiveNote(): string {
  return [
    '[目标状态]本任务当前没有运行中的目标,之前回复末尾的 goal_status 裁决块只属于目标模式。',
    '本轮回复末尾不要再输出 goal_status 裁决块。',
    '这一轮结束后不会因目标模式被自动唤起继续:可以说明仍在后台运行的进程,但不要承诺会自己接着推进;',
    '需要持续推进时,建议用户开启目标模式或设置自动任务。',
    '== 状态说明结束,以下是用户的新消息 ==',
  ].join('\n');
}

/** 发送入口调用:命中条件返回说明文本,否则 null。读库失败由调用方静默跳过。 */
export async function peekGoalInactiveNote(sessionId: string): Promise<string | null> {
  const [goalRows, latestAssistantText] = await Promise.all([
    getDbClient()
      .drizzle.select({ status: sessionGoals.status, usageResetAt: sessionGoals.usageResetAt })
      .from(sessionGoals)
      .where(eq(sessionGoals.sessionId, sessionId))
      .limit(1),
    // 目标达成 / 用量恢复会落空正文的 assistant 记录,要跳过它们看真正的上一条回复。
    latestNonEmptyMessageText(sessionId, 'assistant'),
  ]);
  return shouldPrependGoalInactiveNote({
    goal: goalRows[0] ?? null,
    latestAssistantText,
  })
    ? buildGoalInactiveNote()
    : null;
}

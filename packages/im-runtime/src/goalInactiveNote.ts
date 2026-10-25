import { stripGoalVerdictBlock } from '@cindy/maker-shared/goal-verdict';

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


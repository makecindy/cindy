import { schedulePrTriggers, type Schedule, type Scheduler } from '@cindy/maker-scheduler';

export interface MultiPrSessionWarning {
  targetSessionId: string;
  siblingSchedules: Array<{ id: string; name: string; prUrls: string[] }>;
  message: string;
}

/**
 * Detect when an active PR follow-up schedule shares `targetSessionId` with another active
 * PR follow-up schedule watching a different PR URL. Cross-repo paired PRs may legitimately
 * share one task, so this returns a structured non-breaking advisory rather than blocking.
 */
export async function attachMultiPrSessionWarning(
  scheduler: Pick<Scheduler, 'list'>,
  schedule: Schedule,
): Promise<Schedule & { multiPrSessionWarning?: MultiPrSessionWarning }> {
  if (schedule.status !== 'active' || !schedule.targetSessionId) return schedule;
  const ownUrls = new Set(schedulePrTriggers(schedule).map((rule) => rule.url.toLowerCase()));
  if (ownUrls.size === 0) return schedule;
  let active: Schedule[];
  try {
    active = await scheduler.list({ status: 'active' });
  } catch {
    return schedule;
  }
  if (!Array.isArray(active)) return schedule;
  const siblings: Array<{ id: string; name: string; prUrls: string[] }> = [];
  for (const other of active) {
    if (other.id === schedule.id || other.targetSessionId !== schedule.targetSessionId) continue;
    const otherUrls = schedulePrTriggers(other).map((rule) => rule.url.toLowerCase());
    if (otherUrls.length === 0) continue;
    const hasDifferentPr = otherUrls.some((url) => !ownUrls.has(url));
    if (!hasDifferentPr) continue;
    siblings.push({ id: other.id, name: other.name, prUrls: otherUrls });
  }
  if (siblings.length === 0) return schedule;
  return {
    ...schedule,
    multiPrSessionWarning: {
      targetSessionId: schedule.targetSessionId,
      siblingSchedules: siblings,
      message:
        '目标会话已绑定其他活跃 PR 自动跟进调度；同一会话串行排队处理多条 PR 会互相阻塞并拖慢收口。除非为跨仓成对联动 PR，建议为不同 PR 各自创建独立任务跟进。',
    },
  };
}

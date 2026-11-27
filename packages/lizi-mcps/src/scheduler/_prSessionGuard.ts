import { schedulePrTriggers, type Schedule, type Scheduler } from '@cindy/maker-scheduler';
import type { SchedulerMcpDeps } from '../types.js';
import { qualifyRemoteSessionIds } from './_devices.js';

export interface MultiPrSessionWarning {
  targetSessionId: string;
  siblingSchedules: Array<{ id: string; name: string; prUrls: string[] }>;
  message: string;
}

function isScheduleLike(value: unknown): value is Schedule {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { status?: unknown }).status === 'string',
  );
}

/**
 * Detect when an active PR follow-up schedule shares `targetSessionId` with another active
 * PR follow-up schedule watching a different PR URL. Cross-repo paired PRs may legitimately
 * share one task, so this returns a structured non-breaking advisory rather than blocking.
 */
export async function attachMultiPrSessionWarningWithList(
  listActive: () => Promise<Schedule[]>,
  schedule: Schedule,
): Promise<Schedule & { multiPrSessionWarning?: MultiPrSessionWarning }> {
  if (schedule.status !== 'active' || !schedule.targetSessionId) return schedule;
  const ownUrls = new Set(schedulePrTriggers(schedule).map((rule) => rule.url.toLowerCase()));
  if (ownUrls.size === 0) return schedule;
  let active: Schedule[];
  try {
    active = await listActive();
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

export async function attachMultiPrSessionWarning(
  scheduler: Pick<Scheduler, 'list'>,
  schedule: Schedule,
): Promise<Schedule & { multiPrSessionWarning?: MultiPrSessionWarning }> {
  return attachMultiPrSessionWarningWithList(
    () => scheduler.list({ status: 'active' }),
    schedule,
  );
}

/**
 * Same non-breaking advisory for remote `schedule_create` / `schedule_update`:
 * runs only when the saved remote schedule is active, bound to a session, and
 * watches a PR, so non-PR remote writes incur zero extra RPCs.
 */
export async function attachRemoteMultiPrSessionWarning(
  deps: Pick<SchedulerMcpDeps, 'remote'>,
  deviceId: string,
  data: unknown,
): Promise<unknown> {
  if (!deps.remote || !isScheduleLike(data)) return data;
  return attachMultiPrSessionWarningWithList(async () => {
    const res = await deps.remote!.invoke(deviceId, 'list', [{ status: 'active' }]);
    if (!res.ok) return [];
    const qualified = qualifyRemoteSessionIds(res.data, deviceId);
    return Array.isArray(qualified) ? (qualified as Schedule[]) : [];
  }, data);
}

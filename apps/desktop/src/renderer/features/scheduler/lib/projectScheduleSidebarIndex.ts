import type { AutomationScheduleSessionInfo } from '../../cc-agent/lib/automationSidebarGrouping';
import type { ScheduleSidebarIndexRun } from './scheduleSidebarIndexRuns';
import { isFailedScheduleRun, isUnreadFailedScheduleRun, isUnreadScheduleRun } from './runUnread';
import { compareFailedScheduleRuns } from './failedScheduleDismissal';

/** Local and remote snapshots have the same unread projection. */
export function projectScheduleSidebarIndex(
  runs: readonly ScheduleSidebarIndexRun[],
): Map<string, AutomationScheduleSessionInfo> {
  const next = new Map<string, AutomationScheduleSessionInfo>();
  const latestUnreadFailedFiredAt = new Map<string, number>();
  for (const run of runs) {
    if (!run.sessionId) continue;
    const existing = next.get(run.sessionId);
    const unreadRunIds = existing?.unreadRunIds ? [...existing.unreadRunIds] : [];
    const unreadFailedRunIds = existing?.unreadFailedRunIds ? [...existing.unreadFailedRunIds] : [];
    // 只对未读 run 累加(与 isUnreadScheduleRun 对齐)。failed / interrupted
    // 未读 run 拉高本 session 的 urgency 让侧栏涂红而不是涂绿。
    const isRunUnread = isUnreadScheduleRun(run);
    if (isRunUnread) unreadRunIds.push(run.runId);
    let latestFailedRun = existing?.latestFailedRun;
    if (isFailedScheduleRun(run)) {
      const candidate = { runId: run.runId, firedAt: run.firedAt ?? 0 };
      if (!latestFailedRun || compareFailedScheduleRuns(candidate, latestFailedRun) > 0)
        latestFailedRun = candidate;
    }
    let latestUnreadFailedRunId = existing?.latestUnreadFailedRunId;
    if (isUnreadFailedScheduleRun(run)) {
      unreadFailedRunIds.push(run.runId);
      const firedAt = run.firedAt ?? 0;
      if (firedAt >= (latestUnreadFailedFiredAt.get(run.sessionId) ?? Number.NEGATIVE_INFINITY)) {
        latestUnreadFailedFiredAt.set(run.sessionId, firedAt);
        latestUnreadFailedRunId = run.runId;
      }
    }
    next.set(run.sessionId, {
      scheduleId: run.scheduleId,
      scheduleName: run.scheduleName,
      scheduleStatus: run.scheduleStatus,
      scheduleSource: run.scheduleSource,
      nextFireAt: run.nextFireAt,
      workingDir: run.workingDir,
      projectConfigId: run.projectConfigId,
      unreadRunIds,
      unreadFailedRunIds,
      latestUnreadFailedRunId,
      latestFailedRun,
      hasFailedRun: Boolean(existing?.hasFailedRun || isFailedScheduleRun(run)),
      hasUnreadRun: unreadRunIds.length > 0,
      hasUnreadFailedRun: unreadFailedRunIds.length > 0,
    });
  }
  return next;
}

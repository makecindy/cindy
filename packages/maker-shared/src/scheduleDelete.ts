import type { RemoteSchedule, RemoteScheduleRun } from './scheduleTypes';

export const DELETE_PREVIEW_RUN_LIMIT = 10_000;

export type ScheduleGeneratedSessionDisposition = 'keep' | 'archive' | 'delete';

export interface ScheduleDeletePreview {
  sessionIds: string[];
  sessionCount: number;
  inflightCount: number;
}

export interface ScheduleDeleteTarget {
  id: string;
  name: string;
  source?: RemoteSchedule['source'];
  workingDir?: string;
  projectConfigId?: string;
}

export interface GeneratedSessionDispositionPatch {
  status?: 'archived' | 'deleted';
  pinnedAt?: string | null;
}

export function buildScheduleDeleteTarget(schedule: RemoteSchedule): ScheduleDeleteTarget {
  return {
    id: schedule.id,
    name: schedule.name,
    source: schedule.source,
    workingDir: schedule.workingDir,
    projectConfigId: schedule.projectConfigId,
  };
}

/**
 * 收集"由本 schedule 生成的会话" id 集合,供删除时处置(归档/软删)。
 *
 * `excludeSessionId` 用于排除手绑到该 schedule 的用户既有会话
 * (`schedule.targetSessionId`)。runner 在心跳模式下把 targetSessionId 当每轮
 * run 的 sessionId 落进 schedule_runs(见 scheduler-host/runner.ts),收集时若
 * 不过滤就会把这个**非本任务生成**的用户会话算进处置集合,导致它被误软删。
 *
 * 硬不变量:删除 schedule 时绝不能软删/归档一个不是本任务生成的会话。
 *
 * 全线统一 id 排除法:desktop hook、mobile、共享 helper 三处同一机制 ——
 * 收集层把 excludeSessionId(手绑 schedule.targetSessionId)从 run 历史 ids 与
 * knownSessionIds 两个来源里排除。纯 id 操作,不依赖 session 对象 / source,
 * 三端一致、无分叉。
 */
export function collectGeneratedSessionIds(
  runs: readonly RemoteScheduleRun[],
  knownSessionIds: readonly string[] = [],
  excludeSessionId?: string,
): string[] {
  const ids = new Set<string>();
  const shouldKeep = (id: string | undefined): id is string =>
    !!id && id !== excludeSessionId;
  for (const id of knownSessionIds) {
    if (shouldKeep(id)) ids.add(id);
  }
  for (const run of runs) {
    if (shouldKeep(run.sessionId)) ids.add(run.sessionId);
  }
  return [...ids];
}

export function buildScheduleDeletePreview(
  runs: readonly RemoteScheduleRun[],
  inflightCount = 0,
  knownSessionIds: readonly string[] = [],
  excludeSessionId?: string,
): ScheduleDeletePreview {
  const sessionIds = collectGeneratedSessionIds(runs, knownSessionIds, excludeSessionId);
  return {
    sessionIds,
    sessionCount: sessionIds.length,
    inflightCount: Math.max(0, Math.trunc(inflightCount) || 0),
  };
}

export function buildGeneratedSessionDispositionPatch(
  disposition: ScheduleGeneratedSessionDisposition,
): GeneratedSessionDispositionPatch | null {
  if (disposition === 'keep') return null;
  if (disposition === 'archive') return { status: 'archived', pinnedAt: null };
  return { status: 'deleted' };
}

export function isProjectAutomationSchedule(target: ScheduleDeleteTarget): boolean {
  return target.source === 'project' && !!target.workingDir && !!target.projectConfigId;
}

export function describeScheduleDeletePreview(preview: ScheduleDeletePreview): string {
  const sessionPart = preview.sessionCount === 0
    ? '没有找到由它生成的任务'
    : `找到 ${preview.sessionCount} 个由它生成的任务`;
  if (preview.inflightCount > 0) {
    return `${sessionPart}，还有 ${preview.inflightCount} 次执行正在进行`;
  }
  return sessionPart;
}

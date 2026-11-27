/**
 * 归档前的自动化提醒:绑定的自动化仍会运行，并像用户发送消息一样恢复原任务。本机读
 * schedulesStore,远程任务读 remoteProjectsStore 的绑定分片;读取失败按「无绑定」处理
 * (有确认框兜底;静默归档改用 loadConfirmedActiveBoundScheduleNames,没读到就保留任务)。
 */
import type { Schedule } from '@cindy/maker-scheduler';
import {
  getActiveOrcaWorkersForLead,
  indexActiveOrcaWorkersByLead,
  normalizeOrcaDeviceId,
  orcaLeadSessionKey,
  parseOrcaTeamWorkers,
  type OrcaBoundSessionRef,
  type OrcaRetainedWorkerProjection,
} from '@cindy/maker-shared/orca-team';
import type { TFunction } from 'i18next';

import { listRetainedWorkerProjections } from '@/features/cc-agent/hooks/workerProjectionStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getCurrentAuthDeviceId } from '@/lib/authDeviceIdStore';
import { sessionsStore } from '@/lib/sessionsStore';

import {
  buildBindingMap,
  parseScheduleBindings,
  type ScheduleBinding,
} from './scheduleBindingIndex';
import { schedulesStore } from './schedulesStore';

export interface ArchiveTarget {
  id: string;
  deviceLinkDeviceId?: string | null;
  orcaRole?: string | null;
}

export interface ActiveBoundSchedule {
  id: string;
  name: string;
  /** null 表示本机自动化；非空表示所在远程电脑的 deviceId。 */
  deviceId: string | null;
  /** project 来源由仓库配置管理，归档弹窗不直接删除。 */
  deletable: boolean;
}

/** 冷启动且缓存未就绪时,最多等这么久;超时按「无绑定」处理,不让普通任务的归档卡在列表请求上。 */
export const COLD_SCHEDULE_LOAD_WAIT_MS = 1500;

/**
 * 本机列表:缓存存在且没有刷新在途时直接用(侧栏行常驻订阅,通常已就绪);缓存缺失,或有刷新在途
 * (缓存可能刚被创建 / 恢复 / 改绑作废)时,有限等待那次请求,超时退回已有缓存(没有则当无绑定)。
 */
async function readLocalSchedules(strict = false) {
  const cached = schedulesStore.getSnapshot();
  const pending = schedulesStore.pendingRefresh() ?? (cached ? null : schedulesStore.ensure());
  // strict:上一次刷新失败时 store 保留着旧缓存(并记下错误),它可能已经过期,不能当作读到了。
  if (!pending) return strict && schedulesStore.getError() ? null : cached;
  // strict:超时或失败不退回缓存(它可能已过期),而是报告「没读到」。
  const fallback = strict ? null : cached;
  const timeout = new Promise<Schedule[] | null>((resolve) =>
    setTimeout(() => resolve(fallback), COLD_SCHEDULE_LOAD_WAIT_MS),
  );
  return Promise.race([pending.catch(() => fallback), timeout]);
}

/**
 * 远程任务不信任本地镜像:刚连上 / 重连、或远端刚创建 / 恢复 / 改绑自动化时,镜像可能未加载或已过期。
 * 归档是用户主动的低频操作,所以每台设备直接取一次最新绑定列表,最多等 COLD_SCHEDULE_LOAD_WAIT_MS,
 * 失败或超时退回镜像里已有的快照(没有则当无绑定)。
 */
async function readRemoteBindingsOnce(
  deviceId: string,
): Promise<readonly ScheduleBinding[] | null> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), COLD_SCHEDULE_LOAD_WAIT_MS),
  );
  const load = window.electronAPI.deviceLink
    .invoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }])
    .then(parseScheduleBindings)
    .catch(() => null);
  return Promise.race([load, timeout]);
}

function collectRetainedOrcaWorkerProjections(): OrcaRetainedWorkerProjection[] {
  const projections: OrcaRetainedWorkerProjection[] = [];
  for (const [leadSessionId, snapshot] of listRetainedWorkerProjections()) {
    const leadDeviceId = remoteProjectsStore.getSessionDeviceId?.(leadSessionId) ?? null;
    const workers: OrcaBoundSessionRef[] = snapshot.workers.map((worker) =>
      worker.executionDevice
        ? { sessionId: worker.executionDevice.remoteSessionId, deviceId: worker.executionDevice.deviceId }
        : { sessionId: worker.sessionId, deviceId: leadDeviceId },
    );
    if (workers.length > 0) projections.push([leadSessionId, leadDeviceId, workers]);
  }
  return projections;
}

async function readLocalLeadWorkersOnce(
  leadSessionId: string,
  selfDeviceId: string | null,
): Promise<{ workers: OrcaBoundSessionRef[]; ok: boolean }> {
  const listWorkers = typeof window !== 'undefined'
    ? window.electronAPI?.localDb?.orcaWorkflows?.listWorkersByLead
    : undefined;
  if (!listWorkers) return { workers: [], ok: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      listWorkers(leadSessionId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COLD_SCHEDULE_LOAD_WAIT_MS);
      }),
    ]);
    if (!Array.isArray(rows)) return { workers: [], ok: false };
    return {
      ok: true,
      workers: rows.map((worker) => {
        const exec = (worker as { executionDevice?: { deviceId?: unknown; remoteSessionId?: unknown } })
          .executionDevice;
        return typeof exec?.deviceId === 'string' && typeof exec?.remoteSessionId === 'string'
          ? {
              sessionId: exec.remoteSessionId,
              deviceId: normalizeOrcaDeviceId(exec.deviceId, selfDeviceId),
            }
          : { sessionId: worker.sessionId, deviceId: null };
      }),
    };
  } catch {
    return { workers: [], ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readRemoteLeadWorkersOnce(
  deviceId: string,
  leadSessionId: string,
  selfDeviceId: string | null,
): Promise<{ workers: OrcaBoundSessionRef[]; ok: boolean }> {
  const invoke = typeof window !== 'undefined' ? window.electronAPI?.deviceLink?.invoke : undefined;
  if (!invoke) return { workers: [], ok: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      invoke(deviceId, 'local-db:orca-workflows:list-workers-by-lead', [leadSessionId]),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COLD_SCHEDULE_LOAD_WAIT_MS);
      }),
    ]);
    if (!Array.isArray(raw)) return { workers: [], ok: false };
    return {
      ok: true,
      workers: parseOrcaTeamWorkers(raw).map((worker) =>
        worker.executionDevice
          ? {
              sessionId: worker.executionDevice.remoteSessionId,
              deviceId: normalizeOrcaDeviceId(worker.executionDevice.deviceId, selfDeviceId),
            }
          : { sessionId: worker.sessionId, deviceId },
      ),
    };
  } catch {
    return { workers: [], ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expandTargetsWithOrcaWorkers(
  targets: readonly ArchiveTarget[],
  selfDeviceId: string | null,
): Promise<{
  refsByTarget: Map<ArchiveTarget, OrcaBoundSessionRef[]>;
  workersConfirmed: boolean;
}> {
  const localSessions = sessionsStore.getByFilter?.('active') ?? sessionsStore.getByFilter?.('all') ?? [];
  const remoteSessions = remoteProjectsStore.getVisibleMergedRemoteSessions?.() ?? [];
  const knownByKey = new Map<string, { orcaRole?: string | null }>();
  for (const session of localSessions) {
    knownByKey.set(orcaLeadSessionKey(session.id, null, selfDeviceId), session);
  }
  for (const session of remoteSessions) {
    knownByKey.set(orcaLeadSessionKey(session.id, session.deviceLinkDeviceId, selfDeviceId), session);
  }
  const workerIndex = indexActiveOrcaWorkersByLead(
    [...localSessions, ...remoteSessions],
    {
      selfDeviceId,
      retainedProjections: collectRetainedOrcaWorkerProjections(),
    },
  );
  const leadWorkerReads = new Map<string, Promise<{ workers: OrcaBoundSessionRef[]; ok: boolean }>>();
  const refsByTarget = new Map<ArchiveTarget, OrcaBoundSessionRef[]>();

  for (const target of targets) {
    const normalizedDevice = normalizeOrcaDeviceId(target.deviceLinkDeviceId, selfDeviceId);
    const selfRef: OrcaBoundSessionRef = { sessionId: target.id, deviceId: normalizedDevice };
    const leadKey = orcaLeadSessionKey(target.id, normalizedDevice, selfDeviceId);
    const known = knownByKey.get(leadKey);
    const effectiveRole = target.orcaRole !== undefined ? target.orcaRole : known?.orcaRole;
    const refs: OrcaBoundSessionRef[] = [selfRef];
    if (effectiveRole === 'lead') {
      for (const worker of getActiveOrcaWorkersForLead(workerIndex, target, selfDeviceId)) {
        if (!refs.some((item) => item.sessionId === worker.sessionId && item.deviceId === worker.deviceId)) {
          refs.push(worker);
        }
      }
      if (!leadWorkerReads.has(leadKey)) {
        leadWorkerReads.set(
          leadKey,
          normalizedDevice === null
            ? readLocalLeadWorkersOnce(target.id, selfDeviceId)
            : readRemoteLeadWorkersOnce(normalizedDevice, target.id, selfDeviceId),
        );
      }
    }
    refsByTarget.set(target, refs);
  }

  let workersConfirmed = true;
  if (leadWorkerReads.size > 0) {
    const resolved = new Map<string, { workers: OrcaBoundSessionRef[]; ok: boolean }>(
      await Promise.all(
        [...leadWorkerReads.entries()].map(async ([leadKey, read]) => [leadKey, await read] as const),
      ),
    );
    for (const [target, refs] of refsByTarget) {
      const normalizedDevice = normalizeOrcaDeviceId(target.deviceLinkDeviceId, selfDeviceId);
      const entry = resolved.get(orcaLeadSessionKey(target.id, normalizedDevice, selfDeviceId));
      if (!entry) continue;
      if (!entry.ok) workersConfirmed = false;
      for (const worker of entry.workers) {
        if (!refs.some((item) => item.sessionId === worker.sessionId && item.deviceId === worker.deviceId)) {
          refs.push(worker);
        }
      }
    }
  }

  return { refsByTarget, workersConfirmed };
}

async function resolveActiveBoundSchedules(
  targets: readonly ArchiveTarget[],
  strict: boolean,
): Promise<{ schedules: Map<string, ActiveBoundSchedule[]>; confirmed: boolean }> {
  const selfDeviceId = getCurrentAuthDeviceId();
  const { refsByTarget, workersConfirmed } = await expandTargetsWithOrcaWorkers(targets, selfDeviceId);
  const allRefs = [...refsByTarget.values()].flat();
  // 本机与各台远程设备的读取同时发起,共用一个等待窗口(混合设备批量归档不会叠加到 2 倍)。
  const needsLocal = allRefs.some((ref) => ref.deviceId === null);
  const localRead = needsLocal ? readLocalSchedules(strict) : null;
  const remoteReads = new Map<string, Promise<ReadonlyMap<string, ScheduleBinding[]> | null>>();
  for (const ref of allRefs) {
    const deviceId = ref.deviceId;
    if (deviceId && !remoteReads.has(deviceId)) {
      remoteReads.set(
        deviceId,
        readRemoteBindingsOnce(deviceId).then((list) => (list ? buildBindingMap(list) : null)),
      );
    }
  }
  const localSchedules = localRead ? await localRead : null;
  let confirmed = (!strict || workersConfirmed) && !(strict && needsLocal && !localSchedules);
  const localMap: ReadonlyMap<string, readonly ScheduleBinding[]> = localSchedules
    ? buildBindingMap(localSchedules)
    : new Map();
  const result = new Map<string, ActiveBoundSchedule[]>();
  for (const target of targets) {
    const refs = refsByTarget.get(target) ?? [
      { sessionId: target.id, deviceId: normalizeOrcaDeviceId(target.deviceLinkDeviceId, selfDeviceId) },
    ];
    const seenScheduleKeys = new Set<string>();
    const bound: ActiveBoundSchedule[] = [];
    for (const ref of refs) {
      const deviceId = ref.deviceId;
      let bindings: readonly ScheduleBinding[];
      if (!deviceId) bindings = localMap.get(ref.sessionId) ?? [];
      else {
        const fresh = await remoteReads.get(deviceId);
        if (!fresh && strict) confirmed = false;
        bindings = fresh
          ? (fresh.get(ref.sessionId) ?? [])
          : remoteProjectsStore.getSessionScheduleBindings(deviceId, ref.sessionId);
      }
      for (const schedule of bindings) {
        if (schedule.status !== 'active') continue;
        const scheduleKey = `${deviceId ?? ''}\0${schedule.id}`;
        if (seenScheduleKeys.has(scheduleKey)) continue;
        seenScheduleKeys.add(scheduleKey);
        const source = (schedule as Partial<Schedule>).source;
        bound.push({
          id: schedule.id,
          name: schedule.name,
          deviceId: deviceId ?? null,
          deletable: source !== 'project',
        });
      }
    }
    if (bound.length > 0) result.set(target.id, bound);
  }
  return { schedules: result, confirmed };
}

function projectScheduleNames(
  schedules: Map<string, ActiveBoundSchedule[]>,
): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const [targetId, items] of schedules) {
    names.set(targetId, items.map((item) => item.name));
  }
  return names;
}

/** 每个任务绑定的 active 自动化明细（含本机/远程归属与是否可从归档框删除）。 */
export async function loadActiveBoundSchedules(
  targets: readonly ArchiveTarget[],
): Promise<Map<string, ActiveBoundSchedule[]>> {
  return (await resolveActiveBoundSchedules(targets, false)).schedules;
}

/** 每个任务绑定的 active 自动化名称；包含持续任务，没有的任务不出现在结果里。 */
export async function loadActiveBoundScheduleNames(
  targets: readonly ArchiveTarget[],
): Promise<Map<string, string[]>> {
  return projectScheduleNames((await resolveActiveBoundSchedules(targets, false)).schedules);
}

/**
 * 同上,但只在确实读到了绑定列表时才给结果;超时、读取失败或只能用可能过期的缓存时返回 null。
 * 给没有确认框的静默归档用:没读到不能当成「没有绑定」。
 */
export async function loadConfirmedActiveBoundScheduleNames(
  targets: readonly ArchiveTarget[],
): Promise<Map<string, string[]> | null> {
  const { schedules, confirmed } = await resolveActiveBoundSchedules(targets, true);
  return confirmed ? projectScheduleNames(schedules) : null;
}

function isScheduleNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /schedule not found/i.test(message);
}

/** 删除归档确认框勾选的关联自动化（本机与远程均按各自归属设备执行；已不存在按幂等成功计）。 */
export async function deleteBoundSchedules(
  schedules: readonly ActiveBoundSchedule[],
): Promise<{ deleted: ActiveBoundSchedule[]; failed: ActiveBoundSchedule[] }> {
  const deleted: ActiveBoundSchedule[] = [];
  const failed: ActiveBoundSchedule[] = [];
  const seen = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.deletable) continue;
    const key = `${schedule.deviceId ?? ''}\0${schedule.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (schedule.deviceId) {
        await window.electronAPI.deviceLink.invoke(
          schedule.deviceId,
          'maker:schedule:delete',
          [schedule.id],
        );
      } else {
        await window.electronAPI.maker.schedule.delete(schedule.id);
      }
      deleted.push(schedule);
    } catch (err) {
      if (isScheduleNotFoundError(err)) deleted.push(schedule);
      else failed.push(schedule);
    }
  }
  return { deleted, failed };
}

/** 单个任务的提醒句;无绑定时返回空串。 */
export function archiveScheduleWarning(t: TFunction, names: readonly string[]): string {
  if (names.length === 0) return '';
  return t('ccAgent.sidebar.confirmArchive.scheduleWarning', {
    count: names.length,
    names: names
      .map((name) => t('ccAgent.sidebar.confirmArchive.scheduleName', { name }))
      .join(t('ccAgent.sidebar.confirmArchive.scheduleNameSeparator')),
  });
}

/** 勾选删除关联自动化后的警示句;无待删自动化时返回空串。 */
export function archiveDeleteScheduleWarning(t: TFunction, names: readonly string[]): string {
  if (names.length === 0) return '';
  return t('ccAgent.sidebar.confirmArchive.deleteScheduleWarning', {
    count: names.length,
    names: names
      .map((name) => t('ccAgent.sidebar.confirmArchive.scheduleName', { name }))
      .join(t('ccAgent.sidebar.confirmArchive.scheduleNameSeparator')),
  });
}

/** 批量归档的提醒句:绑定了 active 自动化的任务数;为 0 时返回空串。 */
export async function archiveScheduleWarningMany(
  t: TFunction,
  targets: readonly ArchiveTarget[],
): Promise<string> {
  const count = (await loadActiveBoundScheduleNames(targets)).size;
  return count > 0 ? t('ccAgent.sidebar.confirmArchive.scheduleWarningMany', { count }) : '';
}

/** 单个任务归档确认的完整说明:基础句 + worktree 警告 + 自动化提醒。 */
export function archiveConfirmDescription(
  t: TFunction,
  { dirtyWorktree, scheduleNames }: { dirtyWorktree: boolean; scheduleNames: readonly string[] },
  baseDescription = t('ccAgent.sidebar.confirmArchive.description'),
): string {
  return [
    baseDescription,
    dirtyWorktree ? t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning') : '',
    archiveScheduleWarning(t, scheduleNames),
  ]
    .filter(Boolean)
    .join(' ');
}

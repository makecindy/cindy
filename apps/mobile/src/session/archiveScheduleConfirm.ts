import { Alert } from 'react-native';
import type { TFunction } from 'i18next';
import {
  getActiveOrcaWorkersForLead,
  indexActiveOrcaWorkersByLead,
  orcaLeadSessionKey,
  type OrcaBoundSessionRef,
  type OrcaLeadWorkerSessionLike,
} from '@cindy/maker-shared/orca-team';
import { normalizeScheduleList } from '@/scheduler/scheduleModel';
import type { RemoteSchedule } from '@/scheduler/types';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { sessionMayHaveScheduleRuns } from '@/session/scheduleIndex';

/**
 * 归档前的自动化提醒:绑定的自动化仍会运行，并像用户发送消息一样恢复原任务。
 * 已知未绑定的普通任务直接放行,不额外请求;
 * 读取失败或超过等待上限按无绑定处理。
 */
/** 查询自动化列表的等待上限:超时按「无绑定」处理,不让归档卡在远程请求上(通道超时预算可达 40 秒)。 */
export const SCHEDULE_LOOKUP_WAIT_MS = 1500;

function withLookupDeadline<T>(lookup: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SCHEDULE_LOOKUP_WAIT_MS);
    lookup.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * 只取绑定投影(不含 prompt / 脚本等大字段):完整列表可能超过 device-link 帧限制,
 * 失败后被当成「无绑定」就会漏掉提醒。旧被控端忽略该参数,返回完整列表,行为不变。
 */
function listBindingSchedules(deviceId: string, invoke: RemoteInvoke): Promise<unknown> {
  return invoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }]);
}

function hasActiveTarget(schedule: RemoteSchedule): boolean {
  return schedule.status === 'active' && !!schedule.targetSessionId;
}

export interface BulkArchiveCandidate {
  id: string;
  source?: string | null;
}

interface CandidateCheckRef {
  sessionId: string;
  deviceId: string;
  source?: string | null;
}

function expandCandidateRefs(
  deviceId: string,
  candidates: readonly BulkArchiveCandidate[],
  sessions: readonly OrcaLeadWorkerSessionLike[] = remoteSessionStore.getSessions(),
): Map<string, CandidateCheckRef[]> {
  const knownByKey = new Map<string, OrcaLeadWorkerSessionLike>();
  for (const session of sessions) {
    knownByKey.set(orcaLeadSessionKey(session.id, session.deviceLinkDeviceId), session);
    if (session.canonicalDeviceId && session.canonicalDeviceId !== session.deviceLinkDeviceId) {
      knownByKey.set(orcaLeadSessionKey(session.id, session.canonicalDeviceId), session);
    }
  }
  const workerIndex = indexActiveOrcaWorkersByLead(sessions);
  const byCandidate = new Map<string, CandidateCheckRef[]>();
  for (const candidate of candidates) {
    const refs: CandidateCheckRef[] = [{ sessionId: candidate.id, deviceId, source: candidate.source }];
    const known = knownByKey.get(orcaLeadSessionKey(candidate.id, deviceId));
    if (known?.orcaRole === 'lead') {
      const workers: readonly OrcaBoundSessionRef[] = getActiveOrcaWorkersForLead(workerIndex, {
        id: candidate.id,
        deviceLinkDeviceId: known.deviceLinkDeviceId ?? deviceId,
        canonicalDeviceId: known.canonicalDeviceId,
      });
      for (const worker of workers) {
        if (!worker.deviceId) continue;
        if (!refs.some((item) => item.sessionId === worker.sessionId && item.deviceId === worker.deviceId)) {
          const workerSession = knownByKey.get(orcaLeadSessionKey(worker.sessionId, worker.deviceId));
          refs.push({
            sessionId: worker.sessionId,
            deviceId: worker.deviceId,
            source: (workerSession as { source?: string | null } | undefined)?.source,
          });
        }
      }
    }
    byCandidate.set(candidate.id, refs);
  }
  return byCandidate;
}

function refsMayHaveBoundSchedules(refs: readonly CandidateCheckRef[]): boolean {
  return refs.some((ref) => sessionMayHaveScheduleRuns(ref.deviceId, ref.sessionId, ref.source));
}

/** 与单条路径同一个快路径:索引已确认无绑定的任务不必查询。 */
export function anyMayHaveBoundSchedules(
  deviceId: string,
  candidates: readonly BulkArchiveCandidate[],
  sessions?: readonly OrcaLeadWorkerSessionLike[],
): boolean {
  const expanded = expandCandidateRefs(deviceId, candidates, sessions);
  for (const refs of expanded.values()) {
    if (refsMayHaveBoundSchedules(refs)) return true;
  }
  return false;
}

/** 批量归档:所选任务里绑定了 active 自动化的任务数(每涉及设备最多一次列表请求;全部已知无绑定则不请求;失败按 0)。 */
export async function countSessionsWithActiveBoundSchedules(
  deviceId: string,
  invoke: RemoteInvoke,
  candidates: readonly BulkArchiveCandidate[],
  sessions?: readonly OrcaLeadWorkerSessionLike[],
): Promise<number> {
  const expanded = expandCandidateRefs(deviceId, candidates, sessions);
  const devicesToQuery = new Set<string>();
  for (const refs of expanded.values()) {
    for (const ref of refs) {
      if (sessionMayHaveScheduleRuns(ref.deviceId, ref.sessionId, ref.source)) {
        devicesToQuery.add(ref.deviceId);
      }
    }
  }
  if (devicesToQuery.size === 0) return 0;
  try {
    const schedulesByDevice = new Map<string, RemoteSchedule[]>(
      await Promise.all(
        [...devicesToQuery].map(async (targetDeviceId) => {
          try {
            const raw = await withLookupDeadline(listBindingSchedules(targetDeviceId, invoke), []);
            return [targetDeviceId, normalizeScheduleList(raw)] as const;
          } catch {
            return [targetDeviceId, [] as RemoteSchedule[]] as const;
          }
        }),
      ),
    );
    let count = 0;
    for (const refs of expanded.values()) {
      const hasBound = refs.some((ref) =>
        (schedulesByDevice.get(ref.deviceId) ?? []).some(
          (schedule) => schedule.targetSessionId === ref.sessionId && hasActiveTarget(schedule),
        ),
      );
      if (hasBound) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function loadActiveBoundScheduleNames({
  deviceId,
  invoke,
  sessionId,
  source,
  sessions,
}: {
  deviceId: string;
  invoke: RemoteInvoke;
  sessionId: string;
  source?: string | null;
  sessions?: readonly OrcaLeadWorkerSessionLike[];
}): Promise<string[]> {
  const refs = expandCandidateRefs(deviceId, [{ id: sessionId, source }], sessions).get(sessionId) ?? [
    { sessionId, deviceId, source },
  ];
  const devicesToQuery = new Set(
    refs
      .filter((ref) => sessionMayHaveScheduleRuns(ref.deviceId, ref.sessionId, ref.source))
      .map((ref) => ref.deviceId),
  );
  if (devicesToQuery.size === 0) return [];
  try {
    const schedulesByDevice = new Map<string, RemoteSchedule[]>(
      await Promise.all(
        [...devicesToQuery].map(async (targetDeviceId) => {
          try {
            const raw = await withLookupDeadline(listBindingSchedules(targetDeviceId, invoke), []);
            return [targetDeviceId, normalizeScheduleList(raw)] as const;
          } catch {
            return [targetDeviceId, [] as RemoteSchedule[]] as const;
          }
        }),
      ),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const ref of refs) {
      for (const schedule of schedulesByDevice.get(ref.deviceId) ?? []) {
        if (schedule.targetSessionId !== ref.sessionId || !hasActiveTarget(schedule)) continue;
        const key = `${ref.deviceId}\0${schedule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(schedule.name || schedule.id);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * 不弹确认的静默归档(卡片「离开后自动归档」)用:读取失败或超过等待上限返回 null(不确认),
 * 调用方据此保留任务。索引已确认无绑定的任务不请求,直接返回空列表。
 */
export async function loadConfirmedActiveBoundScheduleNames({
  deviceId,
  invoke,
  sessionId,
  source,
  sessions,
}: {
  deviceId: string;
  invoke: RemoteInvoke;
  sessionId: string;
  source?: string | null;
  sessions?: readonly OrcaLeadWorkerSessionLike[];
}): Promise<string[] | null> {
  const refs = expandCandidateRefs(deviceId, [{ id: sessionId, source }], sessions).get(sessionId) ?? [
    { sessionId, deviceId, source },
  ];
  const devicesToQuery = new Set(
    refs
      .filter((ref) => sessionMayHaveScheduleRuns(ref.deviceId, ref.sessionId, ref.source))
      .map((ref) => ref.deviceId),
  );
  if (devicesToQuery.size === 0) return [];
  const failed = Symbol('failed');
  try {
    const entries = await Promise.all(
      [...devicesToQuery].map(async (targetDeviceId) => {
        try {
          const raw = await withLookupDeadline<unknown>(listBindingSchedules(targetDeviceId, invoke), failed);
          if (raw === failed) return [targetDeviceId, null] as const;
          return [targetDeviceId, normalizeScheduleList(raw)] as const;
        } catch {
          return [targetDeviceId, null] as const;
        }
      }),
    );
    if (entries.some(([, list]) => list === null)) return null;
    const schedulesByDevice = new Map<string, RemoteSchedule[]>(
      entries.map(([targetDeviceId, list]) => [targetDeviceId, list!]),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const ref of refs) {
      for (const schedule of schedulesByDevice.get(ref.deviceId) ?? []) {
        if (schedule.targetSessionId !== ref.sessionId || !hasActiveTarget(schedule)) continue;
        const key = `${ref.deviceId}\0${schedule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(schedule.name || schedule.id);
      }
    }
    return names;
  } catch {
    return null;
  }
}

/** 有 active 自动化时提示后续会恢复任务;没有直接返回 true。 */
export function confirmArchiveWithSchedules(t: TFunction, names: readonly string[]): Promise<boolean> {
  if (names.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      t('session.menu.archiveScheduleConfirmTitle'),
      t('session.menu.archiveScheduleConfirmBody', {
        count: names.length,
        names: names
          .map((name) => t('session.menu.archiveScheduleName', { name }))
          .join(t('session.menu.archiveScheduleNameSeparator')),
      }),
      [
        { style: 'cancel', text: t('devices.common.cancel'), onPress: () => resolve(false) },
        { text: t('session.menu.archive'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

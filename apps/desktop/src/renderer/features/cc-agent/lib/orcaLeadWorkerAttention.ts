/**
 * Orca Lead 行汇总 Worker 的出错 / 等待确认(2026-10 用户裁决)。
 *
 * Worker 不进普通侧栏；出错读取 sessionAttentionStore 的 error，等待确认读取
 * awaiting 或未处理交互，避免看过 Worker 后丢失蓝点。
 * 这里把它投到所属 Lead 行上,只做读侧派生:
 *   - 只汇总 error / awaiting;Worker 的 'done' 不汇总(完成由 Lead 被回报唤起的那一轮表达)。
 *   - 优先级:出错 > 等待确认 > Lead 自己的状态(与行内 error > awaiting > done 同一张表)。
 *   - 等待确认在未处理交互或任务 awaiting 任一存在时保持；不新增清除或通知逻辑。
 *
 * ⚠️ 汇总结果**不写回** sessionAttentionStore:那份会同步到 Main(Dock / 灵动岛 / 远端),
 * 还会被「导航即已读」的被动清除抹掉,破坏 Lead 自己的 attention 生命周期与完成保持判定。
 *
 * 提问按真实聊天任务读取本机状态或设备活动镜像；完成和出错沿用原有本机汇总规则。
 */

import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import { sessionsStore } from '@/lib/sessionsStore';
import { remoteProjectsStore } from '../../device-link/remoteProjectsStore';
import { sessionRowKey } from '../sidebar/sessionRowKey';
import {
  getRemoteSessionActivity,
  getRemoteSessionActivityRevision,
  subscribeRemoteSessionActivity,
} from '../../device-link/remoteSessionActivityStore';
import { makerChatStore, type SessionStatusInfo } from '@/lib/makerChatStore';
import {
  localOrcaWorkerSessionIds,
  resolveOrcaWorkerTaskAttention,
  subscribeOrcaWorkerPendingInteractions,
} from './orcaWorkerTaskAttention';

import {
  getSessionAttentionKinds,
  subscribeSessionAttention,
  type AttentionKind,
} from '@/lib/sessionAttentionStore';
import {
  getAllWorkerProjectionVersion,
  listRetainedWorkerProjections,
  subscribeAllWorkerProjections,
} from '../hooks/workerProjectionStore';

export type OrcaLeadWorkerAttentionKind = 'error' | 'awaiting';

type LeadWorkerSessions = readonly [leadSessionId: string, workerSessionIds: readonly string[]];

const ATTENTION_RANK: Record<AttentionKind, number> = { done: 1, awaiting: 2, error: 3 };

/** 按 Lead 汇总其 Worker 的 error / awaiting;Worker 的 done 不汇总。 */
export function deriveOrcaLeadWorkerAttention(
  leads: Iterable<LeadWorkerSessions>,
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  statuses: ReadonlyMap<string, SessionStatusInfo> = new Map(),
): Map<string, OrcaLeadWorkerAttentionKind> {
  const result = new Map<string, OrcaLeadWorkerAttentionKind>();
  for (const [leadSessionId, workerSessionIds] of leads) {
    let kind: OrcaLeadWorkerAttentionKind | undefined;
    for (const workerSessionId of workerSessionIds) {
      const workerKind = resolveOrcaWorkerTaskAttention(
        attentionKinds.get(workerSessionId),
        statuses.get(workerSessionId),
      );
      if (workerKind === 'error') {
        kind = 'error';
        break;
      }
      if (workerKind === 'awaiting') kind = 'awaiting';
    }
    if (kind) result.set(leadSessionId, kind);
  }
  return result;
}

/** Resolve on activation: a question can be answered while its Lead is visible. */
export function pendingOrcaWorkerQuestion(leadId: string): { workerSessionId: string; chatSessionId: string } | undefined {
  refreshCache();
  if (cachedStatuses?.get(leadId)?.hasPendingAskUser ||
    remoteQuestionPending(leadId, remoteProjectsStore.getSessionDeviceId(leadId))) return undefined;
  return cachedQuestionTargets.get(leadId);
}

/** Lead 自身 kind 与 Worker 汇总取严重度更高的一档(error > awaiting > done)。 */
export function mergeOrcaLeadAttentionKind(
  own: AttentionKind | undefined,
  worker: OrcaLeadWorkerAttentionKind | undefined,
): AttentionKind | undefined {
  if (!worker) return own;
  if (!own) return worker;
  return ATTENTION_RANK[worker] > ATTENTION_RANK[own] ? worker : own;
}

/** 整表合并;没有任何改动时原样返回入参引用,下游 memo 不被打穿。 */
export function mergeOrcaLeadAttentionKinds(
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  leadAttention: ReadonlyMap<string, OrcaLeadWorkerAttentionKind>,
): ReadonlyMap<string, AttentionKind> {
  let merged: Map<string, AttentionKind> | null = null;
  for (const [leadSessionId, workerKind] of leadAttention) {
    const own = attentionKinds.get(leadSessionId);
    const next = mergeOrcaLeadAttentionKind(own, workerKind);
    if (next === own || next === undefined) continue;
    merged ??= new Map(attentionKinds);
    merged.set(leadSessionId, next);
  }
  return merged ?? attentionKinds;
}

/** 未读集合并入有 Worker 汇总的 Lead;没有新增成员时原样返回入参引用。 */
export function mergeOrcaLeadNotifications(
  notifications: ReadonlySet<string>,
  leadAttention: ReadonlyMap<string, OrcaLeadWorkerAttentionKind>,
): ReadonlySet<string> {
  let merged: Set<string> | null = null;
  for (const leadSessionId of leadAttention.keys()) {
    if (notifications.has(leadSessionId)) continue;
    merged ??= new Set(notifications);
    merged.add(leadSessionId);
  }
  return merged ?? notifications;
}

function sameLeadAttention(
  a: ReadonlyMap<string, OrcaLeadWorkerAttentionKind>,
  b: ReadonlyMap<string, OrcaLeadWorkerAttentionKind>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

// —— 模块级派生快照 ——
// useSyncExternalStore 要求内容不变时返回同一引用:按上游快照引用 / 版本号缓存,
// 内容没变就复用旧 Map,逐行订阅与整表订阅都不会被无关广播惊动。
const EMPTY_LEAD_ATTENTION: ReadonlyMap<string, OrcaLeadWorkerAttentionKind> = new Map();
let cachedAttentionKinds: ReadonlyMap<string, AttentionKind> | null = null;
let cachedProjectionVersion = -1;
let cachedStatuses: ReadonlyMap<string, SessionStatusInfo> | null = null;
let cachedLeadAttention: ReadonlyMap<string, OrcaLeadWorkerAttentionKind> = EMPTY_LEAD_ATTENTION;
let cachedMergedKinds: ReadonlyMap<string, AttentionKind> = new Map();

let cachedLocalSessions: readonly Session[] | null = null;
let cachedRemoteSessions: readonly Session[] | null = null;
let listedWorkers: readonly Session[] = [];
let cachedRemoteRevision = -1;
let cachedQuestionTargets = new Map<string, { workerSessionId: string; chatSessionId: string }>();
let cachedRemoteQuestionLeadRows: ReadonlySet<string> = new Set();

function remoteQuestionPending(id: string, device?: string): boolean {
  const activity = getRemoteSessionActivity(id, device);
  return activity?.phase === 'needs-interaction' && activity.interactionKind === 'ask_user_question';
}

function refreshCache(): void {
  const attentionKinds = getSessionAttentionKinds();
  const projectionVersion = getAllWorkerProjectionVersion();
  const statuses = makerChatStore.getRunningSnapshot();
  const localSessions = sessionsStore.getByFilter('active') ?? sessionsStore.getByFilter('all');
  const remoteSessions = remoteProjectsStore.getVisibleMergedRemoteSessions();
  const remoteRevision = getRemoteSessionActivityRevision();
  if (
    localSessions === cachedLocalSessions &&
    remoteSessions === cachedRemoteSessions &&
    remoteRevision === cachedRemoteRevision &&
    attentionKinds === cachedAttentionKinds &&
    projectionVersion === cachedProjectionVersion &&
    statuses === cachedStatuses
  ) {
    return;
  }
  const leads: LeadWorkerSessions[] = [];
  const targets = new Map<string, { workerSessionId: string; chatSessionId: string }>();
  const remoteQuestionLeadRows = new Set<string>();
  for (const [leadId, snapshot] of listRetainedWorkerProjections()) {
    const localIds = localOrcaWorkerSessionIds(snapshot.workers, leadId);
    leads.push([leadId, localIds]);
    const worker = snapshot.workers.find(worker => {
      if (!worker.executionDevice && !localIds.includes(worker.sessionId)) return false;
      const chatId = worker.executionDevice?.remoteSessionId ?? worker.sessionId;
      return statuses.get(chatId)?.hasPendingAskUser ||
        (worker.executionDevice && remoteQuestionPending(chatId, worker.executionDevice.deviceId));
    });
    if (!worker) continue;
    targets.set(leadId, {
      workerSessionId: worker.sessionId,
      chatSessionId: worker.executionDevice?.remoteSessionId ?? worker.sessionId,
    });
    if (snapshot.leadDeviceId) {
      remoteQuestionLeadRows.add(sessionRowKey({ id: leadId, deviceLinkDeviceId: snapshot.leadDeviceId }));
    }
  }
  if (localSessions !== cachedLocalSessions || remoteSessions !== cachedRemoteSessions) {
    const isWorker = (session: Session) => session.status === 'active' && session.orcaRole === 'worker';
    listedWorkers = [...(localSessions?.filter(isWorker) ?? []), ...remoteSessions.filter(isWorker)];
  }
  for (const worker of listedWorkers) {
    const leadId = worker.orcaLeadSessionId;
    if (!leadId) continue;
    const waiting = worker.orcaHasPendingQuestion ?? remoteQuestionPending(worker.id, worker.deviceLinkDeviceId);
    if (!waiting) continue;
    if (worker.deviceLinkDeviceId) {
      remoteQuestionLeadRows.add(sessionRowKey({ id: leadId, deviceLinkDeviceId: worker.deviceLinkDeviceId }));
    }
    if (!targets.has(leadId) && remoteProjectsStore.getSessionDeviceId(leadId) === worker.deviceLinkDeviceId) {
      targets.set(leadId, { workerSessionId: worker.id, chatSessionId: worker.id });
    }
  }
  if (remoteQuestionLeadRows.size !== cachedRemoteQuestionLeadRows.size ||
    [...remoteQuestionLeadRows].some(row => !cachedRemoteQuestionLeadRows.has(row))) {
    cachedRemoteQuestionLeadRows = remoteQuestionLeadRows;
  }
  cachedLocalSessions = localSessions;
  cachedRemoteSessions = remoteSessions;
  cachedRemoteRevision = remoteRevision;
  cachedQuestionTargets = targets;
  const next = deriveOrcaLeadWorkerAttention(leads, attentionKinds, statuses);
  for (const id of targets.keys()) if (!next.has(id)) next.set(id, 'awaiting');
  const leadAttention = sameLeadAttention(next, cachedLeadAttention) ? cachedLeadAttention : next;
  if (leadAttention !== cachedLeadAttention || attentionKinds !== cachedAttentionKinds) {
    cachedMergedKinds = mergeOrcaLeadAttentionKinds(attentionKinds, leadAttention);
  }
  cachedStatuses = statuses;
  cachedAttentionKinds = attentionKinds;
  cachedProjectionVersion = projectionVersion;
  cachedLeadAttention = leadAttention;
}

// 两组订阅者只在各自关心的派生结果换引用时才被唤醒:逐行订阅 Lead 汇总的组件不会因
// 无关会话的 attention 或 Worker 状态变化而全部重跑 getSnapshot。上游订阅按需建立。
const leadAttentionListeners = new Set<() => void>();
const mergedKindsListeners = new Set<() => void>();
let unsubscribeUpstream: (() => void) | null = null;

function onUpstreamChange(): void {
  const previousLeadAttention = cachedLeadAttention;
  const previousMergedKinds = cachedMergedKinds;
  const previousRemoteQuestionLeadRows = cachedRemoteQuestionLeadRows;
  refreshCache();
  if (cachedLeadAttention !== previousLeadAttention || cachedRemoteQuestionLeadRows !== previousRemoteQuestionLeadRows) {
    for (const listener of [...leadAttentionListeners]) listener();
  }
  if (cachedMergedKinds !== previousMergedKinds) {
    for (const listener of [...mergedKindsListeners]) listener();
  }
}

function subscribeDerived(listeners: Set<() => void>, listener: () => void): () => void {
  if (!unsubscribeUpstream) {
    refreshCache();
    const unsubscribeLocal = sessionsStore.subscribe(onUpstreamChange);
    const unsubscribeRemote = remoteProjectsStore.subscribe(onUpstreamChange);
    const unsubscribeActivity = subscribeRemoteSessionActivity(onUpstreamChange);
    const unsubscribeAttention = subscribeSessionAttention(onUpstreamChange);
    const unsubscribeProjections = subscribeAllWorkerProjections(onUpstreamChange);
    const unsubscribePending = subscribeOrcaWorkerPendingInteractions(
      () =>
        listRetainedWorkerProjections().flatMap(([, snapshot]) =>
          snapshot.workers.map(worker => worker.executionDevice?.remoteSessionId ?? worker.sessionId),
        ),
      onUpstreamChange,
    );
    unsubscribeUpstream = () => {
      unsubscribeLocal();
      unsubscribeRemote();
      unsubscribeActivity();
      unsubscribePending();
      unsubscribeAttention();
      unsubscribeProjections();
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (leadAttentionListeners.size === 0 && mergedKindsListeners.size === 0) {
      unsubscribeUpstream?.();
      unsubscribeUpstream = null;
    }
  };
}

/** Lead 汇总表换引用(内容变化)时通知。 */
export function subscribeOrcaLeadWorkerAttention(listener: () => void): () => void {
  return subscribeDerived(leadAttentionListeners, listener);
}

/** 合并后的 kind 表换引用时通知(与 sessionAttentionStore 每次广播同频)。 */
export function subscribeSessionAttentionKindsWithOrcaLeads(listener: () => void): () => void {
  return subscribeDerived(mergedKindsListeners, listener);
}

/** Lead → 汇总的 Worker kind。 */
export function getOrcaLeadWorkerAttention(): ReadonlyMap<string, OrcaLeadWorkerAttentionKind> {
  refreshCache();
  return cachedLeadAttention;
}

/** sessionAttentionStore 的 kind 表并入 Lead 汇总;无 Orca 汇总时与原表同一引用。 */
export function getSessionAttentionKindsWithOrcaLeads(): ReadonlyMap<string, AttentionKind> {
  refreshCache();
  return cachedMergedKinds;
}

/**
 * Worker 自身事件是否单独发通知:只放行本机 Worker 的出错与需要确认;完成仍不单独通知,
 * 等 Lead 被回报唤起的那一轮以 Lead 名义统一通知。远程控制另一台电脑的 Worker 不在范围内。
 */
export function shouldNotifyOrcaWorkerEvent(
  kind: 'done' | 'error' | 'needs-reply',
  worker: { deviceLinkDeviceId?: string | null },
): boolean {
  return kind !== 'done' && !worker.deviceLinkDeviceId;
}

/** Worker 通知标题:「Lead 标题 · Worker 标题」;找不到 Lead 时退回 Worker 标题。 */
export function formatOrcaWorkerNotificationTitle(
  workerTitle: string,
  leadTitle: string | null,
): string {
  return leadTitle ? `${leadTitle} · ${workerTitle}` : workerTitle;
}

/** Worker 会话所属的本机 Lead(按已持有的投影反查);查不到返回 null。 */
export function findOrcaLeadSessionIdForWorker(workerSessionId: string): string | null {
  for (const [leadSessionId, snapshot] of listRetainedWorkerProjections()) {
    if (snapshot.workers.some((worker) => worker.sessionId === workerSessionId)) {
      return leadSessionId;
    }
  }
  return null;
}

/**
 * 逐行用:只订阅本行 Lead 的汇总 kind(primitive 快照),其它 Lead 或无关会话变化不重渲染。
 * 性能不变量同 useSessionAttentionKind,列表行禁止改用下面的整表 hook。
 */
export function useOrcaLeadWorkerAttentionKind(
  sessionId: string,
): OrcaLeadWorkerAttentionKind | undefined {
  const getSnapshot = () => getOrcaLeadWorkerAttention().get(sessionId);
  return useSyncExternalStore(subscribeOrcaLeadWorkerAttention, getSnapshot, getSnapshot);
}

/** 聚合视图用:整张 Lead 汇总表(只在内容变化时换引用)。 */
export function useOrcaLeadWorkerAttention(): ReadonlyMap<string, OrcaLeadWorkerAttentionKind> {
  return useSyncExternalStore(
    subscribeOrcaLeadWorkerAttention,
    getOrcaLeadWorkerAttention,
    getOrcaLeadWorkerAttention,
  );
}

export function getRemoteOrcaQuestionLeadRows(): ReadonlySet<string> {
  refreshCache();
  return cachedRemoteQuestionLeadRows;
}

export function useRemoteOrcaQuestionLeadRows(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeOrcaLeadWorkerAttention, getRemoteOrcaQuestionLeadRows, getRemoteOrcaQuestionLeadRows);
}

/**
 * 聚合视图用:替代 useSessionAttentionKinds,Lead 的 kind 已并入 Worker 汇总。
 * 与 useSessionAttentionKinds 一样每次 attention 广播都可能换引用,不要进逐行组件。
 */
export function useSessionAttentionKindsWithOrcaLeads(): ReadonlyMap<string, AttentionKind> {
  return useSyncExternalStore(
    subscribeSessionAttentionKindsWithOrcaLeads,
    getSessionAttentionKindsWithOrcaLeads,
    getSessionAttentionKindsWithOrcaLeads,
  );
}

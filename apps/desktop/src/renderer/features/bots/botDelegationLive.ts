import { useCallback, useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { makerApiForSticky } from '@/lib/makerTransport';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import type {
  BotDelegationListResult,
  BotDelegationStatus,
  BotDelegationView,
} from '../../../shared/botDelegation';

/** 未落终态的后台任务：任务卡按这个集合决定是否仍在执行。 */
const ACTIVE_STATUSES = new Set<BotDelegationStatus>(['queued', 'waiting', 'running']);

export function isActiveDelegationStatus(status: BotDelegationStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

interface DelegationSnapshot {
  rows: readonly BotDelegationView[];
  resolved: boolean;
  stale: boolean;
}

const EMPTY_SNAPSHOT: DelegationSnapshot = { rows: [], resolved: false, stale: false };

interface SessionEntry {
  snapshot: DelegationSnapshot;
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
  reloadGeneration: number;
  requesterWideListeners: Map<string, number>;
  requesterWideDirty: boolean;
  scheduleLocalReload?: (read: () => Promise<void>) => Promise<void>;
}

/**
 * 每个会话一份委派快照，会话内所有协作卡共用。
 *
 * 存在的理由：一次连环编排里父任务可能挂三四张协作卡，每张都自己 `listBotDelegations`
 * + 订阅推送的话，一条状态变更会引发 N 次全量拉取。这里把「一个会话一次订阅、一次
 * 拉取、广播给所有卡」收在一处；组件侧只按 delegationId 取自己那行。
 *
 * 缓存按数据主人、代次及会话隔离；异步读取继续用 generation 守卫丢弃旧结果。
 */
const sessions = new Map<string, SessionEntry>();

function sessionKey(sessionId: string, owner: DataOwnerGeneration): string {
  return JSON.stringify([owner.dataOwnerId, owner.generation, sessionId]);
}

function useDelegationKey(sessionId: string | null): string | null {
  // A same-owner recommit does not remount the route. Observe the auth update
  // so an already-open list also switches to the newly published generation.
  useOptionalDataOwnerGeneration();
  return sessionId ? sessionKey(sessionId, getDataOwnerGeneration()) : null;
}

function ensureEntry(key: string): SessionEntry {
  const existing = sessions.get(key);
  if (existing) return existing;
  const entry: SessionEntry = {
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    unsubscribe: null,
    reloadGeneration: 0,
    requesterWideListeners: new Map(),
    requesterWideDirty: false,
  };
  sessions.set(key, entry);
  return entry;
}

function publish(entry: SessionEntry, snapshot: DelegationSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of [...entry.listeners]) listener();
}

async function reload(sessionId: string, key: string): Promise<void> {
  const entry = sessions.get(key);
  const owner = getDataOwnerGeneration();
  if (!entry || key !== sessionKey(sessionId, owner)) return;
  const generation = ++entry.reloadGeneration;
  entry.requesterWideDirty = false;
  const current = () => isDataOwnerGenerationCurrent(owner)
    && sessions.get(key) === entry && entry.reloadGeneration === generation;
  const read = async () => {
    if (!current()) return;
    let result: BotDelegationListResult | null = null;
    try {
      result = await makerApiForSticky(sessionId).listBotDelegations(sessionId);
    } catch {
      // Keep the last confirmed rows on a transient read failure.
    }
    if (!current()) return;
    publish(entry, {
      rows: result?.ok ? result.delegations : entry.snapshot.rows,
      resolved: true,
      stale: !result?.ok,
    });
  };
  return entry.scheduleLocalReload ? entry.scheduleLocalReload(read) : read();
}

function subscribe(
  sessionId: string,
  key: string,
  listener: () => void,
  requestingBotId?: string,
): () => void {
  const entry = ensureEntry(key);
  entry.listeners.add(listener);
  if (requestingBotId) {
    entry.requesterWideListeners.set(requestingBotId, (entry.requesterWideListeners.get(requestingBotId) ?? 0) + 1);
  }
  if (!entry.unsubscribe) {
    const deviceId = remoteProjectsStore.getSessionDeviceId(sessionId);
    if (!deviceId) entry.scheduleLocalReload = createCoalescedRefresh<void>();
    const offPush = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
          if (
            push.deviceId !== deviceId ||
            push.channel !== 'maker:bot-delegation:changed' ||
            !isDeviceLinkRemotePushCurrent(push, stamp)
          )
            return;
          const payload = push.payload as { parentSessionId?: string };
          if (payload?.parentSessionId === sessionId) void reload(sessionId, key);
        })
      : window.electronAPI.maker.onBotDelegationChanged((payload, ownerStamp) => {
          if (!isDataOwnerPushCurrent(ownerStamp)) return;
          // Older pushes omit the requester. Keep their broad invalidation for open lists.
          const requesterListOpen = payload.requestingBotId
            ? entry.requesterWideListeners.has(payload.requestingBotId)
            : entry.requesterWideListeners.size > 0;
          if (payload.parentSessionId === sessionId || requesterListOpen) {
            void reload(sessionId, key);
          } else {
            entry.requesterWideDirty = true;
          }
        });
    const offStatus = deviceId
      ? window.electronAPI.deviceLink.onStatusChanged((state) => {
          if (state.status === 'online') void reload(sessionId, key);
          else {
            entry.reloadGeneration += 1;
            publish(entry, { ...entry.snapshot, stale: true });
          }
        })
      : () => {};
    entry.unsubscribe = () => {
      offPush();
      offStatus();
    };
    void reload(sessionId, key);
  } else if (requestingBotId && entry.requesterWideDirty) {
    void reload(sessionId, key);
  }
  return () => {
    entry.listeners.delete(listener);
    if (requestingBotId) {
      const count = entry.requesterWideListeners.get(requestingBotId) ?? 0;
      if (count > 1) entry.requesterWideListeners.set(requestingBotId, count - 1);
      else entry.requesterWideListeners.delete(requestingBotId);
    }
    if (entry.listeners.size > 0) return;
    entry.unsubscribe?.();
    if (sessions.get(key) === entry) sessions.delete(key);
  };
}

function useDelegationSnapshot(
  sessionId: string | null,
  key: string | null,
  requestingBotId?: string,
): DelegationSnapshot {
  const subscribeSnapshot = useCallback((listener: () => void) => {
    if (!sessionId || !key) return () => {};
    return subscribe(sessionId, key, listener, requestingBotId);
  }, [sessionId, key, requestingBotId]);
  const read = useCallback(() => {
    if (!sessionId || !key || key !== sessionKey(sessionId, getDataOwnerGeneration())) return EMPTY_SNAPSHOT;
    return sessions.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
  }, [sessionId, key]);
  return useSyncExternalStore(subscribeSnapshot, read, read);
}

export interface BotDelegationLive {
  /** 这一条委派的实时行；还没读到、或读完了但不存在时为 null。 */
  row: BotDelegationView | null;
  /**
   * 本会话的委派列表是否已经拉过一次（成功或失败都算）。
   *
   * `resolved && row === null` 是一个**确定的**结论：这条委派我们核实不了。
   * 调用方必须据此改口，不能继续画「正在进行」。
   */
  resolved: boolean;
  stale: boolean;
}

/** 取本会话发起的某一个委派的实时行，附带「首次拉取是否已落地」。 */
export function useBotDelegation(
  sessionId: string | null,
  delegationId: string,
): BotDelegationLive {
  const key = useDelegationKey(sessionId);
  const { rows, resolved, stale } = useDelegationSnapshot(sessionId, key);
  return { row: rows.find((item) => item.id === delegationId) ?? null, resolved, stale };
}

/** 本会话发起的全部委派（伙伴工作台的进度卡用），与协作卡共用同一份订阅。 */
export function useBotDelegations(sessionId: string | null): readonly BotDelegationView[] {
  const key = useDelegationKey(sessionId);
  return useDelegationSnapshot(sessionId, key).rows;
}

/** 本机伙伴主聊天的后台任务列表，与原协作卡共享快照和订阅。 */
export function useBotDelegationList(sessionId: string | null, requestingBotId: string): DelegationSnapshot & { retry: () => void } {
  const key = useDelegationKey(sessionId);
  const snapshot = useDelegationSnapshot(sessionId, key, requestingBotId);
  const retry = useCallback(() => {
    if (sessionId && key) void reload(sessionId, key);
  }, [sessionId, key]);
  return { ...snapshot, retry };
}

/** 测试用：清掉进程内缓存，避免用例之间互相看到对方的订阅。 */
export function __resetBotDelegationLiveForTest(): void {
  for (const entry of sessions.values()) entry.unsubscribe?.();
  sessions.clear();
}

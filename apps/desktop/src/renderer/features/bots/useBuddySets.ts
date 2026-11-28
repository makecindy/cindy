import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import {
  buddySetsStorageKey,
  readBuddySetsResult,
  writeBuddySets,
  type BuddySetsReadResult,
} from './buddySetsPrefs';
import { useAuth } from '@/contexts/AuthContext';

export type BuddySetsStatus = BuddySetsReadResult['status'];
export type BuddySetsChange = (current: BuddySetsState) => BuddySetsState;
export type BuddySetsUpdate = (change: BuddySetsChange) => void;
export type BuddySetsHookResult = [
  BuddySetsState,
  BuddySetsUpdate,
  BuddySetsStatus,
  () => void,
  boolean,
  () => void,
];

interface Snapshot {
  state: BuddySetsState;
  status: BuddySetsStatus;
  saveFailed: boolean;
}

interface PendingSave {
  ownerId: string;
  change: BuddySetsChange;
}

function readSnapshot(ownerId: string | null): Snapshot {
  const result = readBuddySetsResult(ownerId);
  return {
    state: result.status === 'ready' ? result.state : emptyBuddySets(),
    status: result.status,
    saveFailed: false,
  };
}

/**
 * 本机、按账号的「伙伴集」展示偏好。切换账号重新读取,不入伙伴资料、不跨电脑同步。
 * 存储记录是唯一 owner:每次保存前重读一次,storage 事件负责同步其它窗口;
 * 未确认读成功或写入未提交时都不把乐观状态当成已保存(engineering-conventions.md §8.2)。
 */
export function useBuddySets(): BuddySetsHookResult {
  const { dataOwnerId } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot(dataOwnerId));
  const pendingSave = useRef<PendingSave | null>(null);

  const refresh = useCallback((preservePending = true) => {
    if (!preservePending) pendingSave.current = null;
    const next = readSnapshot(dataOwnerId);
    setSnapshot({
      ...next,
      saveFailed: preservePending && pendingSave.current?.ownerId === dataOwnerId,
    });
  }, [dataOwnerId]);

  useEffect(() => {
    refresh(false);
    if (!dataOwnerId || typeof window === 'undefined') return;
    const key = buddySetsStorageKey(dataOwnerId);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      refresh(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dataOwnerId, refresh]);

  const attemptSave = useCallback((ownerId: string | null, change: BuddySetsChange) => {
    if (!ownerId) return;
    // Another window may have written since this hook last rendered: apply the
    // change to the record on disk, never to a whole stale React snapshot.
    const stored = readBuddySetsResult(ownerId);
    if (stored.status !== 'ready') {
      // A transient read failure must not discard an earlier uncommitted change;
      // retrySave can still apply it once the record is readable again.
      setSnapshot({
        state: emptyBuddySets(),
        status: stored.status,
        saveFailed: pendingSave.current?.ownerId === ownerId,
      });
      return;
    }
    const next = normalizeBuddySets(change(stored.state));
    if (writeBuddySets(ownerId, next)) {
      pendingSave.current = null;
      setSnapshot({ state: next, status: 'ready', saveFailed: false });
    } else {
      pendingSave.current = { ownerId, change };
      setSnapshot({ state: stored.state, status: 'ready', saveFailed: true });
    }
  }, []);

  const update = useCallback<BuddySetsUpdate>((change) => {
    attemptSave(dataOwnerId, change);
  }, [attemptSave, dataOwnerId]);

  const retry = useCallback(() => refresh(true), [refresh]);

  const retrySave = useCallback(() => {
    const pending = pendingSave.current;
    if (!pending || pending.ownerId !== dataOwnerId) return;
    attemptSave(pending.ownerId, pending.change);
  }, [attemptSave, dataOwnerId]);

  // Without an account there is no owner-scoped store; never persist or surface
  // another account's containers. A failed read is not an empty record.
  const safeState = dataOwnerId && snapshot.status === 'ready' ? snapshot.state : emptyBuddySets();
  const saveFailed = snapshot.saveFailed && pendingSave.current?.ownerId === dataOwnerId;
  return [safeState, update, snapshot.status, retry, saveFailed, retrySave];
}

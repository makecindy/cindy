import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { getHomeViewSession, useRetainedHomeState } from './homeViewSession';
import { readBuddySets, saveBuddySets } from './buddySetsStore';

/** Cold-start read state. A failed read must never let a fresh empty state be saved. */
export type BuddySetsStatus = 'loading' | 'ready' | 'error';

/**
 * 「伙伴集」展示偏好:首页视图会话持有当前值(与折叠偏好同口径),按账号落本机
 * AsyncStorage。只存 override;冷启动读回,读取成功前不接受修改,失败时给出重试。
 */
export function useBuddySets(owner: string): [BuddySetsState, (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void, BuddySetsStatus, () => void] {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const statusRef = useRef<BuddySetsStatus>('loading');
  const [status, setStatus] = useState<BuddySetsStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  const [state, setState] = useRetainedHomeState<BuddySetsState>(
    getHomeViewSession(),
    'buddySets',
    emptyBuddySets(),
    (next) => {
      const activeOwner = ownerRef.current;
      // Only a successful hydration may unlock writes: otherwise a failed read
      // followed by a user edit would replace the whole valid on-disk record.
      if (activeOwner && statusRef.current === 'ready') {
        void saveBuddySets(activeOwner, next).catch(() => undefined);
      }
    },
  );

  useEffect(() => {
    let cancelled = false;
    statusRef.current = 'loading';
    setStatus('loading');
    if (!owner) {
      // No account means no owner-scoped store; nothing to read or persist.
      statusRef.current = 'ready';
      setStatus('ready');
      return undefined;
    }
    void readBuddySets(owner).then((stored) => {
      if (cancelled || ownerRef.current !== owner) return;
      getHomeViewSession().write('buddySets', stored);
      statusRef.current = 'ready';
      setStatus('ready');
    }).catch(() => {
      if (cancelled || ownerRef.current !== owner) return;
      // Leave the view session empty and locked; do not persist anything.
      statusRef.current = 'error';
      setStatus('error');
    });
    return () => { cancelled = true; };
  }, [owner, attempt]);

  const update = useCallback((input: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => {
    if (statusRef.current !== 'ready') return;
    setState((current) => normalizeBuddySets(typeof input === 'function' ? input(current) : input));
  }, [setState]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return [owner ? state : emptyBuddySets(), update, status, retry];
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { getHomeViewSession, useRetainedHomeState, type HomeViewSession } from './homeViewSession';
import { readBuddySets, saveBuddySets } from './buddySetsStore';

/** Cold-start read state. A failed read must never let a fresh empty state be saved. */
export type BuddySetsStatus = 'loading' | 'ready' | 'error';

interface Load {
  promise: Promise<BuddySetsState>;
  status: BuddySetsStatus;
  applied: boolean;
}

/** One read per (view session, account): a second Home/Sidebar mount must not
 *  start a fresh read that could resolve with an older blob and overwrite edits. */
const loads = new WeakMap<HomeViewSession, Map<string, Load>>();

function loadFor(session: HomeViewSession, owner: string): Load {
  let byOwner = loads.get(session);
  if (!byOwner) {
    byOwner = new Map();
    loads.set(session, byOwner);
  }
  let load = byOwner.get(owner);
  if (!load) {
    load = { promise: readBuddySets(owner), status: 'loading', applied: false };
    byOwner.set(owner, load);
  }
  return load;
}

/** Read without starting one, so a remount can inherit the settled status. */
function peekStatus(session: HomeViewSession, owner: string): BuddySetsStatus {
  const load = loads.get(session)?.get(owner);
  return owner ? load?.status ?? 'loading' : 'ready';
}

/**
 * 「伙伴集」展示偏好:首页视图会话持有当前值(与折叠偏好同口径),按账号落本机
 * AsyncStorage。只存 override;冷启动读回,读取成功前不接受修改,失败时给出重试。
 */
export function useBuddySets(owner: string): [BuddySetsState, (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void, BuddySetsStatus, () => void] {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<BuddySetsStatus>(
    () => peekStatus(getHomeViewSession(), owner),
  );
  const statusRef = useRef(status);
  statusRef.current = status;

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
    const session = getHomeViewSession();
    if (!owner) {
      // No account means no owner-scoped store; nothing to read or persist.
      statusRef.current = 'ready';
      setStatus('ready');
      return undefined;
    }
    const load = loadFor(session, owner);
    if (load.status !== 'loading') {
      statusRef.current = load.status;
      setStatus(load.status);
      return undefined;
    }
    statusRef.current = 'loading';
    setStatus('loading');
    void load.promise.then((stored) => {
      load.status = 'ready';
      if (cancelled || ownerRef.current !== owner || getHomeViewSession() !== session) return;
      // Apply the disk snapshot exactly once; never over a value already edited
      // in this view session (e.g. by an earlier mount that finished sooner).
      if (!load.applied) {
        load.applied = true;
        session.write('buddySets', stored);
      }
      statusRef.current = 'ready';
      setStatus('ready');
    }).catch(() => {
      load.status = 'error';
      if (cancelled || ownerRef.current !== owner || getHomeViewSession() !== session) return;
      statusRef.current = 'error';
      setStatus('error');
    });
    return () => { cancelled = true; };
  }, [owner, attempt]);

  const update = useCallback((input: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => {
    if (statusRef.current !== 'ready') return;
    setState((current) => normalizeBuddySets(typeof input === 'function' ? input(current) : input));
  }, [setState]);

  const retry = useCallback(() => {
    const session = getHomeViewSession();
    // Drop the rejected read so the next effect run performs a fresh one.
    loads.get(session)?.delete(ownerRef.current);
    statusRef.current = 'loading';
    setStatus('loading');
    setAttempt((value) => value + 1);
  }, []);

  return [owner ? state : emptyBuddySets(), update, status, retry];
}

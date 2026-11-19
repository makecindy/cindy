import { useCallback, useEffect, useRef } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { getHomeViewSession, useRetainedHomeState } from './homeViewSession';
import { readBuddySets, saveBuddySets } from './buddySetsStore';

/**
 * 「伙伴集」展示偏好:首页视图会话持有当前值(与折叠偏好同口径),按账号落本机
 * AsyncStorage。只存 override;冷启动读回,用户已手动改过则不被旧快照覆盖。
 */
export function useBuddySets(owner: string): [BuddySetsState, (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void] {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const touched = useRef(false);

  const [state, setState] = useRetainedHomeState<BuddySetsState>(
    getHomeViewSession(),
    'buddySets',
    emptyBuddySets(),
    (next) => {
      const activeOwner = ownerRef.current;
      if (activeOwner) void saveBuddySets(activeOwner, next).catch(() => undefined);
    },
  );

  useEffect(() => {
    let cancelled = false;
    touched.current = false;
    if (!owner) return undefined;
    // Hydration writes straight into the view session: it must not re-persist
    // the restored value, and it must not clobber a user edit made meanwhile.
    void readBuddySets(owner).then((stored) => {
      if (cancelled || ownerRef.current !== owner || touched.current) return;
      getHomeViewSession().write('buddySets', stored);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [owner]);

  const update = useCallback((input: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => {
    touched.current = true;
    setState((current) => normalizeBuddySets(typeof input === 'function' ? input(current) : input));
  }, [setState]);

  return [owner ? state : emptyBuddySets(), update];
}

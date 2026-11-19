import { useCallback, useEffect, useState } from 'react';
import {
  emptyBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { readBuddySets, writeBuddySets } from './buddySetsPrefs';
import { useAuth } from '@/contexts/AuthContext';

/** 本机、按账号的「伙伴集」展示偏好。切换账号重新读取,不入伙伴资料、不跨电脑同步。 */
export function useBuddySets(): [BuddySetsState, (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void] {
  const { dataOwnerId } = useAuth();
  const [state, setState] = useState<BuddySetsState>(() => readBuddySets(dataOwnerId));

  useEffect(() => {
    setState(readBuddySets(dataOwnerId));
  }, [dataOwnerId]);

  const update = useCallback((input: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => {
    setState((current) => {
      const candidate = typeof input === 'function' ? input(current) : input;
      const next = normalizeBuddySets(candidate);
      writeBuddySets(dataOwnerId, next);
      return next;
    });
  }, [dataOwnerId]);

  // Without an account there is no owner-scoped store; never persist or surface
  // another account's containers.
  const safeState = dataOwnerId ? state : emptyBuddySets();
  return [safeState, update];
}

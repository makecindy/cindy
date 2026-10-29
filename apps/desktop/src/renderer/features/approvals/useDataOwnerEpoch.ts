import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

import { useNow } from './useNow';

/**
 * Bumps whenever the signed-in data owner changes, so the caller can remount everything that holds
 * selection, placeholders or in-flight lookups. There is no change subscription for the owner, so it
 * is re-read on every render, on each shared clock tick (at most 1 s late) and when the window regains focus.
 */
export function useDataOwnerEpoch(): number {
  const [state, setState] = useState<{ epoch: number; owner: DataOwnerGeneration }>(
    () => ({ epoch: 0, owner: getDataOwnerGeneration() }),
  );
  useNow();
  const [, recheck] = useState(0);
  useEffect(() => {
    const onFocus = () => recheck((value) => value + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  if (!isDataOwnerGenerationCurrent(state.owner)) {
    setState({ epoch: state.epoch + 1, owner: getDataOwnerGeneration() });
  }
  return state.epoch;
}

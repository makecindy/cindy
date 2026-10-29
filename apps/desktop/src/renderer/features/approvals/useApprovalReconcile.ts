import { useCallback, useEffect, useRef, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';

interface ReconcileInput {
  /** Sessions the store already holds a pending permission for. */
  storeIds: readonly string[];
  /** Sessions the host reports as waiting for a permission (from the activity snapshot). */
  hostIds: readonly string[];
}

/**
 * Rebuilds pending permissions from the host's snapshot, for requests this window missed.
 * It is NOT run per id-set change: a decision would otherwise cost one IPC call per remaining
 * request and flicker Refresh. Triggers: mount, window focus / visibility, a host-reported
 * request the store does not know yet, and the manual Refresh. Overlapping triggers are
 * coalesced into at most one follow-up run, and a result that arrives for another data owner
 * is ignored. Rows come only from the store, so a late result can never revive a decided card.
 */
export function useApprovalReconcile({ storeIds, hostIds }: ReconcileInput) {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ storeIds, hostIds });
  latest.current = { storeIds, hostIds };
  const inFlight = useRef(false);
  const queued = useRef<'all' | 'missed' | null>(null);
  const mounted = useRef(true);

  const run = useCallback((scope: 'all' | 'missed') => {
    if (inFlight.current) {
      queued.current = queued.current === 'all' || scope === 'all' ? 'all' : 'missed';
      return;
    }
    const { storeIds: known, hostIds: reported } = latest.current;
    const targets = scope === 'all'
      ? [...new Set([...known, ...reported])]
      : reported.filter((id) => !known.includes(id));
    if (targets.length === 0) return;
    inFlight.current = true;
    const owner = getDataOwnerGeneration();
    setChecking(true);
    void Promise.allSettled(targets.map((id) => makerChatStore.reconcilePendingInteractions(id))).then((results) => {
      inFlight.current = false;
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner)) return;
      setChecking(false);
      setFailed(results.some((result) => result.status === 'rejected'));
      const next = queued.current;
      queued.current = null;
      if (next) run(next);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    run('all');
    const onFocus = () => run('all');
    const onVisible = () => { if (document.visibilityState !== 'hidden') run('all'); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [run]);

  const missedKey = hostIds.filter((id) => !storeIds.includes(id)).sort().join('\u0001');
  const previousMissed = useRef(missedKey);
  useEffect(() => {
    if (previousMissed.current === missedKey) return;
    previousMissed.current = missedKey;
    if (missedKey) run('missed');
  }, [missedKey, run]);

  const refresh = useCallback(() => run('all'), [run]);
  return { checking, failed, refresh };
}

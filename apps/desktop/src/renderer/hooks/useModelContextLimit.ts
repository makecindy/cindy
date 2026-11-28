import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { useModelSettingsSource } from '@/components/settings/modelSettingsSource';
import type {
  ModelContextLimitTarget,
  ModelContextLimitView,
} from '../../shared/modelContextLimit';

const log = createLogger('UseModelContextLimit');
const EMPTY: ModelContextLimitView = { limit: null, isCustomized: false };

/** The editor commits on blur. Requests never outlive their model/owner generation. */
export function useModelContextLimit(target: ModelContextLimitTarget | null) {
  const key = JSON.stringify(target);
  const stableTarget = useMemo<ModelContextLimitTarget | null>(() => JSON.parse(key), [key]);
  const [state, setState] = useState({ ...EMPTY, key, loading: true, error: false });
  // Another device's settings (cloud instance page) answer instead of this device.
  const source = useModelSettingsSource();
  const remote = source !== null;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Resolved when a request runs, like a direct preload call.
  const maker = () => sourceRef.current?.maker ?? window.electronAPI.maker;
  const generation = useRef(0);
  const pendingWrite = useRef<{
    request: number; owner: ReturnType<typeof getDataOwnerGeneration>; refresh: boolean;
  } | null>(null);

  const run = useCallback(
    async (write?: { limit: number | null } | { compactionPct: number | null }) => {
      // A save owns its result and recovery; provider notifications must not supersede it.
      if (!write && pendingWrite.current?.request === generation.current
        && isDataOwnerGenerationCurrent(pendingWrite.current.owner)) {
        pendingWrite.current.refresh = true;
        return;
      }
      const request = ++generation.current;
      if (!stableTarget) {
        setState({ ...EMPTY, key, loading: false, error: false });
        return;
      }
      const owner = getDataOwnerGeneration();
      if (write) pendingWrite.current = { request, owner, refresh: false };
      const stamp = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation };
      const current = () => request === generation.current && isDataOwnerGenerationCurrent(owner);
      const read = async () => {
        let view: ModelContextLimitView;
        do {
          if (pendingWrite.current?.request === request) pendingWrite.current.refresh = false;
          view = await maker().getModelContextLimit(stableTarget);
        } while (current() && pendingWrite.current?.request === request && pendingWrite.current.refresh);
        return view;
      };
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        let view = write
          ? 'compactionPct' in write
            ? await maker().setModelCompaction(stableTarget, write.compactionPct, stamp)
            : await maker().setModelContextLimit(stableTarget, write.limit, stamp)
          : await read();
        if (write && current() && (stableTarget.agent === 'codex' || pendingWrite.current?.refresh)) {
          view = await read();
        }
        if (current()) setState({ ...view, key, loading: false, error: false });
      } catch (error) {
        log.warn('model context limit request failed', error);
        // A failed runtime refresh is rolled back by main. Read the committed
        // value even if rollback/readback also failed; never retain a stale edit.
        if (write && current()) {
          try {
            const view = await read();
            if (current()) setState({ ...view, key, loading: false, error: true });
            return;
          } catch (readError) {
            log.warn('model context limit recovery read failed', readError);
          }
        }
        if (current()) setState((prev) => ({ ...prev, loading: false, error: true }));
      } finally {
        if (pendingWrite.current?.request === request) pendingWrite.current = null;
      }
    },
    [stableTarget, key],
  );

  useEffect(() => {
    setState({ ...EMPTY, key, loading: stableTarget !== null, error: false });
    // This device's provider changes say nothing about another device's limits.
    const unsubscribe = remote
      ? undefined
      : window.electronAPI?.maker?.onProvidersChanged?.(() => { void run(); });
    void run();
    return () => {
      unsubscribe?.();
      generation.current += 1;
    };
  }, [run, stableTarget, key, remote]);

  const setLimit = useCallback((limit: number | null) => run({ limit }), [run]);
  const reset = useCallback(() => run({ limit: null }), [run]);
  const setCompaction = useCallback((compactionPct: number | null) => run({ compactionPct }), [run]);
  return { ...(state.key === key ? state : { ...EMPTY, loading: true, error: false }), setLimit, reset, setCompaction };
}

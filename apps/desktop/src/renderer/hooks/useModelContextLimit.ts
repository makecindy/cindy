import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
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
  const [state, setState] = useState({ ...EMPTY, loading: true, error: false });
  const generation = useRef(0);

  const run = useCallback(
    async (write?: { limit: number | null }) => {
      const request = ++generation.current;
      if (!stableTarget) {
        setState({ ...EMPTY, loading: false, error: false });
        return;
      }
      const owner = getDataOwnerGeneration();
      const stamp = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation };
      const current = () => request === generation.current && isDataOwnerGenerationCurrent(owner);
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        let view = write
          ? await window.electronAPI.maker.setModelContextLimit(stableTarget, write.limit, stamp)
          : await window.electronAPI.maker.getModelContextLimit(stableTarget);
        if (write && stableTarget.agent === 'codex' && current()) {
          view = await window.electronAPI.maker.getModelContextLimit(stableTarget);
        }
        if (current()) setState({ ...view, loading: false, error: false });
      } catch (error) {
        log.warn('model context limit request failed', error);
        // A failed runtime refresh is rolled back by main. Read the committed
        // value even if rollback/readback also failed; never retain a stale edit.
        if (write && current()) {
          try {
            const view = await window.electronAPI.maker.getModelContextLimit(stableTarget);
            if (current()) setState({ ...view, loading: false, error: true });
            return;
          } catch (readError) {
            log.warn('model context limit recovery read failed', readError);
          }
        }
        if (current()) setState((prev) => ({ ...prev, loading: false, error: true }));
      }
    },
    [stableTarget],
  );

  useEffect(() => {
    setState({ ...EMPTY, loading: stableTarget !== null, error: false });
    void run();
    return () => {
      generation.current += 1;
    };
  }, [run, stableTarget]);

  const setLimit = useCallback((limit: number | null) => run({ limit }), [run]);
  const reset = useCallback(() => run({ limit: null }), [run]);
  return { ...state, setLimit, reset };
}

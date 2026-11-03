import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import type {
  ModelImageInputTarget,
  ModelImageInputView,
} from '../../shared/modelImageInputOverride';

const log = createLogger('UseModelImageInputOverride');
const EMPTY: ModelImageInputView = { value: null, mixed: false };

/** Requests never outlive their model or owner; catalog pushes cannot supersede a save. */
export function useModelImageInputOverride(target: ModelImageInputTarget | null) {
  const key = JSON.stringify(target);
  const stableTarget = useMemo<ModelImageInputTarget | null>(() => JSON.parse(key), [key]);
  const [state, setState] = useState({ ...EMPTY, key, loading: true, error: false });
  const generation = useRef(0);
  const pendingWrite = useRef<{
    request: number;
    owner: ReturnType<typeof getDataOwnerGeneration>;
    refresh: boolean;
  } | null>(null);

  const run = useCallback(
    async (write?: { value: boolean | null }) => {
      // A save owns its result and recovery; provider notifications must not supersede it.
      if (
        !write &&
        pendingWrite.current?.request === generation.current &&
        isDataOwnerGenerationCurrent(pendingWrite.current.owner)
      ) {
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
        let view: ModelImageInputView;
        do {
          if (pendingWrite.current?.request === request) pendingWrite.current.refresh = false;
          view = await window.electronAPI.maker.getModelImageInputOverride(stableTarget);
        } while (
          current() &&
          pendingWrite.current?.request === request &&
          pendingWrite.current.refresh
        );
        return view;
      };
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        let view = write
          ? await window.electronAPI.maker.setModelImageInputOverride(
              stableTarget,
              write.value,
              stamp,
            )
          : await read();
        if (write && current() && pendingWrite.current?.refresh) {
          view = await read();
        }
        if (current()) setState({ ...view, key, loading: false, error: false });
      } catch (error) {
        log.warn('model image input request failed', error);
        // A failed runtime refresh is rolled back by main. Read the committed
        // value even if rollback/readback also failed; never retain a stale edit.
        if (write && current()) {
          try {
            const view = await read();
            if (current()) setState({ ...view, key, loading: false, error: true });
            return;
          } catch (readError) {
            log.warn('model image input recovery read failed', readError);
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
    let active = true;
    let observedOwner = getDataOwnerGeneration();
    const unsubscribeOwner = window.electronAPI?.onAuthStateChange?.(() => {
      // AuthContext publishes the accepted owner fence synchronously while
      // handling this push. Wait until every listener has seen the event.
      queueMicrotask(() => {
        if (!active || isDataOwnerGenerationCurrent(observedOwner)) return;
        observedOwner = getDataOwnerGeneration();
        pendingWrite.current = null;
        void run();
      });
    });
    const unsubscribe = window.electronAPI?.maker?.onProvidersChanged?.(() => {
      void run();
    });
    void run();
    return () => {
      active = false;
      unsubscribeOwner?.();
      unsubscribe?.();
      generation.current += 1;
    };
  }, [run, stableTarget, key]);

  const setValue = useCallback((value: boolean | null) => run({ value }), [run]);
  return { ...(state.key === key ? state : { ...EMPTY, loading: true, error: false }), setValue };
}

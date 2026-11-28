import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { useModelSettingsSource } from '@/components/settings/modelSettingsSource';
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
  // Another device's settings (cloud instance page) answer instead of this device.
  const source = useModelSettingsSource();
  const remote = source !== null;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Resolved when a request runs, like a direct preload call.
  const maker = () => sourceRef.current?.maker ?? window.electronAPI?.maker;
  // An older device runtime cannot read or change this override.
  const unavailable = remote && !source.maker.getModelImageInputOverride;
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
      const api = maker();
      if (!stableTarget || !api?.getModelImageInputOverride || !api.setModelImageInputOverride) {
        setState({ ...EMPTY, key, loading: false, error: false });
        return;
      }
      const { getModelImageInputOverride, setModelImageInputOverride } = api;
      const owner = getDataOwnerGeneration();
      if (write) pendingWrite.current = { request, owner, refresh: false };
      const stamp = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation };
      const current = () => request === generation.current && isDataOwnerGenerationCurrent(owner);
      const read = async () => {
        let view: ModelImageInputView;
        do {
          if (pendingWrite.current?.request === request) pendingWrite.current.refresh = false;
          view = await getModelImageInputOverride(stableTarget);
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
          ? await setModelImageInputOverride(stableTarget, write.value, stamp)
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
    // This device's owner and provider changes say nothing about another device's override.
    const unsubscribeOwner = remote ? undefined : window.electronAPI?.onAuthStateChange?.(() => {
      // AuthContext publishes the accepted owner fence synchronously while
      // handling this push. Wait until every listener has seen the event.
      queueMicrotask(() => {
        if (!active || isDataOwnerGenerationCurrent(observedOwner)) return;
        observedOwner = getDataOwnerGeneration();
        pendingWrite.current = null;
        void run();
      });
    });
    const unsubscribe = remote ? undefined : window.electronAPI?.maker?.onProvidersChanged?.(() => {
      void run();
    });
    void run();
    return () => {
      active = false;
      unsubscribeOwner?.();
      unsubscribe?.();
      generation.current += 1;
    };
  }, [run, stableTarget, key, remote]);

  const setValue = useCallback((value: boolean | null) => run({ value }), [run]);
  return { ...(state.key === key ? state : { ...EMPTY, loading: true, error: false }), unavailable, setValue };
}

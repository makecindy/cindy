import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

const log = createLogger('UseCompactionSettings');

// main (compaction-settings-store) 是 clamp 的唯一 source of truth: IPC 返回值已是
// [50,95] 内的合法整数, Slider 也用 min/max/step 约束输入。
const DEFAULT_PCT = 75;
const WRITE_DEBOUNCE_MS = 300;

export type CompactionAgent = 'claude' | 'pi';

type CompactionApi = {
  getState: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
  setPct: (pct: number) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
  resetPct: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
};

export function useCompactionSettings(agent: CompactionAgent = 'claude'): {
  pct: number | null;
  isCustomized: boolean;
  defaultPct: number;
  setPct: (next: number) => void;
  resetPct: () => Promise<number>;
} {
  const api = useMemo<CompactionApi>(
    () =>
      agent === 'pi'
        ? {
            getState: window.electronAPI.maker.piCompactionGetState,
            setPct: window.electronAPI.maker.piCompactionSetPct,
            resetPct: window.electronAPI.maker.piCompactionResetPct,
          }
        : {
            getState: window.electronAPI.maker.compactionGetState,
            setPct: window.electronAPI.maker.compactionSetPct,
            resetPct: window.electronAPI.maker.compactionResetPct,
          },
    [agent],
  );

  const [pct, setPctState] = useState<number | null>(null);
  const [isCustomized, setIsCustomized] = useState(false);
  const [defaultPct, setDefaultPct] = useState(DEFAULT_PCT);
  const mountedRef = useRef(false);
  const pendingPctRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadPct = useCallback(async () => {
    try {
      const next = await api.getState();
      if (mountedRef.current) {
        setPctState(next.pct);
        setIsCustomized(next.isCustomized);
        setDefaultPct(next.defaultPct);
      }
    } catch (err) {
      log.warn('compactionGetState failed', err);
      if (mountedRef.current) setPctState(DEFAULT_PCT);
    }
  }, [api]);

  const commitPct = useCallback(
    async (next: number) => {
      try {
        const state = await api.setPct(next);
        if (mountedRef.current) {
          setPctState(state.pct);
          setIsCustomized(state.isCustomized);
          setDefaultPct(state.defaultPct);
        }
      } catch (err) {
        log.warn('compactionSetPct failed', err);
        await reloadPct();
      }
    },
    [api, reloadPct],
  );

  const setPct = useCallback(
    (next: number) => {
      setPctState(next);
      pendingPctRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingPctRef.current = null;
        void commitPct(next);
      }, WRITE_DEBOUNCE_MS);
    },
    [commitPct],
  );

  const resetPct = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingPctRef.current = null;
    const next = await api.resetPct();
    if (mountedRef.current) {
      setPctState(next.pct);
      setIsCustomized(next.isCustomized);
      setDefaultPct(next.defaultPct);
    }
    return next.pct;
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void reloadPct();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingPctRef.current;
      pendingPctRef.current = null;
      if (pending !== null) {
        void api.setPct(pending);
      }
    };
  }, [api, reloadPct]);

  return { pct, isCustomized, defaultPct, setPct, resetPct };
}

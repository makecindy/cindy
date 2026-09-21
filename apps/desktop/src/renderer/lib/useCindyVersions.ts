import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import type { CindyVersionAction, CindyVersionsState } from '../../shared/cindyVersions';

export function useCindyVersions(enabled = true, refreshKey?: string) {
  const [state, setState] = useState<CindyVersionsState>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);
  const owner = getDataOwnerGeneration();
  const current = () => active.current && isDataOwnerGenerationCurrent(owner);
  const refresh = useCallback(async () => {
    if (!enabled || typeof window.electronAPI.getCindyVersions !== 'function') return;
    const version = ++generation.current;
    try {
      const next = await window.electronAPI.getCindyVersions();
      if (current() && version === generation.current) setState(next);
    } catch {
      if (current()) setError('unavailable');
    }
  }, [enabled, owner.dataOwnerId, owner.generation]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const focus = () => {
      if (!busy.current) void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      active.current = false;
      window.removeEventListener('focus', focus);
    };
  }, [refresh, refreshKey]);
  const act = async (action: CindyVersionAction, id: string) => {
    if (busy.current || !current()) return;
    busy.current = true;
    generation.current += 1;
    setPending(id);
    setError(undefined);
    try {
      const next = await window.electronAPI.actCindyVersion(action, id);
      if (current()) setState(next);
    } catch (failure) {
      const code = extractIpcError(failure)?.message;
      if (current())
        setError(
          code && ['busy', 'incompatible', 'launchFailed'].includes(code) ? code : 'unavailable',
        );
    } finally {
      busy.current = false;
      if (current()) setPending(undefined);
    }
  };
  return { state, pending, error, act, refresh };
}

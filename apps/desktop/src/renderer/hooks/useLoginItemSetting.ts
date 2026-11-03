import { useCallback, useEffect, useRef, useState } from 'react';

import type { LoginItemState } from '../../shared/loginItem';
import { extractIpcError } from '@/utils/ipcError';

/** Reads native state on mount/focus; serializes edits and discards stale reads. */
export function useLoginItemSetting() {
  const [state, setState] = useState<LoginItemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'loadFailed' | 'saveFailed' | 'notApplied' | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const saving = useRef(false);
  const platform = window.electronAPI?.platform;
  const supported = platform === 'win32' || platform === 'darwin';

  const refresh = useCallback(async () => {
    if (saving.current) return;
    const current = ++generation.current;
    setBusy(true);
    try {
      const next = await window.electronAPI.windowBehavior.getLoginItem();
      if (mounted.current && generation.current === current) {
        setState(next);
        setError(null);
      }
    } catch {
      if (mounted.current && generation.current === current) {
        setState(null);
        setError('loadFailed');
      }
    } finally {
      if (mounted.current && generation.current === current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (supported) {
      void refresh();
      window.addEventListener('focus', refresh);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('focus', refresh);
    };
  }, [supported, refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (saving.current) return;
    saving.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await window.electronAPI.windowBehavior.setLoginItem(enabled);
      if (mounted.current && generation.current === current) setState(next);
    } catch (err) {
      // Native writes may have partially applied. Re-read instead of presenting
      // an optimistic value or blindly rolling back the system setting.
      const next = await window.electronAPI.windowBehavior.getLoginItem().catch(() => null);
      if (mounted.current && generation.current === current) {
        setState(next);
        setError(
          extractIpcError(err)?.code === 'PRECONDITION_FAILED' ? 'notApplied' : 'saveFailed',
        );
      }
    } finally {
      saving.current = false;
      if (mounted.current && generation.current === current) setBusy(false);
    }
  }, []);

  return { state, busy, error, setEnabled, supported };
}

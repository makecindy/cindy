import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { AwayGuardDelaySeconds, AwayGuardPreviewResult, AwayGuardState } from '../../shared/awayGuard';

type PreviewState = 'idle' | 'starting' | Extract<AwayGuardPreviewResult, { ok: false }>['reason'];

/** Local privacy screen preferences and the last attempt to show the screen. */
export function useAwayGuardSetting() {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<PreviewState>('idle');
  const [state, setState] = useState<AwayGuardState | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  // Main confirms the OS version (macOS 14+, supported Hyprland). Windows is implemented
  // but off until verified on Windows hardware (WINDOWS_PRIVACY_SCREEN_ENABLED).
  const supported = ['darwin', 'linux'].includes(window.electronAPI?.platform ?? '');

  const applyState = useCallback((next: AwayGuardState) => {
    setReadFailed(false);
    setState(next);
    setPreview((value) => {
      if (value !== 'permission' && value !== 'checkFailed') return value;
      if (next.permission === 'unknown') return 'checkFailed';
      return next.permission === 'missing' ? 'permission' : 'idle';
    });
  }, []);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await window.electronAPI.windowBehavior.getAwayGuardState();
      if (mounted.current && generation.current === current) applyState(next);
    } catch {
      if (mounted.current && generation.current === current) setReadFailed(true);
    }
  }, [applyState]);

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

  const save = useCallback(
    async (write: () => Promise<AwayGuardState>) => {
      const current = ++generation.current;
      try {
        const next = await write();
        if (!mounted.current) return;
        if (generation.current === current) {
          applyState(next);
        } else {
          // A focus read may have finished before the preference was committed.
          void refresh();
        }
      } catch {
        if (mounted.current) {
          toast.error(t('settings.windowBehavior.awayGuard.saveFailed'));
          void refresh();
        }
      }
    },
    [applyState, refresh, t],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await save(() => window.electronAPI.windowBehavior.setAwayGuardEnabled(enabled));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [save],
  );
  const setDelay = useCallback(
    (seconds: AwayGuardDelaySeconds | null) => save(() => window.electronAPI.windowBehavior.setAwayGuardDelay(seconds)),
    [save],
  );

  const startPreview = useCallback(async () => {
    setPreview('starting');
    try {
      const result = await window.electronAPI.windowBehavior.previewAwayGuard();
      if (!mounted.current) return;
      setPreview(result.ok ? 'idle' : result.reason);
      if (result.ok) void refresh();
    } catch {
      if (mounted.current) setPreview('unavailable');
    }
  }, [refresh]);
  return {
    readFailed,
    available: supported && state?.available === true,
    state,
    busy,
    setEnabled,
    setDelay,
    preview,
    startPreview,
    refresh,
  };
}

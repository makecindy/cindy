import { useCallback, useEffect, useRef, useState } from 'react';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import type { LocalNetworkState } from '../../shared/localNetwork';

/**
 * macOS Local Network access of this computer. Main pushes every change; `poll`
 * also re-reads while a settings row is on screen, so a grant made in System
 * Settings shows up without returning focus to Cindy. With `probe: false` the
 * hook only reads what Main already knows; `probeOnFocus` decides at focus time
 * whether to probe (an always-mounted surface passes "am I visible"), so a
 * hidden surface never triggers the system prompt.
 */
export function useLocalNetworkAccess({
  poll = false,
  probe = true,
  probeOnFocus,
}: { poll?: boolean; probe?: boolean; probeOnFocus?: () => boolean } = {}) {
  const [state, setState] = useState<LocalNetworkState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [prompted, setPrompted] = useState(false);
  const [openedSettingsLocal, setOpenedSettingsLocal] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const supported = window.electronAPI?.platform === 'darwin' && !!window.electronAPI.localNetwork;

  const focusProbe = useRef(probeOnFocus);
  focusProbe.current = probeOnFocus;

  const applyState = useCallback((next: LocalNetworkState) => {
    setState(next);
    if (next.access !== 'denied') {
      setPrompted(false);
      setOpenedSettingsLocal(false);
      setFailed(false);
    }
  }, []);

  const refresh = useCallback(async (fresh = probe) => {
    if (!supported) return;
    try {
      const next = await window.electronAPI.localNetwork.status({ probe: fresh });
      if (mounted.current) applyState(next);
    } catch {
      // Unknown is not denied: say nothing rather than a wrong reminder.
    }
  }, [applyState, probe, supported]);

  useEffect(() => {
    mounted.current = true;
    if (!supported) return () => {
      mounted.current = false;
    };
    void refresh();
    const off = window.electronAPI.localNetwork.onChanged((next) => {
      if (mounted.current) applyState(next);
    });
    const onFocus = () => void refresh(focusProbe.current ? focusProbe.current() : probe);
    window.addEventListener('focus', onFocus);
    // With background throttling off (running tasks), a minimized window still reports
    // `visible`; the window-hidden broadcast is the reliable signal (main/windowHiddenBroadcast.ts).
    const timer = poll
      ? setInterval(() => {
          if (!document.hidden && !isWindowHidden()) void refresh();
        }, 1500)
      : null;
    return () => {
      mounted.current = false;
      off();
      window.removeEventListener('focus', onFocus);
      if (timer) clearInterval(timer);
    };
  }, [applyState, poll, probe, refresh, supported]);

  /** Trigger the native macOS permission prompt without hijacking focus to System Settings. */
  const request = useCallback(async () => {
    if (!supported || requesting) return;
    setRequesting(true);
    setFailed(false);
    try {
      const next = await window.electronAPI.localNetwork.request();
      if (!mounted.current) return;
      applyState(next);
      if (next.access === 'denied') setPrompted(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setRequesting(false);
    }
  }, [applyState, requesting, supported]);

  /** Open System Settings (or a fresh System Settings window on retry). */
  const openSettings = useCallback(async () => {
    if (!supported || requesting) return;
    setRequesting(true);
    setFailed(false);
    const separateWindow = state?.settingsOpenStage === 'standard';
    try {
      const next = await window.electronAPI.localNetwork.request({
        openSettings: true,
        ...(separateWindow ? { separateWindow: true } : {}),
      });
      if (!mounted.current) return;
      applyState(next);
      if (next.access === 'denied') setOpenedSettingsLocal(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setRequesting(false);
    }
  }, [applyState, requesting, state?.settingsOpenStage, supported]);

  const appBundlePath = state?.appBundlePath;
  const revealApp = useCallback(async () => {
    if (!appBundlePath || !window.electronAPI?.showItemInFolder) return;
    setFailed(false);
    try {
      const result = await window.electronAPI.showItemInFolder({ filePath: appBundlePath });
      if (mounted.current && !result.success) setFailed(true);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, [appBundlePath]);

  const settingsStage = state?.settingsOpenStage;
  const openedSettings =
    state?.access === 'denied' && (openedSettingsLocal || (settingsStage !== undefined && settingsStage !== 'none'));
  const separateWindowRetry = state?.access === 'denied' && settingsStage === 'standard';

  return {
    state,
    requesting,
    prompted: state?.access === 'denied' && prompted,
    openedSettings,
    separateWindowRetry,
    appBundlePath,
    failed,
    request,
    openSettings,
    revealApp,
  };
}

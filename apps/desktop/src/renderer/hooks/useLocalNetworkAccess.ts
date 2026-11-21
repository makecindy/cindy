import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalNetworkState } from '../../shared/localNetwork';

/**
 * macOS Local Network access of this computer. Main pushes every change; `poll`
 * also re-reads while a settings row is on screen, so a grant made in System
 * Settings shows up without returning focus to Cindy.
 */
export function useLocalNetworkAccess({ poll = false }: { poll?: boolean } = {}) {
  const [state, setState] = useState<LocalNetworkState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [openedSettings, setOpenedSettings] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const supported = window.electronAPI?.platform === 'darwin' && !!window.electronAPI.localNetwork;

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const next = await window.electronAPI.localNetwork.status();
      if (mounted.current) setState(next);
    } catch {
      // Unknown is not denied: say nothing rather than a wrong reminder.
    }
  }, [supported]);

  useEffect(() => {
    mounted.current = true;
    if (!supported) return () => {
      mounted.current = false;
    };
    void refresh();
    const off = window.electronAPI.localNetwork.onChanged((next) => {
      if (mounted.current) setState(next);
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = poll
      ? setInterval(() => {
          if (!document.hidden) void refresh();
        }, 1500)
      : null;
    return () => {
      mounted.current = false;
      off();
      window.removeEventListener('focus', onFocus);
      if (timer) clearInterval(timer);
    };
  }, [poll, refresh, supported]);

  const request = useCallback(async () => {
    if (!supported || requesting) return;
    setRequesting(true);
    setFailed(false);
    try {
      const next = await window.electronAPI.localNetwork.request();
      if (!mounted.current) return;
      setState(next);
      if (next.access === 'denied') setOpenedSettings(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setRequesting(false);
    }
  }, [requesting, supported]);

  return { state, requesting, openedSettings, failed, request };
}

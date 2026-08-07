import { useCallback, useEffect, useState, type RefObject } from 'react';

import { createLogger } from '@/lib/logger';

import type {
  RsbNativePopupCommand,
  RsbNativePopupSnapshot,
} from '../../../../shared/rsbNativePopup';
import type { UseBrowserWebviewResult } from './useBrowserWebview';

const log = createLogger('rightSidebar.nativePopupSurface');

const EMPTY_SNAPSHOT: RsbNativePopupSnapshot = {
  url: 'about:blank',
  title: '',
  favicon: null,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  isAudible: false,
  crash: null,
};

export interface UseNativePopupSurfaceResult extends UseBrowserWebviewResult {
  closed: boolean;
}

export function useNativePopupSurface(
  surfaceId: string | undefined,
  sessionId: string | undefined,
  tabId: string,
  slotRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
): UseNativePopupSurfaceResult {
  const [snapshot, setSnapshot] = useState<RsbNativePopupSnapshot>(EMPTY_SNAPSHOT);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!surfaceId || !sessionId) return;
    let cancelled = false;
    const off = window.electronAPI.rsbNativePopup.onEvent((event) => {
      if (event.surfaceId !== surfaceId) return;
      if (event.type === 'closed') {
        setClosed(true);
      } else {
        setSnapshot(event.snapshot);
      }
    });
    void window.electronAPI.rsbNativePopup
      .claim({ surfaceId, sessionId, tabId })
      .then((result) => {
        if (cancelled) return;
        if (!result.alive) {
          setClosed(true);
          return;
        }
        setSnapshot(result.snapshot);
      })
      .catch((err) => {
        if (!cancelled) log.warn('native popup claim failed', { surfaceId, err });
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, surfaceId, tabId]);

  useEffect(() => {
    if (!surfaceId) return;
    const slot = slotRef.current;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = slot?.getBoundingClientRect();
        const left = rect ? Math.max(0, Math.ceil(rect.left)) : 0;
        const top = rect ? Math.max(0, Math.ceil(rect.top)) : 0;
        const right = rect ? Math.min(window.innerWidth, Math.floor(rect.right)) : 1;
        const bottom = rect ? Math.min(window.innerHeight, Math.floor(rect.bottom)) : 1;
        const width = Math.max(1, right - left);
        const height = Math.max(1, bottom - top);
        const actuallyVisible =
          visible &&
          Boolean(rect) &&
          rect!.width > 0 &&
          rect!.height > 0 &&
          right > left &&
          bottom > top;
        void window.electronAPI.rsbNativePopup
          .setBounds({
            surfaceId,
            bounds: { x: left, y: top, width, height },
            visible: actuallyVisible,
          })
          .catch(() => undefined);
      });
    };
    const resizeObserver = slot ? new ResizeObserver(sync) : null;
    if (slot) resizeObserver?.observe(slot);
    const intersectionObserver = slot ? new IntersectionObserver(sync) : null;
    if (slot) intersectionObserver?.observe(slot);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      void window.electronAPI.rsbNativePopup
        .setBounds({
          surfaceId,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          visible: false,
        })
        .catch(() => undefined);
    };
  }, [slotRef, surfaceId, visible]);

  const command = useCallback(
    (input: RsbNativePopupCommand) => {
      if (!surfaceId) return;
      void window.electronAPI.rsbNativePopup
        .command({ ...input, surfaceId })
        .catch((err) => log.warn('native popup command failed', { surfaceId, err }));
    },
    [surfaceId],
  );

  const navigate = useCallback(
    (url: string) => {
      setSnapshot((current) => ({ ...current, url, favicon: null, isLoading: true, crash: null }));
      command({ command: 'navigate', url });
    },
    [command],
  );
  const reload = useCallback(() => {
    setSnapshot((current) => ({ ...current, isLoading: true, crash: null }));
    command({ command: 'reload' });
  }, [command]);
  const goBack = useCallback(() => command({ command: 'go-back' }), [command]);
  const goForward = useCallback(() => command({ command: 'go-forward' }), [command]);
  const stop = useCallback(() => {
    setSnapshot((current) => ({ ...current, isLoading: false }));
    command({ command: 'stop' });
  }, [command]);

  return {
    wrapper: null,
    webview: null,
    ...snapshot,
    resourceAlert: null,
    navigate,
    reload,
    goBack,
    goForward,
    stop,
    dismissResourceAlert: () => undefined,
    closed,
  };
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

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

/** Native child views sit above the host DOM regardless of CSS z-index. Use the
 * host's hit test so every full-window preview (including portals outside the
 * chat tree) can cover the native page without destroying its browsing context.
 * Local content and the slot's own full-window ancestors are not occluders. */
function isCoveredByGlobalOverlay(slot: HTMLElement, x: number, y: number): boolean {
  // Preview panels have margins and are siblings of their full-window scrim.
  // Walking only the top hit's ancestors misses the scrim beneath the panel.
  for (const hit of document.elementsFromPoint(x, y)) {
    // Layers below the slot do not cover it. Also stop for a slot descendant
    // (e.g. a guest placeholder) or ancestor instead of hiding for background UI.
    if (hit.contains(slot) || slot.contains(hit)) return false;
    let element: Element | null = hit;
    while (element && !element.contains(slot)) {
      if (element === document.fullscreenElement) return true;
      if (getComputedStyle(element).position === 'fixed') {
        const rect = element.getBoundingClientRect();
        if (
          rect.left <= 0 && rect.top <= 0 &&
          rect.right >= window.innerWidth && rect.bottom >= window.innerHeight
        ) return true;
      }
      element = element.parentElement;
    }
  }
  return false;
}

export interface UseNativePopupSurfaceResult extends UseBrowserWebviewResult {
  closed: boolean;
}

export function useNativePopupSurface(
  surfaceId: string | undefined,
  sessionId: string | undefined,
  tabId: string,
  slotRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
  focusRequest = 0,
): UseNativePopupSurfaceResult {
  const [snapshot, setSnapshot] = useState<RsbNativePopupSnapshot>(EMPTY_SNAPSHOT);
  const [closed, setClosed] = useState(false);
  const consumedFocusRequest = useRef(focusRequest);

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
    let lastUpdate: {
      surfaceId: string;
      bounds: { x: number; y: number; width: number; height: number };
      visible: boolean;
    } | undefined;
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
          bottom > top &&
          !isCoveredByGlobalOverlay(slot!, (left + right) / 2, (top + bottom) / 2);
        // Consume even when hidden/covered: a delayed show must not steal focus.
        const focus = actuallyVisible && consumedFocusRequest.current !== focusRequest;
        consumedFocusRequest.current = focusRequest;
        // A streaming chat can mutate the host DOM on every frame. Only send
        // changes in native geometry/visibility, not one IPC per text update.
        if (
          !focus && lastUpdate?.visible === actuallyVisible &&
          lastUpdate.bounds.x === left && lastUpdate.bounds.y === top &&
          lastUpdate.bounds.width === width && lastUpdate.bounds.height === height
        ) return;
        const update = {
          surfaceId,
          bounds: { x: left, y: top, width, height },
          visible: actuallyVisible,
          ...(focus ? { focus: true } : {}),
        };
        lastUpdate = update;
        void window.electronAPI.rsbNativePopup
          .setBounds(update)
          .catch(() => { if (lastUpdate === update) lastUpdate = undefined; });
      });
    };
    const resizeObserver = slot ? new ResizeObserver(sync) : null;
    if (slot) resizeObserver?.observe(slot);
    const intersectionObserver = slot ? new IntersectionObserver(sync) : null;
    if (slot) intersectionObserver?.observe(slot);
    // Overlay mount/unmount, retained previews toggling class/style, and closing
    // animations must all update native visibility, even when the slot does not
    // resize. Observe only in foreground; activation performs a fresh hit test.
    const overlayObserver = visible ? new MutationObserver(sync) : null;
    overlayObserver?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'data-state'],
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('transitionend', sync, true);
    document.addEventListener('animationend', sync, true);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      overlayObserver?.disconnect();
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('transitionend', sync, true);
      document.removeEventListener('animationend', sync, true);
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
  }, [slotRef, surfaceId, visible, focusRequest]);

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

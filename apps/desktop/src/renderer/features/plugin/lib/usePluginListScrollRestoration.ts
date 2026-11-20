import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react';
import { readPluginCatalogAnchor, restorePluginCatalogAnchor, type PluginCatalogAnchor } from './pluginCatalogAnchor';

export interface PluginListScrollRestoration {
  listRef: RefObject<HTMLElement | null>;
  onListScroll: (event: UIEvent<HTMLElement>) => void;
  capture: (focusId?: string) => void;
  requestRestore: () => void;
  clearPendingRestore: () => void;
}

/**
 * Keeps a catalog's scroll offset across a conditional list/detail mount.
 * The caller decides when a return should restore the saved position.
 */
export function usePluginListScrollRestoration(listVisible: boolean, saved?: { offset: number; anchor?: PluginCatalogAnchor | null }): PluginListScrollRestoration {
  const listRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(saved?.offset ?? 0);
  const pendingRestoreRef = useRef(!!saved?.offset);
  const wasListVisibleRef = useRef(false);
  const anchorRef = useRef(saved?.anchor ?? null);
  const focusIdRef = useRef<string | null>(null);

  const onListScroll = useCallback((event: UIEvent<HTMLElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop;
    if (saved) saved.offset = scrollTopRef.current;
    anchorRef.current = readPluginCatalogAnchor(event.currentTarget);
    if (saved) saved.anchor = anchorRef.current;
  }, [saved]);

  const capture = useCallback((focusId?: string) => {
    const list = listRef.current;
    if (list) { scrollTopRef.current = list.scrollTop; anchorRef.current = readPluginCatalogAnchor(list); }
    const active = document.activeElement;
    focusIdRef.current = focusId ?? (active instanceof HTMLElement && list?.contains(active)
      ? active.closest<HTMLElement>('[data-plugin-id]')?.dataset.pluginId ?? null : null);
    if (saved) saved.offset = scrollTopRef.current;
    if (saved) saved.anchor = anchorRef.current;
  }, [saved]);

  const requestRestore = useCallback(() => {
    pendingRestoreRef.current = true;
  }, []);

  const clearPendingRestore = useCallback(() => {
    pendingRestoreRef.current = false;
    focusIdRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const wasListVisible = wasListVisibleRef.current;
    wasListVisibleRef.current = listVisible;
    if (!listVisible || wasListVisible || !pendingRestoreRef.current) return;

    const list = listRef.current;
    if (!list) return;
    // Restore before paint so returning from detail never flashes the top.
    list.scrollTop = scrollTopRef.current;
    restorePluginCatalogAnchor(list, anchorRef.current);
    pendingRestoreRef.current = false;
    if (!focusIdRef.current) return;
    const restoreFocus = () => {
      if (!focusIdRef.current) return true;
      const cards = [...list.querySelectorAll<HTMLElement>('[data-plugin-id]')].filter(node => !node.closest('[hidden]'));
      const anchor = anchorRef.current;
      const card = [focusIdRef.current, ...(anchor ? [anchor.id, ...(anchor.following ?? [])] : [])]
        .map(id => cards.find(node => node.dataset.pluginId === id)).find(Boolean);
      const target = card?.matches('[tabindex], button') ? card : card?.querySelector<HTMLElement>('[role="button"], button, [tabindex]');
      if (!target) return false;
      target.focus({ preventScroll: true });
      focusIdRef.current = null;
      return true;
    };
    if (restoreFocus()) return;
    // The grid commits its restored virtual range after its ancestor ref mounts.
    // Observe that commit before paint rather than focusing a fallback first row.
    const observer = new MutationObserver(() => { if (restoreFocus()) observer.disconnect(); });
    observer.observe(list, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [listVisible]);

  return {
    listRef,
    onListScroll,
    capture,
    requestRestore,
    clearPendingRestore,
  };
}

import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react';

export interface PluginListScrollRestoration {
  listRef: RefObject<HTMLElement | null>;
  onListScroll: (event: UIEvent<HTMLElement>) => void;
  capture: () => void;
  requestRestore: () => void;
  clearPendingRestore: () => void;
}

/**
 * Keeps a catalog's scroll offset across a conditional list/detail mount.
 * The caller decides when a return should restore the saved position.
 */
export function usePluginListScrollRestoration(listVisible: boolean): PluginListScrollRestoration {
  const listRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(0);
  const pendingRestoreRef = useRef(false);
  const wasListVisibleRef = useRef(listVisible);

  const onListScroll = useCallback((event: UIEvent<HTMLElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop;
  }, []);

  const capture = useCallback(() => {
    const list = listRef.current;
    if (list) scrollTopRef.current = list.scrollTop;
  }, []);

  const requestRestore = useCallback(() => {
    pendingRestoreRef.current = true;
  }, []);

  const clearPendingRestore = useCallback(() => {
    pendingRestoreRef.current = false;
  }, []);

  useLayoutEffect(() => {
    const wasListVisible = wasListVisibleRef.current;
    wasListVisibleRef.current = listVisible;
    if (!listVisible || wasListVisible || !pendingRestoreRef.current) return;

    const list = listRef.current;
    if (!list) return;
    // Restore before paint so returning from detail never flashes the top.
    list.scrollTop = scrollTopRef.current;
    pendingRestoreRef.current = false;
  }, [listVisible]);

  return {
    listRef,
    onListScroll,
    capture,
    requestRestore,
    clearPendingRestore,
  };
}

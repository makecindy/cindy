import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

const loadingByTabId = new Map<string, boolean>();
const listenersByTabId = new Map<string, Set<Listener>>();

function notify(tabId: string): void {
  listenersByTabId.get(tabId)?.forEach((listener) => listener());
}

export function setWebBrowserLoading(tabId: string, loading: boolean): void {
  if (loadingByTabId.get(tabId) === loading) return;
  if (loading) {
    loadingByTabId.set(tabId, true);
  } else {
    loadingByTabId.delete(tabId);
  }
  notify(tabId);
}

export function useWebBrowserLoading(tabId: string | undefined): boolean {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!tabId) return () => undefined;
      let listeners = listenersByTabId.get(tabId);
      if (!listeners) {
        listeners = new Set();
        listenersByTabId.set(tabId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) listenersByTabId.delete(tabId);
      };
    },
    [tabId],
  );
  const getSnapshot = useCallback(
    () => (tabId ? loadingByTabId.get(tabId) === true : false),
    [tabId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

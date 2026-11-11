import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PluginReviewUpdate } from '../../shared/pluginContributions';
import { useAuth } from './AuthContext';

const empty: PluginReviewUpdate[] = [];
const PluginReviewUpdatesContext = createContext<{
  updates: PluginReviewUpdate[];
  refresh: () => Promise<void>;
  markRead: (pluginId: string, key: string) => Promise<void>;
}>({
  updates: empty,
  refresh: async () => {},
  markRead: async () => {},
});
export const usePluginReviewUpdates = () => useContext(PluginReviewUpdatesContext);

/** One foreground reader for the app; reading a list never acknowledges a result. */
export function PluginReviewUpdatesProvider({ children }: { children: ReactNode }) {
  const { dataOwnerId, dataOwnerGeneration, user, mode } = useAuth();
  const owner = JSON.stringify([dataOwnerId, dataOwnerGeneration, user?.id, mode]);
  const contributor = mode === 'cloud' && (user?.membershipKind === 'personal' || user?.membershipKind === 'org');
  const current = useRef(owner);
  current.current = owner;
  const [snapshot, setSnapshot] = useState({ owner, updates: empty });
  const lifecycle = useRef(0);
  const pending = useRef<{ owner: string; task: Promise<void> } | null>(null);
  const marking = useRef(new Set<string>());
  const acknowledged = useRef({ owner, keys: new Set<string>() });
  const refresh = useCallback(async () => {
    if (!contributor || document.visibilityState !== 'visible') return;
    if (pending.current?.owner === owner) return pending.current.task;
    const generation = lifecycle.current;
    const task = (async () => {
      try {
        const updates = await window.electronAPI.pluginContributions.reviewUpdates();
        if (current.current !== owner || lifecycle.current !== generation) return;
        setSnapshot({ owner, updates: updates.map(item => acknowledged.current.owner === owner && acknowledged.current.keys.has(item.key)
          ? { ...item, unread: false } : item) });
      } catch { /* Preserve an existing unread result during an offline interval. */ }
    })();
    pending.current = { owner, task };
    try { await task; }
    finally { if (pending.current?.task === task) pending.current = null; }
  }, [owner, contributor]);
  const markRead = useCallback(async (pluginId: string, key: string) => {
    const request = JSON.stringify([owner, pluginId, key]);
    if (!contributor || marking.current.has(request)) return;
    marking.current.add(request);
    const generation = lifecycle.current;
    try {
      await window.electronAPI.pluginContributions.markReviewRead(pluginId, key);
      if (current.current !== owner || lifecycle.current !== generation) return;
      if (acknowledged.current.owner !== owner) acknowledged.current = { owner, keys: new Set() };
      acknowledged.current.keys.add(key);
      setSnapshot(previous => previous.owner !== owner ? previous : {
        owner, updates: previous.updates.map(item => item.pluginId === pluginId && item.key === key ? { ...item, unread: false } : item),
      });
    } catch { /* A failed read receipt must leave the dot visible. */ }
    finally { marking.current.delete(request); }
  }, [owner, contributor]);
  useEffect(() => {
    lifecycle.current++;
    pending.current = null;
    void refresh();
    const sync = () => { void refresh(); };
    const timer = window.setInterval(sync, 60_000);
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      lifecycle.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      window.removeEventListener('online', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [refresh]);
  return <PluginReviewUpdatesContext.Provider value={{ updates: contributor && snapshot.owner === owner ? snapshot.updates : empty, refresh, markRead }}>
    {children}
  </PluginReviewUpdatesContext.Provider>;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PluginReviewUpdate } from '../../shared/pluginContributions';
import { useWindowShown } from '@/hooks/useWindowVisible';
import { useAuth } from './AuthContext';

const empty: PluginReviewUpdate[] = [];
const PluginReviewUpdatesContext = createContext<{
  updates: PluginReviewUpdate[];
  /**
   * The organization change signal the team results were read at. It also moves on changes that
   * are not review results (a first submission, becoming a maintainer); null until read or when
   * the server has no signal.
   */
  teamChangeToken: string | null;
  refresh: () => Promise<void>;
  markRead: (pluginId: string, key: string) => Promise<void>;
}>({
  updates: empty,
  teamChangeToken: null,
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
  // Public and team (organization) results are separate slices read independently: a slow or
  // failing side never holds back or clears the other (#1541).
  const [snapshot, setSnapshot] = useState<{
    owner: string; publicUpdates: PluginReviewUpdate[]; teamUpdates: PluginReviewUpdate[]; teamChangeToken: string | null;
  }>({ owner, publicUpdates: empty, teamUpdates: empty, teamChangeToken: null });
  const lifecycle = useRef(0);
  const pending = useRef<Record<'public' | 'team', { owner: string; task: Promise<void> } | null>>({ public: null, team: null });
  const marking = useRef(new Set<string>());
  const acknowledged = useRef({ owner, keys: new Set<string>() });
  const organization = user?.membershipKind === 'org';
  const readSlice = useCallback((
    slice: 'public' | 'team',
    read: () => Promise<{ updates: PluginReviewUpdate[]; changeToken?: string | null }>,
  ) => {
    if (pending.current[slice]?.owner === owner) return pending.current[slice]!.task;
    const generation = lifecycle.current;
    const task = (async () => {
      try {
        const { updates, changeToken = null } = await read();
        if (current.current !== owner || lifecycle.current !== generation) return;
        const visible = updates.map(item => acknowledged.current.owner === owner && acknowledged.current.keys.has(item.key)
          ? { ...item, unread: false } : item);
        setSnapshot(previous => {
          const base = previous.owner === owner ? previous : { owner, publicUpdates: empty, teamUpdates: empty, teamChangeToken: null };
          return slice === 'public' ? { ...base, publicUpdates: visible } : { ...base, teamUpdates: visible, teamChangeToken: changeToken };
        });
      } catch { /* Preserve this slice's existing unread results during an offline interval. */ }
    })();
    pending.current[slice] = { owner, task };
    return task.finally(() => { if (pending.current[slice]?.task === task) pending.current[slice] = null; });
  }, [owner]);
  // Reads only while the user can see the window: with background throttling off (a running turn
  // or a voice call) a hidden window still reports visibilityState 'visible', so Main's
  // window-hidden signal gates reads too, and showing the window again triggers one read.
  const shown = useWindowShown();
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const refresh = useCallback(async () => {
    if (!contributor || document.visibilityState !== 'visible' || !shownRef.current) return;
    const team = organization ? window.electronAPI.pluginAuthor?.reviewUpdates : undefined;
    await Promise.all([
      readSlice('public', async () => ({ updates: await window.electronAPI.pluginContributions.reviewUpdates() })),
      ...(team ? [readSlice('team', () => team())] : []),
    ]);
  }, [contributor, organization, readSlice]);
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
      const clear = (items: PluginReviewUpdate[]) =>
        items.map(item => item.pluginId === pluginId && item.key === key ? { ...item, unread: false } : item);
      setSnapshot(previous => previous.owner !== owner ? previous : {
        ...previous, publicUpdates: clear(previous.publicUpdates), teamUpdates: clear(previous.teamUpdates),
      });
    } catch { /* A failed read receipt must leave the dot visible. */ }
    finally { marking.current.delete(request); }
  }, [owner, contributor]);
  useEffect(() => {
    lifecycle.current++;
    pending.current = { public: null, team: null };
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
  useEffect(() => {
    if (shown) void refresh();
  }, [shown, refresh]);
  const updates = useMemo(() => contributor && snapshot.owner === owner
    ? organization ? [...snapshot.publicUpdates, ...snapshot.teamUpdates] : snapshot.publicUpdates
    : empty, [contributor, organization, snapshot, owner]);
  const teamChangeToken = contributor && organization && snapshot.owner === owner ? snapshot.teamChangeToken : null;
  return <PluginReviewUpdatesContext.Provider value={{ updates, teamChangeToken, refresh, markRead }}>
    {children}
  </PluginReviewUpdatesContext.Provider>;
}

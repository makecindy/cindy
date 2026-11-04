import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth, type MobileUser } from '@/auth/AuthContext';
import {
  readHomeNavigationPreferences, saveHomeNavigationPreferences,
  type HomeNavigationPreferences, type LastTeammateIdentity,
} from './homeViewPreferenceStore';
import { startBoundedStartupRead } from './mobileHomeStartup';

/** Membership, not display name/email, owns the choice. No migration from unscoped bot ids. */
export function homeNavigationOwner(user: MobileUser | null): string {
  return user ? JSON.stringify([user.passportId, user.membershipKind, user.orgId, user.id]) : '';
}
interface Snapshot {
  hydrated: boolean;
  lastTeammate: LastTeammateIdentity | null;
  teammatesCollapsed: boolean;
  showCollapsedTeammateAvatars: boolean;
}
const initial: Snapshot = { hydrated: false, lastTeammate: null, teammatesCollapsed: false, showCollapsedTeammateAvatars: true };
interface Entry { snapshot: Snapshot; revision: number; loading?: Promise<void> }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function entryFor(owner: string): Entry {
  let entry = entries.get(owner);
  if (!entry) { entry = { snapshot: initial, revision: 0 }; entries.set(owner, entry); }
  return entry;
}
function publish(entry: Entry, patch: Partial<Snapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  listeners.forEach((listener) => listener());
}
function hydrate(owner: string, entry: Entry): Promise<void> {
  if (entry.snapshot.hydrated) return Promise.resolve();
  if (entry.loading) return entry.loading;
  const revision = entry.revision;
  const read = startBoundedStartupRead<HomeNavigationPreferences>(readHomeNavigationPreferences(owner), {});
  entry.loading = read.initial.then(({ value: stored, timedOut }) => {
    publish(entry, entry.revision === revision
      ? { hydrated: true, lastTeammate: stored.lastTeammate ?? null,
        teammatesCollapsed: stored.teammatesCollapsed ?? false,
        showCollapsedTeammateAvatars: stored.showCollapsedTeammateAvatars ?? true }
      : { hydrated: true });
    if (timedOut) void read.completion.then((result) => {
      // Late values only fill in what the user has not changed since the timeout.
      if (result.ok && entry.revision === revision) publish(entry, {
        showCollapsedTeammateAvatars: result.value.showCollapsedTeammateAvatars ?? true,
        lastTeammate: result.value.lastTeammate ?? null, teammatesCollapsed: result.value.teammatesCollapsed ?? false,
      });
    });
  });
  return entry.loading;
}

/** Shared reactive preference for home and companion headers; defaults never write themselves. */
export function useHomeMode() {
  const { user } = useAuth();
  const owner = homeNavigationOwner(user);
  const entry = entryFor(owner);
  const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot, () => initial);
  useEffect(() => { if (owner) void hydrate(owner, entry); }, [entry, owner]);
  const update = useCallback((patch: { lastTeammate?: LastTeammateIdentity | null; teammatesCollapsed?: boolean; showCollapsedTeammateAvatars?: boolean }) => {
    if (!owner) return Promise.resolve();
    // Hydrate first so one write cannot erase the other, not yet read, preference.
    return hydrate(owner, entry).then(() => {
      entry.revision += 1;
      publish(entry, patch);
      // Navigation must not wait behind a stalled native storage write: the choice is shared in
      // memory at once, and a failed write only means the next launch shows the earlier choice.
      void saveHomeNavigationPreferences(owner, patch).catch(() => undefined);
    });
  }, [entry, owner]);
  const selectTeammate = useCallback((identity: LastTeammateIdentity) => update({ lastTeammate: identity }), [update]);
  const setTeammatesCollapsed = useCallback((teammatesCollapsed: boolean) => update({ teammatesCollapsed }), [update]);
  const setShowCollapsedTeammateAvatars = useCallback((showCollapsedTeammateAvatars: boolean) => update({ showCollapsedTeammateAvatars }), [update]);
  return { ...snapshot, owner, selectTeammate, setTeammatesCollapsed, setShowCollapsedTeammateAvatars };
}

/** Hold the startup splash until the home's teammate section knows its stored collapse state. */
export function useHomeStartupSplashRelease(releaseSplash: () => void): void {
  const auth = useAuth();
  const { owner, hydrated } = useHomeMode();
  useEffect(() => {
    if (auth.initialized && (!auth.isAuthenticated || !owner || hydrated)) releaseSplash();
  }, [auth.initialized, auth.isAuthenticated, hydrated, owner, releaseSplash]);
}

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
  inboxShowCollapsedTeammateAvatars: boolean;
  taskSuggestionFooterDismissed?: true;
}
const initial: Snapshot = { hydrated: false, lastTeammate: null, teammatesCollapsed: false, showCollapsedTeammateAvatars: true, inboxShowCollapsedTeammateAvatars: true };
type NavigationPatch = Partial<Omit<Snapshot, 'hydrated'>>;
interface Entry { snapshot: Snapshot; edits: NavigationPatch; loading?: Promise<void> }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function entryFor(owner: string): Entry {
  let entry = entries.get(owner);
  if (!entry) { entry = { snapshot: initial, edits: {} }; entries.set(owner, entry); }
  return entry;
}
function publish(entry: Entry, patch: Partial<Snapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  listeners.forEach((listener) => listener());
}
function hydrate(owner: string, entry: Entry): Promise<void> {
  if (entry.snapshot.hydrated) return Promise.resolve();
  if (entry.loading) return entry.loading;
  const restore = (stored: HomeNavigationPreferences) => publish(entry, {
    ...initial, ...stored, ...entry.edits, hydrated: true,
  });
  const read = startBoundedStartupRead<HomeNavigationPreferences>(readHomeNavigationPreferences(owner), {});
  entry.loading = read.initial.then(({ value: stored, timedOut }) => {
    restore(stored);
    if (timedOut) void read.completion.then(result => {
      if (result.ok) restore(result.value);
    });
  });
  return entry.loading;
}

function useHomePreferenceEntry(user: MobileUser | null) {
  const owner = homeNavigationOwner(user);
  const entry = entryFor(owner);
  useEffect(() => { if (owner) void hydrate(owner, entry); }, [entry, owner]);
  return { owner, entry };
}

/** Shared reactive preference for home and companion headers; defaults never write themselves. */
export function useHomeMode(mode: 'tasks' | 'inbox' = 'tasks') {
  const { user } = useAuth();
  const { owner, entry } = useHomePreferenceEntry(user);
  const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot, () => initial);
  const update = useCallback((patch: NavigationPatch) => {
    if (!owner) return Promise.resolve();
    // Hydrate first so one write cannot erase the other, not yet read, preference.
    return hydrate(owner, entry).then(() => {
      Object.assign(entry.edits, patch);
      publish(entry, patch);
      // Navigation must not wait behind a stalled native storage write: the choice is shared in
      // memory at once, and a failed write only means the next launch shows the earlier choice.
      void saveHomeNavigationPreferences(owner, patch).catch(() => undefined);
    });
  }, [entry, owner]);
  const selectTeammate = useCallback((identity: LastTeammateIdentity) => update({ lastTeammate: identity }), [update]);
  const setTeammatesCollapsed = useCallback((teammatesCollapsed: boolean) => update({ teammatesCollapsed }), [update]);
  const avatarKey = mode === 'inbox' ? 'inboxShowCollapsedTeammateAvatars' : 'showCollapsedTeammateAvatars';
  const setShowCollapsedTeammateAvatars = useCallback((enabled: boolean) => update({ [avatarKey]: enabled }), [avatarKey, update]);
  const dismissTaskSuggestionFooter = useCallback(() => update({ taskSuggestionFooterDismissed: true }), [update]);
  return { ...snapshot, showCollapsedTeammateAvatars: snapshot[avatarKey], owner, selectTeammate, setTeammatesCollapsed, setShowCollapsedTeammateAvatars, dismissTaskSuggestionFooter };
}

/** Hold the startup splash until the home's teammate section knows its stored collapse state. */
export function useHomeStartupSplashRelease(releaseSplash: () => void): void {
  const auth = useAuth();
  const { owner, entry } = useHomePreferenceEntry(auth.user);
  // AuthGate owns the root navigator. Selecting a teammate must not refresh that tree just
  // because the startup gate was also listening to lastTeammate or home display preferences.
  const hydrated = useSyncExternalStore(subscribe, () => entry.snapshot.hydrated, () => initial.hydrated);
  useEffect(() => {
    if (auth.initialized && (!auth.isAuthenticated || !owner || hydrated)) releaseSplash();
  }, [auth.initialized, auth.isAuthenticated, hydrated, owner, releaseSplash]);
}

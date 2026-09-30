import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth, type MobileUser } from '@/auth/AuthContext';
import {
  readHomeNavigationPreferences, saveHomeNavigationPreferences,
  type HomeMode, type HomeNavigationPreferences, type LastTeammateIdentity,
} from './homeViewPreferenceStore';
import { startBoundedStartupRead } from './mobileHomeStartup';

/** Membership, not display name/email, owns the choice. No migration from unscoped bot ids. */
export function homeNavigationOwner(user: MobileUser | null): string {
  return user ? JSON.stringify([user.passportId, user.membershipKind, user.orgId, user.id]) : '';
}
interface Snapshot {
  hydrated: boolean;
  mode: HomeMode;
  lastTeammate: LastTeammateIdentity | null;
  /** Startup recovery only; explicit mode selection must land on the roster. Never persisted. */
  restoreLastTeammate: boolean;
  saveFailed: boolean;
}
const initial: Snapshot = { hydrated: false, mode: 'tasks', lastTeammate: null, restoreLastTeammate: true, saveFailed: false };
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
      ? { hydrated: true, mode: stored.mode ?? 'tasks', lastTeammate: stored.lastTeammate ?? null }
      : { hydrated: true });
    if (timedOut) void read.completion.then((result) => {
      // Never switch away from the task list the user has begun using after a timeout.
      // The stored mode remains intact on disk; only recover the identity for the next explicit switch.
      if (result.ok && entry.revision === revision) publish(entry, { lastTeammate: result.value.lastTeammate ?? null });
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
  const update = useCallback((patch: { mode?: HomeMode; lastTeammate?: LastTeammateIdentity | null }) => {
    if (!owner) return Promise.resolve();
    // Hydrate first so changing mode cannot erase an unread last-teammate choice.
    return hydrate(owner, entry).then(() => {
      entry.revision += 1;
      const revision = entry.revision;
      publish(entry, { ...patch, saveFailed: false });
      // Navigation must not wait behind a stalled native storage write. The preference is
      // immediately shared in memory; durable failure is reported separately, never as success.
      void saveHomeNavigationPreferences(owner, patch).catch(() => {
        if (entry.revision === revision) publish(entry, { saveFailed: true });
      });
    });
  }, [entry, owner]);
  const setMode = useCallback((mode: HomeMode) => {
    // Fence recovery before hydration publishes a remembered teammate or mounts its pane.
    // Keeping this in the shared in-memory snapshot also covers route remounts.
    if (owner) publish(entry, { restoreLastTeammate: false });
    return update({ mode });
  }, [entry, owner, update]);
  const rememberTeammate = useCallback((identity: LastTeammateIdentity | null) => update({ lastTeammate: identity }), [update]);
  const selectTeammate = useCallback((identity: LastTeammateIdentity) => update({ mode: 'teammates', lastTeammate: identity }), [update]);
  return { ...snapshot, owner, setMode, rememberTeammate, selectTeammate };
}

/**
 * New Maker worktree source-branch preferences owned by this work endpoint.
 *
 * A source branch describes one repository, not the device-wide New Maker
 * draft. Persist it under a canonical repo-scoped key so local Desktop and
 * device-link controllers share one value across renderer and host restarts
 * without leaking a branch from repository A into repository B.
 */
import path from 'node:path';
import Store from 'electron-store';

export interface NewMakerWorktreeBranchPreferenceSnapshot {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
}

interface NewMakerWorktreeBranchPreferenceStoreShape {
  preferences: Record<string, NewMakerWorktreeBranchPreferenceSnapshot>;
}

/**
 * The host is the source of truth for this preference.  Keep the cache in the
 * main process for cheap reads, but back it with electron-store so a Desktop
 * restart does not silently reset a repo's branch choice.  The old Map-only
 * implementation made the renderer fall back to the checkout branch after
 * every restart, which was especially surprising when Worktree was enabled.
 */
let storeInstance: Store<NewMakerWorktreeBranchPreferenceStoreShape> | null = null;

function getStore(): Store<NewMakerWorktreeBranchPreferenceStoreShape> {
  if (storeInstance) return storeInstance;
  storeInstance = new Store<NewMakerWorktreeBranchPreferenceStoreShape>({
    name: 'new-maker-worktree-branch-preferences',
    defaults: { preferences: {} },
    schema: {
      preferences: { type: 'object' },
    },
    clearInvalidConfig: true,
  });
  return storeInstance;
}

function readPreferences(): Record<string, NewMakerWorktreeBranchPreferenceSnapshot> {
  const raw = getStore().get('preferences', {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, NewMakerWorktreeBranchPreferenceSnapshot>;
}

function writePreferences(
  preferences: Record<string, NewMakerWorktreeBranchPreferenceSnapshot>,
): void {
  getStore().set('preferences', preferences);
}

/** Canonical wire/store key. Callers validate that baseRepo is absolute first. */
export function canonicalizeNewMakerWorktreeBaseRepo(baseRepo: string): string {
  return path.resolve(baseRepo.trim());
}

export function getNewMakerWorktreeBranchPreference(
  baseRepo: string,
): NewMakerWorktreeBranchPreferenceSnapshot | null {
  return readPreferences()[canonicalizeNewMakerWorktreeBaseRepo(baseRepo)] ?? null;
}

/**
 * Last host-accepted write wins. Same-value writes still advance revision so a
 * controller can fence a pull or invoke completion that started before it.
 */
export function applyNewMakerWorktreeBranchPreference(input: {
  baseRepo: string;
  sourceBranch: string;
}): NewMakerWorktreeBranchPreferenceSnapshot {
  const baseRepo = canonicalizeNewMakerWorktreeBaseRepo(input.baseRepo);
  const preferences = readPreferences();
  const current = preferences[baseRepo];
  const snapshot: NewMakerWorktreeBranchPreferenceSnapshot = {
    baseRepo,
    sourceBranch: input.sourceBranch.trim(),
    revision: (current?.revision ?? 0) + 1,
  };
  preferences[baseRepo] = snapshot;
  writePreferences(preferences);
  return snapshot;
}

/** Test-only reset for the persisted preference map. */
export function resetNewMakerWorktreeBranchPreferencesForTest(): void {
  writePreferences({});
}

/** Test hook for replacing the electron-store instance without touching disk. */
export function _setNewMakerWorktreeBranchPreferenceStoreForTest(
  store: Store<NewMakerWorktreeBranchPreferenceStoreShape> | null,
): void {
  storeInstance = store;
}

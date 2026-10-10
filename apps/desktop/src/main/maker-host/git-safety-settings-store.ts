/**
 * git-safety-settings-store —— Git safety workflow machine settings.
 *
 * File: <userData>/git-safety-settings.json
 *   { "mode": "existing-git", "declinedNonEmptyProjects": [] }
 *
 * New installs snapshot existing Git projects without initializing empty
 * folders. The override file stores only customized fields, so future default
 * changes can flow to users who never changed the setting.
 */

import { app } from 'electron';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('git-safety-settings-store');

export type GitSafetyMode = 'off' | 'existing-git' | 'all-projects';

export interface GitSafetySettings {
  mode: GitSafetyMode;
  /** Derived compatibility field for existing snapshot consumers. */
  autoSnapshotEnabled: boolean;
  /** Whether local non-Git projects may be bootstrapped (non-empty needs consent). */
  autoInitProjectGit: boolean;
}

interface PersistedGitSafetySettings {
  mode: GitSafetyMode;
  declinedNonEmptyProjects: string[];
}

const DEFAULTS: PersistedGitSafetySettings = {
  mode: 'existing-git',
  declinedNonEmptyProjects: [],
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'git-safety-settings.json');
}

function normalize(raw: unknown): PersistedGitSafetySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const legacyMode =
    typeof r.autoSnapshotEnabled === 'boolean'
      ? r.autoSnapshotEnabled
        ? 'all-projects'
        : 'off'
      : undefined;
  const mode: GitSafetyMode =
    legacyMode !== undefined && (r.mode === undefined || r.mode === DEFAULTS.mode)
      ? legacyMode
      : r.mode === 'off' || r.mode === 'existing-git' || r.mode === 'all-projects'
        ? r.mode
        : DEFAULTS.mode;
  return {
    mode,
    declinedNonEmptyProjects: Array.isArray(r.declinedNonEmptyProjects)
      ? r.declinedNonEmptyProjects.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function derive(persisted: PersistedGitSafetySettings): GitSafetySettings {
  return {
    mode: persisted.mode,
    autoSnapshotEnabled: persisted.mode !== 'off',
    autoInitProjectGit: persisted.mode === 'all-projects',
  };
}

function mergeOverrides({
  patch,
  next,
  overrides,
}: {
  patch: Partial<PersistedGitSafetySettings>;
  next: PersistedGitSafetySettings;
  overrides: Record<string, unknown>;
}): Record<string, unknown> {
  const updated = { ...overrides };
  if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
    // Keep an explicit selection even when it matches today's default. This
    // preserves the user's choice if the default changes in a later release.
    updated.mode = next.mode;
    delete updated.autoSnapshotEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'declinedNonEmptyProjects')) {
    updated.declinedNonEmptyProjects = next.declinedNonEmptyProjects;
  }
  return updated;
}

const store = createOverrideSettingsFile<PersistedGitSafetySettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  mergeOverrides,
  log,
  label: 'git safety',
});

export function readGitSafetySettings(): GitSafetySettings {
  return derive(store.read());
}

export function readGitSafetySettingsState(): OverrideSettingsState<GitSafetySettings> {
  const state = store.readState();
  return {
    ...state,
    value: derive(state.value),
    defaults: derive(state.defaults),
  };
}

export function writeGitSafetyMode(mode: GitSafetyMode): OverrideSettingsState<GitSafetySettings> {
  store.writePatch({ mode });
  log.info('git safety setting written', { mode });
  return readGitSafetySettingsState();
}

/** Compatibility for callers still sending the old boolean during migration. */
export function writeGitSafetyAutoSnapshotEnabled(
  autoSnapshotEnabled: boolean,
): OverrideSettingsState<GitSafetySettings> {
  return writeGitSafetyMode(autoSnapshotEnabled ? 'all-projects' : 'off');
}

export function resetGitSafetySettings(): GitSafetySettings {
  return derive(store.reset());
}

function projectConsentKey(workingDir: string): string {
  const resolved = path.resolve(workingDir);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Keep the lexical path when the directory disappeared between turns.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** A declined prompt stays quiet across turns and restarts; resetting Git safety clears it. */
export function hasDeclinedNonEmptyProjectGit(workingDir: string): boolean {
  store.invalidateIfChanged();
  const declined = store.read().declinedNonEmptyProjects;
  const lexical = path.resolve(workingDir);
  const legacyKey = process.platform === 'win32' ? lexical.toLowerCase() : lexical;
  const canonical = projectConsentKey(workingDir);
  return declined.some(
    (key) => key === canonical || key === legacyKey || projectConsentKey(key) === canonical,
  );
}

export async function recordDeclinedNonEmptyProjectGit(workingDir: string): Promise<void> {
  const key = projectConsentKey(workingDir);
  await store.updateAtomic(({ value }) => ({
    declinedNonEmptyProjects: [...new Set([...value.declinedNonEmptyProjects, key])],
  }));
}

export const __testing = { mergeOverrides, normalize };

/**
 * git-safety-settings-store —— Git safety workflow machine settings.
 *
 * File: <userData>/git-safety-settings.json
 *   { "mode": "existing-git" }
 *
 * New installs snapshot existing Git projects without initializing empty
 * folders. The override file stores only customized fields, so future default
 * changes can flow to users who never changed the setting.
 */

import { app } from 'electron';
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
  /** Whether an empty local non-Git project may be bootstrapped. */
  autoInitProjectGit: boolean;
}

interface PersistedGitSafetySettings {
  mode: GitSafetyMode;
}

const DEFAULTS: PersistedGitSafetySettings = {
  mode: 'existing-git',
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

export function writeGitSafetyMode(
  mode: GitSafetyMode,
): OverrideSettingsState<GitSafetySettings> {
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

export const __testing = { mergeOverrides, normalize };

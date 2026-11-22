import path from 'node:path';
import { createOverrideSettingsFile } from '../../../desktop/src/main/maker-host/override-settings-file.js';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

export interface NewMakerWorktreeBranchPreferenceSnapshot {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
}

interface StoreShape {
  preferences: Record<string, NewMakerWorktreeBranchPreferenceSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const store = createOverrideSettingsFile<StoreShape>({
  filePath: () => path.join(getUserDataDir(), 'new-maker-worktree-branch-preferences.json'),
  defaults: { preferences: {} },
  normalize(raw) {
    const preferences: StoreShape['preferences'] = {};
    if (!isRecord(raw) || !isRecord(raw.preferences)) return { preferences };
    for (const [baseRepo, snapshot] of Object.entries(raw.preferences)) {
      if (!isRecord(snapshot) || typeof snapshot.baseRepo !== 'string' ||
        typeof snapshot.sourceBranch !== 'string' || typeof snapshot.revision !== 'number' ||
        !Number.isInteger(snapshot.revision) || snapshot.revision < 0) continue;
      preferences[baseRepo] = {
        baseRepo: snapshot.baseRepo,
        sourceBranch: snapshot.sourceBranch,
        revision: snapshot.revision,
      };
    }
    return { preferences };
  },
  log: createLogger('host-worktree-branch-preferences'),
  label: 'Host worktree branch preferences',
});

function canonicalize(baseRepo: string): string {
  return path.resolve(baseRepo.trim());
}

export function getNewMakerWorktreeBranchPreference(
  baseRepo: string,
): NewMakerWorktreeBranchPreferenceSnapshot | null {
  return store.read().preferences[canonicalize(baseRepo)] ?? null;
}

export function applyNewMakerWorktreeBranchPreference(input: {
  baseRepo: string;
  sourceBranch: string;
}): NewMakerWorktreeBranchPreferenceSnapshot {
  const baseRepo = canonicalize(input.baseRepo);
  const current = getNewMakerWorktreeBranchPreference(baseRepo);
  const snapshot: NewMakerWorktreeBranchPreferenceSnapshot = {
    baseRepo,
    sourceBranch: input.sourceBranch.trim(),
    revision: (current?.revision ?? 0) + 1,
  };
  store.writePatch({ preferences: { ...store.read().preferences, [baseRepo]: snapshot } });
  return snapshot;
}

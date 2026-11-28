import path from 'node:path';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { createAsyncJsonSettings } from './async-json-settings.js';

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

const store = createAsyncJsonSettings<StoreShape>({
  filePath: () => path.join(getUserDataDir(), 'new-maker-worktree-branch-preferences.json'),
  defaults: () => ({ preferences: {} }),
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

export async function getNewMakerWorktreeBranchPreference(
  baseRepo: string,
): Promise<NewMakerWorktreeBranchPreferenceSnapshot | null> {
  return (await store.read()).preferences[canonicalize(baseRepo)] ?? null;
}

export function applyNewMakerWorktreeBranchPreference(input: {
  baseRepo: string;
  sourceBranch: string;
}): Promise<NewMakerWorktreeBranchPreferenceSnapshot> {
  const baseRepo = canonicalize(input.baseRepo);
  // Read and revision bump inside one ordered update, so concurrent writes never reuse a revision.
  return store.update(current => {
    const snapshot: NewMakerWorktreeBranchPreferenceSnapshot = {
      baseRepo,
      sourceBranch: input.sourceBranch.trim(),
      revision: (current.preferences[baseRepo]?.revision ?? 0) + 1,
    };
    return { next: { preferences: { ...current.preferences, [baseRepo]: snapshot } }, result: snapshot };
  });
}

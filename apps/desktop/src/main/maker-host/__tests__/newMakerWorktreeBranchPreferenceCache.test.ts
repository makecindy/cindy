import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backingStore = {
  preferences: {} as Record<string, { baseRepo: string; sourceBranch: string; revision: number }>,
};

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: 'preferences', fallback: typeof backingStore.preferences) {
      return backingStore[key] ?? fallback;
    }

    set(key: 'preferences', value: typeof backingStore.preferences) {
      backingStore[key] = value;
    }
  },
}));

import {
  _setNewMakerWorktreeBranchPreferenceStoreForTest,
  applyNewMakerWorktreeBranchPreference,
  getNewMakerWorktreeBranchPreference,
  resetNewMakerWorktreeBranchPreferencesForTest,
} from '../newMakerWorktreeBranchPreferenceCache';

describe('newMakerWorktreeBranchPreferenceCache', () => {
  beforeEach(() => {
    backingStore.preferences = {};
    _setNewMakerWorktreeBranchPreferenceStoreForTest(null);
    resetNewMakerWorktreeBranchPreferencesForTest();
  });

  afterEach(() => {
    resetNewMakerWorktreeBranchPreferencesForTest();
    _setNewMakerWorktreeBranchPreferenceStoreForTest(null);
  });

  it('returns null until a repository has a host-owned selection', () => {
    expect(getNewMakerWorktreeBranchPreference('/tmp/repo')).toBeNull();
  });

  it('canonicalizes the repository key and isolates different repositories', () => {
    const snapshot = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/parent/../repo/',
      sourceBranch: ' feature/mobile ',
    });

    expect(snapshot).toEqual({
      baseRepo: path.resolve('/tmp/repo'),
      sourceBranch: 'feature/mobile',
      revision: 1,
    });
    expect(getNewMakerWorktreeBranchPreference('/tmp/repo/.')).toEqual(snapshot);
    expect(getNewMakerWorktreeBranchPreference('/tmp/other')).toBeNull();
  });

  it('increments a per-repository revision even when the value is unchanged', () => {
    const first = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'main',
    });
    const second = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'main',
    });
    const other = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-b',
      sourceBranch: 'main',
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(other.revision).toBe(1);
  });

  it('survives a host-store recreation and continues the persisted revision', () => {
    const first = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'feature/persisted',
    });

    // Simulate the lazy electron-store instance being rebuilt after Desktop
    // main-process restart while the on-disk backing data remains.
    _setNewMakerWorktreeBranchPreferenceStoreForTest(null);

    expect(getNewMakerWorktreeBranchPreference('/tmp/repo-a')).toEqual(first);
    expect(applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'feature/next',
    })).toMatchObject({
      sourceBranch: 'feature/next',
      revision: 2,
    });
  });
});

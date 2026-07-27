import { describe, expect, it } from 'vitest';

import {
  normalizeWorkingDirForGrouping,
  normalizeWorkingDirForProjectSettings,
  normalizeWorkingDirForStorage,
} from '../workingDir';

describe('workingDir normalization', () => {
  it('normalizes Windows-looking paths for storage', () => {
    expect(normalizeWorkingDirForStorage('D:\\repo\\project\\')).toBe('D:/repo/project');
    expect(normalizeWorkingDirForStorage('\\\\?\\D:\\repo\\project\\')).toBe('D:/repo/project');
    expect(normalizeWorkingDirForStorage('\\\\?\\UNC\\server\\share\\repo\\')).toBe('//server/share/repo');
  });

  it('preserves literal POSIX backslashes for storage and grouping', () => {
    expect(normalizeWorkingDirForStorage('/Users/me/a\\b/')).toBe('/Users/me/a\\b');
    expect(normalizeWorkingDirForStorage('/Users/me/a\\b\\')).toBe('/Users/me/a\\b\\');
    expect(normalizeWorkingDirForGrouping('/Users/me/a\\b/.xdt-worktrees/auto/src')).toBe(
      '/Users/me/a\\b',
    );
  });

  it('groups current and legacy managed worktrees under their base repo', () => {
    expect(normalizeWorkingDirForGrouping('/repo/.cindy-worktrees/new-one/src')).toBe('/repo');
    expect(normalizeWorkingDirForGrouping('/repo/.xdt-worktrees/old-one/src')).toBe('/repo');
  });

  it('keeps user-managed worktrees on their runtime path for project settings', () => {
    expect(
      normalizeWorkingDirForProjectSettings('/repo/.cindy-worktrees/managed/src'),
    ).toBe('/repo');
    expect(normalizeWorkingDirForProjectSettings('/repo/.worktrees/imported/src')).toBe(
      '/repo/.worktrees/imported/src',
    );
    expect(
      normalizeWorkingDirForProjectSettings('/repo/.claude/worktrees/manual/src'),
    ).toBe('/repo/.claude/worktrees/manual/src');
  });
});

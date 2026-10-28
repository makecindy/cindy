import { describe, expect, it } from 'vitest';

import {
  normalizeWorkingDirForGrouping,
  normalizeWorkingDirForProjectSettings,
  normalizeWorkingDirForStorage,
  workingDirEquals,
} from '../workingDir';

describe('workingDir normalization', () => {
  it('preserves significant whitespace through repeated storage normalization', () => {
    for (const path of ['/repo ', '/repo /', '/repo\t']) {
      const expected = path.endsWith('/') ? path.slice(0, -1) : path;
      expect(normalizeWorkingDirForStorage(path)).toBe(expected);
      expect(normalizeWorkingDirForStorage(normalizeWorkingDirForStorage(path))).toBe(expected);
      expect(normalizeWorkingDirForProjectSettings(path)).toBe(expected);
    }
    expect(normalizeWorkingDirForStorage(' \t ')).toBeNull();
  });

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

describe('workingDirEquals', () => {
  it('ignores storage-level spelling differences on every platform', () => {
    expect(workingDirEquals('/repo/foo', '/repo/foo/')).toBe(true);
    expect(workingDirEquals('D:\\repo\\foo', 'D:/repo/foo', { windows: true })).toBe(true);
    expect(workingDirEquals('\\\\?\\D:\\repo\\foo', 'D:/repo/foo')).toBe(true);
  });

  it('folds Windows drive / UNC case only when asked to', () => {
    expect(workingDirEquals('D:/repo/foo', 'd:/REPO/FOO', { windows: true })).toBe(true);
    expect(workingDirEquals('//server/share/foo', '//SERVER/SHARE/FOO', { windows: true })).toBe(true);
    expect(workingDirEquals('D:/repo/foo', 'd:/REPO/FOO', { windows: false })).toBe(false);
    // POSIX 下大小写敏感:不能把两个真实存在的不同目录当成同一个。
    expect(workingDirEquals('/repo/foo', '/REPO/FOO', { windows: true })).toBe(false);
  });

  it('reports distinct and empty directories as not equal', () => {
    expect(workingDirEquals('/repo/foo', '/repo/bar')).toBe(false);
    expect(workingDirEquals('/repo/foo', null)).toBe(false);
    expect(workingDirEquals(undefined, '')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  collapseWorktreeDirForGrouping,
  groupingWorktreeBaseRepo,
  isManagedWorktreeDirectoryName,
  managedWorktreeBaseRepo,
} from '../worktreePaths.js';

describe('worktreePaths', () => {
  it('collapses Cindy-managed worktrees (current and legacy dir name) to their base repo', () => {
    expect(managedWorktreeBaseRepo('/repo/.cindy-worktrees/serene-lovelace')).toBe('/repo');
    expect(managedWorktreeBaseRepo('/repo/.cindy-worktrees/serene-lovelace/src/main')).toBe('/repo');
    expect(managedWorktreeBaseRepo('/repo/.xdt-worktrees/pensive-pasteur')).toBe('/repo');
  });

  it('collapses conventional worktree layouts only for grouping', () => {
    expect(managedWorktreeBaseRepo('/repo/.worktrees/feature')).toBeNull();
    expect(managedWorktreeBaseRepo('/repo/.claude/worktrees/feature')).toBeNull();
    expect(groupingWorktreeBaseRepo('/repo/.worktrees/feature')).toBe('/repo');
    expect(groupingWorktreeBaseRepo('/repo/.claude/worktrees/feature/src')).toBe('/repo');
  });

  it('returns null when the path is not a worktree path', () => {
    expect(groupingWorktreeBaseRepo('/repo')).toBeNull();
    expect(groupingWorktreeBaseRepo('/repo/src/.cindy-worktreesish/name')).toBeNull();
    // 容器目录本身(后面没有 worktree 名)不是 worktree 路径。
    expect(groupingWorktreeBaseRepo('/repo/.cindy-worktrees')).toBeNull();
    expect(groupingWorktreeBaseRepo('/repo/.cindy-worktrees/')).toBeNull();
    // 相对路径直接以容器目录开头时定不出 base repo。
    expect(groupingWorktreeBaseRepo('.cindy-worktrees/serene-lovelace')).toBeNull();
  });

  it('keeps filesystem roots addressable', () => {
    expect(groupingWorktreeBaseRepo('/.cindy-worktrees/name')).toBe('/');
    expect(groupingWorktreeBaseRepo('C:/.cindy-worktrees/name')).toBe('C:/');
    expect(groupingWorktreeBaseRepo(String.raw`C:\.cindy-worktrees\name`)).toBe('C:\\');
    // 重复分隔符不该跟着漏进盘符根。
    expect(groupingWorktreeBaseRepo('C://.cindy-worktrees/name')).toBe('C:/');
  });

  it('preserves the incoming separator style', () => {
    expect(groupingWorktreeBaseRepo(String.raw`C:\Repo\App\.cindy-worktrees\calm-feynman`))
      .toBe(String.raw`C:\Repo\App`);
    expect(groupingWorktreeBaseRepo(String.raw`\\Server\Share\App\.worktrees\feature`))
      .toBe(String.raw`\\Server\Share\App`);
    expect(groupingWorktreeBaseRepo('//Server/Share/App/.worktrees/feature'))
      .toBe('//Server/Share/App');
  });

  it('does not treat literal backslashes in POSIX directory names as separators', () => {
    // POSIX 下反斜杠是合法文件名字符:`weird\.worktrees` 是一个目录名,不是容器目录。
    expect(groupingWorktreeBaseRepo(String.raw`/repo/weird\.worktrees/name`)).toBeNull();
    expect(groupingWorktreeBaseRepo(String.raw`/Users/me/a\b/.xdt-worktrees/auto/src`))
      .toBe(String.raw`/Users/me/a\b`);
  });

  it('collapses at the outermost worktree container when nested', () => {
    expect(groupingWorktreeBaseRepo('/repo/.cindy-worktrees/outer/.worktrees/inner'))
      .toBe('/repo');
  });

  it('collapseWorktreeDirForGrouping falls back to the input path', () => {
    expect(collapseWorktreeDirForGrouping('/repo/app')).toBe('/repo/app');
    expect(collapseWorktreeDirForGrouping('/repo/.cindy-worktrees/serene-lovelace')).toBe('/repo');
  });

  it('recognizes managed worktree container directory names', () => {
    expect(isManagedWorktreeDirectoryName('.cindy-worktrees')).toBe(true);
    expect(isManagedWorktreeDirectoryName('.xdt-worktrees')).toBe(true);
    expect(isManagedWorktreeDirectoryName('.worktrees')).toBe(false);
  });
});

/**
 * worktree-parallel-sessions: nameGenerator 冲突避让 + 后缀生成单测。
 */

import { describe, it, expect } from 'vitest';

import {
  blocksManagedWorktreeBranchNamespace,
  generateRawName,
  avoidCollision,
  generateUniqueName,
  getBranchName,
  getManagedWorktreeBranchCandidates,
  getManagedWorktreeNameFromBranch,
  getManagedWorktreeReservedName,
  isManagedWorktreeBranchForName,
  validateWorktreeName,
} from '../worktree/nameGenerator';

describe('nameGenerator', () => {
  it('generateRawName returns "<adj>-<surname>" pattern with lowercase + dash', () => {
    const name = generateRawName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('generateRawName never exceeds 20 chars (1000 samples, 用户需求 1)', () => {
    for (let i = 0; i < 1000; i += 1) {
      const name = generateRawName();
      expect(name.length).toBeLessThanOrEqual(20);
    }
  });

  it('avoidCollision returns the original name when not taken', () => {
    expect(avoidCollision('jolly-turing', [])).toBe('jolly-turing');
    expect(avoidCollision('jolly-turing', ['eager-curie'])).toBe('jolly-turing');
  });

  it('avoidCollision appends -2 when name is taken once', () => {
    expect(avoidCollision('jolly-turing', ['jolly-turing'])).toBe('jolly-turing-2');
  });

  it('avoidCollision keeps incrementing -3, -4, ... until unique', () => {
    expect(
      avoidCollision('jolly-turing', ['jolly-turing', 'jolly-turing-2', 'jolly-turing-3']),
    ).toBe('jolly-turing-4');
  });

  it('avoidCollision is case-insensitive', () => {
    expect(avoidCollision('Jolly-Turing', ['JOLLY-TURING'])).toBe('Jolly-Turing-2');
  });

  it('getBranchName prefixes new branches with cindy/', () => {
    expect(getBranchName('jolly-turing')).toBe('cindy/jolly-turing');
    expect(getBranchName('foo-bar-3')).toBe('cindy/foo-bar-3');
  });

  it('keeps recognizing legacy xdt/ branches without writing new ones', () => {
    expect(getManagedWorktreeBranchCandidates('jolly-turing')).toEqual([
      'cindy/jolly-turing',
      'xdt/jolly-turing',
    ]);
    expect(getManagedWorktreeNameFromBranch('cindy/jolly-turing')).toBe('jolly-turing');
    expect(getManagedWorktreeNameFromBranch('xdt/jolly-turing')).toBe('jolly-turing');
    expect(getManagedWorktreeNameFromBranch('cindy/jolly-turing/child')).toBeNull();
    expect(getManagedWorktreeNameFromBranch('xdt/jolly-turing/child')).toBeNull();
    expect(getManagedWorktreeNameFromBranch('feature/jolly-turing')).toBeNull();
    expect(isManagedWorktreeBranchForName('cindy/jolly-turing', 'jolly-turing')).toBe(true);
    expect(isManagedWorktreeBranchForName('xdt/jolly-turing', 'jolly-turing')).toBe(true);
    expect(isManagedWorktreeBranchForName('main', 'jolly-turing')).toBe(false);
  });

  it('reserves ref ancestors and descendants that would block cindy/<name>', () => {
    expect(blocksManagedWorktreeBranchNamespace('cindy')).toBe(true);
    expect(blocksManagedWorktreeBranchNamespace('xdt')).toBe(false);
    expect(getManagedWorktreeReservedName('cindy/foo')).toBe('foo');
    expect(getManagedWorktreeReservedName('cindy/foo/bar')).toBe('foo');
    expect(getManagedWorktreeReservedName('xdt/foo')).toBe('foo');
    expect(getManagedWorktreeReservedName('xdt/foo/bar')).toBeNull();
  });

  it('generateUniqueName always returns a name not in taken (after retries + suffix)', () => {
    // 模拟 taken 包含 50 个 raw name → generateUniqueName 仍能给出唯一名
    const taken: string[] = [];
    for (let i = 0; i < 50; i += 1) taken.push(generateRawName());
    const out = generateUniqueName(taken);
    // 即便随机撞了, 走 avoidCollision 加后缀也能避开
    expect(taken).not.toContain(out);
  });
});

describe('validateWorktreeName', () => {
  it('合法 worktree 名通过', () => {
    expect(validateWorktreeName('pensive-lederberg')).toBeNull();
    expect(validateWorktreeName('happy-curie')).toBeNull();
    expect(validateWorktreeName('auto-3l9k0c')).toBeNull();
    expect(validateWorktreeName('a')).toBeNull();
    expect(validateWorktreeName('a1')).toBeNull();
    expect(validateWorktreeName('test-1-2')).toBeNull();
  });

  it('空字符串拒绝', () => {
    expect(validateWorktreeName('')).toBe('不能为空');
  });

  it('超长拒绝', () => {
    expect(validateWorktreeName('a'.repeat(21))).toContain('不能超过');
    expect(validateWorktreeName('a'.repeat(20))).toBeNull();
  });

  it('非字符串拒绝', () => {
    // @ts-expect-error 测试 runtime 防御
    expect(validateWorktreeName(undefined)).toBe('必须是字符串');
    // @ts-expect-error 测试 runtime 防御
    expect(validateWorktreeName(null)).toBe('必须是字符串');
    // @ts-expect-error 测试 runtime 防御
    expect(validateWorktreeName(123)).toBe('必须是字符串');
  });

  it('大写字母拒绝', () => {
    expect(validateWorktreeName('Pensive')).not.toBeNull();
    expect(validateWorktreeName('FOO')).not.toBeNull();
  });

  it('特殊字符拒绝（路径越权 / git ref 非法 / Windows 非法）', () => {
    expect(validateWorktreeName('../etc/passwd')).not.toBeNull();
    expect(validateWorktreeName('../escape')).not.toBeNull();
    expect(validateWorktreeName('foo/bar')).not.toBeNull();
    expect(validateWorktreeName('foo\\bar')).not.toBeNull();
    expect(validateWorktreeName('foo:bar')).not.toBeNull();
    expect(validateWorktreeName('foo*bar')).not.toBeNull();
    expect(validateWorktreeName('foo?bar')).not.toBeNull();
    expect(validateWorktreeName('foo bar')).not.toBeNull();
    expect(validateWorktreeName('foo.bar')).not.toBeNull();
    expect(validateWorktreeName('foo@{bar')).not.toBeNull();
    expect(validateWorktreeName('foo;bar')).not.toBeNull();
    expect(validateWorktreeName('foo|bar')).not.toBeNull();
  });

  it('以 - 开头拒绝（防 cli flag 误识别）', () => {
    expect(validateWorktreeName('-foo')).not.toBeNull();
    expect(validateWorktreeName('--rf')).not.toBeNull();
  });

  it('以 - 结尾拒绝', () => {
    expect(validateWorktreeName('foo-')).not.toBeNull();
  });

  it('连续 -- 拒绝（git ref 风格保险）', () => {
    expect(validateWorktreeName('foo--bar')).not.toBeNull();
  });

  it('generateRawName 出来的名字一定通过 validateWorktreeName（1000 样本）', () => {
    for (let i = 0; i < 1000; i += 1) {
      const name = generateRawName();
      expect(validateWorktreeName(name)).toBeNull();
    }
  });
});

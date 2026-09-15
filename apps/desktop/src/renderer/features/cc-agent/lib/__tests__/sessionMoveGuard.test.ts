import { describe, expect, it } from 'vitest';

import { managedWorktreeRootOf } from '../sessionMoveGuard';

describe('managedWorktreeRootOf', () => {
  it('folds roots and their descendants to the same managed worktree root', () => {
    expect(managedWorktreeRootOf('/repo/.cindy-worktrees/steady-goodall'))
      .toBe('/repo/.cindy-worktrees/steady-goodall');
    expect(managedWorktreeRootOf('/repo/.cindy-worktrees/steady-goodall/src/nested'))
      .toBe('/repo/.cindy-worktrees/steady-goodall');
    // 同一 worktree 内的兄弟目录必须归到同一个根(GUI 预检据此放行,与共享写路径一致)。
    expect(managedWorktreeRootOf('/repo/.cindy-worktrees/steady-goodall/tests'))
      .toBe(managedWorktreeRootOf('/repo/.cindy-worktrees/steady-goodall/src'));
  });

  it('keeps the input separator style, including legacy containers and drive paths', () => {
    expect(managedWorktreeRootOf('D:\\repo\\.cindy-worktrees\\steady-goodall\\src'))
      .toBe('D:\\repo\\.cindy-worktrees\\steady-goodall');
    expect(managedWorktreeRootOf('/repo/.xdt-worktrees/legacy-name/sub'))
      .toBe('/repo/.xdt-worktrees/legacy-name');
  });

  it('treats ordinary projects and user-managed worktrees as having no managed root', () => {
    expect(managedWorktreeRootOf('/repo/src')).toBeNull();
    expect(managedWorktreeRootOf('/repo/.worktrees/steady-goodall')).toBeNull();
    expect(managedWorktreeRootOf('/repo/.claude/worktrees/steady-goodall')).toBeNull();
    expect(managedWorktreeRootOf('/repo/.cindy-worktrees')).toBeNull();
    expect(managedWorktreeRootOf(null)).toBeNull();
    expect(managedWorktreeRootOf(undefined)).toBeNull();
    expect(managedWorktreeRootOf('')).toBeNull();
  });
});

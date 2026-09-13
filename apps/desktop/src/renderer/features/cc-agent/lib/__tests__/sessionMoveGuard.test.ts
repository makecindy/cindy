import { describe, expect, it } from 'vitest';

import { isManagedWorktreeWorkingDir } from '../sessionMoveGuard';

describe('isManagedWorktreeWorkingDir', () => {
  it('recognizes managed worktrees, legacy names and their descendants', () => {
    expect(isManagedWorktreeWorkingDir('/repo/.cindy-worktrees/steady-goodall')).toBe(true);
    expect(isManagedWorktreeWorkingDir('D:\\repo\\.cindy-worktrees\\steady-goodall')).toBe(true);
    expect(isManagedWorktreeWorkingDir('/repo/.xdt-worktrees/steady-goodall/sub')).toBe(true);
  });

  it('leaves ordinary projects, user-managed worktrees and empty values alone', () => {
    expect(isManagedWorktreeWorkingDir('/repo/src')).toBe(false);
    expect(isManagedWorktreeWorkingDir('/repo/.worktrees/steady-goodall')).toBe(false);
    expect(isManagedWorktreeWorkingDir('/repo/.claude/worktrees/steady-goodall')).toBe(false);
    expect(isManagedWorktreeWorkingDir(null)).toBe(false);
    expect(isManagedWorktreeWorkingDir(undefined)).toBe(false);
    expect(isManagedWorktreeWorkingDir('')).toBe(false);
  });
});

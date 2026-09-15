import { describe, expect, it } from 'vitest';

import { crossesWorktreeBoundary, managedWorktreeRootOf } from '../sessionMoveGuard';

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

describe('crossesWorktreeBoundary', () => {
  const worktree = '/repo/.cindy-worktrees/steady-goodall';

  it('blocks only targets outside the session\'s own worktree root', () => {
    // 跨到别的项目（含它所属的 base repo）→ 拦。
    expect(crossesWorktreeBoundary(worktree, '/repo/other-project')).toBe(true);
    expect(crossesWorktreeBoundary(worktree, '/repo')).toBe(true);
    expect(crossesWorktreeBoundary(worktree, '/repo/.cindy-worktrees/another-name')).toBe(true);
  });

  it('allows targets inside the same worktree root', () => {
    expect(crossesWorktreeBoundary(worktree, worktree)).toBe(false);
    expect(crossesWorktreeBoundary(worktree, `${worktree}/src`)).toBe(false);
    expect(crossesWorktreeBoundary(`${worktree}/src`, `${worktree}/tests`)).toBe(false);
  });

  it('never blocks sessions that are not bound to a managed worktree', () => {
    expect(crossesWorktreeBoundary('/repo', '/elsewhere')).toBe(false);
    expect(crossesWorktreeBoundary(null, '/elsewhere')).toBe(false);
    expect(crossesWorktreeBoundary('/repo/.worktrees/user-made', '/elsewhere')).toBe(false);
  });

  it('treats separator and Windows case variants of the same root as the same worktree', () => {
    // 目录选择器给原生 `\` 拼写,而 working_dir 落库时是 `/`:不能因此误拦。
    expect(
      crossesWorktreeBoundary('D:/repo/.cindy-worktrees/steady-goodall', 'D:\\repo\\.cindy-worktrees\\steady-goodall\\tests'),
    ).toBe(false);
    expect(
      crossesWorktreeBoundary('D:\\repo\\.xdt-worktrees\\legacy', 'D:/repo/.xdt-worktrees/legacy/src'),
    ).toBe(false);

    // Windows 盘符/UNC 大小写差异也不算跨根(平台显式伪造,非 Windows CI 同样执行)。
    const host = globalThis as { electronAPI?: { platform?: string } };
    const previous = host.electronAPI;
    try {
      host.electronAPI = { platform: 'win32' };
      expect(
        crossesWorktreeBoundary('D:/repo/.cindy-worktrees/steady-goodall', 'd:/REPO/.cindy-worktrees/steady-goodall/src'),
      ).toBe(false);
      // POSIX 路径大小写敏感:盘符规则不能把两个真实存在的不同目录当成同一个。
      expect(
        crossesWorktreeBoundary('/repo/.cindy-worktrees/steady-goodall', '/REPO/.cindy-worktrees/steady-goodall/src'),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete host.electronAPI;
      else host.electronAPI = previous;
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatWorktreeChipText,
  observedWorktreeFromTelemetry,
  pathBasename,
  resolveManagedWorktree,
  selectDisplayedWorktree,
} from '../sessionWorktreeInfo';

describe('sessionWorktreeInfo', () => {
  it('maps an official store entry', () => {
    expect(
      resolveManagedWorktree({
        path: '/repo/.cindy-worktrees/steady-goodall',
        name: 'steady-goodall',
        branch: 'cindy/steady-goodall',
      }),
    ).toEqual({
      path: '/repo/.cindy-worktrees/steady-goodall',
      name: 'steady-goodall',
      branch: 'cindy/steady-goodall',
      source: 'managed',
      canReveal: true,
    });
    expect(resolveManagedWorktree(null)).toBeNull();
  });

  it('only observes telemetry that landed in a live linked worktree', () => {
    expect(
      observedWorktreeFromTelemetry({
        source: 'telemetry',
        workdir: '/repo/.worktrees/dash-slug',
        branch: 'dash/slug',
        isInsideWorktree: true,
      }),
    ).toMatchObject({
      path: '/repo/.worktrees/dash-slug',
      name: 'dash-slug',
      source: 'observed',
      canReveal: false,
    });
  });

  it('ignores the session workingDir fallback even when it is a git repo', () => {
    expect(
      observedWorktreeFromTelemetry({
        source: 'workingDir',
        workdir: '/repo',
        branch: 'main',
        isInsideWorktree: false,
      }),
    ).toBeNull();
  });

  it('ignores telemetry that is still the main checkout', () => {
    expect(
      observedWorktreeFromTelemetry({
        source: 'telemetry',
        workdir: '/repo',
        branch: 'main',
        isInsideWorktree: false,
      }),
    ).toBeNull();
  });

  it('does not offer reveal on observed worktrees', () => {
    expect(
      observedWorktreeFromTelemetry({
        source: 'telemetry',
        workdir: '/repo/.worktrees/dash-slug',
        branch: null,
        isInsideWorktree: true,
      }),
    ).toMatchObject({ canReveal: false });
  });

  it('keeps windows path names', () => {
    expect(pathBasename('D:\\repo\\.cindy-worktrees\\feat-win\\')).toBe('feat-win');
  });

  it('hides the badge when the official worktree directory is gone', () => {
    const managed = resolveManagedWorktree({
      path: '/repo/.cindy-worktrees/steady-goodall',
      name: 'steady-goodall',
      branch: 'cindy/steady-goodall',
    });
    expect(
      selectDisplayedWorktree({
        enabled: true,
        managed,
        officialStillLive: false,
        observed: null,
      }),
    ).toBeNull();
    expect(
      selectDisplayedWorktree({
        enabled: true,
        managed,
        officialStillLive: true,
        observed: null,
      }),
    ).toEqual(managed);
  });

  it('formats the composer chip as repo (worktree)', () => {
    expect(
      formatWorktreeChipText({
        path: '/Users/dash/Code/Cindy/cindy/.cindy-worktrees/steady-goodall',
        name: 'steady-goodall',
        branch: 'cindy/steady-goodall',
        source: 'managed',
        canReveal: true,
      }),
    ).toBe('cindy (steady-goodall)');
    expect(
      formatWorktreeChipText({
        path: '/Users/dash/Code/Cindy/cindy-my-task',
        name: 'cindy-my-task',
        branch: 'dash/my-task',
        source: 'observed',
        canReveal: false,
      }),
    ).toBe('cindy-my-task');
  });
});

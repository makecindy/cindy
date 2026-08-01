// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  branchesStateForTarget,
  detectCwdStateForTarget,
  suggestNameStateForTarget,
  useDetectCwd,
  type BranchesSnapshot,
  type DetectCwdSnapshot,
  type SuggestNameSnapshot,
} from '../useWorktreeQueries';

const REPO_A = {
  gitInstalled: true,
  isGitRepo: true,
  isInsideWorktree: false,
  repoRoot: '/repo-a',
  currentBranch: 'feature/a',
};

describe('detectCwdStateForTarget', () => {
  const snapshot: DetectCwdSnapshot = {
    target: { cwd: '/repo-a', deviceLinkDeviceId: 'device-a' },
    data: REPO_A,
    loading: false,
  };

  it('keeps the resolved probe only for the exact device and directory', () => {
    expect(
      detectCwdStateForTarget(snapshot, {
        cwd: '/repo-a',
        deviceLinkDeviceId: 'device-a',
      }),
    ).toEqual({ data: REPO_A, loading: false });
  });

  it('synchronously fences stale data when the project changes', () => {
    expect(
      detectCwdStateForTarget(snapshot, {
        cwd: '/repo-b',
        deviceLinkDeviceId: 'device-a',
      }),
    ).toEqual({ data: null, loading: true });
  });

  it('synchronously fences stale data when the device changes', () => {
    expect(
      detectCwdStateForTarget(snapshot, {
        cwd: '/repo-a',
        deviceLinkDeviceId: 'device-b',
      }),
    ).toEqual({ data: null, loading: true });
  });
});

describe('useDetectCwd', () => {
  it('retries the remote probe when the reconnect epoch changes', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('relay offline'))
      .mockResolvedValueOnce(REPO_A);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        deviceLink: { invoke },
      },
    });

    const { result, rerender } = renderHook(
      ({ reconnectEpoch }: { reconnectEpoch: number }) =>
        useDetectCwd('/repo-a', 'device-a', reconnectEpoch),
      { initialProps: { reconnectEpoch: 0 } },
    );

    await waitFor(() => {
      expect(result.current).toEqual({ data: null, loading: false });
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    rerender({ reconnectEpoch: 1 });

    await waitFor(() => {
      expect(result.current).toEqual({ data: REPO_A, loading: false });
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('worktree repo query target fences', () => {
  const branches: BranchesSnapshot = {
    target: { baseRepo: '/repo-a', deviceLinkDeviceId: 'device-a' },
    branches: ['feature/a', 'main'],
    current: 'feature/a',
    loading: false,
    failed: false,
  };
  const suggested: SuggestNameSnapshot = {
    target: { baseRepo: '/repo-a', deviceLinkDeviceId: 'device-a' },
    name: 'repo-a-task',
    loading: false,
  };

  it('does not expose the previous repository branch list', () => {
    expect(
      branchesStateForTarget(branches, {
        baseRepo: '/repo-b',
        deviceLinkDeviceId: 'device-a',
      }),
    ).toEqual({
      branches: [],
      current: null,
      loading: true,
      failed: false,
    });
  });

  it('does not expose the previous device suggested name', () => {
    expect(
      suggestNameStateForTarget(suggested, {
        baseRepo: '/repo-a',
        deviceLinkDeviceId: 'device-b',
      }),
    ).toEqual({ name: '', loading: true });
  });
});

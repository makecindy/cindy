// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileDiff } from '@/lib/gitReview.types';

const mocks = vi.hoisted(() => ({
  useReviewGitState: vi.fn(),
  useReviewCommitDiff: vi.fn(),
  useReviewBranchDiff: vi.fn(),
  useReviewFileDiffs: vi.fn(),
  useLastTurnFilter: vi.fn(),
  getTurnChangeSets: vi.fn(),
}));

vi.mock('../useReviewGitState', () => ({
  useReviewGitState: mocks.useReviewGitState,
  useReviewCommitDiff: mocks.useReviewCommitDiff,
  useReviewBranchDiff: mocks.useReviewBranchDiff,
  useReviewFileDiffs: mocks.useReviewFileDiffs,
}));

vi.mock('../useLastTurnFilter', () => ({
  useLastTurnFilter: mocks.useLastTurnFilter,
}));

import { REVIEW_TURN_LOCAL_ONLY_ERROR, useReviewSource } from '../useReviewSource';

function loadState<T>(data: T | null = null) {
  return {
    data,
    loading: false,
    error: null,
    errorCode: null,
    refresh: vi.fn(),
    setData: vi.fn(),
  };
}

function diff(path: string): FileDiff {
  return {
    id: `unstaged:${path}`,
    source: 'unstaged',
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 10,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
  };
}

describe('useReviewSource', () => {
  beforeEach(() => {
    mocks.useReviewGitState.mockReturnValue(loadState());
    mocks.useReviewCommitDiff.mockReturnValue(loadState());
    mocks.useReviewBranchDiff.mockReturnValue(loadState());
    mocks.useReviewFileDiffs.mockReturnValue(loadState([]));
    mocks.useLastTurnFilter.mockReturnValue(new Set<string>());
    mocks.getTurnChangeSets.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { getTurnChangeSets: mocks.getTurnChangeSets } },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads a turn-set through the historical source and skips every git source hook', async () => {
    const recordedDiff = diff('src/a.ts');
    mocks.getTurnChangeSets.mockResolvedValue([
      {
        id: 'set-1',
        state: 'partial',
        diffs: [recordedDiff],
      },
    ]);

    const { result } = renderHook(() =>
      useReviewSource(
        { kind: 'turn-set', targetSessionId: 'worker-session', changeSetIds: ['set-1'] },
        'host-session',
        { hideWhitespace: false, deviceLinkDeviceId: null, remoteHostId: null },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.getTurnChangeSets).toHaveBeenCalledWith('worker-session', ['set-1']);
    expect(result.current.diffs).toEqual([recordedDiff]);
    expect(result.current.isPartial).toBe(true);
    expect(mocks.useReviewGitState).toHaveBeenCalledWith(null, false, null);
    expect(mocks.useReviewCommitDiff).toHaveBeenCalledWith(null, null, false, null);
    expect(mocks.useReviewBranchDiff).toHaveBeenCalledWith(null, null, false, false, null);
  });

  it('fails closed for remote historical snapshots without calling the local IPC', async () => {
    const { result } = renderHook(() =>
      useReviewSource(
        { kind: 'turn-set', targetSessionId: null, changeSetIds: ['set-1'] },
        'host-session',
        { hideWhitespace: false, deviceLinkDeviceId: null, remoteHostId: 'ssh-host' },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(REVIEW_TURN_LOCAL_ONLY_ERROR);
    expect(mocks.getTurnChangeSets).not.toHaveBeenCalled();
  });

  it('fails closed while device-link ownership is unresolved', async () => {
    const { result } = renderHook(() =>
      useReviewSource(
        { kind: 'turn-set', targetSessionId: null, changeSetIds: ['set-1'] },
        'host-session',
        { hideWhitespace: false, deviceLinkDeviceId: undefined, remoteHostId: null },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(REVIEW_TURN_LOCAL_ONLY_ERROR);
    expect(mocks.getTurnChangeSets).not.toHaveBeenCalled();
  });
});

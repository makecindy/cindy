// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ReviewCommitDiffData,
  ReviewDirtySummary,
  ReviewFileDiffData,
  ReviewFileDiffRequest,
} from '@/lib/gitReview.types';
import type { SessionStatusInfo } from '@/lib/makerChatStore';
import {
  subscribeReviewRefreshOnTurnEnd,
  useReviewCommitDiff,
  useReviewDirtySummary,
  useReviewFileDiff,
  useReviewFileDiffs,
} from '../useReviewGitState';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe({ sessionId, oid }: { sessionId: string; oid: string }) {
  const state = useReviewCommitDiff(sessionId, oid);
  return createElement(
    'div',
    { 'data-testid': 'state' },
    `${state.data?.commitOid ?? 'null'}|${state.loading ? 'loading' : 'idle'}`,
  );
}

function SummaryProbe({
  sessionId,
  deviceId = null,
}: {
  sessionId: string | null;
  deviceId?: string | null;
}) {
  const state = useReviewDirtySummary(sessionId, deviceId);
  return createElement(
    'div',
    { 'data-testid': 'state' },
    `${state.data?.sessionId ?? 'null'}|${state.loading ? 'loading' : 'idle'}`,
  );
}

function FileDiffProbe({
  sessionId,
  request,
  refreshVersion,
}: {
  sessionId: string;
  request: ReviewFileDiffRequest;
  refreshVersion: number;
}) {
  const state = useReviewFileDiff(sessionId, request, refreshVersion);
  return createElement(
    'div',
    { 'data-testid': 'state' },
    `${state.data?.diff?.path ?? 'null'}|${state.loading ? 'loading' : 'idle'}`,
  );
}

function FileDiffsProbe({
  sessionId,
  requests,
}: {
  sessionId: string;
  requests: readonly ReviewFileDiffRequest[];
}) {
  const state = useReviewFileDiffs(sessionId, requests);
  return createElement(
    'div',
    { 'data-testid': 'state' },
    `${state.data?.length ?? 0}|${state.loading ? 'loading' : 'idle'}`,
  );
}

function commitDiffData(commitOid: string): ReviewCommitDiffData {
  return {
    scope: {} as ReviewCommitDiffData['scope'],
    commitOid,
    diffs: [],
    capped: null,
  };
}

function dirtySummary(sessionId: string): ReviewDirtySummary {
  return {
    sessionId,
    disabledReason: null,
    disabledMessage: null,
    totalFiles: 1,
    stagedFiles: 0,
    unstagedFiles: 1,
    untrackedFiles: 0,
    unmergedFiles: 0,
    dirty: true,
  };
}

function fileDiffData(path: string): ReviewFileDiffData {
  return {
    scope: {} as ReviewFileDiffData['scope'],
    diff: {
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
    },
  };
}

function runningSnapshot(
  sessionId: string,
  isRunning: boolean,
): ReadonlyMap<string, SessionStatusInfo> {
  if (!isRunning) return new Map();
  return new Map([
    [
      sessionId,
      {
        isRunning: true,
        hasError: false,
        hasPendingAskUser: false,
        hasPendingPermission: false,
        hasPendingPlanReview: false,
        hasPendingPluginSetup: false,
      },
    ],
  ]);
}

describe('subscribeReviewRefreshOnTurnEnd', () => {
  it('ignores stream updates while running and refreshes once on the stopped edge', () => {
    const sessionId = 'turn-end-refresh-session';
    let isRunning = true;
    let listener = () => {};
    const onTurnEnd = vi.fn();
    const unsubscribe = vi.fn();
    const store = {
      getRunningSnapshot: () => runningSnapshot(sessionId, isRunning),
      subscribe: (_sessionId: string, nextListener: () => void) => {
        listener = nextListener;
        return unsubscribe;
      },
    };

    const cancelPendingRefresh = vi.fn();
    const cleanup = subscribeReviewRefreshOnTurnEnd(
      sessionId,
      { onTurnEnd, cancelPendingRefresh },
      store,
    );

    listener();
    listener();
    expect(onTurnEnd).not.toHaveBeenCalled();

    isRunning = false;
    listener();
    listener();
    expect(onTurnEnd).toHaveBeenCalledTimes(1);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(cancelPendingRefresh).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending stopped-edge refresh when the Agent resumes', () => {
    vi.useFakeTimers();
    const sessionId = 'continuation-refresh-session';
    let isRunning = true;
    let listener = () => {};
    let timer: number | null = null;
    const refresh = vi.fn();
    const onTurnEnd = () => {
      timer = window.setTimeout(refresh, 350);
    };
    const cancelPendingRefresh = vi.fn(() => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    });
    const store = {
      getRunningSnapshot: () => runningSnapshot(sessionId, isRunning),
      subscribe: (_sessionId: string, nextListener: () => void) => {
        listener = nextListener;
        return () => {};
      },
    };
    const cleanup = subscribeReviewRefreshOnTurnEnd(
      sessionId,
      { onTurnEnd, cancelPendingRefresh },
      store,
    );

    isRunning = false;
    listener();
    isRunning = true;
    listener();
    vi.advanceTimersByTime(350);

    expect(cancelPendingRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    cleanup();
    expect(cancelPendingRefresh).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not treat non-running message updates as a completed turn', () => {
    const sessionId = 'idle-refresh-session';
    let listener = () => {};
    const onTurnEnd = vi.fn();
    const store = {
      getRunningSnapshot: () => runningSnapshot(sessionId, false),
      subscribe: (_sessionId: string, nextListener: () => void) => {
        listener = nextListener;
        return () => {};
      },
    };

    subscribeReviewRefreshOnTurnEnd(
      sessionId,
      { onTurnEnd, cancelPendingRefresh: () => {} },
      store,
    );
    listener();
    listener();

    expect(onTurnEnd).not.toHaveBeenCalled();
  });
});

describe('useReviewGitState cache continuity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps previous data while loading an uncached commit diff key', async () => {
    const pendingNext = deferred<ReviewCommitDiffData>();
    const commitDiff = vi.fn((payload: { oid: string }) => {
      if (payload.oid === 'commit-a') {
        return Promise.resolve(commitDiffData('commit-a'));
      }
      return pendingNext.promise;
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { commitDiff },
    };

    const { rerender } = render(
      createElement(Probe, { sessionId: 'cache-continuity-session', oid: 'commit-a' }),
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-a|idle'));

    rerender(createElement(Probe, { sessionId: 'cache-continuity-session', oid: 'commit-b' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-a|loading'));

    await act(async () => {
      pendingNext.resolve(commitDiffData('commit-b'));
      await pendingNext.promise;
    });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('commit-b|idle'));
  });
  it('invalidates an in-flight request before a new device scope load effect runs', async () => {
    const pendingOld = deferred<{ ok: true; result: ReviewDirtySummary }>();
    const invoke = vi.fn((deviceId: string) => {
      if (deviceId === 'device-a') return pendingOld.promise;
      return Promise.reject(new Error('device-b unavailable'));
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: {
        invoke: (deviceId: string) => invoke(deviceId),
      },
    };

    const { rerender } = render(
      createElement(SummaryProbe, {
        sessionId: 'shared-session',
        deviceId: 'device-a',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('null|loading'));

    let oldRequestResolved = false;
    await act(async () => {
      rerender(
        createElement(SummaryProbe, {
          sessionId: 'shared-session',
          deviceId: 'device-b',
        }),
      );
      pendingOld.resolve({ ok: true, result: dirtySummary('shared-session') });
      oldRequestResolved = true;
      await pendingOld.promise;
      await Promise.resolve();
    });
    expect(oldRequestResolved).toBe(true);
    expect(screen.getByTestId('state').textContent).not.toContain('shared-session');

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('device-b'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('null|idle'));
  });

  it('reloads a file diff when the write refresh version changes without changing the IPC payload', async () => {
    const fileDiff = vi.fn(async () => fileDiffData('src/a.ts'));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { fileDiff },
    };
    const request: ReviewFileDiffRequest = {
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    };

    const { rerender } = render(
      createElement(FileDiffProbe, {
        sessionId: 'file-diff-write-version-session',
        request,
        refreshVersion: 0,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('src/a.ts|idle'));
    expect(fileDiff).toHaveBeenCalledTimes(1);

    rerender(
      createElement(FileDiffProbe, {
        sessionId: 'file-diff-write-version-session',
        request,
        refreshVersion: 1,
      }),
    );

    await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(2));
    expect(fileDiff).toHaveBeenLastCalledWith({
      sessionId: 'file-diff-write-version-session',
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    });
  });

  it('does not reload a file diff batch when request array identity changes without content changes', async () => {
    const fileDiff = vi.fn(async (payload: ReviewFileDiffRequest & { sessionId: string }) =>
      fileDiffData(payload.path),
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitReview: { fileDiff },
    };
    const request: ReviewFileDiffRequest = {
      source: 'unstaged',
      path: 'src/a.ts',
      oldPath: null,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: false,
    };

    const { rerender } = render(
      createElement(FileDiffsProbe, {
        sessionId: 'file-diff-batch-session',
        requests: [{ ...request }],
      }),
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('1|idle'));
    expect(fileDiff).toHaveBeenCalledTimes(1);

    rerender(
      createElement(FileDiffsProbe, {
        sessionId: 'file-diff-batch-session',
        requests: [{ ...request }],
      }),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fileDiff).toHaveBeenCalledTimes(1);
  });
});

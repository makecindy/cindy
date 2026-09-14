import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  FileDiff,
  ReviewBranchDiffData,
  ReviewCappedDiffData,
  ReviewCommitDiffData,
  ReviewData,
  ReviewDiffSummaryEntry,
  ReviewFileDiffRequest,
} from '@/lib/gitReview.types';
import { extractIpcError } from '@/utils/ipcError';
import { buildCappedDiffData } from '../../../../../shared/gitReviewCapped';
import type { ReviewSourceDescriptor } from '../../../../../shared/reviewSource';
import type { TurnChangeSetDetail } from '../../../../../shared/turnChangeSet';
import { useLastTurnFilter } from './useLastTurnFilter';
import {
  useReviewBranchDiff,
  useReviewCommitDiff,
  useReviewFileDiffs,
  useReviewGitState,
} from './useReviewGitState';

export const REVIEW_TURN_LOCAL_ONLY_ERROR = 'REVIEW_TURN_LOCAL_ONLY';

export interface ReviewSourceData {
  diffs: FileDiff[];
  capped: ReviewCappedDiffData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  isPartial: boolean;
  rawDiffCount: number;
  lastTurnCount: number;
  reviewData: ReviewData | null;
  commitData: ReviewCommitDiffData | null;
  branchData: ReviewBranchDiffData | null;
  gitLoading: boolean;
  gitError: string | null;
  gitErrorCode: string | null;
  refreshGit: () => void;
  setReviewData: (data: ReviewData) => void;
}

interface TurnLoadState {
  key: string | null;
  changeSets: TurnChangeSetDetail[];
  loading: boolean;
  error: string | null;
}

function shouldHideWhitespaceOnlyDiff(diff: FileDiff, hideWhitespace: boolean): boolean {
  return (
    hideWhitespace && diff.kind === 'text' && diff.status === 'modified' && diff.hunks.length === 0
  );
}

function filterWhitespaceHiddenDiffs(
  diffs: readonly FileDiff[],
  hideWhitespace: boolean,
): FileDiff[] {
  if (!hideWhitespace) return Array.from(diffs);
  return diffs.filter((diff) => !shouldHideWhitespaceOnlyDiff(diff, true));
}

function fileDiffToSummaryEntry(diff: FileDiff): ReviewDiffSummaryEntry {
  return {
    id: diff.id,
    source: diff.source,
    path: diff.path,
    oldPath: diff.oldPath,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    changedLines: diff.additions + diff.deletions,
    changedBytes: Math.max(0, diff.size ?? 0),
    isBinary: diff.isBinary,
    isSubmodule: diff.isSubmodule,
  };
}

function getCurrentBranchDiffData(
  data: ReviewBranchDiffData | null,
  requestedBaseRef: string | null,
): ReviewBranchDiffData | null {
  if (!data) return null;
  if (requestedBaseRef && data.baseRef !== requestedBaseRef) {
    const isRequestedBaseFallback =
      data.warning?.code === 'base-missing' && data.warning.requestedBaseRef === requestedBaseRef;
    if (!isRequestedBaseFallback) return null;
  }
  return data;
}

export function useReviewSource(
  descriptor: ReviewSourceDescriptor,
  sessionId: string | null,
  opts: {
    hideWhitespace: boolean;
    deviceLinkDeviceId: string | null | undefined;
    remoteHostId: string | null;
  },
): ReviewSourceData {
  const { hideWhitespace, deviceLinkDeviceId, remoteHostId } = opts;
  const gitDeviceLinkDeviceId = deviceLinkDeviceId ?? null;
  const gitSessionId = descriptor.kind === 'turn-set' ? null : sessionId;
  const branchBaseRef = descriptor.kind === 'branch' ? descriptor.baseRef : null;
  const commitOid = descriptor.kind === 'commit' ? descriptor.commitOid : null;
  const gitState = useReviewGitState(gitSessionId, hideWhitespace, gitDeviceLinkDeviceId);
  const commitState = useReviewCommitDiff(
    gitSessionId,
    commitOid,
    hideWhitespace,
    gitDeviceLinkDeviceId,
  );
  const branchState = useReviewBranchDiff(
    gitSessionId,
    branchBaseRef,
    hideWhitespace,
    descriptor.kind === 'branch',
    gitDeviceLinkDeviceId,
  );
  const currentBranchData = getCurrentBranchDiffData(branchState.data, branchBaseRef);
  const lastTurnPaths = useLastTurnFilter(gitSessionId, gitState.data?.scope.repoRoot ?? null);
  const rawUnstaged = gitState.data?.diffs.unstaged ?? [];
  const rawStaged = gitState.data?.diffs.staged ?? [];
  const worktreeCapped = gitState.data?.diffs.capped ?? null;
  const unstaged = useMemo(
    () => filterWhitespaceHiddenDiffs(rawUnstaged, hideWhitespace),
    [hideWhitespace, rawUnstaged],
  );
  const staged = useMemo(
    () => filterWhitespaceHiddenDiffs(rawStaged, hideWhitespace),
    [hideWhitespace, rawStaged],
  );
  const selectedCommitData = commitState.data?.commitOid === commitOid ? commitState.data : null;
  const commitDiffs = useMemo(
    () => filterWhitespaceHiddenDiffs(selectedCommitData?.diffs ?? [], hideWhitespace),
    [hideWhitespace, selectedCommitData?.diffs],
  );
  const branchDiffs = useMemo(
    () => filterWhitespaceHiddenDiffs(currentBranchData?.diffs ?? [], hideWhitespace),
    [currentBranchData?.diffs, hideWhitespace],
  );
  const availableLastTurnDiffs = useMemo(
    () =>
      rawUnstaged
        .concat(rawStaged)
        .filter(
          (diff) =>
            lastTurnPaths.has(diff.path) ||
            (diff.oldPath !== null && lastTurnPaths.has(diff.oldPath)),
        ),
    [lastTurnPaths, rawStaged, rawUnstaged],
  );
  const lastTurnCappedEntries = useMemo(
    () =>
      [...(worktreeCapped?.unstaged?.files ?? []), ...(worktreeCapped?.staged?.files ?? [])].filter(
        (entry) =>
          lastTurnPaths.has(entry.path) ||
          (entry.oldPath !== null && lastTurnPaths.has(entry.oldPath)),
      ),
    [lastTurnPaths, worktreeCapped],
  );
  const lastTurnCapped = useMemo(
    () =>
      buildCappedDiffData([
        ...availableLastTurnDiffs.map(fileDiffToSummaryEntry),
        ...lastTurnCappedEntries,
      ]),
    [availableLastTurnDiffs, lastTurnCappedEntries],
  );
  const lastTurnHydrationRequests = useMemo<ReviewFileDiffRequest[]>(() => {
    if (descriptor.kind !== 'last-turn' || lastTurnCapped || lastTurnCappedEntries.length === 0)
      return [];
    return lastTurnCappedEntries.map((entry) => ({
      source: entry.source,
      path: entry.path,
      oldPath: entry.oldPath,
      commitOid: null,
      branchBaseRef: null,
      ignoreWhitespace: hideWhitespace,
    }));
  }, [descriptor.kind, hideWhitespace, lastTurnCapped, lastTurnCappedEntries]);
  const lastTurnHydratedState = useReviewFileDiffs(
    gitSessionId,
    lastTurnHydrationRequests,
    gitDeviceLinkDeviceId,
  );
  const hydratedLastTurnDiffs = useMemo(
    () =>
      lastTurnHydratedState.data
        ?.map((item) => item.diff)
        .filter((diff): diff is FileDiff => diff !== null) ?? [],
    [lastTurnHydratedState.data],
  );
  const rawLastTurnDiffs = useMemo(
    () => availableLastTurnDiffs.concat(hydratedLastTurnDiffs),
    [availableLastTurnDiffs, hydratedLastTurnDiffs],
  );
  const lastTurnDiffs = useMemo(
    () => filterWhitespaceHiddenDiffs(rawLastTurnDiffs, hideWhitespace),
    [hideWhitespace, rawLastTurnDiffs],
  );

  const turnTargetSessionId = descriptor.kind === 'turn-set' ? descriptor.targetSessionId : null;
  const turnChangeSetIdsKey =
    descriptor.kind === 'turn-set' ? descriptor.changeSetIds.join('\0') : '';
  const turnKey =
    descriptor.kind === 'turn-set'
      ? `${turnTargetSessionId ?? sessionId ?? ''}\0${turnChangeSetIdsKey}`
      : null;
  const [turnReloadToken, setTurnReloadToken] = useState(0);
  const [turnState, setTurnState] = useState<TurnLoadState>({
    key: null,
    changeSets: [],
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (descriptor.kind !== 'turn-set' || !turnKey) return;
    let cancelled = false;
    if (!sessionId || remoteHostId !== null || deviceLinkDeviceId !== null) {
      setTurnState({
        key: turnKey,
        changeSets: [],
        loading: false,
        error: REVIEW_TURN_LOCAL_ONLY_ERROR,
      });
      return;
    }
    setTurnState((current) => ({
      key: turnKey,
      changeSets: current.key === turnKey ? current.changeSets : [],
      loading: true,
      error: null,
    }));
    const reviewSessionId = turnTargetSessionId ?? sessionId;
    void window.electronAPI.maker
      .getTurnChangeSets(reviewSessionId, turnChangeSetIdsKey.split('\0'))
      .then((changeSets) => {
        if (!cancelled) setTurnState({ key: turnKey, changeSets, loading: false, error: null });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setTurnState({
          key: turnKey,
          changeSets: [],
          loading: false,
          error:
            extractIpcError(reason)?.message ??
            (reason instanceof Error ? reason.message : String(reason)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    descriptor.kind,
    deviceLinkDeviceId,
    remoteHostId,
    sessionId,
    turnChangeSetIdsKey,
    turnKey,
    turnReloadToken,
    turnTargetSessionId,
  ]);

  const refreshTurn = useCallback(() => setTurnReloadToken((value) => value + 1), []);
  const refreshGitSource = useCallback(() => {
    gitState.refresh();
    if (descriptor.kind === 'commit') commitState.refresh();
    if (descriptor.kind === 'branch') branchState.refresh();
    if (descriptor.kind === 'last-turn') lastTurnHydratedState.refresh();
  }, [branchState, commitState, descriptor.kind, gitState, lastTurnHydratedState]);

  if (descriptor.kind === 'turn-set') {
    const currentTurnState =
      turnState.key === turnKey
        ? turnState
        : { key: turnKey, changeSets: [], loading: true, error: null };
    const rawDiffs = currentTurnState.changeSets.flatMap((changeSet) => changeSet.diffs);
    return {
      diffs: filterWhitespaceHiddenDiffs(rawDiffs, hideWhitespace),
      capped: null,
      loading: currentTurnState.loading,
      error: currentTurnState.error,
      refresh: refreshTurn,
      isPartial: currentTurnState.changeSets.some((changeSet) => changeSet.state === 'partial'),
      rawDiffCount: rawDiffs.length,
      lastTurnCount: 0,
      reviewData: null,
      commitData: null,
      branchData: null,
      gitLoading: false,
      gitError: null,
      gitErrorCode: null,
      refreshGit: gitState.refresh,
      setReviewData: gitState.setData,
    };
  }

  const sourceDiffs =
    descriptor.kind === 'commit'
      ? commitDiffs
      : descriptor.kind === 'branch'
        ? branchDiffs
        : descriptor.kind === 'staged'
          ? staged
          : descriptor.kind === 'last-turn'
            ? lastTurnDiffs
            : unstaged;
  const capped =
    descriptor.kind === 'commit'
      ? (selectedCommitData?.capped ?? null)
      : descriptor.kind === 'branch'
        ? (currentBranchData?.capped ?? null)
        : descriptor.kind === 'staged'
          ? (worktreeCapped?.staged ?? null)
          : descriptor.kind === 'last-turn'
            ? lastTurnCapped
            : (worktreeCapped?.unstaged ?? null);
  const loading =
    descriptor.kind === 'commit'
      ? commitState.loading
      : descriptor.kind === 'branch'
        ? branchState.loading
        : descriptor.kind === 'last-turn'
          ? lastTurnHydratedState.loading
          : gitState.loading;
  const error =
    descriptor.kind === 'commit'
      ? commitState.error
      : descriptor.kind === 'branch'
        ? branchState.error
        : descriptor.kind === 'last-turn'
          ? lastTurnHydratedState.error
          : gitState.error;
  const rawDiffCount =
    descriptor.kind === 'commit'
      ? (selectedCommitData?.diffs.length ?? 0)
      : descriptor.kind === 'branch'
        ? (currentBranchData?.diffs.length ?? 0)
        : descriptor.kind === 'staged'
          ? rawStaged.length
          : descriptor.kind === 'last-turn'
            ? rawLastTurnDiffs.length
            : rawUnstaged.length;

  return {
    diffs: sourceDiffs,
    capped,
    loading,
    error,
    refresh: refreshGitSource,
    isPartial: false,
    rawDiffCount,
    lastTurnCount:
      lastTurnCapped?.stats.fileCount ??
      availableLastTurnDiffs.length + lastTurnCappedEntries.length,
    reviewData: gitState.data,
    commitData: selectedCommitData,
    branchData: currentBranchData,
    gitLoading: gitState.loading,
    gitError: gitState.error,
    gitErrorCode: gitState.errorCode,
    refreshGit: gitState.refresh,
    setReviewData: gitState.setData,
  };
}

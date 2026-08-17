/**
 * ReviewTabBody — unified workspace and recorded-message review panel.
 *
 * A persisted descriptor selects the data source. The toolbar remains shared;
 * source capabilities decide which actions are available.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Diff,
  Eye,
  EyeOff,
  FileDiff as FileDiffIcon,
  FileSearch,
  FoldVertical,
  Folder,
  FolderOpen,
  GitBranch,
  Image,
  ImageOff,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareSplitHorizontal,
  Undo2,
  UnfoldVertical,
  Upload,
  WrapText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn, basename } from '@/lib/utils';
import type {
  FileDiff,
  ReviewBranchBaseCandidate,
  ReviewBranchDiffData,
  ReviewBranchDiffWarning,
  ReviewCappedDiffData,
  ReviewCommit,
  ReviewDiffSummaryEntry,
  ReviewFileTarget,
  ReviewImagePreviewData,
  ReviewMarkdownPreviewData,
  ReviewPushResult,
  ReviewSource,
  ReviewStageAction,
  ReviewStageOperationSummary,
} from '@/lib/gitReview.types';
import { formatSidebarTime } from '@/features/cc-agent/lib/formatSidebarTime';

import { gitReviewApiFor, isReviewRemoteOversizeError } from '@/lib/gitReviewTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import { extractIpcError } from '@/utils/ipcError';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { buildCappedDiffData } from '../../../../../shared/gitReviewCapped';
import { capabilitiesFor, type ReviewSourceDescriptor } from '../../../../../shared/reviewSource';
import type { TabKindHostContext } from '../../types';
import type { ReviewState } from './index';
import { getReviewDiffsExpanded, setReviewDiffsExpanded } from './diffExpansionPreference';
import { PlainUnifiedDiff, type DiffViewMode } from './DiffViewer/PlainUnifiedDiff';
import { MarkdownDiffPreview } from './DiffViewer/MarkdownDiffPreview';
import { shouldVirtualizeFileList } from './DiffViewer/diffRows';
import {
  buildFilteredReviewFileTree,
  filterReviewFileJumpResults,
  findReviewFileTreeFileIndex,
  flattenReviewFileTree,
  getReviewDiffExpansionAction,
  getReviewFileTreeVisibility,
  isReviewFileTreeScrollKey,
  moveReviewFileJumpSelection,
  nextReviewFileJumpPreciseScrollStep,
  nextReviewFileTreeActiveIdFromScroll,
  REVIEW_FILE_TREE_WIDTH_PX,
  type ReviewFileJumpResult,
  type ReviewFileTreeFlatNode,
} from './fileTree';
import { getGitApplyCopyAvailability } from './gitApplyCommand';
import { getRichMarkdownPreviewEligibility } from './markdownPreview';
import { REVIEW_TURN_LOCAL_ONLY_ERROR, useReviewSource } from './useReviewSource';
import { useReviewCommits, useReviewFileDiff } from './useReviewGitState';

interface ReviewTabBodyProps {
  state: ReviewState;
  ctx: TabKindHostContext;
}

type ReviewToggleAction = Extract<ReviewStageAction, 'stage' | 'unstage'>;
type RevealActionScope = 'file' | 'section';
type ReviewToolbarLayout = 'wide' | 'compact' | 'minimal';
type BatchActionLayout = 'full' | 'icon-only';
interface ReviewFileJumpRequest {
  id: string;
  nonce: number;
}

type LoadImagePreview = (diff: FileDiff) => Promise<ReviewImagePreviewData>;
type LoadMarkdownPreview = (diff: FileDiff) => Promise<ReviewMarkdownPreviewData>;

const SECTION_ACTION_REVEAL_CLASS =
  'invisible opacity-0 transition-opacity group-hover/section:visible group-hover/section:opacity-100 group-focus-within/section:visible group-focus-within/section:opacity-100';

// 断点按四语言最长文案(ja/ko 明显长于 zh/en)和 A/B 后 900px 窗口的
// 240px 实际 RSB 宽校准:240px 只能容纳 source + 统计 + 主操作 / 跳转 / More
// 三个图标;420px 起可放回次级图标;560px 起恢复分支信息、文本主按钮和独立 Push 文案。
export const REVIEW_TOOLBAR_MINIMAL_MAX_WIDTH_PX = 419;
export const REVIEW_TOOLBAR_COMPACT_MAX_WIDTH_PX = 559;
export const REVIEW_BATCH_ICON_ONLY_MAX_WIDTH_PX = 419;
export const REVIEW_BRANCH_BASE_LABEL_MIN_WIDTH_PX = 520;

export function getReviewToolbarLayout(containerWidth: number): ReviewToolbarLayout {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 'wide';
  if (containerWidth <= REVIEW_TOOLBAR_MINIMAL_MAX_WIDTH_PX) return 'minimal';
  if (containerWidth <= REVIEW_TOOLBAR_COMPACT_MAX_WIDTH_PX) return 'compact';
  return 'wide';
}

export function getBatchActionLayout(containerWidth: number): BatchActionLayout {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 'full';
  return containerWidth <= REVIEW_BATCH_ICON_ONLY_MAX_WIDTH_PX ? 'icon-only' : 'full';
}

export function shouldShowBranchBaseLabel(
  rowWidth: number,
  hasBranchBaseControl: boolean,
): boolean {
  return (
    hasBranchBaseControl &&
    Number.isFinite(rowWidth) &&
    rowWidth >= REVIEW_BRANCH_BASE_LABEL_MIN_WIDTH_PX
  );
}

export function shouldOfferReviewOpenFile(
  remoteHostId: string | null,
  deviceLinkDeviceId: string | null,
): boolean {
  return remoteHostId === null && deviceLinkDeviceId === null;
}

export type ReviewCommitActionDisabledReason =
  'no-message' | 'write-disabled' | 'no-changes' | 'no-staged' | null;

export function getReviewCommitActionDisabledReason({
  message,
  includeUnstaged,
  stagedCount,
  unstagedCount,
  canWrite,
}: {
  message: string;
  includeUnstaged: boolean;
  stagedCount: number;
  unstagedCount: number;
  canWrite: boolean;
}): ReviewCommitActionDisabledReason {
  if (message.trim() === '') return 'no-message';
  if (!canWrite) return 'write-disabled';
  if (includeUnstaged) return stagedCount + unstagedCount > 0 ? null : 'no-changes';
  return stagedCount > 0 ? null : 'no-staged';
}

export interface ReviewCommitRunResult {
  committed: boolean;
  completed: boolean;
}

export function getReviewCommitDropdownCompletionEffect(result: ReviewCommitRunResult): {
  clearMessage: boolean;
  closeDropdown: boolean;
} {
  return {
    clearMessage: result.committed,
    closeDropdown: result.completed,
  };
}

export function refreshBranchDiffAfterCommit(
  source: ReviewSource,
  refreshBranchDiff: () => void,
): void {
  if (source === 'branch') refreshBranchDiff();
}

export function reviewActionRevealClass(scope: RevealActionScope, forceVisible: boolean): string {
  if (scope === 'file') return 'visible opacity-100 transition-opacity';
  if (forceVisible) return 'visible opacity-100 transition-opacity';
  return SECTION_ACTION_REVEAL_CLASS;
}

export function canUsePatchBasedReviewActions(hideWhitespace: boolean): boolean {
  return typeof hideWhitespace === 'boolean';
}

export function shouldHideWhitespaceOnlyDiff(
  diff: Pick<FileDiff, 'kind' | 'status' | 'hunks'>,
  hideWhitespace: boolean,
): boolean {
  return (
    hideWhitespace && diff.kind === 'text' && diff.status === 'modified' && diff.hunks.length === 0
  );
}

export function filterWhitespaceHiddenDiffs(
  diffs: readonly FileDiff[],
  hideWhitespace: boolean,
): FileDiff[] {
  if (!hideWhitespace) return Array.from(diffs);
  return diffs.filter((diff) => !shouldHideWhitespaceOnlyDiff(diff, true));
}

export function getExpandedDiffSet(
  diffs: readonly Pick<FileDiff, 'id'>[],
  diffsExpanded: boolean,
  expansionOverrides: ReadonlyMap<string, boolean>,
): Set<string> {
  return new Set(
    diffs
      .map((diff) => diff.id)
      .filter((id) => (expansionOverrides.get(id) ?? diffsExpanded) === true),
  );
}

export function summaryEntryToPlaceholderDiff(entry: ReviewDiffSummaryEntry): FileDiff {
  return {
    id: entry.id,
    source: entry.source,
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    kind: entry.isBinary ? 'binary' : 'text',
    size: entry.changedBytes,
    additions: entry.additions,
    deletions: entry.deletions,
    isBinary: entry.isBinary,
    isSubmodule: entry.isSubmodule,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
  };
}

export function fileDiffToSummaryEntry(diff: FileDiff): ReviewDiffSummaryEntry {
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

export function getLastTurnCappedSummaryEntries(
  worktreeCapped:
    | { staged: ReviewCappedDiffData | null; unstaged: ReviewCappedDiffData | null }
    | null
    | undefined,
  lastTurnPaths: ReadonlySet<string>,
): ReviewDiffSummaryEntry[] {
  return [
    ...(worktreeCapped?.unstaged?.files ?? []),
    ...(worktreeCapped?.staged?.files ?? []),
  ].filter(
    (entry) =>
      lastTurnPaths.has(entry.path) || (entry.oldPath !== null && lastTurnPaths.has(entry.oldPath)),
  );
}

export function buildLastTurnCappedData(
  availableDiffs: readonly FileDiff[],
  cappedEntries: readonly ReviewDiffSummaryEntry[],
): ReviewCappedDiffData | null {
  return buildCappedDiffData([...availableDiffs.map(fileDiffToSummaryEntry), ...cappedEntries]);
}

export function getCappedDiffForSource({
  source,
  worktreeCapped,
  commitCapped,
  branchCapped,
  lastTurnCapped,
}: {
  source: ReviewSource;
  worktreeCapped?: {
    staged: ReviewCappedDiffData | null;
    unstaged: ReviewCappedDiffData | null;
  } | null;
  commitCapped?: ReviewCappedDiffData | null;
  branchCapped?: ReviewCappedDiffData | null;
  lastTurnCapped?: ReviewCappedDiffData | null;
}): ReviewCappedDiffData | null {
  if (source === 'unstaged') return worktreeCapped?.unstaged ?? null;
  if (source === 'staged') return worktreeCapped?.staged ?? null;
  if (source === 'commit') return commitCapped ?? null;
  if (source === 'branch') return branchCapped ?? null;
  if (source === 'last-turn') return lastTurnCapped ?? null;
  return null;
}

export function getNextCappedFileSelection(
  currentId: string | null,
  diffs: readonly Pick<FileDiff, 'id'>[],
): string | null {
  if (currentId && diffs.some((diff) => diff.id === currentId)) return currentId;
  return diffs[0]?.id ?? null;
}

export function scrollElementIntoContainerView(
  container: HTMLElement | null,
  element: HTMLElement | null,
  align: 'start' | 'nearest',
): void {
  if (!container || !element) return;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const currentTop = container.scrollTop;
  const targetTop = currentTop + elementRect.top - containerRect.top;

  if (align === 'start') {
    container.scrollTo({ top: targetTop });
    return;
  }

  if (elementRect.top < containerRect.top) {
    container.scrollTo({ top: targetTop });
    return;
  }
  if (elementRect.bottom > containerRect.bottom) {
    container.scrollTo({ top: currentTop + elementRect.bottom - containerRect.bottom });
  }
}

export function shouldFallbackFromMissingSelectedCommit(
  source: ReviewSource | 'turn',
  selectedCommitOid: string | null,
  commits: readonly Pick<ReviewCommit, 'oid'>[],
  commitsLoaded: boolean,
  commitsLoading = false,
): boolean {
  return (
    source === 'commit' &&
    commitsLoaded &&
    !commitsLoading &&
    Boolean(selectedCommitOid) &&
    !commits.some((commit) => commit.oid === selectedCommitOid)
  );
}

export function getCurrentBranchDiffData(
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

export function useClearReviewOperationNoticeOnSourceChange(
  source: ReviewSource | 'turn',
  clearOperationNotice: () => void,
): void {
  const previousSourceRef = useRef<ReviewSource | 'turn'>(source);
  useEffect(() => {
    if (previousSourceRef.current === source) return;
    previousSourceRef.current = source;
    clearOperationNotice();
  }, [clearOperationNotice, source]);
}

export function reviewSourceStatePatch(descriptor: ReviewSourceDescriptor) {
  return {
    descriptor,
    jumpTarget: null,
    // A partial state merge cannot delete the deprecated field. Null prevents
    // legacy migration from reviving the previous historical source.
    turnTarget: null,
  };
}

export function descriptorForReviewSource(
  source: ReviewSource,
  branchBaseRef: string | null,
): ReviewSourceDescriptor {
  if (source === 'commit') return { kind: 'commit', commitOid: null };
  if (source === 'branch') return { kind: 'branch', baseRef: branchBaseRef };
  return { kind: source };
}

export function ReviewTabBody({ state, ctx }: ReviewTabBodyProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  // device-link 远程会话:session 行在被控设备的 DB 里,只读查询经 gitReviewTransport
  // 隧道到被控端执行(被控端以它自己的 session 记录解析 workdir);写操作与本机
  // 文件打开在控制端禁用(readOnly 经 writeDisabledReasons 的 remote-device 档)。
  const deviceLinkDeviceId = ctx.deviceLinkDeviceId ?? null;
  const sessionId = ctx.sessionId || null;
  const hideWhitespace = state.hideWhitespace ?? false;
  const descriptor = state.descriptor;
  const messageSnapshot =
    state.messageSnapshot ?? (descriptor.kind === 'turn-set' ? descriptor : null);
  const source: ReviewSource | 'turn' = descriptor.kind === 'turn-set' ? 'turn' : descriptor.kind;
  const branchBaseRef =
    state.branchBaseRef ?? (descriptor.kind === 'branch' ? descriptor.baseRef : null);
  const selectedCommitOid = descriptor.kind === 'commit' ? descriptor.commitOid : null;
  const effectiveCommitOid = selectedCommitOid;
  const crossSession =
    descriptor.kind === 'turn-set' &&
    Boolean(descriptor.targetSessionId && descriptor.targetSessionId !== sessionId);
  const capabilities = useMemo(() => {
    const sourceCapabilities = capabilitiesFor(descriptor);
    return {
      ...sourceCapabilities,
      canSwitchSource:
        descriptor.kind === 'turn-set' && crossSession ? false : sourceCapabilities.canSwitchSource,
    };
  }, [crossSession, descriptor]);
  const setDescriptor = useCallback(
    (nextDescriptor: ReviewSourceDescriptor) => {
      ctx.patchState(reviewSourceStatePatch(nextDescriptor));
    },
    [ctx],
  );
  const setSource = useCallback(
    (nextSource: ReviewSource) => {
      setDescriptor(descriptorForReviewSource(nextSource, branchBaseRef));
    },
    [branchBaseRef, setDescriptor],
  );
  const selectMessageSnapshot = useCallback(() => {
    if (messageSnapshot) setDescriptor(messageSnapshot);
  }, [messageSnapshot, setDescriptor]);
  const sourceState = useReviewSource(descriptor, sessionId, {
    hideWhitespace,
    deviceLinkDeviceId: ctx.deviceLinkDeviceId,
    remoteHostId: ctx.remoteHostId,
  });
  const data = sourceState.reviewData;
  const loading = sourceState.loading;
  const error = sourceState.error;
  const errorCode = sourceState.gitErrorCode;
  const refresh = sourceState.refreshGit;
  const setReviewData = sourceState.setReviewData;
  const commitsState = useReviewCommits(
    capabilities.canSwitchSource ? sessionId : null,
    branchBaseRef,
    deviceLinkDeviceId,
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationSummary, setOperationSummary] = useState<ReviewStageOperationSummary | null>(
    null,
  );
  const [jumpRequest, setJumpRequest] = useState<ReviewFileJumpRequest | null>(null);
  const [selectedCappedFileId, setSelectedCappedFileId] = useState<string | null>(null);
  const [reviewWriteVersion, setReviewWriteVersion] = useState(0);
  // header 元素用 state 而不是 ref 持有:首帧常走"无会话 / 加载中"早退分支,
  // <header> 尚不存在;空依赖 effect 只跑一次会永远挂不上 ResizeObserver,
  // headerWidth 恒 0 → 工具栏收纳档位永远判 wide(实测踩过)。元素出现 /
  // 消失时 setState 触发 effect 重挂,才能覆盖所有渲染分支切换。
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
  const runningSnapshot = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const agentRunning = sessionId ? runningSnapshot.get(sessionId)?.isRunning === true : false;

  const diffViewMode: DiffViewMode = state.diffViewMode ?? 'unified';
  const fileTreeVisible = state.fileTreeVisible ?? false;
  const wordWrap = state.wordWrap ?? false;
  const wordDiff = state.wordDiff ?? false;
  const richMarkdownPreview = state.richMarkdownPreview ?? true;
  const persistedDiffsExpanded = state.diffsExpanded ?? true;
  const diffsExpanded = getReviewDiffsExpanded(sessionId ?? '', persistedDiffsExpanded);
  const [diffExpansionOverrides, setDiffExpansionOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!sessionId) return;
    setReviewDiffsExpanded(sessionId, diffsExpanded);
    if (diffsExpanded !== persistedDiffsExpanded) {
      ctx.patchState({ diffsExpanded });
    }
  }, [ctx, diffsExpanded, persistedDiffsExpanded, sessionId]);
  const rawUnstaged = data?.diffs.unstaged ?? [];
  const rawStaged = data?.diffs.staged ?? [];
  const worktreeCapped = data?.diffs.capped ?? null;
  const unstaged = useMemo(
    () => filterWhitespaceHiddenDiffs(rawUnstaged, hideWhitespace),
    [hideWhitespace, rawUnstaged],
  );
  const staged = useMemo(
    () => filterWhitespaceHiddenDiffs(rawStaged, hideWhitespace),
    [hideWhitespace, rawStaged],
  );
  const commits = commitsState.data?.commits ?? [];
  const currentBranchDiffData = sourceState.branchData;
  const selectedCommitDiff = sourceState.commitData;
  const rawCommitDiffs = selectedCommitDiff?.diffs ?? [];
  const rawBranchDiffs = currentBranchDiffData?.diffs ?? [];
  const platform = window.electronAPI?.platform ?? '';
  const branchCandidates = currentBranchDiffData?.candidates ?? [];
  const selectedBranchBaseRef =
    branchBaseRef && branchCandidates.some((candidate) => candidate.refName === branchBaseRef)
      ? branchBaseRef
      : (currentBranchDiffData?.baseRef ?? branchBaseRef);
  const currentCapped = sourceState.capped;
  const cappedSummaryDiffs = useMemo(
    () => (currentCapped ? currentCapped.files.map(summaryEntryToPlaceholderDiff) : []),
    [currentCapped],
  );
  const visibleDiffs = currentCapped ? cappedSummaryDiffs : sourceState.diffs;
  const expandedSet = useMemo(
    () => getExpandedDiffSet(visibleDiffs, diffsExpanded, diffExpansionOverrides),
    [diffExpansionOverrides, diffsExpanded, visibleDiffs],
  );
  const entryJumpDiff = state.jumpTarget?.diffId
    ? visibleDiffs.find((diff) => diff.id === state.jumpTarget?.diffId)
    : state.jumpTarget?.path
      ? visibleDiffs.find(
          (diff) => diff.path === state.jumpTarget?.path || diff.oldPath === state.jumpTarget?.path,
        )
      : null;
  const resolvedJumpRequest =
    jumpRequest ??
    (entryJumpDiff && state.jumpTarget
      ? { id: entryJumpDiff.id, nonce: state.jumpTarget.nonce }
      : null);
  const selectedCappedSummaryDiff = currentCapped
    ? (cappedSummaryDiffs.find((diff) => diff.id === selectedCappedFileId) ??
      cappedSummaryDiffs[0] ??
      null)
    : null;
  const expansionDiffs =
    currentCapped && selectedCappedSummaryDiff ? [selectedCappedSummaryDiff] : visibleDiffs;
  const cappedFileDiffRequest = selectedCappedSummaryDiff
    ? {
        source: selectedCappedSummaryDiff.source,
        path: selectedCappedSummaryDiff.path,
        oldPath: selectedCappedSummaryDiff.oldPath,
        commitOid: selectedCappedSummaryDiff.source === 'commit' ? effectiveCommitOid : null,
        branchBaseRef:
          selectedCappedSummaryDiff.source === 'branch'
            ? (currentBranchDiffData?.baseRef ?? branchBaseRef)
            : null,
        ignoreWhitespace: hideWhitespace,
      }
    : null;
  const cappedFileDiffState = useReviewFileDiff(
    sessionId,
    cappedFileDiffRequest,
    reviewWriteVersion,
    deviceLinkDeviceId,
  );
  const cappedFileDiffData = cappedFileDiffState.data;
  const maybeCappedLoadedDiff = cappedFileDiffData?.diff ?? null;
  const cappedLoadedDiff =
    maybeCappedLoadedDiff?.id === selectedCappedSummaryDiff?.id ? maybeCappedLoadedDiff : null;
  const lastTurnHydrating =
    source === 'last-turn' && sourceState.loading && sourceState.diffs.length === 0;
  const lastTurnHydrationError = source === 'last-turn' ? sourceState.error : null;
  const expansionAction = useMemo(
    () =>
      getReviewDiffExpansionAction(
        expansionDiffs.map((diff) => diff.id),
        diffsExpanded,
      ),
    [diffsExpanded, expansionDiffs],
  );
  const gitApplyAvailability = useMemo(
    () => getGitApplyCopyAvailability(visibleDiffs, hideWhitespace, platform),
    [hideWhitespace, platform, visibleDiffs],
  );
  /**
   * device-link 预览请求只发送被控端实际读取的轻量 diff 字段，裁剪 hunks / hunksPlain
   * 等大字段以节省帧预算。markdownReader 额外读取 kind/size/status/isTooLarge/isBinary,
   * imageReader 读取 kind。本地调用仍传完整 diff 保持兼容。
   */
  const trimPreviewDiff = useCallback(
    (diff: FileDiff): FileDiff =>
      ({
        source: diff.source,
        id: diff.id,
        path: diff.path,
        oldPath: diff.oldPath,
        index: diff.index,
        kind: diff.kind,
        size: diff.size,
        status: diff.status,
        isTooLarge: diff.isTooLarge,
        isBinary: diff.isBinary,
      }) as FileDiff,
    [],
  );
  const loadImagePreview = useCallback<LoadImagePreview>(
    (diff) => {
      if (!sessionId) return Promise.reject(new Error('sessionId is required'));
      return gitReviewApiFor(deviceLinkDeviceId)
        .imagePreview({
          sessionId,
          diff: deviceLinkDeviceId ? trimPreviewDiff(diff) : diff,
          commitOid: diff.source === 'commit' ? effectiveCommitOid : null,
          branchBaseRef:
            diff.source === 'branch' ? (currentBranchDiffData?.baseRef ?? branchBaseRef) : null,
        } as Parameters<typeof window.electronAPI.gitReview.imagePreview>[0])
        .catch((err) => {
          if (isReviewRemoteOversizeError(err))
            throw new Error(t('rightSidebar.review.remote.oversizeDesc'));
          throw err;
        });
    },
    [
      branchBaseRef,
      currentBranchDiffData?.baseRef,
      deviceLinkDeviceId,
      effectiveCommitOid,
      sessionId,
      t,
      trimPreviewDiff,
    ],
  );
  const loadMarkdownPreview = useCallback<LoadMarkdownPreview>(
    (diff) => {
      if (!sessionId) return Promise.reject(new Error('sessionId is required'));
      return gitReviewApiFor(deviceLinkDeviceId)
        .markdownPreview({
          sessionId,
          diff: deviceLinkDeviceId ? trimPreviewDiff(diff) : diff,
          commitOid: diff.source === 'commit' ? effectiveCommitOid : null,
          branchBaseRef:
            diff.source === 'branch' ? (currentBranchDiffData?.baseRef ?? branchBaseRef) : null,
        } as Parameters<typeof window.electronAPI.gitReview.markdownPreview>[0])
        .catch((err) => {
          if (isReviewRemoteOversizeError(err))
            throw new Error(t('rightSidebar.review.remote.oversizeDesc'));
          throw err;
        });
    },
    [
      branchBaseRef,
      currentBranchDiffData?.baseRef,
      deviceLinkDeviceId,
      effectiveCommitOid,
      sessionId,
      t,
      trimPreviewDiff,
    ],
  );
  const unavailableHistoricalPreview = useCallback(
    () => Promise.reject(new Error(t('rightSidebar.review.turn.previewUnavailable'))),
    [t],
  );
  const openReviewFile = useCallback(
    (diff: FileDiff) => {
      if (!sessionId) return;
      void window.electronAPI.gitReview.openFile({ sessionId, path: diff.path }).catch((err) => {
        const message =
          extractIpcError(err)?.message ?? (err instanceof Error ? err.message : String(err));
        toast.error(t('rightSidebar.review.openFileFailed', { error: message }));
      });
    },
    [sessionId, t],
  );
  // device-link 与 SSH 工作区都没有可由控制端 shell 打开的本机文件。
  const openFileHandler =
    capabilities.canOpenFile && shouldOfferReviewOpenFile(ctx.remoteHostId, deviceLinkDeviceId)
      ? openReviewFile
      : undefined;
  // 次级视图(提交 / 分支 / 单文件)错误串的 OVERSIZE 标记 → 可读文案;其余原样。
  const localizeReviewError = useCallback(
    <T extends string | null>(message: T): T | string => {
      if (message && isReviewRemoteOversizeError(message))
        return t('rightSidebar.review.remote.oversizeDesc');
      return message;
    },
    [t],
  );
  const writeDisabledReasons = data?.status?.writeDisabledReasons ?? [];
  const effectiveWriteDisabledReasons = useMemo(() => {
    const reasons = [...writeDisabledReasons];
    if (!capabilities.canCommit || !capabilities.canPush) reasons.push('historical-snapshot');
    // device-link 首期只读:被控端 handler 也不实现写 op,这里是同一契约的 UI 面。
    if (deviceLinkDeviceId) reasons.push('remote-device');
    if (agentRunning) reasons.push('agent-running');
    return Array.from(new Set(reasons));
  }, [
    agentRunning,
    capabilities.canCommit,
    capabilities.canPush,
    deviceLinkDeviceId,
    writeDisabledReasons,
  ]);
  const canWrite = Boolean(
    capabilities.canCommit &&
    capabilities.canPush &&
    data?.status &&
    effectiveWriteDisabledReasons.length === 0 &&
    !pendingKey,
  );
  const commitOrPushPending =
    pendingKey === 'commit' || pendingKey === 'commit-push' || pendingKey === 'push';
  const pushPending = pendingKey === 'push' || pendingKey === 'commit-push';
  const writeDisabledReasonText = effectiveWriteDisabledReasons
    .map((reason) =>
      t(`rightSidebar.review.writeDisabledReasons.${reason}`, { defaultValue: reason }),
    )
    .join(', ');
  const actionWriteDisabledTooltip = writeDisabledReasonText
    ? t('rightSidebar.review.actions.disabledWriteGateWithReasons', {
        reasons: writeDisabledReasonText,
      })
    : undefined;
  const pushWriteDisabledText = writeDisabledReasonText
    ? t('rightSidebar.review.push.disabledWriteGateWithReasons', {
        reasons: writeDisabledReasonText,
      })
    : undefined;
  const totalAdd = visibleDiffs.reduce((sum, diff) => sum + diff.additions, 0);
  const totalDel = visibleDiffs.reduce((sum, diff) => sum + diff.deletions, 0);
  const statusStagedCount = data?.status?.stagedCount ?? rawStaged.length;
  const statusUnstagedCount = data?.status?.unstagedCount ?? rawUnstaged.length;
  const sourceUnstagedCount = worktreeCapped?.unstaged?.stats.fileCount ?? unstaged.length;
  const sourceStagedCount = worktreeCapped?.staged?.stats.fileCount ?? staged.length;
  const sourceLastTurnCount = sourceState.lastTurnCount;

  const clearOperationNotice = useCallback(() => {
    setOperationError(null);
    setOperationSummary(null);
  }, []);

  useClearReviewOperationNoticeOnSourceChange(source, clearOperationNotice);

  const refreshAll = useCallback(() => {
    clearOperationNotice();
    sourceState.refresh();
    commitsState.refresh();
    if (currentCapped) cappedFileDiffState.refresh();
  }, [cappedFileDiffState, clearOperationNotice, commitsState, currentCapped, sourceState]);

  const messageFromOperationError = useCallback(
    (err: unknown): string => {
      const ipcError = extractIpcError(err);
      if (ipcError?.code === 'STALE_DIFF') return t('rightSidebar.review.staleDiff');
      if (ipcError?.code === 'SESSION_RUNNING')
        return t('rightSidebar.review.sessionRunningWriteBlocked');
      if (ipcError?.code === 'PUSH_LEASE_EXPIRED')
        return t('rightSidebar.review.push.leaseExpired');
      if (ipcError?.code === 'PUSH_NO_REMOTE') return t('rightSidebar.review.push.noRemote');
      return ipcError?.message ?? (err instanceof Error ? err.message : String(err));
    },
    [t],
  );

  // 写操作共用的 pending/错误/收尾样板:失败时保留当前视图并触发 refresh。
  const runWrite = useCallback(
    async (
      key: string,
      exec: () => Promise<void>,
      decorateError?: (message: string, err: unknown) => string,
    ): Promise<boolean> => {
      setPendingKey(key);
      clearOperationNotice();
      try {
        await exec();
        return true;
      } catch (err) {
        const message = messageFromOperationError(err);
        setOperationError(decorateError ? decorateError(message, err) : message);
        refresh();
        return false;
      } finally {
        setPendingKey(null);
      }
    },
    [clearOperationNotice, messageFromOperationError, refresh],
  );
  const updateReviewDataFromWrite = useCallback(
    (nextData: typeof data) => {
      if (!nextData) return;
      setReviewWriteVersion((version) => version + 1);
      if (hideWhitespace) {
        refresh();
        return;
      }
      setReviewData(nextData);
    },
    [hideWhitespace, refresh, setReviewData],
  );

  const runStageOperation = useCallback(
    (action: ReviewToggleAction, targets: ReviewFileTarget[], key: string) => {
      if (!sessionId || targets.length === 0) return;
      void runWrite(key, async () => {
        const api =
          action === 'stage'
            ? targets.length === 1
              ? window.electronAPI.gitReview.stageFile
              : window.electronAPI.gitReview.stageAll
            : targets.length === 1
              ? window.electronAPI.gitReview.unstageFile
              : window.electronAPI.gitReview.unstageAll;
        const result = await api({ sessionId, targets });
        updateReviewDataFromWrite(result.data);
        setOperationSummary(result.operation);
      });
    },
    [runWrite, sessionId, updateReviewDataFromWrite],
  );

  const runHunkOperation = useCallback(
    (action: ReviewToggleAction, diff: FileDiff, hunkIndex: number) => {
      if (!sessionId) return;
      void runWrite(`${action}:hunk:${diff.id}:${hunkIndex}`, async () => {
        const api =
          action === 'stage'
            ? window.electronAPI.gitReview.stageHunk
            : window.electronAPI.gitReview.unstageHunk;
        const result = await api({ sessionId, diff, hunkIndex, ignoreWhitespace: hideWhitespace });
        updateReviewDataFromWrite(result.data);
        setOperationSummary(result.operation);
      });
    },
    [hideWhitespace, runWrite, sessionId, updateReviewDataFromWrite],
  );

  const confirmDiscard = useCallback(
    async (scope: 'file' | 'hunk' | 'section', diffs: FileDiff[]): Promise<boolean> => {
      const untrackedCount = diffs.filter((diff) => diff.status === 'untracked').length;
      return confirm({
        title: t(`rightSidebar.review.discard.confirm.${scope}.title`, { count: diffs.length }),
        description:
          untrackedCount > 0
            ? t(`rightSidebar.review.discard.confirm.${scope}.descWithUntracked`, {
                count: diffs.length,
                untrackedCount,
              })
            : t(`rightSidebar.review.discard.confirm.${scope}.desc`, { count: diffs.length }),
        confirmText: t('rightSidebar.review.discard.confirm.confirm'),
        cancelText: t('rightSidebar.review.discard.confirm.cancel'),
      });
    },
    [confirm, t],
  );

  const runDiscardFileOperation = useCallback(
    (diff: FileDiff) => {
      if (!sessionId) return;
      void (async () => {
        if (!(await confirmDiscard('file', [diff]))) return;
        await runWrite(`discard:file:${diff.id}`, async () => {
          const result = await window.electronAPI.gitReview.discardFile({
            sessionId,
            targets: [targetFromDiff(diff)],
          });
          updateReviewDataFromWrite(result.data);
          setOperationSummary(result.operation);
        });
      })();
    },
    [confirmDiscard, runWrite, sessionId, updateReviewDataFromWrite],
  );

  const runDiscardHunkOperation = useCallback(
    (diff: FileDiff, hunkIndex: number) => {
      if (!sessionId) return;
      void (async () => {
        if (!(await confirmDiscard('hunk', [diff]))) return;
        await runWrite(`discard:hunk:${diff.id}:${hunkIndex}`, async () => {
          const result = await window.electronAPI.gitReview.discardHunk({
            sessionId,
            diff,
            hunkIndex,
            ignoreWhitespace: hideWhitespace,
          });
          updateReviewDataFromWrite(result.data);
          setOperationSummary(result.operation);
        });
      })();
    },
    [confirmDiscard, hideWhitespace, runWrite, sessionId, updateReviewDataFromWrite],
  );

  const runDiscardSectionOperation = useCallback(
    (diffsToDiscard: FileDiff[], key: string) => {
      if (!sessionId || diffsToDiscard.length === 0) return;
      void (async () => {
        if (!(await confirmDiscard('section', diffsToDiscard))) return;
        await runWrite(key, async () => {
          const result = await window.electronAPI.gitReview.discardAll({
            sessionId,
            targets: diffsToDiscard.map(targetFromDiff),
          });
          updateReviewDataFromWrite(result.data);
          setOperationSummary(result.operation);
        });
      })();
    },
    [confirmDiscard, runWrite, sessionId, updateReviewDataFromWrite],
  );

  const applyPushResult = useCallback(
    (result: ReviewPushResult) => {
      updateReviewDataFromWrite(result.data);
      return result;
    },
    [updateReviewDataFromWrite],
  );

  const runPushFlow = useCallback(async () => {
    if (!sessionId) return;
    const result = applyPushResult(await window.electronAPI.gitReview.push({ sessionId }));
    if (result.kind !== 'needs-force') {
      toast.success(t('rightSidebar.review.push.successToast'));
      return;
    }

    const ok = await confirm({
      title: t('rightSidebar.review.push.forceTitle'),
      description: t('rightSidebar.review.push.forceDesc', {
        count: result.behind,
        remoteRef: result.remoteRef,
      }),
      confirmText: t('rightSidebar.review.push.forceConfirm'),
      cancelText: t('rightSidebar.review.push.forceCancel'),
    });
    if (!ok) return;

    const forceResult = applyPushResult(
      await window.electronAPI.gitReview.push({
        sessionId,
        confirmForce: {
          remoteRef: result.remoteRef,
          expectedOid: result.remoteOid,
        },
      }),
    );
    if (forceResult.kind === 'needs-force') {
      throw new Error(t('rightSidebar.review.push.forceStillRejected'));
    }
    toast.success(t('rightSidebar.review.push.successToast'));
  }, [applyPushResult, confirm, sessionId, t]);

  const decoratePushError = useCallback(
    (message: string, err: unknown) => {
      // lease/no-remote 已是完整本地化文案;其余(hook 拒绝/凭证/网络)保留 raw 细节,
      // 但补一行本地化主文案,OperationNotice 会把首行做主展示。
      const code = extractIpcError(err)?.code;
      if (code === 'PUSH_LEASE_EXPIRED' || code === 'PUSH_NO_REMOTE' || code === 'SESSION_RUNNING')
        return message;
      return `${t('rightSidebar.review.push.failedTitle')}\n${message}`;
    },
    [t],
  );

  const commitChanges = useCallback(
    (
      message: string,
      includeUnstaged: boolean,
      pushAfterCommit: boolean,
    ): Promise<ReviewCommitRunResult> => {
      if (!sessionId) return Promise.resolve({ committed: false, completed: false });
      let committed = false;
      return runWrite(
        pushAfterCommit ? 'commit-push' : 'commit',
        async () => {
          const result = await window.electronAPI.gitReview.commit({
            sessionId,
            message,
            includeUnstaged,
          });
          committed = true;
          updateReviewDataFromWrite(result.data);
          if (source === 'commit') setDescriptor({ kind: 'commit', commitOid: result.commitOid });
          commitsState.refresh();
          if (source === 'branch') sourceState.refresh();
          if (pushAfterCommit) await runPushFlow();
        },
        (messageText, err) => {
          if (!committed) return messageText;
          return decoratePushError(messageText, err);
        },
      ).then((completed) => ({ committed, completed }));
    },
    [
      commitsState,
      decoratePushError,
      runPushFlow,
      runWrite,
      sessionId,
      setDescriptor,
      source,
      sourceState,
      updateReviewDataFromWrite,
    ],
  );

  const pushCurrentBranch = useCallback(() => {
    if (!sessionId) return;
    void runWrite('push', runPushFlow, decoratePushError);
  }, [decoratePushError, runPushFlow, runWrite, sessionId]);

  useEffect(() => {
    if (
      shouldFallbackFromMissingSelectedCommit(
        source,
        selectedCommitOid,
        commits,
        commitsState.data !== null,
        commitsState.loading,
      )
    ) {
      setSource('branch');
    }
  }, [commits, commitsState.data, commitsState.loading, selectedCommitOid, setSource, source]);

  const togglePath = useCallback(
    (id: string) => {
      setDiffExpansionOverrides((current) => {
        const next = new Map(current);
        const nextExpanded = !(next.get(id) ?? diffsExpanded);
        if (nextExpanded === diffsExpanded) next.delete(id);
        else next.set(id, nextExpanded);
        return next;
      });
    },
    [diffsExpanded],
  );
  const setDiffViewMode = useCallback(
    (mode: DiffViewMode) => {
      ctx.patchState({ diffViewMode: mode });
    },
    [ctx],
  );
  const setFileTreeVisible = useCallback(
    (visible: boolean) => {
      ctx.patchState({ fileTreeVisible: visible });
    },
    [ctx],
  );
  const setWordWrap = useCallback(
    (nextWordWrap: boolean) => {
      ctx.patchState({ wordWrap: nextWordWrap });
    },
    [ctx],
  );
  const setWordDiff = useCallback(
    (nextWordDiff: boolean) => {
      ctx.patchState({ wordDiff: nextWordDiff });
    },
    [ctx],
  );
  const setHideWhitespace = useCallback(
    (nextHideWhitespace: boolean) => {
      ctx.patchState({ hideWhitespace: nextHideWhitespace });
    },
    [ctx],
  );
  const setRichMarkdownPreview = useCallback(
    (nextRichMarkdownPreview: boolean) => {
      ctx.patchState({ richMarkdownPreview: nextRichMarkdownPreview });
    },
    [ctx],
  );
  const setBranchBaseRef = useCallback(
    (nextBaseRef: string) => {
      ctx.patchState({
        ...reviewSourceStatePatch({ kind: 'branch', baseRef: nextBaseRef }),
        branchBaseRef: nextBaseRef,
      });
    },
    [ctx],
  );
  const selectCommitSource = useCallback(
    (oid: string) => {
      setDescriptor({ kind: 'commit', commitOid: oid });
    },
    [setDescriptor],
  );
  const requestFileJump = useCallback((diff: FileDiff) => {
    setJumpRequest((prev) => ({ id: diff.id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const selectCappedFile = useCallback(
    (diff: FileDiff) => {
      setSelectedCappedFileId(diff.id);
      if (!expandedSet.has(diff.id)) {
        setDiffExpansionOverrides((current) => new Map(current).set(diff.id, true));
      }
    },
    [expandedSet],
  );
  const toggleAllDiffs = useCallback(() => {
    if (expansionAction === 'disabled') return;
    const nextDiffsExpanded = expansionAction === 'expand';
    setDiffExpansionOverrides(new Map());
    if (sessionId) setReviewDiffsExpanded(sessionId, nextDiffsExpanded);
    ctx.patchState({ diffsExpanded: nextDiffsExpanded });
  }, [ctx, expansionAction, sessionId]);
  const copyGitApplyCommand = useCallback(() => {
    const availability = getGitApplyCopyAvailability(visibleDiffs, hideWhitespace, platform);
    if (!availability.canCopy) return;
    void navigator.clipboard
      .writeText(availability.payload.command)
      .then(() => toast.success(t('rightSidebar.review.moreMenu.copyGitApplySuccess')))
      .catch(() => toast.error(t('rightSidebar.review.moreMenu.copyGitApplyFailed')));
  }, [hideWhitespace, platform, t, visibleDiffs]);

  useEffect(() => {
    if (!currentCapped) return;
    const nextId = getNextCappedFileSelection(selectedCappedFileId, cappedSummaryDiffs);
    if (nextId === selectedCappedFileId) return;
    setSelectedCappedFileId(nextId);
    if (nextId && !expandedSet.has(nextId)) {
      setDiffExpansionOverrides((current) => new Map(current).set(nextId, true));
    }
  }, [cappedSummaryDiffs, currentCapped, expandedSet, selectedCappedFileId]);

  useEffect(() => {
    // 切 source 后 DiffList 重挂载、nonce 去重 ref 归零;残留的
    // jumpRequest 会在切回同 source 时被重放成一次意外跳转,这里清掉。
    setJumpRequest(null);
  }, [source]);

  useEffect(() => {
    if (!headerEl) {
      setHeaderWidth(0);
      return;
    }
    const update = () => setHeaderWidth(headerEl.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);

  if (!sessionId) {
    return (
      <CenteredState
        icon={<FileDiffIcon size={24} />}
        title={t('rightSidebar.review.noSessionTitle')}
        desc={t('rightSidebar.review.noSessionDesc')}
      />
    );
  }

  if (source !== 'turn' && !data && sourceState.gitLoading) {
    return (
      <CenteredState
        icon={<Spinner icon={RefreshCw} size={24} />}
        title={t('rightSidebar.review.loadingTitle')}
        desc={t('rightSidebar.review.loadingDesc')}
      />
    );
  }

  if (source !== 'turn' && sourceState.gitError && !data) {
    // device-link 远程会话的两类确定性失败给专属占位:老被控端无 remote-op
    // channel(升级即解决,刷新无用),以及响应超设备互联帧预算。
    if (deviceLinkDeviceId && errorCode === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
      return (
        <CenteredState
          icon={<AlertTriangle size={24} />}
          title={t('rightSidebar.review.remote.deviceTooOldTitle')}
          desc={t('rightSidebar.review.remote.deviceTooOldDesc')}
        />
      );
    }
    if (deviceLinkDeviceId && isReviewRemoteOversizeError(sourceState.gitError)) {
      return (
        <CenteredState
          icon={<AlertTriangle size={24} />}
          title={t('rightSidebar.review.remote.oversizeTitle')}
          desc={t('rightSidebar.review.remote.oversizeDesc')}
          actionLabel={t('rightSidebar.review.refresh')}
          onAction={refresh}
        />
      );
    }
    return (
      <CenteredState
        icon={<AlertTriangle size={24} />}
        title={t('rightSidebar.review.errorTitle')}
        desc={sourceState.gitError}
        actionLabel={t('rightSidebar.review.refresh')}
        onAction={refresh}
      />
    );
  }

  if (data?.scope.disabledReason) {
    const disabledTitle = t(`rightSidebar.review.disabled.${data.scope.disabledReason}.title`, {
      defaultValue: t('rightSidebar.review.disabled.default.title'),
    });
    const disabledDesc = t(`rightSidebar.review.disabled.${data.scope.disabledReason}.desc`, {
      defaultValue: data.scope.disabledMessage ?? t('rightSidebar.review.disabled.default.desc'),
    });
    return (
      <CenteredState
        icon={<AlertTriangle size={24} />}
        title={disabledTitle}
        desc={disabledDesc}
        actionLabel={t('rightSidebar.review.refresh')}
        onAction={refresh}
      />
    );
  }

  const branchLabel = data?.scope.isDetached
    ? t('rightSidebar.review.detachedHead', { oid: data.scope.headOid?.slice(0, 7) ?? '' })
    : data?.scope.branch || t('rightSidebar.review.branchUnknown');
  const hasAnyDiff =
    rawUnstaged.length + rawStaged.length + sourceUnstagedCount + sourceStagedCount > 0;
  const reviewRefreshPending =
    sourceState.loading ||
    sourceState.gitLoading ||
    commitsState.loading ||
    cappedFileDiffState.loading;
  const toolbarLayout = getReviewToolbarLayout(headerWidth);
  const toolbarMinimal = toolbarLayout === 'minimal';
  const toolbarShowBranch = toolbarLayout === 'wide' && capabilities.showBranchInfo;
  const toolbarShowSecondaryActions = toolbarLayout !== 'minimal';
  const toolbarFileTreeVisibility = getReviewFileTreeVisibility({
    userVisible: fileTreeVisible,
    containerWidth: headerWidth,
    fileCount: visibleDiffs.length,
  });
  const copyGitApplyDisabledTooltip =
    descriptor.kind === 'turn-set'
      ? t('rightSidebar.review.turn.snapshotPatchUnavailable')
      : !gitApplyAvailability.canCopy
        ? gitApplyAvailability.reason === 'hide-whitespace'
          ? t('rightSidebar.review.moreMenu.copyGitApplyDisabledWhitespace')
          : t('rightSidebar.review.moreMenu.copyGitApplyDisabledEmpty')
        : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
      <header
        ref={setHeaderEl}
        className={cn(
          'shrink-0 border-b border-[var(--border-default)] py-2',
          toolbarMinimal ? 'px-2' : 'px-3',
        )}
      >
        <div
          className={cn('flex min-h-8 min-w-0 items-center', toolbarMinimal ? 'gap-1' : 'gap-1.5')}
        >
          <SourceDropdown
            source={source}
            messageSnapshotAvailable={messageSnapshot !== null}
            counts={{
              unstaged: sourceUnstagedCount,
              staged: sourceStagedCount,
              branch: rawBranchDiffs.length,
              lastTurn: sourceLastTurnCount,
            }}
            commits={commits}
            commitsLoading={commitsState.loading}
            commitsError={commitsState.error}
            commitsLoaded={commitsState.data !== null}
            selectedCommitOid={selectedCommitOid}
            layout={toolbarLayout}
            disabledReason={
              capabilities.canSwitchSource
                ? undefined
                : t('rightSidebar.review.turn.crossSessionSwitchDisabled')
            }
            onChange={setSource}
            onSelectMessageSnapshot={selectMessageSnapshot}
            onSelectCommit={selectCommitSource}
            onRefreshCommits={commitsState.refresh}
          />
          <span className="shrink-0 whitespace-nowrap font-mono text-11 tabular-nums">
            <span className="text-[var(--diff-add-fg)]">+{totalAdd}</span>{' '}
            <span className="text-[var(--diff-del-fg)]">-{totalDel}</span>
          </span>
          {toolbarShowBranch && (
            <>
              <div className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-default)]" />
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
                  {branchLabel}
                </span>
                {data?.scope.aheadBehind.upstream && (
                  <AheadBehindPill
                    ahead={data.scope.aheadBehind.ahead}
                    behind={data.scope.aheadBehind.behind}
                    upstream={data.scope.aheadBehind.upstream}
                  />
                )}
              </div>
            </>
          )}
          <div
            className={cn(
              'flex shrink-0 items-center',
              toolbarMinimal ? 'gap-0.5' : 'gap-1',
              !toolbarShowBranch && 'ml-auto',
            )}
          >
            <ReviewMoreMenu
              wordWrap={wordWrap}
              wordDiff={wordDiff}
              hideWhitespace={hideWhitespace}
              diffExpansionOverflow={
                toolbarShowSecondaryActions
                  ? null
                  : {
                      action: expansionAction,
                      onToggle: toggleAllDiffs,
                    }
              }
              fileTreeOverflow={
                toolbarShowSecondaryActions
                  ? null
                  : {
                      preferenceVisible: fileTreeVisible,
                      temporarilyHidden: toolbarFileTreeVisibility.temporarilyHidden,
                      onToggle: () => setFileTreeVisible(!fileTreeVisible),
                    }
              }
              canCopyGitApply={descriptor.kind !== 'turn-set' && gitApplyAvailability.canCopy}
              copyGitApplyDisabledTooltip={copyGitApplyDisabledTooltip}
              onWordWrapChange={setWordWrap}
              onWordDiffChange={setWordDiff}
              onHideWhitespaceChange={setHideWhitespace}
              onCopyGitApply={copyGitApplyCommand}
            />
            <FileJumpPopover
              diffs={visibleDiffs}
              onSelectFile={currentCapped ? selectCappedFile : requestFileJump}
            />
            {toolbarShowSecondaryActions && (
              <>
                <DiffExpansionToggleButton action={expansionAction} onToggle={toggleAllDiffs} />
                <FileTreeToggleButton
                  preferenceVisible={fileTreeVisible}
                  temporarilyHidden={toolbarFileTreeVisibility.temporarilyHidden}
                  onToggle={() => setFileTreeVisible(!fileTreeVisible)}
                />
              </>
            )}
            <CommitOrPushDropdown
              branchLabel={branchLabel}
              totalAdd={totalAdd}
              totalDel={totalDel}
              stagedCount={statusStagedCount}
              unstagedCount={statusUnstagedCount}
              canWrite={canWrite}
              writeDisabledText={writeDisabledReasonText}
              pending={commitOrPushPending}
              push={{
                branch: data?.scope.branch ?? null,
                ahead: data?.scope.aheadBehind.ahead ?? 0,
                behind: data?.scope.aheadBehind.behind ?? 0,
                upstream: data?.scope.aheadBehind.upstream ?? null,
                canWrite,
                writeDisabledText: pushWriteDisabledText,
                pending: pushPending,
                onPush: () => pushCurrentBranch(),
              }}
              iconOnly={toolbarLayout !== 'wide'}
              platform={platform}
              onCommit={commitChanges}
            />
          </div>
        </div>
        {effectiveWriteDisabledReasons.length > 0 && (
          <div className="mt-2 flex items-start gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-2.5 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
            <span>
              {t('rightSidebar.review.writeDisabledNotice', {
                reasons: writeDisabledReasonText,
              })}
            </span>
          </div>
        )}
        {(Boolean(operationError) || (operationSummary?.failed.length ?? 0) > 0) && (
          <OperationNotice error={operationError} summary={operationSummary} />
        )}
      </header>

      {!loading && !error && sourceState.isPartial && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-3 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
          <span>{t('rightSidebar.review.turn.partialNotice')}</span>
        </div>
      )}

      {source === 'turn' ? (
        loading ? (
          <CenteredState
            icon={<Spinner size={24} />}
            title={t('rightSidebar.review.loadingTitle')}
            desc={t('rightSidebar.review.loadingDesc')}
          />
        ) : error ? (
          <CenteredState
            icon={<AlertTriangle size={24} />}
            title={t('rightSidebar.review.errorTitle')}
            desc={
              error === REVIEW_TURN_LOCAL_ONLY_ERROR
                ? t('rightSidebar.review.turn.localOnly')
                : error
            }
            actionLabel={t('rightSidebar.review.refresh')}
            onAction={refreshAll}
          />
        ) : visibleDiffs.length === 0 ? (
          <CenteredState
            icon={<FileDiffIcon size={24} />}
            title={t('rightSidebar.review.turn.emptyTitle')}
            desc={t('rightSidebar.review.turn.emptyDesc')}
          />
        ) : (
          <DiffList
            diffs={visibleDiffs}
            expandedSet={expandedSet}
            onToggleDiff={togglePath}
            onRefresh={refreshAll}
            refreshPending={reviewRefreshPending}
            viewMode={diffViewMode}
            onViewModeChange={setDiffViewMode}
            onRichMarkdownPreviewChange={setRichMarkdownPreview}
            wordWrap={wordWrap}
            wordDiff={wordDiff}
            fileTreeVisible={fileTreeVisible}
            jumpRequest={resolvedJumpRequest}
            loadImagePreview={unavailableHistoricalPreview}
            loadMarkdownPreview={unavailableHistoricalPreview}
            richMarkdownPreview={false}
            richMarkdownPreviewDisabledReason={t('rightSidebar.review.turn.previewUnavailable')}
          />
        )
      ) : currentCapped ? (
        <CappedSourceView
          capped={currentCapped}
          summaryDiffs={cappedSummaryDiffs}
          selectedSummaryDiff={selectedCappedSummaryDiff}
          loadedDiff={cappedLoadedDiff}
          loading={cappedFileDiffState.loading && !cappedLoadedDiff}
          error={localizeReviewError(cappedFileDiffState.error)}
          onSelectFile={selectCappedFile}
          onRefresh={refreshAll}
          refreshPending={reviewRefreshPending}
          branchBaseControl={
            source === 'branch' ? (
              <BranchBaseDropdown
                candidates={branchCandidates}
                selectedBaseRef={selectedBranchBaseRef}
                onSelectBase={setBranchBaseRef}
              />
            ) : undefined
          }
          topNotice={
            source === 'branch' && currentBranchDiffData?.warning
              ? branchWarningText(currentBranchDiffData.warning, t)
              : null
          }
          viewMode={diffViewMode}
          onViewModeChange={setDiffViewMode}
          onRichMarkdownPreviewChange={setRichMarkdownPreview}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          expandedSet={expandedSet}
          onToggleDiff={togglePath}
          fileTreeVisible
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={capabilities.canRichPreview && richMarkdownPreview}
          onOpenFile={openFileHandler}
          writeAction={
            source === 'unstaged'
              ? {
                  canWrite,
                  pendingKey,
                  disabledTooltip: actionWriteDisabledTooltip,
                  actionForDiff: () => 'stage',
                  discardForDiff: (diff) => diff.source === 'unstaged',
                  hunkActionsEnabled: canUsePatchBasedReviewActions(hideWhitespace),
                  sectionAction: null,
                  sectionPendingKey: 'stage:all',
                  onFileAction: (diff) =>
                    runStageOperation('stage', [targetFromDiff(diff)], `stage:file:${diff.id}`),
                  onFileDiscard: runDiscardFileOperation,
                  onHunkAction: (diff, hunkIndex) => runHunkOperation('stage', diff, hunkIndex),
                  onHunkDiscard: runDiscardHunkOperation,
                }
              : source === 'staged'
                ? {
                    canWrite,
                    pendingKey,
                    disabledTooltip: actionWriteDisabledTooltip,
                    actionForDiff: () => 'unstage',
                    hunkActionsEnabled: canUsePatchBasedReviewActions(hideWhitespace),
                    sectionAction: null,
                    sectionPendingKey: 'unstage:all',
                    onFileAction: (diff) =>
                      runStageOperation(
                        'unstage',
                        [targetFromDiff(diff)],
                        `unstage:file:${diff.id}`,
                      ),
                    onHunkAction: (diff, hunkIndex) => runHunkOperation('unstage', diff, hunkIndex),
                  }
                : undefined
          }
        />
      ) : source === 'commit' ? (
        <CommitSourceView
          selectedCommitOid={effectiveCommitOid}
          diffs={sourceState.diffs}
          rawDiffCount={rawCommitDiffs.length}
          diffLoading={sourceState.loading && !selectedCommitDiff}
          diffError={localizeReviewError(sourceState.error)}
          onRefreshDiff={sourceState.refresh}
          onRefresh={refreshAll}
          refreshPending={reviewRefreshPending}
          expandedSet={expandedSet}
          onToggleDiff={togglePath}
          viewMode={diffViewMode}
          onViewModeChange={setDiffViewMode}
          onRichMarkdownPreviewChange={setRichMarkdownPreview}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={resolvedJumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={capabilities.canRichPreview && richMarkdownPreview}
          onOpenFile={openFileHandler}
        />
      ) : source === 'branch' ? (
        <BranchSourceView
          candidates={branchCandidates}
          selectedBaseRef={selectedBranchBaseRef}
          warning={currentBranchDiffData?.warning ?? null}
          diffs={sourceState.diffs}
          rawDiffCount={rawBranchDiffs.length}
          diffLoading={sourceState.loading && !currentBranchDiffData}
          diffError={localizeReviewError(sourceState.error)}
          onSelectBase={setBranchBaseRef}
          onRefreshDiff={sourceState.refresh}
          onRefresh={refreshAll}
          refreshPending={reviewRefreshPending}
          expandedSet={expandedSet}
          onToggleDiff={togglePath}
          viewMode={diffViewMode}
          onViewModeChange={setDiffViewMode}
          onRichMarkdownPreviewChange={setRichMarkdownPreview}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={resolvedJumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={capabilities.canRichPreview && richMarkdownPreview}
          onOpenFile={openFileHandler}
        />
      ) : source === 'staged' ? (
        <StagedSourceView
          diffs={staged}
          stagedCount={rawStaged.length}
          expandedSet={expandedSet}
          onToggleDiff={togglePath}
          onRefresh={refreshAll}
          refreshPending={reviewRefreshPending}
          canWrite={canWrite}
          pendingKey={pendingKey}
          actionDisabledTooltip={actionWriteDisabledTooltip}
          onFileAction={(diff) =>
            runStageOperation('unstage', [targetFromDiff(diff)], `unstage:file:${diff.id}`)
          }
          onHunkAction={(diff, hunkIndex) => runHunkOperation('unstage', diff, hunkIndex)}
          onSectionAction={() =>
            runStageOperation('unstage', staged.map(targetFromDiff), 'unstage:all')
          }
          viewMode={diffViewMode}
          onViewModeChange={setDiffViewMode}
          onRichMarkdownPreviewChange={setRichMarkdownPreview}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={resolvedJumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={capabilities.canRichPreview && richMarkdownPreview}
          onOpenFile={openFileHandler}
          hunkActionsEnabled={canUsePatchBasedReviewActions(hideWhitespace)}
        />
      ) : source === 'last-turn' && lastTurnHydrating ? (
        <CenteredState
          icon={<Spinner size={24} />}
          title={t('rightSidebar.review.loadingTitle')}
          desc={t('rightSidebar.review.loadingDesc')}
        />
      ) : source === 'last-turn' && lastTurnHydrationError ? (
        <CenteredState
          icon={<AlertTriangle size={24} />}
          title={t('rightSidebar.review.errorTitle')}
          desc={localizeReviewError(lastTurnHydrationError)}
          actionLabel={t('rightSidebar.review.refresh')}
          onAction={refreshAll}
        />
      ) : source === 'last-turn' && sourceState.rawDiffCount === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.lastTurnEmpty.title')}
          desc={t('rightSidebar.review.lastTurnEmpty.desc')}
          actionLabel={t('rightSidebar.review.lastTurnEmpty.action')}
          onAction={() => setSource('branch')}
        />
      ) : !hasAnyDiff ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.emptyTitle')}
          desc={t('rightSidebar.review.emptyDescGit')}
        />
      ) : visibleDiffs.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.filterEmptyTitle')}
          desc={t('rightSidebar.review.filterEmptyDesc')}
        />
      ) : (
        <DiffList
          diffs={visibleDiffs}
          expandedSet={expandedSet}
          onToggleDiff={togglePath}
          onRefresh={refreshAll}
          refreshPending={reviewRefreshPending}
          viewMode={diffViewMode}
          onViewModeChange={setDiffViewMode}
          onRichMarkdownPreviewChange={setRichMarkdownPreview}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={resolvedJumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={capabilities.canRichPreview && richMarkdownPreview}
          onOpenFile={openFileHandler}
          writeAction={
            source === 'last-turn'
              ? undefined
              : {
                  canWrite,
                  pendingKey,
                  disabledTooltip: actionWriteDisabledTooltip,
                  actionForDiff: (diff) => actionForReviewDiff(source, diff),
                  discardForDiff: (diff) => discardForReviewDiff(source, diff),
                  hunkActionsEnabled: canUsePatchBasedReviewActions(hideWhitespace),
                  sectionAction: source === 'unstaged' ? 'stage' : null,
                  sectionPendingKey: 'stage:all',
                  sectionDiscardVisible: source === 'unstaged',
                  sectionDiscardPendingKey: 'discard:all',
                  onFileAction: (diff) => {
                    const action = actionForReviewDiff(source, diff);
                    if (!action) return;
                    runStageOperation(action, [targetFromDiff(diff)], `${action}:file:${diff.id}`);
                  },
                  onFileDiscard: runDiscardFileOperation,
                  onHunkAction: (diff, hunkIndex) => {
                    const action = actionForReviewDiff(source, diff);
                    if (!action) return;
                    runHunkOperation(action, diff, hunkIndex);
                  },
                  onHunkDiscard: runDiscardHunkOperation,
                  onSectionAction:
                    source === 'unstaged'
                      ? () =>
                          runStageOperation('stage', visibleDiffs.map(targetFromDiff), 'stage:all')
                      : undefined,
                  onSectionDiscard:
                    source === 'unstaged'
                      ? () => runDiscardSectionOperation(visibleDiffs, 'discard:all')
                      : undefined,
                }
          }
        />
      )}
    </div>
  );
}

function AheadBehindPill({
  ahead,
  behind,
  upstream,
}: {
  ahead: number;
  behind: number;
  upstream: string;
}) {
  const { t } = useTranslation();
  const label = t('rightSidebar.review.aheadBehindTooltip', { ahead, behind, upstream });
  return (
    <Tip text={label}>
      <span
        className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 font-mono text-10 text-[var(--text-secondary)]"
        aria-label={label}
      >
        ↑{ahead} ↓{behind}
      </span>
    </Tip>
  );
}

interface PushControlProps {
  branch: string | null;
  ahead: number;
  behind: number;
  upstream: string | null;
  canWrite: boolean;
  writeDisabledText?: string;
  pending: boolean;
  onPush: () => void;
}

function getPushControlState({
  branch,
  ahead,
  behind,
  upstream,
  canWrite,
  writeDisabledText,
  pending,
  t,
}: Omit<PushControlProps, 'onPush'> & { t: ReturnType<typeof useTranslation>['t'] }) {
  const synced = Boolean(upstream) && ahead === 0 && behind === 0;
  // 纯落后(本地无新提交)时禁推:此时强推只会把远端回退,几乎必然是误操作。
  const strictlyBehind = Boolean(upstream) && ahead === 0 && behind > 0;
  const disabledReason = !branch
    ? t('rightSidebar.review.push.disabledNoBranch')
    : !canWrite && !pending
      ? (writeDisabledText ?? t('rightSidebar.review.push.disabledWriteGate'))
      : synced
        ? t('rightSidebar.review.push.synced')
        : strictlyBehind
          ? t('rightSidebar.review.push.disabledBehindOnly', { count: behind })
          : null;
  const tooltip =
    disabledReason ??
    (upstream
      ? behind > 0
        ? t('rightSidebar.review.push.readyForceCandidate', { count: behind })
        : t('rightSidebar.review.push.ready', { count: ahead })
      : t('rightSidebar.review.push.readyNoUpstream'));
  return {
    disabled: Boolean(disabledReason) || pending,
    disabledReason,
    tooltip,
  };
}

function CommitOrPushDropdown({
  branchLabel,
  totalAdd,
  totalDel,
  stagedCount,
  unstagedCount,
  canWrite,
  writeDisabledText,
  pending,
  push,
  iconOnly = false,
  platform,
  onCommit,
}: {
  branchLabel: string;
  totalAdd: number;
  totalDel: number;
  stagedCount: number;
  unstagedCount: number;
  canWrite: boolean;
  writeDisabledText: string;
  pending: boolean;
  push: PushControlProps;
  iconOnly?: boolean;
  platform: string;
  onCommit: (
    message: string,
    includeUnstaged: boolean,
    pushAfterCommit: boolean,
  ) => Promise<ReviewCommitRunResult>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const writeDisabledTooltip = writeDisabledText
    ? t('rightSidebar.review.topAction.disabledWriteGateWithReasons', {
        reasons: writeDisabledText,
      })
    : t('rightSidebar.review.topAction.disabledWriteGate');
  const triggerDisabled = (!canWrite && !pending) || pending;
  const triggerTooltip = !canWrite
    ? writeDisabledTooltip
    : t('rightSidebar.review.topAction.label');
  const commitDisabledReason = getReviewCommitActionDisabledReason({
    message,
    includeUnstaged,
    stagedCount,
    unstagedCount,
    canWrite,
  });
  const commitDisabledTooltip =
    commitDisabledReason === 'no-message'
      ? t('rightSidebar.review.commit.disabledNoMessage')
      : commitDisabledReason === 'write-disabled'
        ? writeDisabledTooltip
        : commitDisabledReason === 'no-changes'
          ? t('rightSidebar.review.commit.disabledNoChanges')
          : commitDisabledReason === 'no-staged'
            ? t('rightSidebar.review.commit.disabledNoStaged')
            : undefined;
  const commitDisabled = pending || Boolean(commitDisabledReason);
  const pushState = getPushControlState({ ...push, t });
  const shortcut = platform === 'darwin' ? '⌘↩' : 'Ctrl↩';
  const runCommit = useCallback(
    (pushAfterCommit: boolean) => {
      if (commitDisabled) return;
      void onCommit(message, includeUnstaged, pushAfterCommit).then((result) => {
        const effect = getReviewCommitDropdownCompletionEffect(result);
        if (effect.clearMessage) setMessage('');
        if (effect.closeDropdown) setOpen(false);
      });
    },
    [commitDisabled, includeUnstaged, message, onCommit],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const shortcutPressed =
        platform === 'darwin'
          ? event.metaKey && event.key === 'Enter'
          : event.ctrlKey && event.key === 'Enter';
      if (!shortcutPressed) return;
      event.preventDefault();
      runCommit(false);
    },
    [platform, runCommit],
  );
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (triggerDisabled) {
          setOpen(false);
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Tip text={triggerTooltip}>
          <button
            type="button"
            aria-disabled={triggerDisabled}
            aria-label={t('rightSidebar.review.topAction.label')}
            onClick={() => {
              if (!triggerDisabled) setOpen(true);
            }}
            className={cn(
              'inline-flex h-6 shrink-0 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-10 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
              iconOnly ? 'w-6 justify-center px-0' : 'gap-1 px-2.5',
              triggerDisabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {pending ? <Spinner size={12} /> : <Check size={12} />}
            <span className={cn(iconOnly && 'sr-only')}>
              {t('rightSidebar.review.topAction.label')}
            </span>
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        collisionPadding={8}
        onKeyDown={handleKeyDown}
        className="w-[min(22rem,calc(100vw-24px))] rounded-[10px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2 shadow-[var(--shadow-menu)]"
      >
        <div className="flex min-w-0 items-center gap-2 rounded-[8px] bg-[var(--surface-chip)] px-2.5 py-2 text-12">
          <GitBranch size={13} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
            {branchLabel}
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono text-11 tabular-nums">
            <span className="text-[var(--diff-add-fg)]">+{totalAdd}</span>{' '}
            <span className="text-[var(--diff-del-fg)]">-{totalDel}</span>
          </span>
        </div>
        <div className="mt-2">
          <textarea
            ref={inputRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              handleKeyDown(event);
            }}
            rows={4}
            placeholder={t('rightSidebar.review.commit.placeholder')}
            className="min-h-[92px] w-full resize-none rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-12 leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          />
        </div>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setIncludeUnstaged((current) => !current);
          }}
          className="mt-1 flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]">
            {includeUnstaged && <Check size={10} />}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {t('rightSidebar.review.commit.includeUnstaged')}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 bg-[var(--border-default)]" />
        <CommitDropdownAction
          label={t('rightSidebar.review.commit.submit')}
          icon={pending && !push.pending ? <Spinner size={12} /> : <Check size={12} />}
          disabled={commitDisabled}
          disabledTooltip={commitDisabledTooltip}
          shortcut={shortcut}
          onSelect={() => runCommit(false)}
        />
        <CommitDropdownAction
          label={t('rightSidebar.review.commit.submitAndPush')}
          icon={pending && push.pending ? <Spinner size={12} /> : <Upload size={12} />}
          disabled={commitDisabled}
          disabledTooltip={commitDisabledTooltip}
          onSelect={() => runCommit(true)}
        />
        <CommitDropdownAction
          label={t('rightSidebar.review.push.submit')}
          icon={push.pending ? <Spinner size={12} /> : <Upload size={12} />}
          disabled={pushState.disabled}
          disabledTooltip={pushState.tooltip}
          onSelect={() => {
            if (pushState.disabled) return;
            push.onPush();
            setOpen(false);
          }}
        >
          {push.ahead > 0 && (
            <span className="rounded-full bg-[var(--surface-chip)] px-1 font-mono text-10 text-[var(--text-secondary)]">
              ↑{push.ahead}
            </span>
          )}
        </CommitDropdownAction>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommitDropdownAction({
  label,
  icon,
  disabled,
  disabledTooltip,
  shortcut,
  onSelect,
  children,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  disabledTooltip?: string;
  shortcut?: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const item = (
    <DropdownMenuItem
      aria-disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
      {shortcut && (
        <span className="shrink-0 rounded bg-[var(--surface-chip)] px-1 py-0.5 font-mono text-10 text-[var(--text-tertiary)]">
          {shortcut}
        </span>
      )}
    </DropdownMenuItem>
  );
  if (!disabledTooltip) return item;
  return (
    <Tip text={disabledTooltip}>
      <span className="block">{item}</span>
    </Tip>
  );
}

function FileJumpPopover({
  diffs,
  onSelectFile,
}: {
  diffs: FileDiff[];
  onSelectFile: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const disabled = diffs.length === 0;
  const { results, overflowCount } = useMemo(
    () => filterReviewFileJumpResults(diffs, query),
    [diffs, query],
  );

  useEffect(() => {
    setSelectedIndex(results.length > 0 ? 0 : -1);
  }, [query, results.length]);

  const close = useCallback(() => setOpen(false), []);
  const selectResult = useCallback(
    (result: ReviewFileJumpResult | null | undefined) => {
      if (!result) return;
      onSelectFile(result.diff);
      close();
    },
    [close, onSelectFile],
  );
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled) {
        setOpen(false);
        return;
      }
      if (nextOpen) {
        setQuery('');
        setSelectedIndex(diffs.length > 0 ? 0 : -1);
      }
      setOpen(nextOpen);
    },
    [diffs.length, disabled],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((current) => moveReviewFileJumpSelection(current, 1, results.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((current) => moveReviewFileJumpSelection(current, -1, results.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectResult(results[selectedIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [close, results, selectResult, selectedIndex],
  );

  return (
    <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Tip
          text={
            disabled
              ? t('rightSidebar.review.fileJump.disabled')
              : t('rightSidebar.review.fileJump.tooltip')
          }
        >
          <button
            type="button"
            disabled={disabled}
            aria-label={t('rightSidebar.review.fileJump.tooltip')}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              open && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <FileSearch size={13} />
          </button>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="w-[280px] rounded-[12px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2 shadow-[var(--shadow-menu)]"
      >
        <div onKeyDown={handleKeyDown}>
          <label className="relative block">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('rightSidebar.review.fileJump.placeholder')}
              aria-label={t('rightSidebar.review.fileJump.placeholder')}
              className="h-7 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] pl-7 pr-2 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
          </label>
          <div
            role="listbox"
            aria-label={t('rightSidebar.review.fileJump.tooltip')}
            className="mt-2 max-h-[280px] overflow-y-auto"
          >
            {results.length === 0 ? (
              <div className="px-2 py-4 text-11 text-[var(--text-tertiary)]">
                {t('rightSidebar.review.fileJump.empty')}
              </div>
            ) : (
              results.map((result, index) => (
                <button
                  key={result.diff.id}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => selectResult(result)}
                  className={cn(
                    'flex h-9 w-full min-w-0 flex-col justify-center rounded-[8px] px-2 text-left hover:bg-[var(--cmd-palette-item-hover)]',
                    index === selectedIndex && 'bg-[var(--cmd-palette-item-hover)]',
                  )}
                >
                  <span className="truncate text-12 font-medium text-[var(--text-primary)]">
                    {result.fileName}
                  </span>
                  {result.directory && (
                    <span className="truncate text-10 text-[var(--text-tertiary)]">
                      {result.directory}
                    </span>
                  )}
                </button>
              ))
            )}
            {overflowCount > 0 && (
              <div className="px-2 py-1.5 text-10 text-[var(--text-tertiary)]">
                {t('rightSidebar.review.fileJump.more', { count: overflowCount })}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DiffExpansionToggleButton({
  action,
  onToggle,
}: {
  action: 'expand' | 'collapse' | 'disabled';
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const disabled = action === 'disabled';
  const label = disabled
    ? t('rightSidebar.review.diffExpansion.disabled')
    : action === 'collapse'
      ? t('rightSidebar.review.diffExpansion.collapse')
      : t('rightSidebar.review.diffExpansion.expand');
  return (
    <Tip text={label}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {action === 'collapse' ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
      </button>
    </Tip>
  );
}

function FileTreeToggleButton({
  preferenceVisible,
  temporarilyHidden,
  onToggle,
}: {
  preferenceVisible: boolean;
  temporarilyHidden: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label =
    preferenceVisible && temporarilyHidden
      ? t('rightSidebar.review.fileTree.temporarilyHidden')
      : preferenceVisible
        ? t('rightSidebar.review.fileTree.hide')
        : t('rightSidebar.review.fileTree.show');
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-pressed={preferenceVisible}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
          preferenceVisible && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
        )}
      >
        {preferenceVisible ? <FolderOpen size={13} /> : <Folder size={13} />}
      </button>
    </Tip>
  );
}

interface DiffExpansionOverflowProps {
  action: 'expand' | 'collapse' | 'disabled';
  onToggle: () => void;
}

interface FileTreeOverflowProps {
  preferenceVisible: boolean;
  temporarilyHidden: boolean;
  onToggle: () => void;
}

export function ReviewMoreMenu({
  wordWrap,
  wordDiff,
  hideWhitespace,
  diffExpansionOverflow,
  fileTreeOverflow,
  canCopyGitApply,
  copyGitApplyDisabledTooltip,
  onWordWrapChange,
  onWordDiffChange,
  onHideWhitespaceChange,
  onCopyGitApply,
}: {
  wordWrap: boolean;
  wordDiff: boolean;
  hideWhitespace: boolean;
  diffExpansionOverflow: DiffExpansionOverflowProps | null;
  fileTreeOverflow: FileTreeOverflowProps | null;
  canCopyGitApply: boolean;
  copyGitApplyDisabledTooltip?: string;
  onWordWrapChange: (wordWrap: boolean) => void;
  onWordDiffChange: (wordDiff: boolean) => void;
  onHideWhitespaceChange: (hideWhitespace: boolean) => void;
  onCopyGitApply: () => void;
}) {
  const { t } = useTranslation();
  const overflowItems = [
    diffExpansionOverflow ? 'diffExpansion' : null,
    fileTreeOverflow ? 'fileTree' : null,
  ].filter(Boolean);
  const copyItem = (
    <DropdownMenuItem
      aria-disabled={!canCopyGitApply}
      onSelect={(event) => {
        if (!canCopyGitApply) {
          event.preventDefault();
          return;
        }
        onCopyGitApply();
      }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]',
        !canCopyGitApply && 'cursor-not-allowed opacity-50',
      )}
    >
      <Clipboard size={12} className="text-[var(--text-secondary)]" />
      <span>{t('rightSidebar.review.moreMenu.copyGitApply')}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip text={t('rightSidebar.review.moreMenu.aria')}>
          <button
            type="button"
            aria-label={t('rightSidebar.review.moreMenu.aria')}
            className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <MoreHorizontal size={13} />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-[13rem] rounded-[8px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
      >
        {overflowItems.length > 0 && (
          <>
            {diffExpansionOverflow && (
              <DiffExpansionMenuItem
                action={diffExpansionOverflow.action}
                onToggle={diffExpansionOverflow.onToggle}
              />
            )}
            {fileTreeOverflow && (
              <FileTreeMenuItem
                preferenceVisible={fileTreeOverflow.preferenceVisible}
                temporarilyHidden={fileTreeOverflow.temporarilyHidden}
                onToggle={fileTreeOverflow.onToggle}
              />
            )}
            <DropdownMenuSeparator className="my-1 bg-[var(--border-default)]" />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => onWordWrapChange(!wordWrap)}
          className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
        >
          {wordWrap ? (
            <WrapText size={12} className="text-[var(--text-secondary)]" />
          ) : (
            <ArrowRight size={12} className="text-[var(--text-secondary)]" />
          )}
          <span>
            {t(
              wordWrap
                ? 'rightSidebar.review.moreMenu.wordWrapDisable'
                : 'rightSidebar.review.moreMenu.wordWrapEnable',
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onWordDiffChange(!wordDiff)}
          className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
        >
          {wordDiff ? (
            <Diff size={12} className="text-[var(--text-secondary)]" />
          ) : (
            <SquareSplitHorizontal size={12} className="text-[var(--text-secondary)]" />
          )}
          <span>
            {t(
              wordDiff
                ? 'rightSidebar.review.moreMenu.wordDiffDisable'
                : 'rightSidebar.review.moreMenu.wordDiffEnable',
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onHideWhitespaceChange(!hideWhitespace)}
          className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
        >
          {hideWhitespace ? (
            <EyeOff size={12} className="text-[var(--text-secondary)]" />
          ) : (
            <Eye size={12} className="text-[var(--text-secondary)]" />
          )}
          <span>
            {t(
              hideWhitespace
                ? 'rightSidebar.review.moreMenu.showWhitespace'
                : 'rightSidebar.review.moreMenu.hideWhitespace',
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 bg-[var(--border-default)]" />
        {canCopyGitApply || !copyGitApplyDisabledTooltip ? (
          copyItem
        ) : (
          <Tip text={copyGitApplyDisabledTooltip}>
            <span className="block">{copyItem}</span>
          </Tip>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DiffExpansionMenuItem({ action, onToggle }: DiffExpansionOverflowProps) {
  const { t } = useTranslation();
  const disabled = action === 'disabled';
  const label = disabled
    ? t('rightSidebar.review.diffExpansion.disabled')
    : action === 'collapse'
      ? t('rightSidebar.review.diffExpansion.collapse')
      : t('rightSidebar.review.diffExpansion.expand');
  const item = (
    <DropdownMenuItem
      aria-disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onToggle();
      }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {action === 'collapse' ? (
        <UnfoldVertical size={12} className="text-[var(--text-secondary)]" />
      ) : (
        <FoldVertical size={12} className="text-[var(--text-secondary)]" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </DropdownMenuItem>
  );
  return disabled ? (
    <Tip text={label}>
      <span className="block">{item}</span>
    </Tip>
  ) : (
    item
  );
}

function FileTreeMenuItem({
  preferenceVisible,
  temporarilyHidden,
  onToggle,
}: FileTreeOverflowProps) {
  const { t } = useTranslation();
  const label =
    preferenceVisible && temporarilyHidden
      ? t('rightSidebar.review.fileTree.temporarilyHidden')
      : preferenceVisible
        ? t('rightSidebar.review.fileTree.hide')
        : t('rightSidebar.review.fileTree.show');
  return (
    <DropdownMenuItem
      onSelect={onToggle}
      className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
    >
      {preferenceVisible ? (
        <FolderOpen size={12} className="text-[var(--text-secondary)]" />
      ) : (
        <Folder size={12} className="text-[var(--text-secondary)]" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </DropdownMenuItem>
  );
}

export function SourceDropdown({
  source,
  messageSnapshotAvailable = false,
  counts,
  commits,
  commitsLoading,
  commitsError,
  commitsLoaded,
  selectedCommitOid,
  layout = 'wide',
  disabledReason,
  onChange,
  onSelectMessageSnapshot,
  onSelectCommit,
  onRefreshCommits,
}: {
  /** `'turn'` is the selected label for a persisted turn-set descriptor. */
  source: ReviewSource | 'turn';
  /** Whether the exact message snapshot remains available after selecting a Git source. */
  messageSnapshotAvailable?: boolean;
  counts: { unstaged?: number; staged?: number; branch?: number; lastTurn?: number };
  commits?: ReviewCommit[];
  commitsLoading?: boolean;
  commitsError?: string | null;
  commitsLoaded?: boolean;
  selectedCommitOid?: string | null;
  layout?: ReviewToolbarLayout;
  disabledReason?: string;
  onChange: (source: ReviewSource) => void;
  onSelectMessageSnapshot?: () => void;
  onSelectCommit?: (oid: string) => void;
  onRefreshCommits?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 消息快照独立于当前来源保存；切到 Git 来源后仍可精确返回原消息的变更。
  const turnOption: SourceDropdownOption | null =
    source === 'turn' || messageSnapshotAvailable
      ? { source: 'turn', label: t('rightSidebar.review.turn.title') }
      : null;
  const options: SourceDropdownOption[] = [
    { source: 'unstaged', label: t('rightSidebar.review.source.unstaged'), count: counts.unstaged },
    { source: 'staged', label: t('rightSidebar.review.source.staged'), count: counts.staged },
    { source: 'commit', label: t('rightSidebar.review.source.commit') },
    { source: 'branch', label: t('rightSidebar.review.source.branch') },
    { source: 'last-turn', label: t('rightSidebar.review.source.lastTurn') },
  ];
  const directOptions = options.filter((option) => option.source !== 'commit');
  const selected =
    source === 'turn' && turnOption
      ? turnOption
      : (options.find((option) => option.source === source) ?? options[0]);
  const commitList = commits ?? [];
  const commitMenuLoaded = commitsLoaded ?? false;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => setOpen(disabledReason ? false : nextOpen)}
    >
      <DropdownMenuTrigger asChild>
        <Tip text={disabledReason ?? t('rightSidebar.review.sourceDropdownAria')}>
          <button
            type="button"
            aria-disabled={Boolean(disabledReason)}
            aria-label={t('rightSidebar.review.sourceDropdownAria')}
            className={cn(
              'flex h-7 shrink-0 items-center justify-between rounded-full border border-transparent bg-transparent px-1.5 text-left text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
              layout === 'wide' ? 'max-w-[11rem]' : 'max-w-[10rem]',
              disabledReason && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            <span className="truncate">{selected.label}</span>
            <SourceCountBadge count={selected.count} />
            <ChevronDown
              size={13}
              className={cn(
                'shrink-0 text-[var(--text-tertiary)]',
                layout === 'minimal' ? 'ml-1' : 'ml-2',
              )}
            />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[12rem] rounded-[8px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
      >
        {turnOption && (
          <SourceDropdownItem
            option={turnOption}
            active={source === 'turn'}
            onChange={onChange}
            onSelectMessageSnapshot={onSelectMessageSnapshot}
          />
        )}
        {directOptions.slice(0, 2).map((option) => (
          <SourceDropdownItem
            key={option.source}
            option={option}
            active={option.source === source}
            onChange={onChange}
          />
        ))}
        <DropdownMenuSub
          onOpenChange={(open) => {
            if (open) onRefreshCommits?.();
          }}
        >
          <DropdownMenuSubTrigger className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)] data-[state=open]:bg-[var(--cmd-palette-item-hover)]">
            <span className="min-w-0 flex-1 truncate">
              {t('rightSidebar.review.source.commit')}
            </span>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
              {source === 'commit' && <Check size={12} />}
            </span>
            <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={6}
            collisionPadding={8}
            className="max-h-80 w-[min(20rem,calc(100vw-24px))] overflow-y-auto rounded-[8px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
          >
            {commitsError ? (
              <>
                <DropdownMenuItem
                  disabled
                  className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-secondary)]"
                >
                  <AlertTriangle size={12} />
                  <span>{t('rightSidebar.review.commitMenu.error')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onRefreshCommits?.();
                  }}
                  className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <Spinner
                    icon={RefreshCw}
                    size={12}
                    spinning={commitsLoading}
                    className="text-[var(--text-secondary)]"
                  />
                  <span>{t('rightSidebar.review.commitMenu.retry')}</span>
                </DropdownMenuItem>
              </>
            ) : !commitMenuLoaded || (commitsLoading && commitList.length === 0) ? (
              <DropdownMenuItem
                disabled
                className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-secondary)]"
              >
                <Spinner icon={RefreshCw} size={12} />
                <span>{t('rightSidebar.review.commitMenu.loading')}</span>
              </DropdownMenuItem>
            ) : commitList.length === 0 ? (
              <DropdownMenuItem
                disabled
                className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-secondary)]"
              >
                <FileDiffIcon size={12} />
                <span>{t('rightSidebar.review.commitMenu.empty')}</span>
              </DropdownMenuItem>
            ) : (
              commitList.map((commit) => {
                const title = commit.title || t('rightSidebar.review.untitledCommit');
                const active = commit.oid === selectedCommitOid;
                return (
                  <Tip key={commit.oid} text={title} side="left">
                    <DropdownMenuItem
                      onSelect={() => onSelectCommit?.(commit.oid)}
                      className={cn(
                        'flex h-8 min-w-0 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]',
                        active && 'bg-[var(--surface-chip)]',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                        {t('rightSidebar.review.commitMenu.relativeTime', {
                          time: formatSidebarTime(
                            new Date(commit.authorTime * 1000).toISOString(),
                            t,
                          ),
                        })}
                      </span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
                        {active && <Check size={12} />}
                      </span>
                    </DropdownMenuItem>
                  </Tip>
                );
              })
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {directOptions.slice(2).map((option) => (
          <SourceDropdownItem
            key={option.source}
            option={option}
            active={option.source === source}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SourceDropdownOption {
  source: ReviewSource | 'turn';
  label: string;
  count?: number;
}

function SourceCountBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null;
  return (
    <span className="ml-1 shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-xs font-medium leading-none text-[var(--text-secondary)]">
      {count}
    </span>
  );
}

function SourceDropdownItem({
  option,
  active,
  onChange,
  onSelectMessageSnapshot,
}: {
  option: SourceDropdownOption;
  active: boolean;
  onChange: (source: ReviewSource) => void;
  onSelectMessageSnapshot?: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        if (option.source === 'turn') {
          if (!active) onSelectMessageSnapshot?.();
          return;
        }
        onChange(option.source);
      }}
      className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
    >
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <SourceCountBadge count={option.count} />
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {active && <Check size={12} />}
      </span>
    </DropdownMenuItem>
  );
}

function targetFromDiff(diff: FileDiff): ReviewFileTarget {
  return {
    path: diff.path,
    oldPath: diff.oldPath,
    source: diff.source === 'staged' ? 'staged' : 'unstaged',
  };
}

export function partialAllowed(diff: FileDiff): boolean {
  return (
    diff.kind === 'text' &&
    !diff.isBinary &&
    !diff.isSubmodule &&
    diff.status !== 'renamed' &&
    diff.status !== 'copied' &&
    diff.status !== 'deleted' &&
    diff.status !== 'typechange' &&
    !isTypechangeModeChange(diff)
  );
}

function isRenameLikeDiff(diff: FileDiff): boolean {
  return diff.status === 'renamed' || diff.status === 'copied';
}

function isTypechangeLikeDiff(diff: FileDiff): boolean {
  return diff.status === 'typechange' || isTypechangeModeChange(diff);
}

function isTypechangeModeChange(diff: FileDiff): boolean {
  return Boolean(
    diff.mode.old &&
    diff.mode.new &&
    diff.mode.old !== '000000' &&
    diff.mode.new !== '000000' &&
    diff.mode.old !== diff.mode.new,
  );
}

function actionLabel(action: ReviewToggleAction, t: (key: string) => string): string {
  return action === 'stage'
    ? t('rightSidebar.review.actions.stage')
    : t('rightSidebar.review.actions.unstage');
}

function hunkActionLabel(action: ReviewToggleAction, t: (key: string) => string): string {
  return action === 'stage'
    ? t('rightSidebar.review.actions.stageHunk')
    : t('rightSidebar.review.actions.unstageHunk');
}

function allActionLabel(action: ReviewToggleAction, t: (key: string) => string): string {
  return action === 'stage'
    ? t('rightSidebar.review.actions.stageAll')
    : t('rightSidebar.review.actions.unstageAll');
}

export function actionForReviewDiff(
  source: ReviewSource,
  diff: Pick<FileDiff, 'source'>,
): ReviewToggleAction | null {
  void diff;
  if (source === 'unstaged') return 'stage';
  if (source === 'staged') return 'unstage';
  return null;
}

export function discardForReviewDiff(
  source: ReviewSource,
  diff: Pick<FileDiff, 'source'>,
): boolean {
  if (source === 'unstaged') return diff.source === 'unstaged';
  return false;
}

export function lastTurnStageableTargets(diffs: readonly FileDiff[]): ReviewFileTarget[] {
  void diffs;
  return [];
}

export function lastTurnDiscardableDiffs(diffs: readonly FileDiff[]): FileDiff[] {
  void diffs;
  return [];
}

function OperationNotice({
  error,
  summary,
}: {
  error: string | null;
  summary: ReviewStageOperationSummary | null;
}) {
  const { t } = useTranslation();
  const failed = summary?.failed ?? [];
  const errorLines = error ? error.split(/\r?\n/) : [];
  const errorTitle = errorLines[0] ?? null;
  const errorDetails = errorLines.slice(1).join('\n').trim();
  if (!error && failed.length === 0) return null;
  return (
    <div className="mt-2 rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-2.5 py-2 text-11 leading-relaxed text-[var(--error-fg)]">
      {errorTitle ??
        t('rightSidebar.review.actions.partialFailure', {
          succeeded: summary?.succeeded.length ?? 0,
          failed: failed.length,
        })}
      {errorDetails && (
        <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-10 text-[var(--error-fg-strong)]">
          {errorDetails}
        </div>
      )}
      {failed.length > 0 && (
        <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-10 text-[var(--error-fg-strong)]">
          {failed[0].path}: {failed[0].stderr || failed[0].error}
        </div>
      )}
    </div>
  );
}

export interface WriteActionProps {
  canWrite: boolean;
  pendingKey: string | null;
  disabledTooltip?: string;
  actionForDiff: (diff: FileDiff) => ReviewToggleAction | null;
  discardForDiff?: (diff: FileDiff) => boolean;
  hunkActionsEnabled?: boolean;
  sectionAction: ReviewToggleAction | null;
  sectionPendingKey: string;
  sectionDiscardVisible?: boolean;
  sectionDiscardPendingKey?: string;
  onFileAction: (diff: FileDiff) => void;
  onFileDiscard?: (diff: FileDiff) => void;
  onHunkAction: (diff: FileDiff, hunkIndex: number) => void;
  onHunkDiscard?: (diff: FileDiff, hunkIndex: number) => void;
  onSectionAction?: () => void;
  onSectionDiscard?: () => void;
}

function DiffList({
  diffs,
  expandedSet,
  onToggleDiff,
  onRefresh,
  refreshPending,
  branchBaseControl,
  topNotice,
  viewMode,
  onViewModeChange,
  onRichMarkdownPreviewChange,
  wordWrap,
  wordDiff,
  fileTreeVisible,
  jumpRequest,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  richMarkdownPreviewDisabledReason,
  onOpenFile,
  writeAction,
}: {
  diffs: FileDiff[];
  expandedSet: Set<string>;
  onToggleDiff: (id: string) => void;
  onRefresh: () => void;
  refreshPending: boolean;
  branchBaseControl?: ReactNode;
  topNotice?: ReactNode;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
  wordWrap: boolean;
  wordDiff: boolean;
  fileTreeVisible: boolean;
  jumpRequest: ReviewFileJumpRequest | null;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  richMarkdownPreviewDisabledReason?: string;
  onOpenFile?: (diff: FileDiff) => void;
  writeAction?: WriteActionProps;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const programmaticScrollSuppressedRef = useRef(false);
  const programmaticScrollTargetRef = useRef<string | null>(null);
  const preciseScrollRafRef = useRef<number | null>(null);
  const consumedJumpNonceRef = useRef<number | null>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [activeFileId, setActiveFileId] = useState<string | null>(diffs[0]?.id ?? null);
  const allPending = writeAction ? writeAction.pendingKey === writeAction.sectionPendingKey : false;
  const discardAllPending = writeAction?.sectionDiscardPendingKey
    ? writeAction.pendingKey === writeAction.sectionDiscardPendingKey
    : false;
  const hasBatchActions = Boolean(
    (writeAction?.sectionAction && writeAction.onSectionAction) ||
    (writeAction?.sectionDiscardVisible && writeAction.onSectionDiscard),
  );
  const virtualized = shouldVirtualizeFileList(diffs.length);
  const fileVirtualizer = useVirtualizer({
    count: diffs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (expandedSet.has(diffs[index]?.id) ? 360 : 45),
    overscan: 8,
    getItemKey: (index) => diffs[index]?.id ?? index,
  });
  const fileTreeVisibility = getReviewFileTreeVisibility({
    userVisible: fileTreeVisible,
    containerWidth: contentWidth,
    fileCount: diffs.length,
  });
  const showFileTree = fileTreeVisibility.effectiveVisible;
  const batchActionLayout = getBatchActionLayout(contentWidth);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setContentWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (activeFileId && diffs.some((diff) => diff.id === activeFileId)) return;
    setActiveFileId(diffs[0]?.id ?? null);
  }, [activeFileId, diffs]);

  const endProgrammaticScrollSuppression = useCallback(() => {
    programmaticScrollSuppressedRef.current = false;
    programmaticScrollTargetRef.current = null;
    if (preciseScrollRafRef.current !== null) {
      cancelAnimationFrame(preciseScrollRafRef.current);
      preciseScrollRafRef.current = null;
    }
  }, []);

  const beginProgrammaticScrollSuppression = useCallback(
    (targetId: string) => {
      endProgrammaticScrollSuppression();
      programmaticScrollSuppressedRef.current = true;
      programmaticScrollTargetRef.current = targetId;
    },
    [endProgrammaticScrollSuppression],
  );

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      endProgrammaticScrollSuppression();
    },
    [endProgrammaticScrollSuppression],
  );

  useEffect(() => {
    const targetId = programmaticScrollTargetRef.current;
    if (targetId && !diffs.some((diff) => diff.id === targetId)) {
      endProgrammaticScrollSuppression();
    }
  }, [diffs, endProgrammaticScrollSuppression]);

  const syncActiveFileFromScroll = useCallback(() => {
    const scroller = parentRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-review-file-id]'));
    const current = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 8 && rect.top < scrollerRect.bottom;
    });
    const id = current?.dataset.reviewFileId ?? null;
    const pinnedTargetId = programmaticScrollTargetRef.current;
    const suppressed = programmaticScrollSuppressedRef.current;
    if (pinnedTargetId && id === pinnedTargetId) {
      endProgrammaticScrollSuppression();
    }
    setActiveFileId(
      (currentId) =>
        nextReviewFileTreeActiveIdFromScroll({
          currentActiveFileId: currentId,
          candidateId: id,
          suppressed,
          pinnedTargetId,
        }).activeFileId,
    );
  }, [endProgrammaticScrollSuppression]);

  const scheduleActiveFileSync = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      syncActiveFileFromScroll();
    });
  }, [syncActiveFileFromScroll]);

  const schedulePreciseScrollToFile = useCallback(
    (targetId: string, attemptsLeft = 16) => {
      if (preciseScrollRafRef.current !== null) {
        cancelAnimationFrame(preciseScrollRafRef.current);
      }
      preciseScrollRafRef.current = requestAnimationFrame(() => {
        preciseScrollRafRef.current = null;
        const targetStillPinned = programmaticScrollTargetRef.current === targetId;
        const row = findFileRowElement(parentRef.current, targetId);
        const step = nextReviewFileJumpPreciseScrollStep({
          targetStillPinned,
          rowMounted: Boolean(row),
          attemptsLeft,
        });
        if (step.action === 'scroll' && row) {
          scrollElementIntoContainerView(parentRef.current, row, 'start');
          scheduleActiveFileSync();
          return;
        }
        if (step.action === 'retry') {
          schedulePreciseScrollToFile(targetId, step.nextAttemptsLeft);
        }
      });
    },
    [scheduleActiveFileSync],
  );

  const handleUserScrollIntent = useCallback(() => {
    if (programmaticScrollTargetRef.current || programmaticScrollSuppressedRef.current) {
      endProgrammaticScrollSuppression();
    }
  }, [endProgrammaticScrollSuppression]);

  const handleUserScrollKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isReviewFileTreeScrollKey(event.key)) {
        handleUserScrollIntent();
      }
    },
    [handleUserScrollIntent],
  );

  const scrollToFile = useCallback(
    (diff: FileDiff) => {
      setActiveFileId(diff.id);
      const index = diffs.findIndex((item) => item.id === diff.id);
      if (index < 0) return;
      beginProgrammaticScrollSuppression(diff.id);
      if (!expandedSet.has(diff.id)) onToggleDiff(diff.id);
      if (virtualized) {
        fileVirtualizer.scrollToIndex(index, { align: 'start' });
      }
      schedulePreciseScrollToFile(diff.id);
    },
    [
      beginProgrammaticScrollSuppression,
      diffs,
      expandedSet,
      fileVirtualizer,
      onToggleDiff,
      schedulePreciseScrollToFile,
      virtualized,
    ],
  );

  useEffect(() => {
    if (!jumpRequest || consumedJumpNonceRef.current === jumpRequest.nonce) return;
    consumedJumpNonceRef.current = jumpRequest.nonce;
    const diff = diffs.find((item) => item.id === jumpRequest.id);
    if (diff) scrollToFile(diff);
  }, [diffs, jumpRequest, scrollToFile]);

  const handleImagePreviewLoad = useCallback(() => {
    requestAnimationFrame(() => fileVirtualizer.measure());
  }, [fileVirtualizer]);

  const renderFileRow = (diff: FileDiff) => (
    <FileRow
      key={diff.id}
      diff={diff}
      expanded={expandedSet.has(diff.id)}
      onToggle={() => {
        setActiveFileId(diff.id);
        onToggleDiff(diff.id);
      }}
      writeAction={writeAction}
      viewMode={viewMode}
      wordWrap={wordWrap}
      wordDiff={wordDiff}
      loadImagePreview={loadImagePreview}
      loadMarkdownPreview={loadMarkdownPreview}
      richMarkdownPreview={richMarkdownPreview}
      onImagePreviewLoad={handleImagePreviewLoad}
      onOpenFile={onOpenFile}
    />
  );
  return (
    <>
      <ReviewDiffListHeader
        fileCount={diffs.length}
        branchBaseControl={branchBaseControl}
        refreshPending={refreshPending}
        onRefresh={onRefresh}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        richMarkdownPreview={richMarkdownPreview}
        richMarkdownPreviewDisabledReason={richMarkdownPreviewDisabledReason}
        onRichMarkdownPreviewChange={onRichMarkdownPreviewChange}
      />
      {topNotice && (
        <div className="shrink-0 border-b border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-3 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
          {topNotice}
        </div>
      )}
      <div ref={contentRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0">
          <div className="relative min-h-0 min-w-0 flex-1">
            {virtualized ? (
              <div
                ref={parentRef}
                role="list"
                data-virtualized-file-list="true"
                onScroll={scheduleActiveFileSync}
                onWheel={handleUserScrollIntent}
                onTouchStart={handleUserScrollIntent}
                onPointerDownCapture={handleUserScrollIntent}
                onKeyDownCapture={handleUserScrollKeyDown}
                className={cn('h-full min-h-0 min-w-0 overflow-y-auto', hasBatchActions && 'pb-14')}
              >
                <div className="relative w-full" style={{ height: fileVirtualizer.getTotalSize() }}>
                  {fileVirtualizer.getVirtualItems().map((item) => {
                    const diff = diffs[item.index];
                    if (!diff) return null;
                    return (
                      <div
                        key={item.key}
                        data-index={item.index}
                        ref={fileVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full"
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        {renderFileRow(diff)}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div
                ref={parentRef}
                role="list"
                onScroll={scheduleActiveFileSync}
                onWheel={handleUserScrollIntent}
                onTouchStart={handleUserScrollIntent}
                onPointerDownCapture={handleUserScrollIntent}
                onKeyDownCapture={handleUserScrollKeyDown}
                className={cn(
                  'flex h-full min-h-0 min-w-0 flex-col overflow-y-auto',
                  hasBatchActions && 'pb-14',
                )}
              >
                {diffs.map(renderFileRow)}
              </div>
            )}
            {writeAction && hasBatchActions && (
              <BatchActionPill
                writeAction={writeAction}
                allPending={allPending}
                discardAllPending={discardAllPending}
                layout={batchActionLayout}
              />
            )}
          </div>
          {showFileTree && (
            <ReviewFileTreeSidebar
              diffs={diffs}
              activeFileId={activeFileId}
              onSelectFile={scrollToFile}
            />
          )}
        </div>
      </div>
    </>
  );
}

function findFileRowElement(container: HTMLElement | null, id: string): HTMLElement | null {
  if (!container) return null;
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-review-file-id]'));
  return rows.find((row) => row.dataset.reviewFileId === id) ?? null;
}

function findFileTreeRowElement(container: HTMLElement | null, id: string): HTMLElement | null {
  if (!container) return null;
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-review-file-tree-node-id]'),
  );
  return rows.find((row) => row.dataset.reviewFileTreeNodeId === id) ?? null;
}

export function revealReviewFileTreeActiveNode({
  activeFileId,
  flatNodes,
  virtualized,
  treeVirtualizer,
  listEl,
}: {
  activeFileId: string | null;
  flatNodes: readonly ReviewFileTreeFlatNode[];
  virtualized: boolean;
  treeVirtualizer: { scrollToIndex: (index: number, options: { align: 'auto' }) => void };
  listEl: HTMLElement | null;
}): void {
  if (!activeFileId) return;
  const activeIndex = findReviewFileTreeFileIndex(flatNodes, activeFileId);
  if (activeIndex < 0) return;
  if (virtualized) {
    treeVirtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    return;
  }
  requestAnimationFrame(() => {
    const row = findFileTreeRowElement(listEl, activeFileId);
    scrollElementIntoContainerView(listEl, row, 'nearest');
  });
}

export function ReviewFileTreeSidebar({
  diffs,
  activeFileId,
  onSelectFile,
}: {
  diffs: FileDiff[];
  activeFileId: string | null;
  onSelectFile: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const { nodes, matchedDiffs } = useMemo(
    () => buildFilteredReviewFileTree(diffs, query),
    [diffs, query],
  );
  const emptyCollapsedDirs = useMemo(() => new Set<string>(), []);
  const effectiveCollapsedDirs = query.trim() ? emptyCollapsedDirs : collapsedDirs;
  const flatNodes = useMemo(
    () => flattenReviewFileTree(nodes, effectiveCollapsedDirs),
    [effectiveCollapsedDirs, nodes],
  );
  const virtualized = shouldVirtualizeFileList(matchedDiffs.length);
  const treeVirtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (index) => flatNodes[index]?.node.id ?? index,
  });
  const toggleDirectory = useCallback((id: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const renderNode = (item: ReviewFileTreeFlatNode) => (
    <ReviewFileTreeRow
      key={item.node.id}
      item={item}
      activeFileId={activeFileId}
      collapsedDirs={effectiveCollapsedDirs}
      onToggleDirectory={toggleDirectory}
      onSelectFile={onSelectFile}
    />
  );

  useEffect(() => {
    revealReviewFileTreeActiveNode({
      activeFileId,
      flatNodes,
      virtualized,
      treeVirtualizer,
      listEl: listRef.current,
    });
  }, [activeFileId, flatNodes, treeVirtualizer, virtualized]);

  return (
    <aside
      className="flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--border-default)] bg-[var(--panel-bg)]"
      style={{ width: REVIEW_FILE_TREE_WIDTH_PX }}
    >
      <div className="shrink-0 border-b border-[var(--border-default)] p-2">
        <label className="relative block">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('rightSidebar.review.fileTree.filterPlaceholder')}
            aria-label={t('rightSidebar.review.fileTree.filterPlaceholder')}
            className="h-7 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] pl-7 pr-2 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          />
        </label>
      </div>
      {flatNodes.length === 0 ? (
        <div className="px-3 py-4 text-11 leading-relaxed text-[var(--text-tertiary)]">
          {t('rightSidebar.review.fileTree.empty')}
        </div>
      ) : (
        <div
          ref={listRef}
          role="tree"
          aria-label={t('rightSidebar.review.fileTree.aria')}
          className="min-h-0 flex-1 overflow-y-auto py-1"
          data-review-file-tree="true"
        >
          {virtualized ? (
            <div className="relative w-full" style={{ height: treeVirtualizer.getTotalSize() }}>
              {treeVirtualizer.getVirtualItems().map((item) => {
                const node = flatNodes[item.index];
                if (!node) return null;
                return (
                  <div
                    key={item.key}
                    ref={treeVirtualizer.measureElement}
                    data-index={item.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderNode(node)}
                  </div>
                );
              })}
            </div>
          ) : (
            flatNodes.map(renderNode)
          )}
        </div>
      )}
    </aside>
  );
}

function ReviewFileTreeRow({
  item,
  activeFileId,
  collapsedDirs,
  onToggleDirectory,
  onSelectFile,
}: {
  item: ReviewFileTreeFlatNode;
  activeFileId: string | null;
  collapsedDirs: ReadonlySet<string>;
  onToggleDirectory: (id: string) => void;
  onSelectFile: (diff: FileDiff) => void;
}) {
  const { node, depth } = item;
  const paddingLeft = 8 + depth * 12;
  if (node.type === 'directory') {
    const collapsed = collapsedDirs.has(node.id);
    return (
      <button
        type="button"
        role="treeitem"
        aria-expanded={!collapsed}
        onClick={() => onToggleDirectory(node.id)}
        className="flex h-7 w-full min-w-0 items-center gap-1 pr-2 text-left text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
        style={{ paddingLeft }}
      >
        {collapsed ? (
          <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        )}
        <span className="min-w-0 truncate font-medium">{node.name}</span>
      </button>
    );
  }

  const active = node.id === activeFileId;
  return (
    <Tip text={node.path}>
      <button
        type="button"
        role="treeitem"
        data-review-file-tree-node-id={node.id}
        aria-selected={active}
        onClick={() => onSelectFile(node.diff)}
        className={cn(
          'flex h-7 w-full min-w-0 items-center pr-2 text-left text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
          active && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
        )}
        style={{ paddingLeft: paddingLeft + 18 }}
      >
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
    </Tip>
  );
}

export function BatchActionPill({
  writeAction,
  allPending,
  discardAllPending,
  layout = 'full',
}: {
  writeAction: WriteActionProps;
  allPending: boolean;
  discardAllPending: boolean;
  layout?: BatchActionLayout;
}) {
  const { t } = useTranslation();
  const iconOnly = layout === 'icon-only';
  return (
    <div
      data-review-batch-action-pill="true"
      className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 overflow-hidden rounded-full border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,transparent)] p-1 shadow-[var(--shadow-menu)] backdrop-blur-sm"
      style={{ maxWidth: 'calc(100% - 16px)' }}
    >
      {writeAction.sectionDiscardVisible && writeAction.onSectionDiscard && (
        <ActionButton
          label={t('rightSidebar.review.actions.discardAll')}
          icon={<Undo2 size={12} />}
          pending={discardAllPending}
          disabled={!writeAction.canWrite || discardAllPending}
          disabledTooltip={!writeAction.canWrite ? writeAction.disabledTooltip : undefined}
          onClick={writeAction.onSectionDiscard}
          className="pointer-events-auto border-transparent bg-transparent px-2 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          iconOnly={iconOnly}
        />
      )}
      {writeAction.sectionAction && writeAction.onSectionAction && (
        <ActionButton
          label={allActionLabel(writeAction.sectionAction, t)}
          icon={writeAction.sectionAction === 'stage' ? <Plus size={12} /> : <Minus size={12} />}
          pending={allPending}
          disabled={!writeAction.canWrite || allPending}
          disabledTooltip={!writeAction.canWrite ? writeAction.disabledTooltip : undefined}
          onClick={writeAction.onSectionAction}
          className="pointer-events-auto border-transparent bg-transparent px-2 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          iconOnly={iconOnly}
        />
      )}
    </div>
  );
}

export function ReviewDiffListHeader({
  fileCount,
  branchBaseControl,
  refreshPending,
  onRefresh,
  viewMode,
  onViewModeChange,
  richMarkdownPreview,
  richMarkdownPreviewDisabledReason,
  onRichMarkdownPreviewChange,
}: {
  fileCount: number;
  branchBaseControl?: ReactNode;
  refreshPending: boolean;
  onRefresh: () => void;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  richMarkdownPreview: boolean;
  richMarkdownPreviewDisabledReason?: string;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
}) {
  const { t } = useTranslation();
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const showBranchBaseLabel = shouldShowBranchBaseLabel(rowWidth, Boolean(branchBaseControl));

  useEffect(() => {
    if (!rowEl) {
      setRowWidth(0);
      return;
    }
    const update = () => setRowWidth(rowEl.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(rowEl);
    return () => observer.disconnect();
  }, [rowEl]);

  return (
    <div
      ref={setRowEl}
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3 text-12"
    >
      <div
        data-testid="review-diff-list-header-left"
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        {branchBaseControl && (
          <>
            {showBranchBaseLabel && (
              <span
                data-testid="review-branch-base-label"
                className="shrink-0 text-11 text-[var(--text-tertiary)]"
              >
                {t('rightSidebar.review.branch.baseLabel')}
              </span>
            )}
            <div data-testid="review-branch-base-control" className="min-w-0 max-w-[8.5rem] shrink">
              {branchBaseControl}
            </div>
          </>
        )}
        <span className="shrink-0 font-medium text-[var(--text-primary)]">
          {t('rightSidebar.review.fileCount', { count: fileCount })}
        </span>
      </div>
      <div
        data-testid="review-diff-list-header-actions"
        className="ml-auto flex shrink-0 items-center gap-1"
      >
        <ReviewRefreshButton pending={refreshPending} onRefresh={onRefresh} />
        <RichMarkdownPreviewToggleButton
          enabled={richMarkdownPreview}
          disabledReason={richMarkdownPreviewDisabledReason}
          onToggle={() => onRichMarkdownPreviewChange(!richMarkdownPreview)}
        />
        <DiffViewModeToggle mode={viewMode} onChange={onViewModeChange} />
      </div>
    </div>
  );
}

function RichMarkdownPreviewToggleButton({
  enabled,
  disabledReason,
  onToggle,
}: {
  enabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(
    enabled
      ? 'rightSidebar.review.moreMenu.richPreviewDisable'
      : 'rightSidebar.review.moreMenu.richPreviewEnable',
  );
  return (
    <Tip text={disabledReason ?? label}>
      <button
        type="button"
        aria-disabled={Boolean(disabledReason)}
        aria-pressed={enabled}
        aria-label={label}
        onClick={() => {
          if (!disabledReason) onToggle();
        }}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
          enabled && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
          disabledReason &&
            'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-[var(--text-secondary)]',
        )}
      >
        {enabled ? <Image size={13} /> : <ImageOff size={13} />}
      </button>
    </Tip>
  );
}

export function ReviewRefreshButton({
  pending,
  onRefresh,
}: {
  pending: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const label = t('rightSidebar.review.refreshGitData');
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onRefresh}
        className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        <Spinner icon={RefreshCw} size={13} spinning={pending} />
      </button>
    </Tip>
  );
}

function DiffViewModeToggle({
  mode,
  onChange,
}: {
  mode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ mode: DiffViewMode; label: string }> = [
    { mode: 'unified', label: t('rightSidebar.review.viewMode.unified') },
    { mode: 'split', label: t('rightSidebar.review.viewMode.split') },
  ];
  return (
    <div
      className="inline-flex h-6 shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface)] p-0.5"
      aria-label={t('rightSidebar.review.viewMode.aria')}
    >
      <SlidersHorizontal size={11} className="ml-1 self-center text-[var(--text-tertiary)]" />
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          onClick={() => onChange(option.mode)}
          className={cn(
            'rounded-full px-2 text-10 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            option.mode === mode &&
              'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CappedSourceView({
  capped,
  summaryDiffs,
  selectedSummaryDiff,
  loadedDiff,
  loading,
  error,
  onSelectFile,
  onRefresh,
  refreshPending,
  branchBaseControl,
  topNotice,
  viewMode,
  onViewModeChange,
  onRichMarkdownPreviewChange,
  wordWrap,
  wordDiff,
  expandedSet,
  onToggleDiff,
  fileTreeVisible,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  onOpenFile,
  writeAction,
}: {
  capped: ReviewCappedDiffData;
  summaryDiffs: FileDiff[];
  selectedSummaryDiff: FileDiff | null;
  loadedDiff: FileDiff | null;
  loading: boolean;
  error: string | null;
  onSelectFile: (diff: FileDiff) => void;
  onRefresh: () => void;
  refreshPending: boolean;
  branchBaseControl?: ReactNode;
  topNotice?: ReactNode;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
  wordWrap: boolean;
  wordDiff: boolean;
  expandedSet: Set<string>;
  onToggleDiff: (id: string) => void;
  fileTreeVisible: boolean;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  onOpenFile?: (diff: FileDiff) => void;
  writeAction?: WriteActionProps;
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const activeId = selectedSummaryDiff?.id ?? null;
  const selectedExpanded = selectedSummaryDiff ? expandedSet.has(selectedSummaryDiff.id) : false;
  const fileTreeVisibility = getReviewFileTreeVisibility({
    userVisible: fileTreeVisible,
    containerWidth: contentWidth,
    fileCount: summaryDiffs.length,
  });
  const showFileTree = fileTreeVisibility.effectiveVisible;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setContentWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleImagePreviewLoad = useCallback(() => undefined, []);
  const notice = (
    <div className="space-y-1">
      {topNotice && <div>{topNotice}</div>}
      <div>
        {t('rightSidebar.review.capped.notice', {
          count: capped.stats.fileCount,
          lines: capped.stats.totalChangedLines,
        })}
      </div>
    </div>
  );

  return (
    <div
      data-testid="review-capped-source-view"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <ReviewDiffListHeader
        fileCount={capped.stats.fileCount}
        branchBaseControl={branchBaseControl}
        refreshPending={refreshPending}
        onRefresh={onRefresh}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        richMarkdownPreview={richMarkdownPreview}
        onRichMarkdownPreviewChange={onRichMarkdownPreviewChange}
      />
      <div className="shrink-0 border-b border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-3 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {notice}
      </div>
      <div ref={contentRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {!selectedSummaryDiff ? (
              <CenteredState
                icon={<FileDiffIcon size={24} />}
                title={t('rightSidebar.review.emptyTitle')}
                desc={t('rightSidebar.review.emptyDescGit')}
              />
            ) : loading ? (
              <CappedFileState
                icon={<Spinner icon={RefreshCw} size={20} />}
                title={t('rightSidebar.review.capped.fileLoading')}
                desc={selectedSummaryDiff.path}
              />
            ) : error && !loadedDiff ? (
              <CappedFileState
                icon={<AlertTriangle size={20} />}
                title={t('rightSidebar.review.capped.fileLoadFailed')}
                desc={error}
              />
            ) : loadedDiff ? (
              <FileRow
                diff={loadedDiff}
                expanded={selectedExpanded}
                onToggle={() => {
                  if (selectedSummaryDiff) onToggleDiff(selectedSummaryDiff.id);
                }}
                writeAction={writeAction}
                viewMode={viewMode}
                wordWrap={wordWrap}
                wordDiff={wordDiff}
                loadImagePreview={loadImagePreview}
                loadMarkdownPreview={loadMarkdownPreview}
                richMarkdownPreview={richMarkdownPreview}
                onImagePreviewLoad={handleImagePreviewLoad}
                onOpenFile={onOpenFile}
              />
            ) : (
              <CappedFileState
                icon={<AlertTriangle size={20} />}
                title={t('rightSidebar.review.capped.fileLoadFailed')}
                desc={selectedSummaryDiff.path}
              />
            )}
          </div>
          {showFileTree && (
            <ReviewFileTreeSidebar
              diffs={summaryDiffs}
              activeFileId={activeId}
              onSelectFile={onSelectFile}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CappedFileState({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="m-3 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-3 text-12 leading-relaxed text-[var(--text-secondary)]">
      <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
        <span className="text-[var(--text-tertiary)]">{icon}</span>
        <span>{title}</span>
      </div>
      <div className="mt-1 break-words text-11 text-[var(--text-tertiary)]">{desc}</div>
    </div>
  );
}

function CommitSourceView({
  selectedCommitOid,
  diffs,
  rawDiffCount,
  diffLoading,
  diffError,
  onRefreshDiff,
  onRefresh,
  refreshPending,
  expandedSet,
  onToggleDiff,
  viewMode,
  onViewModeChange,
  onRichMarkdownPreviewChange,
  wordWrap,
  wordDiff,
  fileTreeVisible,
  jumpRequest,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  onOpenFile,
}: {
  selectedCommitOid: string | null;
  diffs: FileDiff[];
  rawDiffCount: number;
  diffLoading: boolean;
  diffError: string | null;
  onRefreshDiff: () => void;
  onRefresh: () => void;
  refreshPending: boolean;
  expandedSet: Set<string>;
  onToggleDiff: (id: string) => void;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
  wordWrap: boolean;
  wordDiff: boolean;
  fileTreeVisible: boolean;
  jumpRequest: ReviewFileJumpRequest | null;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  onOpenFile?: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();

  if (!selectedCommitOid) {
    return (
      <CenteredState
        icon={<FileDiffIcon size={24} />}
        title={t('rightSidebar.review.noCommitsTitle')}
        desc={t('rightSidebar.review.noCommitsDesc')}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {diffLoading ? (
        <CenteredState
          icon={<Spinner icon={RefreshCw} size={24} />}
          title={t('rightSidebar.review.commitDiffLoadingTitle')}
          desc={selectedCommitOid.slice(0, 7)}
        />
      ) : diffError && diffs.length === 0 ? (
        <CenteredState
          icon={<AlertTriangle size={24} />}
          title={t('rightSidebar.review.commitDiffErrorTitle')}
          desc={diffError}
          actionLabel={t('rightSidebar.review.refresh')}
          onAction={onRefreshDiff}
        />
      ) : diffs.length === 0 && rawDiffCount > 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.filterEmptyTitle')}
          desc={t('rightSidebar.review.filterEmptyDesc')}
        />
      ) : diffs.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.commitDiffEmptyTitle')}
          desc={t('rightSidebar.review.commitDiffEmptyDesc')}
        />
      ) : (
        <DiffList
          diffs={diffs}
          expandedSet={expandedSet}
          onToggleDiff={onToggleDiff}
          onRefresh={onRefresh}
          refreshPending={refreshPending}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          onRichMarkdownPreviewChange={onRichMarkdownPreviewChange}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={jumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={richMarkdownPreview}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

function BranchSourceView({
  candidates,
  selectedBaseRef,
  warning,
  diffs,
  rawDiffCount,
  diffLoading,
  diffError,
  onSelectBase,
  onRefreshDiff,
  onRefresh,
  refreshPending,
  expandedSet,
  onToggleDiff,
  viewMode,
  onViewModeChange,
  onRichMarkdownPreviewChange,
  wordWrap,
  wordDiff,
  fileTreeVisible,
  jumpRequest,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  onOpenFile,
}: {
  candidates: ReviewBranchBaseCandidate[];
  selectedBaseRef: string | null;
  warning: ReviewBranchDiffWarning | null;
  diffs: FileDiff[];
  rawDiffCount: number;
  diffLoading: boolean;
  diffError: string | null;
  onSelectBase: (baseRef: string) => void;
  onRefreshDiff: () => void;
  onRefresh: () => void;
  refreshPending: boolean;
  expandedSet: Set<string>;
  onToggleDiff: (id: string) => void;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
  wordWrap: boolean;
  wordDiff: boolean;
  fileTreeVisible: boolean;
  jumpRequest: ReviewFileJumpRequest | null;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  onOpenFile?: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const blockingWarning = warning && warning.code !== 'base-missing' ? warning : null;

  if (diffLoading) {
    return (
      <CenteredState
        icon={<Spinner icon={RefreshCw} size={24} />}
        title={t('rightSidebar.review.branch.loadingTitle')}
        desc={t('rightSidebar.review.branch.loadingDesc')}
      />
    );
  }
  if (diffError && rawDiffCount === 0) {
    return (
      <CenteredState
        icon={<AlertTriangle size={24} />}
        title={t('rightSidebar.review.branch.errorTitle')}
        desc={diffError}
        actionLabel={t('rightSidebar.review.refresh')}
        onAction={onRefreshDiff}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {candidates.length === 0 ? (
        <CenteredState
          icon={<GitBranch size={24} />}
          title={t('rightSidebar.review.branch.noCandidatesTitle')}
          desc={t('rightSidebar.review.branch.noCandidatesDesc')}
        />
      ) : blockingWarning ? (
        <CenteredState
          icon={<AlertTriangle size={24} />}
          title={t('rightSidebar.review.branch.warningTitle')}
          desc={branchWarningText(blockingWarning, t)}
          actionLabel={t('rightSidebar.review.refresh')}
          onAction={onRefreshDiff}
        />
      ) : diffs.length === 0 && rawDiffCount > 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.filterEmptyTitle')}
          desc={t('rightSidebar.review.filterEmptyDesc')}
        />
      ) : diffs.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.branch.emptyTitle')}
          desc={t('rightSidebar.review.branch.emptyDesc')}
        />
      ) : (
        <DiffList
          diffs={diffs}
          expandedSet={expandedSet}
          onToggleDiff={onToggleDiff}
          onRefresh={onRefresh}
          refreshPending={refreshPending}
          branchBaseControl={
            <BranchBaseDropdown
              candidates={candidates}
              selectedBaseRef={selectedBaseRef}
              onSelectBase={onSelectBase}
            />
          }
          topNotice={warning && !blockingWarning ? branchWarningText(warning, t) : null}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          onRichMarkdownPreviewChange={onRichMarkdownPreviewChange}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={jumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={richMarkdownPreview}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

export function BranchBaseDropdown({
  candidates,
  selectedBaseRef,
  onSelectBase,
}: {
  candidates: ReviewBranchBaseCandidate[];
  selectedBaseRef: string | null;
  onSelectBase: (baseRef: string) => void;
}) {
  const { t } = useTranslation();
  const selected =
    candidates.find((candidate) => candidate.refName === selectedBaseRef) ?? candidates[0] ?? null;
  const label = selected?.shortName ?? t('rightSidebar.review.branch.basePlaceholder');
  const tooltip = selected
    ? t('rightSidebar.review.branch.baseTooltip', { base: selected.refName })
    : t('rightSidebar.review.branch.baseDropdownAria');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip text={tooltip}>
          <button
            type="button"
            disabled={candidates.length === 0}
            aria-label={tooltip}
            className="flex h-6 min-w-0 max-w-full items-center justify-between rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-left text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown size={13} className="ml-1.5 shrink-0 text-[var(--text-tertiary)]" />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] min-w-[14rem] overflow-y-auto rounded-[8px] border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
      >
        {candidates.map((candidate) => (
          <DropdownMenuItem
            key={candidate.refName}
            onSelect={() => onSelectBase(candidate.refName)}
            className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-12 text-[var(--text-primary)] focus:bg-[var(--cmd-palette-item-hover)]"
          >
            <span className="flex h-4 w-4 items-center justify-center text-[var(--text-secondary)]">
              {candidate.refName === selectedBaseRef && <Check size={12} />}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {candidate.shortName}
              {candidate.isStaleRisk && (
                <span className="text-[var(--text-tertiary)]">
                  {' '}
                  {t('rightSidebar.review.branch.staleRiskSuffix')}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function branchWarningText(
  warning: ReviewBranchDiffWarning,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (warning.code) {
    case 'base-missing':
      return t('rightSidebar.review.branch.baseMissing', { base: warning.requestedBaseRef ?? '' });
    case 'merge-base-missing':
      return t('rightSidebar.review.branch.mergeBaseMissing');
    case 'too-many-files':
      return t('rightSidebar.review.branch.tooManyFiles', {
        count: warning.fileCount ?? 0,
        limit: warning.limit ?? 0,
      });
    case 'unborn':
      return t('rightSidebar.review.branch.unborn');
    case 'no-base-candidates':
      return t('rightSidebar.review.branch.noCandidatesDesc');
    default:
      return warning.message;
  }
}

function CenteredState({
  icon,
  title,
  desc,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[var(--text-tertiary)]">{icon}</div>
      <p className="text-13 font-medium text-[var(--text-primary)]">{title}</p>
      <p className="max-w-[260px] text-11 leading-relaxed text-[var(--text-tertiary)]">{desc}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function ActionButton({
  label,
  icon,
  pending,
  disabled,
  disabledTooltip,
  onClick,
  className,
  iconOnly = false,
}: {
  label: string;
  icon: ReactNode;
  pending: boolean;
  disabled: boolean;
  disabledTooltip?: string;
  onClick: () => void;
  className?: string;
  iconOnly?: boolean;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-6 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-10 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
        iconOnly ? 'w-6 px-0' : 'gap-1 px-2',
      )}
    >
      {pending ? <Spinner size={12} /> : icon}
      <span className={cn(iconOnly && 'sr-only')}>{label}</span>
    </button>
  );
  if (!iconOnly && (!disabled || !disabledTooltip)) return button;
  return (
    <Tip text={disabled && disabledTooltip ? disabledTooltip : label}>
      <span
        className={cn(
          'inline-flex',
          className?.includes('w-full') && 'w-full',
          className?.includes('flex-1') && 'flex-1',
        )}
      >
        {button}
      </span>
    </Tip>
  );
}

function StagedSourceView({
  diffs,
  stagedCount,
  expandedSet,
  onToggleDiff,
  onRefresh,
  refreshPending,
  canWrite,
  pendingKey,
  actionDisabledTooltip,
  onFileAction,
  onHunkAction,
  onSectionAction,
  viewMode,
  onViewModeChange,
  onRichMarkdownPreviewChange,
  wordWrap,
  wordDiff,
  fileTreeVisible,
  jumpRequest,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  hunkActionsEnabled,
  onOpenFile,
}: {
  diffs: FileDiff[];
  stagedCount: number;
  expandedSet: Set<string>;
  onToggleDiff: (id: string) => void;
  onRefresh: () => void;
  refreshPending: boolean;
  canWrite: boolean;
  pendingKey: string | null;
  actionDisabledTooltip?: string;
  onFileAction: (diff: FileDiff) => void;
  onHunkAction: (diff: FileDiff, hunkIndex: number) => void;
  onSectionAction: () => void;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  onRichMarkdownPreviewChange: (richMarkdownPreview: boolean) => void;
  wordWrap: boolean;
  wordDiff: boolean;
  fileTreeVisible: boolean;
  jumpRequest: ReviewFileJumpRequest | null;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  hunkActionsEnabled: boolean;
  onOpenFile?: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const filteredEmpty = diffs.length === 0 && stagedCount > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filteredEmpty ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.filterEmptyTitle')}
          desc={t('rightSidebar.review.filterEmptyDesc')}
        />
      ) : diffs.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon size={24} />}
          title={t('rightSidebar.review.stagedEmptyTitle')}
          desc={t('rightSidebar.review.stagedEmptyDesc')}
        />
      ) : (
        <DiffList
          diffs={diffs}
          expandedSet={expandedSet}
          onToggleDiff={onToggleDiff}
          onRefresh={onRefresh}
          refreshPending={refreshPending}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          onRichMarkdownPreviewChange={onRichMarkdownPreviewChange}
          wordWrap={wordWrap}
          wordDiff={wordDiff}
          fileTreeVisible={fileTreeVisible}
          jumpRequest={jumpRequest}
          loadImagePreview={loadImagePreview}
          loadMarkdownPreview={loadMarkdownPreview}
          richMarkdownPreview={richMarkdownPreview}
          onOpenFile={onOpenFile}
          writeAction={{
            canWrite,
            pendingKey,
            disabledTooltip: actionDisabledTooltip,
            actionForDiff: () => 'unstage',
            hunkActionsEnabled,
            sectionAction: 'unstage',
            sectionPendingKey: 'unstage:all',
            onFileAction,
            onHunkAction,
            onSectionAction,
          }}
        />
      )}
    </div>
  );
}

function FileRow({
  diff,
  expanded,
  onToggle,
  writeAction,
  viewMode,
  wordWrap,
  wordDiff,
  loadImagePreview,
  loadMarkdownPreview,
  richMarkdownPreview,
  onImagePreviewLoad,
  onOpenFile,
}: {
  diff: FileDiff;
  expanded: boolean;
  onToggle: () => void;
  writeAction?: WriteActionProps;
  viewMode: DiffViewMode;
  wordWrap: boolean;
  wordDiff: boolean;
  loadImagePreview: LoadImagePreview;
  loadMarkdownPreview: LoadMarkdownPreview;
  richMarkdownPreview: boolean;
  onImagePreviewLoad: () => void;
  onOpenFile?: (diff: FileDiff) => void;
}) {
  const { t } = useTranslation();
  const fileName = basename(diff.path);
  const action = writeAction?.actionForDiff(diff) ?? null;
  const canDiscard = writeAction?.discardForDiff?.(diff) ?? false;
  const filePending = action ? writeAction?.pendingKey === `${action}:file:${diff.id}` : false;
  const discardFilePending = writeAction?.pendingKey === `discard:file:${diff.id}`;
  const hasFileActions = Boolean(
    writeAction && ((canDiscard && writeAction.onFileDiscard) || action),
  );
  const fileActionsPending = Boolean(filePending || discardFilePending);
  const hunkActionsEnabled = writeAction?.hunkActionsEnabled ?? true;
  const canPartial = hunkActionsEnabled && partialAllowed(diff);
  const showRenamePartialNotice = Boolean(hunkActionsEnabled && action && isRenameLikeDiff(diff));
  const showTypechangePartialNotice = Boolean(
    hunkActionsEnabled && action && isTypechangeLikeDiff(diff),
  );
  const showsPathTransition = Boolean(
    diff.oldPath && (diff.status === 'renamed' || diff.status === 'copied'),
  );
  const richMarkdownEligibility = getRichMarkdownPreviewEligibility(diff, richMarkdownPreview);
  const changeChip =
    diff.status === 'renamed'
      ? t('rightSidebar.review.changeStatus.renamed')
      : diff.status === 'copied'
        ? t('rightSidebar.review.changeStatus.copied')
        : null;
  const hunkActions = [
    ...(writeAction && canDiscard && canPartial && writeAction.onHunkDiscard
      ? [
          {
            label: t('rightSidebar.review.actions.discardHunk'),
            disabled: !writeAction.canWrite,
            disabledTooltip: !writeAction.canWrite ? writeAction.disabledTooltip : undefined,
            isPending: (hunkIndex: number) =>
              writeAction.pendingKey === `discard:hunk:${diff.id}:${hunkIndex}`,
            onClick: (hunkIndex: number) => writeAction.onHunkDiscard?.(diff, hunkIndex),
            icon: 'revert' as const,
          },
        ]
      : []),
    ...(writeAction && action && canPartial
      ? [
          {
            label: hunkActionLabel(action, t),
            disabled: !writeAction.canWrite,
            disabledTooltip: !writeAction.canWrite ? writeAction.disabledTooltip : undefined,
            isPending: (hunkIndex: number) =>
              writeAction.pendingKey === `${action}:hunk:${diff.id}:${hunkIndex}`,
            onClick: (hunkIndex: number) => writeAction.onHunkAction(diff, hunkIndex),
            icon: action === 'stage' ? ('plus' as const) : ('minus' as const),
          },
        ]
      : []),
  ];
  const plainDiffBody = (
    <PlainUnifiedDiff
      diff={diff}
      viewMode={viewMode}
      wordWrap={wordWrap}
      wordDiff={wordDiff}
      loadImagePreview={loadImagePreview}
      onImagePreviewLoad={onImagePreviewLoad}
      onOpenFile={onOpenFile}
      hunkActions={hunkActions}
    />
  );

  return (
    <div
      role="listitem"
      data-review-file-id={diff.id}
      className="group/file min-w-0 border-b border-[var(--border-default)]"
    >
      <div
        className={cn(
          'relative flex w-full items-center gap-2 px-3 py-2 hover:bg-[var(--surface-hover)]',
          hasFileActions && 'pr-20',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          {expanded ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
              {fileName}
            </span>
            <span className="block truncate text-10 text-[var(--text-tertiary)]">
              {showsPathTransition ? (
                <>
                  <span className="opacity-70">{diff.oldPath}</span>
                  <span className="px-1">→</span>
                  <span>{diff.path}</span>
                </>
              ) : (
                diff.path
              )}
            </span>
          </span>
        </button>
        {changeChip && (
          <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 text-[var(--text-secondary)]">
            {changeChip}
          </span>
        )}
        {diff.kind !== 'text' && (
          <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 text-[var(--text-secondary)]">
            {t(`rightSidebar.review.status.${diff.kind}`, { defaultValue: diff.kind })}
          </span>
        )}
        <span className="shrink-0 font-mono text-11 tabular-nums">
          <span className="text-[var(--diff-add-fg)]">+{diff.additions}</span>{' '}
          <span className="text-[var(--diff-del-fg)]">-{diff.deletions}</span>
        </span>
        {hasFileActions && (
          <span
            data-review-action-reveal="file"
            className={cn(
              'absolute right-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
              reviewActionRevealClass('file', fileActionsPending),
            )}
          >
            {writeAction && canDiscard && writeAction.onFileDiscard && (
              <ActionButton
                label={t('rightSidebar.review.actions.discard')}
                icon={<Undo2 size={12} />}
                pending={Boolean(discardFilePending)}
                disabled={!writeAction.canWrite || Boolean(discardFilePending)}
                disabledTooltip={!writeAction.canWrite ? writeAction.disabledTooltip : undefined}
                onClick={() => writeAction.onFileDiscard?.(diff)}
                iconOnly
              />
            )}
            {writeAction && action && (
              <ActionButton
                label={actionLabel(action, t)}
                icon={action === 'stage' ? <Plus size={12} /> : <Minus size={12} />}
                pending={Boolean(filePending)}
                disabled={!writeAction.canWrite || Boolean(filePending)}
                disabledTooltip={!writeAction.canWrite ? writeAction.disabledTooltip : undefined}
                onClick={() => writeAction.onFileAction(diff)}
                iconOnly
              />
            )}
          </span>
        )}
      </div>
      {expanded && (
        <div className="min-w-0 px-3 pb-3">
          {showRenamePartialNotice && (
            <div className="mb-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-12 text-[var(--text-secondary)]">
              {t('rightSidebar.review.renamePartialNotice')}
            </div>
          )}
          {showTypechangePartialNotice && (
            <div className="mb-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-12 text-[var(--text-secondary)]">
              {t('rightSidebar.review.typechangePartialNotice')}
            </div>
          )}
          {richMarkdownEligibility.canPreview ? (
            <MarkdownDiffPreview
              diff={diff}
              loadMarkdownPreview={loadMarkdownPreview}
              fallback={plainDiffBody}
              onPreviewSettled={onImagePreviewLoad}
            />
          ) : (
            plainDiffBody
          )}
        </div>
      )}
    </div>
  );
}

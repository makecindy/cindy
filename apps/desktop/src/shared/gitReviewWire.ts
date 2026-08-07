/**
 * Serializable git-review IPC DTOs shared by main, preload, and renderer.
 *
 * Keep process-local dependencies and callbacks out of this file; main-only
 * service deps live in main/git-review/types.ts.
 */

export type ReviewSource = 'unstaged' | 'staged' | 'commit' | 'branch' | 'last-turn';

export type ReviewDisableReason =
  | 'remote-session'
  | 'no-session'
  | 'no-workdir'
  | 'non-git'
  | 'git-unavailable'
  | 'invalid-worktree'
  | 'unknown';

export interface AheadBehind {
  ahead: number;
  behind: number;
  upstream: string | null;
  stale: boolean;
}

export interface ReviewScope {
  sessionId: string;
  workdir: string | null;
  worktreePath: string | null;
  workingDir: string | null;
  repoRoot: string | null;
  branch: string | null;
  headOid: string | null;
  isDetached: boolean;
  isUnborn: boolean;
  source: 'telemetry' | 'worktree' | 'workingDir' | null;
  aheadBehind: AheadBehind;
  disabledReason: ReviewDisableReason | null;
  disabledMessage: string | null;
  resolutionChain: Array<{ source: string; path: string | null; ok: boolean; reason?: string }>;
}

export type GitIndexStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | null;

export type GitWorktreeStatus =
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'typechange'
  | 'untracked'
  | 'unmerged'
  | null;

export interface FileStatus {
  path: string;
  oldPath: string | null;
  indexStatus: GitIndexStatus;
  worktreeStatus: GitWorktreeStatus;
  isUntracked: boolean;
  isUnmerged: boolean;
  isSubmodule: boolean;
  sources: Array<'staged' | 'unstaged'>;
  rawXY: string;
}

export type GitOperationKind =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'squash'
  | 'unknown';

export interface GitInProgressState {
  kind: GitOperationKind;
  marker: string;
  path: string;
}

export interface ReviewStatus {
  scope: ReviewScope;
  files: FileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  unmergedCount: number;
  inProgress: GitInProgressState[];
  writeDisabledReasons: string[];
  dirty: boolean;
}

export type DiffFileKind =
  | 'text'
  | 'binary'
  | 'large-text'
  | 'too-large'
  | 'submodule'
  | 'unrenderable';

export type DiffChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'unknown';

export interface DiffLine {
  index: number;
  type: 'context' | 'add' | 'delete';
  content: string;
  raw: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  originalLineNumber: number | null;
  selectable: boolean;
  noTrailingNewLine: boolean;
}

export interface Hunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
  selectableLines: number[];
  raw: string;
}

export interface FileDiff {
  id: string;
  source: 'staged' | 'unstaged' | 'commit' | 'branch' | 'turn';
  path: string;
  oldPath: string | null;
  status: DiffChangeKind;
  kind: DiffFileKind;
  size: number | null;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isSubmodule: boolean;
  isTooLarge: boolean;
  mode: { old: string | null; new: string | null };
  index: { oldOid: string | null; newOid: string | null };
  rawHeader: string;
  rawPatch: string;
  hunks: Hunk[];
  error: string | null;
}

export type ReviewDiffSummarySource = FileDiff['source'];

export type ReviewCappedDiffReason = 'file-count' | 'changed-lines' | 'changed-bytes';

export interface ReviewDiffSummaryEntry {
  id: string;
  source: ReviewDiffSummarySource;
  path: string;
  oldPath: string | null;
  status: DiffChangeKind;
  additions: number;
  deletions: number;
  changedLines: number;
  changedBytes: number;
  isBinary: boolean;
  isSubmodule: boolean;
}

export interface ReviewCappedDiffStats {
  fileCount: number;
  totalChangedLines: number;
  totalChangedBytes: number;
}

export interface ReviewCappedDiffData {
  reason: ReviewCappedDiffReason;
  stats: ReviewCappedDiffStats;
  files: ReviewDiffSummaryEntry[];
}

export interface ReviewDiffBucket {
  staged: FileDiff[];
  unstaged: FileDiff[];
  capped?: {
    staged: ReviewCappedDiffData | null;
    unstaged: ReviewCappedDiffData | null;
  };
}

export interface ReviewData {
  scope: ReviewScope;
  status: ReviewStatus | null;
  diffs: ReviewDiffBucket;
  summary: ReviewDirtySummary;
}

export interface ReviewDiffReadOptions {
  ignoreWhitespace?: boolean;
}

export interface ReviewDirtySummary {
  sessionId: string;
  disabledReason: ReviewDisableReason | null;
  disabledMessage: string | null;
  totalFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  unmergedFiles: number;
  dirty: boolean;
}

export interface ReviewCommit {
  oid: string;
  shortOid: string;
  title: string;
  authorTime: number;
}

export interface ReviewCommitListData {
  scope: ReviewScope;
  baseRef: string | null;
  baseOid: string | null;
  headOid: string | null;
  commits: ReviewCommit[];
  warning: ReviewBranchDiffWarning | null;
}

export interface ReviewCommitDiffData {
  scope: ReviewScope;
  commitOid: string;
  diffs: FileDiff[];
  capped: ReviewCappedDiffData | null;
}

export type ReviewBranchBaseCandidateKind =
  | 'upstream'
  | 'remote-default'
  | 'local'
  | 'remote';

export interface ReviewBranchBaseCandidate {
  refName: string;
  shortName: string;
  kind: ReviewBranchBaseCandidateKind;
  remote: string | null;
  oid: string;
  isStaleRisk?: boolean;
}

export type ReviewBranchDiffWarningCode =
  | 'base-missing'
  | 'no-base-candidates'
  | 'merge-base-missing'
  | 'too-many-files'
  | 'unborn';

export interface ReviewBranchDiffWarning {
  code: ReviewBranchDiffWarningCode;
  message: string;
  requestedBaseRef?: string;
  fileCount?: number;
  limit?: number;
}

export interface ReviewBranchDiffData {
  scope: ReviewScope;
  baseRef: string | null;
  baseOid: string | null;
  headOid: string | null;
  mergeBaseOid: string | null;
  candidates: ReviewBranchBaseCandidate[];
  diffs: FileDiff[];
  capped: ReviewCappedDiffData | null;
  warning: ReviewBranchDiffWarning | null;
}

export interface ReviewFileDiffRequest {
  source: ReviewDiffSummarySource;
  path: string;
  oldPath?: string | null;
  commitOid?: string | null;
  branchBaseRef?: string | null;
  ignoreWhitespace?: boolean;
}

export interface ReviewFileDiffData {
  scope: ReviewScope;
  diff: FileDiff | null;
}

export interface ReviewImagePreviewSide {
  present: boolean;
  oid: string | null;
  mime: string | null;
  size: number | null;
  dataUrl?: string;
  tooLarge?: boolean;
  error?: string | null;
}

export interface ReviewImagePreviewData {
  diffId: string;
  old: ReviewImagePreviewSide | null;
  new: ReviewImagePreviewSide | null;
  maxBytes: number;
}

export interface ReviewImagePreviewRequest {
  diff: FileDiff;
  commitOid?: string | null;
  branchBaseRef?: string | null;
}

export type ReviewMarkdownPreviewReason =
  | 'not-markdown'
  | 'deleted'
  | 'unsupported-kind'
  | 'too-large'
  | 'missing'
  | 'unsafe-path'
  | 'source-missing'
  | 'read-error';

export interface ReviewMarkdownPreviewData {
  diffId: string;
  content: string | null;
  size: number | null;
  baseDir: string | null;
  maxBytes: number;
  reason: ReviewMarkdownPreviewReason | null;
  error: string | null;
}

export interface ReviewMarkdownPreviewRequest {
  diff: FileDiff;
  commitOid?: string | null;
  branchBaseRef?: string | null;
}

export type ReviewStageAction = 'stage' | 'unstage' | 'discard';

export interface DiffLineSelection {
  hunkIndex: number;
  lineIndices: number[];
}

export interface DiffSelection {
  lines: DiffLineSelection[];
}

export interface ReviewFileTarget {
  path: string;
  oldPath: string | null;
  source: 'staged' | 'unstaged';
}

export interface ReviewHunkOperationRequest {
  sessionId: string;
  diff: FileDiff;
  hunkIndex: number;
  ignoreWhitespace?: boolean;
}

export interface ReviewStageOperationSummary {
  action: ReviewStageAction;
  succeeded: string[];
  failed: Array<{ path: string; error: string; stderr?: string }>;
  partial: boolean;
}

export interface ReviewStageOperationResult {
  data: ReviewData;
  operation: ReviewStageOperationSummary;
}

export interface ReviewCommitRequest {
  sessionId: string;
  message: string;
  includeUnstaged?: boolean;
}

export interface ReviewCommitResult {
  data: ReviewData;
  commitOid: string;
  stdout: string;
  stderr: string;
}

export interface ReviewPushConfirmForce {
  remoteRef: string;
  expectedOid: string;
}

export interface ReviewPushPushedResult {
  kind: 'pushed';
  data: ReviewData;
  remote: string;
  remoteRef: string;
  stdout: string;
  stderr: string;
  aheadBehind: AheadBehind;
}

export interface ReviewPushNeedsForceResult {
  kind: 'needs-force';
  data: ReviewData;
  remote: string;
  remoteRef: string;
  remoteOid: string;
  ahead: number;
  behind: number;
  upstream: string | null;
  stderr: string;
}

export type ReviewPushResult = ReviewPushPushedResult | ReviewPushNeedsForceResult;

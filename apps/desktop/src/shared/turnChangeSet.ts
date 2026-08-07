import type { DiffChangeKind, FileDiff } from './gitReviewWire';

export const TURN_CHANGE_SET_MAX_DIFF_BYTES = 12 * 1024 * 1024;

export type TurnChangeProvider = 'codex' | 'claude-code' | 'pi';
export type TurnChangeSetState = 'complete' | 'partial';
export type TurnChangeWorkspaceState = 'applied' | 'undone';
export type TurnChangeAction = 'undo' | 'reapply';
export type TurnChangeIncompleteReason =
  | 'opaque-tool'
  | 'outside-workspace'
  | 'remote-session'
  | 'file-too-large'
  | 'binary-file'
  | 'sensitive-file'
  | 'read-failed'
  | 'diff-too-large'
  | 'provider-diff-conflict'
  | 'turn-failed'
  /** Another session's turn overlapped in the same workspace; capture attribution is best-effort and never undoable. */
  | 'concurrent-workspace';

export interface TurnChangeFileSummary {
  id: string;
  path: string;
  oldPath: string | null;
  status: DiffChangeKind;
  additions: number;
  deletions: number;
}

export interface TurnChangeSetSummary {
  /** Cindy-owned product-turn identity. */
  id: string;
  sessionId: string;
  /** Visible user message that owns this product turn. */
  anchorClientId: string;
  provider: TurnChangeProvider;
  /** Optional provider identity (Codex app-server turn id today). */
  providerTurnId: string | null;
  cwd: string;
  state: TurnChangeSetState;
  /** Last successful patch direction recorded by Main. */
  workspaceState: TurnChangeWorkspaceState;
  /** Whether the exact recorded payload can be safely applied in either direction. */
  isReversible: boolean;
  incompleteReasons: TurnChangeIncompleteReason[];
  createdAt: number;
  completedAt: number;
  files: TurnChangeFileSummary[];
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface TurnChangeSetDetail extends TurnChangeSetSummary {
  diffs: FileDiff[];
}

export interface PersistedTurnChangeSetV1 {
  version: 1;
  /** Present only for patches captured with the current lossless/reversible format. */
  reversibleFormat?: 'exact-text-v1';
  id: string;
  sessionId: string;
  anchorClientId: string;
  provider: TurnChangeProvider;
  providerTurnId: string | null;
  cwd: string;
  state: TurnChangeSetState;
  incompleteReasons: TurnChangeIncompleteReason[];
  createdAt: number;
  completedAt: number;
  unifiedDiff: string;
  files: TurnChangeFileSummary[];
}

/**
 * Reasons that never justify a standalone zero-file review card. Either the
 * capture only "may not have seen everything" without evidence that a change
 * happened (opaque tools ran, the turn failed, another session overlapped), or
 * the affected paths are deliberately out of tracking scope ('outside-workspace':
 * agent temp files, symlink escapes and fail-closed foreign diff blocks all
 * concern content the review UI will never show). Reasons outside this set
 * (diff-too-large, sensitive-file, …) prove in-scope changes existed but were
 * not recorded.
 */
const NO_CHANGE_EVIDENCE_REASONS: ReadonlySet<TurnChangeIncompleteReason> = new Set([
  'opaque-tool',
  'turn-failed',
  'concurrent-workspace',
  'outside-workspace',
]);

/**
 * Whether a summary carries anything a standalone review card can show. Zero-file
 * entries whose reasons carry no change evidence open an empty review pane — hide
 * the chat-stream card instead of sending users into a dead end.
 */
export function hasReviewableTurnChanges(summary: TurnChangeSetSummary): boolean {
  if (summary.fileCount > 0 || summary.files.length > 0) return true;
  return summary.incompleteReasons.some((reason) => !NO_CHANGE_EVIDENCE_REASONS.has(reason));
}

export interface TurnChangeSetUpdatedPayload {
  sessionId: string;
  summary: TurnChangeSetSummary;
}

export interface TurnChangeActionResult {
  action: TurnChangeAction;
  /** False when Main only reconciled a stale sidecar state. */
  changed: boolean;
  summary: TurnChangeSetSummary;
}

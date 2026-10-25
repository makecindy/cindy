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
 * Whether a summary carries file content a standalone review card can show.
 * Incomplete zero-file records remain persisted for diagnostics, but rendering a
 * warning-only card in the chat stream gives the user nothing to inspect or act on.
 */
export function hasReviewableTurnChanges(summary: TurnChangeSetSummary): boolean {
  return summary.fileCount > 0 || summary.files.length > 0;
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

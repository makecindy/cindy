/**
 * Cindy-owned Subagent workspace contract.
 *
 * A `SubagentRun` is the durable, user-visible record in the parent task. It is
 * deliberately separate from a harness-native run/thread/session handle: one
 * Codex spawn may fan out to several child threads, while PI and Claude expose
 * different native identities. Renderer code must use `id`; harness adapters
 * may add opaque `providerRunIds` without changing the product model.
 */

export type SubagentProvider = 'claude-code' | 'codex' | 'pi';

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type SubagentActivityKind =
  | 'started'
  | 'progress'
  | 'message'
  | 'question'
  | 'decision'
  | 'resumed'
  | 'steered'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface SubagentActivityEntry {
  /** Monotonic within one Cindy run. */
  sequence: number;
  kind: SubagentActivityKind;
  status: SubagentRunStatus;
  summary?: string;
  lastToolName?: string;
  occurredAt: number;
}

/**
 * Capability truth is data, not a provider-name switch in the UI. PR1 exposes
 * durable viewing only; later harness integrations can turn on the same fields
 * without changing the sidebar or database shape.
 */
export interface SubagentCapabilities {
  viewActivity: boolean;
  viewReturnedResult: boolean;
  viewFullTranscript: boolean;
  resume: boolean;
  steer: boolean;
  stop: boolean;
  parentContext: 'unknown' | 'snapshot' | 'live';
}

export interface SubagentRunUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface SubagentRun {
  /** Cindy-owned stable id. */
  id: string;
  parentSessionId: string;
  provider: SubagentProvider;
  /** Stable logical card identity inside the parent task. */
  logicalAgentId: string;
  /** Link back to the parent task's spawning tool call. */
  parentToolUseId?: string;
  /** Stable task/tool aliases accepted by the common detail entrance. */
  identityAliases: string[];
  /** Opaque harness-native run/thread ids; never filesystem paths. */
  providerRunIds: string[];
  status: SubagentRunStatus;
  title?: string;
  description?: string;
  summary?: string;
  model?: string;
  reasoningEffort?: string;
  usage?: SubagentRunUsage;
  capabilities: SubagentCapabilities;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type SubagentTranscriptRole = 'parent' | 'subagent' | 'tool' | 'system';

/**
 * Harness-neutral transcript entry. PR1 leaves this capability disabled, but
 * the durable contract is fixed now so PI, Codex and Claude adapters can fill
 * the same detail view without replacing its data model.
 */
export interface SubagentTranscriptEntry {
  id: string;
  sequence: number;
  role: SubagentTranscriptRole;
  content: string;
  occurredAt: number;
  toolName?: string;
}

export interface SubagentRunDetail extends SubagentRun {
  activity: SubagentActivityEntry[];
  /** The result explicitly returned to the parent task, when available. */
  returnedResult?: string;
  returnedResultTruncated?: boolean;
}

/** Provider-scoped lookup for a Cindy run id or harness-native alias. */
export interface SubagentRunDetailRequest {
  sessionId: string;
  provider: SubagentProvider;
  runIdOrAlias: string;
}

/** Lazy transcript contract for long-lived child sessions. */
export interface SubagentTranscriptPageRequest {
  sessionId: string;
  provider: SubagentProvider;
  runIdOrAlias: string;
  /** Opaque provider/resolver cursor returned by the previous page. */
  cursor?: string;
  /** The host clamps this value to a safe range. */
  limit?: number;
}

export interface SubagentTranscriptPageResponse {
  supported: boolean;
  entries: SubagentTranscriptEntry[];
  nextCursor?: string;
}

export interface SubagentRunsListRequest {
  sessionId: string;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
  /** The host clamps this value to a safe range. */
  limit?: number;
}

export interface SubagentRunsListResponse {
  supported: boolean;
  runs: SubagentRun[];
  nextCursor?: string;
}

export interface SubagentRunDetailResponse {
  supported: boolean;
  run: SubagentRunDetail | null;
}

export interface SubagentRunsChangedPayload {
  sessionId: string;
  /** Null invalidates the whole session projection after a clear/rewind boundary. */
  runId: string | null;
  created: boolean;
  /** True only when this is the first visible Subagent record in the task. */
  firstForSession: boolean;
}

export const SUBAGENT_RUNS_CHANGED_CHANNEL = 'local-db:subagent-runs:changed';

export const SUBAGENT_PR1_CAPABILITIES: Readonly<SubagentCapabilities> =
  Object.freeze({
    viewActivity: true,
    viewReturnedResult: true,
    viewFullTranscript: false,
    resume: false,
    steer: false,
    stop: false,
    parentContext: 'unknown',
  });

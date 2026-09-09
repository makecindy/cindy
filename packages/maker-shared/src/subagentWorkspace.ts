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
  parentContext: 'unknown' | 'none' | 'snapshot' | 'live';
}

export interface SubagentRunUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  costUsd?: number;
}

export interface SubagentChildRun {
  id: string;
  /**
   * The same logical child's ids in this run's earlier generations, newest
   * first, excluding `id` itself.
   *
   * A resume starts a new run directory and mints a fresh `childId` for every
   * task it carries over, so the transcript — which is read across generations
   * — labels one continuous child conversation with several ids. The only thing
   * a resumed task keeps is its PI session, so that is what the Host groups by.
   * Absent for a child that has only ever had one id, and for any Host that
   * predates this field; a reader must fall back to matching `id` alone.
   */
  identityAliases?: string[];
  role: string;
  title?: string;
  task?: string;
  status: SubagentRunStatus | 'queued';
  model?: string;
  reasoningEffort?: string;
  usage?: SubagentRunUsage;
  awaitingApproval?: boolean;
  output?: string;
  outputTruncated?: boolean;
  error?: string;
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

/** Lifecycle half of a `role: 'tool'` entry, used to pair one tool card. */
export type SubagentToolPhase = 'start' | 'end';

/** Parent-originated control that produced a `role: 'parent'` entry. */
export type SubagentControlAction = 'steer' | 'follow_up' | 'resume' | 'stop';

/**
 * Harness-neutral transcript entry. PR1 leaves this capability disabled, but
 * the durable contract is fixed now so PI, Codex and Claude adapters can fill
 * the same detail view without replacing its data model.
 *
 * Wire compatibility (device-link): every field below `occurredAt` is optional
 * and additive. An older controlled device simply omits them, and the renderer
 * degrades to the pre-existing "one plain row per entry" rendering; a newer
 * device talking to an older client sends fields the old client ignores.
 * Never repurpose an existing field's meaning here — add another optional one.
 */
export interface SubagentTranscriptEntry {
  id: string;
  sequence: number;
  role: SubagentTranscriptRole;
  content: string;
  occurredAt: number;
  toolName?: string;
  childId?: string;
  childTitle?: string;
  /** Harness-native tool call id; pairs the `start` and `end` halves. */
  toolCallId?: string;
  toolPhase?: SubagentToolPhase;
  /** Serialized tool arguments, already truncated by the producer. */
  toolInputJson?: string;
  /** True when the harness reported this tool call or entry as failed. */
  isError?: boolean;
  controlAction?: SubagentControlAction;
  /**
   * Structured stand-in for a `role: 'system'` line the Host synthesised itself
   * (as opposed to runtime output it merely forwarded).
   *
   * `content` still carries the English sentence, so an older client — and any
   * record written before this field existed — keeps rendering exactly as it
   * did. A client that understands `kind` looks up its own localized string
   * instead, which is the only way these lines can be anything but English in a
   * durable transcript: the text is written once, at synthesis time, and read
   * back long after by a UI in whatever language the user picked.
   *
   * `kind` is a stable slug. Never reuse one for a different sentence — add a
   * new slug, exactly like adding a field here.
   */
  systemEvent?: { kind: string; params?: Record<string, string> };
}

export interface SubagentRunDetail extends SubagentRun {
  activity: SubagentActivityEntry[];
  /** PI durable batches expose their independently addressable children. */
  children?: SubagentChildRun[];
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
  /**
   * Cursor pointing at the position the producer stopped reading, returned even
   * at end of file (where `nextCursor` is absent). Consumers keep it to resume
   * a tail read for appended entries instead of re-reading the whole record.
   * Additive and optional: an older device omits it and the consumer falls back
   * to a full re-read.
   */
  tailCursor?: string;
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

/**
 * PI detached runs are owned by Cindy's durable runner rather than the parent
 * turn. The current product surface exposes exact stop; the runner's internal
 * steer/follow-up protocol stays fail-closed until a reviewed host IPC and UI
 * are connected.
 */
export const PI_DURABLE_SUBAGENT_CAPABILITIES: Readonly<SubagentCapabilities> =
  Object.freeze({
    viewActivity: true,
    viewReturnedResult: true,
    viewFullTranscript: true,
    resume: true,
    steer: true,
    stop: true,
    parentContext: 'unknown',
  });

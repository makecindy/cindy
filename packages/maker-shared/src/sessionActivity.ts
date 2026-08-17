/**
 * Canonical session control-plane status projection.
 *
 * The inputs remain owned by their existing lifecycle authorities (Agent Island,
 * persisted session rows, queue/control state). This module only defines the one
 * read model consumed by UI, MCP probes, and future subscribers.
 */

type OpenValue<Known extends string> = Known | (string & Record<never, never>);

export type SessionActivityPhase = OpenValue<
  'idle' | 'running' | 'needs-interaction' | 'completed' | 'error'
>;

export type SessionRecordStatus = OpenValue<'active' | 'archived' | 'deleted'>;

export type SessionGracefulStopState = OpenValue<
  'none' | 'waiting-for-safe-point' | 'requesting' | 'requested' | 'unconfirmed'
>;

export type SessionActivitySource = OpenValue<'live' | 'persisted' | 'fallback'>;

export type SessionWorkflowWaitTarget = OpenValue<'user' | 'automation' | 'review' | 'merge'>;

export interface SessionWorkflowState {
  /** Stable machine key. Unknown title states retain an open `title:*` key. */
  key: string;
  /** Original user-visible suffix, without rewriting the session title. */
  label: string;
  source: 'title';
  waitingOn?: SessionWorkflowWaitTarget;
}

export interface SessionActivitySnapshot {
  sessionId: string;
  phase: SessionActivityPhase;
  /**
   * Whether the current turn is still actively running. This stays orthogonal
   * to `phase`: a durable/stale error may keep the right-side error status at
   * higher priority while a newer turn continues running.
   *
   * Optional on the wire so older device-link snapshots remain readable.
   */
  currentTurnActive?: boolean;
  recordStatus?: SessionRecordStatus;
  startedAtMs: number | null;
  lastActivityAtMs: number | null;
  currentActionSummary: string | null;
  interactionKind?: string;
  attention: boolean;
  workflow: SessionWorkflowState | null;
  turnGeneration: number | null;
  gracefulStopState: SessionGracefulStopState;
  source: SessionActivitySource;
}

/**
 * Observable edge emitted when a canonical session activity snapshot changes.
 * A null side marks entry to or exit from the live projection.
 */
export interface SessionActivityTransition {
  sessionId: string;
  previous: SessionActivitySnapshot | null;
  current: SessionActivitySnapshot | null;
  changedAtMs: number;
}

export interface SessionActivityProjectionInput {
  sessionId: string;
  recordStatus?: SessionRecordStatus;
  title?: string | null;
  source?: SessionActivitySource;
  livePhase?: SessionActivityPhase | null;
  running?: boolean;
  waitingForUser?: boolean;
  terminal?: 'completed' | 'error' | null;
  startedAtMs?: number | null;
  lastActivityAtMs?: number | null;
  currentActionSummary?: string | null;
  interactionKind?: string;
  attention?: boolean;
  turnGeneration?: number | null;
  gracefulStopState?: SessionGracefulStopState;
}

const WORKFLOW_RULES: readonly {
  key: string;
  waitingOn?: SessionWorkflowWaitTarget;
  matches: (label: string) => boolean;
}[] = [
  { key: 'awaiting-user-decision', waitingOn: 'user', matches: (label) => /等拍板/u.test(label) },
  { key: 'awaiting-acceptance', waitingOn: 'user', matches: (label) => /待验收/u.test(label) },
  { key: 'awaiting-bot', waitingOn: 'automation', matches: (label) => /待\s*bot/iu.test(label) },
  { key: 'awaiting-review', waitingOn: 'review', matches: (label) => /待人审|待审核/u.test(label) },
  { key: 'awaiting-merge', waitingOn: 'merge', matches: (label) => /待合并/u.test(label) },
  { key: 'draft', matches: (label) => /draft/iu.test(label) },
  { key: 'in-progress', matches: (label) => /修\s*review|修复|处理中/u.test(label) },
  { key: 'completed', matches: (label) => /已合并|已关闭|已完成/u.test(label) },
];

function workflowSuffix(title: string): string | null {
  const parts = title.split('·');
  const suffix = (parts.at(-1) ?? '').trim();
  return parts.length > 1 && suffix ? suffix : null;
}

function openWorkflowKey(label: string): string {
  const normalized = label
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '-');
  return `title:${normalized || 'unknown'}`;
}

/** Lift the workflow suffix already carried by the title into a structured facet. */
export function sessionWorkflowFromTitle(title: string | null | undefined): SessionWorkflowState | null {
  if (!title) return null;
  const label = workflowSuffix(title);
  if (!label) return null;
  const rule = WORKFLOW_RULES.find((candidate) => candidate.matches(label));
  return {
    key: rule?.key ?? openWorkflowKey(label),
    label,
    source: 'title',
    ...(rule?.waitingOn ? { waitingOn: rule.waitingOn } : {}),
  };
}

function resolvePhase(input: SessionActivityProjectionInput): SessionActivityPhase {
  if (input.terminal === 'error' || input.livePhase === 'error') return 'error';
  if (input.waitingForUser === true || input.livePhase === 'needs-interaction') {
    return 'needs-interaction';
  }
  if (input.running === true || input.livePhase === 'running') return 'running';
  if (input.terminal === 'completed' || input.livePhase === 'completed') return 'completed';
  if (input.livePhase && input.livePhase !== 'idle') return input.livePhase;
  return 'idle';
}

/** Build the canonical read model without persisting another status copy. */
export function projectSessionActivity(
  input: SessionActivityProjectionInput,
): SessionActivitySnapshot {
  return {
    sessionId: input.sessionId,
    phase: resolvePhase(input),
    currentTurnActive: input.running === true || input.livePhase === 'running',
    ...(input.recordStatus ? { recordStatus: input.recordStatus } : {}),
    startedAtMs: input.startedAtMs ?? null,
    lastActivityAtMs: input.lastActivityAtMs ?? null,
    currentActionSummary: input.currentActionSummary?.trim() || null,
    ...(input.interactionKind ? { interactionKind: input.interactionKind } : {}),
    attention: input.attention === true,
    workflow: sessionWorkflowFromTitle(input.title),
    turnGeneration: input.turnGeneration ?? null,
    gracefulStopState: input.gracefulStopState ?? 'none',
    source: input.source ?? 'fallback',
  };
}

export function isSessionActivityRunning(activity: Pick<SessionActivitySnapshot, 'phase'>): boolean {
  return activity.phase === 'running';
}

export function isSessionActivityWaitingForUser(
  activity: Pick<SessionActivitySnapshot, 'phase'>,
): boolean {
  return activity.phase === 'needs-interaction';
}

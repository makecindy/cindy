/**
 * The task card of a V1 teammate background task ("delegation"). V2 teammates open ordinary tasks
 * with send_to_session; nothing creates or advances these any more. Hosts still list the existing
 * rows read-only (`maker:bot-delegations:list`) so old task cards and glance outputs stay readable.
 * Older hosts answer the same shape live.
 *
 *   queued → running ⇄ waiting → completed | failed | cancelled
 *
 * A row that was still queued/running/waiting at upgrade keeps that stored status; its child is an
 * ordinary task now, so clients show its real runtime state instead.
 */
export type BotDelegationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Timeouts were stored as failed + a TIMEOUT error; the view reports them as timed out. */
  | 'timed-out';

/** What a waiting task was waiting for. Hosts without live tasks send null. */
export interface BotDelegationPendingInteraction {
  requestId: string;
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  summary: string;
  raisedAt: number;
}

/** A file the child task produced (relative path + absolute path on its host). */
export interface BotDelegationArtifact {
  path: string;
  absolutePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface BotDelegationView {
  id: string;
  requestingBotId: string;
  /** null = an ordinary Cindy task. */
  targetBotId: string | null;
  targetBotName: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  /** The actual child Session title, including a caller-supplied task name. */
  title: string;
  objective: string;
  contextRefs: string[];
  permissionSnapshot: Record<string, unknown>;
  lineage: string[];
  targetProfileVersion: number | null;
  depth: number;
  status: BotDelegationStatus;
  pendingInteraction: BotDelegationPendingInteraction | null;
  resultSummary: string | null;
  /** Remote task cards omit host-only absolute paths. Local artifacts retain them. */
  artifacts: Array<Omit<BotDelegationArtifact, 'absolutePath'> & { absolutePath?: string }>;
  lastError: string | null;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export type BotDelegationListResult =
  | { ok: true; delegations: BotDelegationView[] }
  | { ok: false; errorCode: string; message: string };

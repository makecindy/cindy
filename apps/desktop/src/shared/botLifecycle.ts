import type { ConversationSearchResponse } from './conversationSearch';
import type { BotFailureReason } from './botFailureReason';

export type BotHealthStatus = 'healthy' | 'attention' | 'recovering' | 'paused';

export type BotProfileLifecycleStatus =
  | 'active'
  | 'paused'
  | 'error'
  | 'archived'
  | 'deleting';

export type BotLifecycleAction = 'pause' | 'resume' | 'delete';

export type BotWorktreeDisposition = 'recycle' | 'retain';

export interface BotLifecycleActionRequest {
  botId: string;
  action: BotLifecycleAction;
  /** Required for permanent deletion; compared in main against the current name. */
  confirmName?: string;
  /** Delete only. Recycle is safe and preserves the git branch. */
  worktreeDisposition?: BotWorktreeDisposition;
  /** Delete only. Retained task transcripts become archived standalone tasks. */
  keepTaskHistory?: boolean;
}

export interface BotLifecycleActionResult {
  botId: string;
  action: BotLifecycleAction;
  status: BotProfileLifecycleStatus | 'deleted';
  affected: {
    sessions: number;
    routes: number;
    automations: number;
    delegations: number;
    deliveries: number;
    worktrees: number;
  };
  warnings?: string[];
}

export type BotHealthIssueCode =
  | 'profile-error'
  | 'missing-canonical'
  | 'canonical-session-missing'
  | 'canonical-session-deleted'
  | 'canonical-link-missing'
  | 'canonical-link-mismatch'
  | 'profile-update-pending'
  | 'runtime-degraded'
  | 'runtime-failed'
  | 'routes-recovering'
  | 'routes-error'
  | 'automation-error'
  | 'delivery-failed'
  | 'delivery-dead-letter'
  | 'workspace-error'
  | 'durable-attention'
  | 'lifecycle-incomplete';

export interface BotHealthIssue {
  code: BotHealthIssueCode;
  count?: number;
}

export interface BotHealthReport {
  botId: string;
  status: BotHealthStatus;
  checkedAt: number;
  failureReason: BotFailureReason | null;
  needsAttention: boolean;
  canonical: {
    sessionId: string | null;
    sessionStatus: 'active' | 'archived' | 'deleted' | 'missing' | null;
    linked: boolean;
    profileVersion: number | null;
    runtimeStatus: 'not-started' | 'prepared' | 'applied' | 'degraded' | 'failed';
  };
  counts: {
    routes: number;
    recoveringRoutes: number;
    errorRoutes: number;
    automations: number;
    errorAutomations: number;
    deliveries: number;
    failedDeliveries: number;
    deadLetterDeliveries: number;
    workspaceLeases: number;
    errorWorkspaceLeases: number;
  };
  issues: BotHealthIssue[];
}

export interface BotLifecycleEventView {
  id: string;
  botId: string;
  sessionId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface BotHistorySearchRequest {
  botId: string;
  query: string;
  limit?: number;
}

export type BotHistorySearchResponse = ConversationSearchResponse;

import type { ConversationSearchResponse } from './conversationSearch';

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

export interface BotHistorySearchRequest {
  botId: string;
  query: string;
  limit?: number;
}

export type BotHistorySearchResponse = ConversationSearchResponse;

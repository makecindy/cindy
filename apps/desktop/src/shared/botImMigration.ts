import type {
  BotChannelConnection,
  BotChannelOwnership,
} from './botChannelRegistry';

export type BotImMigrationConflictCode =
  | 'connection-unavailable'
  | 'connection-not-routable'
  | 'channel-owned-by-another-bot'
  | 'session-owned-by-another-bot'
  | 'session-role-conflict'
  | 'im-takeover-active'
  | 'ambiguous-legacy-binding'
  | 'route-overlap'
  | 'channel-busy';

export type BotImMigrationWarningCode =
  | 'connection-offline'
  | 'no-legacy-tasks';

export interface BotImMigrationWarning {
  code: BotImMigrationWarningCode;
}

export interface BotImMigrationConflict {
  code: BotImMigrationConflictCode;
  message: string;
  sessionId?: string;
  botId?: string;
}

export interface BotImMigrationCandidate {
  sessionId: string;
  title: string;
  status: 'active' | 'archived';
  source: string;
  updatedAt: number;
  alreadyLinked: boolean;
}

export interface BotImMigrationPlan {
  botId: string;
  connection: BotChannelConnection;
  channelId: string;
  routeKey: 'default';
  planHash: string;
  candidates: BotImMigrationCandidate[];
  conflicts: BotImMigrationConflict[];
  warnings: BotImMigrationWarning[];
  alreadyMounted: boolean;
  canApply: boolean;
}

export interface BotImMigrationRecord {
  id: string;
  requestId: string;
  botId: string;
  channelId: string;
  routeId: string;
  connectionId: string;
  ownership: BotChannelOwnership;
  kind: BotChannelConnection['kind'];
  accountKey: string;
  planHash: string;
  status: 'applying' | 'applied' | 'rolling-back' | 'rolled-back' | 'failed';
  migratedSessionCount: number;
  createdAt: number;
  appliedAt?: number;
  rolledBackAt?: number;
  warnings?: Array<{
    code: 'binding-restore-conflict';
    count: number;
  }>;
}

export interface ApplyBotImMigrationInput {
  botId: string;
  connectionId: string;
  planHash: string;
  requestId: string;
}

export interface RollbackBotImMigrationInput {
  migrationId: string;
}

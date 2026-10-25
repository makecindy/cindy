import type { createMessageWriter } from '@cindy/runtime-db/messageWriter';
import type { createCodexPlanStore } from '@cindy/runtime-db/codexPlanState';
import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { NativeToolMedia, ProcessMediaRef } from '@cindy/maker-shared/tool-process-media';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import type { AgentMeta, Message } from './sessionTypes.js';
import type { OwnerBroadcastTap, DataOwnerBroadcastScope, BroadcastLocal } from './ownerBroadcast.js';

export interface ToolMediaOrigin {
  workdir: string;
  remoteHostId: string | null;
}

export interface MessagePersistenceHost {
  logger: DbLogger;
  getDbClient(): DbClient;
  broadcastTap: OwnerBroadcastTap;
  broadcastLocal: BroadcastLocal;
  createDbMessage: ReturnType<typeof createMessageWriter<DataOwnerBroadcastScope, AgentMeta>>['createMessage'];
  broadcastMessageRow(sessionId: string, message: Message, owner?: DataOwnerBroadcastScope | null): void;
  broadcastMessageDeleted(payload: { sessionId: string; clientId: string; clientIds?: string[] }, owner?: DataOwnerBroadcastScope | null): void;
  discardPersistedAssistantMessage(sessionId: string, clientId: string, isCurrent: () => boolean): Promise<boolean>;
  broadcastMessageAgentMetaUpdate(sessionId: string, clientId: string, owner?: DataOwnerBroadcastScope | null): Promise<boolean>;
  findVisibleToolUseMessageByAliases(sessionId: string, aliases: readonly string[]): Promise<{ clientId: string; toolUseId: string } | null>;
  patchMessageAgentMetaWithResult(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<{
    previous: Record<string, unknown>; next: Record<string, unknown>;
  } | null>;
  updateDbMessageContent(sessionId: string, clientId: string, content: unknown,
    autoReviewAnswer?: { text: string; acceptedAt: number }, finalSnapshot?: { isCurrent: () => boolean }): Promise<Message | null>;
  codexPlan: Pick<ReturnType<typeof createCodexPlanStore>, 'markCodexPlanInterrupted' | 'writeCodexPlanTerminal' | 'writeCodexPlanUpdate'>;
  getSubagentRunDetail(sessionId: string, provider: 'claude-code' | 'codex' | 'pi', taskId: string): Promise<{ parentToolUseId?: string | null } | null | undefined>;
  commitMessageMediaRefs(input: { sessionId: string; role: string; content: string }): Promise<unknown>;
  takeMediaToolResult(input: unknown): string | null;
  getSessionProvider(sessionId: string): string | undefined | null;
  materializeToolProcessMedia(items: NativeToolMedia[], db: DbClient['drizzle'], assertStillValid: () => void, origin?: ToolMediaOrigin): Promise<ProcessMediaRef[]>;
  readTaskResultsForReply(sessionId: string, replyClientId: string, inputClientIds: readonly string[]): Promise<BotCollaborationMeta[]>;
}

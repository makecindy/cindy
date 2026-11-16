import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { isAutoResumeUserMessage } from './interruptedTurnAutoResume.js';
import { recordTurnModelChange, type TurnModelIdentity } from './turnModelChange.js';
import type { AgentKind } from '@cindy/maker-core';

/** What the turn-model attribution reads and writes through (the desktop: register.ts send transaction). */
export interface TurnModelAttributionPorts<Owner> {
  maker: { getSession(sessionId: string): { agentKind: AgentKind; model: string } | undefined | null };
  getSessionProvider(sessionId: string): string | null;
  captureDataOwnerBroadcastScope(): Owner;
  isDataOwnerBroadcastScopeCurrent(owner: Owner): boolean;
  enqueueDurableWrite(label: string, write: () => Promise<void>): Promise<unknown>;
  patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<boolean>;
  createDbMessage(sessionId: string, body: {
    clientId: string; role: 'assistant'; content: string; agentMeta: Record<string, unknown>;
    agentKind: ReturnType<typeof makerToDbAgentKind>; createdAt: number;
  }): Promise<unknown>;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * The send transaction's onModelDispatched: once a user turn is dispatched, record which model ran
 * it and, when it differs from the previous turn's, a model-change card (turnModelChange.ts).
 */
export function createTurnModelAttribution<Owner>({
  maker, getSessionProvider, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent,
  enqueueDurableWrite, patchMessageAgentMeta, createDbMessage, log,
}: TurnModelAttributionPorts<Owner>): (sessionId: string, clientId: string) => void {
  return (sessionId, clientId) => {
    const live = maker.getSession(sessionId);
    if (!live) return;
    const current: TurnModelIdentity = {
      agentKind: live.agentKind, model: live.model, providerId: getSessionProvider(sessionId),
    };
    const owner = captureDataOwnerBroadcastScope();
    const db = getDbClient().drizzle;
    const createdAt = Date.now();
    void enqueueDurableWrite(`turn-model:${sessionId}:${clientId}`, async () => {
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
      const [input] = await db.select({ content: messages.content, meta: messages.agentMeta }).from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId),
          eq(messages.role, 'user'), isNull(messages.rewindAt))).limit(1);
      if (!input) return;
      await recordTurnModelChange(current, {
        input: { content: input.content, autoResume: isAutoResumeUserMessage(input.meta ? JSON.parse(input.meta) : null) },
        readPrevious: async () => {
          const [previous] = await db.select({ meta: messages.agentMeta }).from(messages)
            .innerJoin(sessions, eq(sessions.id, messages.sessionId))
            .where(and(
              eq(messages.sessionId, sessionId), eq(messages.role, 'user'),
              sql`${messages.clientId} <> ${clientId}`, isNull(messages.rewindAt),
              or(isNull(sessions.clearedAt), sql`${messages.createdAt} > ${sessions.clearedAt}`),
              sql`CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.executionModel') END IS NOT NULL`,
            )).orderBy(desc(messages.createdAt), desc(sql`${messages}.rowid`)).limit(1);
          return previous?.meta
            ? (JSON.parse(previous.meta) as { executionModel?: TurnModelIdentity }).executionModel ?? null
            : null;
        },
        record: async (executionModel) => isDataOwnerBroadcastScopeCurrent(owner) &&
          await patchMessageAgentMeta(sessionId, clientId, { executionModel }),
        publish: async (modelChange) => {
          if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
          await createDbMessage(sessionId, {
            clientId: `model-change:${clientId}`, role: 'assistant', content: '',
            agentMeta: { modelChange }, agentKind: makerToDbAgentKind(current.agentKind), createdAt,
          });
        },
      });
    }).catch((error) => log.warn('turn model attribution failed', { sessionId, error }));
  };
}

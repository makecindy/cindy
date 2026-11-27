import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { parseImDefaultRouteRecord } from '../im/shared/channelDefaultRoute.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { makerToDbEngineKind } from '../../shared/agentKindConversion.js';
import { isAutoResumeUserMessage } from './interruptedTurnAutoResume.js';
import { recordTurnModelChange, type TurnModelIdentity } from './turnModelChange.js';
import type { EngineKind } from '@cindy/maker-core';

/** What the turn-model attribution reads and writes through (the desktop: register.ts send transaction). */
export interface TurnModelAttributionPorts<Owner> {
  maker: { getSession(sessionId: string): { agentKind: EngineKind; model: string; remoteHostId?: string | null; agentDeviceId?: string | null } | undefined | null };
  captureModelChoice?(model: string, harness?: string): ((automatic?: boolean) => Promise<void>) | undefined;
  getSessionProvider(sessionId: string): string | null;
  captureDataOwnerBroadcastScope(): Owner;
  isDataOwnerBroadcastScopeCurrent(owner: Owner): boolean;
  enqueueDurableWrite(label: string, write: () => Promise<void>): Promise<unknown>;
  patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<boolean>;
  createDbMessage(sessionId: string, body: {
    clientId: string; role: 'assistant'; content: string; agentMeta: Record<string, unknown>;
    agentKind: ReturnType<typeof makerToDbEngineKind>; createdAt: number;
  }): Promise<unknown>;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

// resolvedImDefaultFingerprint wraps the raw settings fingerprint when a channel
// picked the model automatically. A manual override or a different live route wins.
function channelChoseModel(raw: string | null, current: TurnModelIdentity) {
  const record = parseImDefaultRouteRecord(raw);
  if (!record || record.manual || record.route.model !== current.model || record.route.agentKind !== current.agentKind
    || record.route.providerId !== current.providerId) return false;
  try {
    const fields: unknown = JSON.parse(record.fp);
    return Array.isArray(fields) && fields.length === 5 && typeof fields[0] === 'string'
      && fields[0].startsWith('[') && fields[1] === current.agentKind && fields[2] === current.model;
  } catch {
    return false;
  }
}

/**
 * The send transaction's onModelDispatched: once a user turn is dispatched, record which model ran
 * it and, when it differs from the previous turn's, a model-change card (turnModelChange.ts).
 */
export function createTurnModelAttribution<Owner>({
  maker, captureModelChoice, getSessionProvider, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent,
  enqueueDurableWrite, patchMessageAgentMeta, createDbMessage, log,
}: TurnModelAttributionPorts<Owner>): (sessionId: string, clientId: string) => void {
  return (sessionId, clientId) => {
    const live = maker.getSession(sessionId);
    if (!live) return;
    const current: TurnModelIdentity = {
      agentKind: live.agentKind, model: live.model, providerId: getSessionProvider(sessionId),
    };
    const recordChoice = live.agentKind !== 'acp' && !live.remoteHostId && !live.agentDeviceId ? captureModelChoice?.(live.model, live.agentKind) : undefined;
    const owner = captureDataOwnerBroadcastScope();
    const db = getDbClient().drizzle;
    const createdAt = Date.now();
    void enqueueDurableWrite(`turn-model:${sessionId}:${clientId}`, async () => {
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
      const [input] = await db.select({ content: messages.content, meta: messages.agentMeta, route: sessions.imDefaultRoute }).from(messages)
        .innerJoin(sessions, eq(sessions.id, messages.sessionId))
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId),
          eq(messages.role, 'user'), isNull(messages.rewindAt))).limit(1);
      if (!input) return;
      const autoResume = isAutoResumeUserMessage(input.meta ? JSON.parse(input.meta) : null);
      await recordTurnModelChange(current, {
        input: { content: input.content, autoResume },
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
        record: async (executionModel) => {
          if (!isDataOwnerBroadcastScopeCurrent(owner) || !await patchMessageAgentMeta(sessionId, clientId, { executionModel })) return false;
          if (!autoResume) void recordChoice?.(channelChoseModel(input.route, current)).catch(() => log.warn('model choice reporting deferred'));
          return true;
        },
        publish: async (modelChange) => {
          if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
          await createDbMessage(sessionId, {
            clientId: `model-change:${clientId}`, role: 'assistant', content: '',
            agentMeta: { modelChange }, agentKind: makerToDbEngineKind(current.agentKind), createdAt,
          });
        },
      });
    }).catch((error) => log.warn('turn model attribution failed', { sessionId, error }));
  };
}

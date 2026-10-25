import {and,eq} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {messages,sessions} from '@cindy/runtime-db/schema';
import type {AgentRequestReceipt} from '@cindy/maker-shared/forwarded-request-types';
import type {AgentInputQueuedMessage} from '@cindy/maker-shared/agent-input-queue';
import {resolveBotAuthorizationDelivery,type BotAuthorizationInputGuard} from './botAuthorizationDelivery.js';
import {sessionQueueOriginForDispatcher} from './sessionQueueOrigin.js';
import type {AgentInputCoordinator} from './agent-input-coordinator.js';
import type {createSessionControlInputBuilder} from './sessionControlInput.js';
import type {createQueuedDispatchReceipts} from './queuedDispatchReceipts.js';
export type BotSessionMessage = {
    autoReviewUserText?: AgentRequestReceipt;
    targetSessionId: string;
    dispatcherSessionId?: string;
    authorizationGuard?: BotAuthorizationInputGuard;
    toolsDisabled?: boolean;
    retry?: boolean;
    onQueued?: (clientId: string) => Promise<void>;
    message: string;
    persistedContent?: string;
    clientId?: string;
    files?: AgentInputQueuedMessage['files'];
    onAccepted?: (replayed?: boolean) => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    /**
     * Remote-origin input and Bot Session tasks: a cold session resumes with its stored
     * permission mode (and Plan), never bypass.
     */
    resumeWithStoredPermissionMode?: boolean;
  };
export function createBotSessionDispatcher<Meta,Result>(host:{
 getDbClient():DbClient;
 maker:{getSessionMeta(id:string):Promise<Meta|null>};
 getSessionRowSnapshot(id:string):Promise<{status:string}|null>;
 getInputCoordinator():Pick<AgentInputCoordinator,'ensureQueueRestored'|'isQueueRestored'|'hasPendingQueueItem'|'hasQueuedItemWhere'|'remove'|'enqueue'>;
 createId():string;
 buildSessionControlInputItem:ReturnType<typeof createSessionControlInputBuilder<Meta>>;
 readSenderIdentity(id:string|undefined):Promise<Pick<Parameters<typeof sessionQueueOriginForDispatcher>[0],'dispatcherSessionTitle'|'dispatcherBot'>>;
 welcomeDispatchReceipts:ReturnType<typeof createQueuedDispatchReceipts>;
 sendToSessionInternal(params:BotSessionMessage):Promise<Result>;
}) {
 const {getDbClient,maker,getSessionRowSnapshot,getInputCoordinator,createId,buildSessionControlInputItem,readSenderIdentity,welcomeDispatchReceipts,sendToSessionInternal}=host;
 return async (params:BotSessionMessage)=>{

    if (params.clientId && params.authorizationGuard) {
      const delivery = await resolveBotAuthorizationDelivery(params.clientId, async (clientId) => {
        const [row] = await getDbClient().drizzle
          .select({ id: messages.id, createdAt: messages.createdAt, rewindAt: messages.rewindAt, clearedAt: sessions.clearedAt })
          .from(messages).innerJoin(sessions, eq(sessions.id, messages.sessionId))
          .where(and(eq(messages.sessionId, params.targetSessionId), eq(messages.clientId, clientId)))
          .limit(1);
        return row ?? null;
      });
      params = { ...params, clientId: delivery.clientId };
      if (delivery.delivered) {
        await params.authorizationGuard!.validate();
        params.authorizationGuard!.assertCurrent();
        await params.onAccepted?.();
        return { ok: true as const, targetSessionId: params.targetSessionId, wakeKind: 'already-active' as const };
      }
    } else if (params.clientId) {
      const [persisted] = await getDbClient()
        .drizzle.select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, params.targetSessionId),
            eq(messages.clientId, params.clientId),
          ),
        )
        .limit(1);
      // A user row is written BEFORE provider acceptance. After an interrupted
      // attempt it cannot prove delivery; retain the invitation for explicit retry.
      if (persisted && params.toolsDisabled && !params.retry) {
        return { ok: false as const, errorCode: 'AGENT_NOT_READY' as const, message: 'Previous welcome acceptance is unconfirmed; retry is required.' };
      }
      if (persisted && !params.toolsDisabled) {
        await params.onAccepted?.(true);
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      }
    }
    if (params.files?.length || params.toolsDisabled === true) {
      const [meta, dbRow] = await Promise.all([
        maker.getSessionMeta(params.targetSessionId).catch(() => null),
        getSessionRowSnapshot(params.targetSessionId),
      ]);
      if (!meta || !dbRow || dbRow.status === 'deleted') {
        return {
          ok: false as const,
          errorCode: 'NOT_FOUND' as const,
          message: `session ${params.targetSessionId} not found`,
        };
      }
      if (dbRow.status === 'archived') {
        return {
          ok: false as const,
          errorCode: 'ARCHIVED' as const,
          message: `session ${params.targetSessionId} is archived`,
        };
      }
      await getInputCoordinator().ensureQueueRestored(params.targetSessionId).catch(() => undefined);
      if (params.toolsDisabled && !getInputCoordinator().isQueueRestored(params.targetSessionId)) {
        throw new Error('INVITATION_QUEUE_UNAVAILABLE');
      }
      // An explicit retry must not hit the failed attempt's recent-client dedupe.
      // Checkpoint the new id before enqueue, and retire only the prior hidden
      // welcome's pending item (never an active turn or another user's input).
      const clientId = params.toolsDisabled ? createId() : params.clientId ?? createId();
      if (params.toolsDisabled) await params.onQueued?.(clientId);
      if (params.toolsDisabled && params.clientId && getInputCoordinator().hasPendingQueueItem(params.targetSessionId, params.clientId)
        && getInputCoordinator().hasQueuedItemWhere(params.targetSessionId, item => item.clientId === params.clientId && item.toolsDisabled === true)) {
        getInputCoordinator().remove(params.targetSessionId, params.clientId);
      }
      const queued = await buildSessionControlInputItem({
        targetSessionId: params.targetSessionId,
        message: params.message,
        persistedContent: params.persistedContent ?? params.message,
        clientId,
        meta,
        files: params.files,
        autoReviewUserText: params.autoReviewUserText,
        ...(params.toolsDisabled === true ? { toolsDisabled: true } : {}),
        origin: sessionQueueOriginForDispatcher({
          dispatcherSessionId: params.dispatcherSessionId,
          ...(await readSenderIdentity(params.dispatcherSessionId)),
          message: params.message,
        }),
      });
      const enqueue = () => getInputCoordinator().enqueue(params.targetSessionId, queued, {
        resumeRestorePausedQueue: true,
      });
      if (params.toolsDisabled) {
        if (!await welcomeDispatchReceipts.dispatch(params.targetSessionId, clientId, enqueue)) {
          return { ok: false as const, errorCode: 'AGENT_NOT_READY' as const, message: 'Welcome turn was not accepted by the runtime.' };
        }
      } else {
        enqueue();
      }
      await params.onAccepted?.();
      return {
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
        queuedMessageId: clientId,
      };
    }
    return sendToSessionInternal({ ...params, onAccepted: () => params.onAccepted?.() });

 };
}

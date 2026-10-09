import type {
  AgentKind,
  Effort,
  SessionGracefulStopResult,
  SessionTurnControlSnapshot,
} from '@cindy/maker-core';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';

import type {
  PendingSessionRuntimeMutation,
  SessionRuntimeProfile,
} from './sessionRuntimeControl.js';

import {
  updateQueuedMessageText,
  type AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';
import {
  createSessionQueueControlService,
  type QueuedSteerOutcome,
  type SessionQueueMoveResult,
  type SessionQueueSteerResult,
} from './sessionQueueControl.js';

type Failure<Code extends string> = { ok: false; errorCode: Code; message: string };

export type SessionQueuedMessageControlResult =
  | { ok: true; queuedMessageId: string }
  | Failure<
      | 'NOT_FOUND'
      | 'QUEUED_MESSAGE_NOT_FOUND'
      | 'MESSAGE_CONSUMING'
      | 'NOT_AUTHORIZED'
      | 'INVALID_ARGS'
    >;

export type SessionSteerResult =
  | { ok: true; queuedMessageId: string }
  | Failure<'NOT_FOUND' | 'NO_ACTIVE_TURN' | 'UNSUPPORTED_CAPABILITY' | 'DELIVERY_FAILED'>;

export type SessionStopResult =
  | {
      ok: true;
      status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed';
      turnGeneration?: number;
      reason?: string;
    }
  | Failure<'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY'>;

export interface SessionRuntimeDetails extends SessionActivitySnapshot {
  runtimeGeneration: number;
  baselineProfile: SessionRuntimeProfile;
  effectiveProfile: SessionRuntimeProfile;
  pendingMutation: PendingSessionRuntimeMutation | null;
  fallbackEnabled: boolean;
}

export type SessionRuntimeResult =
  { ok: true; runtime: SessionRuntimeDetails } | Failure<'NOT_FOUND'>;

export type SessionRuntimeSetResult =
  | {
      ok: true;
      status: 'applied' | 'deferred';
      effectiveBoundary?: 'next_send';
      generation: number;
      effectiveProfile: SessionRuntimeProfile;
      pendingMutation: PendingSessionRuntimeMutation | null;
    }
  | Failure<'NOT_FOUND' | 'CONFLICT' | 'INVALID_ARGS' | 'ROUTE_UNAVAILABLE'>;

export interface SessionControlLiveSession {
  agentKind: AgentKind;
  capabilities: { sameTurnSteer: { supported: boolean } };
  isTurnRunning(): boolean;
  getTurnGeneration(): number;
  requestGracefulStop(): Promise<SessionGracefulStopResult>;
  getTurnControlSnapshot(): SessionTurnControlSnapshot;
}

export interface SessionSteerTurnIdentity {
  session: SessionControlLiveSession;
  turnGeneration: number;
  beforeMutation?: () => Promise<void>;
}

export interface SessionControlServiceDeps {
  sessionExists(sessionId: string): Promise<boolean>;
  getLiveSession(sessionId: string): SessionControlLiveSession | null;
  getSessionActivitySnapshot(sessionId: string): Promise<SessionActivitySnapshot>;
  getSessionRuntimeDetails(sessionId: string): Promise<SessionRuntimeDetails>;
  setSessionRuntime(params: {
    targetSessionId: string;
    expectedGeneration?: number;
    beforeMutation?: () => Promise<void>;
    patch: {
      harness?: AgentKind;
      model?: string;
      providerId?: string | null;
      effort?: Effort | null;
      fastMode?: boolean;
    };
  }): Promise<SessionRuntimeSetResult>;
  assertExternalInputAllowed(sessionId: string): Promise<void>;
  createQueuedMessage(params: {
    targetSessionId: string;
    callerSessionId: string;
    queuedMessageId: string;
    message: string;
  }): Promise<AgentInputQueuedMessage>;
  steerQueuedMessage(
    sessionId: string,
    item: AgentInputQueuedMessage,
    expectedTurn: SessionSteerTurnIdentity,
  ): Promise<boolean>;
  getQueueSnapshot(sessionId: string): Promise<{
    pendingQueue: AgentInputQueuedMessage[];
    consumingClientIds: string[];
  }>;
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage, expected?: AgentInputQueuedMessage): boolean;
  removeQueuedMessage(sessionId: string, clientId: string, expected?: AgentInputQueuedMessage): boolean;
  steerStoredQueuedMessage(sessionId: string, clientId: string): Promise<QueuedSteerOutcome>;
  moveQueuedMessage(sessionId: string, clientId: string, position: number): number | null | 'locked';
  createId(): string;
}

export function createSessionControlService(deps: SessionControlServiceDeps) {
  const queueControl = createSessionQueueControlService({
    getSnapshot: deps.getQueueSnapshot,
    replaceQueuedMessage: deps.replaceQueuedMessage,
    removeQueuedMessage: deps.removeQueuedMessage,
    steerQueuedMessage: deps.steerStoredQueuedMessage,
    moveQueuedMessage: deps.moveQueuedMessage,
  });

  async function ensureTarget(sessionId: string): Promise<Failure<'NOT_FOUND'> | null> {
    // A live Session is authoritative even when its persisted metadata is temporarily
    // unavailable. Only a successful metadata lookup may classify the target as absent.
    if (deps.getLiveSession(sessionId)) return null;
    return (await deps.sessionExists(sessionId))
      ? null
      : { ok: false, errorCode: 'NOT_FOUND', message: `session ${sessionId} not found` };
  }

  return {
    async updateQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
      /** Host-only authorization check after async reads, immediately before mutation. */
      beforeMutation?: () => Promise<void>;
      message: string;
    }): Promise<SessionQueuedMessageControlResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.update({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        message: params.message,
        authorize: (item) => authorizeSessionQueueItem(item, params.callerSessionId),
        beforeMutation: params.beforeMutation,
        rebuild: rebuildSessionQueueItem,
      });
    },

    async cancelQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
      /** Host-only authorization check after async reads, immediately before mutation. */
      beforeMutation?: () => Promise<void>;
    }): Promise<SessionQueuedMessageControlResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.cancel({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        authorize: (item) => authorizeSessionQueueItem(item, params.callerSessionId),
        beforeMutation: params.beforeMutation,
      });
    },

    async steerQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
    }): Promise<SessionQueueSteerResult | Failure<'NOT_FOUND'>> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.steer({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        authorize: (item) =>
          authorizeSessionQueueReorder(item, params.callerSessionId, params.targetSessionId),
      });
    },

    async moveQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
      position: number;
    }): Promise<SessionQueueMoveResult | Failure<'NOT_FOUND'>> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.move({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        position: params.position,
        authorize: (item) =>
          authorizeSessionQueueReorder(item, params.callerSessionId, params.targetSessionId),
      });
    },

    async steerSession(params: {
      callerSessionId: string;
      targetSessionId: string;
      message: string;
      /** Host-owned stable ID; the input coordinator owns acceptance deduplication. */
      queuedMessageId?: string;
      beforeMutation?: () => Promise<void>;
    }): Promise<SessionSteerResult> {
      const missing = await ensureTarget(params.targetSessionId);
      await params.beforeMutation?.();
      if (missing) return missing;
      try {
        await deps.assertExternalInputAllowed(params.targetSessionId);
      } catch (error) {
        await params.beforeMutation?.();
        if ((error as { code?: unknown }).code === 'UNSUPPORTED_CAPABILITY') {
          return {
            ok: false,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      }
      await params.beforeMutation?.();
      const live = deps.getLiveSession(params.targetSessionId);
      if (!live?.isTurnRunning()) {
        return {
          ok: false,
          errorCode: 'NO_ACTIVE_TURN',
          message: `session ${params.targetSessionId} has no active turn`,
        };
      }
      if (!live.capabilities.sameTurnSteer.supported) {
        return {
          ok: false,
          errorCode: 'UNSUPPORTED_CAPABILITY',
          message: `agent ${live.agentKind} does not support same-turn steer`,
        };
      }
      const turnGeneration = live.getTurnGeneration();
      const queuedMessageId = params.queuedMessageId ?? deps.createId();
      const item = await deps.createQueuedMessage({
        ...params,
        queuedMessageId,
      });
      await params.beforeMutation?.();
      const current = deps.getLiveSession(params.targetSessionId);
      if (
        current !== live ||
        !current.isTurnRunning() ||
        current.getTurnGeneration() !== turnGeneration
      ) {
        return {
          ok: false,
          errorCode: 'NO_ACTIVE_TURN',
          message: `session ${params.targetSessionId} changed turns before steer was accepted`,
        };
      }
      const expectedTurn = { session: live, turnGeneration, ...(params.beforeMutation ? { beforeMutation: params.beforeMutation } : {}) };
      const accepted = await deps.steerQueuedMessage(params.targetSessionId, item, expectedTurn);
      if (!accepted) {
        const latest = deps.getLiveSession(params.targetSessionId);
        return latest === live &&
          latest.isTurnRunning() &&
          latest.getTurnGeneration() === turnGeneration
          ? {
              ok: false,
              errorCode: 'DELIVERY_FAILED',
              message: 'steer was not accepted at the current input boundary',
            }
          : {
              ok: false,
              errorCode: 'NO_ACTIVE_TURN',
              message: `session ${params.targetSessionId} turn ended before steer was accepted`,
            };
      }
      return { ok: true, queuedMessageId };
    },

    async stopSessionTurn(params: { targetSessionId: string; beforeMutation?: () => Promise<void> }): Promise<SessionStopResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (params.beforeMutation) await params.beforeMutation();
      if (missing) return missing;
      const live = deps.getLiveSession(params.targetSessionId);
      if (!live) return { ok: true, status: 'no-active-turn' };
      const result = await live.requestGracefulStop();
      if (result.status === 'unsupported') {
        return {
          ok: false,
          errorCode: 'UNSUPPORTED_CAPABILITY',
          message: `agent ${live.agentKind} does not support graceful stop`,
        };
      }
      return {
        ok: true,
        status: result.status,
        ...('turnGeneration' in result ? { turnGeneration: result.turnGeneration } : {}),
        ...('reason' in result ? { reason: result.reason } : {}),
      };
    },

    async getSessionRuntime(params: { targetSessionId: string }): Promise<SessionRuntimeResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      const [activity, details] = await Promise.all([
        deps.getSessionActivitySnapshot(params.targetSessionId),
        deps.getSessionRuntimeDetails(params.targetSessionId),
      ]);
      const control = deps.getLiveSession(params.targetSessionId)?.getTurnControlSnapshot();
      return {
        ok: true,
        runtime: {
          ...details,
          ...activity,
          turnGeneration: control?.turnGeneration ?? null,
          gracefulStopState: control?.gracefulStopState ?? 'none',
        },
      };
    },

    async setSessionRuntime(params: {
      targetSessionId: string;
      expectedGeneration?: number;
      beforeMutation?: () => Promise<void>;
      patch: {
        harness?: AgentKind;
        model?: string;
        providerId?: string | null;
        effort?: Effort | null;
        fastMode?: boolean;
      };
    }): Promise<SessionRuntimeSetResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (params.beforeMutation) await params.beforeMutation();
      if (missing) return missing;
      return deps.setSessionRuntime(params);
    },
  };
}

export function authorizeSessionQueueItem(
  item: AgentInputQueuedMessage,
  callerSessionId: string,
): { ok: true } | { ok: false; message: string } {
  return item.origin?.kind === 'session' && item.origin.senderSessionId === callerSessionId
    ? { ok: true }
    : { ok: false, message: 'queued message was not sent by the current session' };
}

/**
 * 插话 / 排序不改正文：除了自己投递的消息，任务还可以处理自己队列里由其它任务或协同
 * 成员发来的机器消息。用户手打、伙伴委派、插件与定时任务的条目有各自的接受簿记，不开放。
 */
export function authorizeSessionQueueReorder(
  item: AgentInputQueuedMessage,
  callerSessionId: string,
  targetSessionId: string,
): { ok: true } | { ok: false; message: string } {
  const plainMachineMessage =
    !item.sourcePlugin &&
    (item.origin?.kind === 'orca' ||
      (item.origin?.kind === 'session' && !item.origin.senderBotId));
  const owned =
    authorizeSessionQueueItem(item, callerSessionId).ok || callerSessionId === targetSessionId;
  return plainMachineMessage && owned
    ? { ok: true }
    : {
        ok: false,
        message:
          'queued message is neither sent by the current session nor a task/collaboration message in its own queue',
      };
}

export function rebuildSessionQueueItem(
  item: AgentInputQueuedMessage,
  message: string,
): AgentInputQueuedMessage {
  const updated = updateQueuedMessageText(item, message);
  if (updated.origin?.kind === 'session') {
    // send_to_session owns raw user text, not a renderer composer envelope.
    // A valid JSON object/array is still literal message content, so editing it
    // must replace the persisted history row wholesale instead of merging a
    // synthetic `text` property into the old JSON value. Attachment items are
    // the exception: their persisted row is the host-built `{text, images, files}`
    // envelope, which updateQueuedMessageText already rewrote in place.
    if (!item.files?.length) updated.persistedContent = item.botTaskCoordination ? updated.text : message;
    updated.origin = { ...updated.origin, displayText: message };
  }
  return updated;
}

export function sessionQueueOriginForDispatcher(params: {
  dispatcherSessionId?: string;
  /** 来源会话当前标题快照；缺失时接收方 renderer 回退实时查询或通用文案。 */
  dispatcherSessionTitle?: string | null;
  /** 来源会话所属伙伴；有则接收方标签显示「由伙伴「X」发送」。 */
  dispatcherBot?: { id: string; name: string } | null;
  message: string;
  explicitOrigin?: AgentInputQueuedMessage['origin'];
}): AgentInputQueuedMessage['origin'] | undefined {
  if (params.explicitOrigin) return params.explicitOrigin;
  if (!params.dispatcherSessionId) return undefined;
  const senderSessionTitle = params.dispatcherSessionTitle?.trim();
  return {
    kind: 'session',
    senderSessionId: params.dispatcherSessionId,
    displayText: params.message,
    ...(senderSessionTitle ? { senderSessionTitle } : {}),
    ...(params.dispatcherBot
      ? { senderBotId: params.dispatcherBot.id, senderBotName: params.dispatcherBot.name }
      : {}),
  };
}

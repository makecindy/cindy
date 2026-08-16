import type {
  AgentKind,
  SessionGracefulStopResult,
  SessionRuntimeSnapshot,
} from '@cindy/maker-core';

import {
  updateQueuedMessageText,
  type AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';
import { createSessionQueueControlService } from './sessionQueueControl.js';

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

export type SessionRuntimeResult =
  { ok: true; runtime: SessionRuntimeSnapshot } | Failure<'NOT_FOUND'>;

export interface SessionControlLiveSession {
  agentKind: AgentKind;
  capabilities: { sameTurnSteer: { supported: boolean } };
  isTurnRunning(): boolean;
  requestGracefulStop(): Promise<SessionGracefulStopResult>;
  getRuntimeSnapshot(): SessionRuntimeSnapshot;
}

export interface SessionControlServiceDeps {
  sessionExists(sessionId: string): Promise<boolean>;
  getLiveSession(sessionId: string): SessionControlLiveSession | null;
  assertExternalInputAllowed(sessionId: string): Promise<void>;
  createQueuedMessage(params: {
    targetSessionId: string;
    callerSessionId: string;
    queuedMessageId: string;
    message: string;
  }): Promise<AgentInputQueuedMessage>;
  steerQueuedMessage(sessionId: string, item: AgentInputQueuedMessage): Promise<boolean>;
  getQueueSnapshot(sessionId: string): Promise<{
    pendingQueue: AgentInputQueuedMessage[];
    consumingClientIds: string[];
  }>;
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage): boolean;
  removeQueuedMessage(sessionId: string, clientId: string): boolean;
  createId(): string;
}

const INACTIVE_RUNTIME: SessionRuntimeSnapshot = {
  active: false,
  turnGeneration: null,
  startedAtMs: null,
  lastActivityAtMs: null,
  currentActionSummary: null,
  gracefulStopState: 'none',
};

export function createSessionControlService(deps: SessionControlServiceDeps) {
  const queueControl = createSessionQueueControlService({
    getSnapshot: deps.getQueueSnapshot,
    replaceQueuedMessage: deps.replaceQueuedMessage,
    removeQueuedMessage: deps.removeQueuedMessage,
  });

  async function ensureTarget(sessionId: string): Promise<Failure<'NOT_FOUND'> | null> {
    return (await deps.sessionExists(sessionId))
      ? null
      : { ok: false, errorCode: 'NOT_FOUND', message: `session ${sessionId} not found` };
  }

  return {
    async updateQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
      message: string;
    }): Promise<SessionQueuedMessageControlResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.update({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        message: params.message,
        authorize: (item) => authorizeSessionQueueItem(item, params.callerSessionId),
        rebuild: rebuildSessionQueueItem,
      });
    },

    async cancelQueuedMessage(params: {
      callerSessionId: string;
      targetSessionId: string;
      queuedMessageId: string;
    }): Promise<SessionQueuedMessageControlResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      return queueControl.cancel({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        authorize: (item) => authorizeSessionQueueItem(item, params.callerSessionId),
      });
    },

    async steerSession(params: {
      callerSessionId: string;
      targetSessionId: string;
      message: string;
    }): Promise<SessionSteerResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (missing) return missing;
      try {
        await deps.assertExternalInputAllowed(params.targetSessionId);
      } catch (error) {
        if ((error as { code?: unknown }).code === 'UNSUPPORTED_CAPABILITY') {
          return {
            ok: false,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      }
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
      const queuedMessageId = deps.createId();
      const item = await deps.createQueuedMessage({
        ...params,
        queuedMessageId,
      });
      const accepted = await deps.steerQueuedMessage(params.targetSessionId, item);
      if (!accepted) {
        return live.isTurnRunning()
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

    async stopSessionTurn(params: { targetSessionId: string }): Promise<SessionStopResult> {
      const missing = await ensureTarget(params.targetSessionId);
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
      return {
        ok: true,
        runtime:
          deps.getLiveSession(params.targetSessionId)?.getRuntimeSnapshot() ?? INACTIVE_RUNTIME,
      };
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

export function rebuildSessionQueueItem(
  item: AgentInputQueuedMessage,
  message: string,
): AgentInputQueuedMessage {
  const updated = updateQueuedMessageText(item, message);
  if (updated.origin?.kind === 'session') {
    updated.origin = { ...updated.origin, displayText: message };
  }
  return updated;
}

export function sessionQueueOriginForDispatcher(params: {
  dispatcherSessionId?: string;
  message: string;
  explicitOrigin?: AgentInputQueuedMessage['origin'];
}): AgentInputQueuedMessage['origin'] | undefined {
  if (params.explicitOrigin) return params.explicitOrigin;
  if (!params.dispatcherSessionId) return undefined;
  return {
    kind: 'session',
    senderSessionId: params.dispatcherSessionId,
    displayText: params.message,
  };
}

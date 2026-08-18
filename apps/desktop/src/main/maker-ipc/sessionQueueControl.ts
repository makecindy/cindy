import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export type SessionQueueControlFailureCode =
  'QUEUED_MESSAGE_NOT_FOUND' | 'MESSAGE_CONSUMING' | 'NOT_AUTHORIZED' | 'INVALID_ARGS';

export type SessionQueueControlResult =
  | { ok: true; queuedMessageId: string }
  | {
      ok: false;
      errorCode: SessionQueueControlFailureCode;
      message: string;
    };

export interface SessionQueueControlSnapshot {
  pendingQueue: AgentInputQueuedMessage[];
  consumingClientIds: string[];
}

export interface SessionQueueControlDeps {
  getSnapshot(sessionId: string): Promise<SessionQueueControlSnapshot>;
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage): boolean;
  removeQueuedMessage(sessionId: string, clientId: string): boolean;
}

export type SessionQueueAuthorization = (
  item: AgentInputQueuedMessage,
) => { ok: true } | { ok: false; message: string };

type BaseControlParams = {
  sessionId: string;
  queuedMessageId: string;
  authorize: SessionQueueAuthorization;
};

/**
 * 排队消息控制的统一事务边界。Orca 与 cindy_helper 只提供身份策略和正文重建，
 * 恢复后定位、consuming 拒绝、replace/remove 竞态复核都只在这里维护。
 */
export function createSessionQueueControlService(deps: SessionQueueControlDeps) {
  async function resolve(
    params: BaseControlParams,
  ): Promise<
    { ok: true; item: AgentInputQueuedMessage } | Exclude<SessionQueueControlResult, { ok: true }>
  > {
    const snapshot = await deps.getSnapshot(params.sessionId);
    if (snapshot.consumingClientIds.includes(params.queuedMessageId)) {
      return consumingFailure(params.queuedMessageId);
    }
    const item = snapshot.pendingQueue.find(
      (candidate) => candidate.clientId === params.queuedMessageId,
    );
    if (!item) return missingFailure(params.queuedMessageId);
    const authorization = params.authorize(item);
    if (!authorization.ok) {
      return {
        ok: false,
        errorCode: 'NOT_AUTHORIZED',
        message: authorization.message,
      };
    }
    return { ok: true, item };
  }

  async function classifyLostRace(
    sessionId: string,
    queuedMessageId: string,
  ): Promise<Exclude<SessionQueueControlResult, { ok: true }>> {
    const latest = await deps.getSnapshot(sessionId);
    return latest.consumingClientIds.includes(queuedMessageId)
      ? consumingFailure(queuedMessageId)
      : missingFailure(queuedMessageId);
  }

  return {
    async update(
      params: BaseControlParams & {
        message: string;
        rebuild: (item: AgentInputQueuedMessage, message: string) => AgentInputQueuedMessage;
      },
    ): Promise<SessionQueueControlResult> {
      if (params.message.trim().length === 0) {
        return { ok: false, errorCode: 'INVALID_ARGS', message: 'message must not be empty' };
      }
      const resolved = await resolve(params);
      if (!resolved.ok) return resolved;
      const next = params.rebuild(resolved.item, params.message);
      if (
        next.clientId !== params.queuedMessageId ||
        next.chatMessage.clientId !== params.queuedMessageId
      ) {
        return {
          ok: false,
          errorCode: 'INVALID_ARGS',
          message: 'replacement must preserve queued message identity',
        };
      }
      if (!deps.replaceQueuedMessage(params.sessionId, params.queuedMessageId, next)) {
        return classifyLostRace(params.sessionId, params.queuedMessageId);
      }
      return { ok: true, queuedMessageId: params.queuedMessageId };
    },

    async cancel(params: BaseControlParams): Promise<SessionQueueControlResult> {
      const resolved = await resolve(params);
      if (!resolved.ok) return resolved;
      if (!deps.removeQueuedMessage(params.sessionId, params.queuedMessageId)) {
        return classifyLostRace(params.sessionId, params.queuedMessageId);
      }
      return { ok: true, queuedMessageId: params.queuedMessageId };
    },
  };
}

function missingFailure(queuedMessageId: string): Exclude<SessionQueueControlResult, { ok: true }> {
  return {
    ok: false,
    errorCode: 'QUEUED_MESSAGE_NOT_FOUND',
    message: `queued message ${queuedMessageId} not found — it may have been dispatched or cancelled already`,
  };
}

function consumingFailure(
  queuedMessageId: string,
): Exclude<SessionQueueControlResult, { ok: true }> {
  return {
    ok: false,
    errorCode: 'MESSAGE_CONSUMING',
    message: `queued message ${queuedMessageId} is being delivered and can no longer be modified`,
  };
}

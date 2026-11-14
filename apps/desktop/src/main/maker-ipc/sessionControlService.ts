import { formatForwardedRequest, type CapturedAgentRequest } from './forwardedRequest.js';
import type { AgentRequestReceipt } from '../../shared/forwardedRequest.js';
import type {
  AgentKind,
  Effort,
  PermissionMode,
  SessionGracefulStopResult,
  SessionTurnControlSnapshot,
} from '@cindy/maker-core';
import { assertTaskActionCurrent, bindTaskActionInput, combineInputGuards, hasTaskActionAuthorization } from './taskActionAuthorization.js';
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

type Failure<Code extends string> = { ok: false; errorCode: Code; message: string; data?: Record<string, unknown> };

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
  permissionMode?: PermissionMode;
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
      permissionMode?: PermissionMode;
    }
  | Failure<'NOT_FOUND' | 'CONFLICT' | 'INVALID_ARGS' | 'ROUTE_UNAVAILABLE' | 'UNSUPPORTED_CAPABILITY' | 'INTERNAL'>;

export interface SessionControlLiveSession {
  agentKind: AgentKind;
  capabilities: {
    sameTurnSteer: { supported: boolean };
    permissionModes?: readonly { id: PermissionMode }[];
    setPermissionModeMidSession?: { supported: boolean };
  };
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
  setSessionPermissionMode?(params: { sessionId: string; mode: PermissionMode; beforeMutation?: () => Promise<void> }): Promise<unknown>;
  setSessionRuntime(params: {
    targetSessionId: string;
    expectedGeneration?: number;
    beforeMutation?: () => Promise<void>;
    patch: {
      harness?: AgentKind;
      agentDeviceId?: string | null;
      model?: string;
      providerId?: string | null;
      effort?: Effort | null;
      fastMode?: boolean | 'ultrafast';
      permissionMode?: PermissionMode;
    };
  }): Promise<SessionRuntimeSetResult>;
  assertExternalInputAllowed(sessionId: string): Promise<void>;
  createQueuedMessage(params: {
    targetSessionId: string;
    callerSessionId?: string;
    queuedMessageId: string;
    message: string;
  }): Promise<AgentInputQueuedMessage>;
  /**
   * The editing task's current request decides whether an edited hand-off still speaks for
   * the owner. Omitted keeps the item's provenance without owner authority.
   */
  captureRequest?(callerSessionId: string, message: string, target: { sessionId: string }): Promise<CapturedAgentRequest>;
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
      const captured = await deps.captureRequest?.(params.callerSessionId, params.message,
        { sessionId: params.targetSessionId });
      return queueControl.update({
        sessionId: params.targetSessionId,
        queuedMessageId: params.queuedMessageId,
        message: params.message,
        authorize: (item) => authorizeSessionQueueItem(item, params.callerSessionId),
        beforeMutation: combineInputGuards(params.beforeMutation, assertTaskActionCurrent),
        rebuild: (item, message) => {
          const next = rebuildSessionQueueItem(item, message, captured?.autoReviewUserText);
          bindTaskActionInput(params.targetSessionId, next);
          return next;
        },
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
        beforeMutation: combineInputGuards(params.beforeMutation, assertTaskActionCurrent),
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
        beforeMutation: assertTaskActionCurrent,
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
        beforeMutation: assertTaskActionCurrent,
        authorize: (item) =>
          authorizeSessionQueueReorder(item, params.callerSessionId, params.targetSessionId),
      });
    },

    async steerSession(params: {
      callerSessionId?: string;
      targetSessionId: string;
      message: string;
      /** Host-owned stable ID; the input coordinator owns acceptance deduplication. */
      queuedMessageId?: string;
      beforeMutation?: () => Promise<void>;
    }): Promise<SessionSteerResult> {
      const beforeMutation = combineInputGuards(params.beforeMutation, assertTaskActionCurrent);
      const missing = await ensureTarget(params.targetSessionId);
      await beforeMutation?.();
      if (missing) return missing;
      try {
        await deps.assertExternalInputAllowed(params.targetSessionId);
      } catch (error) {
        await beforeMutation?.();
        if ((error as { code?: unknown }).code === 'UNSUPPORTED_CAPABILITY') {
          return {
            ok: false,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      }
      await beforeMutation?.();
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
      const item: AgentInputQueuedMessage = await deps.createQueuedMessage({
        ...params,
        queuedMessageId,
      });
      await beforeMutation?.();
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
      const expectedTurn = { session: live, turnGeneration, beforeMutation };
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
      await combineInputGuards(params.beforeMutation, assertTaskActionCurrent)?.();
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
        agentDeviceId?: string | null;
        model?: string;
        providerId?: string | null;
        effort?: Effort | null;
        fastMode?: boolean | 'ultrafast';
        permissionMode?: PermissionMode;
      };
    }): Promise<SessionRuntimeSetResult> {
      const missing = await ensureTarget(params.targetSessionId);
      if (params.beforeMutation) await params.beforeMutation();
      if (missing) return missing;
      if (params.patch.permissionMode !== undefined) {
        if (hasTaskActionAuthorization(params.targetSessionId)) {
          return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY',
            message: 'An admitted task cannot change its own permission mode, including in a mixed runtime patch.' };
        }
        if (!deps.setSessionPermissionMode) return { ok: false, errorCode: 'INVALID_ARGS', message: 'Permission control is unavailable.' };
        const beforeMutation = combineInputGuards(params.beforeMutation, assertTaskActionCurrent);
        const { permissionMode, ...runtimePatch } = params.patch;
        const hasRuntimePatch = Object.keys(runtimePatch).length > 0;
        let result: SessionRuntimeSetResult;
        if (hasRuntimePatch) {
          const live = deps.getLiveSession(params.targetSessionId);
          if (live && (!live.capabilities.permissionModes?.some(mode => mode.id === permissionMode) ||
            live.capabilities.setPermissionModeMidSession?.supported !== true)) {
            return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY',
              message: `The live ${live.agentKind} session does not support permission mode '${permissionMode}'. Runtime settings were not changed.` };
          }
          result = await deps.setSessionRuntime({ ...params, patch: runtimePatch, beforeMutation });
        } else {
          const details = await deps.getSessionRuntimeDetails(params.targetSessionId);
          await beforeMutation?.();
          if (params.expectedGeneration !== undefined && details.runtimeGeneration !== params.expectedGeneration)
            return { ok: false, errorCode: 'CONFLICT', message: 'Runtime generation changed; read it again before retrying.' };
          result = { ok: true, status: 'applied', generation: details.runtimeGeneration,
            effectiveProfile: details.effectiveProfile, pendingMutation: details.pendingMutation };
        }
        if (!result.ok) return result;
        try {
          await beforeMutation?.();
          await deps.setSessionPermissionMode({ sessionId: params.targetSessionId, mode: permissionMode, beforeMutation });
        } catch (error) {
          if (!hasRuntimePatch) throw error;
          return { ok: false, errorCode: 'INTERNAL',
            message: `Runtime settings were ${result.status}, but permission_mode failed. Read get_session_runtime before retrying.`,
            data: { runtime: { status: result.status, generation: result.generation, fields: Object.keys(runtimePatch),
              ...(result.effectiveBoundary ? { effective_boundary: result.effectiveBoundary } : {}) },
              failed: 'permission_mode', original_error: {
                code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null,
                message: error instanceof Error ? error.message : String(error),
              } },
          };
        }
        return { ...result, permissionMode };
      }
      return deps.setSessionRuntime({ ...params,
        beforeMutation: combineInputGuards(params.beforeMutation, assertTaskActionCurrent),
      });
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
      item.origin?.kind === 'session');
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
  /** The editor's freshly captured receipt; edited text is a new hand-off, not the old one. */
  captured?: AgentRequestReceipt,
): AgentInputQueuedMessage {
  const request = typeof item.autoReviewUserText === 'object' ? item.autoReviewUserText.request : undefined;
  // Older envelopes keep their quoted user words when edited. Any other item (a plain hand-off or
  // an ordinary message without authority) speaks for the user only if the editor's own request
  // re-checked exactly the new text; otherwise it keeps its provenance without authority.
  const legacyEnvelope = request?.plainBody !== true && typeof request?.userText === 'string';
  const plainRequest = legacyEnvelope ? undefined
    : captured?.request?.delegatedText === message ? captured.request
      : request?.plainBody ? { sessionId: request.sessionId, clientId: request.clientId, plainBody: true as const }
        : undefined;
  const nextRequest = plainRequest ?? request;
  if (item.origin?.kind === 'session') message = formatForwardedRequest(nextRequest ?? { userText: null }, message);
  const updated = updateQueuedMessageText(item, message);
  if (updated.origin?.kind === 'session') {
    updated.autoReviewUserText = {
      kind: typeof item.autoReviewUserText === 'object' ? item.autoReviewUserText.kind : 'agent-request',
      request: nextRequest ?? { userText: null },
    };
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

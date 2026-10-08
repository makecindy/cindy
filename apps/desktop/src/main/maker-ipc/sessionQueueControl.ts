import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { ControlSteerOutcome } from './agent-input-coordinator.js';

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

/** 排队消息转插话没插成时的原因；消息仍留在队列里。 */
export type QueuedSteerFallbackReason =
  'NO_ACTIVE_TURN' | 'STEER_UNSUPPORTED' | 'INPUT_BOUNDARY_BUSY' | 'STEER_UNCERTAIN';

/** Host-side outcome; `gone` means the row left the queue without being steered. */
export type QueuedSteerOutcome =
  | { kind: 'steered' }
  | { kind: 'queued'; reason: QueuedSteerFallbackReason }
  | { kind: 'gone' };

export type SessionQueueSteerResult =
  | { ok: true; queuedMessageId: string; delivery: 'steered' }
  | { ok: true; queuedMessageId: string; delivery: 'queued'; reason: QueuedSteerFallbackReason }
  | Exclude<SessionQueueControlResult, { ok: true }>;

export type SessionQueueMoveResult =
  | { ok: true; queuedMessageId: string; position: number }
  | Exclude<SessionQueueControlResult, { ok: true }>;

export interface SessionQueueControlDeps {
  getSnapshot(sessionId: string): Promise<SessionQueueControlSnapshot>;
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage, expected?: AgentInputQueuedMessage): boolean;
  removeQueuedMessage(sessionId: string, clientId: string, expected?: AgentInputQueuedMessage): boolean;
  steerQueuedMessage(sessionId: string, clientId: string): Promise<QueuedSteerOutcome>;
  /**
   * Moves among waiting rows; returns the final waiting-row index, null when it is gone,
   * or 'locked' while the user is editing it.
   */
  moveQueuedMessage(sessionId: string, clientId: string, position: number): number | null | 'locked';
}

export type SessionQueueAuthorization = (
  item: AgentInputQueuedMessage,
) => { ok: true } | { ok: false; message: string };

type BaseControlParams = {
  sessionId: string;
  queuedMessageId: string;
  authorize: SessionQueueAuthorization;
  beforeMutation?: () => Promise<void>;
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
      await params.beforeMutation?.();
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
      if (!deps.replaceQueuedMessage(params.sessionId, params.queuedMessageId, next, resolved.item)) {
        return classifyLostRace(params.sessionId, params.queuedMessageId);
      }
      return { ok: true, queuedMessageId: params.queuedMessageId };
    },

    async cancel(params: BaseControlParams): Promise<SessionQueueControlResult> {
      const resolved = await resolve(params);
      if (!resolved.ok) return resolved;
      await params.beforeMutation?.();
      if (!deps.removeQueuedMessage(params.sessionId, params.queuedMessageId, resolved.item)) {
        return classifyLostRace(params.sessionId, params.queuedMessageId);
      }
      return { ok: true, queuedMessageId: params.queuedMessageId };
    },

    /** 转插话不改正文与身份；没插成时消息原位保留并说明原因。 */
    async steer(params: BaseControlParams): Promise<SessionQueueSteerResult> {
      const resolved = await resolve(params);
      if (!resolved.ok) return resolved;
      await params.beforeMutation?.();
      const outcome = await deps.steerQueuedMessage(params.sessionId, params.queuedMessageId);
      if (outcome.kind === 'gone') return classifyLostRace(params.sessionId, params.queuedMessageId);
      return outcome.kind === 'steered'
        ? { ok: true, queuedMessageId: params.queuedMessageId, delivery: 'steered' }
        : {
            ok: true,
            queuedMessageId: params.queuedMessageId,
            delivery: 'queued',
            reason: outcome.reason,
          };
    },

    async move(params: BaseControlParams & { position: number }): Promise<SessionQueueMoveResult> {
      if (!Number.isInteger(params.position) || params.position < 0) {
        return { ok: false, errorCode: 'INVALID_ARGS', message: 'position must be a non-negative integer' };
      }
      const resolved = await resolve(params);
      if (!resolved.ok) return resolved;
      await params.beforeMutation?.();
      const position = deps.moveQueuedMessage(
        params.sessionId,
        params.queuedMessageId,
        params.position,
      );
      if (position === null) return classifyLostRace(params.sessionId, params.queuedMessageId);
      if (position === 'locked') {
        return {
          ok: false,
          errorCode: 'MESSAGE_CONSUMING',
          message: `queued message ${params.queuedMessageId} is being edited and cannot be moved now`,
        };
      }
      return { ok: true, queuedMessageId: params.queuedMessageId, position };
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

/** createQueueReorderAdapter 只需要 coordinator 的这几项能力。 */
export interface QueueReorderCoordinator {
  steerControlInput(
    sessionId: string,
    target: { queuedClientId: string },
    expectedTurn: { session: object; turnGeneration: number },
  ): Promise<ControlSteerOutcome>;
  isQueuePaused(sessionId: string): boolean;
  getQueueControlSnapshot(sessionId: string): { pendingQueue: readonly AgentInputQueuedMessage[] };
  getProjection(sessionId: string): {
    queueEditLocks: readonly string[];
    steeringQueueClientIds: readonly string[];
  };
  move(sessionId: string, clientId: string, targetIndex: number): unknown;
}

/**
 * Host adapter shared by cindy_orca and cindy_helper. Capability, remote-host and turn
 * identity are decided here; queue guards, the pre-dispatch re-check and acceptance
 * bookkeeping stay in the coordinator.
 */
export function createQueueReorderAdapter(deps: {
  getLiveSession(sessionId: string):
    | {
        isTurnRunning(): boolean;
        getTurnGeneration(): number;
        capabilities: { sameTurnSteer: { supported: boolean } };
        remoteHostId?: string | null;
      }
    | null
    | undefined;
  hasSendToSessionLock(sessionId: string): boolean;
  getCoordinator(): QueueReorderCoordinator;
}): {
  steerStoredControlMessage(sessionId: string, clientId: string): Promise<QueuedSteerOutcome>;
  moveStoredControlMessage(sessionId: string, clientId: string, position: number): number | null | 'locked';
} {
  const waitingIndex = (sessionId: string, clientId: string): number =>
    deps
      .getCoordinator()
      .getQueueControlSnapshot(sessionId)
      .pendingQueue.findIndex((item) => item.clientId === clientId);
  return {
    async steerStoredControlMessage(sessionId, clientId) {
      const live = deps.getLiveSession(sessionId);
      if (!live?.isTurnRunning()) return { kind: 'queued', reason: 'NO_ACTIVE_TURN' };
      if (!live.capabilities.sameTurnSteer.supported || live.remoteHostId) {
        return { kind: 'queued', reason: 'STEER_UNSUPPORTED' };
      }
      if (deps.hasSendToSessionLock(sessionId)) return { kind: 'queued', reason: 'INPUT_BOUNDARY_BUSY' };
      const coordinator = deps.getCoordinator();
      const outcome = await coordinator.steerControlInput(
        sessionId,
        { queuedClientId: clientId },
        { session: live, turnGeneration: live.getTurnGeneration() },
      );
      if (outcome === 'steered') return { kind: 'steered' };
      // rejected = screening discarded the row; any other outcome without the row is a lost race.
      if (outcome === 'rejected' || waitingIndex(sessionId, clientId) < 0) return { kind: 'gone' };
      if (outcome === 'queued' && coordinator.isQueuePaused(sessionId)) {
        return { kind: 'queued', reason: 'STEER_UNCERTAIN' };
      }
      return {
        kind: 'queued',
        reason: deps.getLiveSession(sessionId)?.isTurnRunning() ? 'INPUT_BOUNDARY_BUSY' : 'NO_ACTIVE_TURN',
      };
    },
    moveStoredControlMessage(sessionId, clientId, position) {
      const from = waitingIndex(sessionId, clientId);
      if (from < 0) return null;
      const coordinator = deps.getCoordinator();
      const projection = coordinator.getProjection(sessionId);
      // A row that started steering is being consumed; move() would silently refuse it.
      if (projection.steeringQueueClientIds.includes(clientId)) return null;
      // Same rule as the queue UI: a row the user is editing keeps its place.
      if (projection.queueEditLocks.includes(clientId)) return 'locked';
      const waitingCount = coordinator.getQueueControlSnapshot(sessionId).pendingQueue.length;
      const to = Math.min(position, waitingCount - 1);
      // coordinator.move 的 targetIndex 是「插到原队列第 n 条之前」。
      coordinator.move(sessionId, clientId, to > from ? to + 1 : to);
      const index = waitingIndex(sessionId, clientId);
      return index < 0 ? null : index;
    },
  };
}

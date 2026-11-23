import { randomUUID } from 'node:crypto';
import { isTaskActionRevoked } from './taskActionAuthorization.js';
import { isTerminalAgentErrorEvent, type ManualCompactResult, type Session } from '@cindy/maker-core';

type CompactSession = Pick<Session, 'getTurnGeneration' | 'isTurnRunning' | 'onEvent' | 'onStatusChange'
  | 'stablePermissionModeState' | 'stablePlanModeState' | 'sdkSessionId'>;

export type SessionCompactReceipt = { operationId: string } & (
  | { status: 'requested' | 'cancelled' }
  | ({ status: 'completed' } & ManualCompactResult)
  | { status: 'failed'; errorCode: 'COMPACT_FAILED' }
);

const MAX_WAIT_FOR_COMPACT_BOUNDARY_MS = 10 * 60_000;

/** Pi's native compact aborts its active turn. Let a self-call return before it can do so. */
export function createDeferredSessionCompact() {
  const receipts = new WeakMap<CompactSession, SessionCompactReceipt>();
  return {
    get: (session: CompactSession) => receipts.get(session),
    request(session: CompactSession, input: {
      turnGeneration: number;
      isCurrent: () => boolean;
      signal?: AbortSignal;
      dispatch: (beforeDispatch: () => Promise<void>, signal: AbortSignal) => Promise<ManualCompactResult>;
    }): SessionCompactReceipt | null {
      const permission = session.stablePermissionModeState;
      const plan = session.stablePlanModeState;
      const nativeSessionId = session.sdkSessionId;
      if (input.signal?.aborted || !input.isCurrent() || !permission || permission.mode === 'plan' || !plan || plan.enabled
        || session.getTurnGeneration() !== input.turnGeneration || !session.isTurnRunning()
        || receipts.get(session)?.status === 'requested') return null;

      const operationId = randomUUID();
      const receipt = { operationId, status: 'requested' } as const;
      const controller = new AbortController();
      let settled = false;
      const settle = (result: SessionCompactReceipt) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        offEvent();
        offStatus();
        receipts.set(session, result);
      };
      const cancel = () => {
        controller.abort();
        settle({ operationId, status: 'cancelled' });
      };
      const dispatch = async () => {
        let admitted = false;
        try {
          const native = await input.dispatch(async () => {
            const currentPermission = session.stablePermissionModeState;
            const currentPlan = session.stablePlanModeState;
            if (!input.isCurrent() || session.sdkSessionId !== nativeSessionId
              || session.getTurnGeneration() !== input.turnGeneration || session.isTurnRunning()
              || currentPermission?.generation !== permission.generation
              || !currentPlan || currentPlan.enabled || currentPlan.generation !== plan.generation) cancel();
            controller.signal.throwIfAborted();
            admitted = true;
            // After the actual RPC is admitted, only its result can settle this receipt.
            clearTimeout(deadline);
            offStatus();
          }, controller.signal);
          settle({ operationId, status: 'completed', ...native });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!admitted && isTaskActionRevoked(error)) cancel();
          else settle({ operationId, status: 'failed', errorCode: 'COMPACT_FAILED' });
        }
      };
      const offEvent = session.onEvent(event => {
        if (event.sessionTurnGeneration !== input.turnGeneration || event.turnScope === 'background') return;
        if (isTerminalAgentErrorEvent(event)) {
          cancel();
        } else if (event.type === 'done' && event.turnContinuationId === undefined) {
          offEvent();
          if ((event.data as { status?: string } | undefined)?.status === 'completed') void dispatch();
          else cancel();
        }
      });
      const offStatus = session.onStatusChange(status => { if (status !== 'active') cancel(); });
      const deadline = setTimeout(cancel, MAX_WAIT_FOR_COMPACT_BOUNDARY_MS);
      deadline.unref?.();
      receipts.set(session, receipt);
      return receipt;
    },
  };
}

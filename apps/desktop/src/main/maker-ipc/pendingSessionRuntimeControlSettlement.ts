import type { AgentEvent } from '@cindy/maker-core';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { nextDeferredModelWindowRetry } from '../../shared/runtimeModelSwitchGate.js';
import type { Logger } from '../logger.js';
import { MAKER_PUSH } from './channels.js';
import {
  cancelPendingSessionRuntimeMutation,
  getPendingSessionRuntimeMutation,
  isPendingSessionRuntimeRouteExplicit,
} from './sessionRuntimeControl.js';
import type { ApplySessionRuntimeSelection } from './sessionRuntimeSelectionApply.js';

export interface PendingSessionRuntimeControlSettlementPorts {
  canSettle?(sessionId: string, generation: number): boolean;
  /** The Host waits for every generation. The desktop leaves each work promise untouched. */
  onSettlementWork?(sessionId: string, work: Promise<void>): void;
  applySessionRuntimeSelection: ApplySessionRuntimeSelection;
  runtimeSelectionRequiresModelWindowConfirmation(result: Awaited<ReturnType<ApplySessionRuntimeSelection>>): boolean;
  broadcastSessionRuntimeProjection(sessionId: string): Promise<void>;
  onTurnErrorEvent(sessionId: string, error: { message: string; reason: string }, agentMeta: null): void;
  getSessionDbAgentKind(sessionId: string): string | null | undefined;
  broadcastToAllWindows(channel: typeof MAKER_PUSH.EVENT, payload: { sessionId: string; event: AgentEvent }): void;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

/** Applies the accepted control once its turn is idle, as in registerMakerIpc. */
export function createPendingSessionRuntimeControlSettlement({
  canSettle, onSettlementWork, applySessionRuntimeSelection, runtimeSelectionRequiresModelWindowConfirmation,
  broadcastSessionRuntimeProjection, onTurnErrorEvent, getSessionDbAgentKind, broadcastToAllWindows, log,
}: PendingSessionRuntimeControlSettlementPorts) {
  const settlingSessionRuntimeControls = new Set<string>();
  const settlePendingSessionRuntimeControl = (sessionId: string, reason: string): void => {
    if (settlingSessionRuntimeControls.has(sessionId)) return;
    const pending = getPendingSessionRuntimeMutation(sessionId);
    if (!pending) return;
    const allowed = () => canSettle?.(sessionId, pending.generation) !== false;
    if (!allowed()) return;
    settlingSessionRuntimeControls.add(sessionId);
    const work = (async () => {
      try {
        const settleSelection = {
          effort: pending.profile.effort,
          fastMode: pending.profile.fastMode,
          ...(pending.thinking !== undefined ? { thinking: pending.thinking } : {}),
        };
        const settleOptions = {
          source: pending.source,
          expectedGeneration: pending.generation,
          applyingPendingGeneration: pending.generation,
          effortExplicit: pending.profile.effort !== null,
          fastExplicit: true,
          routeExplicit: isPendingSessionRuntimeRouteExplicit(sessionId, pending.generation),
        };
        let result = await applySessionRuntimeSelection(
          sessionId,
          pending.profile.model,
          pending.profile.providerId,
          settleSelection,
          settleOptions,
        );
        // 回合中登记的缩窗选择:用户当时已经点过目标模型。空闲结算时若仍要确认换窗,
        // 带着核实窗口再 apply 一次,避免把选择取消掉。
        const windowRetry = nextDeferredModelWindowRetry(
          runtimeSelectionRequiresModelWindowConfirmation(result),
          result.contextWindowConfirmationRequired,
        );
        if (!allowed()) return;
        if (windowRetry.action === 'retry') {
          result = await applySessionRuntimeSelection(
            sessionId,
            pending.profile.model,
            pending.profile.providerId,
            { ...settleSelection, confirmedContextWindow: windowRetry.confirmedContextWindow },
            settleOptions,
          );
          if (nextDeferredModelWindowRetry(
            runtimeSelectionRequiresModelWindowConfirmation(result),
            result.contextWindowConfirmationRequired,
          ).action !== 'done') {
            throw new Error('deferred model-window selection requires unsupported confirmation');
          }
        } else if (windowRetry.action === 'cancel') {
          throw new Error('deferred model-window selection requires unsupported confirmation');
        }
        log.info('pending session runtime settled', {
          sessionId,
          reason,
          generation: pending.generation,
          superseded: result.superseded,
        });
      } catch (error) {
        if (!allowed()) return;
        const cancelled = cancelPendingSessionRuntimeMutation(sessionId, pending.generation);
        log.warn('pending session runtime settlement failed', {
          sessionId,
          reason,
          cancelled,
          error: error instanceof Error ? error.message : String(error),
        });
        if (cancelled) {
          await broadcastSessionRuntimeProjection(sessionId).catch((broadcastError) => {
            log.debug('cancelled pending runtime projection broadcast failed', {
              sessionId,
              error:
                broadcastError instanceof Error ? broadcastError.message : String(broadcastError),
            });
          });
          if (!allowed()) return;
          const failureMessage =
            error instanceof Error && error.message.includes('unsupported')
              ? 'Deferred model switch was cancelled because safe context rebuild is unsupported. The previous model remains active.'
              : 'Deferred model switch was cancelled because it could not be applied safely. The previous model remains active.';
          const failureReason = 'runtime-selection-cancelled';
          onTurnErrorEvent(sessionId, { message: failureMessage, reason: failureReason }, null);
          const dbAgentKind = getSessionDbAgentKind(sessionId);
          const agentSource = dbAgentKind ? dbToMakerAgentKind(dbAgentKind) : undefined;
          broadcastToAllWindows(MAKER_PUSH.EVENT, {
            sessionId,
            event: {
              type: 'error',
              data: { message: failureMessage, reason: failureReason, isTerminal: true },
              ...(agentSource ? { source: agentSource } : {}),
            } satisfies AgentEvent,
          });
        }
      } finally {
        settlingSessionRuntimeControls.delete(sessionId);
        const latest = getPendingSessionRuntimeMutation(sessionId);
        if (latest && latest.generation !== pending.generation) {
          settlePendingSessionRuntimeControl(sessionId, `${reason}:generation-advanced`);
        }
      }
    })();
    onSettlementWork?.(sessionId, work);
  };
  return settlePendingSessionRuntimeControl;
}

import type { Session } from '@cindy/maker-core';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
import type { SessionDeliveryResult } from './sessionEventDelivery.js';
import type { FinishSessionTerminalEventDeps } from './sessionEventTerminal.js';
import type * as persist from '../messagePersistBroadcaster.desktop.js';
import type * as rollover from './contextOverflowRollover.js';
import type { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';

/** Recovery owns only the claimed terminal; platform IO stays in the launcher. */
export interface ContextRecoveryTerminalPorts {
  getRollover(): FinishSessionTerminalEventDeps['contextOverflowRolloverHolder'];
  getSuppressedBroadcasts(): FinishSessionTerminalEventDeps['overflowSuppressedBroadcasts'];
  isTerminalTurnErrorEvent: typeof isTerminalTurnErrorEvent;
  isContextOverflowErrorData: typeof rollover.isContextOverflowErrorData;
  isOversizedHistoryErrorData: typeof rollover.isOversizedHistoryErrorData;
  isUnsupportedRequestOptionErrorData: typeof rollover.isUnsupportedRequestOptionErrorData;
  reserveTurnErrorPersistId: typeof persist.reserveTurnErrorPersistId;
  releaseReservedTurnErrorPersistId: typeof persist.releaseReservedTurnErrorPersistId;
  onTurnErrorEvent: typeof persist.onTurnErrorEvent;
  broadcastToAllWindows: FinishSessionTerminalEventDeps['broadcastToAllWindows'];
  handleAgentIslandEventAfterBroadcast: FinishSessionTerminalEventDeps['handleAgentIslandEventAfterBroadcast'];
  eventChannel(): string;
  log: FinishSessionTerminalEventDeps['log'];
}

type Input = Pick<PreparedSessionEvent, 'event' | 'attributedEvent' | 'broadcastEvent' | 'eventAgentMeta'
  | 'isPlannedUpgradeClose' | 'isRemoteAuthRetry' | 'isGatewayProxyTokenRecovery'> & {
  session: Session;
  autoResumeSuppressesPersist: boolean;
  persistId: SessionDeliveryResult['persistId'];
};

/** Must run synchronously before any terminal observer can release its owner. */
export function claimContextRecoveryTerminal(ports: ContextRecoveryTerminalPorts, input: Input): rollover.OverflowClaimResult {
  const { session, event, attributedEvent, isPlannedUpgradeClose, isRemoteAuthRetry,
    isGatewayProxyTokenRecovery, autoResumeSuppressesPersist } = input;
    const overflowClaim =
      event.type === 'error' &&
      !session.remoteHostId &&
      ports.isTerminalTurnErrorEvent(event) &&
      !isPlannedUpgradeClose &&
      !isRemoteAuthRetry &&
      !isGatewayProxyTokenRecovery &&
      !autoResumeSuppressesPersist
        ? (ports.getRollover()?.claim(session.id, {
            instanceId: event.sessionInstanceId,
            generation: event.sessionTurnGeneration,
          }, ports.isContextOverflowErrorData(attributedEvent.data)
            || ports.isOversizedHistoryErrorData(attributedEvent.data)
            || ports.isUnsupportedRequestOptionErrorData(attributedEvent.data)) ?? 'idle')
        : 'idle';
  return overflowClaim;
}

export function deferContextRecoveryTerminal(ports: ContextRecoveryTerminalPorts, input: Input,
  overflowClaim: rollover.OverflowClaimResult, deferUnsuccessfulProductTurn: () => void): boolean {
  const { event, isRemoteAuthRetry, isGatewayProxyTokenRecovery, isPlannedUpgradeClose, autoResumeSuppressesPersist } = input;
    const recoveryOwnsUnsuccessfulBoundary =
      ports.isTerminalTurnErrorEvent(event) &&
      (isRemoteAuthRetry ||
        isGatewayProxyTokenRecovery ||
        isPlannedUpgradeClose ||
        overflowClaim === 'claimed' ||
        overflowClaim === 'in-flight');
    if (recoveryOwnsUnsuccessfulBoundary || autoResumeSuppressesPersist) {
      deferUnsuccessfulProductTurn();
    }
  return recoveryOwnsUnsuccessfulBoundary;
}

/** Starts settlement without awaiting it; the event pipeline stays synchronous. */
export function settleContextRecoveryTerminal(ports: ContextRecoveryTerminalPorts, input: Input,
  overflowClaim: rollover.OverflowClaimResult, notifyUnsuccessfulProductTurn: () => void): boolean {
  const { session, event, attributedEvent, broadcastEvent, eventAgentMeta, persistId } = input;
    if (overflowClaim === 'claimed') {
      const overflowErrorData = attributedEvent.data;
      // Duplicate terminals can replace the session-indexed stash while this
      // promise is pending. Keep this claim's own broadcast for failure.
      const claimedBroadcast = ports.getSuppressedBroadcasts().get(session.id);
      const ownedBroadcast = claimedBroadcast?.event === broadcastEvent ? claimedBroadcast : undefined;
      let overflowFailureSurfaced = false;
      const surfaceOverflowFailure = (): void => {
        if (overflowFailureSurfaced) return;
        overflowFailureSurfaced = true;
        const overflowErrorPayload = overflowErrorData as {
          message?: unknown;
          reason?: unknown;
          sdkError?: unknown;
        } | null;
        const overflowPersistId = ports.reserveTurnErrorPersistId(
          session.id,
          overflowErrorPayload,
          eventAgentMeta,
        );
        if (ports.getSuppressedBroadcasts().get(session.id)?.event === broadcastEvent) {
          ports.getSuppressedBroadcasts().delete(session.id);
        }
        if (ownedBroadcast) {
          ports.broadcastToAllWindows(ports.eventChannel(), {
            ...ownedBroadcast,
            persistId: overflowPersistId ?? ownedBroadcast.persistId,
          });
          ports.handleAgentIslandEventAfterBroadcast(session, ownedBroadcast.event);
        }
        ports.onTurnErrorEvent(session.id, overflowErrorPayload, eventAgentMeta, overflowPersistId);
        notifyUnsuccessfulProductTurn();
      };
      void ports.getRollover()
        ?.tryRecover(session.id, overflowErrorData, {
          instanceId: event.sessionInstanceId,
          generation: event.sessionTurnGeneration,
        })
        .then((recovered) => {
          if (recovered) {
            if (ports.getSuppressedBroadcasts().get(session.id)?.event === broadcastEvent) {
              ports.getSuppressedBroadcasts().delete(session.id);
            }
            return;
          }
          surfaceOverflowFailure();
        })
        .catch((error) => {
          ports.log.warn('context overflow rollover rejected', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
          surfaceOverflowFailure();
        });
    } else if (overflowClaim === 'in-flight') {
      // 同一 turn 的重复终态 error：继续压住，避免污染历史。
      if (ports.getSuppressedBroadcasts().get(session.id)?.event === broadcastEvent) {
        ports.getSuppressedBroadcasts().delete(session.id);
      }
      if (persistId) ports.releaseReservedTurnErrorPersistId(session.id, persistId);
    } else {
      return false;
    }
  return true;
}

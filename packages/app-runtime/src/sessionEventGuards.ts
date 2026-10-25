import type {AgentEvent,InteractionRequest,InteractionDecision} from '@cindy/maker-core';
import type {RegionalMoney,MoneyCurrency} from '@cindy/maker-shared/regional-money';
import {isTurnContinuationBoundaryEvent} from '@cindy/maker-shared/turn-continuation';
import {isTerminalTurnErrorEvent} from './sessionTurnActivityTracker.js';
import type {AgentInputCoordinator} from './agent-input-coordinator.js';
export function createSessionEventGuards(host:{coordinator():Pick<AgentInputCoordinator,'isFencedStaleTerminal'>|null;currentLedgerCurrency():MoneyCurrency}) {
function defaultDecisionForPending(
  kind: InteractionRequest['kind'],
  reason: string,
): InteractionDecision {
  if (kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {}, dismissed: true };
  }
  if (kind === 'plan_review') {
    // dismissed: 系统性 deny(session_closed / session_aborted / 超时清理等),
    // reason 是系统代码 —— Codex plan 修订循环据此不把它当用户反馈发修订 turn。
    return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
  }
  return { kind, behavior: 'deny', reason } as InteractionDecision;
}
function unpricedSubscriptionValueMarker(): RegionalMoney {
  return {
    amount: 0,
    currency: host.currentLedgerCurrency(),
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: ['subscription-value', 'reference-price'],
  };
}
function isRemoteAuthRetryErrorEvent(
  session: { agentKind?: unknown; remoteHostId?: unknown },
  event: AgentEvent,
): boolean {
  if (!session.remoteHostId || event.type !== 'error' || !isTerminalTurnErrorEvent(event))
    return false;
  if (session.agentKind === 'codex') return false;
  const data = event.data as
    { message?: unknown; sdkError?: unknown; errorStatus?: unknown } | undefined;
  return (
    data?.sdkError === 'authentication_failed' ||
    data?.errorStatus === 401 ||
    /authentication_error|invalid.*api.key|401/i.test(
      typeof data?.message === 'string' ? data.message : '',
    )
  );
}
function isFencedStaleProductTerminal(event: AgentEvent): boolean {
  if (event.type === 'done') return true;
  if (isTerminalTurnErrorEvent(event)) return true;
  if (event.type !== 'status') return false;
  const data = event.data as { isRunning?: unknown } | null | undefined;
  return data?.isRunning === false;
}
function isFencedStaleSessionTerminal(sessionId: string, event: AgentEvent): boolean {
  if (isTurnContinuationBoundaryEvent(event) || event.turnScope === 'background') {
    return false;
  }
  return (
    isFencedStaleProductTerminal(event) &&
    host.coordinator()?.isFencedStaleTerminal(sessionId, {
      sessionTurnGeneration: event.sessionTurnGeneration,
      sessionInstanceId: event.sessionInstanceId,
    }) === true
  );
}
return {isRemoteAuthRetryErrorEvent,isFencedStaleProductTerminal,isFencedStaleSessionTerminal,defaultDecisionForPending,unpricedSubscriptionValueMarker};
}

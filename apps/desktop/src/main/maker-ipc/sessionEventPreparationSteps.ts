import type { AgentEvent, InteractionDecision, InteractionRequest, Session } from '@cindy/maker-core';
import type { AgentMeta } from '../../renderer/lib/ccAgent.types';
import { isQuietScheduledOutput } from '../scheduler-host/silent-output.js';
import { consumeClaudeOpusPlanMismatch } from '../maker-host/claude-gateway-error-observer.js';
import { isBotGroupClientId } from '../../shared/botGroupChat.js';
import { MAKER_PUSH } from './channels.js';
import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';

/**
 * Steps of prepareSessionEvent (sessionEventPreparation.ts) that the Node Host runs as well
 * (apps/host/src/agent/turn-executor.mjs). Each block is moved verbatim; the desktop's preparation
 * calls it where the block was. A step that ends the preparation returns true.
 */

export interface DismissedInteraction {
  kind: InteractionRequest['kind'];
  resolve: (decision: InteractionDecision) => void;
  request: InteractionRequest;
  persistId?: string;
}

/** The pending card's default decision when it is closed without an answer (moved from register.ts). */
export function defaultDecisionForPending(
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

/** A post-terminal runtime recovery receipt, in the user's language; other events unchanged. */
export function localizeRuntimeRecoveryEvent(event: AgentEvent, t: (key: string) => string): AgentEvent {
  // Helper readiness is Host-authored, not vendor prose. Translate fixed codes
  // before either error-banner delivery or the independent durable message;
  // preserve the original event for other listeners and never rewrite model text.
  if (event.source === 'codex' && (event.type === 'error' || event.type === 'text' && event.standaloneText)) {
    const data = event.data as Record<string, unknown> | null;
    const text = data?.code === 'CINDY_EXPECTED_HELPER_UNAVAILABLE'
      ? t('chat.errorBanner.codexHelperUnavailable')
      : data?.code === 'CINDY_EXPECTED_HELPER_UNVERIFIED'
        ? t('chat.errorBanner.codexHelperUnverified') : undefined;
    if (text !== undefined) {
      event = { ...event, data: { ...data, ...(event.type === 'error' ? { message: text } : { text }) } };
    }
  }
  // Post-terminal Host recovery bypasses the model. Localize before both
  // persistence and renderer delivery, without mutating the internal receipt.
  if (event.runtimeRecovery && event.source === 'pi' && event.type === 'text') {
    event = {
      ...event,
      data: {
        ...(event.data as Record<string, unknown>),
        text: t('settings.piPackages.failure.runtimeRetirementFailed'),
      },
    };
  }
  return event;
}

export interface InteractionDismissedDeps {
  readonly handleAgentIslandInteractionDismissed: (sessionId: string, requestId: string) => void;
  readonly clearPendingInteraction: (requestId: string) => DismissedInteraction | null;
  readonly defaultDecisionForPending: (
    kind: InteractionRequest['kind'],
    reason: string,
  ) => InteractionDecision;
  readonly persistInteractionDecision: (
    sessionId: string,
    persistId: string | undefined,
    kind: InteractionRequest['kind'],
    request: InteractionRequest,
    decision: InteractionDecision | Record<string, unknown>,
  ) => void;
  readonly broadcastToAllWindows: (channel: string, payload: unknown) => void;
}

export interface StandaloneTextEventDeps {
  readonly redactEventForRenderer: (event: AgentEvent) => AgentEvent;
  readonly agentInputCoordinatorHolder: {
    getActiveInputClientId(sessionId: string, vendorGeneration?: number): string | null;
    getAcceptedInputProvenance(sessionId: string): {
      clientId: string;
      autoResume?: boolean;
      retrySourceClientId?: string;
    } | null;
  } | null;
}

/** A standalone notice (a Pi extension's, for one) is its own history row, not a reply. */
export function routeStandaloneTextEvent(
  deps: StandaloneTextEventDeps,
  session: Pick<Session, 'id'>,
  event: AgentEvent,
  onStandaloneTextEvent: (
    sessionId: string,
    text: string,
    agentMeta?: Pick<AgentMeta, 'botPrivateReply'> | null,
  ) => unknown,
): boolean {
  if (event.type === 'text' && event.standaloneText === true) {
    if (isQuietScheduledOutput(event) && !event.runtimeRecovery) return true;
    // Deliver through the existing persisted-row channel only. Sending a text
    // event as well would let older renderers adopt the notice as their active
    // assistant stream and overwrite/misdate the next model reply.
    const redacted = deps.redactEventForRenderer(event);
    const text = (redacted.data as { text?: unknown } | null)?.text;
    const inputId = deps.agentInputCoordinatorHolder?.getActiveInputClientId(session.id, event.sessionTurnGeneration);
    // Private-message visibility is still owned by the accepted input, even
    // though the notice is independent of the model's reply/usage state.
    const inputProvenance = deps.agentInputCoordinatorHolder?.getAcceptedInputProvenance(session.id);
    const replyInputId = inputId && inputProvenance?.clientId === inputId && inputProvenance.autoResume
      ? inputProvenance.retrySourceClientId ?? inputId : inputId;
    const privateReply = inputId
      ? isBotGroupClientId(inputId) || (!!replyInputId?.startsWith('bot-dm:') && !event.runtimeRecovery)
      : event.agentMeta?.botPrivateReply;
    if (typeof text === 'string') {
      onStandaloneTextEvent(session.id, text,
        typeof privateReply === 'boolean' ? { botPrivateReply: privateReply } : null);
    }
    return true;
  }
  return false;
}

/** The normalized data of a Claude Opus plan-mode terminal error, consuming its observation. */
export function claudeOpusPlanTerminalErrorData(
  deps: { readonly log: { warn(...args: unknown[]): void } },
  session: Pick<Session, 'id' | 'remoteHostId' | 'agentKind' | 'model'>,
  event: AgentEvent,
): Record<string, unknown> | null {
  if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {
    const reason =
      !session.remoteHostId && session.agentKind === 'claude-code'
        ? consumeClaudeOpusPlanMismatch(session.id)
        : null;
    if (reason) {
      const eventData =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      deps.log.warn('Claude Opus plan error normalized for renderer', {
        sessionId: session.id,
        model: session.model,
        reason,
      });
      return { ...eventData, reason };
    }
  }
  return null;
}

/** A card the runtime closed itself: its pending entry, decision and clients. */
export function handleInteractionDismissedEvent(
  deps: InteractionDismissedDeps,
  session: Pick<Session, 'id'>,
  event: AgentEvent,
): boolean {
  if (event.type === 'interaction_dismissed') {
    const data = event.data as { requestId?: unknown; reason?: unknown; withdrawalReason?: unknown };
    if (typeof data.requestId === 'string') {
      deps.handleAgentIslandInteractionDismissed(session.id, data.requestId);
      const entry = deps.clearPendingInteraction(data.requestId);
      if (entry) {
        const decision = deps.defaultDecisionForPending(
          entry.kind,
          typeof data.reason === 'string' ? data.reason : 'dismissed',
        );
        const persistedDecision = data.reason === 'question_withdrawn' && entry.kind === 'ask_user_question'
          && typeof data.withdrawalReason === 'string'
          ? { ...decision, withdrawalReason: data.withdrawalReason } : decision;
        entry.resolve(decision);
        deps.persistInteractionDecision(
          session.id,
          entry.persistId,
          entry.kind,
          entry.request,
          persistedDecision,
        );
      }
    }
    deps.broadcastToAllWindows(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: session.id,
      ...(event.data as object),
    });
    return true;
  }
  return false;
}

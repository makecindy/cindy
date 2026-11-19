import { isTerminalAgentErrorEvent, type SendOrigin, type Session, type SessionSendOptions, type SessionSendResult, type TurnPermissionPolicy } from '@cindy/maker-core';
import { isProductTurnDoneEvent } from '@cindy/maker-shared/turn-continuation';
import { beginTemporaryImPermission } from '../im/shared/temporaryTurnPermission.js';
import { createLogger } from '../logger.js';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

const log = createLogger('telegram-question');

// The capability belongs to the live turn. A session binding or a client-supplied
// question id alone must never make ordinary App input public.
interface QuestionRoute {
  activate(session: object): void;
  answerOrigin: SendOrigin;
  permissions?: { session: Session; policy: TurnPermissionPolicy };
}
const routes = new WeakMap<SendOrigin, QuestionRoute>();
export const TELEGRAM_QUESTION_ORIGIN = Symbol('telegram-question-origin');

export function telegramQuestionOrigin(activate: (session: object) => void, permissions?: QuestionRoute['permissions']): SendOrigin {
  const origin: SendOrigin = { kind: 'user', surface: 'im' };
  const route: QuestionRoute = { activate, answerOrigin: { kind: 'user' }, permissions };
  routes.set(origin, route);
  routes.set(route.answerOrigin, route);
  return origin;
}

export function hasTelegramQuestionRoute(origin?: SendOrigin | null): origin is SendOrigin {
  return !!origin && routes.has(origin);
}

export function activateTelegramQuestionReply(origin: SendOrigin | undefined, session: object): void {
  if (origin) routes.get(origin)?.activate(session);
}

type QueuedAnswer = AgentInputQueuedMessage & {
  [TELEGRAM_QUESTION_ORIGIN]?: Pick<AgentInputQueuedMessage, 'clientId' | 'text' | 'persistedContent'> & { origin: SendOrigin };
};

export function stampTelegramQuestionAnswer(item: QueuedAnswer, origin: SendOrigin): void {
  item[TELEGRAM_QUESTION_ORIGIN] = { origin, clientId: item.clientId, text: item.text, persistedContent: item.persistedContent };
}

export function telegramQuestionAnswerOrigin(item: QueuedAnswer): SendOrigin | undefined {
  const receipt = item[TELEGRAM_QUESTION_ORIGIN];
  if (!receipt || receipt.clientId !== item.clientId || receipt.text !== item.text ||
      receipt.persistedContent !== item.persistedContent || item.files?.length || item.sessionRefs?.length ||
      item.mentions?.length || item.agentReferences?.length || item.contextFiles?.length || item.mergedDeliveryClientIds?.length) return;
  return routes.get(receipt.origin)?.answerOrigin;
}

// Only the coordinator's explicit retry boundary may transfer this capability
// to a freshly generated input identity or a host-generated continuation.
export function inheritTelegramQuestionRetry(previous: QueuedAnswer, retry: QueuedAnswer): void {
  const origin = telegramQuestionAnswerOrigin(previous);
  if (origin) stampTelegramQuestionAnswer(retry, origin);
}

// Policy and destination share the same host-only capability across answers and retries.
// Session reservations serialize the temporary mode change with other sends.
export async function withTelegramQuestionPolicy(
  origin: SendOrigin | undefined,
  session: object,
  send: (options: Partial<SessionSendOptions>) => Promise<SessionSendResult>,
): Promise<SessionSendResult> {
  const permissions = origin && routes.get(origin)?.permissions;
  if (!permissions) return send({});
  if (permissions.session !== session) throw new Error('Question runtime changed');
  let restore = () => {};
  let unsubscribe = () => {};
  let unsubscribeStatus = () => {};
  const cleanup = () => {
    unsubscribe();
    unsubscribeStatus();
    restore();
    restore = () => {};
  };
  try {
    const result = await send({
      turnPermissionPolicy: permissions.policy,
      afterTurnReserved: async () => {
        const generation = permissions.session.getTurnGeneration();
        await beginTemporaryImPermission(permissions.session, cleanup => { restore = cleanup; },
          () => log.warn('temporary question permission cleanup failed'));
        unsubscribe = permissions.session.onEvent(event => {
          // Session owns terminal attribution. Origins are shared across answers and
          // cannot prove that a late terminal belongs to this send's reservation.
          const terminal = permissions.session.getObservedCurrentTurnTerminal();
          if (permissions.session.getTurnGeneration() === generation &&
              event.sessionInstanceId === permissions.session.instanceId &&
              event.sessionTurnGeneration === generation && terminal.generation === generation &&
              terminal.kind !== 'none' && event.turnScope !== 'background' && !event.agentMeta?.parentUuid &&
              (isProductTurnDoneEvent(event) || isTerminalAgentErrorEvent(event))) cleanup();
        });
        unsubscribeStatus = permissions.session.onStatusChange(status => {
          if (status === 'closed' || status === 'error') cleanup();
        });
      },
    });
    if (!result.accepted) cleanup();
    return result;
  } catch (error) { cleanup(); throw error; }
}

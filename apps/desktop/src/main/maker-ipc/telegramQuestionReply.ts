import type { SendOrigin } from '@cindy/maker-core';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

// The capability belongs to the live turn. A session binding or a client-supplied
// question id alone must never make ordinary App input public.
interface QuestionRoute {
  activate(session: object): void;
  answerOrigin: SendOrigin;
}
const routes = new WeakMap<SendOrigin, QuestionRoute>();
export const TELEGRAM_QUESTION_ORIGIN = Symbol('telegram-question-origin');

export function telegramQuestionOrigin(activate: (session: object) => void): SendOrigin {
  const origin: SendOrigin = { kind: 'user', surface: 'im' };
  const route: QuestionRoute = { activate, answerOrigin: { kind: 'user' } };
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

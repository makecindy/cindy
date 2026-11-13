import {
  answerKey,
  askAnswerError,
  askQuestionOptions,
  buildAskUserQuestionDecision,
  describePermissionAction,
  normalizeAskQuestions,
  permissionAlertOperation,
  permissionInput,
  permissionRiskSummary,
  permissionToolName,
  readRequestId,
} from '@cindy/maker-shared/interaction';
import { buildPermissionDecision, resolveInteractionResilient } from '@/session/interactionModel';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { APPROVE_ACTION, DENY_ACTION, OPTION_ACTION_PREFIX, REPLY_ACTION } from './notificationActionIds';
import { parseNotificationResponseDeepLink } from './pushRegistrationModel';

/** Buttons on a task alert: what a press means and how it is carried out (docs/product-rules/notification-actions.md). */

/** Same bound as the notify protocol's `NOTIFY_ACTION_REQUEST_ID_MAX_LENGTH`. */
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ID_LENGTH = 256;
/** A dictated reply, not a document; longer text belongs in the app. */
export const MAX_NOTIFICATION_REPLY_LENGTH = 4000;

interface ActionTarget {
  sessionId: string;
  deviceId: string;
  /** In-app route of the task; a failed action sends the person here. */
  route: string;
  /** Alert title (the task's), reused when reporting a failure. */
  title: string;
  /**
   * Identity of this alert. The system reuses one notification identifier for
   * every alert of a task (it is the collapse id), so the delivery time tells
   * two alerts apart; a replayed response of the same alert keeps the same key.
   */
  alertKey: string;
}

export type NotificationActionRequest =
  | (ActionTarget & {
    kind: 'permission';
    decision: 'allow' | 'deny';
    requestId: string;
    /** The text the alert showed. Allowing requires it to contain the whole operation. */
    shownBody: string;
  })
  | (ActionTarget & {
    kind: 'question';
    requestId: string;
    /** The option button that was pressed (its label as the alert listed it), or what the person typed or dictated. */
    answer: { option: string } | { text: string };
  })
  | (ActionTarget & { kind: 'reply'; text: string });

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** The push payload reaches JS under `content.data` or `trigger.payload`, sometimes wrapped once. */
function payloadRecords(response: Record<string, unknown>): Record<string, unknown>[] {
  const request = record(record(response.notification)?.request);
  const roots = [record(record(request?.content)?.data), record(record(request?.trigger)?.payload)];
  return roots.flatMap(root => [root, record(root?.body), record(root?.data)])
    .filter((item): item is Record<string, unknown> => item !== null);
}

function sessionTarget(route: string): { sessionId: string; deviceId: string } | null {
  const match = /^\/sessions\/([^/?#]+)\?([^#]*)$/.exec(route);
  if (!match) return null;
  let sessionId: string;
  try { sessionId = decodeURIComponent(match[1]!); } catch { return null; }
  const deviceId = new URLSearchParams(match[2]).get('deviceId') ?? '';
  if (!sessionId || !deviceId || sessionId.length > MAX_ID_LENGTH || deviceId.length > MAX_ID_LENGTH
    || hasControlCharacter(sessionId) || hasControlCharacter(deviceId)) return null;
  return { sessionId, deviceId };
}

/**
 * Reads a button press from a notification response.
 *  - `null`: an ordinary tap; the caller opens the task as before.
 *  - `'invalid'`: a button was pressed but the alert does not say, in the form
 *    this app accepts, what it answers. Nothing may be sent for it.
 * The payload came through third-party push channels and is treated as untrusted:
 * a permission answer needs the request id the alert itself carried, and only a
 * task route with its computer is accepted as the target.
 */
export function parseNotificationAction(response: unknown): NotificationActionRequest | 'invalid' | null {
  const value = record(response);
  const actionIdentifier = value?.actionIdentifier;
  const optionIndex = typeof actionIdentifier === 'string' && /^option:\d{1,2}$/.test(actionIdentifier)
    ? Number(actionIdentifier.slice(OPTION_ACTION_PREFIX.length)) : null;
  if (actionIdentifier !== APPROVE_ACTION && actionIdentifier !== DENY_ACTION && actionIdentifier !== REPLY_ACTION
    && optionIndex === null) return null;
  const route = parseNotificationResponseDeepLink(response);
  const ids = route ? sessionTarget(route) : null;
  if (!value || !route || !ids) return 'invalid';
  const notification = record(value.notification);
  const request = record(notification?.request);
  const content = record(request?.content);
  const target: ActionTarget = {
    ...ids,
    route,
    title: typeof content?.title === 'string' ? content.title : '',
    alertKey: `${typeof request?.identifier === 'string' ? request.identifier : ''}@${String(notification?.date ?? '')}`,
  };
  const action = payloadRecords(value).map(item => record(item.action)).find(item => item !== null) ?? null;
  const requestId = action?.requestId;
  const boundRequest = typeof requestId === 'string' && requestId.length > 0
    && requestId.length <= MAX_REQUEST_ID_LENGTH && !hasControlCharacter(requestId) ? requestId : null;
  const text = typeof value.userText === 'string' ? value.userText.trim() : '';
  if (action?.kind === 'question') {
    if (!boundRequest) return 'invalid';
    if (optionIndex !== null) {
      // The button stands for the option the alert listed at that position.
      const option = Array.isArray(action.options) ? action.options[optionIndex] : undefined;
      return typeof option === 'string' && option
        ? { ...target, kind: 'question', requestId: boundRequest, answer: { option } } : 'invalid';
    }
    if (actionIdentifier !== REPLY_ACTION || !text || text.length > MAX_NOTIFICATION_REPLY_LENGTH) return 'invalid';
    return { ...target, kind: 'question', requestId: boundRequest, answer: { text } };
  }
  if (optionIndex !== null) return 'invalid';
  if (actionIdentifier === REPLY_ACTION) {
    if (action?.kind !== 'reply' || !text || text.length > MAX_NOTIFICATION_REPLY_LENGTH) return 'invalid';
    return { ...target, kind: 'reply', text };
  }
  if (action?.kind !== 'permission' || !boundRequest) return 'invalid';
  return {
    ...target,
    kind: 'permission',
    decision: actionIdentifier === APPROVE_ACTION ? 'allow' : 'deny',
    requestId: boundRequest,
    shownBody: typeof content?.body === 'string' ? content.body : '',
  };
}

/**
 * `sent`: the computer took it. `ended`: the request was already answered or
 * expired, so nothing was changed. `failed`: it did not get through.
 */
export type NotificationActionOutcome = 'sent' | 'ended' | 'failed';

type ActionMaker = Pick<MobileMakerTransport, 'resolveInteraction' | 'getPendingInteractions' | 'getSession'> & {
  input: Pick<MobileMakerTransport['input'], 'enqueue'>;
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Failures raised before anything left the phone. The app was just woken, so
 * the connection is usually still coming up and presence may predate it.
 */
function notYetConnected(error: unknown): boolean {
  return ['NOT_CONNECTED', 'BACKPRESSURE', 'DEVICE_OFFLINE'].includes(errorCode(error));
}

/**
 * Whether "Allow once" may be sent for what is waiting on the computer. The
 * phone decides this itself from the request it reads over its own connection:
 * the push only carried a request id and some text, through third parties. So
 * the request must be the only thing waiting in the task, must be a kind the
 * card asks about in plain words and not a high-risk command, and the alert the
 * person read must end with its whole operation. An alert that showed anything
 * else approves nothing.
 */
function allowableFromAlert(
  pending: readonly { request: Record<string, unknown> }[],
  requestId: string,
  shownBody: string,
): boolean {
  if (pending.length !== 1) return false;
  const request = pending[0]!.request;
  if (request.kind !== 'permission' || request.requestId !== requestId) return false;
  if (permissionRiskSummary(request)) return false;
  const action = describePermissionAction(permissionToolName(request), permissionInput(request));
  if (action.kind === 'tool' || action.kind === 'mcp') return false;
  if (action.kind === 'plugin' && !action.subject) return false;
  // For a plugin call the operation names the plugin: an alert that showed another plugin's
  // name above the same tool and arguments does not end with this request's line.
  const operation = permissionAlertOperation(action);
  return operation.length > 0 && shownBody.endsWith(`\n${operation}`);
}

/**
 * The answer a press gives to the question waiting on the computer, or null
 * when it is not an answer the question accepts. Decided against the question
 * as the phone reads it from the computer, never against the push: a pressed
 * option must be one of its options, and a typed or dictated reply is that
 * option's number or name when it matches one, otherwise the person's own
 * answer where the question allows one.
 */
function questionAnswer(
  pending: readonly { request: Record<string, unknown> }[],
  requestId: string,
  answer: { option: string } | { text: string },
): Record<string, unknown> | null {
  const item = pending.find(entry => entry.request.requestId === requestId);
  if (!item || item.request.kind !== 'ask_user_question' || item.request.delivery === 'async') return null;
  const questions = normalizeAskQuestions(item.request.questions);
  const question = questions[0];
  if (questions.length !== 1 || !question || question.multiSelect) return null;
  const labels = askQuestionOptions(question).map(option => option.label);
  let value: string;
  if ('option' in answer) {
    if (!labels.includes(answer.option)) return null;
    value = answer.option;
  } else {
    const typed = answer.text;
    const numbered = /^\d{1,2}$/.test(typed) ? labels[Number(typed) - 1] : undefined;
    const named = labels.find(label => label.toLowerCase() === typed.toLowerCase());
    value = numbered ?? named ?? typed;
  }
  return askAnswerError(question, value) ? null : buildAskUserQuestionDecision({ [answerKey(question)]: value });
}

/**
 * Carries out one button press against the computer. `until` is the wall-clock
 * deadline of the background time the system granted: no request is started
 * after it, so a press reported as undelivered is not delivered later.
 *
 * A permission answer applies to the request the alert described and to nothing
 * else: it is sent only while that request is still waiting, with "allow" meaning
 * this one time and only for an operation the alert showed in full. A reply is
 * enqueued once; after an ambiguous send it is not repeated, because a second
 * copy would be a second message.
 */
export async function performNotificationAction(
  request: NotificationActionRequest,
  maker: ActionMaker,
  opts: { until: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<NotificationActionOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const inTime = <T,>(call: () => Promise<T>): Promise<T> => (
    now() < opts.until ? call() : Promise.reject(new Error('notification action deadline passed'))
  );
  /** Retries a read that has no effect on the computer until it connects or time runs out. */
  const whenConnected = async <T,>(read: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { return await inTime(read); } catch (error) {
        if (!notYetConnected(error) || now() + 500 >= opts.until) throw error;
        await sleep(500);
      }
    }
  };
  try {
    if (request.kind === 'permission') {
      const readPending = () => maker.getPendingInteractions(request.sessionId);
      const isWaiting = (pending: Awaited<ReturnType<typeof readPending>>) => pending
        .some(item => readRequestId(item) === request.requestId && item.request?.kind === 'permission');
      const pending = await whenConnected(readPending);
      if (!isWaiting(pending)) return 'ended';
      if (request.decision === 'allow' && !allowableFromAlert(pending, request.requestId, request.shownBody)) return 'failed';
      const decision = request.decision === 'allow'
        ? buildPermissionDecision('allow')
        : buildPermissionDecision('deny', { reason: 'User denied' });
      try {
        // Resolving is one-shot on the computer: a repeat of an answered request is refused, never applied twice.
        await resolveInteractionResilient({
          resolveInteraction: (id, value) => inTime(() => maker.resolveInteraction(id, value)),
          getPendingInteractions: sessionId => inTime(() => maker.getPendingInteractions(sessionId)),
        }, request.sessionId, request.requestId, decision, { sleep });
        return 'sent';
      } catch {
        // Refused or unconfirmed. If the request is gone, another surface answered it or it
        // expired in the meantime; if it is still waiting, this answer did not get through.
        return isWaiting(await inTime(readPending)) ? 'failed' : 'ended';
      }
    }
    if (request.kind === 'question') {
      const readPending = () => maker.getPendingInteractions(request.sessionId);
      const isWaiting = (pending: Awaited<ReturnType<typeof readPending>>) => pending
        .some(item => readRequestId(item) === request.requestId);
      const pending = await whenConnected(readPending);
      if (!isWaiting(pending)) return 'ended';
      const decision = questionAnswer(pending, request.requestId, request.answer);
      if (!decision) return 'failed';
      try {
        await resolveInteractionResilient({
          resolveInteraction: (id, value) => inTime(() => maker.resolveInteraction(id, value)),
          getPendingInteractions: sessionId => inTime(() => maker.getPendingInteractions(sessionId)),
        }, request.sessionId, request.requestId, decision, { sleep });
        return 'sent';
      } catch {
        return isWaiting(await inTime(readPending)) ? 'failed' : 'ended';
      }
    }
    const session = await whenConnected(() => maker.getSession(request.sessionId));
    if (!session?.workingDir) return 'failed';
    // One alert, one reply: a replayed response reuses the message id and the computer keeps one copy.
    const item = buildQueuedTextMessage(session, request.text, new Date(now()), `notification-reply:${request.alertKey}`);
    await inTime(() => maker.input.enqueue(request.sessionId, item, { sendAtMs: now() }));
    return 'sent';
  } catch {
    return 'failed';
  }
}

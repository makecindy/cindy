import { i18n } from '@/i18n';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { beginBackgroundWork } from './backgroundWork';
import Notifications from './nativeNotifications';
import { ACTION_RESULT_DATA_KEY } from './notificationActionIds';
import {
  parseNotificationAction,
  performNotificationAction,
  type NotificationActionOutcome,
  type NotificationActionRequest,
} from './notificationActions';

/**
 * Runs a button press from a task alert while the app stays in the background
 * (docs/product-rules/notification-actions.md).
 *
 * The press arrives outside the signed-in tree: the app may have been suspended
 * for hours or just launched. This module waits for the device-link layer to
 * offer its transport, keeps the connection for the one action, and tells the
 * person when the action did not get through.
 */

/** Upper bound for one action, connection included. The system's grant can be shorter. */
const ACTION_BUDGET_MS = 25_000;

export interface NotificationActionTransport {
  /** The guard must reach invoke's actual preSend check after connection/queue waits. */
  makerFor(deviceId: string, preSend: () => void): MobileMakerTransport;
  /** Keep the relay connection in the background until the returned release is called. */
  holdConnection(): () => void;
}

let transport: NotificationActionTransport | null = null;
const transportWaiters = new Set<() => void>();

/** The device-link provider offers its transport while mounted; `null` withdraws it. */
export function setNotificationActionTransport(next: NotificationActionTransport | null): void {
  transport = next;
  if (next) for (const wake of [...transportWaiters]) wake();
}

function transportBy(until: number): Promise<NotificationActionTransport | null> {
  if (transport) return Promise.resolve(transport);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); transportWaiters.delete(done); resolve(transport); };
    const timer = setTimeout(done, Math.max(0, until - Date.now()));
    transportWaiters.add(done);
  });
}

const claimedActions = new Set<string>();

/**
 * A press is acted on once per process. The system replays the last response to
 * late listeners and on return to the foreground; without the claim a press
 * reported as undelivered could be sent minutes later. The key is the alert and
 * what was pressed, so a later alert of the same task is a new press.
 */
function claimAction(key: string): boolean {
  if (claimedActions.has(key)) return false;
  claimedActions.add(key);
  return true;
}

async function reportUndelivered(request: NotificationActionRequest | null, outcome: Exclude<NotificationActionOutcome, 'sent'>): Promise<void> {
  const body = outcome === 'ended'
    ? i18n.t('settings.notifications.actionRequestEnded')
    : request?.kind === 'reply' || (request?.kind === 'question' && 'text' in request.answer)
      ? i18n.t('settings.notifications.actionReplyNotDelivered', {
        text: request.kind === 'reply' ? request.text : (request.answer as { text: string }).text,
      })
      : i18n.t('settings.notifications.actionNotDelivered');
  await Notifications.scheduleNotificationAsync({
    content: {
      title: request?.title || 'Cindy',
      body,
      // Tapping it opens the task through the ordinary alert route.
      data: { [ACTION_RESULT_DATA_KEY]: true, ...(request ? { deepLink: request.route } : {}) },
    },
    trigger: null,
  }).catch(() => undefined);
}

/**
 * Handles a notification response if it is a button press. Returns false for an
 * ordinary tap, which the caller routes as before. Never throws: the outcome
 * the person needs to know about is reported as a local alert.
 */
export function handleNotificationActionResponse(
  response: unknown,
  opts: { canRun?: boolean } = {},
): boolean {
  const request = parseNotificationAction(response);
  if (request === null) return false;
  const value = response as { actionIdentifier?: unknown; notification?: { date?: unknown; request?: { identifier?: unknown } } };
  const key = request === 'invalid'
    ? `invalid:${String(value.notification?.request?.identifier ?? '')}@${String(value.notification?.date ?? '')}:${String(value.actionIdentifier)}`
    : `${request.alertKey}:${request.kind === 'permission' ? `${request.decision}:${request.requestId}`
      : request.kind === 'question' ? `answer:${request.requestId}` : 'reply'}`;
  if (!claimAction(key)) return true;
  void Notifications.clearLastNotificationResponseAsync?.()?.catch(() => undefined);
  void (async () => {
    if (request === 'invalid') { await reportUndelivered(null, 'failed'); return; }
    if (opts.canRun === false) { await reportUndelivered(request, 'failed'); return; }
    // Anything that goes wrong on the way is a press that did not get through.
    const outcome = await runNotificationAction(request).catch((): NotificationActionOutcome => 'failed');
    if (outcome !== 'sent') await reportUndelivered(request, outcome);
  })().catch(() => undefined);
  return true;
}

async function runNotificationAction(request: NotificationActionRequest): Promise<NotificationActionOutcome> {
  const work = await beginBackgroundWork(ACTION_BUDGET_MS);
  const until = Date.now() + work.budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await transportBy(until);
    if (!current) return 'failed';
    const release = current.holdConnection();
    try {
      return await Promise.race([
        // Starts no request after `until`; one already on its way may still land.
        performNotificationAction(request, current.makerFor(request.deviceId, () => {
          if (Date.now() >= until) throw new Error('notification action deadline passed');
        }), { until }),
        new Promise<NotificationActionOutcome>(resolve => { timer = setTimeout(() => resolve('failed'), Math.max(0, until - Date.now())); }),
      ]);
    } finally {
      release();
    }
  } finally {
    clearTimeout(timer);
    work.end();
  }
}

/** Live, same-account notification delivery. No snapshot, replay or server persistence. */
export const MOBILE_NOTIFICATION_CAPABILITY = 'mobile-local-notifications-v1';
export const MOBILE_NOTIFICATION_CHANNEL = 'device-link:mobile-notification';
export const MOBILE_NOTIFICATION_TOPIC_PREFIX = 'notifications:';

export function isMobileNotificationTopic(value: unknown): value is `notifications:${string}` {
  return typeof value === 'string' && /^notifications:[a-f0-9-]{36}$/.test(value);
}

export interface MobileLocalNotification {
  /** Stable per completed reply/run, distinct from the per-session collapse key. */
  eventId: string;
  createdAt: number;
  /** Fresh receiver nonce. A frame from an earlier subscription is silent. */
  subscriptionId: string;
  category: 'session-done';
  title: string;
  body?: string;
  deepLink: string;
  collapseId: string;
  sender?: import('./protocol.js').NotifySender;
}

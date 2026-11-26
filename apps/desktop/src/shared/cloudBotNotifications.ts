/**
 * Notification controls of personal bot cards, exposed to the cloud settings client as
 * management items. They use only existing management intents and fields, so CIS needs no
 * schema change; an older runtime simply does not list them.
 *
 * The client renders them inside the matching channel card, never as cards of their own.
 */
export const BOT_NOTIFICATION_GROUP = 'management.botNotifications';

export const BOT_NOTIFICATION_ITEMS = {
  /** status: webhook configured; detail: masked key; create/sync/delete: save-and-test, test, remove. */
  wecomGroup: 'notify:wecom-group',
  /** status: owner bound; edit: lifecycle announcement select. */
  feishu: 'notify:feishu',
  /** edit: lifecycle announcement select. */
  discord: 'notify:discord',
} as const;

export const LIFECYCLE_ANNOUNCEMENT_FIELD = 'lifecycleAnnouncement';
export const WECOM_GROUP_WEBHOOK_FIELD = 'webhookUrl';
export const WECOM_GROUP_MESSAGE_FIELD = 'message';

/**
 * Identifiers of the buttons a task alert can carry (docs/product-rules/notification-actions.md).
 *
 * They are a contract with the push service, which names the system category in
 * `aps.category`, and with apps already installed: never rename them.
 */
export const PERMISSION_CATEGORY = 'cindy.permission';
export const REPLY_CATEGORY = 'cindy.reply';
/**
 * A question the agent asked. The expanded alert is the custom card, which adds one button per
 * option; the category itself carries "Reply" and "Open task", which is all the Apple Watch shows.
 */
export const QUESTION_CARD_CATEGORY = 'cindy.question.card';
/** Opens the task in the app; an ordinary tap does the same. */
export const OPEN_ACTION = 'open';
/** `option:<index>` into the options the alert listed. */
export const OPTION_ACTION_PREFIX = 'option:';
export const APPROVE_ACTION = 'approve';
export const DENY_ACTION = 'deny';
export const REPLY_ACTION = 'reply';

/** Marks the local alert that reports an undelivered action, so it shows in the foreground too. */
export const ACTION_RESULT_DATA_KEY = 'cindyActionResult';

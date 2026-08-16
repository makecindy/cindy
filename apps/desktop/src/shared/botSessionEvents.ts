/**
 * Open Cindy task-event contract used by Bot subscriptions and inboxes.
 *
 * Known event names are exported for producers, while `BotSessionEventType`
 * intentionally remains `string`: new task states must not require a schema
 * migration or a central enum edit before Bots can subscribe to them.
 */
export const BOT_SESSION_EVENT = {
  TURN_COMPLETED: 'session.turn.completed',
  TURN_FAILED: 'session.turn.failed',
  METADATA_CHANGED: 'session.metadata.changed',
  DECISION_REQUIRED: 'session.decision.required',
} as const;

export type BotSessionEventType = string;

export const BOT_INBOX_STATUSES = [
  'pending',
  'processing',
  'handled',
  'failed',
  'skipped',
] as const;

export type BotInboxStatus = (typeof BOT_INBOX_STATUSES)[number];

export interface BotSessionEventPayload {
  sessionId: string;
  eventType: BotSessionEventType;
  title: string;
  status: string;
  source: string;
  workingDir: string;
  occurredAt: number;
  outcome?: 'completed' | 'failed';
  failureCode?: string;
  changedFields?: string[];
  decisionState?: string;
  originBotId?: string;
  lineage?: string[];
  hopCount?: number;
}

export interface BotEventSubscriptionRule {
  /** Exact names or prefix patterns ending in `.*`. Empty means every event. */
  eventTypes: string[];
  /** Optional Session source allow-list. */
  sources?: string[];
  /** Optional working-directory prefixes. */
  workingDirPrefixes?: string[];
  /** Only decision events whose normalized state is listed here. */
  decisionStates?: string[];
  /** Prevent a Bot's own canonical/route tasks from recursively waking it. */
  excludeOwnBotSessions?: boolean;
  /** Automatically enqueue a turn in the Bot canonical task. */
  wakeMode: 'automatic' | 'manual';
  /** Deliver the Bot-generated result to mounted Routes after processing. */
  resultDelivery: 'all-active-routes' | 'none';
  /** Optional Channel-kind allow-list for result delivery. */
  deliveryChannelKinds?: string[];
}

export interface BotEventSubscriptionView {
  id: string;
  botId: string;
  name: string;
  status: 'active' | 'paused';
  rule: BotEventSubscriptionRule;
  createdAt: number;
  updatedAt: number;
}

export interface BotInboxItemView {
  id: string;
  botId: string;
  subscriptionId: string;
  eventId: string;
  status: BotInboxStatus;
  attempts: number;
  lastError: string | null;
  resultText: string | null;
  resultDeliveryStatus: 'none' | 'queued' | 'partial' | 'failed';
  resultDeliveryError: string | null;
  receivedAt: number;
  startedAt: number | null;
  handledAt: number | null;
  updatedAt: number;
  event: BotSessionEventPayload;
}

export interface BotInboxChangedPayload {
  botId: string;
  inboxItemId?: string;
}

function matchesEventType(pattern: string, eventType: string): boolean {
  const normalized = pattern.trim();
  if (!normalized) return false;
  if (normalized === '*') return true;
  if (normalized.endsWith('.*')) return eventType.startsWith(normalized.slice(0, -1));
  return normalized === eventType;
}

export function normalizeBotEventSubscriptionRule(
  input: Partial<BotEventSubscriptionRule> | null | undefined,
): BotEventSubscriptionRule {
  const uniqueStrings = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
      : [];
  return {
    eventTypes: uniqueStrings(input?.eventTypes),
    ...(uniqueStrings(input?.sources).length > 0 ? { sources: uniqueStrings(input?.sources) } : {}),
    ...(uniqueStrings(input?.workingDirPrefixes).length > 0
      ? { workingDirPrefixes: uniqueStrings(input?.workingDirPrefixes) }
      : {}),
    ...(uniqueStrings(input?.decisionStates).length > 0
      ? { decisionStates: uniqueStrings(input?.decisionStates) }
      : {}),
    excludeOwnBotSessions: input?.excludeOwnBotSessions !== false,
    wakeMode: input?.wakeMode === 'manual' ? 'manual' : 'automatic',
    resultDelivery: input?.resultDelivery === 'none' ? 'none' : 'all-active-routes',
    ...(uniqueStrings(input?.deliveryChannelKinds).length > 0
      ? { deliveryChannelKinds: uniqueStrings(input?.deliveryChannelKinds) }
      : {}),
  };
}

export function matchesBotEventSubscription(
  ruleInput: Partial<BotEventSubscriptionRule> | null | undefined,
  event: BotSessionEventPayload,
  ownBotId: string,
): boolean {
  const rule = normalizeBotEventSubscriptionRule(ruleInput);
  if (
    rule.eventTypes.length > 0
    && !rule.eventTypes.some((pattern) => matchesEventType(pattern, event.eventType))
  ) return false;
  if (rule.sources?.length && !rule.sources.includes(event.source)) return false;
  if (
    rule.workingDirPrefixes?.length
    && !rule.workingDirPrefixes.some((prefix) => event.workingDir.startsWith(prefix))
  ) return false;
  if (
    rule.decisionStates?.length
    && event.eventType === BOT_SESSION_EVENT.DECISION_REQUIRED
    && (!event.decisionState || !rule.decisionStates.includes(event.decisionState))
  ) return false;
  if (rule.excludeOwnBotSessions !== false && event.originBotId === ownBotId) return false;
  if ((event.lineage ?? []).includes(ownBotId)) return false;
  return (event.hopCount ?? 0) < 8;
}

export const DEFAULT_CONTROL_BOT_EVENT_RULE: BotEventSubscriptionRule = {
  eventTypes: [
    BOT_SESSION_EVENT.TURN_COMPLETED,
    BOT_SESSION_EVENT.TURN_FAILED,
    BOT_SESSION_EVENT.DECISION_REQUIRED,
  ],
  decisionStates: ['等拍板', '待验收', '待总控'],
  excludeOwnBotSessions: true,
  wakeMode: 'automatic',
  resultDelivery: 'all-active-routes',
};

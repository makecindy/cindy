/**
 * Bot-side consumer contract for the unified Cindy task-state projection.
 *
 * The control-plane work owns the authoritative state model and transition
 * publisher. Cindy Bots only consumes that stream, applies logical
 * subscriptions, persists matched transitions, and optionally activates a Bot
 * turn. There is deliberately no producer/publish API in this module.
 *
 * `BotObservedSessionState` mirrors the four open facets currently reserved by
 * the control-plane Draft. Before this PR can become Ready it must be aliased or
 * adapted to the final exported control-plane type rather than becoming a
 * second source of task truth.
 */
export interface BotObservedSessionState {
  lifecycle: string;
  execution: string;
  attention: string | null;
  workflow: {
    key: string;
    label?: string;
    waitingOn?: string;
  } | null;
  /** Canonical control-plane activity clocks used by the zero-token guardian. */
  startedAtMs?: number | null;
  lastActivityAtMs?: number | null;
  turnGeneration?: number | null;
}

export interface BotSessionStateTransition {
  /** Stable id/generation supplied by the authoritative state publisher. */
  transitionId: string;
  sessionId: string;
  occurredAt: number;
  previous: BotObservedSessionState;
  current: BotObservedSessionState;
  /** Open facet names; consumers must ignore unknown additions. */
  changedFacets: string[];
  /** Display/routing context from the same projection snapshot. */
  title: string;
  source: string;
  workingDir: string;
}

export interface BotSessionStateTransitionSource {
  subscribe(listener: (transition: BotSessionStateTransition) => void): () => void;
  /**
   * Canonical point-in-time read from the same control-plane model. Optional
   * only until the control-plane dependency is merged and wired.
   */
  readSnapshot?(sessionId: string): Promise<BotObservedSessionState | null>;
}

export const BOT_SESSION_EVENT = {
  STATE_TRANSITION: 'session.state.transition',
  GUARDIAN_ANOMALY: 'session.state.guardian-anomaly',
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
  /** Missing only on inbox rows written by the corrected-away Draft producer. */
  transitionId?: string;
  title: string;
  status: string;
  source: string;
  workingDir: string;
  occurredAt: number;
  /** Authoritative state snapshots. Missing only on legacy Draft inbox rows. */
  previousState?: BotObservedSessionState;
  currentState?: BotObservedSessionState;
  changedFacets?: string[];
  outcome?: 'completed' | 'failed';
  workflowState?: { key: string; label?: string };
  guardianAnomaly?: {
    kind: 'stale-running' | 'expected-event-missing' | 'unclaimed-decision';
    relation: string;
    detectedAt: number;
    supervisedAt: number;
    thresholdMs: number;
    fingerprint: string;
  };
  /** Compatibility for inbox rows created by the earlier Draft producer. */
  decisionState?: string;
  originBotId?: string;
  lineage?: string[];
  hopCount?: number;
}

export interface BotEventSubscriptionRule {
  /**
   * Logical relationships resolved at match time. `all-local` is the broad
   * control-Bot scope; other open values include `delegated-by-bot` and future
   * watch-list relationships. Session ids never live in this rule.
   */
  sessionRelations: string[];
  /** Match when the corresponding authoritative facet changes into a value. */
  executionStates?: string[];
  attentionStates?: string[];
  workflowStates?: string[];
  /** Optional task metadata constraints, evaluated after the logical relation. */
  sources?: string[];
  workingDirPrefixes?: string[];
  /** Prevent a Bot's own canonical/route tasks from recursively waking it. */
  excludeOwnBotSessions?: boolean;
  /** `heartbeat-turn` activates the canonical Bot task; `inbox-only` only records. */
  activationMode: 'heartbeat-turn' | 'inbox-only';
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

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))]
    : [];
}

/**
 * Reads the short-lived Draft shape as well as the state-transition shape, so
 * local preview data made before this design correction remains usable.
 */
export function normalizeBotEventSubscriptionRule(
  input: Partial<BotEventSubscriptionRule> | null | undefined,
): BotEventSubscriptionRule {
  const legacy = input as (Partial<BotEventSubscriptionRule> & {
    eventTypes?: unknown;
    decisionStates?: unknown;
    wakeMode?: unknown;
  }) | null | undefined;
  const legacyEventTypes = uniqueStrings(legacy?.eventTypes);
  const executionStates = uniqueStrings(input?.executionStates);
  if (executionStates.length === 0) {
    if (legacyEventTypes.includes('session.turn.completed')) executionStates.push('normal-ended');
    if (legacyEventTypes.includes('session.turn.failed')) executionStates.push('error-ended');
  }
  const workflowStates = uniqueStrings(input?.workflowStates);
  if (workflowStates.length === 0) workflowStates.push(...uniqueStrings(legacy?.decisionStates));
  const sessionRelations = uniqueStrings(input?.sessionRelations);
  return {
    sessionRelations: sessionRelations.length > 0 ? sessionRelations : ['all-local'],
    ...(executionStates.length > 0 ? { executionStates } : {}),
    ...(uniqueStrings(input?.attentionStates).length > 0
      ? { attentionStates: uniqueStrings(input?.attentionStates) }
      : {}),
    ...(workflowStates.length > 0 ? { workflowStates } : {}),
    ...(uniqueStrings(input?.sources).length > 0 ? { sources: uniqueStrings(input?.sources) } : {}),
    ...(uniqueStrings(input?.workingDirPrefixes).length > 0
      ? { workingDirPrefixes: uniqueStrings(input?.workingDirPrefixes) }
      : {}),
    excludeOwnBotSessions: input?.excludeOwnBotSessions !== false,
    activationMode:
      input?.activationMode === 'inbox-only' || legacy?.wakeMode === 'manual'
        ? 'inbox-only'
        : 'heartbeat-turn',
    resultDelivery: input?.resultDelivery === 'none' ? 'none' : 'all-active-routes',
    ...(uniqueStrings(input?.deliveryChannelKinds).length > 0
      ? { deliveryChannelKinds: uniqueStrings(input?.deliveryChannelKinds) }
      : {}),
  };
}

function facetChanged<T>(previous: T, current: T): boolean {
  return JSON.stringify(previous) !== JSON.stringify(current);
}

export function matchesBotEventSubscription(
  ruleInput: Partial<BotEventSubscriptionRule> | null | undefined,
  event: BotSessionEventPayload,
  ownBotId: string,
  context: { sessionRelations: string[] } = { sessionRelations: [] },
): boolean {
  const rule = normalizeBotEventSubscriptionRule(ruleInput);
  const previousState = event.previousState;
  const currentState = event.currentState;
  // Legacy Draft rows were matched before persistence. They remain readable,
  // but must never be reinterpreted as authoritative state transitions.
  if (!previousState || !currentState) return false;
  if (
    !rule.sessionRelations.includes('all-local')
    && !rule.sessionRelations.some((relation) => context.sessionRelations.includes(relation))
  ) return false;
  if (rule.sources?.length && !rule.sources.includes(event.source)) return false;
  if (
    rule.workingDirPrefixes?.length
    && !rule.workingDirPrefixes.some((prefix) => event.workingDir.startsWith(prefix))
  ) return false;
  const transitionConditions = [
    Boolean(
      rule.executionStates?.includes(currentState.execution)
      && facetChanged(previousState.execution, currentState.execution),
    ),
    Boolean(
      rule.attentionStates?.includes(currentState.attention ?? '')
      && facetChanged(previousState.attention, currentState.attention),
    ),
    Boolean(
      rule.workflowStates?.some((state) =>
        state === currentState.workflow?.key || state === currentState.workflow?.label)
      && facetChanged(previousState.workflow, currentState.workflow),
    ),
  ];
  if (
    (rule.executionStates?.length || rule.attentionStates?.length || rule.workflowStates?.length)
    && !transitionConditions.some(Boolean)
  ) return false;
  if (rule.excludeOwnBotSessions !== false && event.originBotId === ownBotId) return false;
  if ((event.lineage ?? []).includes(ownBotId)) return false;
  return (event.hopCount ?? 0) < 8;
}

export const DEFAULT_CONTROL_BOT_EVENT_RULE: BotEventSubscriptionRule = {
  sessionRelations: ['all-local'],
  executionStates: ['normal-ended', 'error-ended'],
  workflowStates: ['等拍板', '待验收', '待总控'],
  excludeOwnBotSessions: true,
  activationMode: 'heartbeat-turn',
  resultDelivery: 'all-active-routes',
};

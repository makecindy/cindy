import { createHash } from 'node:crypto';

import type { BotObservedSessionState } from '../../shared/botSessionEvents.js';

export const BOT_GUARDIAN_MIN_INTERVAL_MS = 5 * 60_000;
export const BOT_GUARDIAN_MAX_INTERVAL_MS = 15 * 60_000;
export const BOT_GUARDIAN_STALE_RUNNING_MS = 20 * 60_000;
export const BOT_GUARDIAN_EXPECTED_EVENT_GRACE_MS = 5 * 60_000;
export const BOT_GUARDIAN_UNCLAIMED_DECISION_MS = 10 * 60_000;
export const BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK = 256;

export type BotGuardianAnomalyKind =
  'stale-running' | 'expected-event-missing' | 'unclaimed-decision';

export interface BotGuardianSupervisionTarget {
  botId: string;
  sessionId: string;
  relation: string;
  supervisedAt: number;
  expectsTerminalEvent: boolean;
  title: string;
  source: string;
  workingDir: string;
}

export interface BotGuardianAnomaly {
  kind: BotGuardianAnomalyKind;
  thresholdMs: number;
  fingerprint: string;
}

function stateClock(state: BotObservedSessionState): number | null {
  return state.lastActivityAtMs ?? state.startedAtMs ?? null;
}

function isDecisionState(state: BotObservedSessionState): boolean {
  const workflow = state.workflow;
  if (!workflow) return false;
  if (workflow.waitingOn === 'user' || workflow.waitingOn === 'automation') return true;
  return [
    'awaiting-user-decision',
    'awaiting-acceptance',
    'awaiting-bot',
    'awaiting-controller',
  ].includes(workflow.key);
}

export function botGuardianIntervalMs(input: {
  targetCount: number;
  runningCount: number;
}): number {
  if (input.targetCount <= 0) return BOT_GUARDIAN_MAX_INTERVAL_MS;
  const sizePenalty = Math.min(8 * 60_000, Math.floor(input.targetCount / 25) * 60_000);
  const activityAdjustment = input.runningCount > 0 ? -2 * 60_000 : 0;
  return Math.max(
    BOT_GUARDIAN_MIN_INTERVAL_MS,
    Math.min(BOT_GUARDIAN_MAX_INTERVAL_MS, 9 * 60_000 + sizePenalty + activityAdjustment),
  );
}

export function botGuardianFingerprint(input: {
  botId: string;
  sessionId: string;
  relation: string;
  supervisedAt: number;
  kind: BotGuardianAnomalyKind;
  state: BotObservedSessionState;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        botId: input.botId,
        sessionId: input.sessionId,
        relation: input.relation,
        supervisedAt: input.supervisedAt,
        kind: input.kind,
        lifecycle: input.state.lifecycle,
        execution: input.state.execution,
        attention: input.state.attention,
        lastActivityAtMs: input.state.lastActivityAtMs ?? null,
        turnGeneration: input.state.turnGeneration ?? null,
        workflow: input.state.workflow?.key ?? null,
        waitingOn: input.state.workflow?.waitingOn ?? null,
      }),
    )
    .digest('hex');
}

export function detectBotGuardianAnomalies(input: {
  target: BotGuardianSupervisionTarget;
  state: BotObservedSessionState;
  now: number;
  latestReceiptAt: number | null;
  hasActiveClaim: boolean;
  staleRunningMs?: number;
  expectedEventGraceMs?: number;
  unclaimedDecisionMs?: number;
}): BotGuardianAnomaly[] {
  const staleRunningMs = input.staleRunningMs ?? BOT_GUARDIAN_STALE_RUNNING_MS;
  const expectedEventGraceMs = input.expectedEventGraceMs ?? BOT_GUARDIAN_EXPECTED_EVENT_GRACE_MS;
  const unclaimedDecisionMs = input.unclaimedDecisionMs ?? BOT_GUARDIAN_UNCLAIMED_DECISION_MS;
  const clock = stateClock(input.state);
  const observedSince = Math.max(input.target.supervisedAt, clock ?? input.target.supervisedAt);
  const anomalies: BotGuardianAnomaly[] = [];
  const add = (kind: BotGuardianAnomalyKind, thresholdMs: number) => {
    anomalies.push({
      kind,
      thresholdMs,
      fingerprint: botGuardianFingerprint({
        botId: input.target.botId,
        sessionId: input.target.sessionId,
        relation: input.target.relation,
        supervisedAt: input.target.supervisedAt,
        kind,
        state: input.state,
      }),
    });
  };

  if (
    input.state.execution === 'running' &&
    clock !== null &&
    input.now - observedSince >= staleRunningMs
  ) {
    add('stale-running', staleRunningMs);
  }

  if (
    input.target.expectsTerminalEvent &&
    (input.state.execution === 'normal-ended' || input.state.execution === 'error-ended') &&
    clock !== null &&
    clock >= input.target.supervisedAt &&
    (input.latestReceiptAt === null || input.latestReceiptAt < clock) &&
    input.now - clock >= expectedEventGraceMs
  ) {
    add('expected-event-missing', expectedEventGraceMs);
  }

  if (
    isDecisionState(input.state) &&
    !input.hasActiveClaim &&
    input.now - observedSince >= unclaimedDecisionMs
  ) {
    add('unclaimed-decision', unclaimedDecisionMs);
  }

  return anomalies;
}

export function selectBotGuardianTargetBatch(
  targets: readonly BotGuardianSupervisionTarget[],
  afterSessionId: string | null,
  limit = BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK,
): { targets: BotGuardianSupervisionTarget[]; nextCursor: string | null } {
  if (targets.length === 0) return { targets: [], nextCursor: null };
  const sorted = [...targets].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const start = afterSessionId
    ? Math.max(
        0,
        sorted.findIndex((target) => target.sessionId > afterSessionId),
      )
    : 0;
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
  const selected = ordered.slice(0, Math.max(1, limit));
  return {
    targets: selected,
    nextCursor: targets.length > selected.length ? (selected.at(-1)?.sessionId ?? null) : null,
  };
}

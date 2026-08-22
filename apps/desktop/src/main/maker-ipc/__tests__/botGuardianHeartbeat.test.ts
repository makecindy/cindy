import { describe, expect, it } from 'vitest';

import type { BotObservedSessionState } from '../../../shared/botSessionEvents.js';
import {
  BOT_GUARDIAN_MAX_INTERVAL_MS,
  BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK,
  BOT_GUARDIAN_MIN_INTERVAL_MS,
  botGuardianIntervalMs,
  detectBotGuardianAnomalies,
  selectBotGuardianTargetBatch,
  type BotGuardianSupervisionTarget,
} from '../botGuardianHeartbeat.js';

function target(
  overrides: Partial<BotGuardianSupervisionTarget> = {},
): BotGuardianSupervisionTarget {
  return {
    botId: 'control-bot',
    sessionId: 'task-1',
    relation: 'delegated-by-bot',
    supervisedAt: 1_000,
    expectsTerminalEvent: true,
    title: '实现功能',
    source: 'desktop',
    workingDir: '/repo/cindy',
    ...overrides,
  };
}

function state(overrides: Partial<BotObservedSessionState> = {}): BotObservedSessionState {
  return {
    lifecycle: 'active',
    execution: 'running',
    attention: null,
    workflow: null,
    startedAtMs: 1_000,
    lastActivityAtMs: 9_000,
    turnGeneration: 1,
    ...overrides,
  };
}

describe('Bot guardian heartbeat', () => {
  it('keeps the adaptive cadence inside the conservative five-to-fifteen-minute band', () => {
    const samples = [
      botGuardianIntervalMs({ targetCount: 0, runningCount: 0 }),
      botGuardianIntervalMs({ targetCount: 1, runningCount: 1 }),
      botGuardianIntervalMs({ targetCount: 250, runningCount: 0 }),
      botGuardianIntervalMs({ targetCount: 10_000, runningCount: 10_000 }),
    ];
    expect(
      samples.every(
        (value) => value >= BOT_GUARDIAN_MIN_INTERVAL_MS && value <= BOT_GUARDIAN_MAX_INTERVAL_MS,
      ),
    ).toBe(true);
    expect(botGuardianIntervalMs({ targetCount: 1, runningCount: 1 })).toBeLessThan(
      botGuardianIntervalMs({ targetCount: 1, runningCount: 0 }),
    );
  });

  it('stays silent for a healthy running task', () => {
    expect(
      detectBotGuardianAnomalies({
        target: target(),
        state: state(),
        now: 10_000,
        latestReceiptAt: null,
        hasActiveClaim: false,
        staleRunningMs: 2_000,
      }),
    ).toEqual([]);
  });

  it('detects a stale running task and keeps its fingerprint stable for the same anomaly', () => {
    const input = {
      target: target(),
      state: state({ lastActivityAtMs: 2_000 }),
      now: 10_000,
      latestReceiptAt: null,
      hasActiveClaim: false,
      staleRunningMs: 2_000,
    };
    const first = detectBotGuardianAnomalies(input);
    const second = detectBotGuardianAnomalies({ ...input, now: 20_000 });
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe('stale-running');
    expect(second[0]?.fingerprint).toBe(first[0]?.fingerprint);
  });

  it('treats a recreated supervision relationship as a new anomaly generation', () => {
    const base = {
      state: state({ lastActivityAtMs: 2_000 }),
      now: 10_000,
      latestReceiptAt: null,
      hasActiveClaim: false,
      staleRunningMs: 2_000,
    };
    const first = detectBotGuardianAnomalies({ ...base, target: target({ supervisedAt: 1_000 }) });
    const second = detectBotGuardianAnomalies({ ...base, target: target({ supervisedAt: 1_500 }) });
    expect(second[0]?.fingerprint).not.toBe(first[0]?.fingerprint);
  });

  it('detects a missing terminal transition receipt only after the grace period', () => {
    const terminal = state({ execution: 'normal-ended', lastActivityAtMs: 5_000 });
    expect(
      detectBotGuardianAnomalies({
        target: target(),
        state: terminal,
        now: 7_999,
        latestReceiptAt: null,
        hasActiveClaim: false,
        expectedEventGraceMs: 3_000,
      }),
    ).toEqual([]);
    expect(
      detectBotGuardianAnomalies({
        target: target(),
        state: terminal,
        now: 8_000,
        latestReceiptAt: null,
        hasActiveClaim: false,
        expectedEventGraceMs: 3_000,
      }).map((item) => item.kind),
    ).toContain('expected-event-missing');
  });

  it('detects an unclaimed decision and stays silent while a heartbeat turn owns it', () => {
    const decision = state({
      execution: 'needs-interaction',
      lastActivityAtMs: 5_000,
      workflow: { key: 'awaiting-controller', waitingOn: 'automation' },
    });
    const input = {
      target: target(),
      state: decision,
      now: 10_000,
      latestReceiptAt: null,
      unclaimedDecisionMs: 2_000,
    };
    expect(
      detectBotGuardianAnomalies({ ...input, hasActiveClaim: false }).map((item) => item.kind),
    ).toContain('unclaimed-decision');
    expect(
      detectBotGuardianAnomalies({ ...input, hasActiveClaim: true }).map((item) => item.kind),
    ).not.toContain('unclaimed-decision');
  });

  it('round-robins bounded target batches without permanently missing the tail', () => {
    const targets = Array.from({ length: BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK + 20 }, (_, index) =>
      target({ sessionId: `task-${String(index).padStart(4, '0')}` }),
    );
    const first = selectBotGuardianTargetBatch(targets, null);
    const second = selectBotGuardianTargetBatch(targets, first.nextCursor);
    expect(first.targets).toHaveLength(BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK);
    expect(second.targets.slice(0, 20).map((item) => item.sessionId)).toEqual(
      targets.slice(BOT_GUARDIAN_MAX_TARGETS_PER_BOT_TICK).map((item) => item.sessionId),
    );
  });

  it('wraps safely when a saved cursor sorts after every current target', () => {
    const batch = selectBotGuardianTargetBatch(
      [target({ sessionId: 'a' }), target({ sessionId: 'b' })],
      'z',
      1,
    );
    expect(batch.targets[0]?.sessionId).toBe('a');
  });
});

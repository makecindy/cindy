import { describe, expect, it } from 'vitest';

import {
  ClaudeTurnBillingSnapshotRegistry,
  shouldResolveClaudeTurnBillingSnapshotAtUsage,
  type ClaudeTurnBillingSnapshot,
} from '../claudeTurnBillingSnapshotRegistry';
import { resolveClaudeTurnCostSinks } from '../turnCostCalculator';
import type { ModelPricingCatalog } from '../../../shared/regionalMoney';

const PROVIDER_A: ClaudeTurnBillingSnapshot = {
  providerId: 'deepseek',
  billingRoute: 'provider-api',
  subscriptionSession: false,
};

const USER_PROVIDER_B: ClaudeTurnBillingSnapshot = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
  subscriptionSession: false,
};

const UNKNOWN_LOCAL: ClaudeTurnBillingSnapshot = {
  providerId: null,
  billingRoute: 'unknown',
  subscriptionSession: false,
};

const PRICING: ModelPricingCatalog = {
  deepseek: {
    'deepseek-v4-flash': {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      currency: 'CNY',
      source: 'provider-reference',
      approximate: true,
      inputPerMtok: 0.2,
      outputPerMtok: 2,
      cacheReadPerMtok: 0.02,
    },
  },
  xd: {
    'claude-opus-4-8': {
      providerId: 'xd',
      modelId: 'claude-opus-4-8',
      currency: 'CNY',
      source: 'gateway',
      approximate: false,
      inputPerMtok: 1,
      outputPerMtok: 5,
    },
  },
};

describe('ClaudeTurnBillingSnapshotRegistry', () => {
  it('keeps an interleaved user turn and replacement on their exact routes and sinks', () => {
    const registry = new ClaudeTurnBillingSnapshotRegistry();

    // 1. Provider A finishes with a silent stop and reserves a one-shot continuation.
    registry.stage('session-1', 1, () => PROVIDER_A);
    const continuation = registry.claimContinuation('session-1', 1, 'lease-1');
    expect(continuation).toEqual({
      kind: 'silent-stop',
      token: 'lease-1',
      predecessorGeneration: 1,
    });

    // 2. Before replacement dispatch, an independent user turn selects Provider B.
    // It has no continuation identity and therefore cannot consume A's claim.
    const userTurn = registry.stage('session-1', 2, () => USER_PROVIDER_B);
    expect(userTurn).toEqual({ snapshot: USER_PROVIDER_B, inherited: false });
    registry.clear('session-1', 1);
    expect(registry.read('session-1', 2)).toEqual(USER_PROVIDER_B);

    // 3. The delayed replacement alone presents the token and inherits exact Provider A.
    const replacement = registry.stage(
      'session-1',
      3,
      () => {
        throw new Error('replacement must not capture the current provider');
      },
      continuation,
    );
    expect(replacement).toEqual({ snapshot: PROVIDER_A, inherited: true });

    // 4. Complete in reverse dispatch order. Clearing replacement generation 3
    // must preserve the still-pending user generation 2 evidence.
    const replacementSinks = resolveClaudeTurnCostSinks(
      [
        {
          model: 'deepseek-v4-flash',
          costUsdDelta: 18.82,
          inputTokensDelta: 0,
          outputTokensDelta: 0,
          cacheReadTokensDelta: 1_000_000,
          cacheCreateTokensDelta: 0,
        },
      ],
      PRICING,
      { ...registry.read('session-1', 3)!, region: 'cn' },
    );
    registry.clear('session-1', 3);
    expect(registry.read('session-1', 2)).toEqual(USER_PROVIDER_B);

    const userSinks = resolveClaudeTurnCostSinks(
      [
        {
          model: 'claude-opus-4-8',
          costUsdDelta: 0,
          inputTokensDelta: 1_000_000,
          outputTokensDelta: 0,
          cacheReadTokensDelta: 0,
          cacheCreateTokensDelta: 0,
        },
      ],
      PRICING,
      { ...registry.read('session-1', 2)!, region: 'cn' },
    );
    registry.clear('session-1', 2);

    // Message rows keep their own actual/estimate shape; session and daily actual
    // ledgers consume only turnMoney; per-model rows retain the same route.
    expect(userSinks).toMatchObject({
      turnMoney: { amount: 1, kind: 'actual-cost' },
      estimatedTurnMoney: null,
      perModel: [{ source: 'gateway', money: { amount: 1, kind: 'actual-cost' } }],
    });
    expect(replacementSinks).toMatchObject({
      turnMoney: null,
      estimatedTurnMoney: { amount: 0.02, kind: 'value-estimate' },
      perModel: [{ source: 'reference', money: { amount: 0.02, kind: 'value-estimate' } }],
    });
    const sessionActual =
      (userSinks.turnMoney?.amount ?? 0) + (replacementSinks.turnMoney?.amount ?? 0);
    const dailyActual = sessionActual;
    expect({ sessionActual, dailyActual }).toEqual({ sessionActual: 1, dailyActual: 1 });
    expect(registry.hasSession('session-1')).toBe(false);
  });

  it('consumes a continuation token once and fails closed on a mismatched predecessor', () => {
    const registry = new ClaudeTurnBillingSnapshotRegistry();
    registry.stage('session-1', 1, () => PROVIDER_A);
    const continuation = registry.claimContinuation('session-1', 1, 'lease-1');
    expect(continuation).not.toBeNull();
    const mustNotCapture = () => {
      throw new Error('invalid continuation must not capture the current provider');
    };

    const mismatched = registry.stage(
      'session-1',
      2,
      mustNotCapture,
      continuation && { ...continuation, predecessorGeneration: 99 },
    );
    const reused = registry.stage('session-1', 3, mustNotCapture, continuation);

    expect(mismatched).toEqual({
      snapshot: { providerId: null, billingRoute: 'unknown', subscriptionSession: false },
      inherited: false,
    });
    expect(reused).toEqual({
      snapshot: { providerId: null, billingRoute: 'unknown', subscriptionSession: false },
      inherited: false,
    });
  });

  it.each([
    ['xd-gateway', false],
    ['subscription', true],
  ] as const)(
    'preserves an inherited provider-less %s route when the replacement has no observation',
    (billingRoute, subscriptionSession) => {
      const registry = new ClaudeTurnBillingSnapshotRegistry();
      registry.stage('session-1', 1, () => UNKNOWN_LOCAL);
      const resolvedPredecessor = {
        providerId: null,
        billingRoute,
        subscriptionSession,
      } satisfies ClaudeTurnBillingSnapshot;
      expect(registry.replace('session-1', 1, resolvedPredecessor)).toBe(true);
      const continuation = registry.claimContinuation('session-1', 1, 'lease-1');
      expect(continuation).not.toBeNull();

      // SET_MODEL (or an independent user turn) selects an explicit provider
      // before the delayed replacement dispatches. The replacement therefore
      // has no new default-route observation and must retain its inherited route.
      registry.stage('session-1', 2, () => USER_PROVIDER_B);
      const replacement = registry.stage(
        'session-1',
        3,
        () => USER_PROVIDER_B,
        continuation,
      );

      expect(replacement).toEqual({ snapshot: resolvedPredecessor, inherited: true });
      expect(shouldResolveClaudeTurnBillingSnapshotAtUsage(replacement.snapshot, false)).toBe(
        false,
      );
      expect(shouldResolveClaudeTurnBillingSnapshotAtUsage(UNKNOWN_LOCAL, false)).toBe(true);
    },
  );
});

import { describe, expect, it } from 'vitest';

import {
  assessModelSwitchContext,
  shouldBlockLegacyRemotePiModelWindowSwitch,
  shouldHandoffAfterContextAssessment,
} from '../modelSwitchAssessment';

describe('legacy remote Pi model-window guard', () => {
  const legacyPiSwitch = {
    hostGuardSupported: false,
    contextTokens: 180_000,
    currentContextWindow: 1_000_000,
    targetContextWindow: 200_000,
  };

  it('blocks every old-host Pi route estimate', () => {
    const estimatedRoutes = {
      lowPressure: { ...legacyPiSwitch, contextTokens: 100_000 },
      exact90Percent: legacyPiSwitch,
      sameWindow: { ...legacyPiSwitch, targetContextWindow: 1_000_000 },
      expansion: { ...legacyPiSwitch, targetContextWindow: 2_000_000 },
      unknownUsage: { ...legacyPiSwitch, contextTokens: undefined },
      unknownCurrentWindow: { ...legacyPiSwitch, currentContextWindow: undefined },
      unknownTargetWindow: { ...legacyPiSwitch, targetContextWindow: undefined },
    };
    for (const route of Object.values(estimatedRoutes)) {
      expect(shouldBlockLegacyRemotePiModelWindowSwitch(route)).toBe(true);
    }
  });

  it('delegates guarded Pi routes to host-side final runtime verification', () => {
    expect(shouldBlockLegacyRemotePiModelWindowSwitch({
      ...legacyPiSwitch,
      hostGuardSupported: true,
    })).toBe(false);
    expect(shouldBlockLegacyRemotePiModelWindowSwitch({
      hostGuardSupported: true,
      contextTokens: undefined,
      currentContextWindow: undefined,
      targetContextWindow: undefined,
    })).toBe(false);
  });
});

describe('assessModelSwitchContext', () => {
  it('fail-open: unknown context tokens → ok', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 0, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'ok', projectedPct: 0 });
    expect(
      assessModelSwitchContext({ contextTokens: Number.NaN, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'ok', projectedPct: 0 });
  });

  it('fail-open: unknown target window → ok', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 500_000, targetContextWindow: undefined }),
    ).toEqual({ level: 'ok', projectedPct: 0 });
    expect(
      assessModelSwitchContext({ contextTokens: 500_000, targetContextWindow: 0 }),
    ).toEqual({ level: 'ok', projectedPct: 0 });
  });

  it('below 70% → ok', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 139_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'ok', projectedPct: 70 }); // 69.5% ratio < 0.7, pct rounds to 70
  });

  it('70% up to danger threshold → warn', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 140_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'warn', projectedPct: 70 });
    expect(
      assessModelSwitchContext({ contextTokens: 179_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'warn', projectedPct: 90 }); // 89.5% < default 90 threshold
  });

  it('danger threshold (default 90) up to 100% → danger', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 180_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'danger', projectedPct: 90 });
    expect(
      assessModelSwitchContext({ contextTokens: 199_999, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'danger', projectedPct: 100 });
  });

  it('at or above 100% → overflow', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 200_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'overflow', projectedPct: 100 });
    expect(
      assessModelSwitchContext({ contextTokens: 500_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'overflow', projectedPct: 250 });
  });

  it('uses user auto-compact threshold as the danger boundary', () => {
    // 75% 阈值: 150K/200K 恰好命中 danger
    expect(
      assessModelSwitchContext({
        contextTokens: 150_000,
        targetContextWindow: 200_000,
        autoCompactThresholdPct: 75,
      }),
    ).toEqual({ level: 'danger', projectedPct: 75 });
    // 同占用在默认 90 阈值下只是 warn
    expect(
      assessModelSwitchContext({ contextTokens: 150_000, targetContextWindow: 200_000 }),
    ).toEqual({ level: 'warn', projectedPct: 75 });
  });

  it('out-of-range threshold falls back to default 90', () => {
    for (const bad of [10, 99, Number.NaN]) {
      expect(
        assessModelSwitchContext({
          contextTokens: 179_000,
          targetContextWindow: 200_000,
          autoCompactThresholdPct: bad,
        }).level,
      ).toBe('warn');
    }
  });

  it('typical scenario: 1M session switched to Haiku 200K', () => {
    const verdict = assessModelSwitchContext({
      contextTokens: 500_000,
      targetContextWindow: 200_000,
      autoCompactThresholdPct: 90,
    });
    expect(verdict.level).toBe('overflow');
    expect(verdict.projectedPct).toBe(250);
  });

  it('typical scenario: small window back to 1M → ok', () => {
    expect(
      assessModelSwitchContext({ contextTokens: 190_000, targetContextWindow: 1_000_000 }),
    ).toEqual({ level: 'ok', projectedPct: 19 });
  });

  it('handoffs on danger/overflow, not on warn',
    () => {
      expect(
        shouldHandoffAfterContextAssessment(
          assessModelSwitchContext({ contextTokens: 150_000, targetContextWindow: 200_000 }),
        ),
      ).toBe(false);
      expect(
        shouldHandoffAfterContextAssessment(
          assessModelSwitchContext({ contextTokens: 180_000, targetContextWindow: 200_000 }),
        ),
      ).toBe(true);
      expect(
        shouldHandoffAfterContextAssessment(
          assessModelSwitchContext({ contextTokens: 200_000, targetContextWindow: 200_000 }),
        ),
      ).toBe(true);
    },
  );
});

import { describe, expect, it } from 'vitest';
import {
  claudeModelFamily,
  isXaiWeeklyUsageCurrent,
  matchScopedWindowForModel,
} from '../subscriptionUsage.js';

describe('subscription usage shared rules', () => {
  it.each([
    ['claude-fable-5[1m]', 'fable'],
    ['claude-opus-5-5[1m] ', 'opus'],
    ['Claude-Sonnet-5', 'sonnet'],
    ['haiku[', 'haiku'],
    ['gpt-5', null],
    ['', null],
  ])('maps %s to its Claude family', (model, family) => {
    expect(claudeModelFamily(model)).toBe(family);
  });

  it('stays linear on adversarial bracket input', () => {
    const started = Date.now();
    expect(claudeModelFamily(`${'['.repeat(200_000)}opus`)).toBe('opus');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('matches the model weekly window by id first, then display name', () => {
    const scoped = [
      { modelDisplayName: 'Claude Fable 5', utilization: 10 },
      { modelDisplayName: 'Other', modelId: 'claude-opus-4-8', utilization: 20 },
    ];
    expect(matchScopedWindowForModel(scoped, 'claude-fable-5[1m]')?.utilization).toBe(10);
    expect(matchScopedWindowForModel(scoped, 'claude-opus-5-5')?.utilization).toBe(20);
    expect(matchScopedWindowForModel(scoped, 'claude-sonnet-5')).toBeNull();
  });

  it('treats only fresh, unreset SuperGrok snapshots as current', () => {
    const now = 1_000_000_000;
    const fresh = { creditUsagePercent: 10, updatedAt: now - 60_000, resetsAt: now / 1000 + 60 };
    expect(isXaiWeeklyUsageCurrent(fresh, now)).toBe(true);
    expect(isXaiWeeklyUsageCurrent({ ...fresh, updatedAt: now - 31 * 60_000 }, now)).toBe(false);
    expect(isXaiWeeklyUsageCurrent({ ...fresh, resetsAt: now / 1000 - 1 }, now)).toBe(false);
  });
});

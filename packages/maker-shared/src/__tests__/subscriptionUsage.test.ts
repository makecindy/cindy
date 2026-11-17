import { describe, expect, it } from 'vitest';
import {
  claudeModelFamily,
  isXaiWeeklyUsageCurrent,
  matchScopedWindowForModel,
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '../subscriptionUsage.js';

describe('subscription usage shared rules', () => {
  // Unit: both clients used to collapse all Max tiers; older/unknown tiers must remain readable.
  it.each([
    ['max', 'max_5x', 'Max 5×'], ['max', 'max_20x', 'Max 20×'],
    ['max', undefined, 'Max'], ['max', 'max_other', 'Max'], ['ultra', undefined, 'Ultra'],
  ])('renders the reported Claude plan %s / %s as %s', (plan, tier, expected) => {
    expect(formatClaudeSubscriptionPlanLabel(plan, tier)).toBe(expected);
  });
  it('preserves known and newly introduced Codex plan types', () => {
    expect(formatCodexPlanLabel('prolite')).toBe('Pro Lite');
    expect(formatCodexPlanLabel('future_plan')).toBe('Future Plan');
  });
  // Unit: CLI display names can differ from machine plan codes; legacy fixtures only supplied the codes.
  it('prefers the official Claude display name and keeps the legacy fallback', () => {
    expect(formatClaudeSubscriptionPlanLabel('pro', 'pro', ' Ultra ')).toBe('Ultra');
    expect(formatClaudeSubscriptionPlanLabel(undefined, undefined, 'Future Plan')).toBe('Future Plan');
    expect(formatClaudeSubscriptionPlanLabel('max', 'max_20x', ' ')).toBe('Max 20×');
    expect(formatClaudeSubscriptionPlanLabel('max', 'max_20x', 'Max')).toBe('Max 20×');
    expect(formatClaudeSubscriptionPlanLabel('max', 'max_5x', 'Ultra')).toBe('Ultra');
    expect(formatClaudeSubscriptionPlanLabel('pro', 'pro', 123)).toBe('Pro');
  });
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

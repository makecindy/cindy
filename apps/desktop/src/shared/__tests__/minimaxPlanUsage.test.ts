import { describe, expect, it } from 'vitest';
import { minimaxPlanUsageEndpoint, parseMiniMaxPlanUsage } from '../minimaxPlanUsage';

// Issue #9879; unit: the new official MiniMax reader must not confuse remaining
// quota with consumed usage, fabricate a missing month, or send a key to a proxy.
// Existing provider parsers cover different payloads. Minimal input: general with
// 0/0 counts and explicit 5h/weekly percentages. All fixtures are synthetic.
const fetchedAt = 1_800_000_000_000;
const general = {
  model_name: 'general', current_interval_total_count: 0, current_interval_usage_count: 0,
  current_interval_remaining_percent: 80, current_weekly_remaining_percent: 55,
  end_time: fetchedAt + 60_000, weekly_remains_time: 604_800_000,
};

describe('MiniMax plan usage', () => {
  it('pins each inference region to its official quota host and rejects lookalikes and path tricks', () => {
    expect(minimaxPlanUsageEndpoint('https://api.minimaxi.com/anthropic/v1/')).toBe('https://www.minimaxi.com/v1/token_plan/remains');
    expect(minimaxPlanUsageEndpoint('https://api.minimax.io/v1')).toBe('https://www.minimax.io/v1/token_plan/remains');
    for (const upstream of [
      'http://api.minimax.io/v1', 'https://api.minimax.io.evil.example/v1',
      'https://proxy.example/anthropic', 'https://api.minimax.io/tenant/v1',
      'https://user:pass@api.minimax.io/v1', 'https://api.minimax.io/v1?account=other',
    ]) expect(minimaxPlanUsageEndpoint(upstream)).toBeNull();
  });

  it('uses explicit remaining percentages for 0/0 plans and separates reset clocks without making a month', () => {
    const result = parseMiniMaxPlanUsage({ model_remains: [{ model_name: 'video', current_interval_remaining_percent: 1 }, general] }, fetchedAt);
    expect(result.windows).toEqual([
      { id: 'rolling', model: null, usedPercent: 20, resetsAt: fetchedAt + 60_000 },
      { id: 'weekly', model: null, usedPercent: 45, resetsAt: fetchedAt + 604_800_000 },
    ]);
    expect(result.windows.some(window => String(window.id) === 'monthly')).toBe(false);
  });

  it('prefers percentages over ambiguous counts and retains the tightest named legacy model pool', () => {
    const result = parseMiniMaxPlanUsage({ model_remains: [
      { model_name: 'MiniMax-M2.7', current_interval_total_count: 100, current_interval_usage_count: 10, current_interval_remaining_percent: 90 },
      { model_name: 'MiniMax-M2.5', current_interval_total_count: 100, current_interval_usage_count: 30 },
    ] }, fetchedAt);
    expect(result.windows).toEqual([{ id: 'rolling', model: 'MiniMax-M2.5', usedPercent: 70, resetsAt: null }]);
  });

  it('does not turn absent data or unrelated media allowance into a fresh 100% text quota', () => {
    expect(parseMiniMaxPlanUsage({ model_remains: [{ model_name: 'video', current_interval_remaining_percent: 100 }] }, fetchedAt).windows).toEqual([]);
    expect(parseMiniMaxPlanUsage({ model_remains: [{ ...general, current_interval_remaining_percent: null, current_weekly_remaining_percent: null }] }, fetchedAt).windows).toEqual([]);
  });

  it('distinguishes an unavailable plan and unlimited or boosted weekly allowances from numeric meters', () => {
    expect(parseMiniMaxPlanUsage({ model_remains: [{ ...general, current_interval_status: 3, current_weekly_status: 3, current_weekly_total_count: 0 }] }, fetchedAt)).toMatchObject({ noPlan: true, windows: [] });
    expect(parseMiniMaxPlanUsage({ model_remains: [{ ...general, current_weekly_status: 3 }] }, fetchedAt)).toMatchObject({ weeklyUnlimited: true, windows: [{ id: 'rolling' }] });
    const boosted = parseMiniMaxPlanUsage({ model_remains: [{ ...general, current_weekly_remaining_percent: 90, weekly_boost_permille: 1500 }] }, fetchedAt);
    expect(boosted.boostedWeeklyRemainingPercent).toBe(135);
    expect(boosted.windows.map(window => window.id)).toEqual(['rolling']);
  });

  it.each([
    {}, { model_remains: 'invalid' },
    { model_remains: [general], base_resp: { status_code: 1004 } },
    { model_remains: [{ ...general, current_interval_remaining_percent: 101 }] },
    { model_remains: [{ ...general, current_interval_remaining_percent: NaN }] },
    { model_remains: [general, general] },
  ])('rejects invalid or unsuccessful responses rather than displaying zero usage (%j)', payload => {
    expect(() => parseMiniMaxPlanUsage(payload, fetchedAt)).toThrow('invalid MiniMax');
  });
});

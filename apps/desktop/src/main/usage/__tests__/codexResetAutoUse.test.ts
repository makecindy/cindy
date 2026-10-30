import { describe, expect, it, vi } from 'vitest';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { CodexResetAutoUse, DEFAULT_CODEX_RESET_AUTO_USE, type CodexResetAutoUseDeps } from '../codexResetAutoUse';

// Tier unit: observable redemption/resume boundaries. Fake time and RPC, never real credits.
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
function snapshot(): MobileCodexRateLimitsResult {
  return { account: { email: null, accountId: null, planType: 'plus' },
    rateLimits: { secondary: { usedPercent: 99.5, windowMinutes: 10080, resetsAt: (NOW + 4 * DAY) / 1000 } },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: { availableCount: 1, credits: [] },
    resetOffer: { idempotencyKey: 'credit-key', expiresAt: (NOW + 2 * DAY) / 1000, validUntil: NOW + 600_000 },
    autoUse: { accountKey: 'account', settings: { ...DEFAULT_CODEX_RESET_AUTO_USE, enabled: true }, customized: true, lastUsedAt: null } };
}
function harness(value = snapshot()) {
  let now = NOW;
  let scope = 'owner';
  const deps: CodexResetAutoUseDeps = {
    scope: () => scope, now: () => now,
    read: vi.fn(async () => value), authorized: vi.fn(() => true),
    consume: vi.fn(async () => ({ outcome: 'reset' as const, rateLimits: null })),
    record: vi.fn(async () => {}), refreshWeb: vi.fn(async () => {}), restored: vi.fn(async () => {}), warn: vi.fn(),
  };
  const engine = new CodexResetAutoUse(deps);
  return { value, deps, engine, advance: () => { now += 60_000; }, switchOwner: () => { scope = 'another'; } };
}
describe('automatic Codex reset', () => {
  it.each([
    ['three days', 3, 99.5, true], ['custom seven days', 7, 99.5, false],
    ['unlimited', 0, 100, true], ['exactly one percent', 0, 99, false],
  ])('checks the weekly threshold: %s', async (_name, days, used, expected) => {
    const h = harness(); h.value.autoUse!.settings.minimumDays = days;
    h.value.rateLimits.secondary!.usedPercent = used;
    await h.engine.check('openai');
    expect(h.deps.consume).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
  it.each([30, 60])('uses the selected expiry lead of %i minutes independently', async minutes => {
    const h = harness(); h.value.autoUse!.settings.expiryMinutes = minutes;
    h.value.autoUse!.settings.lowQuota = false;
    h.value.rateLimits.secondary!.usedPercent = 20;
    h.value.resetOffer!.expiresAt = (NOW + 48 * 60_000) / 1000;
    await h.engine.check('openai');
    expect(h.deps.consume).toHaveBeenCalledTimes(minutes === 60 ? 1 : 0);
  });
  // Regression: the top-level snapshot may be the last model-specific bucket received.
  it.each([[100, 20, false], [20, 100, true]])('uses generic quota when model quota is %i and generic is %i', async (model, generic, expected) => {
    const h = harness();
    h.value.rateLimits.secondary!.usedPercent = model;
    h.value.rateLimitsByLimitId = {
      spark: { ...h.value.rateLimits, limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark' },
      codex: { secondary: { ...h.value.rateLimits.secondary!, usedPercent: generic } },
    };
    await h.engine.check('openai');
    expect(h.deps.consume).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
  it('skips full quotas, unknown windows and a separate model bucket', async () => {
    for (const used of [0, NaN]) {
      const h = harness(); h.value.rateLimits.secondary!.usedPercent = used;
      h.value.resetOffer!.expiresAt = (NOW + 60_000) / 1000;
      await h.engine.check('openai'); expect(h.deps.consume).not.toHaveBeenCalled();
    }
    const h = harness(); h.value.rateLimits.secondary!.usedPercent = 0;
    h.value.rateLimitsByLimitId = { other: { secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: (NOW + 4 * DAY) / 1000 } } };
    await h.engine.check('openai'); expect(h.deps.consume).not.toHaveBeenCalled();
  });
  it('coalesces concurrent checks and resumes after a confirmed refresh', async () => {
    const h = harness(); await Promise.all([h.engine.check('openai'), h.engine.check('openai')]);
    expect(h.deps.consume).toHaveBeenCalledExactlyOnceWith('openai', 'credit-key', expect.any(Function));
    expect(h.deps.record).toHaveBeenCalledOnce(); expect(h.deps.restored).toHaveBeenCalledOnce();
    await h.engine.check('openai'); expect(h.deps.consume).toHaveBeenCalledOnce();
  });
  it('does not redeem after settings are disabled or the owner changes during a read', async () => {
    const h = harness(); vi.mocked(h.deps.authorized).mockReturnValue(false);
    await h.engine.check('openai'); expect(h.deps.consume).not.toHaveBeenCalled();
    const switched = harness(); vi.mocked(switched.deps.read).mockImplementation(async () => { switched.switchOwner(); return switched.value; });
    await switched.engine.check('openai'); expect(switched.deps.consume).not.toHaveBeenCalled();
  });
  it('retries only its own ambiguous attempt with the same key, never a manual attempt', async () => {
    const h = harness(); vi.mocked(h.deps.consume).mockRejectedValueOnce(new Error('connection lost'));
    await h.engine.check('openai'); h.value.resetOffer!.retryOnly = true; h.advance();
    await h.engine.check('openai');
    expect(h.deps.consume).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.consume).mock.calls.map(call => call[1])).toEqual(['credit-key', 'credit-key']);
    const manual = harness(); manual.value.resetOffer!.retryOnly = true;
    await manual.engine.check('openai'); expect(manual.deps.consume).not.toHaveBeenCalled();
  });
  it('does not turn a failed receipt write into another redemption', async () => {
    const h = harness(); vi.mocked(h.deps.record).mockRejectedValue(new Error('disk full'));
    await h.engine.check('openai');
    expect(h.deps.consume).toHaveBeenCalledOnce(); expect(h.deps.restored).toHaveBeenCalledOnce();
  });
});

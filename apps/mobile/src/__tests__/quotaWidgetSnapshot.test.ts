import { describe, expect, it, vi } from 'vitest';
import { emptyQuotaSnapshot, quotaWindowState, sanitizeQuotaSnapshot, QUOTA_MAX_AGE_MS, remaining } from '../widgets/quotaSnapshot';
import { readWidgetQuota, widgetAccounts, type WidgetQuotaReader } from '../widgets/readWidgetQuota';

const now = 1_800_000_000_000;
const provider = (id: string, native: string) => ({ id, name: 'private account name', connected: true, auth: { method: 'oauth', native } });
const reader = (overrides: Partial<WidgetQuotaReader> = {}): WidgetQuotaReader => ({
  listProviders: async () => ({ providers: [provider('openai', 'codex'), provider('anthropic', 'claude'), provider('xai', 'xai')] }),
  getCodexRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 100, windowMinutes: 300, resetsAt: now / 1000 + 3600 } } }),
  getAccountUsage: async () => { throw new Error('No legacy snapshot'); },
  getSubscriptionUsage: async platform => platform === 'claude'
    ? { fiveHour: { utilization: 25, resetsAt: now / 1000 + 100 }, source: 'oauth-endpoint', updatedAt: now - 5000, accountFingerprint: 'private fingerprint' }
    : { creditUsagePercent: 10, updatedAt: now - QUOTA_MAX_AGE_MS, resetsAt: now / 1000 + 9999 },
  ...overrides,
});

describe('widget quota boundaries', () => {
  it.each([undefined, null, '0', false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 2, 99])('projects only an explicitly returned valid remaining-reset count: %s', async input => {
    const result = await readWidgetQuota(reader({ getCodexRateLimits: async () => ({
      rateLimits: { planType: 'pro', secondary: { usedPercent: 0, windowMinutes: 10080 } },
      rateLimitResetCredits: { availableCount: input, credits: [{ id: 'must-not-cross', status: 'available' }] },
      credits: { balance: '500' },
    }) }), () => now);
    const expected = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
    expect(result.snapshot.rows[0]).toMatchObject({ plan: 'Pro', extraResetsRemaining: expected });
    expect(JSON.stringify(result.snapshot)).not.toMatch(/must-not-cross|balance/);
  });

  it('does not infer reset counts from missing summaries, details, or legacy caches', async () => {
    const legacy = { updatedAt: now, primary: { usedPercent: 0 }, rateLimitResetCredits: { availableCount: 9 } };
    const read = reader({ getCodexRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 0 } }, rateLimitResetCredits: null }) });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].extraResetsRemaining).toBeNull();
    read.getCodexRateLimits = async () => { throw new Error('Unsupported channel'); };
    read.getAccountUsage = async () => legacy;
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].extraResetsRemaining).toBeNull();
    const old = sanitizeQuotaSnapshot({ version: 2, source: 'demo', rows: [{ platform: 'codex', windows: [] }] });
    expect(old.rows[0].extraResetsRemaining).toBeNull();
    expect(sanitizeQuotaSnapshot({ ...old, rows: [{ ...old.rows[0], platform: 'claude', extraResetsRemaining: 2 }] }).rows[0].extraResetsRemaining).toBeNull();
  });

  it('uses an explicit account plan fallback but does not guess Pro price tiers from credits or usage', async () => {
    const read = reader({ getCodexRateLimits: async () => ({ account: { planType: 'plus' }, rateLimits: { secondary: { usedPercent: 50, windowMinutes: 10080 } } }) });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].plan).toBe('Plus');
    read.getCodexRateLimits = async () => ({ rateLimits: { planType: 'pro', credits: { balance: '500' }, secondary: { usedPercent: 50, windowMinutes: 10080 } } });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].plan).toBe('Pro');
    read.getCodexRateLimits = async () => ({ account: { planType: 'unknown' }, rateLimits: { planType: 'unknown', secondary: { usedPercent: 12, windowMinutes: 10080 } }, rateLimitResetCredits: { availableCount: 3 } });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0]).toMatchObject({ plan: null, extraResetsRemaining: 3 });
  });
  it.each(['unknown', '', null])('uses the explicit account plan when the bucket plan is %s', async (planType) => {
    const read = reader({ getCodexRateLimits: async () => ({ account: { planType: 'plus' }, rateLimits: { planType, secondary: { usedPercent: 34, windowMinutes: 10080 } } }) });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].plan).toBe('Plus');
  });
  it('projects only quotas, preserves source observation times and converts reset seconds once', async () => {
    const { snapshot } = await readWidgetQuota(reader(), () => now);
    expect(snapshot.rows.map(row => row.windows[0].remainingPercent)).toEqual([0, 75, 90]);
    expect(snapshot.rows.map(row => row.observedAtMs)).toEqual([now, now - 5000, now - QUOTA_MAX_AGE_MS]);
    expect(snapshot.rows[0].windows[0].resetAtMs).toBe(now + 3_600_000);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|providerId|accountFingerprint|name/);
  });

  it.each([null, undefined, '', '0', false, -1, 101, NaN, Infinity])('does not reinterpret invalid utilization %s as zero', input => {
    expect(remaining(input)).toBeNull();
  });

  it('does not derive subscription allowance from task token counters', async () => {
    const { snapshot } = await readWidgetQuota(reader({ getSubscriptionUsage: async () => ({ inputTokens: 200, outputTokens: 300, updatedAt: now }) }), () => now);
    expect(snapshot.rows.slice(1).every(row => !row.available)).toBe(true);
    expect(snapshot.rows[2].windows).toEqual([]);
  });

  it('keeps other platforms usable when an older host lacks one subscription reader', async () => {
    const { snapshot } = await readWidgetQuota(reader({ getSubscriptionUsage: async platform => {
      if (platform === 'claude') throw new Error('Unsupported channel');
      return { creditUsagePercent: 50, updatedAt: now };
    } }), () => now);
    expect(snapshot.rows.map(row => row.available)).toEqual([true, false, true]);
  });

  it('does not substitute a builtin account for an unsupported/mismatched named account', async () => {
    const legacy = vi.fn();
    const read = reader({ listProviders: async () => ({ providers: [provider('work-codex', 'codex')] }), getAccountUsage: legacy });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].available).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
    read.getCodexRateLimits = async () => ({ providerId: 'work-codex', rateLimits: { primary: { usedPercent: 12 } } });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].windows[0].remainingPercent).toBe(88);
  });

  it('only restores builtin legacy data for non-identity errors without stamping it as fresh', async () => {
    const legacy = vi.fn(async () => ({ primary: { usedPercent: 20 }, updatedAt: now - 100000 }));
    const read = reader({ getCodexRateLimits: async () => { throw new Error('Unsupported channel'); }, getAccountUsage: legacy });
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].observedAtMs).toBe(now - 100000);
    legacy.mockClear();
    read.getCodexRateLimits = async () => { throw new Error('PRECONDITION_FAILED: reconnect account'); };
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[0].available).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('selects at most one usable native account per platform, never an API-key allowance', () => {
    expect(widgetAccounts({ providers: [
      { ...provider('bad', 'codex'), removed: true },
      { ...provider('reconnect', 'codex'), subscriptionAccount: { reconnectRequired: true } },
      { id: 'api-key', connected: true, auth: { method: 'apiKey' } },
      { id: 'bad-api-key', connected: true, auth: { method: 'apiKey', native: 'codex' } },
      provider('work', 'codex'), provider('openai', 'codex'), provider('anthropic', 'claude'),
    ] }).map(account => account.providerId)).toEqual(['work', 'anthropic']);
  });

  it('honors the computer account order rather than the registry array order', () => {
    expect(widgetAccounts({ providerOrder: ['work', 'openai'], providers: [provider('openai', 'codex'), provider('work', 'codex')] })[0].providerId).toBe('work');
  });

  it('rejects a conflicting account echo even for a builtin', async () => {
    const legacy = vi.fn();
    const result = await readWidgetQuota(reader({ getAccountUsage: legacy, getCodexRateLimits: async () => ({ providerId: 'another-account', rateLimits: { primary: { usedPercent: 5 } } }) }), () => now);
    expect(result.snapshot.rows[0].available).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('does not present a model-only promotional bucket as the whole subscription', async () => {
    const result = await readWidgetQuota(reader({ getCodexRateLimits: async () => ({ rateLimits: { limitId: 'codex_spark', primary: { usedPercent: 20 } } }) }), () => now);
    expect(result.snapshot.rows[0].available).toBe(false);
  });

  it('strips unrecognized native payload fields at every level', () => {
    const raw = { version: 2, source: 'live-source', token: 'secret', rows: [{ platform: 'codex', email: 'private', available: true, observedAtMs: now,
      windows: [{ kind: 'primary', remainingPercent: 0, resetAtMs: null, token: 'secret' }, { kind: 'secondary', remainingPercent: '100' }] }] };
    const snapshot = sanitizeQuotaSnapshot(raw);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|secret|email|private/);
    expect(snapshot.rows[0].windows.map(w => w.remainingPercent)).toEqual([0, null]);
    expect(sanitizeQuotaSnapshot({ ...raw, version: 1 })).toEqual(emptyQuotaSnapshot());
  });

  it('distinguishes genuine zero, missing data, offline, expired and reset windows without inventing replenishment', async () => {
    const { snapshot } = await readWidgetQuota(reader(), () => now);
    const row = snapshot.rows[0], window = row.windows[0];
    expect(quotaWindowState(row, window, 'online', now)).toBe('fresh');
    expect(quotaWindowState(row, window, 'offline', now)).toBe('offline');
    expect(quotaWindowState(row, window, 'online', now + QUOTA_MAX_AGE_MS)).toBe('stale');
    expect(quotaWindowState(row, window, 'online', window.resetAtMs!)).toBe('awaitingRefresh');
    expect(window.remainingPercent).toBe(0);
    expect(quotaWindowState(row, { ...window, remainingPercent: null }, 'online', now)).toBe('unavailable');
    expect(quotaWindowState(row, { ...window, observedAtMs: now + 61000 }, 'online', now)).toBe('unavailable');
  });
  it('preserves individual window times and plans without manufacturing a scoped window', async () => {
    const read = reader({ getSubscriptionUsage: async () => ({
      source: 'unified-headers', updatedAt: now, subscriptionType: 'max',
      fiveHour: { utilization: 10, observedAt: now },
      sevenDay: { utilization: 20, observedAt: now - QUOTA_MAX_AGE_MS },
      scoped: [{ modelDisplayName: 'Fable', utilization: 40, observedAt: now - QUOTA_MAX_AGE_MS }],
    }) });
    const row = (await readWidgetQuota(read, () => now)).snapshot.rows.find(r => r.platform === 'claude')!;
    expect(row.plan).toBe('Max');
    expect(row.windows).toHaveLength(3);
    expect(quotaWindowState(row, row.windows[0], 'online', now)).toBe('stale');
    expect(quotaWindowState(row, row.windows[1], 'online', now)).toBe('fresh');
    expect(row.windows[2].scope).toBe('Fable');
    read.getSubscriptionUsage = async () => ({ source: 'unified-headers', updatedAt: now, fiveHour: { utilization: 10 }, subscriptionType: 'private@example.com' });
    const legacy = (await readWidgetQuota(read, () => now)).snapshot.rows.find(r => r.platform === 'claude')!;
    expect(legacy.plan).toBeNull();
    expect(legacy.windows).toHaveLength(1);
    expect(quotaWindowState(legacy, legacy.windows[0], 'online', now)).toBe('unavailable');
  });

  it('drops a provider disconnected or replaced while usage was being read', async () => {
    let calls = 0;
    const read = reader({ listProviders: async () => ({ providers: ++calls === 1 ? [provider('work', 'codex')] : [provider('other', 'codex')] }),
      getCodexRateLimits: async () => ({ providerId: 'work', rateLimits: { primary: { usedPercent: 15, windowMinutes: 10080 } } }) });
    const result = await readWidgetQuota(read, () => now);
    expect(result.snapshot.rows).toEqual([]);
    expect(result.accounts).toEqual([]);
  });

  it('distinguishes missing windows, read failures and missing host capability', async () => {
    const read = reader({ getSubscriptionUsage: async platform => {
      if (platform === 'claude') return { source: 'oauth-endpoint', subscriptionType: 'pro', updatedAt: now };
      throw new Error('Unsupported channel');
    } });
    const rows = (await readWidgetQuota(read, () => now)).snapshot.rows;
    expect(rows[1]).toMatchObject({ status: 'no-windows', plan: 'Pro', windows: [] });
    expect(rows[2]).toMatchObject({ status: 'unsupported', windows: [] });
    read.getSubscriptionUsage = async () => { throw new Error('timeout'); };
    expect((await readWidgetQuota(read, () => now)).snapshot.rows[1].status).toBe('unavailable');
  });

  it('rejects unlabelled model windows instead of making them account-wide quota', () => {
    const snapshot = sanitizeQuotaSnapshot({ version: 2, source: 'demo', connection: 'online', rows: [{ platform: 'claude', available: true, windows: [{ kind: 'scoped', remainingPercent: 90, observedAtMs: now }] }] });
    expect(snapshot.rows[0].windows).toEqual([]);
  });

});

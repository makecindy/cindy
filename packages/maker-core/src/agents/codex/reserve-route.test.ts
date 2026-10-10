import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexReserveRoute } from './reserve-route.js';
import type { AccountRateLimitsResponse } from '../../types/account-rate-limits.js';

function snapshot(main = 100, reserve = 40): AccountRateLimitsResponse {
  const resetsAt = Date.now() / 1000 + 3600;
  return {
    rateLimits: { primary: { usedPercent: main, resetsAt } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: main, resetsAt } },
      base_model_inference: {
        limitId: 'base_model_inference', limitName: 'gpt-reserve', normalModelSlug: 'gpt-5.6-luna',
        primary: { usedPercent: reserve, resetsAt },
      },
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Codex reserve wire routing', () => {
  it('never blocks a cold send and ignores invalidated late snapshots', async () => {
    let complete!: (result: AccountRateLimitsResponse) => void;
    const routes = new CodexReserveRoute(() => new Promise(resolve => { complete = resolve; }));
    const pending = routes.resolve('a', 'gpt-5.6-luna');
    expect(routes.cached('a', 'gpt-5.6-luna')).toBeNull();
    await Promise.resolve();
    routes.invalidate('a');
    complete(snapshot());
    await pending;
    expect(routes.cached('a', 'gpt-5.6-luna')).toBeNull();
  });

  it('serves a warm snapshot synchronously without repeated IO', async () => {
    const read = vi.fn().mockResolvedValue(snapshot());
    const routes = new CodexReserveRoute(read);
    await routes.resolve('a', 'gpt-5.6-luna');
    for (let i = 0; i < 1000; i++) expect(routes.cached('a', 'gpt-5.6-luna')).toBe('gpt-reserve');
    expect(routes.cached('b', 'gpt-5.6-luna')).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('uses ordinary quota first and never routes another model to Luna reserve', async () => {
    const read = vi.fn().mockResolvedValue(snapshot(50));
    const routes = new CodexReserveRoute(read);
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBeNull();
    read.mockResolvedValue(snapshot());
    routes.invalidate('a');
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBe('gpt-reserve');
    expect(await routes.resolve('a', 'gpt-5.6-sol')).toBeNull();
    read.mockResolvedValue(snapshot(100, 100));
    routes.invalidate('a');
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBeNull();
  });

  it('deduplicates reads without sharing reserve entitlement between accounts', async () => {
    const read = vi.fn(async (id?: string) => snapshot(id === 'a' ? 100 : 50));
    const routes = new CodexReserveRoute(read);
    expect(await Promise.all([routes.resolve('a', 'gpt-5.6-luna'), routes.resolve('a', 'gpt-5.6-luna')]))
      .toEqual(['gpt-reserve', 'gpt-reserve']);
    expect(await routes.resolve('b', 'gpt-5.6-luna')).toBeNull();
    expect(read.mock.calls).toEqual([['a'], ['b']]);
  });

  it('returns to ordinary quota after reset and cache expiry', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(0));
    const routes = new CodexReserveRoute(read);
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBe('gpt-reserve');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBeNull();
  });

  it('bounds a hung lookup and does not apply its late result', async () => {
    vi.useFakeTimers();
    let complete!: (result: AccountRateLimitsResponse) => void;
    const routes = new CodexReserveRoute(() => new Promise(resolve => { complete = resolve; }), 100);
    const pending = routes.resolve('a', 'gpt-5.6-luna');
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    complete(snapshot());
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBeNull();
  });

  it('preserves the normal error path on failed or unsupported quota reads', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ rateLimits: {} });
    const routes = new CodexReserveRoute(read);
    expect(await routes.resolve('a', 'gpt-5.6-luna')).toBeNull();
    expect(await routes.resolve('b', 'gpt-5.6-luna')).toBeNull();
  });
});

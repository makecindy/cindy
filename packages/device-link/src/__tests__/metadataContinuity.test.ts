/** Unit: 30-minute metadata trust across transient directory outages, never authorization.
 * Gap: short promise caches discarded models on failure and could renew a forwarded snapshot.
 * Minimal input: one successful read followed by timeout/denial, with independent fake clocks. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetadataContinuityReader, MetadataSnapshotExpiry } from '../metadataContinuity.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const state = { wall: 0, mono: 0, current: true, online: true };
  const reader = new MetadataContinuityReader({ retryable: error => error === 'offline',
    wallNow: () => state.wall, monotonicNow: () => state.mono, refreshWaitMs: 50 });
  const scope = { key: 'owner-a/realm/permission-1', current: () => state.current, signalingAvailable: () => state.online };
  return { state, reader, scope };
}

describe('bounded metadata continuity', () => {
  it('expires a mounted view from the original host budget and cancels an old snapshot timer on replacement', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const expiry = new MetadataSnapshotExpiry(), expired = vi.fn();
    const requestedAt = { wall: Date.now(), mono: performance.now() };
    await vi.advanceTimersByTimeAsync(200);
    expect(expiry.remember('M', { providerContinuity: { stale: true, remainingMs: 1000 } }, requestedAt, expired)).toBe(true);
    await vi.advanceTimersByTimeAsync(799); expect(expiry.valid('M')).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledTimes(1);
    expect(expiry.remember('M', { providerContinuity: { stale: true, remainingMs: 1000 } }, requestedAt, expired)).toBe(false);
    const next = { wall: Date.now(), mono: performance.now() };
    expiry.remember('M', { providerContinuity: { stale: false, remainingMs: 1000 } }, next, expired);
    expiry.forget('M'); await vi.advanceTimersByTimeAsync(1000);
    expect(expired).toHaveBeenCalledTimes(1);
    const wall = Date.now();
    expiry.remember('M', { providerContinuity: { stale: true, remainingMs: 1000 } }, { wall, mono: performance.now() }, expired);
    vi.setSystemTime(wall + 1001);
    expect(expiry.valid('M')).toBe(false);
    vi.setSystemTime(wall);
    expect(expired).toHaveBeenCalledTimes(2); // Retires payload synchronously, before a clock correction.
    await vi.advanceTimersByTimeAsync(1000);
    expect(expired).toHaveBeenCalledTimes(2);
  });
  it('shares concurrent refreshes, returns independent snapshots and never renews from reads', async () => {
    const f = fixture();
    const request = vi.fn(async () => ({ models: ['a'] }));
    await Promise.all([f.reader.read(f.scope, 'catalog', request), f.reader.read(f.scope, 'catalog', request)]);
    expect(request).toHaveBeenCalledTimes(1);
    f.state.online = false; f.state.wall = f.state.mono = 600_000;
    const first = await f.reader.read(f.scope, 'catalog', request);
    first.value.models.push('untrusted mutation');
    const next = await f.reader.read(f.scope, 'catalog', request);
    expect(next).toEqual({ value: { models: ['a'] }, stale: true, remainingMs: 1_200_000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['wall', 'mono'] as const)('expires when %s reaches 30 minutes even if the other clock goes backwards', async clock => {
    const f = fixture(); await f.reader.read(f.scope, 'catalog', async () => ['a']);
    f.state.wall = f.state.mono = -100_000; f.state[clock] = 1_800_000;
    await expect(f.reader.read(f.scope, 'catalog', async () => { throw 'offline'; })).rejects.toBe('offline');
  });

  it('falls back on transport failure, but an authoritative denial erases the old snapshot', async () => {
    const f = fixture(); await f.reader.read(f.scope, 'catalog', async () => ['a']);
    expect((await f.reader.read(f.scope, 'catalog', async () => { throw 'offline'; })).stale).toBe(true);
    await expect(f.reader.read(f.scope, 'catalog', async () => { throw 'revoked'; })).rejects.toBe('revoked');
    await expect(f.reader.read(f.scope, 'catalog', async () => { throw 'offline'; })).rejects.toBe('offline');
  });

  it('rejects an owner change and cannot publish an invalidated in-flight response over a replacement', async () => {
    const f = fixture(); let finish!: (value: string[]) => void;
    const pending = f.reader.read(f.scope, 'catalog', () => new Promise<string[]>(resolve => { finish = resolve; }));
    await Promise.resolve(); f.reader.invalidate(f.scope);
    await f.reader.read(f.scope, 'catalog', async () => ['new']);
    finish(['old']); await pending;
    f.state.online = false;
    expect((await f.reader.read(f.scope, 'catalog', async () => ['unused'])).value).toEqual(['new']);
    f.state.current = false;
    await expect(f.reader.read(f.scope, 'catalog', async () => ['secret'])).rejects.toThrow('scope changed');
  });

  it('bounds a hung refresh without duplicating the request and applies a late denial', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.reader.read(f.scope, 'catalog', async () => ['a']);
    let reject!: (error: unknown) => void;
    const request = vi.fn(() => new Promise<string[]>((_resolve, fail) => { reject = fail; }));
    const pending = f.reader.read(f.scope, 'catalog', request);
    const sibling = f.reader.read(f.scope, 'catalog', request);
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).stale).toBe(true); expect((await sibling).stale).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    reject('revoked'); await vi.advanceTimersByTimeAsync(0);
    await expect(f.reader.read(f.scope, 'catalog', async () => { throw 'offline'; })).rejects.toBe('offline');
  });

  // Unit: the 256-entry storage bound must not fake a healthy live reply as expired.
  // Gap: the capacity branch returned remainingMs:0 before applying the normal
  // request-start/duration/remainingTrustMs budget. Minimal input: 256 all-flight
  // entries, then one live stamped reply with a 1000ms forwarded remainder.
  it('uses the normal request-start budget for a live reply at the storage capacity bound', async () => {
    const f = fixture();
    const pending: Array<Promise<{ value: unknown; stale: boolean; remainingMs: number }>> = [];
    for (let index = 0; index < 256; index += 1) {
      pending.push(f.reader.read(f.scope, 'pending-' + index, () => new Promise<never>(() => {})));
    }
    const live = await f.reader.read({ ...f.scope, remainingTrustMs: () => 1000 }, 'live', async () => ({
      providers: [{ id: 'live' }],
      providerContinuity: { stale: false, remainingMs: 1000 },
    }));
    expect(live.stale).toBe(false);
    expect(live.remainingMs).toBe(1000);
    expect(live.value).toMatchObject({ providers: [{ id: 'live' }] });
    expect(pending).toHaveLength(256);
  });

  it('preserves the remaining trust of a forwarded snapshot instead of starting 30 minutes again', async () => {
    const f = fixture();
    const scope = { ...f.scope, remainingTrustMs: () => 1000 };
    await f.reader.read(scope, 'catalog', async () => { f.state.wall = f.state.mono = 400; return ['a']; });
    f.state.wall = f.state.mono = 999; f.state.online = false;
    expect((await f.reader.read(scope, 'catalog', async () => ['unused'])).remainingMs).toBe(1);
    f.state.wall = f.state.mono = 1000;
    await expect(f.reader.read(scope, 'catalog', async () => { throw 'offline'; })).rejects.toBe('offline');
  });

  it('lets an explicit directory refresh supersede an older request without replacing the newer snapshot', async () => {
    const f = fixture(), scope = { ...f.scope, joinPending: false };
    await f.reader.read(scope, 'directory', async () => ['initial']);
    let finish!: (value: string[]) => void;
    const old = f.reader.read(scope, 'directory', () => new Promise<string[]>(resolve => { finish = resolve; }));
    await f.reader.read(scope, 'directory', async () => ['new']);
    finish(['old']); await old;
    f.state.online = false;
    expect((await f.reader.read(scope, 'directory', async () => ['unused'])).value).toEqual(['new']);
  });
});

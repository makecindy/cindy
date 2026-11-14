import { describe, expect, it, vi, afterEach } from 'vitest';
import { DiscordFinalTextOutbox, type DiscordFinalTextStorage } from '../finalTextOutbox.js';

// unit: complete/drain/hasCompleted are the production durable-delivery entrypoints.
// Existing streaming tests only cover one process. These minimal restart/receipt inputs cover persisted output,
// confirmed-prefix replay, unknown POST outcomes, changed authorization, TTL and storage failure without real waits.
afterEach(() => vi.useRealTimers());
function harness() {
  let contents: string | null = null;
  let authorization = 'grant-1';
  let identity = 'bot:owner';
  let ready = true;
  let now = 1000;
  const startedAt = Date.now();
  const send = vi.fn<(text: string, nonce: string) => Promise<string>>(async () => 'sent-1');
  const store: DiscordFinalTextStorage = { key: 'test', read: () => contents, write: value => { contents = value; }, assertCurrent: () => {}, authorizationStamp: () => authorization };
  const prepare = vi.fn(async () => ({ assertCurrent: () => {}, send }));
  const warn = vi.fn();
  const create = () => new DiscordFinalTextOutbox({ storage: () => store, identity: () => identity, ready: () => ready, prepare, warn, now: () => now + Date.now() - startedAt });
  return { create, send, prepare, store, warn, get json() { return JSON.parse(contents!); }, set contents(v: string | null) { contents = v; }, get contents() { return contents; }, offline: () => { ready = false; }, online: () => { ready = true; }, revoke: () => { authorization = 'grant-2'; }, changeIdentity: () => { identity = 'other:owner'; }, advance: (ms: number) => { now += ms; } };
}
describe('Discord text-only outbox', () => {
  // #10002 review: empty terminal text must permit immediate media delivery without a rejected empty POST.
  it('delivers an empty terminal as zero segments without sending text', async () => {
    const h = harness(); const outbox = h.create();
    try {
      expect(await outbox.complete('image-only', 'g/10/20', '')).toBe('delivered');
      expect(h.send).not.toHaveBeenCalled();
      expect(h.json.entries[0]).toMatchObject({ state: 'delivered', segments: [] });
    } finally { outbox.stop(); }
  });
  // Recovery invokes drain directly; a held POST must not strand unrelated pending finals.
  it('continues recovery after an uncertain POST while never resending that entry', async () => {
    const h = harness(); h.offline(); const first = h.create();
    await first.complete('first', 'g/10/20', 'unknown');
    await first.complete('second', 'g/10/21', 'remaining'); first.stop();
    h.send.mockRejectedValueOnce(new Error('lost receipt')); h.online();
    const restarted = h.create();
    try {
      await restarted.drain();
      expect(h.send.mock.calls.map(c => c[0])).toEqual(['unknown', 'remaining']);
      expect(h.json.entries.map((e: { state: string }) => e.state)).toEqual(['uncertain', 'delivered']);
    } finally { restarted.stop(); }
  });
  it('shares a 429 deadline across new completions and concurrent drain requests', async () => {
    vi.useFakeTimers(); const h = harness(); const outbox = h.create();
    const entered = Promise.withResolvers<void>(); const response = Promise.withResolvers<string>();
    h.send.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    try {
      const first = outbox.complete('first', 'g/10/20', 'limited'); await entered.promise;
      const second = outbox.complete('second', 'g/10/21', 'later');
      response.reject({ status: 429, retry_after: 10 }); await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(5000);
      await outbox.complete('third', 'g/10/22', 'newer'); await outbox.drain();
      expect(h.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999); expect(h.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.send.mock.calls.map(c => c[0])).toEqual(['limited', 'limited', 'later', 'newer']);
    } finally { outbox.stop(); }
  });
  it('persists final text before delivery, recovers offline completion after restart and leaves a completed-input tombstone', async () => {
    const h = harness(); h.offline(); const first = h.create();
    expect(await first.complete('trigger', 'g/10/20', 'finished')).toBe('pending'); first.stop();
    expect(h.send).not.toHaveBeenCalled(); expect(h.json.entries[0].segments[0].text).toBe('finished');
    const restarted = h.create(); expect(restarted.hasCompleted('trigger', 'g/10/20')).toBe(true);
    h.online(); await restarted.drain();
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.json.entries[0]).toMatchObject({ state: 'delivered', segments: [], receipts: ['sent-1'] });
    await restarted.complete('trigger', 'g/10/20', 'do not generate/send again'); expect(h.send).toHaveBeenCalledTimes(1);
    h.advance(60 * 60 * 1000 + 1); await restarted.drain();
    expect(h.json.entries[0].receipts).toBeUndefined(); expect(restarted.hasCompleted('trigger', 'g/10/20')).toBe(true); restarted.stop();
  });
  it('restarts only the unsent suffix, never confirmed segments', async () => {
    const h = harness(); h.prepare.mockImplementationOnce(async () => ({ assertCurrent: () => {}, send: h.send })).mockRejectedValueOnce(new Error('DISCORD_NOT_CONNECTED'));
    const first = h.create(); await first.complete('trigger', 'g/10/20', 'x'.repeat(2500)); first.stop();
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.json.entries[0].segments[0].state).toBe('sent');
    const next = h.create(); await next.drain(); expect(h.send).toHaveBeenCalledTimes(2); expect(h.json.entries[0].state).toBe('delivered'); next.stop();
  });
  it('holds an ambiguous POST (and crash while sending) instead of using nonce as 24-hour exactly-once', async () => {
    const h = harness(); h.send.mockRejectedValueOnce(new Error('lost receipt'));
    const first = h.create(); expect(await first.complete('trigger', 'g/10/20', 'done')).toBe('uncertain');
    const snapshot = h.json; snapshot.entries[0].state = 'pending'; snapshot.entries[0].segments[0].state = 'sending'; h.contents = JSON.stringify(snapshot);
    const next = h.create(); await next.drain(); expect(h.send).toHaveBeenCalledTimes(1); expect(next.summary()).toMatchObject({ uncertain: 1, pending: 0 });
    expect(next.hasCompleted('trigger', 'g/10/20')).toBe(true); first.stop(); next.stop();
  });
  it.each(['authorization', 'identity'])('cancels pending output after %s changes', async change => {
    const h = harness(); h.offline(); const first = h.create(); await first.complete('trigger', 'g/10/20', 'private'); first.stop();
    if (change === 'authorization') h.revoke(); else h.changeIdentity();
    h.online(); const next = h.create(); await next.drain(); expect(h.send).not.toHaveBeenCalled(); expect(h.json.entries[0]).toMatchObject({ state: 'cancelled', segments: [] }); next.stop();
  });
  it('does not send after revocation while resolving a target, and preserves the ledger when persistence fails', async () => {
    const h = harness(); h.prepare.mockImplementationOnce(async () => { h.revoke(); return { assertCurrent: () => {}, send: h.send }; });
    const outbox = h.create(); await outbox.complete('trigger', 'g/10/20', 'private'); expect(h.send).not.toHaveBeenCalled(); outbox.stop();
    const broken = harness(); broken.store.write = () => { throw new Error('disk'); };
    await expect(broken.create().complete('trigger', 'g/10/20', 'done')).rejects.toThrow('disk'); expect(broken.send).not.toHaveBeenCalled();
  });
  it('respects a definite 429 retryAfter without rerunning or duplicating confirmed sends', async () => {
    vi.useFakeTimers(); const h = harness(); h.send.mockRejectedValueOnce({ status: 429, retry_after: 10 }); const outbox = h.create();
    expect(await outbox.complete('trigger', 'g/10/20', 'done')).toBe('pending');
    await vi.advanceTimersByTimeAsync(9999); expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.send).toHaveBeenCalledTimes(2);
    outbox.stop();
  });
  it('expires delivery and text after 24 hours while retaining the capacity-bounded completed-input tombstone', async () => {
    const h = harness(); h.offline(); const first = h.create();
    await first.complete('trigger', 'g/10/20', 'finished'); first.stop();
    h.advance(24 * 60 * 60 * 1000 + 1); h.online(); const restarted = h.create(); await restarted.drain();
    expect(h.send).not.toHaveBeenCalled(); expect(h.json.entries[0]).toMatchObject({ state: 'expired', segments: [] });
    expect(restarted.hasCompleted('trigger', 'g/10/20')).toBe(true);
    await restarted.complete('trigger', 'g/10/20', 'must not replay'); expect(h.send).not.toHaveBeenCalled(); restarted.stop();
  });
  it('holds a sending checkpoint when its write commits then throws, instead of claiming delivery or blindly retrying', async () => {
    const h = harness(); const write = h.store.write;
    h.store.write = value => {
      write(value);
      if (JSON.parse(value).entries.some((e: { segments: { state: string }[] }) => e.segments.some(s => s.state === 'sending'))) throw new Error('receipt of disk write lost');
    };
    const outbox = h.create(); expect(await outbox.complete('trigger', 'g/10/20', 'done')).toBe('uncertain');
    h.store.write = write; await outbox.drain();
    expect(h.send).not.toHaveBeenCalled(); expect(h.json.entries[0].state).toBe('uncertain');
    expect(outbox.hasCompleted('trigger', 'g/10/20')).toBe(true); outbox.stop();
  });
  it('keeps text pending when shutdown happens while resolving the target', async () => {
    const h = harness(); const outbox = h.create();
    h.prepare.mockImplementationOnce(async () => { outbox.stop(); return { assertCurrent() {}, send: h.send }; });
    expect(await outbox.complete('trigger', 'g/10/20', 'done')).toBe('pending'); expect(h.send).not.toHaveBeenCalled();
    const restarted = h.create(); await restarted.drain(); expect(h.send).toHaveBeenCalledTimes(1); restarted.stop();
  });
  it('reclaims the oldest tombstone at capacity and preserves live pending delivery', async () => {
    const h = harness(); h.offline(); const outbox = h.create();
    await outbox.complete('trigger', 'g/10/20', 'live');
    const live = h.json.entries[0];
    h.contents = JSON.stringify({ version: 1, entries: [live, ...Array.from({ length: 4095 }, (_, i) => ({ ...live, key: `old-${i}`, createdAt: i, state: 'delivered', segments: [] }))] });
    await outbox.complete('another', 'g/10/20', 'new');
    expect(h.json.entries).toHaveLength(4096); expect(h.json.entries.some((e: { key: string }) => e.key === 'old-0')).toBe(false);
    expect(outbox.hasCompleted('trigger', 'g/10/20')).toBe(true); outbox.stop();
  });
});

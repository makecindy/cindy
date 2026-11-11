/** Text-only terminal delivery ledger. Unknown POST outcomes are held, never blindly retried. */
import { createHash } from 'node:crypto';
import { ConnectionRetry } from '../connectionRetry.js';
import { chunkDiscordText } from './chunk.js';
import { discordOperationFailure } from './operations.js';

export interface DiscordFinalTextStorage {
  key: string;
  read(): string | null;
  write(contents: string): void;
  assertCurrent(): void;
  /** Non-secret configuration generation; changing authorization cancels old results. */
  authorizationStamp(lane: string): string;
}
interface Segment { text: string; state: 'pending' | 'sending' | 'sent' | 'uncertain' }
interface Entry {
  key: string; identity: string; lane: string; createdAt: number; authorization: string;
  state: 'pending' | 'delivered' | 'uncertain' | 'cancelled' | 'expired'; segments: Segment[];
  /** Shorter-lived delivery receipts; capacity-bounded completed-input tombstones do not expire with delivery. */
  receipts?: string[];
  deliveredAt?: number;
}
interface Ledger { version: 1; entries: Entry[] }
const TTL = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 4096;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class DiscordFinalTextOutbox {
  private draining: Promise<void> | null = null;
  private drainRequested = false;
  private stopped = false;
  private readonly activeSegments = new Set<string>();
  private readonly retry = new ConnectionRetry({ baseMs: 2000, maxMs: 30_000 });
  constructor(private readonly deps: {
    storage(): DiscordFinalTextStorage | null;
    identity(): string;
    ready(): boolean;
    prepare(lane: string): Promise<{ assertCurrent(): void; send(text: string, nonce: string): Promise<string> }>;
    warn(code: string): void;
    now?: () => number;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private key(requestId: string, lane: string) { return hash(`${this.deps.identity()}\n${lane}\n${requestId}`); }
  private read(store: DiscordFinalTextStorage): Ledger {
    store.assertCurrent();
    const raw = store.read();
    const parsed: Ledger = raw ? JSON.parse(raw) : { version: 1, entries: [] };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('DISCORD_OUTBOX_INVALID');
    const entries = parsed.entries.filter(e => Number.isFinite(e.createdAt));
    for (const e of entries) {
      if (this.now() - e.createdAt >= TTL) {
        if (e.state === 'pending' || e.state === 'uncertain') e.state = 'expired';
        e.segments = [];
        delete e.receipts;
      }
      if (e.deliveredAt && this.now() - e.deliveredAt > 60 * 60 * 1000) delete e.receipts;
      // Crash between POST and receipt persistence: delivery cannot be inferred from a short-lived nonce.
      for (const [index, segment] of e.segments.entries()) if (segment.state === 'sending' && !this.activeSegments.has(`${store.key}:${e.key}:${index}`)) { e.state = 'uncertain'; segment.state = 'uncertain'; }
    }
    const ledger: Ledger = { version: 1, entries };
    if (raw && JSON.stringify(ledger) !== raw) { store.assertCurrent(); store.write(JSON.stringify(ledger)); }
    return ledger;
  }
  private mutate<T>(store: DiscordFinalTextStorage, change: (ledger: Ledger) => T): T {
    const ledger = this.read(store);
    const result = change(ledger);
    store.assertCurrent();
    store.write(JSON.stringify(ledger));
    return result;
  }
  hasCompleted(requestId: string, lane: string): boolean {
    const store = this.deps.storage();
    return !!store && this.read(store).entries.some(e => e.key === this.key(requestId, lane));
  }
  invalidate(): void {
    const store = this.deps.storage();
    if (!store) return;
    this.mutate(store, ledger => { for (const e of ledger.entries) { e.state = 'cancelled'; e.segments = []; } });
    this.retry.reset();
  }
  summary(lane?: string) {
    const store = this.deps.storage();
    if (!store) return { available: false };
    const entries = this.read(store).entries.filter(e => !lane || e.lane === lane);
    return { available: true, pending: entries.filter(e => e.state === 'pending').length, uncertain: entries.filter(e => e.state === 'uncertain').length,
      deliveries: entries.filter(e => e.state === 'pending' || e.state === 'uncertain').map(e => ({ key: e.key, lane: e.lane, createdAt: e.createdAt, state: e.state, confirmedSegments: e.segments.filter(s => s.state === 'sent').length })),
      note: 'Text delivery expires after 24 hours; completed-input tombstones remain within the 4096-entry capacity. Uncertain POST receipts require manual history verification. Nonces only deduplicate for a few minutes.' };
  }
  async complete(requestId: string, lane: string, text: string): Promise<Entry['state']> {
    if (this.stopped) throw new Error('DISCORD_OUTBOX_STOPPED');
    const store = this.deps.storage();
    if (!store) throw new Error('DISCORD_OUTBOX_STORAGE_UNAVAILABLE');
    const key = this.key(requestId, lane);
    this.mutate(store, ledger => {
      if (ledger.entries.some(e => e.key === key)) return;
      const segments: Segment[] = chunkDiscordText(text).map(text => ({ text, state: 'pending' }));
      // Reclaim the oldest tombstone first; live pending/uncertain output is never evicted for new work.
      if (ledger.entries.length >= MAX_ENTRIES) {
        const oldest = ledger.entries.filter(e => !e.segments.length).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) ledger.entries.splice(ledger.entries.indexOf(oldest), 1);
      }
      if (ledger.entries.length >= MAX_ENTRIES || ledger.entries.filter(e => e.segments.length).length >= 256 ||
          Buffer.byteLength(JSON.stringify(ledger)) + Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('DISCORD_OUTBOX_CAPACITY');
      ledger.entries.push({ key, identity: this.deps.identity(), lane, createdAt: this.now(), authorization: store.authorizationStamp(lane), state: segments.length ? 'pending' : 'delivered', segments });
    });
    await this.drain();
    const state = this.read(store).entries.find(e => e.key === key)?.state ?? 'cancelled';
    if (state === 'pending' && !this.stopped) this.retry.schedule(() => { void this.drain(); });
    return state;
  }
  start() { this.stopped = false; }
  stop() { this.stopped = true; this.drainRequested = false; this.retry.reset(); }
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) { this.drainRequested = true; return this.draining; }
    this.draining = this.flush().catch(() => { this.deps.warn('DISCORD_OUTBOX_UNAVAILABLE'); }).finally(() => {
      this.draining = null;
      if (this.drainRequested) { this.drainRequested = false; void this.drain(); }
    });
    return this.draining;
  }
  private async flush(): Promise<void> {
    const store = this.deps.storage();
    if (!store) return;
    this.mutate(store, () => undefined); // TTL cleanup and crash-to-uncertain transition.
    if (!this.deps.ready()) return;
    for (;;) {
      if (this.stopped) return;
      store.assertCurrent();
      const entry = this.read(store).entries.find(e => e.state === 'pending');
      if (!entry) { this.retry.reset(); return; }
      const valid = () => {
        if (this.stopped) throw new Error('DISCORD_OUTBOX_STOPPED');
        store.assertCurrent();
        if (this.now() - entry.createdAt >= TTL) throw new Error('DISCORD_OUTBOX_EXPIRED');
        if (entry.identity !== this.deps.identity() || entry.authorization !== store.authorizationStamp(entry.lane)) throw new Error('DISCORD_OUTBOX_REVOKED');
      };
      let target: Awaited<ReturnType<typeof this.deps.prepare>>;
      try {
        valid();
        target = await this.deps.prepare(entry.lane);
        valid(); target.assertCurrent();
      } catch (error) {
        if (this.stopped || !this.deps.ready()) return;
        const code = error instanceof Error ? error.message : '';
        const failure = discordOperationFailure(error);
        if (code === 'DISCORD_OUTBOX_EXPIRED') { this.mutate(store, () => undefined); continue; }
        if (/CHANGED|REVOKED|DENIED|not enabled|owner changed|connection changed/.test(code) ||
            failure.errorCode === 'DISCORD_NOT_FOUND' || failure.errorCode === 'DISCORD_PERMISSION_DENIED') {
          this.mutate(store, ledger => { const current = ledger.entries.find(e => e.key === entry.key); if (current) { current.state = 'cancelled'; current.segments = []; } });
          continue;
        }
        this.retry.schedule(() => { void this.drain(); }, { minimumDelayMs: (failure.retryAfter ?? 0) * 1000 });
        return;
      }
      const index = entry.segments.findIndex(s => s.state === 'pending');
      if (index < 0) {
        this.mutate(store, ledger => {
          const current = ledger.entries.find(e => e.key === entry.key)!;
          current.state = current.segments.every(s => s.state === 'sent') ? 'delivered' : 'uncertain';
          if (current.state === 'delivered') current.segments = [];
        });
        continue;
      }
      valid(); target.assertCurrent();
      const activeKey = `${store.key}:${entry.key}:${index}`;
      this.activeSegments.add(activeKey);
      try {
        this.mutate(store, ledger => { ledger.entries.find(e => e.key === entry.key)!.segments[index].state = 'sending'; });
        let messageId: string;
        try {
          messageId = await target.send(entry.segments[index].text, hash(`${entry.key}:${index}`).slice(0, 25));
          valid(); target.assertCurrent();
        } catch (error) {
          // Any exception after the POST starts may have a side effect, including a lost receipt.
          const failure = error as { status?: number; retry_after?: number };
          this.mutate(store, ledger => {
            const current = ledger.entries.find(e => e.key === entry.key)!;
            if (current.state === 'cancelled' || !current.segments[index]) return;
            if (failure.status === 429) { current.state = 'pending'; current.segments[index].state = 'pending'; return; }
            if (failure.status && failure.status >= 400 && failure.status < 500) { current.state = 'cancelled'; current.segments = []; return; }
            current.state = 'uncertain'; current.segments[index].state = 'uncertain';
          });
          if (failure.status === 429) this.retry.schedule(() => { void this.drain(); }, { minimumDelayMs: Math.max(1, failure.retry_after ?? 1) * 1000 });
          else this.deps.warn(failure.status && failure.status < 500 ? 'DISCORD_DELIVERY_REJECTED' : 'DISCORD_DELIVERY_UNCERTAIN');
          return;
        }
        this.mutate(store, ledger => {
          const current = ledger.entries.find(e => e.key === entry.key)!;
          if (current.state === 'cancelled' || !current.segments[index]) return;
          current.state = 'pending'; current.segments[index] = { text: '', state: 'sent' };
          (current.receipts ??= []).push(messageId);
          if (current.segments.every(s => s.state === 'sent')) { current.state = 'delivered'; current.deliveredAt = this.now(); current.segments = []; }
        });
      } finally { this.activeSegments.delete(activeKey); }
    }
  }
}

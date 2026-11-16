import { createHash, randomUUID } from 'node:crypto';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

export interface DeliveryIdentity { appId: string; ownerOpenId: string; service: 'feishu' | 'lark' }
export interface FeishuDeliveryBinding {
  revision: string;
  sessionId: string;
  identity: DeliveryIdentity;
  chatIds: string[];
}
export interface FeishuDeliveryReceipt {
  scheduleId: string; runId: string; chatId: string; revision: string; uuid: string;
  card?: unknown;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  attempts: number; nextAt: number; firstAttemptAt?: number; leaseUntil?: number;
  messageId?: string; code?: number; error?: string;
}
export interface FeishuDeliveryState {
  bindings: Record<string, FeishuDeliveryBinding>;
  receipts: Record<string, FeishuDeliveryReceipt>;
}
export interface FeishuDeliveryStore {
  read(): FeishuDeliveryState;
  update(fn: (state: FeishuDeliveryState) => FeishuDeliveryState): Promise<void>;
}
export interface FeishuDeliveryTransport {
  identity: DeliveryIdentity;
  assertCurrent(): void;
  checkChat(chatId: string): Promise<void>;
  send(chatId: string, card: unknown, uuid: string): Promise<{ code: number; messageId?: string }>;
}
export interface FeishuDeliveryDeps {
  store: FeishuDeliveryStore;
  /** Captured synchronously; every await boundary must remain in the same owner/account. */
  captureGuard(): () => void;
  resolve(sessionId: string): Promise<FeishuDeliveryTransport>;
  getSchedule(id: string): Promise<Schedule | null>;
  now?: () => number;
}

const keyOf = (runId: string, chatId: string) => JSON.stringify([runId, chatId]);
const sameIdentity = (a: DeliveryIdentity, b: DeliveryIdentity) =>
  a.appId === b.appId && a.ownerOpenId === b.ownerOpenId && a.service === b.service;
// Feishu message uuid deduplicates for one hour. Never replay an ambiguous send
// outside that window: loss of a receipt is not proof that the message was not sent.
const RETRY_HORIZON = 50 * 60_000;
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 20 * 60_000];

/** Host-owned background delivery, separate from the temporary IM tool lane. */
export class FeishuScheduleDelivery {
  private readonly now: () => number;
  private flushing?: Promise<void>;
  constructor(private readonly deps: FeishuDeliveryDeps) { this.now = deps.now ?? Date.now; }

  async configure(scheduleId: string, chatIds: string[]): Promise<FeishuDeliveryBinding | null> {
    const guard = this.deps.captureGuard();
    const schedule = await this.deps.getSchedule(scheduleId);
    guard();
    if (!schedule) throw new Error('Schedule not found');
    if (chatIds.length > 10 || chatIds.some(id => !/^oc_[A-Za-z0-9_-]{1,128}$/.test(id)))
      throw new Error('Invalid Feishu chat targets');
    let binding: FeishuDeliveryBinding | null = null;
    if (chatIds.length) {
      if (!schedule.targetSessionId) throw new Error('Bind the schedule to a task before enabling group delivery');
      const transport = await this.deps.resolve(schedule.targetSessionId);
      guard(); transport.assertCurrent();
      for (const chatId of new Set(chatIds)) {
        await transport.checkChat(chatId);
        guard(); transport.assertCurrent();
      }
      binding = { revision: randomUUID(), sessionId: schedule.targetSessionId,
        identity: transport.identity, chatIds: [...new Set(chatIds)] };
    }
    await this.deps.store.update(state => {
      guard();
      const old = state.bindings[scheduleId];
      if (binding && old && old.sessionId === binding.sessionId && sameIdentity(old.identity, binding.identity)
        && JSON.stringify(old.chatIds) === JSON.stringify(binding.chatIds)) { binding = old; return state; }
      const bindings = { ...state.bindings };
      if (binding) bindings[scheduleId] = binding; else delete bindings[scheduleId];
      // Reconfiguration revokes all pending work. It never backfills old reports.
      const receipts = Object.fromEntries(Object.entries(state.receipts).map(([key, row]) => [key,
        row.scheduleId === scheduleId && (row.state === 'pending' || row.state === 'sending')
          ? { ...row, state: 'failed' as const, card: undefined, error: 'DELIVERY_REVOKED' } : row]));
      return { bindings, receipts };
    });
    guard();
    return binding;
  }

  status(scheduleId: string) {
    this.deps.captureGuard()();
    const state = this.deps.store.read();
    return { binding: state.bindings[scheduleId] ?? null,
      receipts: Object.values(state.receipts).filter(row => row.scheduleId === scheduleId)
        .map(({ card: _card, ...receipt }) => receipt).slice(-100) };
  }

  async publish(schedule: Schedule, run: ScheduleRun): Promise<void> {
    if (run.status !== 'success' || !run.resultText?.trim()) return;
    const guard = this.deps.captureGuard();
    const saved = this.deps.store.read().bindings[schedule.id];
    if (!saved || saved.sessionId !== schedule.targetSessionId) return;
    await this.deps.store.update(state => {
      guard();
      const binding = state.bindings[schedule.id];
      if (!binding || binding.sessionId !== schedule.targetSessionId) return state;
      const receipts = { ...state.receipts };
      // Keep a bounded history, never evict a live pending delivery to make room.
      for (const [key, row] of Object.entries(receipts))
        if (!row.card && row.nextAt < this.now() - 30 * 86400_000) delete receipts[key];
      for (const chatId of binding.chatIds) {
        const key = keyOf(run.id, chatId);
        if (receipts[key]) continue;
        if (Object.keys(receipts).length >= 2000) throw new Error('Feishu delivery history is full');
        receipts[key] = { scheduleId: schedule.id, runId: run.id, chatId, revision: binding.revision,
          uuid: createHash('sha256').update(JSON.stringify([binding.identity, run.id, chatId])).digest('hex').slice(0, 32),
          card: renderFeishuDeliveryCard(schedule.name, run.resultText!),
          state: 'pending', attempts: 0, nextAt: this.now() };
      }
      return { ...state, receipts };
    });
    guard();
    await this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const guard = this.deps.captureGuard();
    const work = this.flushPending(guard);
    this.flushing = work;
    void work.finally(() => { if (this.flushing === work) this.flushing = undefined; }).catch(() => {});
    return work;
  }

  private async flushPending(guard: () => void): Promise<void> {
    const candidates = Object.entries(this.deps.store.read().receipts)
      .filter(([, row]) => (row.state === 'pending' || row.state === 'sending') && row.nextAt <= this.now()
        && (!row.leaseUntil || row.leaseUntil <= this.now())).slice(0, 20);
    for (const [key] of candidates) {
      guard();
      let claimed: FeishuDeliveryReceipt | undefined;
      let binding: FeishuDeliveryBinding | undefined;
      await this.deps.store.update(state => {
        guard();
        const row = state.receipts[key];
        if (!row || !['pending', 'sending'].includes(row.state) || row.nextAt > this.now()
          || (row.leaseUntil && row.leaseUntil > this.now())) return state;
        binding = state.bindings[row.scheduleId];
        if (!binding || row.revision !== binding.revision || !binding.chatIds.includes(row.chatId)) return state;
        if (row.firstAttemptAt !== undefined && this.now() - row.firstAttemptAt >= RETRY_HORIZON) {
          return { ...state, receipts: { ...state.receipts,
            [key]: { ...row, state: 'unknown', card: undefined, error: 'RECEIPT_UNKNOWN_NO_REPLAY' } } };
        }
        claimed = { ...row, state: 'sending', attempts: row.attempts + 1,
          firstAttemptAt: row.firstAttemptAt ?? this.now(), leaseUntil: this.now() + 2 * 60_000 };
        return { ...state, receipts: { ...state.receipts, [key]: claimed } };
      });
      if (!claimed || !binding) continue;
      const row = claimed;
      let result: Partial<FeishuDeliveryReceipt>;
      try {
        const schedule = await this.deps.getSchedule(row.scheduleId);
        guard();
        if (!schedule || schedule.status === 'paused' || schedule.targetSessionId !== binding.sessionId)
          throw new Error('DELIVERY_REVOKED');
        const transport = await this.deps.resolve(binding.sessionId);
        guard(); transport.assertCurrent();
        if (!sameIdentity(transport.identity, binding.identity)) throw new Error('DELIVERY_IDENTITY_CHANGED');
        // Re-read after async resolution: disabling/reconfiguring must stop queued sends.
        const current = this.deps.store.read();
        const authorized = current.bindings[row.scheduleId];
        if (authorized?.revision !== binding.revision || !authorized.chatIds.includes(row.chatId)
          || !sameIdentity(authorized.identity, binding.identity) || authorized.sessionId !== binding.sessionId
          || current.receipts[key]?.state !== 'sending') throw new Error('DELIVERY_REVOKED');
        transport.assertCurrent(); guard();
        const response = await transport.send(row.chatId, row.card, row.uuid);
        guard();
        result = response.code === 0 && response.messageId
          ? { state: 'sent', code: 0, messageId: response.messageId, card: undefined, error: undefined }
          : { code: response.code, error: response.code === 0 ? 'MISSING_MESSAGE_ID' : 'FEISHU_API_REJECTED' };
      } catch (error) {
        guard();
        // Persist only a stable diagnostic, never SDK objects containing headers/content.
        const message = error instanceof Error ? error.message : '';
        result = { code: undefined, error: ['DELIVERY_REVOKED', 'DELIVERY_IDENTITY_CHANGED'].includes(message)
          ? message : 'FEISHU_TRANSPORT_UNAVAILABLE' };
      }
      await this.deps.store.update(state => {
        guard();
        const current = state.receipts[key];
        if (!current || current.attempts !== row.attempts
          || (current.state !== 'sending' && result.state !== 'sent')) return state;
        const terminal = result.state === 'sent' || result.error === 'DELIVERY_REVOKED'
          || result.error === 'DELIVERY_IDENTITY_CHANGED' || row.attempts >= 5;
        const nextAt = this.now() + (RETRY_DELAYS[row.attempts - 1] ?? 0);
        return { ...state, receipts: { ...state.receipts, [key]: { ...current, ...result,
          state: result.state ?? (terminal ? (result.error === 'DELIVERY_REVOKED' || result.error === 'DELIVERY_IDENTITY_CHANGED'
            || (result.code !== undefined && result.code !== 0) ? 'failed' : 'unknown') : 'pending'), leaseUntil: undefined,
          nextAt, ...(terminal ? { card: undefined } : {}) } } };
      });
    }
  }
}

/** Convert ordinary report tables to schema-2 native table elements. No raw HTML. */
export function renderFeishuDeliveryCard(title: string, text: string): unknown {
  const lines = text.split('\n');
  const elements: unknown[] = [];
  let prose: string[] = [];
  const flush = () => { if (prose.join('\n').trim()) elements.push({ tag: 'markdown', content: prose.join('\n') }); prose = []; };
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    const headers = cells(lines[i]);
    if (!fenced && headers.length > 1 && i + 1 < lines.length
      && cells(lines[i + 1]).length === headers.length && cells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      flush(); i++;
      const rows: Record<string, string>[] = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|')) {
        const row = cells(lines[i + 1]);
        if (row.length !== headers.length) break;
        rows.push(Object.fromEntries(row.map((value, index) => [`c${index}`, value]))); i++;
      }
      elements.push({ tag: 'table', page_size: Math.min(50, Math.max(1, rows.length)),
        columns: headers.map((name, index) => ({ name: `c${index}`, display_name: name, data_type: 'text', width: 'auto' })), rows });
    } else prose.push(lines[i]);
  }
  flush();
  const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: title } }, body: { elements } };
  if (Buffer.byteLength(JSON.stringify(card)) > 28_000) throw new Error('Feishu report exceeds card size limit');
  return card;
}

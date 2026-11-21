import type { beginBackgroundWork } from '@/notifications/backgroundWork';
import type { DurableOutboxRecord } from './durableOutbox';

const SEND_BUDGET_MS = 8_000;
const pending = new Map<string, { until: number; end(): void }>();
const keyFor = (r: DurableOutboxRecord) =>
  JSON.stringify([r.accountId, r.deviceId, r.item.sessionId, r.item.clientId]);

export function isPendingPlainText(record: DurableOutboxRecord): boolean {
  return !record.creation && !record.chat && !record.resourceRef && !record.suspended
    && !record.cancelRequested && !record.cleanupOutcome && !record.historyConfirmed
    && (record.state === 'queued' || record.state === 'sending')
    && !record.uploads.length && !record.item.attachmentSlots.length
    && !record.item.sessionRefs?.length && !record.item.text.trimStart().startsWith('/');
}

/** Only a newly submitted online message may use the connection after leaving the app. */
export function beginOutboxBackgroundSend(record: DurableOutboxRecord, hold: () => () => void,
  requestWork: typeof beginBackgroundWork) {
  const key = keyFor(record);
  pending.get(key)?.end();
  const release = hold();
  const until = Date.now() + SEND_BUDGET_MS;
  let grant: Awaited<ReturnType<typeof beginBackgroundWork>> | undefined;
  const entry = { until, end };
  let timer = setTimeout(end, SEND_BUDGET_MS);
  function end() {
    if (pending.get(key) !== entry) return;
    pending.delete(key);
    clearTimeout(timer);
    release();
    grant?.end();
  }
  pending.set(key, entry);
  void requestWork(SEND_BUDGET_MS).then(work => {
    if (pending.get(key) !== entry) return work.end();
    grant = work;
    entry.until = Math.min(until, Date.now() + work.budgetMs);
    clearTimeout(timer);
    timer = setTimeout(end, Math.max(0, entry.until - Date.now()));
  }).catch(end);
  return end;
}

export function hasOutboxBackgroundSend(record: DurableOutboxRecord): boolean {
  const entry = pending.get(keyFor(record));
  return !!entry && entry.until > Date.now() && !record.cancelRequested
    && (record.state === 'queued' || record.state === 'sending');
}

export function endOutboxBackgroundSend(record: DurableOutboxRecord) {
  pending.get(keyFor(record))?.end();
}

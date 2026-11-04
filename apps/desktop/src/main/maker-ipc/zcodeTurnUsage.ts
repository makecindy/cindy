import type { AgentEvent, Session } from '@cindy/maker-core';

import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import type { PrepareSessionEventDeps } from './sessionEventPreparation.js';

const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const;
type Tokens = Record<(typeof tokenKeys)[number], number>;

// Native receipts start at zero for each runtime epoch, including resumed tasks.
// Keep every epoch's high-water marks for the lifetime of this Session: /clear
// can retain a runtime, and a delayed old snapshot must not charge it twice.
const receiptsBySession = new WeakMap<Session, Map<string, Map<string, Tokens>>>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Persist native ZCode token facts; its receipts do not establish a billable amount. */
export function recordSessionZCodeTurnUsage(
  deps: Pick<PrepareSessionEventDeps, 'turnUsageContextBySession' | 'turnModelPromiseBySession'>,
  session: Session,
  event: AgentEvent,
): void {
  if (event.source !== 'zcode' || (event.type !== 'status' && event.type !== 'done')) return;
  if (event.type === 'done') {
    deps.turnUsageContextBySession.delete(session.id);
    deps.turnModelPromiseBySession.delete(session.id);
  }
  const receipt = record(record(event.data)?.requestUsage);
  if (typeof receipt?.epoch !== 'string' || !receipt.epoch || !Array.isArray(receipt.models)) return;

  let epochs = receiptsBySession.get(session);
  if (!epochs) receiptsBySession.set(session, epochs = new Map());
  let models = epochs.get(receipt.epoch);
  if (!models) epochs.set(receipt.epoch, models = new Map());
  const writes: Promise<void>[] = [];
  let totalTokens = 0;
  for (const raw of receipt.models) {
    const row = record(raw);
    if (!row) continue;
    // Never relabel an unidentified receipt as the selected model after a switch.
    const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
    const previous = models.get(model);
    const next = {} as Tokens;
    const delta = {} as Tokens;
    let modelTokens = 0;
    for (const key of tokenKeys) {
      next[key] = Math.max(previous?.[key] ?? 0, count(row[key]));
      delta[key] = next[key] - (previous?.[key] ?? 0);
      modelTokens += delta[key];
    }
    models.set(model, next);
    if (modelTokens === 0) continue;
    totalTokens += modelTokens;
    writes.push(recordModelTurnUsage({
      sessionId: session.id,
      agentKind: 'zcode',
      model,
      money: null,
      inputTokensDelta: delta.inputTokens,
      outputTokensDelta: delta.outputTokens,
      cacheReadTokensDelta: delta.cacheReadTokens,
      cacheCreateTokensDelta: delta.cacheCreateTokens,
    }));
  }
  if (totalTokens === 0) return;
  void recordSessionTurnTokens(session.id, totalTokens);
  // The existing model writer also updates daily_session_usage. Refresh only
  // after its writes settle so an open dashboard sees the new token rows.
  void Promise.allSettled(writes).then(() => rebroadcastTodaySpend());
}

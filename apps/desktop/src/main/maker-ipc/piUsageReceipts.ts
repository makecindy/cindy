import { getDbClient, getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { localDayKey } from '../localDb/dailySpend.js';
import type { PiUsageWrite } from '../localDb/worker/opHandlers/piUsageTx.js';
import { currentLedgerCurrency, isLedgerCurrencyKnown, LEDGER_CURRENCY_FALLBACK } from '../usage/ledgerCurrency.js';
import { getGatewayModelPricing, getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../usage/referenceModelPricing.js';
import { getSubscriptionValuePriceFor, piSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import { computePriceQuoteTurnMoney, normalizeTurnUsageSegments, normalizeModelIdForPricing, resolveTurnCost } from '../usage/turnCostCalculator.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';
import { rebroadcastTodaySpend } from '../usageBroadcaster.js';
import { broadcastSessionSpend, broadcastSessionTokens } from '../sessionSpendBroadcaster.js';
import { addRegionalMoney, legacyUsdMoney, normalizeRegionalMoney } from '../../shared/regionalMoney.js';
import { createLogger } from '../logger.js';
import type { TurnUsageContext } from './turnUsageContext.js';
import type { Session } from '@cindy/maker-core';

const log = createLogger('pi-usage');
const pending = new Set<Promise<unknown>>();
interface PiUsageOwner {
  db: ReturnType<typeof getDbClient>;
  scope: ReturnType<typeof captureDataOwnerBroadcastScope>;
  /** Only a confirmed account currency may survive an owner boundary. */
  currency?: ReturnType<typeof currentLedgerCurrency>;
  contexts: Map<string, TurnUsageContext>;
}
const owners = new WeakMap<Session, PiUsageOwner>();

function confirmedOwnerCurrency(owner: PiUsageOwner) {
  if (isDataOwnerBroadcastScopeCurrent(owner.scope) && isLedgerCurrencyKnown()) {
    owner.currency = currentLedgerCurrency();
  }
  return owner.currency;
}

export function trackPiUsageWrite(write: Promise<unknown>): void {
  const promise = Promise.resolve(write);
  pending.add(promise);
  void promise.catch(error => log.warn('Pi usage persistence failed', { message: String(error) }))
    .finally(() => pending.delete(promise));
}

export async function flushSessionPiTurnUsage(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

export interface PiReceiptPayload {
  settlementId: string;
  receipts: unknown[];
}

export function isPiReceiptPayload(value: unknown): value is PiReceiptPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PiReceiptPayload>;
  return typeof v.settlementId === 'string' && v.settlementId.length > 0
    && v.settlementId.length <= 128 && Array.isArray(v.receipts);
}

/** Capture the owner DB before any async work. Receipt replay is safe across restarts. */
export function recordPiUsageReceipts(session: Session, usage: PiReceiptPayload, context: TurnUsageContext): void {
  const sessionId = session.id;
  let owner = owners.get(session);
  if (!owner) {
    owner = { db: getDbClient(), scope: captureDataOwnerBroadcastScope(), contexts: new Map() };
    owners.set(session, owner);
  }
  trackPiUsageWrite(persistPiUsageReceipts(owner, sessionId, usage, context));
}

async function persistPiUsageReceipts(owner: PiUsageOwner, sessionId: string, usage: PiReceiptPayload, context: TurnUsageContext,
  recovery?: { day: string; current: () => boolean;
    pricing: Awaited<ReturnType<typeof getGatewayModelPricing>>;
    changed: (hasCost: boolean) => void }): Promise<void> {
  const { db, scope, contexts } = owner;
  const tokenCurrency = confirmedOwnerCurrency(owner) ?? LEDGER_CURRENCY_FALLBACK;
  context = contexts.get(usage.settlementId) ?? context;
  contexts.set(usage.settlementId, context);
  if (contexts.size > 64) contexts.delete(contexts.keys().next().value!);
  const subscription = context.subscriptionKind !== null || context.accessKind === 'subscription';
  const route = context.isUserProviderRoute && !subscription ? 'provider-api' : subscription ? 'subscription' : 'xd-gateway';
  const receipts = usage.receipts.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string, unknown>;
    const segment = normalizeTurnUsageSegments([raw])[0];
    if (!segment?.id || !Number.isSafeInteger(value.recordedAt) || Number(value.recordedAt) <= 0) return [];
    const model = normalizeModelIdForPricing(segment.model || 'unknown');
    const unpriced = value.unpriced === true;
    const needsPricing = !unpriced && (route !== 'provider-api' || context.accessKind === 'managed');
    const row: PiUsageWrite = {
      sessionId, settlementId: usage.settlementId, receiptId: segment.id,
      recordedAt: Number(value.recordedAt), day: recovery?.day ?? localDayKey(Number(value.recordedAt)),
      model: subscription ? piSubscriptionUsageModelKey(model) : model, currency: tokenCurrency,
      inputTokens: segment.inputTokens, outputTokens: segment.outputTokens,
      cacheReadTokens: segment.cacheReadTokens, cacheCreateTokens: segment.cacheCreateTokens,
      amount: needsPricing ? null : 0, approximate: subscription, actualCost: false,
      ...(needsPricing ? { pricingPayload: JSON.stringify({ version: 1,
        receipt: { ...segment, recordedAt: Number(value.recordedAt) }, context,
        day: recovery?.day ?? localDayKey(Number(value.recordedAt)),
        ...(owner.currency ? { currency: owner.currency } : {}),
      }) } : {}),
    };
    return [{ row, segment, model, unpriced, needsPricing }];
  });
  if (!receipts.length) return;
  // Token facts never wait for model pricing or account refresh requests.
  const tokens = recovery ? { changed: false } : await db.tx('usage.recordPiUsage', receipts.map(r => r.row));
  if (recovery && !recovery.current()) return;
  if (tokens.changed && isDataOwnerBroadcastScopeCurrent(scope)) {
    const total = await db.queryOne<{ total: number }>('SELECT total_token_usage AS total FROM sessions WHERE id = ?', [sessionId]);
    if (total) broadcastSessionTokens({ sessionId, totalTokens: total.total }, scope);
    void rebroadcastTodaySpend(scope);
  }
  if (!receipts.some(r => r.needsPricing)) return;
  const pricing = recovery ? recovery.pricing
    : route === 'xd-gateway' ? await getGatewayModelPricingForModel() : getReferenceModelPricing();
  if (recovery && !recovery.current()) return;
  // DB/pricing awaits may have allowed this account's currency to recover.
  // Keep token facts, but never finalize money using an unknown USD fallback.
  const currency = confirmedOwnerCurrency(owner);
  if (!currency) return;
  const priced = receipts.filter(r => r.needsPricing).map(({ row, segment, model, unpriced }) => {
    const segments = unpriced ? [] : [{ ...segment,
      priceVariant: segment.priceVariant ?? (segment.id?.startsWith('pi:') && context.piFastMode ? 'priority' : 'standard'),
    }];
    const money = subscription
      ? computePriceQuoteTurnMoney(row,
        (context.providerId ? getCodexProviderSubscriptionValuePrice(context.providerId, model, pricing, undefined, undefined, 'pi') : undefined)
          ?? getSubscriptionValuePriceFor('pi', model, pricing), currency, segments)
      : resolveTurnCost({ rawModel: model, agent: 'pi', tokens: row,
        sdkCostDelta: route === 'provider-api' || unpriced ? undefined : segment.costUsd,
        pricing, context: { providerId: context.providerId, billingRoute: route,
          region: CURRENT_CINDY_REGION, accessKind: context.accessKind }, segments }).money;
    // BYOM reference estimates stay message-only, as in the legacy turn path.
    const ledgerMoney = money?.kind === 'actual-cost' || subscription ? money : null;
    // A resolved message-only estimate is final without ledger spend. Only a
    // missing quote stays pending for replay after the catalog becomes available.
    return { ...row, amount: ledgerMoney?.amount ?? (money ? 0 : null), currency: ledgerMoney?.currency ?? currency,
      approximate: ledgerMoney?.approximate ?? subscription, actualCost: ledgerMoney?.kind === 'actual-cost' };
  });
  if (!priced.some(row => row.amount !== null)) return;
  const result = await db.tx('usage.recordPiUsage', priced);
  if (!result.changed) return;
  const hasCost = priced.some(row => row.actualCost && row.amount !== null && row.amount > 0);
  if (recovery) { recovery.changed(hasCost); return; }
  if (hasCost) await broadcastPersistedPiSpend(owner, sessionId);
  void rebroadcastTodaySpend(scope);
}

async function broadcastPersistedPiSpend(owner: PiUsageOwner, sessionId: string): Promise<void> {
  const { db, scope } = owner;
  if (isDataOwnerBroadcastScopeCurrent(scope)) {
    const row = await db.queryOne<{ legacy: number; amount: number; currency: string | null; approximate: number }>(
      `SELECT total_cost_usd AS legacy, total_cost_amount AS amount, total_cost_currency AS currency,
        total_cost_is_approximate AS approximate FROM sessions WHERE id = ?`, [sessionId]);
    if (row) {
      const legacy = legacyUsdMoney(row.legacy ?? 0);
      const current = normalizeRegionalMoney({ amount: row.amount, currency: row.currency ?? owner.currency ?? LEDGER_CURRENCY_FALLBACK,
        approximate: Boolean(row.approximate), kind: 'actual-cost' });
      const totalMoney = current
        ? legacy.currency === current.currency ? addRegionalMoney([legacy, current]) : current
        : legacy;
      broadcastSessionSpend({ sessionId, totalMoney,
        ...(totalMoney.currency === 'USD' ? { totalCostUsd: totalMoney.amount } : {}) }, scope);
    }
  }
}

const recoveries = new WeakMap<PiUsageOwner['db'], { promise: Promise<void>; again: boolean }>();

/** Replays only durable request facts in this account's DB, never historical totals. */
export function retryPendingPiUsageReceipts(): Promise<void> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) return Promise.resolve();
  const existing = recoveries.get(snapshot.client);
  if (existing) { existing.again = true; return existing.promise; }
  const owner: PiUsageOwner = { db: snapshot.client, scope: captureDataOwnerBroadcastScope(), contexts: new Map() };
  const current = () => getCurrentDbClientSnapshot() === snapshot && isDataOwnerBroadcastScopeCurrent(owner.scope);
  const state = { again: false, promise: Promise.resolve() };
  state.promise = (async () => {
    do {
      state.again = false;
      let cursor = 0;
      while (current()) {
        const rows = await owner.db.query<{ rowId: number; sessionId: string; settlementId: string; receiptId: string; payload: string }>(
          `SELECT rowid AS rowId, session_id AS sessionId, settlement_id AS settlementId,
            receipt_id AS receiptId, pricing_payload AS payload FROM pi_usage_receipts
            WHERE priced = 0 AND pricing_payload IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT 100`, [cursor]);
        if (!current() || rows.length === 0) break;
        // Cache reads only: never wait once per receipt for the same model sync.
        const gatewayPricing = await getGatewayModelPricing();
        if (!current()) return;
        const referencePricing = getReferenceModelPricing();
        const changedSessions = new Set<string>();
        let changed = false;
        for (const row of rows) {
          if (!current()) return;
          cursor = row.rowId;
          try {
            const saved = JSON.parse(row.payload);
            if (saved.version !== 1 || saved.receipt?.id !== row.receiptId || !saved.context
                || typeof saved.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(saved.day)) continue;
            if (!owner.currency && (saved.currency === 'USD' || saved.currency === 'CNY')) owner.currency = saved.currency;
            const subscription = saved.context.subscriptionKind !== null || saved.context.accessKind === 'subscription';
            await persistPiUsageReceipts(owner, row.sessionId,
              { settlementId: row.settlementId, receipts: [saved.receipt] }, saved.context, {
                day: saved.day, current,
                pricing: subscription || saved.context.isUserProviderRoute ? referencePricing : gatewayPricing,
                changed: hasCost => { changed = true; if (hasCost) changedSessions.add(row.sessionId); },
              });
          } catch (error) {
            log.warn('Pi pending usage recovery failed', { message: String(error) });
          }
        }
        if (current() && changed) {
          for (const sessionId of changedSessions) await broadcastPersistedPiSpend(owner, sessionId);
          void rebroadcastTodaySpend(owner.scope);
        }
      }
    } while (state.again && current());
  })().finally(() => { recoveries.delete(snapshot.client); });
  recoveries.set(snapshot.client, state);
  trackPiUsageWrite(state.promise);
  return state.promise;
}

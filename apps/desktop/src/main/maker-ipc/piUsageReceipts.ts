import { getDbClient } from '../localDb/client/current.js';
import { localDayKey } from '../localDb/dailySpend.js';
import type { PiUsageWrite } from '../localDb/worker/opHandlers/piUsageTx.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { getGatewayModelPricingForModel } from '../usage/modelPricing.js';
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
const owners = new WeakMap<Session, {
  db: ReturnType<typeof getDbClient>;
  scope: ReturnType<typeof captureDataOwnerBroadcastScope>;
  currency: ReturnType<typeof currentLedgerCurrency>;
  contexts: Map<string, TurnUsageContext>;
}>();

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
    owner = { db: getDbClient(), scope: captureDataOwnerBroadcastScope(), currency: currentLedgerCurrency(), contexts: new Map() };
    owners.set(session, owner);
  }
  const { db, scope, currency, contexts } = owner;
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
    const row: PiUsageWrite = {
      sessionId, settlementId: usage.settlementId, receiptId: segment.id,
      recordedAt: Number(value.recordedAt), day: localDayKey(Number(value.recordedAt)),
      model: subscription ? piSubscriptionUsageModelKey(model) : model, currency,
      inputTokens: segment.inputTokens, outputTokens: segment.outputTokens,
      cacheReadTokens: segment.cacheReadTokens, cacheCreateTokens: segment.cacheCreateTokens,
      amount: null, approximate: subscription, actualCost: false,
    };
    return [{ row, segment, model, unpriced: value.unpriced === true }];
  });
  if (!receipts.length) return;
  trackPiUsageWrite((async () => {
    // Token facts never wait for model pricing or account refresh requests.
    await db.tx('usage.recordPiUsage', receipts.map(r => r.row));
    if (isDataOwnerBroadcastScopeCurrent(scope)) {
      const total = await db.queryOne<{ total: number }>('SELECT total_token_usage AS total FROM sessions WHERE id = ?', [sessionId]);
      if (total) broadcastSessionTokens({ sessionId, totalTokens: total.total }, scope);
      void rebroadcastTodaySpend(scope);
    }
    const pricing = route === 'xd-gateway' ? await getGatewayModelPricingForModel() : getReferenceModelPricing();
    const priced = receipts.map(({ row, segment, model, unpriced }) => {
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
      // An unavailable quote is not a zero-cost receipt. Terminal replay can
      // finish pricing after the catalog becomes available.
      return { ...row, amount: ledgerMoney?.amount ?? null, currency: ledgerMoney?.currency ?? currency,
        approximate: ledgerMoney?.approximate ?? subscription, actualCost: ledgerMoney?.kind === 'actual-cost' };
    });
    const result = await db.tx('usage.recordPiUsage', priced);
    if (result.changed && priced.some(row => row.actualCost && row.amount !== null && row.amount > 0)
        && isDataOwnerBroadcastScopeCurrent(scope)) {
      const row = await db.queryOne<{ legacy: number; amount: number; currency: string | null; approximate: number }>(
        `SELECT total_cost_usd AS legacy, total_cost_amount AS amount, total_cost_currency AS currency,
          total_cost_is_approximate AS approximate FROM sessions WHERE id = ?`, [sessionId]);
      if (row) {
        const legacy = legacyUsdMoney(row.legacy ?? 0);
        const current = normalizeRegionalMoney({ amount: row.amount, currency: row.currency ?? currency,
          approximate: Boolean(row.approximate), kind: 'actual-cost' });
        const totalMoney = current
          ? legacy.currency === current.currency ? addRegionalMoney([legacy, current]) : current
          : legacy;
        broadcastSessionSpend({ sessionId, totalMoney,
          ...(totalMoney.currency === 'USD' ? { totalCostUsd: totalMoney.amount } : {}) }, scope);
      }
    }
    void rebroadcastTodaySpend(scope);
  })());
}

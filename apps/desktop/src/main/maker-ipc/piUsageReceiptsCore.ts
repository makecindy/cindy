import { mayRecordTurnUsage, turnUsageAdmission } from '../usage/turnUsageAdmission.js';
import { getDbClient, getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { localDayKey } from '../localDb/dailySpend.js';
import type { PiUsageWrite } from '../localDb/worker/opHandlers/piUsageTx.js';
import { currentLedgerCurrency, isLedgerCurrencyKnown, LEDGER_CURRENCY_FALLBACK } from '../usage/ledgerCurrency.js';
import { getGatewayModelPricing, getGatewayModelPricingForModel } from './turnUsagePorts.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../usage/referenceModelPricingCore.js';
import { getSubscriptionValuePriceFor, piSubscriptionUsageModelKey } from '../usage/usageModelKeys.js';
import { computePriceQuoteTurnMoney, normalizeTurnUsageSegments, normalizeModelIdForPricing, resolveTurnCost } from '../usage/turnCostCalculator.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';
import { rebroadcastTodaySpend } from './turnUsagePorts.js';
import { broadcastSessionSpend, broadcastSessionTokens } from './turnUsagePorts.js';
import { sessionSpendAmounts, normalizeRegionalMoney } from '../../shared/regionalMoney.js';
import { createLogger } from '../logger.js';
import { tokenAttribution, piModelBilling, type TurnUsageContext } from './turnUsageContextCore.js';
import type { Session } from '@cindy/maker-core';

const log = createLogger('pi-usage');
const pending = new Set<Promise<unknown>>();
interface PiUsageOwner {
  db: ReturnType<typeof getDbClient>;
  account?: () => boolean;
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
  const account = turnUsageAdmission.getStore();
  if (!owner || (account && owner.account !== account)) {
    owner = { db: getDbClient(), scope: captureDataOwnerBroadcastScope(), contexts: new Map(), account };
    owners.set(session, owner);
  } else if (account) {
    // A new connection/window generation of this same account inherits the settlement
    // context and confirmed currency. In-flight receipts keep their own original DB.
    owner = { ...owner, db: getDbClient(), scope: captureDataOwnerBroadcastScope() };
    owners.set(session, owner);
  }
  trackPiUsageWrite(persistPiUsageReceipts(owner, sessionId, usage, context, !session.remoteHostId && !session.agentDeviceId));
}

async function persistPiUsageReceipts(owner: PiUsageOwner, sessionId: string, usage: PiReceiptPayload, context: TurnUsageContext, localExecution: boolean,
  recovery?: { day: string; current: () => boolean;
    pricing: Awaited<ReturnType<typeof getGatewayModelPricing>>;
    changed: (hasCost: boolean) => void }): Promise<void> {
  const { db, scope, contexts } = owner;
  const tokenCurrency = confirmedOwnerCurrency(owner) ?? LEDGER_CURRENCY_FALLBACK;
  context = contexts.get(usage.settlementId) ?? context;
  contexts.set(usage.settlementId, context);
  if (contexts.size > 64) contexts.delete(contexts.keys().next().value!);
  const receipts = usage.receipts.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string, unknown>;
    const segment = normalizeTurnUsageSegments([raw])[0];
    if (!segment?.id || !Number.isSafeInteger(value.recordedAt) || Number(value.recordedAt) <= 0) return [];
    const model = normalizeModelIdForPricing(segment.model || 'unknown');
    const { route, billing } = piModelBilling(context, model);
    const subscription = route === 'subscription';
    const unpriced = value.unpriced === true;
    const needsPricing = !unpriced && (route !== 'provider-api' || context.accessKind === 'managed');
    const row: PiUsageWrite = {
      attribution: localExecution ? tokenAttribution(billing, context) : undefined,
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
    return [{ row, segment, model, route, subscription, unpriced, needsPricing }];
  });
  if (!receipts.length) return;
  // Token facts never wait for model pricing or account refresh requests.
  const tokens = recovery ? { changed: false } : await db.tx('usage.recordPiUsage', receipts.map(r => r.row));
  if (!mayRecordTurnUsage() || (recovery && !recovery.current())) return;
  const tokensScope = owner.account?.() ? captureDataOwnerBroadcastScope() : scope;
  if (tokens.changed && isDataOwnerBroadcastScopeCurrent(tokensScope)) {
    const total = await db.queryOne<{ total: number }>('SELECT total_token_usage AS total FROM sessions WHERE id = ?', [sessionId]);
    if (total) broadcastSessionTokens({ sessionId, totalTokens: total.total }, tokensScope);
    void rebroadcastTodaySpend(tokensScope);
  }
  if (!receipts.some(r => r.needsPricing)) return;
  const gatewayPricing = recovery ? recovery.pricing
    : receipts.some(r => r.route === 'xd-gateway') ? await getGatewayModelPricingForModel() : null;
  if (!mayRecordTurnUsage() || (recovery && !recovery.current())) return;
  // DB/pricing awaits may have allowed this account's currency to recover.
  // Only Gateway settlement depends on account recovery. Other quotes carry their own currency.
  // Token admission and priced settlement are separate SQLite transactions.
  // A reopened connection for this same account may now be the live writer.
  if (owner.account?.()) owner = { ...owner, db: getDbClient(), scope: captureDataOwnerBroadcastScope() };
  const currency = confirmedOwnerCurrency(owner);
  const referencePricing = getReferenceModelPricing();
  const piOpaqueModelIds = context.opaqueModelIdsByAgent?.pi;
  const priced = receipts.filter(r => r.needsPricing && (r.route !== 'xd-gateway' || currency)).map(({ row, segment, model, route, subscription, unpriced }) => {
    const pricing = route === 'xd-gateway' ? gatewayPricing : referencePricing;
    const segments = unpriced ? [] : [{ ...segment,
      priceVariant: segment.priceVariant ?? (segment.id?.startsWith('pi:') && context.piFastMode ? 'priority' : 'standard'),
    }];
    const isMainRequest = !segment.id?.startsWith('pi-child:');
    const normalizedContextModel = context.selectedModel
      ? normalizeModelIdForPricing(context.selectedModel)
      : undefined;
    const isSelectedOpaque = Boolean(
      isMainRequest &&
      piOpaqueModelIds?.length &&
      (!normalizedContextModel ||
        normalizedContextModel === 'unknown' ||
        piOpaqueModelIds.includes(normalizedContextModel)),
    );
    const money = subscription
      ? computePriceQuoteTurnMoney(row,
        (context.providerId ? getCodexProviderSubscriptionValuePrice(context.providerId, model, pricing, undefined, undefined, 'pi') : undefined)
          ?? getSubscriptionValuePriceFor('pi', model, pricing), segments)
      : resolveTurnCost({ rawModel: model, agent: 'pi', tokens: row,
        sdkCostDelta: route === 'provider-api' || unpriced ? undefined : segment.costUsd,
        pricing, context: { providerId: context.providerId, billingRoute: route,
          region: CURRENT_CINDY_REGION, accessKind: context.accessKind,
          ...(isMainRequest && normalizedContextModel && normalizedContextModel !== 'unknown'
            ? { selectedModel: normalizedContextModel }
            : {}),
          ...(isSelectedOpaque ? { opaqueModelId: true } : {}),
          opaqueModelIds: piOpaqueModelIds,
          ...(context.officialAnthropicApi !== undefined
            ? { officialAnthropicApi: context.officialAnthropicApi }
            : {}),
          ...(context.officialAnthropicModels !== undefined
            ? { officialAnthropicModels: context.officialAnthropicModels }
            : {}),
        }, segments }).money;
    // BYOM reference estimates stay message-only, as in the legacy turn path.
    const ledgerMoney = money?.kind === 'actual-cost' || subscription ? money : null;
    // A resolved message-only estimate is final without ledger spend. Only a
    // missing quote stays pending for replay after the catalog becomes available.
    return { ...row, amount: ledgerMoney?.amount ?? (money ? 0 : null), currency: ledgerMoney?.currency ?? row.currency,
      approximate: ledgerMoney?.approximate ?? subscription, actualCost: ledgerMoney?.kind === 'actual-cost' };
  });
  if (!priced.some(row => row.amount !== null)) return;
  const result = await owner.db.tx('usage.recordPiUsage', priced);
  if (!result.changed) return;
  const hasCost = priced.some(row => row.actualCost && row.amount !== null && row.amount > 0);
  if (recovery) { recovery.changed(hasCost); return; }
  if (hasCost) await broadcastPersistedPiSpend(owner, sessionId);
  void rebroadcastTodaySpend(owner.scope);
}

async function broadcastPersistedPiSpend(owner: PiUsageOwner, sessionId: string): Promise<void> {
  const { db, scope } = owner;
  if (isDataOwnerBroadcastScopeCurrent(scope)) {
    const row = await db.queryOne<{ legacy: number; usdApproximate: number; amount: number; currency: string | null; approximate: number }>(
      `SELECT total_cost_usd AS legacy, total_cost_usd_is_approximate AS usdApproximate, total_cost_amount AS amount, total_cost_currency AS currency,
        total_cost_is_approximate AS approximate FROM sessions WHERE id = ?`, [sessionId]);
    if (row) {
      const current = normalizeRegionalMoney({ amount: row.amount, currency: row.currency ?? owner.currency ?? LEDGER_CURRENCY_FALLBACK,
        approximate: Boolean(row.approximate), kind: 'actual-cost' });
      broadcastSessionSpend({sessionId, ...sessionSpendAmounts(row.legacy ?? 0, current, Boolean(row.usdApproximate))}, scope);
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
            await persistPiUsageReceipts(owner, row.sessionId,
              { settlementId: row.settlementId, receipts: [saved.receipt] }, saved.context, false, {
                day: saved.day, current,
                pricing: gatewayPricing,
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

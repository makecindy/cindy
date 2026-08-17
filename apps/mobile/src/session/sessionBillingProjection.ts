import { BUILTIN_PROVIDERS } from '@cindy/model-providers';

import type { MobileEstimatedSessionValueSnapshot } from '@/device-link/mobileMakerTransport';
import {
  normalizeRemoteMoney,
  type RemoteMoney,
  type RemoteMoneyEstimateReason,
} from '@/session/remoteMoney';
import type { RemoteSession } from '@/session/types';
import type { RemoteMessage } from '@/session/types';

export type MobileSdkCostPresentation = 'regular' | 'hidden' | 'estimate';

export interface MobileMessageBillingProjection {
  presentation: MobileSdkCostPresentation;
  showSdkEstimate: boolean;
  entries: MobileEstimatedSessionValueSnapshot['entries'];
}

const BUILTIN_PROVIDER_IDS = new Set([
  ...BUILTIN_PROVIDERS.map((provider) => provider.id),
  // Pi persists the XD aggregate route under this compatibility id.
  'cindy',
]);

export function resolveMobileSdkCostPresentation(
  providerId: string | null | undefined,
  providers: readonly { id: string; source?: string }[],
  showSdkEstimate: boolean,
): MobileSdkCostPresentation {
  if (!providerId || BUILTIN_PROVIDER_IDS.has(providerId)) return 'regular';
  const provider = providers.find((item) => item.id === providerId);
  const isCustom = provider?.source !== 'builtin';
  if (!isCustom) return 'regular';
  return showSdkEstimate ? 'estimate' : 'hidden';
}

/**
 * A projection request is authoritative for money display. Until it succeeds, callers use
 * this token-only view so stale custom-provider SDK amounts never flash as real spend.
 */
export function withoutSessionMoney(session: RemoteSession): RemoteSession {
  const { totalMoney: _totalMoney, ...rest } = session;
  return { ...rest, totalCostUsd: 0 };
}

/**
 * The host projection is a point-in-time view of both the persisted session ledger and
 * assistant turn metadata. Keep the revision intentionally narrow so message bodies and
 * unrelated session edits do not retrigger a billing query.
 */
export function mobileSessionBillingRevision(
  session: RemoteSession,
  messages: readonly RemoteMessage[],
): string {
  const assistantTurns = messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const meta = message.agentMeta;
    if (!meta) return [];
    const hasBillingMetadata =
      meta.turnCost !== undefined ||
      meta.turnCostUsd !== undefined ||
      meta.turnCostIsEstimate !== undefined ||
      meta.turnCostIsCustomProvider !== undefined ||
      meta.turnCostProviderId !== undefined ||
      meta.userTurnCost !== undefined ||
      meta.userTurnCostUsd !== undefined ||
      meta.userTurnCostIsEstimate !== undefined ||
      meta.turnUsageDetails !== undefined;
    if (!hasBillingMetadata) return [];
    return [{
      clientId: message.clientId,
      createdAt: message.createdAt,
      turnCost: meta.turnCost,
      turnCostUsd: meta.turnCostUsd,
      turnCostIsEstimate: meta.turnCostIsEstimate,
      turnCostIsCustomProvider: meta.turnCostIsCustomProvider,
      turnCostProviderId: meta.turnCostProviderId,
      userTurnCost: meta.userTurnCost,
      userTurnCostUsd: meta.userTurnCostUsd,
      userTurnCostIsEstimate: meta.userTurnCostIsEstimate,
      turnUsageDetails: meta.turnUsageDetails,
    }];
  });
  return JSON.stringify({
    sessionId: session.id,
    updatedAt: session.updatedAt,
    clearedAt: session.clearedAt ?? null,
    totalMoney: session.totalMoney ?? null,
    totalCostUsd: session.totalCostUsd ?? 0,
    assistantTurns,
  });
}

/**
 * A send can resume after uploads while the session ledger has already advanced in the store.
 * Never persist a `/cost` card from a projection built for the older revision.
 */
export function billingSessionForRevision(
  sessionAtSend: RemoteSession,
  messages: readonly RemoteMessage[],
  projectedSession: RemoteSession | null,
  projectedRevision: string,
): RemoteSession {
  return projectedSession &&
    mobileSessionBillingRevision(sessionAtSend, messages) === projectedRevision
    ? projectedSession
    : withoutSessionMoney(sessionAtSend);
}

export function projectSessionBilling(
  session: RemoteSession,
  snapshot: MobileEstimatedSessionValueSnapshot,
): RemoteSession {
  const persistedMoney =
    normalizeRemoteMoney(session.totalMoney) ?? legacyUsdMoney(session.totalCostUsd);
  const excludedActualMoney = addCompatibleRemoteMoney(
    snapshot.entries.flatMap((entry) => {
      const money = normalizeRemoteMoney(entry.excludedActualMoney);
      return money && money.amount > 0 ? [money] : [];
    }),
    persistedMoney?.currency,
  );
  const actualMoney = subtractCompatibleRemoteMoney(persistedMoney, excludedActualMoney);
  const estimatedMoney =
    normalizeRemoteMoney(snapshot.totalValueMoney) ?? legacyEstimateMoney(snapshot.totalValueUsd);
  const totalMoney = addCompatibleRemoteMoney(
    [actualMoney, estimatedMoney].filter((money): money is RemoteMoney => Boolean(money)),
    actualMoney?.currency ?? estimatedMoney?.currency,
  );
  const { totalMoney: _totalMoney, ...rest } = session;
  return {
    ...rest,
    ...(totalMoney && totalMoney.amount > 0 ? { totalMoney } : {}),
    totalCostUsd: totalMoney?.currency === 'USD' ? totalMoney.amount : 0,
  };
}

/**
 * Projects persisted and live assistant billing metadata into the mobile display policy.
 * Host entries are authoritative for historical rows (including legacy rows that predate
 * per-turn provider attribution); rows newer than the snapshot use the same fail-closed rules
 * locally until the next projection arrives.
 */
export function projectMobileMessageBilling(
  messages: readonly RemoteMessage[],
  projection: MobileMessageBillingProjection,
): RemoteMessage[] {
  const entries = new Map(projection.entries.map((entry) => [entry.clientId, entry]));
  let hasUserBoundary = false;
  let roundValues: RemoteMoney[] = [];

  return messages.map((message) => {
    if (isRealUserBoundary(message)) {
      hasUserBoundary = true;
      roundValues = [];
      return message;
    }
    if (message.role !== 'assistant') return message;

    const originalMeta = message.agentMeta ?? {};
    const entry = entries.get(message.clientId);
    const turnMoney = moneyFromMeta(
      originalMeta,
      'turnCost',
      'turnCostUsd',
      'turnCostIsEstimate',
    );
    const userTurnMoney = moneyFromMeta(
      originalMeta,
      'userTurnCost',
      'userTurnCostUsd',
      'userTurnCostIsEstimate',
    );
    const presentation = resolveMessagePresentation(
      turnMoney ?? userTurnMoney,
      originalMeta,
      entry,
      projection,
    );
    const usageDetails = entry?.turnUsageDetails ?? originalMeta.turnUsageDetails;
    const projectedTurnMoney = authoritativeEntryMoney(entry) ?? (
      entryHasAuthoritativeMoney(entry)
        ? null
        : projectSdkCostMoneyWithBreakdown(turnMoney, usageDetails, presentation)
    );
    if (hasUserBoundary && projectedTurnMoney?.amount) roundValues.push(projectedTurnMoney);

    const hasPersistedUserTotal = Boolean(
      normalizeRemoteMoney(originalMeta.userTurnCost) ||
      positiveNumber(originalMeta.userTurnCostUsd) !== null,
    );
    const projectedUserTurnMoney = hasUserBoundary
      ? hasPersistedUserTotal && roundValues.length > 0
        ? addCompatibleRemoteMoney(roundValues, roundValues[0].currency)
        : null
      : projectSdkCostMoney(userTurnMoney, presentation);
    const projectedUsageDetails = projectUsageDetails(usageDetails, presentation);

    const nextMeta: Record<string, unknown> = { ...originalMeta };
    delete nextMeta.turnCost;
    delete nextMeta.turnCostUsd;
    delete nextMeta.turnCostIsEstimate;
    delete nextMeta.userTurnCost;
    delete nextMeta.userTurnCostUsd;
    delete nextMeta.userTurnCostIsEstimate;
    if (projectedTurnMoney) {
      nextMeta.turnCost = projectedTurnMoney;
      if (projectedTurnMoney.currency === 'USD') nextMeta.turnCostUsd = projectedTurnMoney.amount;
      nextMeta.turnCostIsEstimate = projectedTurnMoney.kind === 'value-estimate';
    }
    if (projectedUserTurnMoney) {
      nextMeta.userTurnCost = projectedUserTurnMoney;
      if (projectedUserTurnMoney.currency === 'USD') {
        nextMeta.userTurnCostUsd = projectedUserTurnMoney.amount;
      }
      nextMeta.userTurnCostIsEstimate = projectedUserTurnMoney.kind === 'value-estimate';
    }
    if (projectedUsageDetails === undefined) delete nextMeta.turnUsageDetails;
    else nextMeta.turnUsageDetails = projectedUsageDetails;
    if (typeof entry?.turnCostIsCustomProvider === 'boolean') {
      nextMeta.turnCostIsCustomProvider = entry.turnCostIsCustomProvider;
    }
    if (typeof entry?.turnCostProviderId === 'string' || entry?.turnCostProviderId === null) {
      nextMeta.turnCostProviderId = entry.turnCostProviderId;
    }
    return { ...message, agentMeta: nextMeta };
  });
}

type EstimatedValueEntry = MobileEstimatedSessionValueSnapshot['entries'][number];

function isRealUserBoundary(message: RemoteMessage): boolean {
  return message.role === 'user' &&
    message.systemCardType !== 'auto-resume' &&
    message.agentMeta?.autoResume !== true;
}

function moneyFromMeta(
  meta: Record<string, unknown>,
  structuredKey: string,
  legacyUsdKey: string,
  estimateKey: string,
): RemoteMoney | null {
  const structured = normalizeRemoteMoney(meta[structuredKey]);
  if (structured?.amount) return structured;
  const legacyUsd = positiveNumber(meta[legacyUsdKey]);
  if (legacyUsd === null) return null;
  const isEstimate = meta[estimateKey] === true;
  return {
    amount: legacyUsd,
    currency: 'USD',
    approximate: isEstimate,
    kind: isEstimate ? 'value-estimate' : 'actual-cost',
    ...(isEstimate ? { estimateReasons: ['legacy-usd' as const] } : {}),
  };
}

function resolveMessagePresentation(
  money: RemoteMoney | null,
  meta: Record<string, unknown>,
  entry: EstimatedValueEntry | undefined,
  projection: MobileMessageBillingProjection,
): MobileSdkCostPresentation {
  if (isSdkEstimateMoney(money)) return projection.showSdkEstimate ? 'estimate' : 'hidden';
  if (money?.kind === 'value-estimate') return 'regular';
  const isCustomProviderCost =
    typeof entry?.turnCostIsCustomProvider === 'boolean'
      ? entry.turnCostIsCustomProvider
      : meta.turnCostIsCustomProvider === true
        ? true
        : meta.turnCostIsCustomProvider === false
          ? false
          : undefined;
  if (isCustomProviderCost === true || entry?.excludedActualMoney !== undefined) {
    return projection.showSdkEstimate ? 'estimate' : 'hidden';
  }
  if (isCustomProviderCost === false) return 'regular';
  return projection.presentation;
}

function authoritativeEntryMoney(entry: EstimatedValueEntry | undefined): RemoteMoney | null {
  if (!entry) return null;
  const structured = normalizeRemoteMoney(entry.money);
  if (structured?.amount) return structured;
  return legacyEstimateMoney(entry.costUsd);
}

function entryHasAuthoritativeMoney(entry: EstimatedValueEntry | undefined): boolean {
  return Boolean(entry && (
    Object.prototype.hasOwnProperty.call(entry, 'money') ||
    Object.prototype.hasOwnProperty.call(entry, 'costUsd') ||
    Object.prototype.hasOwnProperty.call(entry, 'excludedActualMoney')
  ));
}

function projectSdkCostMoneyWithBreakdown(
  money: RemoteMoney | null,
  usageDetails: unknown,
  presentation: MobileSdkCostPresentation,
): RemoteMoney | null {
  const projected = projectSdkCostMoney(money, presentation);
  if (projected || presentation !== 'hidden') return projected;
  const perModel = readPerModelMoney(usageDetails);
  if (perModel.length === 0) return null;
  return addCompatibleRemoteMoney(
    perModel.flatMap((entry) => {
      const visible = projectSdkCostMoney(entry, presentation);
      return visible ? [visible] : [];
    }),
  );
}

function projectSdkCostMoney(
  money: RemoteMoney | null,
  presentation: MobileSdkCostPresentation,
): RemoteMoney | null {
  if (!money) return null;
  if (presentation === 'regular') return money;
  if (money.kind === 'value-estimate') {
    return presentation === 'hidden' && isSdkEstimateMoney(money) ? null : money;
  }
  return presentation === 'estimate' ? asSdkEstimateMoney(money) : null;
}

function isSdkEstimateMoney(money: RemoteMoney | null): boolean {
  return money?.estimateReasons?.includes('sdk-estimate') === true;
}

function asSdkEstimateMoney(money: RemoteMoney): RemoteMoney {
  const reasons = (money.estimateReasons ?? []).filter(
    (reason) => reason !== 'subscription-value' && reason !== 'reference-price',
  );
  return {
    ...money,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: [...new Set([...reasons, 'sdk-estimate' as const])],
  };
}

function projectUsageDetails(
  value: unknown,
  presentation: MobileSdkCostPresentation,
): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (presentation === 'regular') return value;
  const details = value as Record<string, unknown>;
  if (!Array.isArray(details.perModelCost)) return value;
  const projected = details.perModelCost.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const money = projectSdkCostMoney(normalizeRemoteMoney(record.money), presentation);
    return money ? [{ ...record, money }] : [];
  });
  const { perModelCost: _perModelCost, ...rest } = details;
  return projected.length > 0 ? { ...rest, perModelCost: projected } : rest;
}

function readPerModelMoney(value: unknown): RemoteMoney[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const list = (value as Record<string, unknown>).perModelCost;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const money = normalizeRemoteMoney((item as Record<string, unknown>).money);
    return money?.amount ? [money] : [];
  });
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function legacyUsdMoney(value: unknown): RemoteMoney | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? {
        amount: value,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      }
    : null;
}

function legacyEstimateMoney(value: unknown): RemoteMoney | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? {
        amount: value,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['legacy-usd', 'subscription-value'],
      }
    : null;
}

function subtractCompatibleRemoteMoney(
  money: RemoteMoney | null,
  excluded: RemoteMoney | null,
): RemoteMoney | null {
  if (!money || money.amount <= 0) return null;
  if (!excluded || excluded.currency !== money.currency) return money;
  const amount = Math.max(0, money.amount - excluded.amount);
  return amount > 0 ? { ...money, amount } : null;
}

function addCompatibleRemoteMoney(
  values: readonly RemoteMoney[],
  preferredCurrency?: RemoteMoney['currency'],
): RemoteMoney | null {
  if (values.length === 0) return null;
  const actualValues = values.filter((value) => value.kind === 'actual-cost');
  const candidates = actualValues.length > 0 ? actualValues : values;
  const currency =
    candidates.find((value) => value.currency === preferredCurrency)?.currency ??
    candidates[0].currency;
  const compatible = values.filter((value) => value.currency === currency);
  if (compatible.length === 0) return null;
  const reasons = uniqueReasons(compatible.flatMap((value) => value.estimateReasons ?? []));
  return {
    amount: compatible.reduce((sum, value) => sum + value.amount, 0),
    currency,
    approximate: compatible.some((value) => value.approximate),
    kind: compatible.some((value) => value.kind === 'actual-cost')
      ? 'actual-cost'
      : 'value-estimate',
    ...(reasons.length > 0 ? { estimateReasons: reasons } : {}),
  };
}

function uniqueReasons(
  reasons: readonly RemoteMoneyEstimateReason[],
): RemoteMoneyEstimateReason[] {
  return [...new Set(reasons)];
}

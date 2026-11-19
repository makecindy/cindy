import { selectCodexUsageForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { providerShareIdOfAgentDeviceId } from '../../shared/providerShare.js';
import type { ProviderShareInsights } from '../../shared/providerShareInsights.js';
import {
  isSubscriptionProvider,
  parseSubscriptionSessionAccountView,
  type SubscriptionCodexUsageBucket,
  type SubscriptionProvider,
  type SubscriptionSessionAccountQuery,
} from '../../shared/subscriptionAccounts.js';
import { SUBSCRIPTION_USAGE_TTL_MS, subscriptionUsageView } from '../subscription-accounts/usageView.js';

interface SessionQuotaRoute {
  providerId: string | null;
  deviceId: string | null;
  remoteHostId: string | null;
  nativeSessionId: string | null;
  modelId?: string | null;
}

export interface SessionQuotaPorts {
  readRoute(sessionId: string): Promise<SessionQuotaRoute | null>;
  readLocal(query: SubscriptionSessionAccountQuery): Promise<unknown>;
  readRemote(deviceId: string, query: SubscriptionSessionAccountQuery): Promise<unknown>;
  readShare(shareId: string): Promise<ProviderShareInsights | null>;
  shareAccessEpoch(shareId: string): number;
  resolveSubscription?(providerId: string, deviceId: string | null): Promise<SubscriptionProvider | null>;
}

const unavailable = { status: 'unavailable' } as const;

function shareQuota(insights: ProviderShareInsights | null) {
  const quota = insights?.quota;
  if (!insights?.capabilities.quota || insights.status.quota !== 'ready'
    || !quota || quota.partial || quota.group || quota.accounts.length !== 1) return unavailable;
  const account = quota.accounts[0];
  if (account.state === 'unlimited') return { status: 'unlimited', source: 'shared' };
  if (account.state !== 'ready' || !account.balance || account.windows.length) return unavailable;
  const now = Date.now();
  const stale = account.updatedAt === null || now - account.updatedAt >= SUBSCRIPTION_USAGE_TTL_MS
    || (account.balance.resetsAt !== null && account.balance.resetsAt <= now);
  return {
    source: 'shared',
    status: stale ? 'stale' : 'available',
    updatedAt: account.updatedAt,
    windows: [],
    balance: {
      remaining: account.balance.remaining, total: account.balance.total,
      unit: account.balance.currency, resetsAt: account.balance.resetsAt,
    },
  };
}

function subscriptionQuota(raw: unknown, provider: SubscriptionProvider, route: SessionQuotaRoute) {
  const view = parseSubscriptionSessionAccountView(raw, provider);
  if (view?.state !== 'bound' || view.routeProviderId !== route.providerId
    || (view.account.status !== 'ready' && view.account.status !== 'limited')) return unavailable;
  const codex = view.account.usage?.codex;
  const bucket = codex && (selectCodexUsageForModel({
    appServerBuckets: codex.buckets, modelId: route.modelId,
  }) as SubscriptionCodexUsageBucket | null);
  const usage = codex ? {
    codex: { ...codex, buckets: bucket ? { codex: bucket } : {} },
  } : view.account.usage;
  const projected = subscriptionUsageView({
    providerId: provider, provider, accountId: '', authenticated: true, usage,
    updatedAt: view.account.usageUpdatedAt,
  }, Date.now());
  const credits = codex?.credits;
  const balance = credits && typeof credits.balance === 'string' && /^\d+(?:\.\d+)?$/.test(credits.balance)
    && Number.isFinite(Number(credits.balance))
    ? { remaining: Number(credits.balance), total: null, unit: 'credits', resetsAt: null } : null;
  if (!projected.windows.length && !balance) return unavailable;
  return {
    source: route.deviceId ? 'device' : 'local',
    status: projected.windows.length ? projected.usageStatus : 'stale',
    updatedAt: projected.updatedAt,
    windows: projected.windows.map(({ id, usedPercent, windowMinutes, resetsAt, updatedAt }) => ({
      kind: id.startsWith('weekly:') ? 'scoped' : id, usedPercent, windowMinutes,
      resetsAt: resetsAt === null ? null : resetsAt * 1000, updatedAt,
    })),
    balance,
  };
}

export async function readSessionQuota(
  sessionId: string, ports: SessionQuotaPorts, assertCurrent: () => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const route = await ports.readRoute(sessionId);
  await assertCurrent();
  if (!route || route.remoteHostId) return unavailable;
  const shareId = providerShareIdOfAgentDeviceId(route.deviceId);
  // The existing share reply does not identify a bound subscription account or
  // model bucket. Cindy AI has one billing balance for the shared connection.
  if (shareId && route.providerId !== 'xd') return unavailable;
  const shareEpoch = shareId ? ports.shareAccessEpoch(shareId) : null;
  let result;
  if (shareId) {
    result = shareQuota(await ports.readShare(shareId));
  } else {
    if (!route.providerId || (route.deviceId && !route.nativeSessionId)) return unavailable;
    const provider = isSubscriptionProvider(route.providerId) ? route.providerId
      : await ports.resolveSubscription?.(route.providerId, route.deviceId);
    await assertCurrent();
    if (!provider) return unavailable;
    const query = { action: 'session' as const, providerId: provider,
      routeProviderId: route.providerId, nativeSessionId: route.nativeSessionId ?? undefined,
      ...(route.deviceId ? {} : { sessionId }),
    };
    const response = route.deviceId ? await ports.readRemote(route.deviceId, query) : await ports.readLocal(query);
    result = subscriptionQuota(response, provider, route);
  }
  const latest = await ports.readRoute(sessionId);
  await assertCurrent();
  if (shareId && ports.shareAccessEpoch(shareId) !== shareEpoch) return unavailable;
  if (!latest || latest.providerId !== route.providerId || latest.deviceId !== route.deviceId
    || latest.nativeSessionId !== route.nativeSessionId || latest.remoteHostId !== route.remoteHostId
    || latest.modelId !== route.modelId) return unavailable;
  return result;
}

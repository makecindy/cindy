import type { ProviderView } from '@cindy/model-providers';
import type { ProviderShareQuotaAccount } from '../../shared/providerShareInsights.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getAuthState } from '../authManager.js';
import { projectModelAccessCreditUsage } from '../billing/projection.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { codexSource, claudeSource, xaiSource } from '../menubar/collect.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { invokeProviderManagement } from '../provider-group/managementClient.js';
import { readProviderGroup } from '../provider-group/store.js';
import { serverApiFetch } from '../serverApiClient.js';
import {
  readClaudeAccountUsageSnapshot,
  readClaudeAccountQuotaClear,
  triggerClaudeAccountUsageRefresh,
} from '../usage/claudeAccountUsage.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  readClaudeSubscriptionUsageSnapshotForDeviceLink,
  readXaiSubscriptionUsageSnapshotForDeviceLink,
  readCodexRateLimitsForHost,
} from '../maker-ipc/usage.js';
import { remoteBackgroundInvoke } from './index.js';

const FRESH_MS = 30_000;
const empty = (state: ProviderShareQuotaAccount['state']): ProviderShareQuotaAccount => ({
  state,
  updatedAt: null,
  windows: [],
  balance: null,
});
let cacheOwner = '';
const cache = new Map<string, { until: number; pending: Promise<ProviderShareQuotaAccount> }>();

async function readAccount(provider: ProviderView): Promise<ProviderShareQuotaAccount> {
  if (!provider.connected || provider.removed || provider.suspended) return empty('unavailable');
  const source = providerWeeklyQuotaSource(provider);
  if (source) {
    const now = Date.now();
    const value =
      source === 'claude'
        ? claudeSource(
            provider,
            await readClaudeSubscriptionUsageSnapshotForDeviceLink(provider.id),
            now,
          )
        : source === 'xai'
          ? xaiSource(
              provider,
              await readXaiSubscriptionUsageSnapshotForDeviceLink(provider.id),
              now,
            )
          : codexSource(
              provider,
              (await readCodexRateLimitsForHost(provider.id))?.rateLimits ?? null,
              now,
            );
    const windows = value.windows.map((window) => ({
      kind: window.kind,
      label: window.label ?? null,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      resetsAt: window.resetsAtMs,
      windowMinutes: window.windowMinutes,
    }));
    return {
      state: windows.length ? 'ready' : 'unavailable',
      updatedAt: value.updatedAtMs,
      windows,
      balance: null,
    };
  }
  if (provider.id !== 'xd') return empty('unsupported');
  const auth = getAuthState();
  if (auth.mode === 'cloud' && auth.user?.membershipKind === 'personal') {
    const usage = projectModelAccessCreditUsage(
      await serverApiFetch<unknown>('/api/model-access/credit-usage', {
        timeoutMs: 20_000,
        redactErrorDetails: true,
        baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      }),
    );
    const pools = (['plan', 'purchased', 'promotional'] as const).map((kind) => ({
      kind,
      remaining: Number(usage[kind].remaining),
      total: usage[kind].total === null ? null : Number(usage[kind].total),
    }));
    return {
      state: 'ready',
      updatedAt: Date.parse(usage.observedAt),
      windows: [],
      balance: {
        remaining: Number(usage.available),
        total: pools.every((pool) => pool.total !== null)
          ? pools.reduce((sum, pool) => sum + pool.total!, 0)
          : null,
        currency: CURRENT_CINDY_REGION === 'cn' ? 'CNY' : 'USD',
        resetsAt: null,
        pools,
      },
    };
  }
  await triggerClaudeAccountUsageRefresh(false);
  const snapshot = readClaudeAccountUsageSnapshot();
  if (!snapshot)
    return empty(
      readClaudeAccountQuotaClear()?.quotaState === 'unlimited' ? 'unlimited' : 'unavailable',
    );
  return {
    state: 'ready',
    updatedAt: snapshot.fetchedAt,
    windows: [],
    balance: {
      remaining: Math.max(0, snapshot.maxBudget - snapshot.spend),
      total: snapshot.maxBudget,
      currency: snapshot.currency,
      resetsAt: snapshot.budgetResetAt ? Date.parse(snapshot.budgetResetAt) : null,
      pools: [],
    },
  };
}

export async function readProviderShareQuotaAccount(
  providerId: string,
): Promise<ProviderShareQuotaAccount> {
  const assertCurrent = captureProviderManagementScope();
  const provider = (
    await getDesktopProviderService().listProviders({ allowSideEffects: false })
  ).find((item) => item.id === providerId);
  assertCurrent();
  if (!provider) return empty('unavailable');
  const owner = activeOwnerScopeKey();
  if (owner !== cacheOwner) {
    cacheOwner = owner;
    cache.clear();
  }
  const key = JSON.stringify(provider);
  for (const [entry, value] of cache) if (value.until <= Date.now()) cache.delete(entry);
  let pending = cache.get(key);
  if (!pending) {
    pending = {
      until: Date.now() + FRESH_MS,
      pending: readAccount(provider).catch(() => empty('unavailable')),
    };
    cache.set(key, pending);
  }
  const result = await pending.pending;
  assertCurrent();
  const latest = (
    await getDesktopProviderService().listProviders({ allowSideEffects: false })
  ).find((item) => item.id === providerId);
  assertCurrent();
  return JSON.stringify(latest) === key ? result : empty('unavailable');
}

async function readGroupQuota(providerId: string) {
  const assertCurrent = captureProviderManagementScope();
  const group = readProviderGroup(providerId);
  if (!group)
    return {
      group: false,
      partial: false,
      accounts: [await readProviderShareQuotaAccount(providerId)],
    };
  const accounts: ProviderShareQuotaAccount[] = [];
  const ownMembers = group.members.filter((member) => member.kind !== 'share');
  for (let offset = 0; offset < ownMembers.length; offset += 3) {
    assertCurrent();
    accounts.push(
      ...(await Promise.all(
        ownMembers.slice(offset, offset + 3).map(async (member) => {
          if (member.kind === 'local' || !member.agentDeviceId)
            return readProviderShareQuotaAccount(member.providerId);
          try {
            const raw = (await invokeProviderManagement(
              remoteBackgroundInvoke,
              member.agentDeviceId,
              {
                action: 'manage-share',
                command: { action: 'quota-account', providerId: member.providerId },
              },
            )) as ProviderShareQuotaAccount;
            return sanitizeQuotaAccount(raw);
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            return empty(
              /UNSUPPORTED_CAPABILITY|CHANNEL_NOT_ALLOWED/.test(message)
                ? 'needs-update'
                : /OFFLINE|NOT_CONNECTED|LINK_NOT_OPEN/.test(message)
                  ? 'offline'
                  : 'unavailable',
            );
          }
        }),
      )),
    );
  }
  assertCurrent();
  if (JSON.stringify(group) !== JSON.stringify(readProviderGroup(providerId)))
    throwIpcError('PRECONDITION_FAILED', 'Provider group changed');
  return { group: true, partial: ownMembers.length !== group.members.length, accounts };
}

function sanitizeQuotaAccount(raw: ProviderShareQuotaAccount): ProviderShareQuotaAccount {
  if (
    !raw ||
    !['ready', 'unsupported', 'unavailable', 'offline', 'needs-update', 'unlimited'].includes(
      raw.state,
    ) ||
    !Array.isArray(raw.windows)
  )
    return empty('unavailable');
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const balance = raw.balance;
  return {
    state: raw.state,
    updatedAt: finite(raw.updatedAt) ? raw.updatedAt : null,
    windows: raw.windows
      .slice(0, 32)
      .filter(
        (window) =>
          window &&
          ['session', 'week', 'scoped'].includes(window.kind) &&
          finite(window.remainingPercent),
      )
      .map((window) => ({
        kind: window.kind,
        label: typeof window.label === 'string' ? window.label.slice(0, 128) : null,
        remainingPercent: Math.min(100, Math.max(0, window.remainingPercent)),
        resetsAt: finite(window.resetsAt) ? window.resetsAt : null,
        windowMinutes: finite(window.windowMinutes) ? window.windowMinutes : null,
      })),
    balance:
      balance && finite(balance.remaining) && ['USD', 'CNY'].includes(balance.currency)
        ? {
            remaining: balance.remaining,
            total: finite(balance.total) ? balance.total : null,
            currency: balance.currency,
            resetsAt: finite(balance.resetsAt) ? balance.resetsAt : null,
            pools: Array.isArray(balance.pools)
              ? balance.pools
                  .slice(0, 3)
                  .filter(
                    (pool) =>
                      pool &&
                      ['plan', 'purchased', 'promotional'].includes(pool.kind) &&
                      finite(pool.remaining),
                  )
                  .map((pool) => ({
                    kind: pool.kind,
                    remaining: pool.remaining,
                    total: finite(pool.total) ? pool.total : null,
                  }))
              : [],
          }
        : null,
  };
}

/** 同一账号/组配置共享在途与短缓存，受邀者人数不会放大组内查询频率。 */
const groupCache = new Map<string, { until: number; pending: ReturnType<typeof readGroupQuota> }>();
let groupCacheOwner = '';
export async function readProviderShareQuota(providerId: string) {
  const assertCurrent = captureProviderManagementScope();
  const owner = activeOwnerScopeKey();
  if (owner !== groupCacheOwner) {
    groupCacheOwner = owner;
    groupCache.clear();
  }
  const config = JSON.stringify(readProviderGroup(providerId));
  const key = JSON.stringify([providerId, config]);
  for (const [entry, value] of groupCache) if (value.until <= Date.now()) groupCache.delete(entry);
  let cached = groupCache.get(key);
  if (!cached) {
    const pending = readGroupQuota(providerId);
    cached = { until: Infinity, pending };
    groupCache.set(key, cached);
    const entry = cached;
    void pending.then(
      () => {
        entry.until = Date.now() + 15_000;
      },
      () => {
        if (groupCache.get(key) === entry) groupCache.delete(key);
      },
    );
  }
  const result = await cached.pending;
  assertCurrent();
  if (config !== JSON.stringify(readProviderGroup(providerId)))
    throwIpcError('PRECONDITION_FAILED', 'Provider group changed');
  return result;
}

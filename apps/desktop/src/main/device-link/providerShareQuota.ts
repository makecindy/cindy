import type { ProviderView } from '@cindy/model-providers';
import { MetadataContinuityReader } from '@cindy/device-link';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import { MAX_PROVIDER_SHARE_QUOTA_ACCOUNTS } from '../../shared/providerShareInsights.js';
import type {
  ProviderShareQuotaAccount,
  ProviderShareQuotaAccountResult,
} from '../../shared/providerShareInsights.js';
import {
  MAX_SUBSCRIPTION_ACCOUNTS,
} from '../../shared/subscriptionAccounts.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { pluginEngineKeyFromProviderId } from '../../shared/pluginEngines.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getAuthState } from '../authManager.js';
import { projectModelAccessCreditUsage } from '../billing/projection.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readPluginEnginePrefs } from '../maker-host/plugin-engine-prefs-store.js';
import { codexSource, claudeSource, xaiSource } from '../menubar/collect.js';
import { readPluginEnginePoolAccountUsages } from '../plugin-engine-accounts/runtime.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { invokeProviderManagement } from '../provider-group/managementClient.js';
import { readProviderGroup } from '../provider-group/store.js';
import { readSubscriptionPoolAccountUsages } from '../subscription-accounts/runtime.js';
import type { CodexAccountUsagePayload } from '../usageBroadcaster.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
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
const GROUP_FRESH_MS = 15_000;
/** Short cache on transient unavailable results: still coalesces burst reads without stalling recovery. */
const UNAVAILABLE_CACHE_MS = 3_000;
const WEEK_MINUTES = 7 * 24 * 60;
const SESSION_MAX_MINUTES = 6 * 60;
const empty = (state: ProviderShareQuotaAccount['state']): ProviderShareQuotaAccount => ({
  state,
  updatedAt: null,
  windows: [],
  balance: null,
});
// Reuse bounded metadata storage/single-flight, with display-specific ages and
// no stale-on-failure fallback. Never used for execution permission or quota admission.
const quotaReader = new MetadataContinuityReader({ retryable: () => false });
let quotaScope: { key: string } | undefined;
function captureQuotaScope() {
  const assertOwner = captureProviderManagementScope();
  const scopeKey = () => JSON.stringify([activeOwnerScopeKey(),
    getClientEndpoint('deviceLinkApiBaseUrl'), getClientEndpoint('modelAccessApiBaseUrl')]);
  const key = scopeKey();
  if (quotaScope?.key !== key) { quotaReader.clear(); quotaScope = { key }; }
  const identity = quotaScope;
  const assertCurrent = () => {
    assertOwner();
    if (quotaScope !== identity || scopeKey() !== key) throwIpcError('PRECONDITION_FAILED', 'Quota display scope changed');
  };
  return { key, current: () => { try { assertCurrent(); return true; } catch { return false; } },
    signalingAvailable: () => true, assertCurrent };
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function pluginWindowKind(label: string, windowMinutes?: number): 'session' | 'week' | 'scoped' {
  if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    if (windowMinutes >= WEEK_MINUTES) return 'week';
    if (windowMinutes <= SESSION_MAX_MINUTES) return 'session';
    return 'scoped';
  }
  if (/\b(?:week|weekly|7\s*d)\b/i.test(label)) return 'week';
  if (/\b(?:5\s*h|session)\b/i.test(label)) return 'session';
  return 'scoped';
}

function pluginEngineQuotaAccount(
  usage: GhostHarnessUsage | null,
  now: number,
): ProviderShareQuotaAccount {
  if (!usage) return empty('unavailable');
  const windows = (usage.windows ?? [])
    .filter(
      (row) =>
        typeof row.remainingPercent === 'number' &&
        Number.isFinite(row.remainingPercent) &&
        (row.resetsAt === undefined || (validTimestamp(row.resetsAt) && row.resetsAt > now)),
    )
    .slice(0, 32)
    .map((row) => ({
      kind: pluginWindowKind(row.label, row.windowMinutes),
      label: typeof row.label === 'string' && row.label.trim() ? row.label.slice(0, 128) : null,
      remainingPercent: Math.min(100, Math.max(0, row.remainingPercent)),
      resetsAt: validTimestamp(row.resetsAt) ? row.resetsAt : null,
      windowMinutes:
        typeof row.windowMinutes === 'number' && Number.isFinite(row.windowMinutes)
          ? row.windowMinutes
          : null,
    }));
  const balanceRow = (usage.balances ?? []).find(
    (row) => (row.currency === 'USD' || row.currency === 'CNY') && Number.isFinite(Number(row.amount)),
  );
  const balance = balanceRow
    ? {
        remaining: Number(balanceRow.amount),
        total: null,
        currency: balanceRow.currency as 'USD' | 'CNY',
        resetsAt: null,
        pools: [],
      }
    : null;
  const ready = windows.length > 0 || balance !== null;
  return {
    state: ready ? 'ready' : 'unavailable',
    updatedAt: ready && validTimestamp(usage.updatedAt) ? usage.updatedAt : null,
    windows,
    balance,
  };
}

function pluginEngineSuspended(providerId: string): boolean {
  const key = pluginEngineKeyFromProviderId(providerId);
  if (!key) return false;
  if (readPluginEnginePrefs(key).suspended === true) return true;
  const tilde = key.indexOf('~');
  return tilde > 0 && readPluginEnginePrefs(key.slice(0, tilde)).suspended === true;
}

async function readPluginEngineQuotaAccounts(
  providerId: string,
): Promise<ProviderShareQuotaAccount[]> {
  const assertCurrent = captureProviderManagementScope();
  if (pluginEngineSuspended(providerId)) return [empty('unavailable')];
  const entries = await readPluginEnginePoolAccountUsages(providerId);
  assertCurrent();
  if (pluginEngineSuspended(providerId)) return [empty('unavailable')];
  if (entries === 'unsupported') return [empty('unsupported')];
  if (!entries || entries.length === 0) return [empty('unavailable')];
  const now = Date.now();
  return entries.map((entry) => pluginEngineQuotaAccount(entry.usage, now));
}

function windowsAccount(value: ReturnType<typeof claudeSource>): ProviderShareQuotaAccount {
  const windows = value.windows.filter((window) => window.kind !== 'period').map((window) => ({
    kind: window.kind as 'session' | 'week' | 'scoped',
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

async function readAccount(provider: ProviderView): Promise<ProviderShareQuotaAccount> {
  if (!provider.connected || provider.removed || provider.suspended) return empty('unavailable');
  const source = providerWeeklyQuotaSource(provider);
  // Kimi and OpenCode Go account usage is only exposed to the owner, not through provider sharing.
  if (source === 'kimi' || source === 'opencode-go') return empty('unsupported');
  if (source) {
    const now = Date.now();
    if (source === 'claude') {
      let value = claudeSource(
        provider,
        await readClaudeSubscriptionUsageSnapshotForDeviceLink(provider.id),
        now,
      );
      // Cached-first reads return null/expired while a background refresh is in flight; wait once
      // through the reader's adaptive throttle & backoff rather than replying unavailable.
      if (value.windows.length === 0) {
        value = claudeSource(
          provider,
          await readClaudeSubscriptionUsageSnapshotForDeviceLink(provider.id, { fresh: true }),
          Date.now(),
        );
      }
      return windowsAccount(value);
    }
    const value =
      source === 'xai'
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
    return windowsAccount(value);
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
  if (pluginEngineKeyFromProviderId(providerId)) {
    const accounts = await readPluginEngineQuotaAccounts(providerId);
    return accounts[0] ?? empty('unavailable');
  }
  const scope = captureQuotaScope();
  const { assertCurrent } = scope;
  const provider = (
    await getDesktopProviderService().listProviders({ allowSideEffects: false })
  ).find((item) => item.id === providerId);
  assertCurrent();
  if (!provider) return empty('unavailable');
  const key = JSON.stringify(provider);
  const { value: result } = await quotaReader.read(
    {
      ...scope,
      freshForMs: FRESH_MS,
      validForMs: FRESH_MS,
      remainingTrustMs: (value) =>
        (value as ProviderShareQuotaAccount).state === 'unavailable' ? UNAVAILABLE_CACHE_MS : FRESH_MS,
    },
    `account:${key}`,
    () => readAccount(provider).catch(() => empty('unavailable')),
  ).catch((error) => {
    assertCurrent();
    throw error;
  });
  assertCurrent();
  const latest = (
    await getDesktopProviderService().listProviders({ allowSideEffects: false })
  ).find((item) => item.id === providerId);
  assertCurrent();
  return JSON.stringify(latest) === key ? result : empty('unavailable');
}

/**
 * A subscription account pool lists each assignable signed-in account's own quota snapshot.
 * Only hosts without a pool use the provider's compatibility reader.
 */
export async function readProviderShareQuotaAccounts(
  providerId: string,
): Promise<ProviderShareQuotaAccount[]> {
  if (pluginEngineKeyFromProviderId(providerId)) {
    return readPluginEngineQuotaAccounts(providerId);
  }
  const assertCurrent = captureProviderManagementScope();
  const pooled = await readSubscriptionPoolAccountUsages(providerId);
  assertCurrent();
  if (pooled === undefined)
    return [await readProviderShareQuotaAccount(providerId)];
  const provider = (
    await getDesktopProviderService().listProviders({ allowSideEffects: false })
  ).find((item) => item.id === providerId);
  assertCurrent();
  if (!provider?.connected || provider.removed || provider.suspended)
    return [empty('unavailable')];
  if (pooled.length === 0) return [empty('unavailable')];
  const now = Date.now();
  return pooled.map((entry) => {
    const isClaude = 'kind' in entry && entry.kind
      ? entry.kind === 'anthropic'
      : providerWeeklyQuotaSource(provider) === 'claude';
    return windowsAccount(
      isClaude
        ? claudeSource(provider, entry.usage?.claudeUsage ?? null, now)
        : // Pool buckets omit windows without a percentage; codexSource skips those.
          codexSource(provider, (entry.usage?.codexUsage ?? null) as unknown as CodexAccountUsagePayload | null, now),
    );
  });
}

async function readGroupQuota(providerId: string) {
  const assertCurrent = captureProviderManagementScope();
  const group = readProviderGroup(providerId);
  if (!group) {
    const accounts = await readProviderShareQuotaAccounts(providerId);
    return { group: accounts.length > 1, partial: false, accounts };
  }
  const accounts: ProviderShareQuotaAccount[] = [];
  const ownMembers = group.members.filter((member) => member.kind !== 'share');
  for (let offset = 0; offset < ownMembers.length; offset += 3) {
    assertCurrent();
    accounts.push(
      ...(await Promise.all(
        ownMembers.slice(offset, offset + 3).map(async (member) => {
          if (member.kind === 'local' || !member.agentDeviceId)
            return readProviderShareQuotaAccounts(member.providerId);
          try {
            const raw = (await invokeProviderManagement(
              remoteBackgroundInvoke,
              member.agentDeviceId,
              {
                action: 'manage-share',
                command: { action: 'quota-account', providerId: member.providerId },
              },
            )) as ProviderShareQuotaAccountResult;
            // Older computers return only their default account.
            return Array.isArray(raw?.accounts) && raw.accounts.length > 0
              ? raw.accounts.slice(0, MAX_SUBSCRIPTION_ACCOUNTS).map(sanitizeQuotaAccount)
              : [sanitizeQuotaAccount(raw)];
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            return [
              empty(
                /UNSUPPORTED_CAPABILITY|CHANNEL_NOT_ALLOWED/.test(message)
                  ? 'needs-update'
                  : /OFFLINE|NOT_CONNECTED|LINK_NOT_OPEN/.test(message)
                    ? 'offline'
                    : 'unavailable',
              ),
            ];
          }
        }),
      )).flat(),
    );
  }
  assertCurrent();
  if (JSON.stringify(group) !== JSON.stringify(readProviderGroup(providerId)))
    throwIpcError('PRECONDITION_FAILED', 'Provider group changed');
  // Keep the existing v1 receiver limit, including for older recipients.
  return {
    group: true,
    partial:
      ownMembers.length !== group.members.length ||
      accounts.length > MAX_PROVIDER_SHARE_QUOTA_ACCOUNTS,
    accounts: accounts.slice(0, MAX_PROVIDER_SHARE_QUOTA_ACCOUNTS),
  };
}

/** Group owners read this from member computers. The first account stays at the top level so
 * older owners keep showing one account; newer owners list every pooled account. */
export async function readProviderShareQuotaAccountResult(
  providerId: string,
): Promise<ProviderShareQuotaAccountResult> {
  const accounts = await readProviderShareQuotaAccounts(providerId);
  return accounts.length > 1 ? { ...accounts[0], accounts } : accounts[0];
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
export async function readProviderShareQuota(providerId: string) {
  const scope = captureQuotaScope();
  const { assertCurrent } = scope;
  const config = JSON.stringify(readProviderGroup(providerId));
  const key = JSON.stringify([providerId, config]);
  const { value: result } = await quotaReader.read(
    {
      ...scope,
      freshForMs: GROUP_FRESH_MS,
      validForMs: GROUP_FRESH_MS,
      remainingTrustMs: (value) =>
        (value as { accounts: ProviderShareQuotaAccount[] }).accounts.some(
          (account) => account.state === 'unavailable',
        )
          ? UNAVAILABLE_CACHE_MS
          : GROUP_FRESH_MS,
    },
    `group:${key}`,
    () => readGroupQuota(providerId),
  ).catch((error) => {
    assertCurrent();
    throw error;
  });
  assertCurrent();
  if (config !== JSON.stringify(readProviderGroup(providerId)))
    throwIpcError('PRECONDITION_FAILED', 'Provider group changed');
  return result;
}

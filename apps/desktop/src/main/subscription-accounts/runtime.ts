import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { getCodexHome } from '../maker-host/codex-home-path.js';
import { mkdir, readFile } from 'node:fs/promises';
import { type AuthState, type NativeSubscriptionAccount } from '@cindy/maker-core';
import { matchScopedWindowForModel } from '@cindy/maker-shared/subscription-usage';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderAuthSharedSystemCredential,
} from '../maker-host/nativeProviderAuthBinding.js';
import { pickProviderGroupMember, providerGroupMembersFull } from '../provider-group/scheduler.js';
import { concurrencyLimitPatch, effectiveConcurrencyLimit } from '../../shared/providerGroup.js';
import { providerGroupMemberUsageState } from '../provider-group/usage.js';
import {
  coolingScope,
  currentCooling,
  PROVIDER_GROUP_COOLING_SCOPE_CAP,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
} from '../provider-group/cooling.js';
import { clearSubscriptionAccountCooling, readSubscriptionAccountCooling, writeSubscriptionAccountCooling } from '../provider-group/coolingStore.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_LOCAL_PROVISIONAL_MS } from '../provider-group/router.js';
import { decideProviderGroupFailure, providerGroupFailureSignals } from '../provider-group/failurePolicy.js';
import { readTurnUsageResetAt } from '../goal-host/usageLimit.js';
import { providerGroupCodexUsageFromReads } from '../provider-group/usage.js';
import { providerGroupCodexUsageSnapshot } from '../provider-group/usage.js';
import { codexLimitBucketKey } from '@cindy/maker-shared/codex-usage-buckets';
import {
  mergeClaudeSubscriptionUsageSnapshot,
  mergeClaudeSubscriptionUsageDuringRead,
  parseClaudeSdkRateLimitInfo,
} from '../../shared/claudeSubscriptionUsage.js';
import type {
  SubscriptionAccountCommand,
  SubscriptionAccountUsage,
  SubscriptionProvider,
  SubscriptionPoolView,
  SubscriptionSessionAccountView,
} from '../../shared/subscriptionAccounts.js';
import {
  DEFAULT_SUBSCRIPTION_ACCOUNT,
  MAX_SUBSCRIPTION_ACCOUNTS,
  parseSubscriptionSessionAccountView,
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  CODEX_POOL_RESET_PREFIX,
  codexResetScope,
} from '../../shared/subscriptionAccounts.js';
import type { CodexRateLimitResetServiceDeps } from '../usage/codexRateLimitReset.js';
import {
  accountDirectory,
  accountOwnerPrefix,
  defaultPool,
  readPool,
  readLegacyCodexAccountId,
  readLegacyCodexProviderId,
  readAccountBinding,
  readProviderBoundAccountIds,
  readBoundSubscriptionAccountIds,
  updatePool as updateStoredPool,
  writeAccountBindings,
} from './store.js';
import { legacyCodexAccountCanRun, subscriptionRouteAllowsModel } from './legacyAccountAccess.js';
import {
  accountOwnProvider,
  accountProviderId,
  accountSiblings,
  createSubscriptionProvider,
  deleteCreatedSubscriptionProvider,
  discardUnusedSubscriptionAccountPlacement,
  pinnedOwnAccount,
  placeSubscriptionAccount,
  providerAccounts,
  readProviderStrategy,
  renameCreatedSubscriptionProvider,
  resolveSubscriptionPoolProvider,
  writeProviderStrategy,
  type SubscriptionPoolProviderRef,
} from './placement.js';
import {
  loginNativeAccount,
  readNativeAccount,
  readNativeAccountUsage,
  readNativeCodexTokens,
  readLegacyCodexAccount,
  loginLegacyCodexAccount,
  readLegacyCodexProviderAccount,
  loginLegacyCodexProviderAccount,
  codexAccountRpc,
} from './nativeCli.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { mapCodexAppServerModelsToCatalog, mapCodexModelsToCatalog } from '../maker-host/codexModelMapping.js';
import type { CatalogModel } from '@cindy/model-providers';
import type { CodexModelListItem } from '@cindy/maker-core';

const log = desktopMakerLogger.child('subscription-accounts');

/** 成功快照的复用窗口。 */
const ACCOUNT_SNAPSHOT_TTL_MS = 30_000;
/**
 * 读取失败只复用这么短：一次读不到**不是**「已登出」或「不可用」的证据。官方 CLI 冷启动、
 * app-server 抢占、owner 边界都可能让重启后的第一次读失败，按成功快照一样缓存 30 秒会把
 * 启动瞬间的一次抖动变成半分钟发不出去(2026-11-12 实测：OpenAI 池里第一个账号额度用尽时，
 * 第二个有额度的账号也被判不可用，整池无账号可选)。并发读取仍由 `state.flights` 合并，
 * 缩短失败窗口不会反复 spawn CLI。
 */
const ACCOUNT_SNAPSHOT_FAILURE_TTL_MS = 3_000;
// A broken CLI must not keep a provider read spawning fresh RPC processes.
const CODEX_MODEL_MAX_PAGES = 10;
const CODEX_MODEL_MAX_ITEMS = 1_000;

type Usage = {
  claudeUsage?: ReturnType<typeof parseClaudeSdkRateLimitInfo>;
  codexUsage?: ReturnType<typeof providerGroupCodexUsageFromReads>;
  codexCredits?: NonNullable<SubscriptionAccountUsage['codex']>['credits'];
  codexPlan?: string;
};
interface AccountSnapshot {
  auth: AuthState & { plan?: string; loginExpiresAt?: string };
  usage?: Usage;
  unavailable?: boolean;
  at: number;
  usageAt?: number;
}
interface OwnerRuntime {
  owner: string;
  cache: Map<string, AccountSnapshot>;
  flights: Map<string, { promise: Promise<AccountSnapshot>; forceUsage: boolean }>;
  running: Map<string, Set<string>>;
  /** Pending reassignments still require admission after an abandoned reservation expires. */
  pendingStarts: Map<string, { accountId: string; token: string; until: number }>;
  /** Keyed by the provider that owns the picked accounts (subscription-account placement). */
  lastPicked: Map<string, string>;
  logins: Map<string, { abort: AbortController; accountId: string }>;
  invalidated: Map<string, { token: string; reason: string }>;
  /** Actual account failures outrank optimistic cached quota for new assignments. */
  quotaCooling: Map<string, Record<string, number>>;
  codexModels: Map<string, { auth: AccountSnapshot['auth']; models: CatalogModel[]; failedAt?: number }>;
  codexModelFlights: Map<string, { promise: Promise<void>; forced: boolean }>;
  codexCatalogs?: Map<string, readonly CatalogModel[]>;
  publishedCodexCatalog?: Record<string, readonly CatalogModel[] | null> | null;
  defaultCodexAuthEpoch: number;
}
let runtime: OwnerRuntime | undefined;
const listeners = new Set<(providerId: SubscriptionProvider, resetAccountId?: string) => void>();
const codexModelListeners = new Set<() => void>();
/** Synchronous capability invalidation; listeners read the newly committed union. */
export function onSubscriptionPoolCodexModelsChanged(listener: () => void): () => void {
  codexModelListeners.add(listener);
  return () => { codexModelListeners.delete(listener); };
}
function publishCodexCatalogChange(state: OwnerRuntime): void {
  if (state !== runtime || state.owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return;
  const pool = readPool('openai');
  const providers = new Set(['openai', ...pool?.accounts.map(account => accountProviderId('openai', account.id)) ?? []]);
  const models = pool ? Object.fromEntries([...providers].sort().map(providerId =>
    [providerId, readSubscriptionPoolCodexModels(providerId)])) : null;
  if (isDeepStrictEqual(state.publishedCodexCatalog ?? null, models)) return;
  state.publishedCodexCatalog = models;
  for (const listener of codexModelListeners) {
    try { listener(); } catch { /* A view cannot invalidate a completed model read. */ }
  }
}
export function onSubscriptionAccountsChanged(
  listener: (providerId: SubscriptionProvider, resetAccountId?: string) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(provider: SubscriptionProvider, resetAccountId?: string) {
  if (provider === 'openai') publishCodexCatalogChange(currentRuntime());
  for (const listener of listeners) {
    try {
      listener(provider, resetAccountId);
    } catch {
      /* Views cannot invalidate a completed account operation. */
    }
  }
}
function currentRuntime(): OwnerRuntime {
  const owner = activeOwnerScopeKey();
  if (runtime?.owner !== owner) {
    for (const login of runtime?.logins.values() ?? []) login.abort.abort();
    runtime = {
      owner,
      cache: new Map(),
      flights: new Map(),
      running: new Map(),
      pendingStarts: new Map(),
      lastPicked: new Map(),
      logins: new Map(),
      invalidated: new Map(),
      quotaCooling: loadCooling(),
      codexModels: new Map(),
      codexModelFlights: new Map(),
      defaultCodexAuthEpoch: 0,
    };
  }
  expirePendingStarts(runtime);
  return runtime;
}
const keyOf = (provider: SubscriptionProvider, id: string) => `${provider}:${id}`;
function expirePendingStarts(state: OwnerRuntime): void {
  for (const [key, pending] of state.pendingStarts) {
    if (pending.until > Date.now()) continue;
    const provider = key.slice(0, key.indexOf(':')) as SubscriptionProvider;
    if (state.running.get(keyOf(provider, pending.accountId))?.delete(pending.token)) changed(provider);
    // Keep the task's admission marker until takeover: an expired reassignment
    // must not use the ordinary existing-task exemption to exceed the limit.
  }
}
/** Persisted like provider group cooling, so a restart does not first retry a failed account. */
function loadCooling(): Map<string, Record<string, number>> {
  const loaded = new Map<string, Record<string, number>>();
  try {
    const now = Date.now();
    for (const [provider, accounts] of Object.entries(readSubscriptionAccountCooling())) {
      if (provider !== 'anthropic' && provider !== 'openai') continue;
      for (const [id, value] of Object.entries(accounts)) {
        const scopes = currentCooling(value, now);
        if (Object.keys(scopes).length) loaded.set(keyOf(provider, id), scopes);
      }
    }
  } catch {
    /* Cooling is an optimization; an unreadable file must not block assignment. */
  }
  return loaded;
}
function persistCooling(state: OwnerRuntime): void {
  if (state.owner !== activeOwnerScopeKey()) return;
  const cooling: Record<string, Record<string, Record<string, number>>> = {};
  for (const [key, scopes] of state.quotaCooling) {
    const split = key.indexOf(':');
    (cooling[key.slice(0, split)] ??= {})[key.slice(split + 1)] = scopes;
  }
  void writeSubscriptionAccountCooling(cooling);
}
function accountCooling(state: OwnerRuntime, provider: SubscriptionProvider, id: string, model?: string): boolean {
  const key = keyOf(provider, id);
  const scopes = currentCooling(state.quotaCooling.get(key), Date.now());
  if (Object.keys(scopes).length) state.quotaCooling.set(key, scopes);
  else state.quotaCooling.delete(key);
  const scope = coolingScope(provider === 'openai' ? model?.replace(/^chatgpt\//, '') : model);
  return Boolean(scopes[''] || scopes[scope]);
}
function legacyCodexDefault(provider: SubscriptionProvider): boolean {
  if (provider !== 'openai') return false;
  const pool = readPool(provider);
  return pool
    ? pool.legacyCodexDefault === true
    : isNativeProviderAuthBound(provider) && !isNativeProviderAuthSharedSystemCredential(provider);
}
function directoryFor(provider: SubscriptionProvider, id: string): string {
  return id === 'default' && legacyCodexDefault(provider)
    ? getCodexHome()
    : accountDirectory(provider, id);
}

/** Resolve only a saved account of this owner. Default/legacy connections retain their adapters. */
export function pooledCodexResetTarget(scope: string): (CodexRateLimitResetServiceDeps & { refresh(): Promise<void> }) | null {
  if (!scope.startsWith(CODEX_POOL_RESET_PREFIX)) return null;
  const id = scope.slice(CODEX_POOL_RESET_PREFIX.length);
  // The old target must remain the sole lock/settings owner of an imported connection.
  if (readLegacyCodexProviderId(id)) throw new Error('PRECONDITION_FAILED: Use the original account connection');
  const state = currentRuntime();
  const directory = directoryFor('openai', id);
  const assertCurrent = () => {
    assertOwner(state);
    const pool = readPool('openai');
    // Turning off the built-in provider affects only its own accounts (2026-11-13).
    if (!pool || disconnectedFor(pool, 'openai', id) || id === 'default' || !pool.accounts.some(a => a.id === id)
      || directoryFor('openai', id) !== directory
      || state.invalidated.has(keyOf('openai', id))
      || [...state.logins].some(([key, login]) => key.startsWith('openai:') && login.accountId === id))
      throw new Error('PRECONDITION_FAILED: Subscription account unavailable');
  };
  assertCurrent();
  let credentialCurrent = () => false;
  const readAccountIdentity = async () => {
    assertCurrent();
    const auth = await readNativeAccount('openai', directory);
    const tokens = await readNativeCodexTokens(directory);
    assertCurrent();
    if (!auth.authenticated || !auth.identity || !tokens.canDispatch())
      throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
    credentialCurrent = tokens.canDispatch;
    return { email: auth.identity, accountId: tokens.chatgptAccountId };
  };
  return {
    readAccountIdentity,
    readRateLimits: async () => {
      assertCurrent();
      const result = await codexAccountRpc(directory, 'account/rateLimits/read', {});
      assertCurrent();
      return result as Awaited<ReturnType<CodexRateLimitResetServiceDeps['readRateLimits']>>;
    },
    consumeResetCredit: async params => {
      // Re-check membership after the reset service has revalidated its account-bound offer.
      assertCurrent();
      const credential = credentialCurrent;
      const canDispatch = () => {
        try { assertCurrent(); return credential(); } catch { return false; }
      };
      if (!canDispatch()) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
      const result = await codexAccountRpc(directory, 'account/rateLimitResetCredit/consume', params, canDispatch);
      assertCurrent();
      return result as Awaited<ReturnType<CodexRateLimitResetServiceDeps['consumeResetCredit']>>;
    },
    recordRateLimitSnapshot: async () => {
      assertCurrent();
      // The reset service projects only the default bucket. The pool retains its
      // full model table, refreshed once after redemption rather than on every read.
    },
    refresh: async () => {
      assertCurrent();
      await snapshot(state, 'openai', id, true, true);
      assertCurrent();
      changed('openai', id);
    },
  };
}

/** Exact task affinity and known fresh quota are both required to wake an existing wait. */
export async function hasRestoredPooledCodexQuota(scope: string, taskId: string, nativeId: string | null | undefined, model?: string | null): Promise<boolean | null> {
  if (!scope.startsWith(CODEX_POOL_RESET_PREFIX)) return null;
  const id = scope.slice(CODEX_POOL_RESET_PREFIX.length);
  const bound = () => (readAccountBinding(`task:${taskId}`, 'openai')
    ?? (nativeId ? readAccountBinding(`native:${nativeId}`, 'openai') : undefined))?.accountId === id;
  if (!bound()) return false;
  const target = pooledCodexResetTarget(scope);
  if (!target) return false;
  const state = currentRuntime();
  const info = await snapshot(state, 'openai', id);
  assertOwner(state);
  const pool = readPool('openai');
  if (!bound() || !pool || disconnectedFor(pool, 'openai', id) || !pool.accounts.some(a => a.id === id && !a.paused)
    || !info.auth.authenticated || info.unavailable) return false;
  const usage = providerGroupMemberUsageState(info.usage ?? {}, model?.replace(/^chatgpt\//, ''), Date.now(), 'codex');
  return usage.quota !== null && !usage.limited;
}
/** Recover affinity from host-owned history metadata, never from pool order or quota.
 * Retain removed aliases so an old task fails closed instead of switching accounts.
 */
export function codexSubscriptionAccountForHistoryHome(historyHome: string): string | undefined {
  const pool = readPool('openai');
  if (!pool) return;
  const ids = new Set([...pool.accounts.map(a => a.id), ...Object.values(pool.legacyCodexAccounts ?? {})]);
  const matches = [...ids].filter(id => path.resolve(directoryFor('openai', id)) === path.resolve(historyHome));
  if (matches.length > 1) throw new Error('Codex history account is ambiguous');
  return matches[0];
}
function updatePool(
  provider: SubscriptionProvider,
  edit: Parameters<typeof updateStoredPool>[1],
): Promise<void> {
  const preserveLegacy = legacyCodexDefault(provider);
  return updateStoredPool(provider, (pool) =>
    edit({
      ...pool,
      ...(preserveLegacy ? { legacyCodexDefault: true } : {}),
    }),
  );
}
function defaultAccountBound(provider: SubscriptionProvider): boolean {
  return (
    isNativeProviderAuthBound(provider) &&
    (provider !== 'openai' ||
      legacyCodexDefault(provider) ||
      isNativeProviderAuthSharedSystemCredential(provider))
  );
}
/**
 * Disconnecting the built-in provider stops only the accounts that belong to it. An account that
 * belongs to its own connection again (placement.ts) keeps running under that connection's switch.
 */
function disconnectedFor(
  pool: { disconnected?: boolean } | null | undefined,
  provider: SubscriptionProvider,
  accountId: string,
): boolean {
  return pool?.disconnected === true && accountProviderId(provider, accountId) === provider;
}
/** Explicit reconnect of the existing default CLI route; private legacy Codex logins do not call this. */
export async function attachDefaultSubscriptionPool(provider: SubscriptionProvider): Promise<void> {
  const state = currentRuntime();
  assertOwner(state);
  await updatePool(provider, (pool) => ({ ...pool, disconnected: false }));
  assertOwner(state);
  state.cache.delete(keyOf(provider, 'default'));
  changed(provider);
}
function assertOwner(state: OwnerRuntime): void {
  if (isAppSessionBoundaryPending() || state.owner !== activeOwnerScopeKey())
    throw new Error('Subscription account owner changed');
}
export function observeSubscriptionAccountUsage(
  account: NativeSubscriptionAccount,
  raw: unknown,
): void {
  try {
    account.assertCurrent();
  } catch {
    return;
  } // Ignore late events after an owner/account disconnect.
  const state = currentRuntime();
  const key = account.id.slice(account.id.indexOf(':') + 1);
  const cached = state.cache.get(key);
  if (!cached) return;
  const provider = key.startsWith('anthropic:') ? 'anthropic' : 'openai';
  const incoming = provider === 'anthropic' ? parseClaudeSdkRateLimitInfo(raw, Date.now()) : null;
  const codexEvent =
    provider === 'openai' && raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const previousCodex = cached.usage?.codexUsage;
  const bucketKey = codexLimitBucketKey({
    limitId: typeof codexEvent?.limitId === 'string' ? codexEvent.limitId : null,
  });
  // Notifications contain one bucket directly. Merge it before sanitizing, retaining
  // omitted fields and unrelated model buckets instead of treating it as an RPC reply.
  let codexUsage =
    codexEvent && ('primary' in codexEvent || 'secondary' in codexEvent)
      ? providerGroupCodexUsageSnapshot({
          appServerBuckets: {
            ...previousCodex?.appServerBuckets,
            [bucketKey]: {
              ...previousCodex?.appServerBuckets?.[bucketKey],
              ...codexEvent,
              updatedAt: Date.now(),
            },
          },
          webSnapshot: previousCodex?.webSnapshot,
        })
      : previousCodex;
  if (codexUsage !== previousCodex && codexUsage?.appServerBuckets?.[bucketKey] && codexEvent) {
    const bucket = codexUsage.appServerBuckets[bucketKey];
    const previous = previousCodex?.appServerBuckets?.[bucketKey];
    // Preserve references for fields the event did not observe. This makes the
    // concurrent delta distinguish a repeated 100% event from an omitted window.
    codexUsage = { ...codexUsage, appServerBuckets: {
      ...previousCodex?.appServerBuckets,
      [bucketKey]: { ...bucket,
        primary: 'primary' in codexEvent ? bucket.primary : previous?.primary ?? null,
        secondary: 'secondary' in codexEvent ? bucket.secondary : previous?.secondary ?? null,
      },
    } };
  }
  const usage: Usage =
    provider === 'anthropic'
      ? {
          claudeUsage: incoming
            ? mergeClaudeSubscriptionUsageSnapshot(cached.usage?.claudeUsage ?? null, incoming)
            : cached.usage?.claudeUsage,
        }
      : { ...cached.usage, codexUsage };
  // The event updates usage, not the last account/endpoint read. Renewing `at`
  // here lets a stream of SDK events postpone authoritative polling indefinitely.
  state.cache.set(key, { ...cached, usage });
  changed(provider);
}
async function snapshot(
  state: OwnerRuntime,
  provider: SubscriptionProvider,
  id: string,
  force = false,
  forceUsage = false,
): Promise<AccountSnapshot> {
  assertOwner(state);
  const key = keyOf(provider, id);
  const cached = state.cache.get(key);
  const ttl = cached?.unavailable ? ACCOUNT_SNAPSHOT_FAILURE_TTL_MS : ACCOUNT_SNAPSHOT_TTL_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return cached;
  const pending = state.flights.get(key);
  if (pending) {
    if (!forceUsage || pending.forceUsage) return pending.promise;
    // A normal read may reuse its cached quota. A manual refresh waits for it,
    // then starts one fresh read shared by any other concurrent refreshes.
    await pending.promise;
    return snapshot(state, provider, id, force, forceUsage);
  }
  const directory = directoryFor(provider, id);
  const defaultCodexAuthEpoch = state.defaultCodexAuthEpoch;
  const flight = (async (): Promise<AccountSnapshot> => {
    const startedAt = Date.now();
    let result: AccountSnapshot;
    if (id === 'default' && !defaultAccountBound(provider)) {
      result = { auth: { authenticated: false }, at: Date.now() };
    } else {
      try {
        const imported = provider === 'openai' ? readLegacyCodexProviderId(id) : undefined;
        const expectedIdentity = provider === 'anthropic'
          ? readPool(provider)?.accounts.find((account) => account.id === id)?.reloginIdentity
          : undefined;
        let auth: AccountSnapshot['auth'] = imported
          ? await readLegacyCodexProviderAccount(imported, directory)
          : id === 'default' && legacyCodexDefault(provider)
            ? await readLegacyCodexAccount()
            : expectedIdentity
              ? await readNativeAccount(provider, directory, { force: true })
              : await readNativeAccount(provider, directory);
        if (expectedIdentity && (!auth.authenticated
          || auth.identity?.trim().toLowerCase() !== expectedIdentity.toLowerCase())) {
          // A cancelled/wrong browser login may already have changed the native profile.
          // Keep the original identity until that same account has been confirmed again.
          auth = {
            authenticated: false,
            identity: expectedIdentity,
            ...(auth.authenticated ? { errorReason: 'account_mismatch' } : {}),
          };
        }
        if (provider === 'anthropic') {
          assertOwner(state);
          const confirmedIdentity = auth.authenticated ? auth.identity?.trim() : undefined;
          const saved = readPool(provider)?.accounts.find((account) => account.id === id);
          if (confirmedIdentity && confirmedIdentity.length <= 320
            && saved && saved.lastConfirmedIdentity !== confirmedIdentity) {
            await updatePool(provider, (pool) => {
              assertOwner(state);
              return { ...pool, accounts: pool.accounts.map((account) => account.id === id
                && (!account.reloginIdentity || account.reloginIdentity.toLowerCase() === confirmedIdentity.toLowerCase())
                ? { ...account, lastConfirmedIdentity: confirmedIdentity } : account) };
            });
            assertOwner(state);
          } else if (!auth.authenticated && !auth.identity && saved?.lastConfirmedIdentity) {
            auth = { ...auth, identity: saved.lastConfirmedIdentity };
          }
        }
        const invalidated = state.invalidated.get(key);
        if (provider === 'openai' && invalidated && auth.authenticated) {
          const current = await readNativeCodexTokens(directory);
          if (current.accessToken === invalidated.token)
            auth = { ...auth, authenticated: false, errorReason: invalidated.reason };
          else if (state.invalidated.get(key) === invalidated) state.invalidated.delete(key);
        }
        // Auth reads yield: quota events may have replaced the captured cache.
        const current = state.cache.get(key);
        const sameAccount = current?.auth.identity === auth.identity;
        const reuseUsage =
          !forceUsage &&
          sameAccount &&
          current?.usageAt !== undefined &&
          Date.now() - current.usageAt < 180_000;
        let usage = auth.authenticated
          ? reuseUsage
            ? current?.usage
            : await readNativeAccountUsage(provider, directory).catch(() =>
                state.cache.get(key)?.auth.identity === auth.identity ? state.cache.get(key)?.usage : undefined,
              )
          : undefined;
        const latest = state.cache.get(key);
        const eventDuringRead = auth.authenticated && latest?.auth.identity === auth.identity
          && latest?.usage !== current?.usage;
        // A successful read owns the full snapshot; overlay only concurrent
        // events, not the old endpoint fields carried along in the event cache.
        if (eventDuringRead && usage !== latest?.usage) {
          if (provider === 'anthropic' && latest?.usage?.claudeUsage) {
            usage = { ...usage, claudeUsage: usage?.claudeUsage ? mergeClaudeSubscriptionUsageDuringRead(
              current?.usage?.claudeUsage, usage.claudeUsage, latest.usage.claudeUsage,
            ) : latest.usage.claudeUsage };
          } else if (provider === 'openai' && latest?.usage?.codexUsage) {
            const buckets = { ...usage?.codexUsage?.appServerBuckets };
            for (const [id, bucket] of Object.entries(latest.usage.codexUsage.appServerBuckets ?? {})) {
              const previous = current?.usage?.codexUsage?.appServerBuckets?.[id];
              if (bucket === previous) continue;
              // Omitted event fields still belong to the fresh RPC result.
              const delta = Object.fromEntries(Object.entries(bucket).filter(([field, value]) => {
                if (value === previous?.[field as keyof typeof previous]) return false;
                if (field === 'primary' || field === 'secondary') {
                  const eventReset = bucket[field]?.resetsAt;
                  const readReset = buckets[id]?.[field]?.resetsAt;
                  if (eventReset != null && readReset != null && eventReset < readReset) return false;
                }
                return true;
              }));
              buckets[id] = { ...buckets[id], ...delta,
                updatedAt: Math.max(bucket.updatedAt ?? 0, buckets[id]?.updatedAt ?? 0) } as typeof bucket;
            }
            usage = { ...usage, codexUsage: providerGroupCodexUsageSnapshot({
              ...usage?.codexUsage, appServerBuckets: buckets,
            }) };
          }
        }
        result = {
          auth: { ...auth, plan: auth.plan ?? usage?.codexPlan },
          usage,
          at: Date.now(),
          usageAt: reuseUsage ? current?.usageAt
            : eventDuringRead && usage === latest?.usage ? latest?.usageAt : Date.now(),
        };
      } catch (error) {
        const account = provider === 'anthropic'
          ? readPool(provider)?.accounts.find((account) => account.id === id) : undefined;
        const identity = account?.reloginIdentity ?? account?.lastConfirmedIdentity;
        // 这条日志是「重启后发不出去」唯一可查的线索。**不记 error.message**：读取链里有
        // auth.json 的 JSON.parse，解析失败的 message 会带上文件片段(可能含 token)。
        // 耗时与错误类型已足够分辨：近 0ms 多为 CLI 未就绪 / spawn 失败，15s 是读超时，
        // SyntaxError 指向 auth.json 损坏。
        log.warn('subscription account read failed', {
          provider,
          accountId: id,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.name : typeof error,
        });
        result = { auth: { authenticated: false, ...(identity ? { identity } : {}) }, unavailable: true, at: Date.now() };
      }
    }
    assertOwner(state);
    if (provider === 'openai' && id === 'default' && state.defaultCodexAuthEpoch !== defaultCodexAuthEpoch)
      return state.cache.get(key) ?? { auth: { authenticated: false }, at: 0 };
    state.cache.set(key, result);
    if (provider === 'openai') publishCodexCatalogChange(state);
    return result;
  })();
  state.flights.set(key, { promise: flight, forceUsage });
  void flight
    .finally(() => {
      state.flights.delete(key);
    })
    .catch(() => {});
  return flight;
}

/**
 * The pool behind a provider id (placement.ts): built-in providers, providers Cindy created for
 * subscription accounts and registered legacy Codex connections. `off` is the built-in provider's
 * own disconnect switch, which never stops the accounts of other providers.
 */
function poolFor(providerId: string) {
  const ref = resolveSubscriptionPoolProvider(providerId);
  if (!ref) return null;
  const pool = readPool(ref.kind);
  return pool ? { ref, kind: ref.kind, pool, off: pool.disconnected === true && ref.providerId === ref.kind } : null;
}
/**
 * The accounts a provider serves its tasks with: its own, or — once merged into another provider
 * with none left — the account it pins for its old tasks (placement.ts pinnedOwnAccount). Without
 * this a merged created provider read as disconnected and its old tasks could not send
 * (found in an isolated sandbox with two real Codex accounts, 2026-11-13).
 */
function servingAccounts(found: NonNullable<ReturnType<typeof poolFor>>) {
  const { kind, pool, ref } = found;
  const pinned = pinnedOwnAccount(ref);
  return pinned
    ? pool.accounts.filter((account) => account.id === pinned && !disconnectedFor(pool, kind, account.id))
    : providerAccounts(kind, pool.accounts, ref.providerId);
}
/** Read-only cached aggregate for provider catalog/auth gates; no account identity leaves it. */
export function hasConnectedSubscriptionPool(providerId: string, options: { includeBoundAccounts?: boolean } = {}): boolean {
  const found = poolFor(providerId);
  if (!found || (found.off && !options.includeBoundAccounts)) return false;
  const state = currentRuntime();
  const historical = options.includeBoundAccounts ? readProviderBoundAccountIds(found.kind, providerId) : new Set<string>();
  const serving = new Set(servingAccounts(found).map(account => account.id));
  return found.pool.accounts.filter(account => (serving.has(account.id) || historical.has(account.id))
    && !disconnectedFor(found.pool, found.kind, account.id))
    .some((a) => state.cache.get(keyOf(found.kind, a.id))?.auth.authenticated);
}

/** The legacy default adapter's auth boundary invalidates only its own pool slot. */
export function resetDefaultSubscriptionCodexDiscovery(authenticated: boolean): void {
  if (!readPool('openai')) return;
  const state = currentRuntime();
  state.defaultCodexAuthEpoch += 1;
  state.codexModels.delete('default');
  if (authenticated) state.cache.delete(keyOf('openai', 'default'));
  else state.cache.set(keyOf('openai', 'default'), { auth: { authenticated: false }, at: Date.now() });
  publishCodexCatalogChange(state);
}

/** Owner-local model/list discovery; shares the account snapshot lifetime and in-flight work.
 * No inference or credential copying. Never publish a partial pagination result or a late login.
 */
export async function refreshSubscriptionPoolCodexModels(force = false): Promise<void> {
  const state = currentRuntime();
  const pool = readPool('openai');
  if (!pool) { publishCodexCatalogChange(state); return; }
  const historical = readBoundSubscriptionAccountIds('openai');
  const refreshAccount = async (id: string): Promise<void> => {
    const loggingIn = () => [...state.logins].some(([key, login]) => key.startsWith('openai:') && login.accountId === id);
    const auth = state.cache.get(keyOf('openai', id))?.auth;
    if (!auth?.authenticated || loggingIn()) { state.codexModels.delete(id); return; }
    const previous = state.codexModels.get(id);
    if (!force && previous?.auth === auth && (previous.failedAt === undefined
      || Date.now() - previous.failedAt < ACCOUNT_SNAPSHOT_FAILURE_TTL_MS)) return;
    const pending = state.codexModelFlights.get(id);
    if (pending) {
      await pending.promise;
      if ((force && !pending.forced) || state.codexModels.get(id)?.auth !== state.cache.get(keyOf('openai', id))?.auth)
        await refreshAccount(id);
      return;
    }
    const directory = directoryFor('openai', id);
    const isCurrent = () => state.owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending()
      && !disconnectedFor(readPool('openai'), 'openai', id)
      && readPool('openai')?.accounts.some(a => a.id === id && (!a.paused || historical.has(id))) === true
      && !loggingIn()
      && state.cache.get(keyOf('openai', id))?.auth === auth
      && directoryFor('openai', id) === directory;
    const flight = (async () => {
      try {
        const models: CodexModelListItem[] = [];
        const cursors = new Set<string>();
        let pages = 0;
        let cursor: string | null = null;
        do {
          if (!isCurrent()) return;
          if (pages >= CODEX_MODEL_MAX_PAGES) throw new Error('Codex model page budget exceeded');
          const page = await codexAccountRpc(directory, 'model/list', { cursor, limit: 100, includeHidden: false }, isCurrent) as {
            data: CodexModelListItem[]; nextCursor?: string | null;
          };
          if (!Array.isArray(page?.data)) throw new Error('Invalid Codex model list');
          pages += 1;
          if (models.length + page.data.length > CODEX_MODEL_MAX_ITEMS) throw new Error('Codex model item budget exceeded');
          models.push(...page.data);
          const next: string | null = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
          if (next && cursors.has(next)) throw new Error('Repeated Codex model cursor');
          if (next) cursors.add(next);
          cursor = next;
        } while (cursor !== null);
        // model/list owns membership/tiers; only this same profile's cache can
        // supply windows and image inputs that the live protocol does not report.
        const cached = await readFile(path.join(directory, 'models_cache.json'), 'utf8')
          .then(raw => new Map(mapCodexModelsToCatalog(JSON.parse(raw)).map(model => [model.id, model])))
          .catch(() => new Map<string, CatalogModel>());
        if (!isCurrent()) return;
        state.codexModels.set(id, { auth, models: mapCodexAppServerModelsToCatalog(models).map(model => {
          const known = cached.get(model.id);
          if (!known) return model;
          return { ...model,
            ...(known.contextWindowVerified ? { contextWindow: known.contextWindow, contextWindowVerified: true,
              contextWindowMax: known.contextWindowMax } : {}),
            ...(known.supportsImageInput !== undefined ? { supportsImageInput: known.supportsImageInput } : {}),
            discoveredMetadata: {
              ...model.discoveredMetadata,
              ...(known.contextWindowVerified ? { contextWindow: known.contextWindow } : {}),
              ...(known.supportsImageInput !== undefined ? { supportsImageInput: known.supportsImageInput } : {}),
            },
          };
        }) });
      } catch (error) {
        // Failure is retryable evidence, not an authoritative empty list. Only
        // this same login may retain its last complete list while recovery runs.
        if (isCurrent()) {
          const sameLogin = previous?.auth === auth || (auth.identity && previous?.auth.identity === auth.identity);
          state.codexModels.set(id, { auth, models: sameLogin ? previous?.models ?? [] : [], failedAt: Date.now() });
          log.warn('subscription account model read failed', {
            accountId: id, error: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    })();
    state.codexModelFlights.set(id, { promise: flight, forced: force });
    try { await flight; } finally { if (state.codexModelFlights.get(id)?.promise === flight) state.codexModelFlights.delete(id); }
  };
  await Promise.all(pool.accounts.filter(account => (!account.paused || historical.has(account.id)) && !disconnectedFor(pool, 'openai', account.id)
    && !readLegacyCodexProviderId(account.id))
    .map(account => refreshAccount(account.id)));
  publishCodexCatalogChange(state);
}

/** null preserves pre-pool discovery; [] is authoritative empty membership.
 * Imported connections are projected separately with their original route authorization.
 */
export function readSubscriptionPoolCodexModels(
  providerId = 'openai', options: { includeBoundAccounts?: boolean } = {},
): readonly CatalogModel[] | null {
  const found = poolFor(providerId);
  if (!found || found.kind !== 'openai') return null;
  const state = currentRuntime();
  const models = new Map<string, CatalogModel>();
  const historical = options.includeBoundAccounts ? readProviderBoundAccountIds('openai', providerId) : new Set<string>();
  const serving = new Set(servingAccounts(found).map(account => account.id));
  const accounts = found.pool.accounts.filter(account => serving.has(account.id) || historical.has(account.id));
  if (!found.off || options.includeBoundAccounts) for (const account of accounts) {
    if (disconnectedFor(found.pool, 'openai', account.id)) continue;
    if ((account.paused && !historical.has(account.id)) || readLegacyCodexProviderId(account.id)) continue;
    if ([...state.logins].some(([key, login]) => key.startsWith('openai:') && login.accountId === account.id)) continue;
    const auth = state.cache.get(keyOf('openai', account.id))?.auth;
    const snapshot = state.codexModels.get(account.id);
    if (!auth?.authenticated || !snapshot || !(snapshot.auth === auth
      || (!!auth.identity && snapshot.auth.identity === auth.identity))) continue;
    for (const model of snapshot.models) if (!models.has(model.id)) models.set(model.id, model);
  }
  const next = [...models.values()];
  const catalogs = state.codexCatalogs ??= new Map();
  const cacheKey = `${providerId}:${options.includeBoundAccounts ? 'routing' : 'selectable'}`;
  const previous = catalogs.get(cacheKey);
  if (previous && previous.length === next.length && next.every((model, index) => previous[index] === model)) return previous;
  catalogs.set(cacheKey, next);
  return next;
}
/** Cached read evidence only; disconnected/unconfigured/paused pools never request UI recovery. */
export function hasUnavailableSubscriptionPoolAccount(providerId: string): boolean {
  const found = poolFor(providerId);
  if (!found || found.off) return false;
  const state = currentRuntime();
  return servingAccounts(found).some(account => !account.paused
    && (state.cache.get(keyOf(found.kind, account.id))?.unavailable === true
      || (found.kind === 'openai' && state.cache.get(keyOf(found.kind, account.id))?.auth.authenticated
        && state.codexModels.get(account.id)?.failedAt !== undefined)));
}

/** Native account membership is independent of the supplier's union. Imported
 * connections retain their original route/permission gate instead of this list.
 */
function codexAccountSupportsModel(state: OwnerRuntime, id: string, model: string | undefined): boolean {
  if (!model || readLegacyCodexProviderId(id)) return true;
  const info = state.cache.get(keyOf('openai', id));
  const catalog = state.codexModels.get(id);
  return !!info?.auth.authenticated && !!catalog
    && (catalog.auth === info.auth || (!!info.auth.identity && catalog.auth.identity === info.auth.identity))
    && catalog.models.some(entry => entry.id === model.replace(/^chatgpt\//, ''));
}
export async function disconnectSubscriptionPool(provider: SubscriptionProvider): Promise<void> {
  const pool = readPool(provider);
  if (!pool || pool.disconnected) return;
  const state = currentRuntime();
  for (const [key, login] of state.logins) if (key.startsWith(provider + ':')) login.abort.abort();
  await updatePool(provider, (pool) => ({ ...pool, disconnected: true }));
  assertOwner(state);
  changed(provider);
}
export function refreshSubscriptionPool(
  providerId: string,
  forceUsage = false,
): Promise<SubscriptionPoolView> {
  return readSubscriptionPoolView(providerId, false, undefined, forceUsage);
}
/** Outer groups see the next usable account's quota, not an exhausted default.
 * No identity, directory, credentials, or account identifiers cross this boundary.
 */
export function readLegacySubscriptionPoolUsage(provider: SubscriptionProvider): Promise<Usage | null | undefined> {
  const pool = readPool(provider);
  const members = pool ? providerAccounts(provider, pool.accounts) : [];
  // One ordinary default account keeps its original native/web usage readers.
  if (!pool || (!pool.disconnected && members.length === 1
    && members[0].id === 'default' && !members[0].paused))
    return Promise.resolve(undefined);
  return readSubscriptionPoolUsage(provider);
}

/** Quota errors belong to a task's pinned account, including paused accounts.
 * Unbound pre-pool sessions retain their original default reader; removed or
 * disconnected bound accounts must never borrow another account's reset time.
 */
export async function readSubscriptionSessionUsage(provider: SubscriptionProvider, nativeSessionId: string): Promise<Usage | null | undefined> {
  const state = currentRuntime();
  assertOwner(state);
  const binding = readAccountBinding(`native:${nativeSessionId}`, provider);
  if (!binding) return undefined;
  const current = () => {
    const pool = readPool(provider);
    return pool && !disconnectedFor(pool, provider, binding.accountId) && pool.accounts.some(a => a.id === binding.accountId)
      && (binding.accountId !== 'default' || defaultAccountBound(provider))
      && readAccountBinding(`native:${nativeSessionId}`, provider)?.accountId === binding.accountId;
  };
  if (!current()) return null;
  // The default account keeps its existing native/web reader and refresh policy.
  if (binding.accountId === 'default') return undefined;
  const info = await snapshot(state, provider, binding.accountId);
  assertOwner(state);
  if (!current() || !info.auth.authenticated) return null;
  return info.usage ?? null;
}

/**
 * Provider group §5/§6.1 pre-send check for one bound account: it cannot take this model now
 * when it remembers a real failure (cooling), its Claude quota snapshot is exhausted, or it is
 * signed out. Unknown quota is not exhaustion. Paused or removed accounts are not judged here.
 * Runs before every send, so it only reads what this owner already knows (failures, the cached
 * snapshot kept fresh by quota events and list reads) and never waits for the native CLI.
 */
export function readSubscriptionAccountBlocked(
  provider: SubscriptionProvider,
  accountId: string,
  model: string | undefined,
): boolean {
  const pool = readPool(provider);
  // Only accounts sharing the task account's provider can take over; a provider with a single
  // account (an independent connection) never moves its tasks (subscription-account-pools.md).
  if (!pool || disconnectedFor(pool, provider, accountId)
    || accountSiblings(provider, pool.accounts, accountId).length < 2) return false;
  if (!pool.accounts.some((account) => account.id === accountId && !account.paused)) return false;
  const state = currentRuntime();
  if (accountCooling(state, provider, accountId, model)) return true;
  const info = state.cache.get(keyOf(provider, accountId));
  if (!info || info.unavailable) return false;
  if (!info.auth.authenticated) return true;
  if (provider === 'openai' && model && state.codexModels.has(accountId)
    && state.codexModels.get(accountId)?.failedAt === undefined
    && !codexAccountSupportsModel(state, accountId, model)) return true;
  // ChatGPT plan windows do not establish whether upstream can spend credits. Only a real
  // failure (checked above) can retire this account and its native context before sending.
  if (provider === 'openai') return false;
  return providerGroupMemberUsageState(info.usage ?? {}, model, Date.now(), 'claude-code').limited;
}

/** A positive result can retire a member/model cooldown, so unknown quota is
 * not enough. This never selects/binds an account or changes an existing task. */
export async function readSubscriptionPoolModelAvailability(
  providerId: string,
  model: string,
  /** ownComputer：远程读取来自自己的其他电脑(不是受邀者)。 */
  options: { remote?: boolean; ownComputer?: boolean } = {},
): Promise<boolean | null> {
  const found = poolFor(providerId);
  if (!found) return null;
  const { kind: provider, pool, ref } = found;
  // The provider's own accounts only, as new assignments use them.
  const members = providerAccounts(provider, pool.accounts, ref.providerId);
  if (members.length < 2) return null;
  if (found.off) return false;
  const state = currentRuntime();
  const infos = await Promise.all(members.map((a) => snapshot(state, provider, a.id)));
  // Match new-account allocation without loading remote-access dependencies for
  // unrelated providers. Check current grants after the asynchronous quota read.
  const legacyAccess = provider === 'openai' ? await import('./legacyAccountAccess.js') : null;
  if (provider === 'openai') await refreshSubscriptionPoolCodexModels();
  assertOwner(state);
  const latest = readPool(provider);
  if (!latest || (latest.disconnected && ref.providerId === provider)) return false;
  return providerAccounts(provider, latest.accounts, ref.providerId).some((account) => {
    const index = members.findIndex((a) => a.id === account.id);
    if (index < 0) return false;
    const info = infos[index];
    if (account.paused || !info?.auth.authenticated || info.unavailable
      || accountCooling(state, provider, account.id, model)
      || [...state.logins].some(([key, login]) => key.startsWith(provider + ':') && login.accountId === account.id)
      || (account.id === 'default' && !defaultAccountBound(provider))) return false;
    const imported = provider === 'openai' ? readLegacyCodexProviderId(account.id) : undefined;
    if (provider === 'openai' && !codexAccountSupportsModel(state, account.id, model)) return false;
    if (imported && !legacyAccess?.legacyCodexAccountCanRun(imported, model, {
      remote: options.remote === true, ownComputer: options.ownComputer === true, newRoute: true,
    })) return false;
    const usage = providerGroupMemberUsageState(info.usage ?? {},
      provider === 'openai' ? model.replace(/^chatgpt\//, '') : model,
      Date.now(), provider === 'openai' ? 'codex' : 'claude-code');
    return (provider === 'openai' || !usage.limited) && usage.quota !== null;
  });
}

const ACCOUNT_SWITCH_PROBE_BUDGET_MS = 2_000;

/**
 * The account an existing task is pinned to, for the task's usage display (model list and
 * the usage under the composer). Bindings are looked up in the same order a resume uses, so the
 * display never names the default or the next pool pick instead of the task's own account.
 */
export async function readSubscriptionSessionAccount(
  provider: SubscriptionProvider,
  keys: { sessionId?: string; nativeSessionId?: string; model?: string; legacyProviderId?: string; routeProviderId?: string },
  /** ownComputer：远程读取来自自己的其他电脑(不是受邀者)，换号探测也认「让我的其他电脑用本机模型」。 */
  options: { remote?: boolean; ownComputer?: boolean } = {},
): Promise<SubscriptionSessionAccountView> {
  // Replacement admission is optional. Share a short budget with the original bound-account
  // read so a slow original read never starts another long CLI wait before returning its view.
  const switchDeadline = performance.now() + ACCOUNT_SWITCH_PROBE_BUDGET_MS;
  const state = currentRuntime();
  assertOwner(state);
  const pool = readPool(provider);
  if (!pool) return { providerId: provider, state: 'legacy' };
  const requestedRoute = keys.routeProviderId ?? keys.legacyProviderId ?? provider;
  const requestedRef = resolveSubscriptionPoolProvider(requestedRoute);
  if (!requestedRef || requestedRef.kind !== provider) return { providerId: provider, state: 'unavailable' };
  const routeEcho = keys.routeProviderId || keys.legacyProviderId ? { routeProviderId: requestedRoute } : {};
  const legacyAccountId = provider === 'openai' && keys.legacyProviderId
    ? readLegacyCodexAccountId(keys.legacyProviderId) : undefined;
  // Only a connection still merged into OpenAI may be offered the merged route; a connection whose
  // account belongs to it again is an independent provider and keeps its tasks (2026-11-13).
  const pinnedLegacyAccountId = legacyAccountId && !providerAccounts(provider, pool.accounts, requestedRoute).length
    ? legacyAccountId : undefined;
  // Only the executing computer can resolve its aliases. Both the original route and the
  // merged destination must still admit this own-computer task; old or unrelated ids do not.
  const legacyRouteAdmits = () => !!legacyAccountId && !!keys.legacyProviderId && !!keys.model
    && options.remote === true && options.ownComputer === true
    && readLegacyCodexAccountId(keys.legacyProviderId) === legacyAccountId
    && legacyCodexAccountCanRun(keys.legacyProviderId, keys.model, {
      remote: options.remote === true, ownComputer: options.ownComputer === true, newRoute: false,
    });
  if (keys.legacyProviderId && !legacyRouteAdmits())
    return { providerId: provider, state: 'unavailable' };
  const canReplace = async (accountId: string, selectedDestination?: string): Promise<boolean> => {
    const originalOwner = accountProviderId(provider, accountId);
    const destination = selectedDestination ?? originalOwner;
    const admits = () => accountProviderId(provider, accountId) === originalOwner
      && subscriptionRouteAllowsModel(destination, keys.model, options)
      && (!options.remote || (pinnedLegacyAccountId ? legacyRouteAdmits() : subscriptionRouteAllowsModel(requestedRoute, keys.model, options)))
      && (!legacyAccountId || legacyRouteAdmits());
    const minimum = !selectedDestination && pool.accounts.some(account => account.id === accountId) ? 2 : 1;
    if (providerAccounts(provider, pool.accounts, destination).length < minimum || !admits()) return false;
    const budget = switchDeadline - performance.now();
    if (budget <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([
        acquireSubscriptionAccount(destination, keys.model, [], false, {
          remote: options.remote === true, ownComputer: options.ownComputer === true,
          exclude: new Set([accountId]), dryRun: true,
        }).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), budget); }),
      ]);
      return available && admits();
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      assertOwner(state);
    }
  };
  const binding = [
    keys.sessionId ? `task:${keys.sessionId}` : '',
    keys.nativeSessionId ? `native:${keys.nativeSessionId}` : '',
  ]
    .filter(Boolean)
    .map((key) => readAccountBinding(key, provider))
    .find(Boolean) ?? (legacyAccountId ? { accountId: legacyAccountId } : undefined)
    ?? (pinnedOwnAccount(requestedRef) ? { accountId: pinnedOwnAccount(requestedRef)! } : undefined);
  if (pinnedLegacyAccountId && binding?.accountId !== pinnedLegacyAccountId
    && (!binding || !('via' in binding) || binding.via !== requestedRoute))
    return { providerId: provider, state: 'unavailable' };
  if (binding && !pinnedLegacyAccountId && (keys.routeProviderId || keys.legacyProviderId) && requestedRoute !== (('via' in binding ? binding.via : undefined) ?? provider)
    && accountProviderId(provider, binding.accountId) !== requestedRoute)
    return { providerId: provider, state: 'unavailable', ...routeEcho,
      ...(await canReplace(binding.accountId, requestedRoute) ? { replacementProviderId: requestedRoute } : {}) };
  // With only the ordinary CLI default, the original readers are the task's account.
  const members = providerAccounts(provider, pool.accounts, requestedRoute);
  const onlyDefault =
    !pool.disconnected && members.length === 1 && members[0].id === 'default' && !members[0].paused;
  // A pre-pool task resumes on the default account; a task that never ran is assigned next turn.
  if (!binding)
    return {
      providerId: provider,
      ...routeEcho,
      state: onlyDefault || keys.nativeSessionId ? 'legacy' : 'unassigned',
    };
  if (onlyDefault && binding.accountId === 'default' && !legacyAccountId)
    return { providerId: provider, state: 'legacy', ...routeEcho };
  // The task keeps its account wherever that account belongs now; number it among its own provider.
  const config = pool.accounts.find((a) => a.id === binding.accountId);
  const index = config ? accountSiblings(provider, pool.accounts, config.id).findIndex((a) => a.id === config.id) : -1;
  if (disconnectedFor(pool, provider, binding.accountId)) return { providerId: provider, state: 'unavailable' };
  if (
    !config || index < 0 ||
    (binding.accountId === 'default' && !defaultAccountBound(provider))
  )
    return { providerId: provider, state: 'unavailable', ...routeEcho,
      ...(pinnedLegacyAccountId && await canReplace(binding.accountId) ? { replacementProviderId: accountProviderId(provider, binding.accountId) } : {}) };
  const info = await snapshot(state, provider, config.id);
  assertOwner(state);
  const usage = providerGroupMemberUsageState(
    info.usage ?? {},
    undefined,
    Date.now(),
    provider === 'openai' ? 'codex' : 'claude-code',
  );
  // The controller hands the task off only when a fresh start here would take another account
  // (same judgment as the local pre-send failover). Accounts merged from a legacy connection move
  // too (2026-11-13): a task on the `openai` route bound to one is an ordinary pool task.
  const blocked = keys.model !== undefined && !config.paused
    && readSubscriptionAccountBlocked(provider, config.id, keys.model);
  // Quota alone cannot authorize retiring native history. Probe actual replacement admission
  // without reserving or rebinding, within the original query's shared budget.
  const switchAvailable = (blocked || config.paused) && await canReplace(config.id);
  const destination = accountProviderId(provider, config.id);
  return {
    providerId: provider,
    state: 'bound',
    ...routeEcho,
    ...(switchAvailable && destination !== requestedRoute ? { replacementProviderId: destination } : {}),
    account: {
      isDefault: config.id === 'default',
      number: index + 1,
      ...(info.auth.identity ? { identity: info.auth.identity } : {}),
      ...(info.auth.plan ? { plan: info.auth.plan } : {}),
      paused: config.paused,
      status: info.unavailable
        ? 'unavailable'
        : !info.auth.authenticated
          ? 'signed-out'
          : usage.limited
            ? 'limited'
            : 'ready',
      ...(info.auth.authenticated ? accountUsage(info.usage) : {}),
      ...(blocked ? { blocked: true as const, switchAvailable } : {}),
      ...((keys.routeProviderId || keys.legacyProviderId) && config.paused ? { switchAvailable } : {}),
    },
  };
}

export async function readSubscriptionPoolUsage(
  providerId: string,
): Promise<Usage | null | undefined> {
  const found = poolFor(providerId);
  if (!found) return undefined;
  if (found.off) return null;
  const { kind: provider, pool, ref } = found;
  const state = currentRuntime();
  // A provider's quota comes from its own accounts only.
  const members = providerAccounts(provider, pool.accounts, ref.providerId);
  const infos = await Promise.all(members.map((a) => snapshot(state, provider, a.id)));
  assertOwner(state);
  const latest = readPool(provider);
  if (!latest || (latest.disconnected && ref.providerId === provider)) return null;
  const current = providerAccounts(provider, latest.accounts, ref.providerId);
  const accounts = members.map(a => current.find(entry => entry.id === a.id));
  const now = Date.now();
  const choose = (
    usageOf: (info: AccountSnapshot) => ReturnType<typeof providerGroupMemberUsageState>,
  ) => {
    const candidates = accounts.flatMap((a, i) => {
      if (!a) return [];
      const usage = usageOf(infos[i]);
      return [{
        ...a,
        key: a.id,
        usable: infos[i].auth.authenticated && !usage.limited,
        running: state.running.get(keyOf(provider, a.id))?.size ?? 0,
        // Quota reads reserve nothing: busy accounts still have quota. Only
        // acquireSubscriptionAccount applies the hard concurrency admission.
        limit: Number.POSITIVE_INFINITY,
        urgency: usage.urgency,
        fiveHourTight: usage.fiveHourTight,
      }];
    });
    const id = pickProviderGroupMember(candidates, providerStrategy(ref.providerId, provider, latest), {
      lastPicked: state.lastPicked.get(ref.providerId),
    });
    return id
      ? members.findIndex((a) => a.id === id)
      : accounts.findIndex((a, i) => a && !a.paused && infos[i].auth.authenticated);
  };
  const base = choose((info) =>
    providerGroupMemberUsageState(
      info.usage ?? {},
      undefined,
      now,
      provider === 'openai' ? 'codex' : 'claude-code',
    ),
  );
  if (base < 0) return null;
  if (provider === 'anthropic') {
    const usage = infos[base].usage?.claudeUsage;
    if (!usage) return null;
    const models = new Set(
      infos.flatMap(
        (info) =>
          info.usage?.claudeUsage?.scoped?.map((w) => w.modelId ?? w.modelDisplayName) ?? [],
      ),
    );
    const scoped = [...models].flatMap((model) => {
      const selected = choose((info) =>
        providerGroupMemberUsageState(info.usage ?? {}, model, now, 'claude-code'),
      );
      const window = matchScopedWindowForModel(infos[selected]?.usage?.claudeUsage?.scoped, model);
      return window ? [window] : [];
    });
    return { claudeUsage: { ...usage, scoped } };
  }
  // Each bucket keeps both windows from one eligible account. Do not publish a
  // single account's exhausted model bucket as the whole provider's quota.
  const keys = new Set(
    infos.flatMap((info) => Object.keys(info.usage?.codexUsage?.appServerBuckets ?? {})),
  );
  const buckets = Object.fromEntries(
    [...keys].flatMap((key) => {
      const selected = choose((info) =>
        providerGroupMemberUsageState(
          {
            codexUsage: {
              appServerBuckets: null,
              webSnapshot: info.usage?.codexUsage?.appServerBuckets?.[key] ?? null,
            },
          },
          undefined,
          now,
          'pi',
        ),
      );
      const bucket = infos[selected]?.usage?.codexUsage?.appServerBuckets?.[key];
      return bucket ? [[key, bucket]] : [];
    }),
  );
  return {
    codexUsage: {
      appServerBuckets: buckets,
      webSnapshot: buckets.codex ?? buckets.__default__ ?? null,
      nativeAccountPool: true,
    },
  };
}
/** Assignable signed-in accounts in pool order, for owner-enabled quota sharing.
 * Only quota snapshots and whether the entry is the CLI default account leave here.
 */
export async function readSubscriptionPoolAccountUsages(
  providerId: string,
): Promise<Array<{ isDefault: boolean; usage: Usage | undefined }> | undefined> {
  const found = poolFor(providerId);
  if (!found || found.off) return undefined;
  const { kind: provider, pool, ref } = found;
  const state = currentRuntime();
  const accounts = providerAccounts(provider, pool.accounts, ref.providerId).filter((account) => !account.paused);
  const infos = await Promise.all(accounts.map((a) => snapshot(state, provider, a.id)));
  assertOwner(state);
  const latest = readPool(provider);
  if (!latest || (latest.disconnected && ref.providerId === provider)) return [];
  return accounts.flatMap((account, index) =>
    latest.accounts.some(a => a.id === account.id && !a.paused)
      && accountProviderId(provider, account.id) === ref.providerId && infos[index].auth.authenticated
      ? [{ isDefault: account.id === 'default', usage: infos[index].usage }]
      : [],
  );
}
function accountUsage(usage: Usage | undefined): { usage?: SubscriptionAccountUsage } {
  if (usage?.claudeUsage) return { usage: { claude: usage.claudeUsage } };
  const buckets = usage?.codexUsage?.appServerBuckets;
  return buckets && Object.keys(buckets).length > 0
    ? { usage: { codex: { buckets, credits: usage?.codexCredits ?? null } } }
    : {};
}
export function readSubscriptionPool(
  providerId: string,
  previewDefault = false,
  taskId?: string,
): Promise<SubscriptionPoolView> {
  return readSubscriptionPoolView(providerId, previewDefault, taskId);
}

async function readSubscriptionPoolView(
  providerId: string,
  previewDefault: boolean,
  taskId?: string,
  forceUsage = false,
): Promise<SubscriptionPoolView> {
  const state = currentRuntime();
  const ref = resolveSubscriptionPoolProvider(providerId);
  if (!ref) throw new Error('Unknown subscription provider');
  const provider = ref.kind;
  // Only built-in providers have the CLI default slot before any account exists.
  const pool = readPool(provider) ?? (ref.providerId === provider ? defaultPool() : { ...defaultPool(), accounts: [] });
  // The task's account shows under this provider only where the task would run on it: the provider
  // it was bound through, or the one that account belongs to now (same rule as acquiring). Under
  // another provider of the kind the task would hand over to that provider's own accounts, so the
  // picker must not show this account's quota there (2026-11-13).
  const binding = taskId ? readAccountBinding(`task:${taskId}`, provider) : undefined;
  const bound = binding && (ref.providerId === (binding.via ?? provider)
    || accountProviderId(provider, binding.accountId) === ref.providerId) ? binding.accountId : undefined;
  // A provider lists its own accounts. A task's read also keeps the task's own account when it now
  // belongs to another provider, so the task never shows someone else's account.
  const listed = pool.accounts.filter(
    (account) => accountProviderId(provider, account.id) === ref.providerId || account.id === bound,
  );
  const accounts = await Promise.all(
    listed.map(async (account) => {
      // The add-provider wizard may present an unbound CLI login, but detection
      // must never populate the authorized dispatch cache or fetch its quota.
      const preview = previewDefault && account.id === 'default';
      const info: AccountSnapshot = preview
        ? await (
            legacyCodexDefault(provider)
              ? readLegacyCodexAccount()
              : readNativeAccount(provider, directoryFor(provider, 'default'))
          )
            .then((auth) => ({ auth, at: Date.now() }))
            .catch(() => ({ auth: { authenticated: false }, unavailable: true, at: Date.now() }))
        : await snapshot(state, provider, account.id, forceUsage, forceUsage);
      const usage = providerGroupMemberUsageState(
        info.usage ?? {},
        undefined,
        Date.now(),
        provider === 'openai' ? 'codex' : 'claude-code',
      );
      const { lastConfirmedIdentity: _lastIdentity, reloginIdentity: _renewalIdentity, ...visibleAccount } = account;
      return {
        ...visibleAccount,
        directory: directoryFor(provider, account.id),
        ...(provider === 'openai' ? { codexResetProviderId: readLegacyCodexProviderId(account.id) ?? codexResetScope(account.id) } : {}),
        ...(account.id === 'default' && legacyCodexDefault(provider) ? { legacy: true } : {}),
        identity: info.auth.identity,
        plan: info.auth.plan,
        ...(provider === 'anthropic' && !disconnectedFor(pool, provider, account.id) && info.auth.authenticated
          && info.auth.loginExpiresAt ? { loginExpiresAt: info.auth.loginExpiresAt } : {}),
        ...(info.auth.errorReason === 'codex_provider_managed_auth'
          ? { authIssue: 'codex-provider-managed-auth' as const }
          : info.auth.errorReason === 'account_mismatch'
            ? { authIssue: 'claude-account-mismatch' as const }
            : {}),
        status:
          disconnectedFor(pool, provider, account.id) && !preview
            ? ('signed-out' as const)
            : info.unavailable
              ? ('unavailable' as const)
              : !info.auth.authenticated
                ? ('signed-out' as const)
                : usage.limited
                  ? ('limited' as const)
                  : ('ready' as const),
        running: state.running.get(keyOf(provider, account.id))?.size ?? 0,
        ...(!disconnectedFor(pool, provider, account.id) && info.auth.authenticated ? accountUsage(info.usage) : {}),
      };
    }),
  );
  assertOwner(state);
  return {
    providerId: ref.providerId,
    kind: provider,
    configured: readPool(provider) !== null,
    strategy: providerStrategy(ref.providerId, provider, pool),
    ...(taskId ? { boundAccountId: bound ?? null } : {}),
    accounts,
    ...(previewDefault
      ? { defaultAdded: defaultLoginAdded(state, provider, accounts.find((account) => account.id === 'default')) }
      : {}),
  };
}

/**
 * Add-provider preview (2026-11-14 user decision): the CLI's own login is already in Cindy when the
 * built-in provider uses it, or when the same identity is already signed in as another account of
 * this kind. The wizard then offers no shortcut for it. Saved records and cached identities only:
 * no extra CLI or quota reads.
 */
function defaultLoginAdded(
  state: OwnerRuntime,
  provider: SubscriptionProvider,
  cli: SubscriptionPoolView['accounts'][number] | undefined,
): boolean {
  const saved = readPool(provider);
  // Older connected providers use an implicit default slot before any pool is saved.
  if ((!saved || saved.accounts.some((account) => account.id === 'default'))
    && !disconnectedFor(saved, provider, 'default') && defaultAccountBound(provider)) return true;
  const identity = cli && (cli.status === 'ready' || cli.status === 'limited')
    ? cli.identity?.trim().toLowerCase() : undefined;
  if (!identity) return false;
  return (saved?.accounts ?? []).some((account) => account.id !== 'default'
    && !disconnectedFor(saved, provider, account.id)
    && [account.lastConfirmedIdentity, state.cache.get(keyOf(provider, account.id))?.auth.identity]
      .some((value) => value?.trim().toLowerCase() === identity));
}

/** Each provider assigns among its own accounts with its own policy; built-ins keep the pool's. */
function providerStrategy(
  providerId: string,
  kind: SubscriptionProvider,
  pool: { strategy: SubscriptionPoolView['strategy'] },
): SubscriptionPoolView['strategy'] {
  return providerId === kind ? pool.strategy : readProviderStrategy(providerId) ?? 'least';
}

/** Every assignable account is at its concurrency limit (2026-11-11: full accounts take no new task). */
export const SUBSCRIPTION_ACCOUNTS_FULL_ERROR =
  '[SUBSCRIPTION_ACCOUNTS_FULL] every available subscription account has reached its concurrency limit';

export type RemoteSubscriptionInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options: { preSend: () => void },
) => Promise<{ ok: boolean; result?: unknown }>;

interface RemoteTaskAccountRow {
  providerId?: string | null; agentKind: string; sdkSessionId?: string | null;
  agentDeviceId?: string | null; remoteHostId?: string | null; model?: string | null;
}

function taskSubscriptionProvider(row: RemoteTaskAccountRow): SubscriptionProvider | null {
  const id = row.providerId ?? '';
  return (id === 'anthropic' || /^anthropic-sub-[a-f0-9]{8}$/.test(id)) && ['cc', 'claude-code'].includes(row.agentKind)
    ? 'anthropic' : (id === 'openai' || /^openai-sub-[a-f0-9]{8}$/.test(id))
      && ['codex', 'cc', 'claude-code', 'pi'].includes(row.agentKind) ? 'openai' : null;
}

/**
 * Same-account remote Agent: the executing computer owns the task's account binding, quota and new
 * route grants, so ask it through the existing owner-only reads. One `session` read per send (as
 * before); a blocked account includes the executor's actual replacement admission in that reply.
 * The separate quota read remains only for the pre-existing paused-account recovery. Older hosts
 * never report replacement admission, and a missing/old reply never authorizes retiring context.
 */
async function readRemoteTaskAccount(
  provider: SubscriptionProvider,
  row: RemoteTaskAccountRow & { agentDeviceId: string },
  invokeRemote: RemoteSubscriptionInvoke,
): Promise<{ number: number; paused: boolean; blocked: boolean; available: boolean; replacementProviderId?: string } | null> {
  const state = currentRuntime();
  const preSend = () => assertOwner(state);
  const legacyProviderId = provider === 'openai' && row.providerId && !taskSubscriptionProvider(row)
    ? row.providerId : undefined;
  const routeProviderId = legacyProviderId ? undefined : row.providerId ?? undefined;
  const reply = await invokeRemote(row.agentDeviceId, SUBSCRIPTION_ACCOUNTS_CHANNEL, [{
    action: 'session', providerId: provider,
    ...(row.sdkSessionId ? { nativeSessionId: row.sdkSessionId } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(legacyProviderId ? { legacyProviderId } : {}),
    ...(routeProviderId ? { routeProviderId } : {}),
  }], { preSend });
  assertOwner(state);
  const view = reply.ok ? parseSubscriptionSessionAccountView(reply.result, provider) : null;
  // Old hosts may ignore the alias field and report a blocked binding. Only the new explicit
  // destination admission permits changing a legacy task's saved source after its handoff.
  if (legacyProviderId && !view?.routeProviderId) return view?.replacementProviderId === 'openai'
    ? { number: view.state === 'bound' ? view.account.number : 0, paused: false, blocked: true, available: true,
      replacementProviderId: view.replacementProviderId }
    : null;
  // Older hosts ignore routeProviderId. Their kind-only reply cannot authorize changing a
  // created provider's native context; built-in routes retain their original compatibility path.
  const requestedRoute = routeProviderId ?? legacyProviderId;
  if (requestedRoute !== provider && view?.routeProviderId !== requestedRoute) return null;
  if (view?.routeProviderId !== undefined && view.routeProviderId !== requestedRoute) return null;
  if (view?.state === 'unavailable' && view.replacementProviderId)
    return { number: 0, paused: false, blocked: true, available: true, replacementProviderId: view.replacementProviderId };
  // Older hosts lack the query. Do not guess another computer's account from local state.
  if (view?.state !== 'bound') return null;
  const { number, paused } = view.account;
  const blocked = view.account.blocked === true;
  const replacement = view.replacementProviderId ? { replacementProviderId: view.replacementProviderId } : {};
  if (!paused || view.routeProviderId !== undefined) return { number, paused, blocked, ...replacement,
    available: (blocked || paused) && view.account.switchAvailable === true };
  if (!row.model) return { number, paused, blocked, available: false };
  const availableReply = await invokeRemote(row.agentDeviceId, 'maker:subscription-pool:quota',
    [provider, row.model], { preSend });
  assertOwner(state);
  const available = availableReply.ok
    ? availableReply.result as { providerId?: unknown; model?: unknown; available?: unknown } | null : null;
  return {
    number, paused, blocked,
    available: available?.providerId === provider && available.model === row.model && available.available === true,
  };
}

/**
 * Account failover for a same-account remote Agent task (subscription-account-pools.md 账号间自动换号):
 * a token for the executing computer's bound account when it cannot take the task model now and
 * that computer's pool can serve the model with another account; otherwise null. Read-only.
 */
export async function readRemoteSubscriptionAccountSwitch(
  row: RemoteTaskAccountRow,
  invokeRemote: RemoteSubscriptionInvoke,
): Promise<string | null> {
  const remote = await readRemoteSubscriptionAccountHandoff(row, invokeRemote);
  return remote?.available && (remote.blocked || remote.paused) ? `${row.agentDeviceId}#${remote.number}` : null;
}

/** Executor-confirmed destination for a saved source that was merged into another provider. */
export async function readRemoteSubscriptionAccountHandoff(
  row: RemoteTaskAccountRow,
  invokeRemote: RemoteSubscriptionInvoke,
): ReturnType<typeof readRemoteTaskAccount> {
  const standardProvider = taskSubscriptionProvider(row);
  const legacy = !standardProvider && !!row.providerId
    && row.providerId !== 'openai' && row.providerId !== 'anthropic'
    && ['codex', 'cc', 'claude-code', 'pi'].includes(row.agentKind);
  const provider = standardProvider ?? (legacy ? 'openai' : null);
  if (!provider || row.remoteHostId || !row.agentDeviceId || isProviderShareAgentDeviceId(row.agentDeviceId)
    || (!row.sdkSessionId && !legacy && row.providerId === provider) || !row.model) return null;
  const remote = await readRemoteTaskAccount(provider,
    { ...row, agentDeviceId: row.agentDeviceId, sdkSessionId: row.sdkSessionId }, invokeRemote);
  return remote;
}

/** Pre-send probe only: preserve native history bindings until the host has durably
 * handed off the transcript and starts a fresh context. Never reserve a task here. */
export async function needsSubscriptionAccountHandoff(
  sessionId: string,
  row: RemoteTaskAccountRow,
  invokeRemote?: RemoteSubscriptionInvoke,
): Promise<boolean> {
  if (row.remoteHostId || (row.agentDeviceId && isProviderShareAgentDeviceId(row.agentDeviceId))) return false;
  // Other computers resolve their own providers. Registered legacy targets can own several
  // accounts too; their source-switch admission is confirmed by the executing computer.
  const resolved = !row.agentDeviceId ? resolveSubscriptionPoolProvider(row.providerId) : null;
  const local = resolved;
  const provider = row.agentDeviceId
    ? taskSubscriptionProvider(row) ?? (row.providerId && ['codex', 'cc', 'claude-code', 'pi'].includes(row.agentKind) ? 'openai' : null)
    : local && (local.kind === 'openai' || ['cc', 'claude-code'].includes(row.agentKind)) ? local.kind : null;
  if (!provider) return false;
  if (row.agentDeviceId) {
    if (!row.sdkSessionId) return false;
    if (!invokeRemote) throw new Error('Remote subscription account query is not configured');
    const remote = await readRemoteTaskAccount(provider,
      { ...row, agentDeviceId: row.agentDeviceId, sdkSessionId: row.sdkSessionId }, invokeRemote);
    if (!remote) return false;
    // A paused account must not take the next turn: no replacement fails the send.
    if (remote.paused) {
      if (!remote.available) throw new Error('No subscription account is available');
      return true;
    }
    // A blocked account (usage limit, sign-in, overload) gives way only when that computer can
    // continue with another account; otherwise the message goes to the original account as before.
    return remote.blocked && remote.available;
  }
  const pool = readPool(provider);
  if (!pool) return false;
  const binding = readAccountBinding(`task:${sessionId}`, provider)
    ?? (row.sdkSessionId ? readAccountBinding(`native:${row.sdkSessionId}`, provider) : undefined);
  if (!binding && provider === 'openai' && !legacyCodexDefault(provider)) return false;
  // The user switched this task to another provider of this kind than its account was bound
  // through (2026-11-13; switching closes the runtime, see setModel). The next turn continues on
  // that provider's accounts with the handed-off context, unless its account already belongs there.
  if (binding && local && local.providerId !== (binding.via ?? provider)
    && accountProviderId(provider, binding.accountId) !== local.providerId) {
    // Fail before closing the old runtime if the new provider cannot serve the model.
    const candidate = await acquireSubscriptionAccount(local.providerId, row.model ?? undefined, [], false, { resuming: false });
    candidate?.release();
    return true;
  }
  const id = binding?.accountId ?? (row.sdkSessionId ? 'default' : undefined);
  if (!id || !pool.accounts.some(a => a.id === id && a.paused)) return false;
  // Pausing hands a task to another account of the provider that account belongs to now; a
  // provider with a single account (an independent one) has nowhere to hand it.
  const owner = accountProviderId(provider, id);
  if ((pool.disconnected && owner === provider) || providerAccounts(provider, pool.accounts, owner).length < 2) return false;
  // Fail before closing the old runtime if the remaining pool cannot serve the model.
  const candidate = await acquireSubscriptionAccount(owner, row.model ?? undefined, [], false, { resuming: false });
  candidate?.release();
  return true;
}

export interface SubscriptionAccountLease {
  account: NativeSubscriptionAccount;
  /** New turns must not reuse a disabled, renewing or unverified account. */
  assertDispatchable(): void;
  /** Pool account id (not the owner-scoped capability id). */
  accountId: string;
  /** Selected from an existing task binding or an explicit legacy route rather than by the pool policy. */
  pinned: boolean;
  /**
   * Records the failure like a provider group member (usage limit until reset, auth/overload
   * briefly) and returns whether the group policy would move this work to another member.
   */
  observeFailure(error: unknown, model: string | undefined, phase: 'start' | 'run'): boolean;
  changeModel(model: string, apply: () => Promise<void>): Promise<void>;
  bind(keys: string[]): Promise<void>;
  /** Transfer this reservation to a task until its next runtime takes over. */
  reserveForTask(taskId: string): void;
  running(active: boolean): void;
  release(): void;
}
/** Await status first; selection and reservation then happen in one synchronous segment. */
export async function acquireSubscriptionAccount(
  /** Any provider that owns accounts (placement.ts): built-in, created, or a legacy Codex connection. */
  providerId: string,
  model: string | undefined,
  keys: string[],
  control = false,
  options: {
    remote?: boolean;
    /** 远程调用来自自己的其他电脑(不是受邀者)：旧版导入的 Codex 账号也认「让我的其他电脑用本机模型」。 */
    ownComputer?: boolean;
    accountId?: string;
    resuming?: boolean;
    /** Accounts already tried for this start (provider group: each member at most once per round). */
    exclude?: ReadonlySet<string>;
    /** Only check that the policy can select an account (throws otherwise); reserve nothing, return null. */
    dryRun?: boolean;
  } = {},
): Promise<SubscriptionAccountLease | null> {
  const ref = resolveSubscriptionPoolProvider(providerId);
  if (!ref) return null;
  const provider = ref.kind;
  const pool = readPool(provider);
  if (!pool) return null;
  const state = currentRuntime();
  const bindings = keys.map((key) => readAccountBinding(key, provider)).filter(Boolean);
  let binding = bindings[0];
  // A stale caller may still carry the pre-switch native id. Never resume it in
  // the newly bound task account's home or overwrite its historical ownership.
  if (bindings.some(entry => entry?.accountId !== binding?.accountId))
    throw new Error('The task subscription account changed');
  // A task naming another provider of this kind than the one its account was bound through was
  // switched there by the user (2026-11-13). A task whose account was moved still names the provider
  // it was bound through and keeps following its account; so does one whose account already belongs
  // to the named provider. Otherwise a fresh native session picks within the named provider, and a
  // resume (its history lives in the old account's directory) stops instead of using the wrong one.
  if (binding && !options.accountId && ref.providerId !== (binding.via ?? provider)
    && accountProviderId(provider, binding.accountId) !== ref.providerId) {
    if (options.resuming !== false) throw new Error('The task subscription account changed');
    binding = undefined;
  }
  // A provider merged away with no accounts left keeps pinning its own account for old tasks.
  if (!binding && !options.accountId) {
    const own = pinnedOwnAccount(ref);
    if (own) options = { ...options, accountId: own };
  }
  // Accounts are chosen within one provider (placement.ts): the provider the task's account belongs
  // to now, or the provider this request names. A task follows its account; an account that belongs
  // to an independent connection again therefore never hands its task to another account.
  const pinnedTarget = options.accountId ?? binding?.accountId;
  const selectionProvider = pinnedTarget ? accountProviderId(provider, pinnedTarget) : ref.providerId;
  if (pool.disconnected && selectionProvider === provider) throw new Error('Subscription provider was disconnected');
  const scoped = providerAccounts(provider, pool.accounts, selectionProvider);
  const snapshots = await Promise.all(scoped.map((a) => snapshot(state, provider, a.id)));
  const needsModelMembership = provider === 'openai' && !control && !!model && options.resuming !== true;
  if (needsModelMembership) await refreshSubscriptionPoolCodexModels();
  // Remote access stores also wire share lifecycle dependencies. Load them only
  // for actual OpenAI selection, not while unrelated catalogs initialize.
  const legacyAccess = provider === 'openai' ? await import('./legacyAccountAccess.js') : null;
  assertOwner(state);
  // Settings may change while the official CLI is answering.
  const latest = readPool(provider);
  if (!latest || (latest.disconnected && selectionProvider === provider)) throw new Error('Subscription accounts changed');
  const group = providerAccounts(provider, latest.accounts, selectionProvider);
  expirePendingStarts(state);
  const pendingKey = !control ? keys.map(key => keyOf(provider, key)).find(key => state.pendingStarts.has(key)) : undefined;
  const pending = pendingKey ? state.pendingStarts.get(pendingKey) : undefined;
  const boundAccount = binding && latest.accounts.find(a => a.id === binding.accountId);
  const freshPausedBinding = options.resuming === false && !!binding
    && (!boundAccount || boundAccount.paused === true);
  // A fresh native session (handoff after a computer or account switch, a cleared task) carries no
  // history on the bound account. When that account cannot take this model now (remembered
  // failure, exhausted trusted quota or signed out), the pool policy picks another one, like a
  // paused binding; with nowhere else to go the task keeps its account and admission. Resumes and
  // explicit account routes (a legacy connection id pins its own account) never move here; an
  // `openai` task bound to an account merged from a legacy connection does (2026-11-13).
  const freshBlockedBinding = options.resuming === false && !control && !freshPausedBinding
    && !!boundAccount && !options.accountId
    && readSubscriptionAccountBlocked(provider, boundAccount.id, model);
  const buildMembers = (rebind: boolean) => group.map((a) => {
    const imported = provider === 'openai' ? readLegacyCodexProviderId(a.id) : undefined;
    const index = scoped.findIndex((p) => p.id === a.id);
    const info = snapshots[index];
    const usage = providerGroupMemberUsageState(
      info?.usage ?? {},
      provider === 'openai' ? model?.replace(/^chatgpt\//, '') : model,
      Date.now(),
      provider === 'openai' ? 'codex' : 'claude-code',
    );
    const loggingIn = [...state.logins].some(
      ([key, login]) => key.startsWith(provider + ':') && login.accountId === a.id,
    );
    return {
      ...a,
      paused: control ? false : a.paused,
      key: a.id,
      loggingIn,
      auth: info?.auth,
      unavailable: info?.unavailable,
      usage,
      // Like goal continuation, ChatGPT admission belongs to upstream: cached windows and
      // credits cannot establish whether this request can run. Keep quota ranking and real cooling.
      usable: !loggingIn && info?.auth.authenticated === true && (control || ((provider === 'openai' || !usage.limited)
        && ((Boolean(binding) && !rebind) || group.length < 2 || !accountCooling(state, provider, a.id, model))))
        && (!needsModelMembership || codexAccountSupportsModel(state, a.id, model))
        && (control || !imported || legacyAccess?.legacyCodexAccountCanRun(imported, model, {
          remote: options.remote === true, ownComputer: options.ownComputer === true,
          newRoute: (!binding || rebind) && !options.resuming,
        }) === true),
      running: state.running.get(keyOf(provider, a.id))?.size ?? 0,
      // Control leases reserve no slot. Pinned tasks never re-pick, so the limit only gates new assignments.
      limit: control ? Number.POSITIVE_INFINITY : effectiveConcurrencyLimit(a),
      urgency: usage.urgency,
      fiveHourTight: usage.fiveHourTight,
    };
  });
  // Reopening an old task without a recorded binding must keep its original default home.
  if (binding && options.accountId && binding.accountId !== options.accountId)
    throw new Error('The task subscription account changed');
  let members = buildMembers(freshPausedBinding || freshBlockedBinding);
  let pinned = (freshPausedBinding || freshBlockedBinding ? undefined : binding?.accountId) ?? options.accountId;
  const exclude = freshBlockedBinding
    ? new Set([...(options.exclude ?? []), boundAccount!.id])
    : options.exclude;
  let choice =
    pinned ??
    pickProviderGroupMember(members, providerStrategy(selectionProvider, provider, latest), {
      lastPicked: state.lastPicked.get(selectionProvider),
      ...(exclude ? { exclude } : {}),
    });
  if (freshBlockedBinding && !choice) {
    // Every other account is blocked, full or already tried: stay on the bound account.
    members = buildMembers(false);
    pinned = boundAccount!.id;
    choice = pinned;
  }
  const selected = choice;
  const member = members.find((a) => a.id === selected);
  const reserved = pending && pending.accountId === selected && state.running.get(keyOf(provider, pending.accountId))?.has(pending.token) ? 1 : 0;
  if (pending && member && member.running - reserved >= member.limit)
    throw new Error(SUBSCRIPTION_ACCOUNTS_FULL_ERROR);
  if (!selected && !pinned && providerGroupMembersFull(members, { exclude: options.exclude }))
    throw new Error(SUBSCRIPTION_ACCOUNTS_FULL_ERROR);
  if (!selected || !member || !member.usable || (!control && member.paused)) {
    if (!pinned) throw new Error('No subscription account is available');
    // Keep account affinity and admission unchanged; report the actual reason.
    // Do not include identity or configDir: errors also reach shared viewers.
    if (!member || member.unavailable || !member.auth || member.auth.errorReason === 'codex_provider_managed_auth')
      throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
    if (member.loggingIn)
      throw new Error('[SUBSCRIPTION_ACCOUNT_SIGNING_IN] The task subscription account is signing in');
    if (!member.auth.authenticated)
      throw new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login');
    if (!control && provider !== 'openai' && member.usage.limited) {
      const reset = member.usage.resetAtMs;
      throw new Error('[SUBSCRIPTION_ACCOUNT_LIMITED] The task subscription account is waiting for its usage window to reset'
        + (reset && Number.isFinite(reset) && reset > Date.now() ? `\nresetAtMs=${reset}` : ''));
    }
    throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account cannot be used for this request');
  }
  if (options.dryRun) return null;
  const token = randomUUID();
  const key = keyOf(provider, selected);
  const active = state.running.get(key) ?? new Set<string>();
  state.running.set(key, active);
  if (!control) {
    if (pending && pendingKey) {
      state.running.get(keyOf(provider, pending.accountId))?.delete(pending.token);
      state.pendingStarts.delete(pendingKey);
    }
    active.add(token);
    state.lastPicked.set(selectionProvider, selected);
    changed(provider);
  }
  let released = false;
  let handedOff = false;
  let currentModel = model;
  const assertCurrent = (targetModel = currentModel, modelSwitch = false) => {
    assertOwner(state);
    const current = readPool(provider);
    if (!current || disconnectedFor(current, provider, selected) || !current.accounts.some((a) => a.id === selected))
      throw new Error('Subscription account was disconnected');
    if (selected === 'default' && !defaultAccountBound(provider))
      throw new Error('Subscription account was disconnected');
    const imported = provider === 'openai' ? readLegacyCodexProviderId(selected) : undefined;
    if (imported && (options.remote || modelSwitch)
      && !legacyAccess?.legacyCodexAccountCanRun(imported, targetModel, {
        remote: options.remote === true, ownComputer: options.ownComputer === true, newRoute: false, modelSwitch,
      }))
      throw new Error(options.remote ? 'Subscription account remote access was revoked' : 'Subscription account does not allow this model');
  };
  return {
    assertDispatchable: () => {
      assertCurrent();
      const account = readPool(provider)?.accounts.find(a => a.id === selected);
      if (account?.paused)
        throw new Error('The task subscription account is disabled; retry to switch accounts');
      if ([...state.logins].some(([key, login]) => key.startsWith(provider + ':') && login.accountId === selected))
        throw new Error('[SUBSCRIPTION_ACCOUNT_SIGNING_IN] The task subscription account is signing in');
      if (provider === 'anthropic' && account?.reloginIdentity) {
        const confirmed = state.cache.get(keyOf(provider, selected));
        if (!confirmed?.auth.authenticated
          || confirmed.auth.identity?.trim().toLowerCase() !== account.reloginIdentity.toLowerCase())
          throw new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login');
      }
    },
    accountId: selected,
    pinned: pinned !== undefined,
    observeFailure(error, failedModel, phase) {
      try { assertCurrent(); } catch { return false; } // Ignore late failures after owner/account removal.
      const signals = providerGroupFailureSignals(error);
      const decision = decideProviderGroupFailure(signals, phase);
      if (decision.action !== 'switch') return false;
      // Same causes and durations as a group member (provider-groups.md §5 冷却): the task model
      // until its quota resets; login or overload failures cool the whole account briefly.
      if (!decision.cool) return true;
      const now = Date.now();
      const usageLimit = decision.cause === 'usage-limit';
      const resetAt = usageLimit ? readTurnUsageResetAt(signals, now) : null;
      const scope = usageLimit
        ? coolingScope(provider === 'openai' ? failedModel?.replace(/^chatgpt\//, '') : failedModel)
        : '';
      const scopes = currentCooling(state.quotaCooling.get(key), now);
      const until = !usageLimit
        ? now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS
        : resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS;
      // Refresh the scope's insertion order and bound remembered model failures.
      const previous = scopes[scope] ?? 0;
      delete scopes[scope];
      scopes[scope] = Math.max(previous, until);
      state.quotaCooling.set(key, Object.fromEntries(Object.entries(scopes).slice(-PROVIDER_GROUP_COOLING_SCOPE_CAP)));
      persistCooling(state);
      return true;
    },
    account: {
      id: `${accountOwnerPrefix()}:${provider}:${selected}`,
      configDir: directoryFor(provider, selected),
      defaultProfile: selected === 'default',
      assertCurrent,
      readState: async () => {
        assertCurrent();
        const result = await snapshot(state, provider, selected);
        assertCurrent();
        // Preserve read failure evidence for request-time auth checks. A failed
        // CLI read is not proof of logout and must not cool this account as auth.
        if (result.unavailable)
          throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
        return result.auth;
      },
      invalidateAuth: (reason, token) => {
        assertCurrent();
        state.invalidated.set(key, { token, reason });
        const cached = state.cache.get(key);
        if (cached)
          state.cache.set(key, {
            ...cached,
            auth: { ...cached.auth, authenticated: false, errorReason: reason },
            at: Date.now(),
          });
        changed(provider);
      },
      ...(provider === 'openai'
        ? {
            readCodexTokens: async (refresh?: boolean) => {
              assertCurrent();
              const tokens = await readNativeCodexTokens(directoryFor(provider, selected), refresh);
              assertCurrent();
              return {
                ...tokens,
                canDispatch: () => {
                  try {
                    assertCurrent();
                    return (
                      (!state.invalidated.has(key) ||
                        state.invalidated.get(key)?.token !== tokens.accessToken) &&
                      (tokens.canDispatch?.() ?? true)
                    );
                  } catch {
                    return false;
                  }
                },
              };
            },
          }
        : {}),
    },
    changeModel: async (nextModel, apply) => {
      if (provider === 'openai' && !control && !readLegacyCodexProviderId(selected)) {
        await snapshot(state, provider, selected);
        await refreshSubscriptionPoolCodexModels();
        if (!codexAccountSupportsModel(state, selected, nextModel))
          throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account does not offer this model');
      }
      assertCurrent(nextModel, true);
      const previous = currentModel;
      currentModel = nextModel;
      try {
        await apply();
      } catch (error) {
        currentModel = previous;
        throw error;
      }
      // A successful switch must keep the new model even if its grant was
      // revoked during the operation; all later sends must fail against it.
      assertCurrent();
    },
    bind: async (ids) => {
      assertCurrent();
      await writeAccountBindings(ids, provider, selected, ref.providerId);
      assertCurrent();
    },
    reserveForTask: (taskId) => {
      assertCurrent();
      if (released || control || readAccountBinding(`task:${taskId}`, provider)?.accountId !== selected)
        throw new Error('Cannot transfer the subscription account reservation');
      const taskKey = keyOf(provider, `task:${taskId}`);
      const previous = state.pendingStarts.get(taskKey);
      if (previous) state.running.get(keyOf(provider, previous.accountId))?.delete(previous.token);
      active.add(token);
      state.pendingStarts.set(taskKey, { accountId: selected, token, until: Date.now() + PROVIDER_GROUP_LOCAL_PROVISIONAL_MS });
      handedOff = true;
    },
    running: (value) => {
      const wasActive = active.has(token);
      if (!released) {
        if (value) active.add(token);
        else active.delete(token);
      }
      if (wasActive !== active.has(token)) {
        changed(provider);
      }
    },
    release: () => {
      released = true;
      if (!handedOff && active.delete(token)) changed(provider);
    },
  };
}

export async function runSubscriptionAccountCommand(
  command: SubscriptionAccountCommand,
): Promise<SubscriptionPoolView> {
  const state = currentRuntime();
  assertOwner(state);
  const ref = resolveSubscriptionPoolProvider(command.providerId);
  if (!ref) throw new Error('Unknown subscription provider');
  // `provider` is the pool kind (CLI, directories, bindings); `owned` is the provider whose own
  // accounts this command manages (placement.ts, 2026-11-13).
  const provider = ref.kind;
  const owned = ref.providerId;
  if (command.action === 'read') return readSubscriptionPool(owned, false, command.taskId);
  if (command.action === 'preview') return readSubscriptionPool(provider, true);
  if (command.action === 'cancel') {
    state.logins.get(`${provider}:${command.loginKey}`)?.abort.abort();
    return readSubscriptionPool(owned);
  }
  // A provider manages only its own accounts. An account that belongs to another provider is
  // paused, signed in, moved or removed through that provider.
  const target = command.action === 'configure' || command.action === 'remove' || command.action === 'login'
    || command.action === 'place' ? command.accountId : undefined;
  if (target && accountProviderId(provider, target) !== owned) throw new Error('Account not found');
  if (command.action === 'place' || command.action === 'merge' || command.action === 'remove-provider') {
    await changeAccountPlacement(state, ref, command);
    assertOwner(state);
    changed(provider);
    // A deleted provider no longer resolves; answer with the built-in one of its kind.
    return readSubscriptionPool(command.action === 'merge' ? command.target
      : command.action === 'place' && command.target ? command.target
        : command.action === 'remove-provider' ? provider : owned);
  }
  let resultProviderId = owned;
  if (command.action === 'configure') {
    if (command.strategy && owned !== provider) await writeProviderStrategy(owned, command.strategy);
    await updatePool(provider, (pool) => ({
      ...pool,
      ...(command.strategy && owned === provider ? { strategy: command.strategy } : {}),
      accounts: pool.accounts.map((a) =>
        a.id !== command.accountId
          ? a
          : {
              ...a,
              ...(command.paused !== undefined ? { paused: command.paused } : {}),
              ...(command.limit !== undefined ? concurrencyLimitPatch(command.limit) : {}),
              ...(command.weight !== undefined ? { weight: command.weight } : {}),
            },
      ),
    }));
    assertOwner(state);
    const imported = provider === 'openai' && command.accountId ? readLegacyCodexProviderId(command.accountId) : undefined;
    // A legacy connection that now hosts other accounts has a provider-wide switch of its own.
    // Pausing its original account must not disable those other accounts as well.
    const importedMembers = imported ? providerAccounts(provider, readPool(provider)?.accounts ?? [], imported) : [];
    if (imported && command.paused !== undefined && !importedMembers.some(account => account.id !== command.accountId)) {
      const { setLegacyCodexAccountPaused } = await import('./legacyAccountAccess.js');
      assertOwner(state);
      setLegacyCodexAccountPaused(imported, command.paused);
    }
  } else if (command.action === 'remove') {
    if (command.accountId === 'default')
      throw new Error('The default CLI account cannot be removed');
    if (state.running.get(keyOf(provider, command.accountId))?.size)
      throw new Error('Account is in use');
    if ([...state.logins.values()].some((login) => login.accountId === command.accountId))
      throw new Error('login_in_progress');
    await updatePool(provider, (pool) => ({
      ...pool,
      accounts: pool.accounts.filter((a) => a.id !== command.accountId),
    }));
    state.cache.delete(keyOf(provider, command.accountId));
    state.quotaCooling.delete(keyOf(provider, command.accountId));
    await clearSubscriptionAccountCooling(provider, command.accountId);
  } else {
    const initial = readPool(provider);
    const adding = command.action === 'add' || command.action === 'connect' || command.action === 'create';
    // The CLI default login always belongs to the built-in provider: only an Add to the built-in
    // provider may attach it; a separate provider and other providers always use a new directory.
    const builtinAdd = command.action === 'add' && owned === provider;
    const useDefault =
      command.action === 'connect'
        ? command.target === 'default'
        : builtinAdd &&
          (!initial || initial.accounts.every((a) => a.id === 'default')) &&
          !defaultAccountBound(provider);
    let accountId = adding
      ? useDefault
        ? 'default'
        : `cindy-${accountOwnerPrefix()}-${randomUUID()}`
      : command.accountId;
    // Native browser logins may share a callback port. Reserve before the first await.
    if ([...state.logins.keys()].some((key) => key.startsWith(provider + ':')))
      throw new Error('login_in_progress');
    if (state.running.get(keyOf(provider, accountId))?.size) throw new Error('Account is in use');
    const abort = new AbortController();
    const key = `${provider}:${command.loginKey}`;
    state.logins.set(key, { abort, accountId });
    let createdProviderId: string | undefined;
    if (provider === 'openai') publishCodexCatalogChange(state);
    try {
      if (
        builtinAdd &&
        (!initial || initial.accounts.every((a) => a.id === 'default'))
      ) {
        // Explicit Add may inspect an unbound default, while ordinary snapshots
        // intentionally hide its native auth until the user connects it.
        const firstAuth = useDefault
          ? await (legacyCodexDefault(provider)
              ? readLegacyCodexAccount()
              : readNativeAccount(provider, directoryFor(provider, 'default')))
          : (await snapshot(state, provider, 'default', true)).auth;
        assertOwner(state);
        if (abort.signal.aborted) throw new Error('login_cancelled');
        if (firstAuth.errorReason === 'codex_provider_managed_auth') {
          if (accountId === 'default') accountId = `cindy-${accountOwnerPrefix()}-${randomUUID()}`;
        } else if (!firstAuth.authenticated) {
          accountId = 'default';
        }
        state.logins.set(key, { abort, accountId });
        if (state.running.get(keyOf(provider, accountId))?.size)
          throw new Error('Account is in use');
      }
      // Record where a new account belongs before it joins the pool, so it never shows up in (or is
      // assigned by) the built-in provider in between (subscription-account-pools.md 合并与拿出).
      if (command.action === 'create') {
        createdProviderId = await createSubscriptionProvider(
          provider, accountId, providerBrandName(provider), () => randomUUID().replaceAll('-', '').slice(0, 8),
        );
        assertOwner(state);
      } else if (command.action === 'add' && owned !== provider) {
        await placeSubscriptionAccount(provider, accountId, owned);
        assertOwner(state);
      }
      if (adding) {
        await updatePool(provider, (pool) => {
          if (pool.accounts.length >= MAX_SUBSCRIPTION_ACCOUNTS && !pool.accounts.some((a) => a.id === accountId))
            throw new Error('Too many subscription accounts');
          return {
            ...pool,
            accounts: pool.accounts.some((a) => a.id === accountId)
              ? pool.accounts
              : [...pool.accounts, { ...DEFAULT_SUBSCRIPTION_ACCOUNT, id: accountId }],
          };
        });
      } else {
        await updatePool(provider, (pool) => {
          if (!pool.accounts.some((a) => a.id === accountId)) throw new Error('Account not found');
          return pool;
        });
      }
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      const directory = directoryFor(provider, accountId);
      if (provider === 'openai') state.codexModels.delete(accountId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      // Only an explicit default-account choice (or legacy Add) may attach the
      // detected login. "New" always uses a fresh, host-generated directory.
      const legacy = accountId === 'default' && legacyCodexDefault(provider);
      const renewClaude = provider === 'anthropic' && command.action === 'login';
      const currentAuth =
        (adding && accountId === 'default') || (provider === 'openai' && !legacy) || renewClaude
          ? await (legacy
              ? readLegacyCodexAccount()
              : readNativeAccount(provider, directory))
          : undefined;
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      if (currentAuth?.errorReason === 'codex_provider_managed_auth')
        throw new Error('codex_provider_managed_auth');
      // Derive identity on the execution computer; the caller only supplies the account ID.
      const savedAccount = readPool(provider)?.accounts.find((account) => account.id === accountId);
      const expectedEmail = renewClaude
        ? savedAccount?.reloginIdentity
          ?? savedAccount?.lastConfirmedIdentity
          ?? state.cache.get(keyOf(provider, accountId))?.auth.identity
          ?? currentAuth?.identity
        : undefined;
      if (renewClaude && !expectedEmail?.trim()) throw new Error('account_identity_unknown');
      if (expectedEmail) {
        await updatePool(provider, (pool) => ({
          ...pool,
          accounts: pool.accounts.map((account) => account.id === accountId
            ? { ...account, reloginIdentity: expectedEmail } : account),
        }));
        assertOwner(state);
        if (abort.signal.aborted) throw new Error('login_cancelled');
      }
      const attachDefault = adding && accountId === 'default' && currentAuth?.authenticated;
      if (!attachDefault) {
        const imported = provider === 'openai' ? readLegacyCodexProviderId(accountId) : undefined;
        if (imported) await loginLegacyCodexProviderAccount(imported, abort.signal);
        else if (accountId === 'default' && legacyCodexDefault(provider))
          await loginLegacyCodexAccount(abort.signal);
        else if (renewClaude)
          await loginNativeAccount(provider, directory, abort.signal, { renew: true, expectedEmail });
        else await loginNativeAccount(provider, directory, abort.signal);
      }
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      if (accountId === 'default' && !legacyCodexDefault(provider))
        bindNativeProviderAuth(provider, { sharedSystem: true });
      // Do not let a pre-login read land after the post-login identity check.
      await state.flights.get(keyOf(provider, accountId))?.promise.catch(() => {});
      assertOwner(state);
      state.cache.delete(keyOf(provider, accountId));
      // Codex's previous rejected credential must not invalidate the newly logged-in account.
      state.invalidated.delete(keyOf(provider, accountId));
      const verified = await snapshot(state, provider, accountId, true);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      if (expectedEmail) {
        if (verified.auth.errorReason === 'account_mismatch') throw new Error('account_mismatch');
        if (!verified.auth.authenticated) throw new Error('login_failed');
        await updatePool(provider, (pool) => ({
          ...pool,
          accounts: pool.accounts.map((account) => {
            if (account.id !== accountId) return account;
            const { reloginIdentity: _expected, ...confirmed } = account;
            return confirmed;
          }),
        }));
        assertOwner(state);
      }
      // Signing in reconnects only the built-in provider's own switch.
      if (accountProviderId(provider, accountId) === provider)
        await updatePool(provider, (pool) => ({ ...pool, disconnected: false }));
      assertOwner(state);
      state.quotaCooling.delete(keyOf(provider, accountId));
      await clearSubscriptionAccountCooling(provider, accountId);
      assertOwner(state);
      // A separate provider is named after its account once the official CLI confirms who it is.
      if (createdProviderId && verified.auth.identity?.trim()) {
        await renameCreatedSubscriptionProvider(createdProviderId,
          `${providerBrandName(provider)} · ${verified.auth.identity.trim()}`);
        assertOwner(state);
      }
    } catch (error) {
      // The CLI owns its credentials even on failure/cancel. Re-read only this slot;
      // its persisted identity guard prevents a wrong account becoming usable later.
      await state.flights.get(keyOf(provider, accountId))?.promise.catch(() => {});
      state.cache.delete(keyOf(provider, accountId));
      // A separate provider whose first sign-in did not finish is not created: its account leaves
      // the pool (the CLI directory and any login stay), so no empty provider remains.
      if (adding && accountId !== 'default' && !initial?.accounts.some(account => account.id === accountId)
        && state.owner === activeOwnerScopeKey()) {
        await updatePool(provider, (pool) => ({
          ...pool, accounts: pool.accounts.filter((account) => account.id !== accountId),
        })).catch(() => {});
        await discardUnusedSubscriptionAccountPlacement(provider, accountId).catch(() => {});
        if (createdProviderId) await deleteCreatedSubscriptionProvider(createdProviderId).catch(() => {});
      }
      if (state.owner === activeOwnerScopeKey()) changed(provider);
      throw error;
    } finally {
      state.logins.delete(key);
    }
    if (createdProviderId) resultProviderId = createdProviderId;
  }
  assertOwner(state);
  const view = await readSubscriptionPool(resultProviderId);
  changed(provider);
  return view;
}

/** Display name of a provider's brand; a created provider is renamed after its account. */
function providerBrandName(kind: SubscriptionProvider): string {
  return kind === 'anthropic' ? 'Claude' : 'OpenAI';
}

/**
 * Move accounts between providers of one kind (subscription-account-pools.md 合并与拿出由用户决定).
 * Only the record of where an account belongs changes: directories, logins, task bindings and
 * native histories stay, so running tasks are untouched and tasks follow their account.
 */
async function changeAccountPlacement(
  state: OwnerRuntime,
  ref: SubscriptionPoolProviderRef,
  command: Extract<SubscriptionAccountCommand, { action: 'place' | 'merge' | 'remove-provider' }>,
): Promise<void> {
  const kind = ref.kind;
  const pool = readPool(kind);
  if (!pool) throw new Error('Account not found');
  const destination = (providerId: string) => {
    const target = resolveSubscriptionPoolProvider(providerId);
    if (!target || target.kind !== kind) throw new Error('Unknown subscription provider');
    return target.providerId;
  };
  if (command.action === 'place') {
    if (command.target !== null) {
      await placeSubscriptionAccount(kind, command.accountId, destination(command.target));
      return;
    }
    // Taking an account out returns it to the provider it was made with, or gives it its own.
    const own = accountOwnProvider(kind, command.accountId);
    const { copyProviderDisableOverrides } = await import('../maker-host/model-disable-store.js');
    assertOwner(state);
    if (own && own !== kind && own !== ref.providerId) {
      copyProviderDisableOverrides(ref.providerId, own);
      await placeSubscriptionAccount(kind, command.accountId, own);
      return;
    }
    if (ref.providerId !== kind && providerAccounts(kind, pool.accounts, ref.providerId).length < 2)
      throw new Error('The account already has its own provider');
    const identity = state.cache.get(keyOf(kind, command.accountId))?.auth.identity?.trim()
      ?? pool.accounts.find((account) => account.id === command.accountId)?.lastConfirmedIdentity;
    await createSubscriptionProvider(kind, command.accountId,
      identity ? `${providerBrandName(kind)} · ${identity}` : providerBrandName(kind),
      () => randomUUID().replaceAll('-', '').slice(0, 8),
      (providerId) => copyProviderDisableOverrides(ref.providerId, providerId));
    return;
  }
  const accounts = providerAccounts(kind, pool.accounts, ref.providerId);
  if (command.action === 'merge') {
    const target = destination(command.target);
    if (target === ref.providerId) throw new Error('Unknown subscription provider');
    // The built-in provider holds the CLI default login and is never merged away as a whole, even
    // when its pool has no default account (a pool migrated without one); move accounts instead.
    if (ref.providerId === kind) throw new Error('The built-in provider cannot be merged into another provider');
    if (accounts.some((account) => account.id === 'default')) throw new Error('The default CLI account cannot be moved');
    for (const account of accounts) await placeSubscriptionAccount(kind, account.id, target);
    return;
  }
  // Deleting a created provider stops using its accounts; their CLI logins and histories stay.
  if (!ref.created) throw new Error('Only providers created for subscription accounts can be deleted here');
  if (accounts.some((account) => state.running.get(keyOf(kind, account.id))?.size)) throw new Error('Account is in use');
  const removed = new Set(accounts.map((account) => account.id));
  await updatePool(kind, (current) => ({
    ...current, accounts: current.accounts.filter((account) => !removed.has(account.id)),
  }));
  for (const id of removed) {
    state.cache.delete(keyOf(kind, id));
    state.quotaCooling.delete(keyOf(kind, id));
    await clearSubscriptionAccountCooling(kind, id);
  }
  // The provider leaves the catalog; tasks that named it show the source as unavailable.
  await deleteCreatedSubscriptionProvider(ref.providerId);
}

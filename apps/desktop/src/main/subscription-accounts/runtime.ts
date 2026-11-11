import { randomUUID } from 'node:crypto';
import { getCodexHome } from '../maker-host/codex-home-path.js';
import { mkdir } from 'node:fs/promises';
import { type AuthState, type NativeSubscriptionAccount } from '@cindy/maker-core';
import { matchScopedWindowForModel } from '@cindy/maker-shared/subscription-usage';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderAuthSharedSystemCredential,
} from '../maker-host/nativeProviderAuthBinding.js';
import { pickProviderGroupMember } from '../provider-group/scheduler.js';
import { providerGroupMemberUsageState } from '../provider-group/usage.js';
import { coolingScope, currentCooling, PROVIDER_GROUP_COOLING_SCOPE_CAP } from '../provider-group/cooling.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS } from '../provider-group/router.js';
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
} from '../../shared/subscriptionAccounts.js';
import {
  accountDirectory,
  accountOwnerPrefix,
  defaultPool,
  readPool,
  readLegacyCodexProviderId,
  readAccountBinding,
  updatePool as updateStoredPool,
  writeAccountBindings,
} from './store.js';
import {
  loginNativeAccount,
  readNativeAccount,
  readNativeAccountUsage,
  readNativeCodexTokens,
  readLegacyCodexAccount,
  loginLegacyCodexAccount,
  readLegacyCodexProviderAccount,
  loginLegacyCodexProviderAccount,
} from './nativeCli.js';

type Usage = {
  claudeUsage?: ReturnType<typeof parseClaudeSdkRateLimitInfo>;
  codexUsage?: ReturnType<typeof providerGroupCodexUsageFromReads>;
  codexCredits?: NonNullable<SubscriptionAccountUsage['codex']>['credits'];
};
interface AccountSnapshot {
  auth: AuthState & { plan?: string };
  usage?: Usage;
  unavailable?: boolean;
  at: number;
  usageAt?: number;
}
interface OwnerRuntime {
  owner: string;
  cache: Map<string, AccountSnapshot>;
  flights: Map<string, Promise<AccountSnapshot>>;
  running: Map<string, Set<string>>;
  lastPicked: Map<SubscriptionProvider, string>;
  logins: Map<string, { abort: AbortController; accountId: string }>;
  invalidated: Map<string, { token: string; reason: string }>;
  /** Actual account failures outrank optimistic cached quota for new assignments. */
  quotaCooling: Map<string, Record<string, number>>;
}
let runtime: OwnerRuntime | undefined;
const listeners = new Set<(providerId: SubscriptionProvider) => void>();
export function onSubscriptionAccountsChanged(
  listener: (providerId: SubscriptionProvider) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(provider: SubscriptionProvider) {
  for (const listener of listeners) {
    try {
      listener(provider);
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
      lastPicked: new Map(),
      logins: new Map(),
      invalidated: new Map(),
      quotaCooling: new Map(),
    };
  }
  return runtime;
}
const keyOf = (provider: SubscriptionProvider, id: string) => `${provider}:${id}`;
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
): Promise<AccountSnapshot> {
  assertOwner(state);
  const key = keyOf(provider, id);
  const cached = state.cache.get(key);
  if (!force && cached && Date.now() - cached.at < 30_000) return cached;
  const pending = state.flights.get(key);
  if (pending) return pending;
  const directory = directoryFor(provider, id);
  const flight = (async (): Promise<AccountSnapshot> => {
    let result: AccountSnapshot;
    if (id === 'default' && !defaultAccountBound(provider)) {
      result = { auth: { authenticated: false }, at: Date.now() };
    } else {
      try {
        const imported = provider === 'openai' ? readLegacyCodexProviderId(id) : undefined;
        let auth = imported
          ? await readLegacyCodexProviderAccount(imported, directory)
          : id === 'default' && legacyCodexDefault(provider)
            ? await readLegacyCodexAccount()
            : await readNativeAccount(provider, directory);
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
          auth,
          usage,
          at: Date.now(),
          usageAt: reuseUsage ? current?.usageAt
            : eventDuringRead && usage === latest?.usage ? latest?.usageAt : Date.now(),
        };
      } catch {
        result = { auth: { authenticated: false }, unavailable: true, at: Date.now() };
      }
    }
    assertOwner(state);
    state.cache.set(key, result);
    return result;
  })();
  state.flights.set(key, flight);
  void flight
    .finally(() => {
      state.flights.delete(key);
    })
    .catch(() => {});
  return flight;
}

/** Read-only cached aggregate for provider catalog/auth gates; no account identity leaves it. */
export function hasConnectedSubscriptionPool(provider: SubscriptionProvider): boolean {
  const pool = readPool(provider);
  if (!pool || pool.disconnected) return false;
  const state = currentRuntime();
  return pool.accounts.some((a) => state.cache.get(keyOf(provider, a.id))?.auth.authenticated);
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
  provider: SubscriptionProvider,
): Promise<SubscriptionPoolView> {
  return readSubscriptionPool(provider);
}
/** Outer groups see the next usable account's quota, not an exhausted default.
 * No identity, directory, credentials, or account identifiers cross this boundary.
 */
export function readLegacySubscriptionPoolUsage(provider: SubscriptionProvider): Promise<Usage | null | undefined> {
  const pool = readPool(provider);
  // One ordinary default account keeps its original native/web usage readers.
  if (!pool || (!pool.disconnected && pool.accounts.length === 1
    && pool.accounts[0].id === 'default' && !pool.accounts[0].paused))
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
    return pool && !pool.disconnected && pool.accounts.some(a => a.id === binding.accountId)
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

/** A positive result can retire a member/model cooldown, so unknown quota is
 * not enough. This never selects/binds an account or changes an existing task. */
export async function readSubscriptionPoolModelAvailability(
  provider: SubscriptionProvider,
  model: string,
  options: { remote?: boolean } = {},
): Promise<boolean | null> {
  const pool = readPool(provider);
  if (!pool || pool.accounts.length < 2) return null;
  if (pool.disconnected) return false;
  const state = currentRuntime();
  const infos = await Promise.all(pool.accounts.map((a) => snapshot(state, provider, a.id)));
  // Match new-account allocation without loading remote-access dependencies for
  // unrelated providers. Check current grants after the asynchronous quota read.
  const legacyAccess = provider === 'openai' ? await import('./legacyAccountAccess.js') : null;
  assertOwner(state);
  const latest = readPool(provider);
  if (!latest || latest.disconnected) return false;
  return latest.accounts.some((account) => {
    const info = infos[pool.accounts.findIndex((a) => a.id === account.id)];
    if (account.paused || !info?.auth.authenticated || info.unavailable
      || accountCooling(state, provider, account.id, model)
      || [...state.logins].some(([key, login]) => key.startsWith(provider + ':') && login.accountId === account.id)
      || (account.id === 'default' && !defaultAccountBound(provider))) return false;
    const imported = provider === 'openai' ? readLegacyCodexProviderId(account.id) : undefined;
    if (imported && !legacyAccess?.legacyCodexAccountCanRun(imported, model, {
      remote: options.remote === true, newRoute: true,
    })) return false;
    const usage = providerGroupMemberUsageState(info.usage ?? {},
      provider === 'openai' ? model.replace(/^chatgpt\//, '') : model,
      Date.now(), provider === 'openai' ? 'codex' : 'claude-code');
    return !usage.limited && usage.quota !== null;
  });
}

/**
 * The account an existing task is pinned to, for the task's usage display (model list and
 * the usage under the composer). Bindings are looked up in the same order a resume uses, so the
 * display never names the default or the next pool pick instead of the task's own account.
 */
export async function readSubscriptionSessionAccount(
  provider: SubscriptionProvider,
  keys: { sessionId?: string; nativeSessionId?: string },
): Promise<SubscriptionSessionAccountView> {
  const state = currentRuntime();
  assertOwner(state);
  const pool = readPool(provider);
  if (!pool) return { providerId: provider, state: 'legacy' };
  const binding = [
    keys.sessionId ? `task:${keys.sessionId}` : '',
    keys.nativeSessionId ? `native:${keys.nativeSessionId}` : '',
  ]
    .filter(Boolean)
    .map((key) => readAccountBinding(key, provider))
    .find(Boolean);
  // With only the ordinary CLI default, the original readers are the task's account.
  const onlyDefault =
    !pool.disconnected && pool.accounts.length === 1 && pool.accounts[0].id === 'default';
  // A pre-pool task resumes on the default account; a task that never ran is assigned next turn.
  if (!binding)
    return {
      providerId: provider,
      state: onlyDefault || keys.nativeSessionId ? 'legacy' : 'unassigned',
    };
  if (onlyDefault && binding.accountId === 'default')
    return { providerId: provider, state: 'legacy' };
  const index = pool.accounts.findIndex((a) => a.id === binding.accountId);
  if (
    pool.disconnected ||
    index < 0 ||
    (binding.accountId === 'default' && !defaultAccountBound(provider))
  )
    return { providerId: provider, state: 'unavailable' };
  const config = pool.accounts[index];
  const info = await snapshot(state, provider, config.id);
  assertOwner(state);
  const usage = providerGroupMemberUsageState(
    info.usage ?? {},
    undefined,
    Date.now(),
    provider === 'openai' ? 'codex' : 'claude-code',
  );
  return {
    providerId: provider,
    state: 'bound',
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
    },
  };
}

export async function readSubscriptionPoolUsage(
  provider: SubscriptionProvider,
): Promise<Usage | null | undefined> {
  const pool = readPool(provider);
  if (!pool) return undefined;
  if (pool.disconnected) return null;
  const state = currentRuntime();
  const infos = await Promise.all(pool.accounts.map((a) => snapshot(state, provider, a.id)));
  assertOwner(state);
  const now = Date.now();
  const choose = (
    usageOf: (info: AccountSnapshot) => ReturnType<typeof providerGroupMemberUsageState>,
  ) => {
    const members = pool.accounts.map((a, i) => {
      const usage = usageOf(infos[i]);
      return {
        ...a,
        key: a.id,
        usable: infos[i].auth.authenticated && !usage.limited,
        running: state.running.get(keyOf(provider, a.id))?.size ?? 0,
        urgency: usage.urgency,
        fiveHourTight: usage.fiveHourTight,
      };
    });
    const id = pickProviderGroupMember(members, pool.strategy, {
      lastPicked: state.lastPicked.get(provider),
    });
    return id
      ? pool.accounts.findIndex((a) => a.id === id)
      : pool.accounts.findIndex((a, i) => !a.paused && infos[i].auth.authenticated);
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
  provider: SubscriptionProvider,
): Promise<Array<{ isDefault: boolean; usage: Usage | undefined }> | undefined> {
  const pool = readPool(provider);
  if (!pool || pool.disconnected) return undefined;
  const state = currentRuntime();
  const accounts = pool.accounts.filter((account) => !account.paused);
  const infos = await Promise.all(accounts.map((a) => snapshot(state, provider, a.id)));
  assertOwner(state);
  return accounts.flatMap((account, index) =>
    infos[index].auth.authenticated
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
export async function readSubscriptionPool(
  provider: SubscriptionProvider,
  previewDefault = false,
  taskId?: string,
): Promise<SubscriptionPoolView> {
  const state = currentRuntime();
  const pool = readPool(provider) ?? defaultPool();
  const accounts = await Promise.all(
    pool.accounts.map(async (account) => {
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
        : await snapshot(state, provider, account.id);
      const usage = providerGroupMemberUsageState(
        info.usage ?? {},
        undefined,
        Date.now(),
        provider === 'openai' ? 'codex' : 'claude-code',
      );
      return {
        ...account,
        directory: directoryFor(provider, account.id),
        ...(account.id === 'default' && legacyCodexDefault(provider) ? { legacy: true } : {}),
        identity: info.auth.identity,
        plan: info.auth.plan,
        ...(info.auth.errorReason === 'codex_provider_managed_auth'
          ? { authIssue: 'codex-provider-managed-auth' as const }
          : {}),
        status:
          pool.disconnected && !preview
            ? ('signed-out' as const)
            : info.unavailable
              ? ('unavailable' as const)
              : !info.auth.authenticated
                ? ('signed-out' as const)
                : usage.limited
                  ? ('limited' as const)
                  : ('ready' as const),
        running: state.running.get(keyOf(provider, account.id))?.size ?? 0,
        ...(!pool.disconnected && info.auth.authenticated ? accountUsage(info.usage) : {}),
      };
    }),
  );
  assertOwner(state);
  return {
    providerId: provider,
    configured: readPool(provider) !== null,
    strategy: pool.strategy,
    ...(taskId ? { boundAccountId: readAccountBinding(`task:${taskId}`, provider)?.accountId ?? null } : {}),
    accounts,
  };
}

export interface SubscriptionAccountLease {
  account: NativeSubscriptionAccount;
  /** New turns must not reuse an account explicitly disabled by the user. */
  assertDispatchable(): void;
  observeFailure(error: unknown, model: string | undefined, phase: 'start' | 'run'): void;
  changeModel(model: string, apply: () => Promise<void>): Promise<void>;
  bind(keys: string[]): Promise<void>;
  running(active: boolean): void;
  release(): void;
}
/** Await status first; selection and reservation then happen in one synchronous segment. */
export async function acquireSubscriptionAccount(
  provider: SubscriptionProvider,
  model: string | undefined,
  keys: string[],
  control = false,
  options: { remote?: boolean; accountId?: string; resuming?: boolean } = {},
): Promise<SubscriptionAccountLease | null> {
  const pool = readPool(provider);
  if (!pool) return null;
  if (pool.disconnected) throw new Error('Subscription provider was disconnected');
  const state = currentRuntime();
  const bindings = keys.map((key) => readAccountBinding(key, provider)).filter(Boolean);
  const binding = bindings[0];
  // A stale caller may still carry the pre-switch native id. Never resume it in
  // the newly bound task account's home or overwrite its historical ownership.
  if (bindings.some(entry => entry?.accountId !== binding?.accountId))
    throw new Error('The task subscription account changed');
  const snapshots = await Promise.all(pool.accounts.map((a) => snapshot(state, provider, a.id)));
  // Remote access stores also wire share lifecycle dependencies. Load them only
  // for actual OpenAI selection, not while unrelated catalogs initialize.
  const legacyAccess = provider === 'openai' ? await import('./legacyAccountAccess.js') : null;
  assertOwner(state);
  // Settings may change while the official CLI is answering.
  const latest = readPool(provider);
  if (!latest || latest.disconnected) throw new Error('Subscription accounts changed');
  const members = latest.accounts.map((a) => {
    const imported = provider === 'openai' ? readLegacyCodexProviderId(a.id) : undefined;
    const index = pool.accounts.findIndex((p) => p.id === a.id);
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
      usable: !loggingIn && info?.auth.authenticated === true && (control || (!usage.limited
        && (Boolean(binding) || latest.accounts.length < 2 || !accountCooling(state, provider, a.id, model))))
        && (control || !imported || legacyAccess?.legacyCodexAccountCanRun(imported, model, {
          remote: options.remote === true, newRoute: !binding && !options.resuming,
        }) === true),
      running: state.running.get(keyOf(provider, a.id))?.size ?? 0,
      urgency: usage.urgency,
      fiveHourTight: usage.fiveHourTight,
    };
  });
  // Reopening an old task without a recorded binding must keep its original default home.
  if (binding && options.accountId && binding.accountId !== options.accountId)
    throw new Error('The task subscription account changed');
  const pinned = binding?.accountId ?? options.accountId;
  const selected =
    pinned ??
    pickProviderGroupMember(members, latest.strategy, {
      lastPicked: state.lastPicked.get(provider),
    });
  const member = members.find((a) => a.id === selected);
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
    if (!control && member.usage.limited) {
      const reset = member.usage.resetAtMs;
      throw new Error('[SUBSCRIPTION_ACCOUNT_LIMITED] The task subscription account is waiting for its usage window to reset'
        + (reset && Number.isFinite(reset) && reset > Date.now() ? `\nresetAtMs=${reset}` : ''));
    }
    throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account cannot be used for this request');
  }
  const token = randomUUID();
  const key = keyOf(provider, selected);
  const active = state.running.get(key) ?? new Set<string>();
  state.running.set(key, active);
  if (!control) {
    active.add(token);
    state.lastPicked.set(provider, selected);
    changed(provider);
  }
  let released = false;
  let currentModel = model;
  const assertCurrent = (targetModel = currentModel, modelSwitch = false) => {
    assertOwner(state);
    const current = readPool(provider);
    if (current?.disconnected || !current?.accounts.some((a) => a.id === selected))
      throw new Error('Subscription account was disconnected');
    if (selected === 'default' && !defaultAccountBound(provider))
      throw new Error('Subscription account was disconnected');
    const imported = provider === 'openai' ? readLegacyCodexProviderId(selected) : undefined;
    if (imported && (options.remote || modelSwitch)
      && !legacyAccess?.legacyCodexAccountCanRun(imported, targetModel, {
        remote: options.remote === true, newRoute: false, modelSwitch,
      }))
      throw new Error(options.remote ? 'Subscription account remote access was revoked' : 'Subscription account does not allow this model');
  };
  return {
    assertDispatchable: () => {
      assertCurrent();
      if (readPool(provider)?.accounts.find(a => a.id === selected)?.paused)
        throw new Error('The task subscription account is disabled; retry to switch accounts');
    },
    observeFailure(error, failedModel, phase) {
      try { assertCurrent(); } catch { return; } // Ignore late failures after owner/account removal.
      const signals = providerGroupFailureSignals(error);
      const decision = decideProviderGroupFailure(signals, phase);
      if (decision.action !== 'switch' || decision.cause !== 'usage-limit') return;
      const now = Date.now();
      const resetAt = readTurnUsageResetAt(signals, now);
      const scope = coolingScope(provider === 'openai' ? failedModel?.replace(/^chatgpt\//, '') : failedModel);
      const scopes = currentCooling(state.quotaCooling.get(key), now);
      const until = resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS;
      // Refresh the scope's insertion order and bound remembered model failures.
      const previous = scopes[scope] ?? 0;
      delete scopes[scope];
      scopes[scope] = Math.max(previous, until);
      state.quotaCooling.set(key, Object.fromEntries(Object.entries(scopes).slice(-PROVIDER_GROUP_COOLING_SCOPE_CAP)));
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
      await writeAccountBindings(ids, provider, selected);
      assertCurrent();
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
      if (active.delete(token)) changed(provider);
    },
  };
}

export async function runSubscriptionAccountCommand(
  command: SubscriptionAccountCommand,
): Promise<SubscriptionPoolView> {
  const state = currentRuntime();
  assertOwner(state);
  const provider = command.providerId;
  if (command.action === 'read') return readSubscriptionPool(provider, false, command.taskId);
  if (command.action === 'preview') return readSubscriptionPool(provider, true);
  if (command.action === 'cancel') {
    state.logins.get(`${provider}:${command.loginKey}`)?.abort.abort();
    return readSubscriptionPool(provider);
  }
  if (command.action === 'configure') {
    await updatePool(provider, (pool) => ({
      ...pool,
      ...(command.strategy ? { strategy: command.strategy } : {}),
      accounts: pool.accounts.map((a) =>
        a.id !== command.accountId
          ? a
          : {
              ...a,
              ...(command.paused !== undefined ? { paused: command.paused } : {}),
              ...(command.limit !== undefined ? { limit: command.limit } : {}),
              ...(command.weight !== undefined ? { weight: command.weight } : {}),
            },
      ),
    }));
    assertOwner(state);
    const imported = provider === 'openai' && command.accountId ? readLegacyCodexProviderId(command.accountId) : undefined;
    if (imported && command.paused !== undefined) {
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
  } else {
    const initial = readPool(provider);
    const adding = command.action === 'add' || command.action === 'connect';
    const useDefault =
      command.action === 'connect'
        ? command.target === 'default'
        : command.action === 'add' &&
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
    try {
      if (
        command.action === 'add' &&
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
      await mkdir(directory, { recursive: true, mode: 0o700 });
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      // Only an explicit default-account choice (or legacy Add) may attach the
      // detected login. "New" always uses a fresh, host-generated directory.
      const legacy = accountId === 'default' && legacyCodexDefault(provider);
      const currentAuth =
        (adding && accountId === 'default') || (provider === 'openai' && !legacy)
          ? await (legacy
              ? readLegacyCodexAccount()
              : readNativeAccount(provider, directory))
          : undefined;
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      if (currentAuth?.errorReason === 'codex_provider_managed_auth')
        throw new Error('codex_provider_managed_auth');
      const attachDefault = adding && accountId === 'default' && currentAuth?.authenticated;
      if (!attachDefault) {
        const imported = provider === 'openai' ? readLegacyCodexProviderId(accountId) : undefined;
        if (imported) await loginLegacyCodexProviderAccount(imported, abort.signal);
        else if (accountId === 'default' && legacyCodexDefault(provider))
          await loginLegacyCodexAccount(abort.signal);
        else await loginNativeAccount(provider, directory, abort.signal);
      }
      assertOwner(state);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      if (accountId === 'default' && !legacyCodexDefault(provider))
        bindNativeProviderAuth(provider, { sharedSystem: true });
      await updatePool(provider, (pool) => ({ ...pool, disconnected: false }));
      assertOwner(state);
      state.cache.delete(keyOf(provider, accountId));
      state.invalidated.delete(keyOf(provider, accountId));
      state.quotaCooling.delete(keyOf(provider, accountId));
      await snapshot(state, provider, accountId, true);
    } finally {
      state.logins.delete(key);
    }
  }
  assertOwner(state);
  const view = await readSubscriptionPool(provider);
  changed(provider);
  return view;
}

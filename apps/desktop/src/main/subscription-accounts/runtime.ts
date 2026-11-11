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
import { providerGroupCodexUsageFromReads } from '../provider-group/usage.js';
import { providerGroupCodexUsageSnapshot } from '../provider-group/usage.js';
import { codexLimitBucketKey } from '@cindy/maker-shared/codex-usage-buckets';
import {
  mergeClaudeSubscriptionUsageSnapshot,
  parseClaudeSdkRateLimitInfo,
} from '../../shared/claudeSubscriptionUsage.js';
import type {
  SubscriptionAccountCommand,
  SubscriptionAccountUsage,
  SubscriptionProvider,
  SubscriptionPoolView,
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
    };
  }
  return runtime;
}
const keyOf = (provider: SubscriptionProvider, id: string) => `${provider}:${id}`;
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
  const codexUsage =
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
  const usage: Usage =
    provider === 'anthropic'
      ? {
          claudeUsage: incoming
            ? mergeClaudeSubscriptionUsageSnapshot(cached.usage?.claudeUsage ?? null, incoming)
            : cached.usage?.claudeUsage,
        }
      : { ...cached.usage, codexUsage };
  state.cache.set(key, { ...cached, usage, at: Date.now() });
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
        let auth =
          id === 'default' && legacyCodexDefault(provider)
            ? await readLegacyCodexAccount()
            : await readNativeAccount(provider, directory);
        const invalidated = state.invalidated.get(key);
        if (provider === 'openai' && invalidated && auth.authenticated) {
          const current = await readNativeCodexTokens(directory);
          if (current.accessToken === invalidated.token)
            auth = { ...auth, authenticated: false, errorReason: invalidated.reason };
          else if (state.invalidated.get(key) === invalidated) state.invalidated.delete(key);
        }
        const reuseUsage =
          cached?.auth.identity === auth.identity &&
          cached?.usageAt !== undefined &&
          Date.now() - cached.usageAt < 180_000;
        const usage = auth.authenticated
          ? reuseUsage
            ? cached?.usage
            : await readNativeAccountUsage(provider, directory).catch(() =>
                cached?.auth.identity === auth.identity ? cached?.usage : undefined,
              )
          : undefined;
        result = {
          auth,
          usage,
          at: Date.now(),
          usageAt: reuseUsage ? cached?.usageAt : Date.now(),
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
    accounts,
  };
}

export interface SubscriptionAccountLease {
  account: NativeSubscriptionAccount;
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
): Promise<SubscriptionAccountLease | null> {
  const pool = readPool(provider);
  if (!pool) return null;
  if (pool.disconnected) throw new Error('Subscription provider was disconnected');
  const state = currentRuntime();
  const binding = keys.map((key) => readAccountBinding(key, provider)).find(Boolean);
  const snapshots = await Promise.all(pool.accounts.map((a) => snapshot(state, provider, a.id)));
  assertOwner(state);
  // Settings may change while the official CLI is answering.
  const latest = readPool(provider);
  if (!latest || latest.disconnected) throw new Error('Subscription accounts changed');
  const members = latest.accounts.map((a) => {
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
      usable: !loggingIn && info?.auth.authenticated === true && (control || !usage.limited),
      running: state.running.get(keyOf(provider, a.id))?.size ?? 0,
      urgency: usage.urgency,
      fiveHourTight: usage.fiveHourTight,
    };
  });
  // Reopening an old task without a recorded binding must keep its original default home.
  const pinned = binding?.accountId;
  const selected =
    pinned ??
    pickProviderGroupMember(members, latest.strategy, {
      lastPicked: state.lastPicked.get(provider),
    });
  const member = members.find((a) => a.id === selected);
  if (!selected || !member || !member.usable)
    throw new Error(
      pinned
        ? 'The task subscription account requires login or quota reset'
        : 'No subscription account is available',
    );
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
  const assertCurrent = () => {
    assertOwner(state);
    const current = readPool(provider);
    if (current?.disconnected || !current?.accounts.some((a) => a.id === selected))
      throw new Error('Subscription account was disconnected');
    if (selected === 'default' && !defaultAccountBound(provider))
      throw new Error('Subscription account was disconnected');
  };
  return {
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
  if (command.action === 'read') return readSubscriptionPool(provider);
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
        if (accountId === 'default' && legacyCodexDefault(provider))
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

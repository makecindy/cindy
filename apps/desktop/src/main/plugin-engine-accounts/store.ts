/**
 * Settings of the accounts Cindy manages for plugin engines (subscription-account-pools.md
 * 插件引擎的账号), per Cindy account in `owners/<account>/plugin-engine-accounts.json`:
 *
 * - `engines[<plugin instance>:<engine id>]`: the engine's accounts with the same settings as a
 *   built-in pool (pause, concurrency limit, weight), its assignment strategy, the separate
 *   providers accounts were taken out into (`providers[suffix]`) and which account sits where
 *   (`placement[accountId] = suffix`; absent = the engine's own provider).
 * - `bindings[<engine key>|task:<id>|native:<id>]`: which account a task and its native session use.
 *
 * An engine without a record has only the agent's original login (`default`), like the built-in
 * pool before its first setting. No credentials, identities or messages are stored here.
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { DEFAULT_ROUTE_STRATEGY, routeStrategyOf, type RouteStrategy } from '../../shared/routeStrategy.js';
import { MAX_SUBSCRIPTION_ACCOUNTS } from '../../shared/subscriptionAccounts.js';
import { isPluginEngineAccountId, removePluginEngineAccountsOfPlugin } from './paths.js';

export interface PluginEngineAccountConfig {
  id: string;
  paused: boolean;
  /** Stored value; effectiveConcurrencyLimit applies `limitSet` (unset = unlimited), as built-in. */
  limit: number;
  limitSet?: true;
  weight: number;
  /** Display identity the plugin last confirmed; kept across sign-out so the row stays recognisable. */
  lastConfirmedIdentity?: string;
  /**
   * Set while an explicit re-login of this account is in progress or ended signed in as someone
   * else: the account takes no task until the plugin confirms this identity again (as built-in).
   */
  reloginIdentity?: string;
}

export interface PluginEnginePoolConfig {
  strategy: RouteStrategy;
  accounts: PluginEngineAccountConfig[];
  /** Separate providers the user took accounts out into, by provider id suffix. */
  providers?: Record<string, { strategy: RouteStrategy }>;
  /** Account → separate provider suffix; absent = the engine's own provider. */
  placement?: Record<string, string>;
}

export interface PluginEngineBinding {
  accountId: string;
  /** The provider the task named when it was bound (its own id or a taken-out provider). */
  via?: string;
}

interface PoolFile {
  engines: Record<string, PluginEnginePoolConfig>;
  bindings: Record<string, PluginEngineBinding>;
}

export const ENGINE_KEY_RE = /^[A-Za-z0-9._-]{1,200}:[a-z][a-z0-9-]{0,31}$/;
export const PROVIDER_SUFFIX_RE = /^[a-z0-9]{8}$/;
const MAX_ENGINES = 256;
const MAX_BINDINGS = 20_000;
const IDENTITY_MAX = 320;

export const DEFAULT_PLUGIN_ENGINE_ACCOUNT: PluginEngineAccountConfig = { id: 'default', paused: false, limit: 4, weight: 1 };
export const defaultPluginEnginePool = (): PluginEnginePoolConfig => ({
  strategy: DEFAULT_ROUTE_STRATEGY,
  accounts: [{ ...DEFAULT_PLUGIN_ENGINE_ACCOUNT }],
});

function strategyOf(value: unknown): RouteStrategy {
  return routeStrategyOf(value);
}

function normalizeAccount(raw: unknown): PluginEngineAccountConfig | null {
  const account = raw as Partial<PluginEngineAccountConfig> | null;
  if (!account || !isPluginEngineAccountId(account.id)) return null;
  const identity = typeof account.lastConfirmedIdentity === 'string' ? account.lastConfirmedIdentity.trim() : '';
  const relogin = typeof account.reloginIdentity === 'string' ? account.reloginIdentity.trim() : '';
  return {
    id: account.id,
    paused: account.paused === true,
    limit: Number.isInteger(account.limit) && account.limit! >= 1 && account.limit! <= 16 ? account.limit! : 4,
    ...(account.limitSet === true ? { limitSet: true as const } : {}),
    weight: Number.isInteger(account.weight) && account.weight! >= 1 && account.weight! <= 100 ? account.weight! : 1,
    ...(identity && identity.length <= IDENTITY_MAX ? { lastConfirmedIdentity: identity } : {}),
    ...(relogin && relogin.length <= IDENTITY_MAX ? { reloginIdentity: relogin } : {}),
  };
}

export function normalizePluginEngineAccountsFile(raw: unknown): PoolFile {
  const value = raw as Partial<PoolFile> | null;
  const engines: PoolFile['engines'] = {};
  for (const [key, pool] of Object.entries(value?.engines ?? {})) {
    if (Object.keys(engines).length >= MAX_ENGINES) break;
    if (!ENGINE_KEY_RE.test(key) || !pool || !Array.isArray(pool.accounts)) continue;
    const seen = new Set<string>();
    const accounts = pool.accounts.map(normalizeAccount)
      .filter((account): account is PluginEngineAccountConfig => !!account && !seen.has(account.id) && !!seen.add(account.id))
      .slice(0, MAX_SUBSCRIPTION_ACCOUNTS);
    const providers = Object.fromEntries(Object.entries(pool.providers ?? {})
      .filter(([suffix, provider]) => PROVIDER_SUFFIX_RE.test(suffix) && provider && typeof provider === 'object')
      .slice(0, MAX_SUBSCRIPTION_ACCOUNTS)
      .map(([suffix, provider]) => [suffix, { strategy: strategyOf((provider as { strategy?: unknown }).strategy) }]));
    const placement = Object.fromEntries(Object.entries(pool.placement ?? {})
      .filter(([accountId, suffix]) => seen.has(accountId) && typeof suffix === 'string' && Object.hasOwn(providers, suffix)));
    engines[key] = {
      strategy: strategyOf(pool.strategy),
      accounts,
      ...(Object.keys(providers).length ? { providers } : {}),
      ...(Object.keys(placement).length ? { placement } : {}),
    };
  }
  const bindings: PoolFile['bindings'] = {};
  const entries = Object.entries(value?.bindings ?? {});
  for (const [key, binding] of entries.slice(Math.max(0, entries.length - MAX_BINDINGS))) {
    if (key.length > 512 || !binding || !isPluginEngineAccountId(binding.accountId)) continue;
    const engineKey = key.slice(0, key.indexOf('|'));
    if (!ENGINE_KEY_RE.test(engineKey)) continue;
    bindings[key] = {
      accountId: binding.accountId,
      ...(typeof binding.via === 'string' && binding.via.length <= 300 ? { via: binding.via } : {}),
    };
  }
  return { engines, bindings };
}

const store = createOverrideSettingsFile<PoolFile>({
  filePath: () => ownerScopedUserDataPath('plugin-engine-accounts.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { engines: {}, bindings: {} },
  normalize: normalizePluginEngineAccountsFile,
  log: desktopMakerLogger,
  label: 'plugin-engine-accounts',
  maxBytes: 8 * 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

/** The engine's recorded pool, or null when nothing was ever set (only the original login). */
export function readPluginEnginePool(engineKey: string): PluginEnginePoolConfig | null {
  store.invalidateIfChanged();
  return store.read().engines[engineKey] ?? null;
}

/** The pool to use: recorded, or only the agent's original login. */
export function effectivePluginEnginePool(engineKey: string): PluginEnginePoolConfig {
  return readPluginEnginePool(engineKey) ?? defaultPluginEnginePool();
}

export async function updatePluginEnginePool(
  engineKey: string,
  edit: (value: PluginEnginePoolConfig) => PluginEnginePoolConfig,
): Promise<PluginEnginePoolConfig> {
  if (!ENGINE_KEY_RE.test(engineKey)) throw new Error('Invalid plugin engine');
  let result: PluginEnginePoolConfig | undefined;
  await store.updateAtomic(({ value }) => {
    result = edit(value.engines[engineKey] ?? defaultPluginEnginePool());
    return { engines: { ...value.engines, [engineKey]: result } };
  });
  return result!;
}

const bindingKey = (engineKey: string, key: string) => `${engineKey}|${key}`;

/** `key` is `task:<id>` or `native:<id>`. */
export function readPluginEngineBinding(engineKey: string, key: string): PluginEngineBinding | undefined {
  store.invalidateIfChanged();
  return store.read().bindings[bindingKey(engineKey, key)];
}

export async function writePluginEngineBindings(
  engineKey: string,
  keys: readonly string[],
  accountId: string,
  via?: string,
): Promise<void> {
  const through = via ? { via } : {};
  await store.updateAtomic(({ value }) => {
    const bindings = { ...value.bindings };
    for (const key of keys.filter(Boolean)) {
      // Re-insert so the newest bindings survive the size bound.
      delete bindings[bindingKey(engineKey, key)];
      bindings[bindingKey(engineKey, key)] = { accountId, ...through };
    }
    return { bindings };
  });
}

/** Account ids any task of this engine has used; their history stays even after removal. */
export function readBoundPluginEngineAccountIds(engineKey: string): ReadonlySet<string> {
  const prefix = `${engineKey}|`;
  return new Set(Object.entries(store.read().bindings)
    .filter(([key]) => key.startsWith(prefix)).map(([, binding]) => binding.accountId));
}

/** Uninstall: the plugin's engines lose the accounts Cindy added, their settings and directories. */
export async function forgetPluginEngineAccountsOfPlugin(ghostId: string): Promise<void> {
  const prefix = `${ghostId}:`;
  await store.updateAtomic(({ value }) => {
    const engines = Object.fromEntries(Object.entries(value.engines).filter(([key]) => !key.startsWith(prefix)));
    const bindings = Object.fromEntries(Object.entries(value.bindings).filter(([key]) => !key.startsWith(prefix)));
    return Object.keys(engines).length === Object.keys(value.engines).length
      && Object.keys(bindings).length === Object.keys(value.bindings).length ? null : { engines, bindings };
  });
  await removePluginEngineAccountsOfPlugin(ghostId);
}

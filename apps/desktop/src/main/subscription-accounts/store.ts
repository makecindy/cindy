import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  DEFAULT_SUBSCRIPTION_ACCOUNT,
  MAX_SUBSCRIPTION_ACCOUNTS,
  type SubscriptionPoolConfig,
  type SubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import { PROVIDER_GROUP_STRATEGIES } from '../../shared/providerGroup.js';
import { legacyCodexAccountHome } from '../maker-host/codex-account-path.js';
import { getUserDataDir } from '../userDataPath.js';

const legacyProviderIdValid = (id: string) => id !== 'openai' && /^[a-z0-9_-]{1,40}$/.test(id);

export const accountIdValid = (id: unknown): id is string =>
  typeof id === 'string' && (id === 'default' || /^cindy-[a-f0-9]{12}-[a-f0-9-]{36}$/.test(id));
function normalizeLegacyAccounts(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  return Object.fromEntries(Object.entries(raw).filter(([providerId, accountId]) => {
    if (!legacyProviderIdValid(providerId) || !accountIdValid(accountId) || accountId === 'default' || seen.has(accountId)) return false;
    seen.add(accountId);
    return true;
  }).slice(0, 512));
}
export const defaultPool = (): SubscriptionPoolConfig => ({
  strategy: 'least',
  accounts: [{ ...DEFAULT_SUBSCRIPTION_ACCOUNT }],
});
interface PoolFile {
  pools: Partial<Record<SubscriptionProvider, SubscriptionPoolConfig>>;
  /** Native ids and business ids both persist, so reopen/fork never change homes. */
  bindings: Record<string, {
    providerId: SubscriptionProvider;
    accountId: string;
    /**
     * 2026-11-13: the provider the task named when this account was bound (built-in, created or a
     * legacy connection). Absent on older bindings, meaning the built-in provider. Older clients
     * keep the binding object as it is.
     */
    via?: string;
  }>;
}
export function normalizePoolFile(raw: unknown): PoolFile {
  const value = raw as Partial<PoolFile> | null;
  const pools: PoolFile['pools'] = {};
  for (const provider of ['anthropic', 'openai'] as const) {
    const pool = value?.pools?.[provider];
    if (!pool || !Array.isArray(pool.accounts)) continue;
    const seen = new Set<string>();
    const legacyAccounts = provider === 'openai' ? normalizeLegacyAccounts(pool.legacyCodexAccounts) : undefined;
    pools[provider] = {
      ...(pool.disconnected === true ? { disconnected: true } : {}),
      ...(provider === 'openai' && pool.legacyCodexDefault === true
        ? { legacyCodexDefault: true }
        : {}),
      ...(legacyAccounts ? { legacyCodexAccounts: legacyAccounts } : {}),
      strategy: PROVIDER_GROUP_STRATEGIES.includes(pool.strategy) ? pool.strategy : 'least',
      accounts: pool.accounts
        .filter((a) => a && accountIdValid(a.id) && !seen.has(a.id) && seen.add(a.id))
        .slice(0, MAX_SUBSCRIPTION_ACCOUNTS)
        .map((a) => ({
          id: a.id,
          ...(provider === 'anthropic' && typeof a.lastConfirmedIdentity === 'string' && a.lastConfirmedIdentity.trim()
            && a.lastConfirmedIdentity.length <= 320
            ? { lastConfirmedIdentity: a.lastConfirmedIdentity.trim() } : {}),
          ...(provider === 'anthropic' && typeof a.reloginIdentity === 'string' && a.reloginIdentity.trim()
            && a.reloginIdentity.length <= 320
            ? { reloginIdentity: a.reloginIdentity.trim() } : {}),
          paused: a.paused === true,
          limit: Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 16 ? a.limit : 4,
          ...(a.limitSet === true ? { limitSet: true as const } : {}),
          weight: Number.isInteger(a.weight) && a.weight >= 1 && a.weight <= 100 ? a.weight : 1,
        })),
    };
  }
  const bindings: PoolFile['bindings'] = {};
  for (const [key, binding] of Object.entries(value?.bindings ?? {})) {
    if (
      key.length <= 256 &&
      binding &&
      (binding.providerId === 'anthropic' || binding.providerId === 'openai') &&
      accountIdValid(binding.accountId)
    )
      bindings[key] = binding;
  }
  return { pools, bindings };
}
const store = createOverrideSettingsFile<PoolFile>({
  filePath: () => ownerScopedUserDataPath('subscription-accounts.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { pools: {}, bindings: {} },
  normalize: normalizePoolFile,
  log: desktopMakerLogger,
  label: 'subscription-accounts',
  maxBytes: 8 * 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});
export const accountOwnerPrefix = () => {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) throw new Error('An active owner is required');
  return createHash('sha256').update(owner).digest('hex').slice(0, 12);
};
export function accountDirectory(provider: SubscriptionProvider, id: string): string {
  if (!accountIdValid(id) || (id !== 'default' && !id.startsWith(`cindy-${accountOwnerPrefix()}-`)))
    throw new Error('Subscription account is unavailable');
  const legacy = provider === 'openai' ? readLegacyCodexProviderId(id) : undefined;
  if (legacy) return legacyCodexAccountHome(getUserDataDir(), getActiveAppSession().dataOwnerId, legacy);
  return path.join(
    homedir(),
    `.${provider === 'anthropic' ? 'claude' : 'codex'}${id === 'default' ? '' : `-${id}`}`,
  );
}
export function readPool(provider: SubscriptionProvider): SubscriptionPoolConfig | null {
  store.invalidateIfChanged();
  return store.read().pools[provider] ?? null;
}
/** OpenAI 池里从旧 Codex 连接导入的账号(旧连接 ID → 账号)；账号池文件读不了时返回 null，不当成没有。 */
export function readOpenAiLegacyAccountsIfReadable(): Readonly<Record<string, string>> | null {
  store.invalidateIfChanged();
  if (store.isUnreadable()) return null;
  return store.read().pools.openai?.legacyCodexAccounts ?? {};
}
export function readLegacyCodexAccountId(providerId: string): string | undefined {
  const accountId = readPool('openai')?.legacyCodexAccounts?.[providerId];
  return typeof accountId === 'string' && accountId.startsWith(`cindy-${accountOwnerPrefix()}-`) ? accountId : undefined;
}
export function readLegacyCodexProviderId(accountId: string): string | undefined {
  return Object.entries(readPool('openai')?.legacyCodexAccounts ?? {})
    .find(([id, account]) => legacyProviderIdValid(id) && account === accountId)?.[0];
}

/** Registers old native connections as OpenAI pool accounts (the 2026-11-11 upgrade writer).
 * Only metadata changes: existing logins, task references and CLI histories stay in place.
 * Since 2026-11-13 catalog loads no longer call it (placement.ts restores what it merged); it is
 * kept as the registration step of a merge the user chooses.
 */
export async function migrateLegacyCodexAccounts(
  accounts: readonly { providerId: string; paused?: boolean }[],
  options: { preserveDefault: boolean; legacyDefault: boolean; isCurrent?: () => boolean },
): Promise<boolean> {
  const candidates = accounts.filter(account => legacyProviderIdValid(account.providerId));
  const existing = readPool('openai');
  if (existing && existing.accounts.length >= MAX_SUBSCRIPTION_ACCOUNTS) return false;
  if (!candidates.some(account => !Object.hasOwn(existing?.legacyCodexAccounts ?? {}, account.providerId))) return false;
  const owner = activeOwnerScopeKey();
  const prefix = accountOwnerPrefix();
  let changed = false;
  await store.updateAtomic(({ value }) => {
    if (owner !== activeOwnerScopeKey() || options.isCurrent?.() === false)
      throw new Error('Subscription account owner changed');
    const current = value.pools.openai ?? {
      ...defaultPool(),
      accounts: options.preserveDefault ? defaultPool().accounts : [],
      ...(options.legacyDefault ? { legacyCodexDefault: true } : {}),
    };
    const aliases = Object.fromEntries(Object.entries(current.legacyCodexAccounts ?? {}));
    const next = [...current.accounts];
    for (const candidate of candidates) {
      if (Object.hasOwn(aliases, candidate.providerId) || next.length >= MAX_SUBSCRIPTION_ACCOUNTS || Object.keys(aliases).length >= 512) continue;
      const id = `cindy-${prefix}-${randomUUID()}`;
      Object.defineProperty(aliases, candidate.providerId, { value: id, enumerable: true, configurable: true });
      next.push({ ...DEFAULT_SUBSCRIPTION_ACCOUNT, id, paused: candidate.paused === true });
      changed = true;
    }
    return { pools: { ...value.pools, openai: { ...current, accounts: next, legacyCodexAccounts: aliases } } };
  });
  return changed;
}
export async function updatePool(
  provider: SubscriptionProvider,
  edit: (value: SubscriptionPoolConfig) => SubscriptionPoolConfig,
): Promise<void> {
  await store.updateAtomic(({ value }) => ({
    pools: { ...value.pools, [provider]: edit(value.pools[provider] ?? defaultPool()) },
  }));
}
export function readAccountBinding(key: string, provider: SubscriptionProvider) {
  const bindings = store.read().bindings;
  const binding = bindings[`${provider}:${key}`] ?? bindings[key];
  return binding?.providerId === provider ? binding : undefined;
}
let boundAccountIndex: { bindings: PoolFile['bindings']; providers: Map<string, ReadonlySet<string>>;
  kinds: Map<SubscriptionProvider, Set<string>> } | undefined;
function boundAccounts() {
  const bindings = store.read().bindings;
  if (boundAccountIndex?.bindings !== bindings) {
    const providers = new Map<string, Set<string>>();
    const kinds = new Map<SubscriptionProvider, Set<string>>();
    for (const binding of Object.values(bindings)) {
      const all = kinds.get(binding.providerId) ?? new Set<string>();
      all.add(binding.accountId);
      kinds.set(binding.providerId, all);
      const key = `${binding.providerId}:${binding.via ?? binding.providerId}`;
      const accounts = providers.get(key) ?? new Set<string>();
      accounts.add(binding.accountId);
      providers.set(key, accounts);
    }
    boundAccountIndex = { bindings, providers, kinds };
  }
  return boundAccountIndex;
}
/** Accounts whose persisted history was created through this source; never used for new routing. */
export function readProviderBoundAccountIds(provider: SubscriptionProvider, providerId: string): ReadonlySet<string> {
  return boundAccounts().providers.get(`${provider}:${providerId}`) ?? new Set();
}
/** Read-only discovery may retain model metadata for paused accounts with existing history. */
export function readBoundSubscriptionAccountIds(provider: SubscriptionProvider): ReadonlySet<string> {
  return boundAccounts().kinds.get(provider) ?? new Set();
}
/** Read-only history lookup: only additional profiles override the legacy/default search. */
export function readBoundClaudeConfigDir(sdkSessionId: string): string | undefined {
  const binding = readAccountBinding(`native:${sdkSessionId}`, 'anthropic');
  return binding && binding.accountId !== 'default'
    ? accountDirectory('anthropic', binding.accountId)
    : undefined;
}
export async function writeAccountBindings(
  keys: string[],
  providerId: SubscriptionProvider,
  accountId: string,
  /** The provider the task named (placement.ts); omitted for the built-in provider. */
  via?: string,
): Promise<void> {
  const through = via && via !== providerId ? { via } : {};
  await store.updateAtomic(({ value }) => ({
    bindings: {
      ...value.bindings,
      ...Object.fromEntries(
        keys.filter(Boolean).map((key) => [`${providerId}:${key}`, { providerId, accountId, ...through }]),
      ),
    },
  }));
}

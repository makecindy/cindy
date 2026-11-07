import { createHash } from 'node:crypto';
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
  type SubscriptionPoolConfig,
  type SubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import { PROVIDER_GROUP_STRATEGIES } from '../../shared/providerGroup.js';

export const accountIdValid = (id: unknown): id is string =>
  typeof id === 'string' && (id === 'default' || /^cindy-[a-f0-9]{12}-[a-f0-9-]{36}$/.test(id));
export const defaultPool = (): SubscriptionPoolConfig => ({
  strategy: 'least',
  accounts: [{ ...DEFAULT_SUBSCRIPTION_ACCOUNT }],
});
interface PoolFile {
  pools: Partial<Record<SubscriptionProvider, SubscriptionPoolConfig>>;
  /** Native ids and business ids both persist, so reopen/fork never change homes. */
  bindings: Record<string, { providerId: SubscriptionProvider; accountId: string }>;
}
export function normalizePoolFile(raw: unknown): PoolFile {
  const value = raw as Partial<PoolFile> | null;
  const pools: PoolFile['pools'] = {};
  for (const provider of ['anthropic', 'openai'] as const) {
    const pool = value?.pools?.[provider];
    if (!pool || !Array.isArray(pool.accounts)) continue;
    const seen = new Set<string>();
    pools[provider] = {
      ...(pool.disconnected === true ? { disconnected: true } : {}),
      ...(provider === 'openai' && pool.legacyCodexDefault === true
        ? { legacyCodexDefault: true }
        : {}),
      strategy: PROVIDER_GROUP_STRATEGIES.includes(pool.strategy) ? pool.strategy : 'least',
      accounts: pool.accounts
        .filter((a) => a && accountIdValid(a.id) && !seen.has(a.id) && seen.add(a.id))
        .slice(0, 32)
        .map((a) => ({
          id: a.id,
          paused: a.paused === true,
          limit: Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 16 ? a.limit : 4,
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
  return path.join(
    homedir(),
    `.${provider === 'anthropic' ? 'claude' : 'codex'}${id === 'default' ? '' : `-${id}`}`,
  );
}
export function readPool(provider: SubscriptionProvider): SubscriptionPoolConfig | null {
  store.invalidateIfChanged();
  return store.read().pools[provider] ?? null;
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
): Promise<void> {
  await store.updateAtomic(({ value }) => ({
    bindings: {
      ...value.bindings,
      ...Object.fromEntries(
        keys.filter(Boolean).map((key) => [`${providerId}:${key}`, { providerId, accountId }]),
      ),
    },
  }));
}

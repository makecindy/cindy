/**
 * Which provider each subscription account belongs to (subscription-account-pools.md
 * 「合并与拿出由用户决定」, 2026-11-13 user decision: whether accounts share a provider is the
 * user's choice, not a default).
 *
 * Kept apart from `subscription-accounts.json` on purpose: clients from before this decision
 * normalize that file on every write (task starts write bindings) and drop the fields they do not
 * know, which would silently undo the user's arrangement. They never read or write this file.
 *
 * An account without an entry belongs to its built-in provider (`openai` / `anthropic`), which is
 * exactly what every older client assumes. The CLI default account always stays there.
 */
import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { PROVIDER_GROUP_STRATEGIES, type ProviderGroupStrategy } from '../../shared/providerGroup.js';
import {
  accountIdValid,
  readLegacyCodexAccountId,
  readOpenAiLegacyAccountsIfReadable,
  readPool,
  updatePool,
} from './store.js';

const PROVIDER_ID = /^[a-z0-9_-]{1,40}$/;
/** Providers Cindy creates for subscription accounts; never collides with connection ids (`<brand>-<hex>`). */
const CREATED_PROVIDER_ID = /^(openai|anthropic)-sub-[a-f0-9]{8}$/;
const MAX_PLACEMENTS = 1024;
const MAX_PROVIDER_NAME = 64;

/** A provider Cindy created for one subscription account (2026-11-13), e.g. a separate account. */
export interface CreatedSubscriptionProvider {
  kind: SubscriptionProvider;
  name: string;
  /** The account it was created for; its tasks keep this account when it moves elsewhere. */
  account: string;
}

interface PlacementFile {
  /** `${kind}:${accountId}` -> provider id the account belongs to. */
  accounts: Record<string, string>;
  /** Providers created for subscription accounts, by provider id. */
  providers: Record<string, CreatedSubscriptionProvider>;
  /** Assignment policy of providers other than the built-ins (those keep the pool's own policy). */
  strategies: Record<string, ProviderGroupStrategy>;
}

const keyOf = (kind: SubscriptionProvider, accountId: string) => `${kind}:${accountId}`;
const isKind = (value: unknown): value is SubscriptionProvider => value === 'openai' || value === 'anthropic';

export function normalizePlacementFile(raw: unknown): PlacementFile {
  const value = raw as Partial<PlacementFile> | null;
  const accounts: Record<string, string> = {};
  const providers: Record<string, CreatedSubscriptionProvider> = {};
  const entries = value?.accounts;
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const [key, providerId] of Object.entries(entries).slice(0, MAX_PLACEMENTS)) {
      const split = key.indexOf(':');
      const kind = key.slice(0, split);
      const accountId = key.slice(split + 1);
      if (isKind(kind) && accountIdValid(accountId) && accountId !== 'default'
        && typeof providerId === 'string' && PROVIDER_ID.test(providerId))
        accounts[key] = providerId;
    }
  }
  const created = value?.providers;
  if (created && typeof created === 'object' && !Array.isArray(created)) {
    for (const [providerId, entry] of Object.entries(created).slice(0, MAX_PLACEMENTS)) {
      if (!CREATED_PROVIDER_ID.test(providerId) || !entry || typeof entry !== 'object') continue;
      const { kind, name, account } = entry as Partial<CreatedSubscriptionProvider>;
      if (!isKind(kind) || !providerId.startsWith(`${kind}-`) || typeof name !== 'string' || !name.trim()
        || !accountIdValid(account) || account === 'default') continue;
      providers[providerId] = { kind, name: name.trim().slice(0, MAX_PROVIDER_NAME), account };
    }
  }
  const strategies: Record<string, ProviderGroupStrategy> = {};
  const saved = value?.strategies;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [providerId, strategy] of Object.entries(saved).slice(0, MAX_PLACEMENTS)) {
      if (PROVIDER_ID.test(providerId) && !isKind(providerId) && PROVIDER_GROUP_STRATEGIES.includes(strategy as ProviderGroupStrategy))
        strategies[providerId] = strategy as ProviderGroupStrategy;
    }
  }
  return { accounts, providers, strategies };
}

const file = createOverrideSettingsFile<PlacementFile>({
  filePath: () => ownerScopedUserDataPath('subscription-account-placement.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { accounts: {}, providers: {}, strategies: {} },
  normalize: normalizePlacementFile,
  log: desktopMakerLogger,
  label: 'subscription-account-placement',
  maxBytes: 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

/** The provider an account belongs to; its built-in provider when nothing else was recorded. */
export function accountProviderId(kind: SubscriptionProvider, accountId: string): string {
  if (accountId === 'default') return kind;
  file.invalidateIfChanged();
  return file.read().accounts[keyOf(kind, accountId)] ?? kind;
}

/** Accounts of `kind` belonging to `providerId` (the built-in provider unless given). */
export function providerAccounts<T extends { id: string }>(
  kind: SubscriptionProvider,
  accounts: readonly T[],
  providerId: string = kind,
): T[] {
  return accounts.filter((account) => accountProviderId(kind, account.id) === providerId);
}

/** The accounts that share a provider with `accountId` (itself included). */
export function accountSiblings<T extends { id: string }>(
  kind: SubscriptionProvider,
  accounts: readonly T[],
  accountId: string,
): T[] {
  return providerAccounts(kind, accounts, accountProviderId(kind, accountId));
}

/**
 * The OpenAI pool account of a legacy Codex connection while that account belongs to another
 * provider (the connection was merged and is hidden behind it). Undefined once the account
 * belongs to its own connection again: the connection is then an ordinary independent provider.
 */
export function readMergedLegacyCodexAccountId(providerId: string): string | undefined {
  const ref = resolveSubscriptionPoolProvider(providerId);
  return ref && !ref.created && ref.kind === 'openai' ? pinnedOwnAccount(ref) : undefined;
}

/**
 * Like {@link readMergedLegacyCodexAccountId} for any provider made for one account (a legacy
 * connection or a created provider): its own account while it is merged into another provider and
 * the provider itself has no accounts left. Such a provider is hidden and only pins old tasks.
 */
export function readMergedProviderAccount(providerId: string): string | undefined {
  const ref = resolveSubscriptionPoolProvider(providerId);
  return ref ? pinnedOwnAccount(ref) : undefined;
}

/** Providers Cindy created for subscription accounts (the file's view; may include hidden ones). */
export function readCreatedSubscriptionProviders(): Readonly<Record<string, CreatedSubscriptionProvider>> {
  file.invalidateIfChanged();
  return file.read().providers ?? {};
}

/** Preserve an already-published list on an unreadable file; missing or valid empty files clear it. */
export function readCreatedSubscriptionProvidersIfReadable(): Readonly<Record<string, CreatedSubscriptionProvider>> | null {
  file.invalidateIfChanged();
  if (file.isUnreadable()) return null;
  return file.read().providers ?? {};
}

/** A provider that owns subscription accounts, with the pool kind its accounts live in. */
export interface SubscriptionPoolProviderRef {
  kind: SubscriptionProvider;
  providerId: string;
  /** The account a created provider or legacy Codex connection was made for. */
  ownAccount?: string;
  /** Created by Cindy (not a built-in provider or a stored connection). */
  created?: true;
}

/**
 * Resolve a provider id to the account pool it uses: the built-in providers, providers Cindy
 * created for subscription accounts, and legacy Codex connections registered in the OpenAI pool.
 * Other providers (API keys, gateways, unregistered legacy connections, SSH) return null.
 */
export function resolveSubscriptionPoolProvider(providerId: string | null | undefined): SubscriptionPoolProviderRef | null {
  if (!providerId) return null;
  if (isKind(providerId)) return { kind: providerId, providerId };
  const created = readCreatedSubscriptionProviders()[providerId];
  if (created) return { kind: created.kind, providerId, ownAccount: created.account, created: true };
  const legacy = readLegacyCodexAccountId(providerId);
  return legacy ? { kind: 'openai', providerId, ownAccount: legacy } : null;
}

/**
 * The account an old provider id still pins when none of the pool's accounts belongs to it any
 * more (it was merged into another provider): its tasks keep that account, as before a merge.
 */
export function pinnedOwnAccount(ref: SubscriptionPoolProviderRef): string | undefined {
  if (!ref.ownAccount) return undefined;
  const pool = readPool(ref.kind);
  // Only while that account still exists somewhere else: a removed account pins nothing, so its
  // provider is never hidden as merged (a removed legacy account is handled by the restore below).
  return pool && providerAccounts(ref.kind, pool.accounts, ref.providerId).length === 0
    && pool.accounts.some((account) => account.id === ref.ownAccount)
    ? ref.ownAccount : undefined;
}

/** The provider an account was created with (a legacy connection or a created provider), if any. */
export function accountOwnProvider(kind: SubscriptionProvider, accountId: string): string | undefined {
  if (accountId === 'default') return kind;
  const created = Object.entries(readCreatedSubscriptionProviders())
    .find(([, entry]) => entry.kind === kind && entry.account === accountId)?.[0];
  if (created) return created;
  if (kind !== 'openai') return undefined;
  return Object.entries(readOpenAiLegacyAccountsIfReadable() ?? {})
    .find(([, account]) => account === accountId)?.[0];
}

function assertOwner(owner: string): void {
  if (owner !== activeOwnerScopeKey()) throw new Error('Subscription account owner changed');
}

/** Record which provider an account belongs to (the default account always stays built-in). */
export async function placeSubscriptionAccount(
  kind: SubscriptionProvider,
  accountId: string,
  providerId: string,
): Promise<void> {
  if (accountId === 'default' || !accountIdValid(accountId) || !PROVIDER_ID.test(providerId))
    throw new Error('Account cannot be moved');
  const owner = activeOwnerScopeKey();
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    const accounts = { ...value.accounts };
    // The built-in provider is the default; storing it explicitly records the user's choice so a
    // later load never mistakes this account for one the upgrade merged.
    accounts[keyOf(kind, accountId)] = providerId;
    return { accounts };
  });
}

/** Create a provider for one account and place the account in it. */
export async function createSubscriptionProvider(
  kind: SubscriptionProvider,
  accountId: string,
  name: string,
  createId: () => string,
  prepare?: (providerId: string) => void,
): Promise<string> {
  if (accountId === 'default' || !accountIdValid(accountId)) throw new Error('Account cannot be moved');
  const owner = activeOwnerScopeKey();
  let providerId = '';
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    const providers = { ...(value.providers ?? {}) };
    do providerId = `${kind}-sub-${createId()}`; while (providers[providerId]);
    if (!CREATED_PROVIDER_ID.test(providerId)) throw new Error('Invalid subscription provider id');
    prepare?.(providerId);
    providers[providerId] = { kind, name: name.trim().slice(0, MAX_PROVIDER_NAME) || kind, account: accountId };
    return { providers, accounts: { ...value.accounts, [keyOf(kind, accountId)]: providerId } };
  });
  return providerId;
}

/** Roll back a new account whose first login failed; existing task bindings never use this path. */
export async function discardUnusedSubscriptionAccountPlacement(kind: SubscriptionProvider, accountId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    const accounts = { ...value.accounts };
    delete accounts[keyOf(kind, accountId)];
    return { accounts };
  });
}

export function readProviderStrategy(providerId: string): ProviderGroupStrategy | undefined {
  file.invalidateIfChanged();
  return file.read().strategies?.[providerId];
}

export async function writeProviderStrategy(providerId: string, strategy: ProviderGroupStrategy): Promise<void> {
  if (isKind(providerId) || !PROVIDER_ID.test(providerId)) throw new Error('Invalid subscription provider');
  const owner = activeOwnerScopeKey();
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    return { strategies: { ...(value.strategies ?? {}), [providerId]: strategy } };
  });
}

/**
 * Forget a created provider (deleted, or its first sign-in did not finish): its record, strategy and
 * every placement pointing at it, so no empty or hidden provider is left behind.
 */
export async function deleteCreatedSubscriptionProvider(providerId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    if (!value.providers?.[providerId]) return {};
    const providers = { ...value.providers };
    delete providers[providerId];
    const strategies = { ...(value.strategies ?? {}) };
    delete strategies[providerId];
    const accounts = Object.fromEntries(Object.entries(value.accounts).filter(([, id]) => id !== providerId));
    return { providers, strategies, accounts };
  });
}

/** Rename a created provider's default name (display overrides still apply on top). */
export async function renameCreatedSubscriptionProvider(providerId: string, name: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    const current = value.providers?.[providerId];
    if (!current) return {};
    return { providers: { ...value.providers, [providerId]: { ...current, name: name.trim().slice(0, MAX_PROVIDER_NAME) || current.name } } };
  });
}

/** Merged legacy connections (old id -> account); null when either file cannot be read. */
export function readOpenAiMergedLegacyAccountsIfReadable(): Readonly<Record<string, string>> | null {
  const aliases = readOpenAiLegacyAccountsIfReadable();
  file.invalidateIfChanged();
  if (!aliases || file.isUnreadable()) return null;
  return Object.fromEntries(
    Object.entries(aliases).filter(([providerId, accountId]) => accountProviderId('openai', accountId) !== providerId),
  );
}

/**
 * Undo the 2026-11-11 upgrade merge (v0.1.135): every legacy Codex connection that was folded into
 * OpenAI without the user choosing it belongs to its own connection again. Runs on each catalog
 * load and only touches aliases without a recorded placement, so an older client that merges again
 * after a downgrade is undone the same way, while a merge the user chose (recorded explicitly) stays.
 *
 * - The account keeps its directory, login and task bindings; tasks bound to it keep using it.
 * - An account paused while merged comes back as a disabled connection, and an account removed
 *   while merged comes back as a disabled ordinary connection (its alias is forgotten). Neither is
 *   used again until the user enables it.
 * - Never runs while either file is unreadable: the merged view is kept and retried next load.
 */
export async function restoreAutoMergedLegacyCodexAccounts(
  connectionIds: ReadonlySet<string>,
  options: {
    disable(providerId: string): void;
    /** Whether the connection is turned off (its own switch); used to spot an interrupted restore. */
    isDisabled(providerId: string): boolean;
    isCurrent?: () => boolean;
  },
): Promise<boolean> {
  file.invalidateIfChanged();
  const aliases = readOpenAiLegacyAccountsIfReadable();
  if (!aliases || file.isUnreadable()) return false;
  const pool = readPool('openai');
  if (!pool) return false;
  const placed = file.read().accounts;
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (owner !== activeOwnerScopeKey() || options.isCurrent?.() === false)
      throw new Error('Subscription account owner changed');
  };
  const restore: Array<[providerId: string, accountId: string]> = [];
  const forget: string[] = [];
  for (const [providerId, accountId] of Object.entries(aliases)) {
    if (!connectionIds.has(providerId)) continue;
    // A removed account turns its connection back into a disabled ordinary one, whether it was
    // removed while merged or from the restored connection's own account list.
    if (!pool.accounts.some((account) => account.id === accountId)) forget.push(providerId);
    else if (!Object.hasOwn(placed, keyOf('openai', accountId))) restore.push([providerId, accountId]);
  }
  // A connection's own switch governs it once restored. A pool pause left behind by an interrupted
  // restore (connection already turned off, placement written, pause not yet cleared) is converted
  // the same way on the next load. A pause on a connection that is still on is the user's own
  // choice in its account list (2026-11-13: restored connections can hold several accounts) and
  // stays as it is.
  const unpause = new Map<string, string>();
  for (const account of pool.accounts) {
    if (!account.paused) continue;
    const placedIn = placed[keyOf('openai', account.id)];
    const own = restore.find(([, accountId]) => accountId === account.id)?.[0]
      ?? (placedIn !== undefined && aliases[placedIn] === account.id && options.isDisabled(placedIn)
        ? placedIn : undefined);
    if (own) unpause.set(account.id, own);
  }
  if (!restore.length && !forget.length && !unpause.size) return false;
  assertCurrent();
  // Disable first: whatever step is interrupted, nothing paused or removed becomes usable.
  for (const providerId of [...unpause.values(), ...forget]) options.disable(providerId);
  if (restore.length) {
    await file.updateAtomic(({ value }) => {
      assertCurrent();
      return {
        accounts: {
          ...value.accounts,
          ...Object.fromEntries(restore.map(([providerId, accountId]) => [keyOf('openai', accountId), providerId])),
        },
      };
    });
  }
  if (unpause.size || forget.length) {
    await updatePool('openai', (current) => {
      assertCurrent();
      const legacy = Object.fromEntries(
        Object.entries(current.legacyCodexAccounts ?? {}).filter(([providerId]) => !forget.includes(providerId)),
      );
      return {
        ...current,
        ...(current.legacyCodexAccounts ? { legacyCodexAccounts: legacy } : {}),
        accounts: current.accounts.map((account) =>
          unpause.has(account.id) && accountProviderId('openai', account.id) !== 'openai'
            ? { ...account, paused: false }
            : account,
        ),
      };
    });
  }
  return true;
}

/**
 * Split old wizard/pool additions too (2026-11-14 user correction): an unplaced non-default
 * account was pooled before users could choose. Explicit additions/merges have a placement and
 * stay where chosen. Legacy Codex aliases are restored by the preceding legacy restoration;
 * an alias whose original connection is missing must not become a different provider here.
 * Only placement metadata changes; directories, task bindings, pauses and limits stay intact.
 */
export async function restoreUnplacedSubscriptionAccounts(options: {
  prepare(kind: SubscriptionProvider, providerId: string): void;
  disable(providerId: string): void;
  isCurrent?: () => boolean;
}): Promise<boolean> {
  if (options.isCurrent?.() === false) return false;
  file.invalidateIfChanged();
  // Both kinds share the same pool file; this also checks that it is readable before any write.
  const aliases = readOpenAiLegacyAccountsIfReadable();
  if (!aliases || file.isUnreadable()) return false;
  const legacy = new Set(Object.values(aliases));
  const placed = file.read().accounts;
  const candidates = (['openai', 'anthropic'] as const).flatMap(kind =>
    (readPool(kind)?.accounts ?? []).filter(account => account.id !== 'default'
      && !Object.hasOwn(placed, keyOf(kind, account.id))
      && !(kind === 'openai' && legacy.has(account.id))).map(account => ({ kind, account })),
  );
  // Keep collision reservations and partially prepared settings stable even if the pool order changes.
  candidates.sort((a, b) => {
    const left = keyOf(a.kind, a.account.id);
    const right = keyOf(b.kind, b.account.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (!candidates.length) return false;
  const owner = activeOwnerScopeKey();
  let changed = false;
  await file.updateAtomic(({ value }) => {
    assertOwner(owner);
    if (options.isCurrent?.() === false) throw new Error('Subscription accounts changed');
    const currentAliases = readOpenAiLegacyAccountsIfReadable();
    if (!currentAliases) throw new Error('Subscription accounts are unreadable');
    const accounts = { ...value.accounts };
    const providers = { ...value.providers };
    for (const { kind, account } of candidates) {
      const key = keyOf(kind, account.id);
      const pool = readPool(kind);
      // Recheck inside the write lock: a concurrent move, removal or legacy registration wins.
      if (Object.hasOwn(accounts, key) || !pool?.accounts.some(entry => entry.id === account.id)
        || (kind === 'openai' && Object.values(currentAliases).includes(account.id))) continue;
      let providerId = Object.entries(providers)
        .find(([, entry]) => entry.kind === kind && entry.account === account.id)?.[0];
      if (!providerId) {
        // Preparing settings writes a separate file before placement commits. Retry the same IDs
        // after either write fails, instead of accumulating orphan overrides under random IDs.
        let collision = 0;
        do {
          const suffix = createHash('sha256').update(`${key}:${collision++}`).digest('hex').slice(0, 8);
          providerId = `${kind}-sub-${suffix}`;
        } while (providers[providerId]);
      }
      options.prepare(kind, providerId);
      // Splitting a disconnected pool must not turn its accounts back on.
      if (pool.disconnected) options.disable(providerId);
      const brand = kind === 'openai' ? 'OpenAI' : 'Claude';
      providers[providerId] ??= { kind, name: account.lastConfirmedIdentity
        ? `${brand} · ${account.lastConfirmedIdentity}` : brand, account: account.id };
      accounts[key] = providerId;
      changed = true;
    }
    assertOwner(owner);
    if (options.isCurrent?.() === false) throw new Error('Subscription accounts changed');
    return { accounts, providers };
  });
  return changed;
}

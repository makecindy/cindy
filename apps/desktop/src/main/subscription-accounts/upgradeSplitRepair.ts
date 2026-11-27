/**
 * Put back what the 0.1.137–0.1.139 upgrade split broke (subscription-account-pools.md
 * 「升级拆坏的自动并回」, 2026-11-18 user decision).
 *
 * That upgrade moved every old pooled account without a placement into its own new provider. When
 * the moved account was the only one the built-in provider could still use, the built-in provider
 * went disconnected, and everything that named it — provider groups and shares on other computers,
 * automations — lost its account (field report 2026-11-17). Such a split provider goes back into the
 * built-in provider through the user's own「并入其他供应商」command, but only while every condition
 * shows the split is still the upgrade's and nothing else could use the built-in provider:
 *
 * - the built-in provider is neither disconnected nor switched off by the user, and none of its
 *   accounts can serve (each one is paused or confirmed signed out; an account not read yet leaves
 *   it for a later check);
 * - the provider id is the one the upgrade derived from the account (user-made ones are random),
 *   and its account was never out of it since this version recorded it: a merged split provider
 *   stays as an alias, so taking its account out later reuses the same id, and that later choice is
 *   the user's (whether this repair or the user merged it);
 * - it still holds just that account, and the user has not renamed it, given it its own strategy,
 *   switched it off, allowed remote invocation, shared it or built a provider group on it.
 *
 * Merging keeps the provider id as an alias that pins its account for old tasks, so nothing that
 * already names it breaks.
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import {
  accountProviderId,
  isUpgradeSplitProvider,
  providerAccounts,
  readCreatedSubscriptionProvidersIfReadable,
  readProviderStrategy,
} from './placement.js';
import { readOpenAiLegacyAccountsIfReadable, readPool } from './store.js';

const PROVIDER_ID = /^(openai|anthropic)-sub-[a-f0-9]{8}$/;
const MAX_REPAIRS = 1024;

/** `pending`: a merge was started; `done`: its account has left it at least once — never merged again. */
type RepairState = 'pending' | 'done';
interface RepairFile {
  repaired: Record<string, RepairState>;
}

function normalizeRepairFile(raw: unknown): RepairFile {
  const value = (raw as Partial<RepairFile> | null)?.repaired;
  const repaired: Record<string, RepairState> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [providerId, done] of Object.entries(value).slice(0, MAX_REPAIRS))
      if ((done === 'pending' || done === 'done') && PROVIDER_ID.test(providerId)) repaired[providerId] = done;
  }
  return { repaired };
}

const file = createOverrideSettingsFile<RepairFile>({
  filePath: () => ownerScopedUserDataPath('subscription-upgrade-split-repairs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { repaired: {} },
  normalize: normalizeRepairFile,
  log: desktopMakerLogger,
  label: 'subscription-upgrade-split-repairs',
  maxBytes: 64 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

async function updateRecord(owner: string, edit: (repaired: Record<string, RepairState>) => Record<string, RepairState> | null): Promise<void> {
  await file.updateAtomic(({ value }) => {
    // Never write one owner's record into another owner's file.
    if (owner !== activeOwnerScopeKey()) throw new Error('Subscription account owner changed');
    const next = edit(value.repaired);
    return next ? { repaired: next } : {};
  });
}

/** A merge of this split provider is about to start (owner: the scope the caller checked). */
export function recordUpgradeSplitRepairStarted(providerId: string, owner: string): Promise<void> {
  if (!PROVIDER_ID.test(providerId)) throw new Error('Invalid subscription provider');
  return updateRecord(owner, (repaired) => repaired[providerId] ? null : { ...repaired, [providerId]: 'pending' });
}

/**
 * Every upgrade-made provider whose account is no longer in it — merged by this repair, by the
 * user, or moved elsewhere — is done: a later take-out back into it is the user's own choice.
 * A pending one whose account is still in it (the merge failed or never ran) stays eligible.
 */
export async function settleUpgradeSplitRepairs(owner: string): Promise<void> {
  const created = readCreatedSubscriptionProvidersIfReadable();
  if (!created) return;
  const left = Object.entries(created)
    .filter(([providerId, entry]) => isUpgradeSplitProvider(providerId, entry)
      && accountProviderId(entry.kind, entry.account) !== providerId)
    .map(([providerId]) => providerId);
  file.invalidateIfChanged();
  if (file.isUnreadable() || left.every((providerId) => file.read().repaired[providerId] === 'done')) return;
  await updateRecord(owner, (repaired) => ({ ...repaired, ...Object.fromEntries(left.map((providerId) => [providerId, 'done' as const])) }));
}

export interface UpgradeSplitRepairDeps {
  signInEvidence(kind: SubscriptionProvider, accountId: string): 'signed-in' | 'signed-out' | 'unknown';
  remoteInvocationAllowed(providerId: string): boolean;
  /** Providers this owner shares, from a complete snapshot; null while it is not known. */
  sharedProviderIds(): ReadonlySet<string> | null;
  hasProviderGroup(providerId: string): boolean;
  /** A display name the user gave the provider. */
  renamed(providerId: string): boolean;
  /** The provider's own on/off switch (Settings「停用供应商」) is off. */
  disabled(providerId: string): boolean;
}

export interface UpgradeSplitRepair {
  kind: SubscriptionProvider;
  providerId: string;
}

/** The next split provider to put back, if any. Callers merge one and ask again. */
export function findUpgradeSplitRepair(deps: UpgradeSplitRepairDeps, onlyProviderId?: string): UpgradeSplitRepair | null {
  // Unreadable files leave everything for a later load.
  file.invalidateIfChanged();
  const created = readCreatedSubscriptionProvidersIfReadable();
  if (!created || !readOpenAiLegacyAccountsIfReadable() || file.isUnreadable()) return null;
  const repaired = file.read().repaired;
  let shared: ReadonlySet<string> | null | undefined;
  for (const kind of ['openai', 'anthropic'] as const) {
    const pool = readPool(kind);
    // A built-in provider the user disconnected or switched off stays that way; merging into it
    // would stop the account.
    if (!pool || pool.disconnected || deps.disabled(kind)) continue;
    if (providerAccounts(kind, pool.accounts, kind)
      .some((account) => !account.paused && deps.signInEvidence(kind, account.id) !== 'signed-out')) continue;
    for (const [providerId, entry] of Object.entries(created)) {
      if (onlyProviderId !== undefined && onlyProviderId !== providerId) continue;
      if (entry.kind !== kind || repaired[providerId] === 'done' || !isUpgradeSplitProvider(providerId, entry)) continue;
      if (accountProviderId(kind, entry.account) !== providerId) continue;
      const own = providerAccounts(kind, pool.accounts, providerId);
      if (own.length !== 1 || own[0]!.id !== entry.account) continue;
      if (readProviderStrategy(providerId) !== undefined || deps.renamed(providerId) || deps.disabled(providerId)
        || deps.remoteInvocationAllowed(providerId) || deps.hasProviderGroup(providerId)) continue;
      shared ??= deps.sharedProviderIds();
      if (!shared || shared.has(providerId)) continue;
      return { kind, providerId };
    }
  }
  return null;
}

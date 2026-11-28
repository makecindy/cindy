import { isDeepStrictEqual } from 'node:util';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { captureProviderManagementScope, withProviderGroupMutation } from '../provider-group/managementScope.js';
import { readStoredProviderGroup } from '../provider-group/store.js';
import { withLocalProviderGroupAccounts, type ProviderGroupConfig } from '../../shared/providerGroup.js';
import { listProviderGroupBindings } from '../provider-group/bindings.desktop.js';
import { openAiAccountGroupKind } from '../../shared/openAiAccountGroup.js';
import { apiKeyMemberForConnection, apiKeyPoolMembers, migratedLocalAccountGroup, pendingNativePoolImport, saveApiKeyPoolMembers } from './apiKeyMembers.js';
import { accountProviderId, placeSubscriptionAccount, providerAccounts, readMergedProviderAccount, resolveSubscriptionPoolProvider, writeProviderStrategy } from './placement.js';
import { readPool, updatePool } from './store.js';
import { isNativeProviderAuthBound, isNativeProviderAuthSharedSystemCredential } from '../maker-host/nativeProviderAuthBinding.js';

async function attachExistingOpenAiPool(assertCurrent: () => void): Promise<void> {
  if (readPool('openai') || !isNativeProviderAuthBound('openai')) return;
  await updatePool('openai', current => {
    assertCurrent();
    return isNativeProviderAuthSharedSystemCredential('openai') ? current : { ...current, legacyCodexDefault: true };
  });
}

function connectionKind(id: string) {
  const row = getActiveCatalog().providers.find(provider => provider.id === id);
  return row && openAiAccountGroupKind(row);
}

export async function mergeOpenAiPoolConnections(source: string, target: string, assertCurrent: () => void) {
  await withProviderGroupMutation(async () => {
    assertCurrent();
    // The catalog was checked before waiting for the management lock. A source
    // already moved elsewhere, or a destination that became an alias, cannot be
    // used by this now-stale operation.
    if (readMergedProviderAccount(source) || readMergedProviderAccount(target)) {
      throw new Error('Providers cannot be merged');
    }
    const from = connectionKind(source);
    const to = connectionKind(target);
    const pool = readPool('openai');
    const targetHasNative = providerAccounts('openai', pool?.accounts ?? [], target).length > 0;
    if (from === 'apiKey' && (to === 'subscription' || (to === 'apiKey' && targetHasNative))) {
      if (resolveSubscriptionPoolProvider(target)?.kind !== 'openai') throw new Error('Unknown subscription provider');
      if (target === 'openai') await attachExistingOpenAiPool(assertCurrent);
      if (!readPool('openai')) throw new Error('Subscription pool not available');
      if (providerAccounts('openai', pool?.accounts ?? [], source).length
        || apiKeyPoolMembers(source).some(member => member.connectionId !== source)) throw new Error('The source has other accounts');
      await saveApiKeyPoolMembers(target, [{ connectionId: source }], assertCurrent, undefined, undefined, undefined, true);
      return;
    }
    if (from !== 'subscription' || to !== 'apiKey' || source === 'openai')
      throw new Error('Providers cannot be merged');
    const accounts = providerAccounts('openai', readPool('openai')?.accounts ?? [], source);
    if (!accounts.length || apiKeyPoolMembers(source).length) throw new Error('Account not found');
    await saveApiKeyPoolMembers(target, [{ connectionId: target }], assertCurrent);
    await placeSubscriptionAccount('openai', accounts.map(account => account.id), target, assertCurrent);
  });
}

/** The legacy flat group is an import source only. The canonical pool controls local, owner and guest picks. */
export async function migrateLegacyOpenAiPool(providerId: string, previous: ProviderGroupConfig) {
  const assertOwner = captureProviderManagementScope();
  await withProviderGroupMutation(async () => {
    const assertCurrent = () => {
      assertOwner();
      if (!isDeepStrictEqual(readStoredProviderGroup(providerId), previous)) throw new Error('The account group changed');
    };
    assertCurrent();
    if (migratedLocalAccountGroup(providerId) || !previous.localAccountIds?.length) return;
    await attachExistingOpenAiPool(assertCurrent);
    const local = withLocalProviderGroupAccounts(previous, providerId).members.filter(member => member.kind === 'local');
    const pool = readPool('openai');
    if (!pool) throw new Error('Subscription pool not available');
    const pending = pendingNativePoolImport(providerId);
    const sources = local.map(member => {
      if (connectionKind(member.providerId) === 'apiKey') {
        const existing = apiKeyMemberForConnection(member.providerId);
        if (existing && existing.providerId !== providerId) throw new Error('The account already belongs to another provider');
        return { member, native: [] as string[] };
      }
      const ref = resolveSubscriptionPoolProvider(member.providerId);
      if (ref?.kind !== 'openai') throw new Error('Unknown OpenAI account');
      const native = pending && Object.hasOwn(pending, member.providerId)
        ? pending[member.providerId].filter(id => pool.accounts.some(account => account.id === id)
          && [member.providerId, providerId].includes(accountProviderId('openai', id)))
        : providerAccounts('openai', pool.accounts, member.providerId).map(account => account.id);
      if (pending && native.length !== pending[member.providerId]?.length) throw new Error('Subscription account changed during import');
      if (!native.length && ref.ownAccount && accountProviderId('openai', ref.ownAccount) === providerId) native.push(ref.ownAccount);
      if (!native.length) throw new Error('Subscription account not available');
      return { member, native };
    });
    const native = sources.flatMap(source => source.native);
    const byId = new Map(sources.flatMap(({ member, native }) => native.map(id => [id, member] as const)));
    // First record the destination and its keys. Replaying an interrupted import
    // repeats only metadata writes, never auth, quota or task dispatch.
    const keys = sources.filter(source => !source.native.length).map(({ member }) => ({
      connectionId: member.providerId, weight: member.weight, limit: member.limit,
      limitSet: member.limitSet, paused: member.paused,
    }));
    await saveApiKeyPoolMembers(providerId, keys, assertCurrent, undefined, undefined, undefined, false,
      Object.fromEntries(sources.filter(source => source.native.length).map(({ member, native }) => [member.providerId, native])));
    await updatePool('openai', current => {
      assertCurrent();
      return { ...current, ...(providerId === 'openai' ? { strategy: previous.strategy } : {}),
        accounts: current.accounts.map(account => {
          const member = byId.get(account.id);
          if (!member) return account;
          const oldSettings = previous.localAccountSettings;
          const weight = oldSettings?.weights?.[member.providerId];
          const explicitLimit = oldSettings?.limits && Object.hasOwn(oldSettings.limits, member.providerId);
          return { ...account, ...(weight === undefined ? {} : { weight }),
            ...(explicitLimit ? { limit: member.limit, limitSet: member.limitSet } : {}),
            ...(member.paused ? { paused: true } : {}) };
        }) };
    });
    await placeSubscriptionAccount('openai', native, providerId, assertCurrent);
    if (providerId !== 'openai') await writeProviderStrategy(providerId, previous.strategy);
    const keyByMember = new Map(sources.filter(source => !source.native.length)
      .map(({ member }) => [member.key, member.providerId]));
    const legacyBindings = Object.fromEntries(Object.entries(listProviderGroupBindings()).flatMap(([sessionId, binding]) => {
      if (binding.providerId !== providerId || binding.groupDeviceId) return [];
      const connectionId = keyByMember.get(binding.memberKey);
      return connectionId ? [[sessionId, { source: providerId, connectionId }]] : [];
    }));
    await saveApiKeyPoolMembers(providerId, keys, assertCurrent, sources.flatMap(({ member, native }) =>
      native.length ? native : [member.providerId]), legacyBindings, previous.autoSwitch);
  });
}

const imports = new Map<string, Promise<void>>();
export async function prepareLegacyOpenAiPool(providerId: string): Promise<void> {
  if (migratedLocalAccountGroup(providerId)) return;
  const raw = readStoredProviderGroup(providerId);
  if (!raw?.localAccountIds?.length) return;
  const key = JSON.stringify([activeOwnerScopeKey(), providerId]);
  const pending = imports.get(key);
  if (pending) return pending;
  const task = migrateLegacyOpenAiPool(providerId, raw).finally(() => imports.delete(key));
  imports.set(key, task);
  return task;
}

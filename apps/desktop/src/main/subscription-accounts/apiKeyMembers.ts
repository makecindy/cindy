import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { concurrencyLimitPatch, isProviderGroupProviderId } from '../../shared/providerGroup.js';
import { DEFAULT_SUBSCRIPTION_ACCOUNT, type SubscriptionAccountConfig } from '../../shared/subscriptionAccounts.js';

export interface ApiKeyPoolMember extends SubscriptionAccountConfig {
  /** Original provider and credential route. The endpoint and secret stay in that connection. */
  connectionId: string;
  providerId: string;
}

interface MembershipFile {
  members: Record<string, ApiKeyPoolMember>;
  order: Record<string, string[]>;
  migrated?: string[];
  pendingNativeImports?: Record<string, Record<string, string[]>>;
  /** Imported origin of existing task bindings; never used for new account selection. */
  legacyBindings?: Record<string, { source: string; connectionId: string }>;
  disabledAutoSwitch?: string[];
}

// Older clients rewrite the native pool and placement files, discarding unknown fields.
// Persist API membership separately from the legacy format, without a second copy of it.
const store = createOverrideSettingsFile<MembershipFile>({
  filePath: () => ownerScopedUserDataPath('subscription-api-key-members.json'),
  scopeKey: activeOwnerScopeKey,
  label: 'subscription-api-key-members',
  log: desktopMakerLogger,
  defaults: { members: {}, order: {} },
  maxBytes: 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  normalize(raw) {
    const saved = raw as Partial<MembershipFile> | null;
    const members: MembershipFile['members'] = {};
    const order: MembershipFile['order'] = {};
    for (const [connectionId, member] of Object.entries(saved?.members ?? {}).slice(0, 512)) {
      if (!isProviderGroupProviderId(connectionId) || !isProviderGroupProviderId(member?.providerId)) continue;
      members[connectionId] = {
        id: keyAccountId(connectionId), connectionId, providerId: member.providerId,
        paused: member.paused === true,
        ...concurrencyLimitPatch(member.limitSet === true && Number.isInteger(member.limit)
          && member.limit >= 1 && member.limit <= 16 ? member.limit : null),
        weight: Number.isInteger(member.weight) && member.weight >= 1 && member.weight <= 100 ? member.weight : 1,
      };
    }
    for (const [providerId, ids] of Object.entries(saved?.order ?? {}).slice(0, 512)) {
      if (!isProviderGroupProviderId(providerId) || !Array.isArray(ids)) continue;
      order[providerId] = [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 64))].slice(0, 512);
    }
    const legacyBindings: NonNullable<MembershipFile['legacyBindings']> = {};
    for (const [id, binding] of Object.entries(saved?.legacyBindings ?? {}).slice(0, 4000)) {
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id) || !isProviderGroupProviderId(binding?.source)
        || !isProviderGroupProviderId(binding?.connectionId)) continue;
      legacyBindings[id] = binding;
    }
    const pendingNativeImports: NonNullable<MembershipFile['pendingNativeImports']> = {};
    for (const [destination, sources] of Object.entries(saved?.pendingNativeImports ?? {}).slice(0, 512)) {
      if (!isProviderGroupProviderId(destination) || !sources || typeof sources !== 'object') continue;
      pendingNativeImports[destination] = Object.fromEntries(Object.entries(sources).slice(0, 512)
        .filter(([source, ids]) => isProviderGroupProviderId(source) && Array.isArray(ids))
        .map(([source, ids]) => [source, ids.filter(id => typeof id === 'string'
          && /^(?:default|cindy-[a-f0-9]{12}-[a-f0-9]{36})$/.test(id)).slice(0, 512)]));
    }
    return { members, order, legacyBindings, pendingNativeImports, ...(Array.isArray(saved?.disabledAutoSwitch) ? {
      disabledAutoSwitch: [...new Set(saved.disabledAutoSwitch.filter(isProviderGroupProviderId))].slice(0, 512),
    } : {}), ...(Array.isArray(saved?.migrated) ? {
      migrated: [...new Set(saved.migrated.filter(isProviderGroupProviderId))].slice(0, 512),
    } : {}) };
  },
});

function keyAccountId(connectionId: string): string {
  // A syntactically valid native binding id keeps the affinity record readable on
  // downgrade. An old client has no account with this id and cannot use its home.
  const hash = createHash('sha256').update('api-key-account\0' + connectionId).digest('hex');
  return `cindy-${hash.slice(0, 12)}-${hash.slice(12, 48)}`;
}

function read(): MembershipFile {
  store.invalidateIfChanged();
  return store.read();
}

export function apiKeyPoolMember(id: string): ApiKeyPoolMember | undefined {
  return Object.values(read().members).find(member => member.id === id);
}

export function apiKeyMemberForConnection(connectionId: string): ApiKeyPoolMember | undefined {
  const members = read().members;
  return Object.hasOwn(members, connectionId) ? members[connectionId] : undefined;
}

export function apiKeyPoolMembers(providerId: string): ApiKeyPoolMember[] {
  return Object.values(read().members).filter(member => member.providerId === providerId);
}

export function hasApiKeyPoolWithMultipleMembers(): boolean {
  const owners = new Set<string>();
  return Object.values(read().members).some(member => {
    if (owners.has(member.providerId)) return true;
    owners.add(member.providerId);
    return false;
  });
}

export function migratedLocalAccountGroup(providerId: string): boolean {
  return read().migrated?.includes(providerId) === true;
}

export function pendingNativePoolImport(providerId: string): Record<string, string[]> | undefined {
  return read().pendingNativeImports?.[providerId];
}

export function apiKeyPoolAllowsAutoSwitch(providerId: string): boolean {
  return !read().disabledAutoSwitch?.includes(providerId);
}

export function legacyApiKeyPoolBinding(sessionId: string | undefined, source: string): string | undefined {
  if (!sessionId) return;
  const saved = read().legacyBindings;
  const binding = saved && Object.hasOwn(saved, sessionId) ? saved[sessionId] : undefined;
  if (binding && (binding.source === source || binding.connectionId === source))
    return apiKeyMemberForConnection(binding.connectionId)?.id;
}

export function poolDispatchOrder<T extends { id: string }>(providerId: string, members: T[]): T[] {
  const order = read().order[providerId];
  if (!order?.length) return members;
  const position = new Map(order.map((id, index) => [id, index]));
  return [...members].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
}

export async function saveApiKeyPoolMembers(
  providerId: string,
  inputs: readonly (Pick<ApiKeyPoolMember, 'connectionId'> & Partial<Pick<ApiKeyPoolMember, 'weight' | 'limit' | 'limitSet' | 'paused'>>)[],
  assertCurrent: () => void,
  order?: readonly string[],
  legacyBindings?: MembershipFile['legacyBindings'],
  autoSwitch?: boolean,
  moveStandalone = false,
  nativeImport?: Record<string, string[]>,
): Promise<void> {
  const owner = activeOwnerScopeKey();
  await store.updateAtomic(({ value }) => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Subscription account owner changed');
    assertCurrent();
    const members = { ...value.members };
    if (Object.keys(members).length + inputs.filter(input => !Object.hasOwn(members, input.connectionId)).length > 512)
      throw new Error('Too many subscription accounts');
    for (const input of inputs) {
      if (!isProviderGroupProviderId(providerId) || !isProviderGroupProviderId(input.connectionId)) throw new Error('Invalid provider');
      const previous = Object.hasOwn(members, input.connectionId) ? members[input.connectionId] : undefined;
      if (previous && previous.providerId !== providerId && (!moveStandalone || previous.providerId !== previous.connectionId))
        throw new Error('Account already belongs to another provider');
      members[input.connectionId] = { ...DEFAULT_SUBSCRIPTION_ACCOUNT, ...previous, ...input,
        id: keyAccountId(input.connectionId), providerId };
    }
    const pendingNativeImports = { ...value.pendingNativeImports };
    if (nativeImport) pendingNativeImports[providerId] = nativeImport;
    if (legacyBindings) delete pendingNativeImports[providerId];
    return { members, pendingNativeImports, ...(order ? { order: { ...value.order, [providerId]: order.map(id =>
      inputs.some(input => input.connectionId === id) ? keyAccountId(id) : id) } } : {}),
      ...(legacyBindings ? { migrated: [...new Set([...(value.migrated ?? []), providerId])],
        legacyBindings: { ...value.legacyBindings, ...legacyBindings } } : {}),
      ...(autoSwitch === false ? { disabledAutoSwitch: [...new Set([...(value.disabledAutoSwitch ?? []), providerId])] } : {}),
    };
  });
}

export async function restoreStandaloneApiKeyMember(member: ApiKeyPoolMember, assertCurrent: () => void): Promise<void> {
  const owner = activeOwnerScopeKey();
  await store.updateAtomic(({ value }) => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Subscription account owner changed');
    assertCurrent();
    const current = value.members[member.connectionId];
    if (current?.providerId !== member.providerId || member.providerId === member.connectionId)
      throw new Error('The account is already standalone');
    const order = { ...value.order, [member.providerId]: (value.order[member.providerId] ?? []).filter(id => id !== member.id) };
    return { members: { ...value.members, [member.connectionId]: { ...current, providerId: member.connectionId } }, order };
  });
}

/** Platform assembly for the shared service. */
import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
import { createProviderGroupStore } from './storeCore.js';
import { migratedLocalAccountGroup } from '../subscription-accounts/apiKeyMembers.js';
import { isDeepStrictEqual } from 'node:util';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { ProviderGroupConfig } from '../../shared/providerGroup.js';
export type { ProviderGroupBindingCleanup } from './storeCore.js';
const store = createProviderGroupStore({
  // Availability revocation reaches Device Link, whose bootstrap also reads groups.
  // Preserve the live import across that cycle instead of capturing an unset port.
  withAvailabilityPolicyMutation: (providerId, work) => withAvailabilityPolicyMutation(providerId, work),
});
export const { onProviderGroupChanged, listProviderGroupBindingCleanups, completeProviderGroupBindingCleanup,
  updateProviderGroup, listProviderGroupReshareCleanups, completeProviderGroupReshareCleanup, __testing } = store;
export const readStoredProviderGroup = store.readProviderGroup;

function computerGroup(providerId: string, config: ProviderGroupConfig | null): ProviderGroupConfig | null {
  if (!config?.localAccountIds?.length || !migratedLocalAccountGroup(providerId)) return config;
  if (!config.members.some(member => member.kind !== 'local')) return null;
  const result = { ...config };
  delete result.localAccountIds;
  delete result.localAccountSettings;
  return result;
}

export function readProviderGroup(providerId: string): ProviderGroupConfig | null {
  return computerGroup(providerId, store.readProviderGroup(providerId));
}

export function listProviderGroups(): Record<string, ProviderGroupConfig> {
  return Object.fromEntries(Object.entries(store.listProviderGroups()).flatMap(([id, config]) => {
    const visible = computerGroup(id, config);
    return visible ? [[id, visible]] : [];
  }));
}

export async function writeProviderGroup(providerId: string, config: unknown, expectedConfig?: ProviderGroupConfig | null) {
  const raw = store.readProviderGroup(providerId);
  if (!raw?.localAccountIds?.length || !migratedLocalAccountGroup(providerId))
    return store.writeProviderGroup(providerId, config, expectedConfig);
  if (expectedConfig !== undefined && !isDeepStrictEqual(computerGroup(providerId, raw), expectedConfig))
    throwIpcError('PROVIDER_GROUP_CHANGED', 'The provider group changed while it was being edited');
  return store.writeProviderGroup(providerId, config, raw);
}

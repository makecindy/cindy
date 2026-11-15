/** Platform assembly for the shared service. */

import {
  completeProviderGroupBindingCleanup,
  listProviderGroupBindingCleanups,
  readProviderGroup,
  type ProviderGroupBindingCleanup,
} from './store.js';
import { createProviderGroupBindings } from './bindings.js';
export type { ProviderGroupBinding, ProviderGroupRef, ProviderGroupRelease } from './bindings.js';
export const { MAX_PROVIDER_GROUP_BINDINGS, readProviderGroupBinding, listProviderGroupBindings, listRemoteProviderGroupBindings, writeProviderGroupBinding, isProviderGroupReleased, markProviderGroupReleased, pruneProviderGroupBindings, __testing } = createProviderGroupBindings({ completeProviderGroupBindingCleanup, listProviderGroupBindingCleanups, readProviderGroup });

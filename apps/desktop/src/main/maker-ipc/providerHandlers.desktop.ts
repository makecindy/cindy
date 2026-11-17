/** Desktop platform bindings; the shared handlers never load Electron adapters. */
import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
import { pruneProviderGroupBindings } from '../provider-group/bindings.desktop.js';
import { writeProviderGroup } from '../provider-group/store.js';
import { notifyManagedOllamaRemoved } from '../local-model-runtime/ipc.js';
import { stopManagedLlamaCppService } from '../local-model-runtime/llamaCppService.js';
import { registerProviderHandlers as registerSharedProviderHandlers, type ProviderHandlerDeps as SharedProviderHandlerDeps, type ProviderPlatformPorts } from './providerHandlers.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export type ProviderHandlerDeps = Omit<SharedProviderHandlerDeps, keyof ProviderPlatformPorts>;

export function registerProviderHandlers(registry: IpcHandlerRegistry, deps: ProviderHandlerDeps) {
  const ports: ProviderPlatformPorts = {
    withAvailabilityPolicyMutation: (providerId, work) => withAvailabilityPolicyMutation(providerId, work),
    writeProviderGroup: (providerId, config) => writeProviderGroup(providerId, config),
    pruneProviderGroupBindings: (providerId, keepMemberKeys) => pruneProviderGroupBindings(providerId, keepMemberKeys),
    notifyManagedOllamaRemoved: () => notifyManagedOllamaRemoved(),
    stopManagedLlamaCppService: deleteConnection => stopManagedLlamaCppService(deleteConnection),
  };
  // Preserve live dependency readers supplied by the caller after registration.
  return registerSharedProviderHandlers(registry, Object.assign(deps, ports));
}

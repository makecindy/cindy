import { getAppCapabilities } from '../appCapabilities.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';

/**
 * Lightweight Host capability probe for consumers that must not initialize
 * the model-access IPC / gateway runtime merely to assess readiness.
 *
 * The owning subsystem remains authoritative: Cindy account capability and
 * the locally persisted gateway credential must both be present.
 */
export function isModelAccessReady(): boolean {
  return getAppCapabilities().canUseCindyGateway && Boolean(getProviderSecretStore().get('xd'));
}

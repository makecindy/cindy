import { createProviderService as createSharedProviderService, type ProviderServiceDeps } from '@cindy/app-runtime/providerService';
import { createLogger } from '../logger.js';
import { mediaErrorForLog } from '../cindy-media/mediaRequestLog.js';
export * from '@cindy/app-runtime/providerService';
const log = createLogger('provider-service');
export function createProviderService(deps: ProviderServiceDeps) {
  return createSharedProviderService({...deps, onMediaReadinessError: error => log.warn(
    'Media readiness unavailable; returning provider configuration without media readiness',
    {error: mediaErrorForLog(error)},
  )});
}

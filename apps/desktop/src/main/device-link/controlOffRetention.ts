import { invalidateProviderMetadataContinuity } from './providerMetadataContinuity.js';

/**
 * A fresh, online control-off is a known permission refusal: end the bounded
 * metadata/routing retention for exactly this target. It does not close the
 * shared data path (reverse traffic stays healthy) and must not touch neighbours.
 */
export function retireControlOffRetention(deviceId: string): void {
  invalidateProviderMetadataContinuity(deviceId);
}

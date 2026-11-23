import { isDeviceUnresponsiveRemoteError, isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';

import { extractIpcError } from '@/utils/ipcError';

/**
 * A temporary remote catalog read failure (timeout, link drop, busy, unresponsive): a bounded snapshot
 * already on screen stays usable, and the read recovers on the existing triggers (foreground,
 * reconnect, source push). Expired budgets (MODEL_VISIBILITY_NOT_READY), refusals and unsupported
 * targets are not temporary. One rule for the picker pill, the multi-device rail and remote-control
 * share discovery.
 */
export function isTemporaryCatalogFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  if (extractIpcError(new Error(error))?.code === 'MODEL_VISIBILITY_NOT_READY') return false;
  return isTransientRemoteError(error) || isDeviceUnresponsiveRemoteError(error);
}

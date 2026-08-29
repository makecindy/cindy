import type { BrowserControlResult } from '@cindy/browser-control-runtime';

import { RealProfileError } from './types.js';

function isRunningFlag(data: unknown): boolean {
  return data !== null && typeof data === 'object' && (data as { running?: unknown }).running === true;
}

/**
 * Profile / consent switches must not proceed while the managed Chrome is still
 * up. POSIX unlinks leave cookie and password bytes in open handles; a failed
 * or unverifiable stop is therefore a hard failure, not a warning.
 */
export function assertManagedBrowserStopped(options: {
  status: BrowserControlResult;
  stop: BrowserControlResult | null;
}): void {
  if (!options.status.ok) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not verify that the agent browser has stopped.',
    );
  }
  if (!isRunningFlag(options.status.data)) return;
  if (!options.stop?.ok) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not stop the agent browser before changing copied logins.',
    );
  }
}

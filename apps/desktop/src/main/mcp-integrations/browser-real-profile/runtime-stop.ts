import type { BrowserControlResult } from '@cindy/browser-control-runtime';

import { RealProfileError } from './types.js';

function isRunningFlag(data: unknown): boolean {
  return (
    data !== null && typeof data === 'object' && (data as { running?: unknown }).running === true
  );
}

function isStoppedFlag(data: unknown): boolean {
  return (
    data !== null && typeof data === 'object' && (data as { stopped?: unknown }).stopped === true
  );
}

/**
 * Live-stop must not hot-reload managed identity. Crash restart already
 * injected the remembered CDP port at module load; a live session still has
 * `executablePath` + `cdpPort` from the last start. Rebuilding config with
 * only `cdpPort` drops the source browser path, the vendored runtime treats
 * that as a profile invariant change, kills the process, then returns
 * `stopped: false`.
 */
export function managedConfigPatchBeforeStop(_input: {
  rememberedCdpPort: number | null;
}): { useRealProfile: true; cdpPort: number; executablePath?: string } | null {
  return null;
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
  if (!options.stop?.ok || !isStoppedFlag(options.stop.data)) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not stop the agent browser before changing copied logins.',
    );
  }
}

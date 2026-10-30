import type {
  BrowserControlResult,
  BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import { RealProfileError } from './types.js';

export interface BrowserProfileLifecycleQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serialize every external-browser operation with real-profile consent changes.
 * A failed operation must not poison later work, so the private tail always
 * settles successfully while each caller still receives its own result.
 */
export function createBrowserProfileLifecycleQueue(): BrowserProfileLifecycleQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export function wrapRuntimeWithProfileLifecycleQueue(
  runtime: Pick<BrowserControlRuntime, 'call'>,
  queue: BrowserProfileLifecycleQueue,
): Pick<BrowserControlRuntime, 'call'> {
  return {
    call: (request) => queue.run(() => runtime.call(request)),
  };
}

function runningFlag(data: unknown): boolean | null {
  if (data === null || typeof data !== 'object') return null;
  const running = (data as { running?: unknown }).running;
  return typeof running === 'boolean' ? running : null;
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

function managedProcessPresent(data: unknown): boolean | null {
  if (data === null || typeof data !== 'object') return null;
  const pid = (data as { pid?: unknown }).pid;
  if (pid === undefined || pid === null) return false;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? true : null;
}

function managedBrowserNeedsStop(data: unknown): boolean | null {
  const running = runningFlag(data);
  const processPresent = managedProcessPresent(data);
  if (running === null || processPresent === null) return null;
  return running || processPresent;
}

/**
 * Check and stop one explicit managed profile as a single operation. Pinning
 * both calls avoids the runtime's cached default profile during config reloads.
 */
export async function stopManagedBrowserForProfile(
  runtime: Pick<BrowserControlRuntime, 'call'>,
  profile: string,
): Promise<void> {
  const status = await runtime.call({ action: 'status', profile });
  const stop = status.ok && managedBrowserNeedsStop(status.data) === true
    ? await runtime.call({ action: 'stop', profile })
    : null;
  assertManagedBrowserStopped({ status, stop });
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
  const needsStop = managedBrowserNeedsStop(options.status.data);
  if (!options.status.ok || needsStop === null) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not verify that the agent browser has stopped.',
    );
  }
  if (!needsStop) return;
  if (!options.stop?.ok || !isStoppedFlag(options.stop.data)) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not stop the agent browser before changing copied logins.',
    );
  }
}

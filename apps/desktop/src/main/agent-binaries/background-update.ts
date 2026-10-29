import { app } from 'electron';
import { isCindyPersonalRuntime } from '../cindy-make/versionRuntimeIdentity.js';
import { getCachedManifest, onManifestFetched, type Manifest } from '../manifestService.js';
import { prefetch } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-binaries/background-update');
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let pending: Manifest | undefined;
let running = false;

/** Start after environment readiness. The app's existing checks supply fresh metadata. */
export function startBinaryBackgroundUpdates(): void {
  if (unsubscribe || !app.isPackaged || isCindyPersonalRuntime()) return;
  controller = new AbortController();
  const signal = controller.signal;
  const queue = (manifest: Manifest): void => {
    pending = manifest;
    if (running || timer) return;
    timer = setTimeout(() => { timer = undefined; void run(signal); }, 0);
    timer.unref?.();
  };
  unsubscribe = onManifestFetched(queue);
  // Let the main window finish opening; do not add any await to startup.
  timer = setTimeout(() => {
    timer = undefined;
    const manifest = pending ?? getCachedManifest();
    if (manifest) queue(manifest);
  }, 10_000);
  timer.unref?.();
  app.once('will-quit', stopBinaryBackgroundUpdates);
}

async function run(signal: AbortSignal): Promise<void> {
  running = true;
  try {
    while (pending && !signal.aborted) {
      const manifest = pending;
      pending = undefined;
      for (const kind of ['claude-code', 'codex', 'pi'] as const) {
        if (signal.aborted) break;
        await prefetch(kind, { manifest, signal });
      }
    }
  } catch {
    log.warn('Binary prefetch stopped; a later update check will retry');
  } finally { running = false; }
}

export function stopBinaryBackgroundUpdates(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  controller?.abort();
  controller = undefined;
  pending = undefined;
  app.removeListener('will-quit', stopBinaryBackgroundUpdates);
}

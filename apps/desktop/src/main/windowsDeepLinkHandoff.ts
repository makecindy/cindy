import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** A narrow, main-only transport. It never accepts command lines or file paths. */
export interface WindowsDeepLinkNative {
  isProcessElevated(): boolean;
  startDeepLinkServer(scope: string, receive: (message: string) => void): { close(): void };
  sendDeepLink(scope: string, message: string): boolean;
}

const MAX_MESSAGE_BYTES = 32_768;
const MAX_RECEIPTS = 256;
const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function requestId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>).cindyDeepLinkRequest;
  return typeof value === 'string' && requestIdPattern.test(value) ? value : null;
}

/** Separate clicks get separate IDs; only the two deliveries of ONE click coalesce. */
export function deepLinkRequestData(): { cindyDeepLinkRequest: string } {
  return { cindyDeepLinkRequest: randomUUID() };
}

export function createWindowsDeepLinkHandoff(options: {
  lockScopeDir: string;
  native: WindowsDeepLinkNative;
  isDeepLink: (url: string) => boolean;
  dispatch: (url: string, source: string) => void;
  onFailure: (stage: 'listen' | 'send' | 'receive') => void;
}) {
  // Match Electron's profile/flavor lock. No profile paths, invitation tokens or
  // API keys are written to disk, passed to a shell, or included in pipe names.
  const scope = createHash('sha256')
    .update(path.win32.resolve(options.lockScopeDir).toLowerCase())
    .digest('hex');
  const receipts = new Set<string>();
  let server: { close(): void } | undefined;
  let closed = false;

  function dispatch(url: string, data: unknown, source: string): void {
    if (closed) return;
    const id = requestId(data);
    if (id) {
      if (receipts.has(id)) return;
      if (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!);
      // Record BEFORE dispatch: parsing some links creates an import draft.
      // No time expiry: Electron may hold second-instance until a slow startup
      // reaches ready, long after the native handoff has already been queued.
      receipts.add(id);
    }
    options.dispatch(url, source);
  }

  return {
    dispatch,
    start(): void {
      try {
        // Normal applications retain Electron's existing single-instance path.
        if (closed || server || !options.native.isProcessElevated()) return;
        server = options.native.startDeepLinkServer(scope, (message) => {
          if (closed || Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return;
          try {
            const data: unknown = JSON.parse(message);
            if (!data || typeof data !== 'object' || !requestId(data)) return;
            const url = (data as Record<string, unknown>).url;
            if (typeof url !== 'string' || url.includes('\0') || !options.isDeepLink(url)) return;
            dispatch(url, data, 'windows-handoff');
          } catch {
            options.onFailure('receive');
          }
        });
      } catch {
        options.onFailure('listen');
      }
    },
    forward(url: string, data: unknown): boolean {
      try {
        // Only the proven failing privilege direction needs compensation.
        if (!requestId(data) || !options.isDeepLink(url) || options.native.isProcessElevated()) return false;
        const message = JSON.stringify({ cindyDeepLinkRequest: requestId(data), url });
        if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES || url.includes('\0')) return false;
        return options.native.sendDeepLink(scope, message);
      } catch {
        options.onFailure('send');
        return false;
      }
    },
    close(): void {
      closed = true;
      receipts.clear();
      server?.close();
      server = undefined;
    },
  };
}

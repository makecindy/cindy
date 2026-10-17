import { createIpcError, type IpcErrorCode } from '../../shared/ipc-errors.js';
import { toWorkdirRel } from '../../shared/workdirPath.js';
import type { HtmlPreviewArgs } from './html-preview.js';
import type { RemoteFileBrowserManager } from './remote.js';

const TRANSPORT_ERRORS = {
  BACKPRESSURE: 'DEVICE_LINK_BUSY',
  DEVICE_LINK_BUSY: 'DEVICE_LINK_BUSY',
  INVOKE_TIMEOUT: 'DEVICE_LINK_TIMEOUT',
  DEVICE_LINK_TIMEOUT: 'DEVICE_LINK_TIMEOUT',
  NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED',
  DEVICE_LINK_NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED',
  LINK_NOT_OPEN: 'DEVICE_LINK_NOT_CONNECTED',
  DEVICE_OFFLINE: 'DEVICE_LINK_DEVICE_OFFLINE',
  DEVICE_LINK_DEVICE_OFFLINE: 'DEVICE_LINK_DEVICE_OFFLINE',
  DEVICE_UNRESPONSIVE: 'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  DEVICE_LINK_DEVICE_UNRESPONSIVE: 'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  PEER_RESET: 'DEVICE_LINK_NOT_CONNECTED',
  TIMEOUT: 'DEVICE_LINK_TIMEOUT',
  CHANNEL_CLOSED: 'DEVICE_LINK_NOT_CONNECTED',
  CHANNEL_ERROR: 'DEVICE_LINK_NOT_CONNECTED',
} satisfies Record<string, IpcErrorCode>;

/** Keep both SSH reads together so cancellation also covers connection rebuilds. */
export async function statSshPreviewMetadata(
  browser: Pick<RemoteFileBrowserManager, 'request'>,
  args: HtmlPreviewArgs,
  root: string,
  relPath: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (args.origin.kind !== 'ssh') throw new Error('BAD_ARGS');
  const options = { beforeSend: () => signal?.throwIfAborted() };
  await browser.request(args.origin.remoteHostId, 'stat', {
    workdir: args.workdir,
    relPath: toWorkdirRel(args.workdir, args.absPath)!,
  }, options);
  signal?.throwIfAborted();
  return browser.request(args.origin.remoteHostId, 'stat', { workdir: root, relPath }, options);
}

/** Closed vocabulary; never expose the remote error text or path to the UI. */
export function previewTransportErrorCode(error: unknown): IpcErrorCode | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const key =
    typeof code === 'string'
      ? code
      : error instanceof Error
        ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1]
        : undefined;
  return key && Object.hasOwn(TRANSPORT_ERRORS, key)
    ? TRANSPORT_ERRORS[key as keyof typeof TRANSPORT_ERRORS]
    : undefined;
}

/** Retry only the preview's read-only stat, never a whole remote-op channel or download. */
export async function readPreviewMetadata<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<T> {
  const budget = new AbortController();
  const timeoutError = createIpcError('DEVICE_LINK_TIMEOUT', 'Preview read timed out');
  const timer = setTimeout(() => budget.abort(timeoutError), 60_000);
  const combined = AbortSignal.any([signal, budget.signal]);
  const started = performance.now();
  const check = () => {
    if (signal.aborted || !isCurrent())
      throw createIpcError('HTML_PREVIEW_CANCELLED', 'Preview cancelled');
    if (budget.signal.aborted || performance.now() - started >= 60_000) throw timeoutError;
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    try {
      check();
    } catch (error) {
      rejectAbort(error);
    }
  };
  combined.addEventListener('abort', onAbort, { once: true });
  try {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        const value = await Promise.race([read(combined), aborted]);
        check();
        return value;
      } catch (error) {
        check();
        const code = previewTransportErrorCode(error);
        if (!code || attempt >= 3) throw error;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              retryTimer = setTimeout(resolve, 1_000 * 2 ** attempt);
            }),
            aborted,
          ]);
        } finally {
          clearTimeout(retryTimer);
        }
      }
    }
  } catch (error) {
    check();
    throw error;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

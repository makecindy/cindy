/**
 * Streaming raw PUT of a local file to a trusted pre-signed URL.
 *
 * Must carry the two signed headers exactly as issued. Content-Length is not
 * signed and must be set precisely. Do not use outboundFetch: its proxy path
 * buffers the whole body. 3xx is rejected because a consumed stream cannot
 * be replayed by following Location. 3xx is refused (`maxRedirections: 0`)
 * and treated as retry_same_url because the PUT did not execute a write.
 *
 * `bytesSent` is bytes queued into the Transform, not bytes acknowledged by
 * OSS. That bias is conservative: abort after enqueue may commit and then
 * see UPLOAD_OBJECT_MISSING, never overwrite or double-publish.
 */
import type { FileHandle } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';

import { resolveOutboundDispatcher } from '../maker-host/outbound-fetch.js';
import { PLUGIN_PUBLISHER_UPLOAD_TTL_MS } from './types.js';

export const PLUGIN_PUBLISHER_PUT_STALL_TIMEOUT_MS = 60_000;
export const PLUGIN_PUBLISHER_PUT_MAX_TOTAL_MS = PLUGIN_PUBLISHER_UPLOAD_TTL_MS;
export const PLUGIN_PUBLISHER_PUT_HIGH_WATER_MARK = 64 * 1024;

export type PluginPublisherPutDisposition =
  | 'retry_same_url'
  | 'commit_same_upload'
  | 'cancelled_incomplete'
  | 'cancelled_uncertain';

export class PluginPublisherPutError extends Error {
  constructor(
    message: string,
    readonly disposition: PluginPublisherPutDisposition,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'PluginPublisherPutError';
  }
}

export interface PutRequestResponse {
  statusCode: number;
  body: { dump(): Promise<unknown> };
}

export interface PutRequestInit {
  method: 'PUT';
  body: Readable;
  headers: Record<string, string>;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
}

export interface PutLocalFileOptions {
  putUrl: string;
  headers: Record<string, string>;
  sizeBytes: number;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  maxTotalMs?: number;
  onBytes?: (bytesSent: number) => void;
  now?: () => number;
  requestImpl?: (url: string, init: PutRequestInit) => Promise<PutRequestResponse>;
  resolveDispatcher?: (url: string, opts: { signal?: AbortSignal }) => Promise<Dispatcher | undefined>;
}

function classifyNetworkFailure(error: unknown): PluginPublisherPutDisposition {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/ENOTFOUND|EAI_AGAIN|CERT_|ERR_TLS|UNABLE_TO_VERIFY|ERR_INVALID_URL|TypeError/i.test(text)) {
    return 'retry_same_url';
  }
  return 'commit_same_upload';
}

export async function putLocalFile(
  handle: FileHandle,
  options: PutLocalFileOptions,
): Promise<{ bytesSent: number }> {
  const stallTimeoutMs = options.stallTimeoutMs ?? PLUGIN_PUBLISHER_PUT_STALL_TIMEOUT_MS;
  const maxTotalMs = options.maxTotalMs ?? PLUGIN_PUBLISHER_PUT_MAX_TOTAL_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastProgressAt = startedAt;
  let bytesSent = 0;
  let settled = false;

  const throwIfAborted = (uncertain: boolean): void => {
    if (!options.signal?.aborted) return;
    throw new PluginPublisherPutError(
      'Plugin package upload was cancelled',
      uncertain ? 'cancelled_uncertain' : 'cancelled_incomplete',
    );
  };

  throwIfAborted(false);

  const stream = handle.createReadStream({
    autoClose: false,
    start: 0,
    highWaterMark: PLUGIN_PUBLISHER_PUT_HIGH_WATER_MARK,
  });
  const counting = new Transform({
    highWaterMark: PLUGIN_PUBLISHER_PUT_HIGH_WATER_MARK,
    transform(chunk: Buffer, _enc, cb) {
      bytesSent += chunk.length;
      lastProgressAt = now();
      options.onBytes?.(bytesSent);
      cb(null, chunk);
    },
  });
  stream.on('error', (err) => counting.destroy(err));
  const body = stream.pipe(counting);

  const abortController = new AbortController();
  const onOuterAbort = (): void => abortController.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const stallTimer = setInterval(() => {
    if (settled) return;
    const t = now();
    if (t - lastProgressAt >= stallTimeoutMs || t - startedAt >= maxTotalMs) {
      abortController.abort();
    }
  }, 1_000);

  try {
    const dispatcher = await (options.resolveDispatcher ?? resolveOutboundDispatcher)(options.putUrl, {
      signal: abortController.signal,
    });
    throwIfAborted(false);
    const requestImpl =
      options.requestImpl ??
      ((url, init) =>
        request(url, {
          ...init,
          // Streamed bodies cannot be replayed; refuse OSS 3xx instead of following.
          maxRedirections: 0,
        } as Parameters<typeof request>[1]));
    const response = await requestImpl(options.putUrl, {
      method: 'PUT',
      body,
      headers: {
        ...options.headers,
        'content-length': String(options.sizeBytes),
      },
      signal: abortController.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    settled = true;
    const status = response.statusCode;
    await response.body.dump().catch(() => undefined);

    if (status >= 300 && status < 400) {
      throw new PluginPublisherPutError(
        'Pre-signed upload redirected; streamed PUT does not follow redirects',
        'retry_same_url',
        status,
      );
    }
    if (status === 409) {
      // x-oss-forbid-overwrite hit: the object is already there. Commit.
      return { bytesSent: options.sizeBytes };
    }
    if (status === 200) return { bytesSent };
    if (status >= 500) {
      throw new PluginPublisherPutError(
        `Pre-signed upload returned ${status}`,
        'commit_same_upload',
        status,
      );
    }
    throw new PluginPublisherPutError(
      `Pre-signed upload returned ${status}`,
      'retry_same_url',
      status,
    );
  } catch (error) {
    settled = true;
    if (error instanceof PluginPublisherPutError) throw error;
    if (options.signal?.aborted) {
      throw new PluginPublisherPutError(
        'Plugin package upload was cancelled',
        bytesSent > 0 ? 'cancelled_uncertain' : 'cancelled_incomplete',
      );
    }
    if (abortController.signal.aborted) {
      throw new PluginPublisherPutError(
        bytesSent > 0
          ? 'Plugin package upload stalled or exceeded the session window'
          : 'Plugin package upload stalled before any bytes were sent',
        bytesSent > 0 ? 'commit_same_upload' : 'retry_same_url',
      );
    }
    throw new PluginPublisherPutError(
      error instanceof Error ? error.message : String(error),
      classifyNetworkFailure(error),
    );
  } finally {
    settled = true;
    clearInterval(stallTimer);
    options.signal?.removeEventListener('abort', onOuterAbort);
    stream.destroy();
    counting.destroy();
  }
}

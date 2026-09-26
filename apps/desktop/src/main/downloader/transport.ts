/** One HTTP attempt. Callers supply policy; queueing/retries live in scheduler.
 * Await disk writes to bound memory even for multi-gigabyte runtime archives. */
import { requestResponse } from './http';
import fs from 'node:fs';
import path from 'node:path';
import { DownloadError, type DownloadOptions, type Logger } from './types';
import {
  partPath,
  readMeta,
  writeMeta,
  deletePart,
  deleteMeta,
  decideResumeOffset,
  type MetaJson,
} from './resume';
import { createStreamingHasher } from './integrity';
import { ProgressTracker } from './progress';

export interface TransportContext {
  opts: DownloadOptions;
  logger: Logger;
  signal?: AbortSignal;
  resumedFromBytes: number;
}
export interface TransportResult {
  size: number;
  sha256: string;
}

export function assertDownloadUrl(url: string, opts: DownloadOptions): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError('URL_POLICY', 'Invalid download URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (opts.isUrlAllowed && !opts.isUrlAllowed(url))
  ) {
    throw new DownloadError('URL_POLICY', 'Download URL is not allowed');
  }
}

export async function executeOnce(ctx: TransportContext): Promise<TransportResult> {
  const { opts } = ctx;
  const signal = ctx.signal ?? opts.signal;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: fs.promises.FileHandle | undefined;
  let meta: MetaJson | undefined;
  let loaded = 0;
  let complete = false;
  let discard = opts.resume === false;
  const abort = () => controller.abort();
  const checkAbort = () => {
    if (controller.signal.aborted)
      throw new DownloadError(
        timedOut ? 'TIMEOUT' : 'ABORTED',
        timedOut ? 'Download timed out' : 'Download aborted',
      );
  };
  const armTimer = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const network = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch {
      checkAbort();
      // Native errors may contain signed URLs. Never expose those to callers/logs.
      throw new DownloadError('NETWORK', 'Download network request failed');
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    checkAbort();
    assertDownloadUrl(opts.url, opts);
    if (opts.existingTarget === 'error' && fs.existsSync(opts.targetPath)) {
      throw new DownloadError('EXISTS', 'Download target already exists');
    }
    let offset =
      opts.resume === false
        ? null
        : decideResumeOffset(opts.targetPath, opts.url, opts.expectedSize, opts.sha256);
    if (
      offset !== null &&
      (offset >= (opts.expectedSize ?? Infinity) || offset > (opts.maxBytes ?? Infinity))
    )
      offset = null;
    if (offset === null) {
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
    }
    ctx.resumedFromBytes = offset ?? 0;
    loaded = offset ?? 0;
    await fs.promises.mkdir(path.dirname(opts.targetPath), { recursive: true });
    checkAbort();
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (offset !== null) {
      headers.Range = `bytes=${offset}-`;
      const prior = readMeta(opts.targetPath);
      if (prior?.etag) headers['If-Range'] = prior.etag;
      else if (prior?.lastModified) headers['If-Range'] = prior.lastModified;
    }
    let url = opts.url;
    for (let hops = 0; ; hops++) {
      assertDownloadUrl(url, opts);
      armTimer(opts.timeout?.connectMs ?? 10_000);
      response = await network(
        requestResponse(url, {
          method: 'GET',
          cache: 'no-store',
          redirect: opts.redirect === 'error' ? 'error' : 'manual',
          headers,
          signal: controller.signal,
        }),
      );
      clearTimeout(timer);
      checkAbort();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      response = undefined;
      if (opts.redirect === 'error' || !location || hops >= 5) {
        throw new DownloadError('URL_POLICY', 'Download redirect is not allowed');
      }
      try {
        url = new URL(location, url).href;
      } catch {
        throw new DownloadError('URL_POLICY', 'Invalid redirect URL');
      }
    }
    if (response.status >= 500)
      throw new DownloadError('HTTP_5XX', `HTTP ${response.status}`, undefined, response.status);
    if (response.status >= 400) {
      if (response.status === 416 && offset !== null) {
        discard = true;
        throw new DownloadError('NETWORK', 'Invalid resume range; restarting');
      }
      throw new DownloadError('HTTP_4XX', `HTTP ${response.status}`, undefined, response.status);
    }
    if (offset !== null && response.status === 200) {
      // Server ignored Range (or If-Range changed): use this full response fresh.
      offset = null;
      loaded = 0;
      ctx.resumedFromBytes = 0;
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
    }
    if (response.status !== (offset === null ? 200 : 206)) {
      discard = true;
      throw new DownloadError('NETWORK', 'Unexpected download response');
    }
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? null : Number(lengthHeader);
    if (length !== null && (!Number.isSafeInteger(length) || length < 0))
      throw new DownloadError('SIZE', 'Invalid Content-Length');
    let total = length === null ? null : length + (offset ?? 0);
    if (offset !== null) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) < offset ||
        Number(range[2]) + 1 !== Number(range[3]) ||
        !Number.isSafeInteger(Number(range[3])) ||
        (length !== null && length !== Number(range[2]) - offset + 1)
      ) {
        discard = true;
        throw new DownloadError('NETWORK', 'Invalid Content-Range; restarting');
      }
      total = Number(range[3]);
      opts.onResume?.({ fromBytes: offset, totalBytes: total });
    }
    if (
      (opts.expectedSize !== undefined && total !== null && total !== opts.expectedSize) ||
      (total !== null && total > (opts.maxBytes ?? Infinity))
    ) {
      throw new DownloadError('SIZE', 'Content-Length does not match the allowed size');
    }
    if (!response.body) throw new DownloadError('NETWORK', 'Download response body is empty');
    reader = response.body.getReader();
    const hasher = createStreamingHasher(
      offset === null ? null : partPath(opts.targetPath),
      controller.signal,
    );
    await hasher.update(Buffer.alloc(0));
    file = await fs.promises.open(partPath(opts.targetPath), offset === null ? 'w' : 'a', 0o600);
    const tracker = new ProgressTracker({
      initialLoaded: loaded,
      total: opts.expectedSize ?? total,
      onProgress: opts.onProgress,
    });
    meta = {
      url: opts.url,
      expectedSize: opts.expectedSize ?? total,
      expectedSha256: opts.sha256,
      downloadedBytes: loaded,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let lastMetaWriteAt = 0;
    armTimer(opts.timeout?.idleMs ?? 30_000);
    while (true) {
      checkAbort();
      const { done, value } = await network(reader.read());
      checkAbort();
      if (done) break;
      if (!value.byteLength) continue;
      if (
        loaded + value.byteLength >
        Math.min(opts.expectedSize ?? Infinity, opts.maxBytes ?? Infinity)
      ) {
        throw new DownloadError('SIZE', 'Download exceeds allowed size');
      }
      armTimer(opts.timeout?.idleMs ?? 30_000);
      await file.writeFile(value);
      await hasher.update(Buffer.from(value));
      loaded += value.byteLength;
      tracker.advance(value.byteLength);
      if (Date.now() - lastMetaWriteAt >= 2000) {
        try {
          writeMeta(opts.targetPath, {
            ...meta,
            downloadedBytes: loaded,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          /* A failed checkpoint only disables resume, not the active transfer. */
        }
        lastMetaWriteAt = Date.now();
      }
    }
    clearTimeout(timer);
    if (loaded !== (opts.expectedSize ?? total ?? loaded))
      throw new DownloadError('SIZE', 'Download size mismatch');
    const sha256 = await hasher.digest();
    if (sha256 !== opts.sha256) throw new DownloadError('CHECKSUM', 'Download SHA-256 mismatch');
    await file.close();
    file = undefined;
    checkAbort();
    if (opts.existingTarget === 'error') {
      // Atomic no-clobber publication, even if another process created the target meanwhile.
      await fs.promises.link(partPath(opts.targetPath), opts.targetPath);
      deletePart(opts.targetPath);
    } else {
      await fs.promises.rename(partPath(opts.targetPath), opts.targetPath);
    }
    complete = true;
    deleteMeta(opts.targetPath);
    tracker.flush();
    return { size: loaded, sha256 };
  } catch (error) {
    checkAbort();
    const failure =
      error instanceof DownloadError
        ? error
        : new DownloadError(
            (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'EXISTS' : 'DISK',
            'Download file operation failed',
          );
    if (['SIZE', 'CHECKSUM', 'URL_POLICY'].includes(failure.code)) discard = true;
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!complete) controller.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (!reader) await response?.body?.cancel().catch(() => undefined);
    await file?.close().catch(() => undefined);
    if (!complete) {
      if (discard) {
        deletePart(opts.targetPath);
        deleteMeta(opts.targetPath);
      } else if (meta) {
        try {
          writeMeta(opts.targetPath, {
            ...meta,
            downloadedBytes: loaded,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          /* A failed checkpoint only disables resume. */
        }
      }
    }
  }
}

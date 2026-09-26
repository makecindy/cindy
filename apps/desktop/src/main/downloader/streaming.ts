import { net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TransportContext, TransportResult } from './transport';
import { DownloadError } from './types';
import { computeHash, createStreamingHasher } from './integrity';
import {
  decideResumeOffset,
  deleteMeta,
  deletePart,
  partPath,
  readMeta,
  writeMeta,
} from './resume';
import { ProgressTracker } from './progress';

/** Pull one chunk only after the previous disk write and hash have completed. */
export async function executeStreaming(ctx: TransportContext): Promise<TransportResult> {
  const { opts } = ctx;
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: fs.FileHandle | undefined;
  try {
    try {
      const stat = await fs.stat(opts.targetPath);
      if (
        (opts.expectedSize === undefined || stat.size === opts.expectedSize) &&
        (await computeHash(opts.targetPath)) === opts.sha256
      ) {
        return { size: stat.size, sha256: opts.sha256 };
      }
    } catch {
      /* no verified cache */
    }
    await fs.rm(opts.targetPath, { force: true });
    await fs.mkdir(path.dirname(opts.targetPath), { recursive: true });
    const offset = decideResumeOffset(opts.targetPath, opts.url, opts.expectedSize, opts.sha256);
    if (offset === null) {
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
    }
    const previous = readMeta(opts.targetPath);
    let url = opts.url;
    let response: Response;
    for (let hop = 0; ; hop++) {
      if (controller.signal.aborted) throw new DownloadError('ABORTED', 'Download cancelled');
      try {
        opts.validateUrl?.(url);
      } catch {
        // A caller policy refusal cannot be repaired by retrying the same URL.
        throw new DownloadError('INVALID_ARG', 'Download URL is not allowed');
      }
      arm(opts.timeout?.connectMs ?? 10_000);
      response = await net.fetch(url, {
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers:
          offset === null
            ? {}
            : {
                Range: `bytes=${offset}-`,
                ...(previous?.etag || previous?.lastModified
                  ? { 'If-Range': previous.etag || previous.lastModified! }
                  : {}),
              },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || hop >= 9) throw new DownloadError('INVALID_ARG', 'Invalid redirect');
      try {
        url = new URL(location, url).href;
      } catch {
        throw new DownloadError('INVALID_ARG', 'Invalid redirect URL');
      }
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 416) {
        deletePart(opts.targetPath);
        deleteMeta(opts.targetPath);
      }
      throw new DownloadError(
        response.status >= 500 || response.status === 416 ? 'NETWORK' : 'HTTP_4XX',
        'Download HTTP failure',
      );
    }
    reader = response.body.getReader();
    const resumed = offset !== null && response.status === 206;
    if (
      response.status === 206 &&
      (!resumed || !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))
    ) {
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
      throw new DownloadError('CHECKSUM', 'Invalid resume response');
    }
    const initial = resumed ? offset : 0;
    const length = response.headers.get('content-length');
    if (
      length !== null &&
      opts.expectedSize !== undefined &&
      Number(length) + initial !== opts.expectedSize
    ) {
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
      throw new DownloadError('CHECKSUM', 'Content length mismatch');
    }
    const hasher = createStreamingHasher(resumed ? partPath(opts.targetPath) : null);
    file = await fs.open(partPath(opts.targetPath), resumed ? 'a' : 'w', 0o600);
    const tracker = new ProgressTracker({
      initialLoaded: initial,
      total: opts.expectedSize ?? null,
      onProgress: opts.onProgress,
    });
    ctx.resumedFromBytes = initial;
    if (resumed) opts.onResume?.({ fromBytes: initial, totalBytes: opts.expectedSize ?? null });
    const meta = {
      url: opts.url,
      expectedSize: opts.expectedSize ?? null,
      expectedSha256: opts.sha256,
      downloadedBytes: initial,
      etag:
        (response.headers.get('etag')?.length ?? 0) <= 1024 ? response.headers.get('etag') : null,
      lastModified:
        (response.headers.get('last-modified')?.length ?? 0) <= 256
          ? response.headers.get('last-modified')
          : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeMeta(opts.targetPath, meta);
    let lastMeta = Date.now();
    for (;;) {
      arm(opts.timeout?.idleMs ?? 30_000);
      const { done, value } = await reader.read();
      clearTimeout(timer);
      if (controller.signal.aborted) throw new DownloadError('ABORTED', 'Download cancelled');
      if (done) break;
      if (opts.maxBytes !== undefined && tracker.getLoaded() + value.length > opts.maxBytes) {
        throw new DownloadError('CHECKSUM', 'Download exceeds declared size');
      }
      await file.writeFile(value);
      await hasher.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      tracker.advance(value.length);
      meta.downloadedBytes = tracker.getLoaded();
      if (Date.now() - lastMeta > 2000) {
        writeMeta(opts.targetPath, meta);
        lastMeta = Date.now();
      }
    }
    opts.onVerifying?.();
    const sha256 = await hasher.digest();
    if (
      sha256 !== opts.sha256 ||
      (opts.expectedSize !== undefined && tracker.getLoaded() !== opts.expectedSize)
    ) {
      throw new DownloadError('CHECKSUM', 'Downloaded artifact mismatch');
    }
    await file.close();
    file = undefined;
    if (controller.signal.aborted) throw new DownloadError('ABORTED', 'Download cancelled');
    await fs.rename(partPath(opts.targetPath), opts.targetPath);
    deleteMeta(opts.targetPath);
    tracker.flush();
    return { size: tracker.getLoaded(), sha256 };
  } catch (error) {
    await file?.close().catch(() => {});
    file = undefined;
    if (error instanceof DownloadError && error.code === 'CHECKSUM') {
      deletePart(opts.targetPath);
      deleteMeta(opts.targetPath);
    }
    if (opts.signal?.aborted) throw new DownloadError('ABORTED', 'Download cancelled');
    if (timedOut) throw new DownloadError('NETWORK', 'Download timed out');
    if (error instanceof DownloadError) throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    const diskFailure = ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(
      (cause as NodeJS.ErrnoException).code ?? '',
    );
    throw new DownloadError(diskFailure ? 'DISK' : 'NETWORK', 'Download failed', cause);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await file?.close().catch(() => {});
  }
}

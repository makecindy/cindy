/**
 * unified-downloader — M2: HTTP transport + resumable download.
 * ---------------------------------------------------------------------------
 * This module owns one resumable HTTP attempt; retry policy lives in retry.ts.
 *
 * Single-attempt execution. The retry/backoff loop lives in retry.ts. This
 * file is responsible for ONE network round-trip:
 *   - Decide resume vs fresh based on .meta.json + .part.
 *   - Send GET (with Range + If-Range when resuming).
 *   - Stream chunks → write to .part, feed SHA256 hasher, advance progress.
 *   - On EOF: verify SHA256, rename .part → targetPath, delete .meta.json.
 *
 * Cleanup invariants on reject:
 *   - CHECKSUM   → delete .part + .meta.json (corrupt, retry would loop).
 *   - HTTP_4XX   → keep .part + .meta.json (caller may want to inspect).
 *   - NETWORK / HTTP_5XX → keep .part + .meta.json (resumable next time).
 *   - ABORTED    → keep .part + .meta.json (caller asked to pause).
 *   - DISK       → keep .part + .meta.json (caller decides; cleanup() exists).
 */

import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DownloadError, type DownloadOptions, type Logger, type TimeoutConfig } from './types';
import {
  partPath,
  readMeta,
  writeMeta,
  deletePart,
  deleteMeta,
  decideResumeOffset,
  type MetaJson,
} from './resume';
import { createStreamingHasher, computeHash } from './integrity';
import { ProgressTracker } from './progress';
import { executeStreaming } from './streaming';

const DEFAULT_TIMEOUT: TimeoutConfig = { connectMs: 10_000, idleMs: 30_000 };
const META_WRITE_INTERVAL_MS = 2000;

export interface TransportContext {
  opts: DownloadOptions;
  logger: Logger;
  signal?: AbortSignal;
  /** Bytes restored from `.part`. Set by executeOnce(); caller reads after success. */
  resumedFromBytes: number;
}

export interface TransportResult {
  size: number;
  sha256: string;
}

/**
 * Headers returned by Electron's net.request can be either a string or string[].
 * We normalize via this helper.
 */
function pickHeader(headers: Record<string, string | string[]>, key: string): string | null {
  const v = headers[key.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function parseContentLength(
  headers: Record<string, string | string[]>,
  status: number,
  resumeOffset: number | null,
): number | null {
  // 206 Partial Content: prefer Content-Range total, else Content-Length + offset.
  if (status === 206) {
    const range = pickHeader(headers, 'content-range');
    if (range !== null) {
      const m = /\/(\d+)$/.exec(range);
      if (m !== null) return Number(m[1]);
    }
    const cl = pickHeader(headers, 'content-length');
    if (cl !== null && resumeOffset !== null) return Number(cl) + resumeOffset;
  }
  const cl = pickHeader(headers, 'content-length');
  if (cl === null) return null;
  return Number(cl);
}

export async function executeOnce(ctx: TransportContext): Promise<TransportResult> {
  if (ctx.opts.streaming) return executeStreaming(ctx);
  const { opts, logger } = ctx;
  const timeout: TimeoutConfig = { ...DEFAULT_TIMEOUT, ...(opts.timeout ?? {}) };

  // ── Step 0: target file already exists & matches sha256 → fast path ──
  // (Scheduler also short-circuits this; the duplicate check here protects
  // against scheduler bypass paths and is cheap when the file is missing.)
  if (fs.existsSync(opts.targetPath)) {
    try {
      const existingHash = await computeHash(opts.targetPath);
      if (existingHash === opts.sha256) {
        return { size: fs.statSync(opts.targetPath).size, sha256: existingHash };
      }
      try { fs.unlinkSync(opts.targetPath); } catch { /* ignore */ }
    } catch {
      try { fs.unlinkSync(opts.targetPath); } catch { /* ignore */ }
    }
  }

  // ── Step 1: decide resume vs fresh ──
  const resumeOffset = decideResumeOffset(
    opts.targetPath,
    opts.url,
    opts.expectedSize,
    opts.sha256,
  );
  if (resumeOffset === null) {
    deletePart(opts.targetPath);
    deleteMeta(opts.targetPath);
  } else {
    ctx.resumedFromBytes = resumeOffset;
    opts.onResume?.({ fromBytes: resumeOffset, totalBytes: opts.expectedSize ?? null });
  }

  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });

  // ── Step 2: build headers ──
  const headers: Record<string, string> = {};
  if (resumeOffset !== null) {
    headers['Range'] = `bytes=${resumeOffset}-`;
    const meta = readMeta(opts.targetPath);
    if (meta?.etag) headers['If-Range'] = meta.etag;
    else if (meta?.lastModified) headers['If-Range'] = meta.lastModified;
  }

  // ── Step 3: HTTP request via Electron net (auto-respects system proxy) ──
  return await new Promise<TransportResult>((resolve, reject) => {
    opts.validateUrl?.(opts.url);
    const request = net.request({ url: opts.url, method: 'GET', redirect: opts.validateUrl ? 'manual' : 'follow', ...(opts.validateUrl ? { useSessionCookies: false, credentials: 'omit' as const } : {}) });
    Object.entries(headers).forEach(([k, v]) => request.setHeader(k, v));

    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanupTimers = (): void => {
      if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    };

    const safeReject = (err: DownloadError): void => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const safeResolve = (r: TransportResult): void => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };

    const onAbort = (): void => {
      try { request.abort(); } catch { /* ignore */ }
      // Keep .part + .meta — caller asked to pause.
      safeReject(new DownloadError('ABORTED', 'download aborted by caller'));
    };

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    connectTimer = setTimeout(() => {
      try { request.abort(); } catch { /* ignore */ }
      safeReject(new DownloadError('NETWORK', `connect timeout after ${timeout.connectMs}ms`));
    }, timeout.connectMs);

    const resetIdleTimer = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { request.abort(); } catch { /* ignore */ }
        safeReject(new DownloadError('NETWORK', `idle timeout after ${timeout.idleMs}ms`));
      }, timeout.idleMs);
    };

    let redirectCount = 0;
    if (opts.validateUrl) request.on('redirect', (_status, _method, redirectUrl) => {
      try {
        if (++redirectCount > 5) throw new Error('Too many redirects');
        opts.validateUrl!(redirectUrl);
        request.followRedirect();
      } catch {
        safeReject(new DownloadError('INVALID_ARG', 'Download redirect rejected'));
        request.abort();
      }
    });
    request.on('response', (response) => {
      if (settled) return;

      if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }

      const status = response.statusCode;
      const responseHeaders = response.headers as Record<string, string | string[]>;

      // 4xx → permanent failure for this URL (not retried).
      if (status >= 400 && status < 500) {
        try { request.abort(); } catch { /* ignore */ }
        safeReject(new DownloadError('HTTP_4XX', `HTTP ${status}`, undefined, status));
        return;
      }
      // 5xx → transient; retry layer decides.
      if (status >= 500) {
        try { request.abort(); } catch { /* ignore */ }
        safeReject(new DownloadError('HTTP_5XX', `HTTP ${status}`, undefined, status));
        return;
      }

      // We asked for Range but server returned full body → restart fresh next attempt.
      if (resumeOffset !== null && status === 200) {
        try { request.abort(); } catch { /* ignore */ }
        deletePart(opts.targetPath);
        deleteMeta(opts.targetPath);
        safeReject(new DownloadError('NETWORK', 'server does not support Range, restarting'));
        return;
      }

      const totalBytes = parseContentLength(responseHeaders, status, resumeOffset);
      const etag = pickHeader(responseHeaders, 'etag');
      const lastModified = pickHeader(responseHeaders, 'last-modified');

      // For fresh downloads, Content-Length must match expectedSize when both known.
      if (
        resumeOffset === null &&
        opts.expectedSize !== undefined &&
        totalBytes !== null &&
        totalBytes !== opts.expectedSize
      ) {
        try { request.abort(); } catch { /* ignore */ }
        deletePart(opts.targetPath);
        deleteMeta(opts.targetPath);
        safeReject(
          new DownloadError(
            'NETWORK',
            `Content-Length ${totalBytes} != expectedSize ${opts.expectedSize}`,
          ),
        );
        return;
      }

      // ── Open .part for append (resume) or truncate (fresh) ──
      const isResume = resumeOffset !== null && status === 206;
      const writeStream = fs.createWriteStream(partPath(opts.targetPath), {
        flags: isResume ? 'a' : 'w',
      });

      const tracker = new ProgressTracker({
        initialLoaded: isResume ? resumeOffset : 0,
        total: totalBytes,
        onProgress: opts.onProgress,
      });

      const hasher = createStreamingHasher(isResume ? partPath(opts.targetPath) : null);

      const meta: MetaJson = {
        url: opts.url,
        expectedSize: opts.expectedSize ?? totalBytes,
        expectedSha256: opts.sha256,
        downloadedBytes: tracker.getLoaded(),
        etag,
        lastModified,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      try {
        writeMeta(opts.targetPath, meta);
      } catch (err) {
        logger.warn?.('[downloader] writeMeta failed (non-fatal)', { err: (err as Error).message });
      }

      let lastMetaWriteAt = Date.now();

      writeStream.on('error', (err) => {
        try { request.abort(); } catch { /* ignore */ }
        safeReject(new DownloadError('DISK', `write stream failed: ${err.message}`, err));
      });

      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (opts.maxBytes !== undefined && tracker.getLoaded() + chunk.length > opts.maxBytes) {
          safeReject(new DownloadError('INVALID_ARG', 'Download exceeds declared size'));
          writeStream.destroy(); request.abort(); return;
        }
        resetIdleTimer();
        // 1. Persist to disk. Electron's IncomingMessage isn't a Node Readable
        //    stream (no pause/resume/destroy on it directly), so we can't apply
        //    Node-style backpressure here; we accept the buffer and let the
        //    fs.WriteStream queue it. For the tens-of-MB payloads we ship
        //    (app patch / claude bin), this stays well within the default
        //    highWaterMark budget.
        writeStream.write(chunk);
        // 2. Feed hasher (async because of priming, but we don't await here —
        //    the write order is preserved by hasher's internal `await primed`).
        void hasher.update(chunk).catch((err: Error) => {
          try { request.abort(); } catch { /* ignore */ }
          try { writeStream.destroy(); } catch { /* ignore */ }
          safeReject(new DownloadError('DISK', `hash update failed: ${err.message}`, err));
        });
        // 3. Advance progress.
        tracker.advance(chunk.length);
        // 4. Throttled meta update.
        const now = Date.now();
        if (now - lastMetaWriteAt > META_WRITE_INTERVAL_MS) {
          lastMetaWriteAt = now;
          try {
            writeMeta(opts.targetPath, {
              ...meta,
              downloadedBytes: tracker.getLoaded(),
              updatedAt: new Date().toISOString(),
            });
          } catch (err) {
            logger.debug?.('[downloader] writeMeta tick failed', { err: (err as Error).message });
          }
        }
      });

      response.on('end', () => {
        if (settled) { writeStream.destroy(); return; }
        try { opts.onVerifying?.(); } catch { /* observer only */ }
        // close the stream and finalize
        writeStream.end(() => {
          (async () => {
            try {
              const finalHash = await hasher.digest();
              const finalSize = tracker.getLoaded();

              if (settled || opts.signal?.aborted) return;
              if (opts.expectedSize !== undefined && finalSize !== opts.expectedSize) {
                deletePart(opts.targetPath);
                deleteMeta(opts.targetPath);
                safeReject(new DownloadError('CHECKSUM', 'Downloaded size mismatch'));
                return;
              }
              if (finalHash !== opts.sha256) {
                // Corrupt body — wipe both .part and .meta so a future attempt
                // starts truly fresh (CHECKSUM is not retried inside withRetry).
                deletePart(opts.targetPath);
                deleteMeta(opts.targetPath);
                safeReject(
                  new DownloadError(
                    'CHECKSUM',
                    `sha256 mismatch: got ${finalHash}, expected ${opts.sha256}`,
                  ),
                );
                return;
              }

              // Good. Move .part into place and drop the sidecar.
              try {
                if (fs.existsSync(opts.targetPath)) fs.unlinkSync(opts.targetPath);
                fs.renameSync(partPath(opts.targetPath), opts.targetPath);
              } catch (err) {
                safeReject(
                  new DownloadError(
                    'DISK',
                    `rename .part failed: ${(err as Error).message}`,
                    err as Error,
                  ),
                );
                return;
              }
              deleteMeta(opts.targetPath);
              tracker.flush();
              safeResolve({ size: finalSize, sha256: finalHash });
            } catch (err) {
              safeReject(
                new DownloadError(
                  'DISK',
                  `finalize failed: ${(err as Error).message}`,
                  err as Error,
                ),
              );
            }
          })();
        });
      });

      response.on('error', (err: Error) => {
        try { writeStream.destroy(); } catch { /* ignore */ }
        safeReject(new DownloadError('NETWORK', `stream error: ${err.message}`, err));
      });

      // Net response sometimes emits 'aborted' on socket reset rather than 'error'.
      // Cast: Electron typings don't list 'aborted' but it's a real event.
      (response as unknown as { on(ev: string, cb: () => void): void }).on('aborted', () => {
        try { writeStream.destroy(); } catch { /* ignore */ }
        if (settled) return;
        safeReject(new DownloadError('NETWORK', 'response aborted mid-stream'));
      });

      // Kick off the idle timer once the response stream begins.
      resetIdleTimer();
    });

    request.on('error', (err: Error) => {
      safeReject(new DownloadError('NETWORK', `request error: ${err.message}`, err));
    });

    // Guard: an abort that sneaks in before request.end() finished.
    request.on('abort' as 'error', () => {
      if (settled) return;
      safeReject(new DownloadError('ABORTED', 'request aborted'));
    });

    request.end();
  });
}

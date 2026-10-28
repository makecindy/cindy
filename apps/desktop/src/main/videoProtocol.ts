/**
 * videoProtocol.ts
 * ---------------------------------------------------------------------------
 * Registers the `xdt-video://` custom protocol used by the renderer to play
 * locally cached video files via standard `<video src>` elements.
 *
 * Two-step registration like imageProtocol:
 *   1. videoSchemePrivilege — collected by protocolPrivileges.ts into the
 *      single registerSchemesAsPrivileged() call (before app.whenReady()).
 *   2. registerVideoProtocolHandler() — must run AFTER app.whenReady().
 *
 * Range request handling: chromium <video> issues `Range: bytes=0-` on first
 * fetch and may seek with subsequent ranges. Earlier impl used `stream:true`
 * privilege + a node Readable but didn't actually parse the Range header —
 * advertising `Accept-Ranges: bytes` while only serving 200 full responses
 * caused chromium to flag the resource broken and fire `<video>.onerror`.
 * We now parse the Range header and reply 206 with the requested slice
 * (or 416 if out of range). For requests without a Range header we still
 * reply 200 + full body. Files are typically 1-30MB so reading the whole
 * file once per request is acceptable; if videos grow into hundreds of MB
 * we can switch the slice path to a node stream.
 */

import { protocol } from 'electron';
import { videoSchemePrivilege } from './protocolPrivileges.js';
import * as videoCacheStore from './videoCacheStore';

import { createLogger } from './logger';

const log = createLogger('videoProtocol');

const SCHEME = videoSchemePrivilege.scheme;

/** Privilege entry for the one-shot registerSchemesAsPrivileged at the index.ts entry. */
export { videoSchemePrivilege };

/** Parse `Range: bytes=START-END` (single range only). Returns null when the
 *  header is absent or malformed — caller falls back to a full 200 response.
 *  Exported for tests; the protocol handler is the only runtime caller. */
export function parseRangeHeader(
  headerValue: string | null,
  totalSize: number,
): { start: number; end: number } | null {
  if (!headerValue) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr !== '') {
    // Suffix range: last N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (startStr !== '') {
    start = parseInt(startStr, 10);
    end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  } else {
    return null;
  }
  if (start < 0 || end >= totalSize || start > end) return null;
  return { start, end };
}

export function registerVideoProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const { buffer, mimeType } = await videoCacheStore.readFile(request.url);
      const totalSize = buffer.byteLength;
      const range = parseRangeHeader(request.headers.get('range'), totalSize);

      if (range) {
        const slice = buffer.slice(range.start, range.end + 1);
        const body = slice.buffer.slice(
          slice.byteOffset,
          slice.byteOffset + slice.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(slice.byteLength),
            'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      }

      const body = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = (err as Error)?.message ?? '';
      if (
        msg.includes('path out of bounds') ||
        msg.includes('invalid url') ||
        msg.includes('malformed url') ||
        msg.includes('unknown host')
      ) {
        return new Response(null, { status: 403 });
      }
      if (code === 'ENOENT') {
        return new Response(null, { status: 404 });
      }
      log.error('[xdt-video] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}

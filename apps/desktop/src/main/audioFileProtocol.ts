/**
 * audioFileProtocol.ts
 * ---------------------------------------------------------------------------
 * Registers the `xdt-audio://` custom protocol used by the renderer to play
 * arbitrary local audio files via standard `<audio src>` requests.
 *
 * Why a custom protocol (not file://):
 *   Same as localFileProtocol — the renderer is loaded from http(s)/file://
 *   and chromium blocks cross-scheme `<audio src="file://...">` loads.
 *
 * Why a separate scheme from xdt-file://:
 *   xdt-file:// is image-only by whitelist; mixing audio in would muddy the
 *   "what does this URL render as" mental model and complicate debugging.
 *
 * URL shape: `xdt-audio://local/?path=<percent-encoded-absolute-path>`
 *   - host fixed to `local` so url.host parsing is stable across platforms
 *   - path lives in the query string to dodge Windows-vs-POSIX pathname
 *     normalization weirdness across protocol url parsers
 *
 * Range request handling: chromium <audio> issues `Range: bytes=0-` on first
 * fetch and seeks with subsequent ranges. parseRangeHeader returns a tagged
 * union so the handler can dispatch 206 / 416 / 200 distinctly:
 *   - { kind: 'range', start, end } → 206 with the requested slice
 *   - { kind: 'unsatisfiable' }     → 416 (start >= totalSize, etc.)
 *   - null                          → 200 full body (header absent or malformed)
 *
 * Safety model (mirrors localFileProtocol — no base dir, no escape concept):
 *   1. URL.host MUST be 'local' (else 403)
 *   2. path MUST be absolute (POSIX `/` or Windows drive letter; else 403)
 *   3. extension MUST be in AUDIO_EXT_WHITELIST, case-insensitive (else 415)
 *   4. realpath'd target must NOT fall inside a sensitive directory
 *      (getSensitiveMediaBlocklist, shared with xdt-file / device-link media
 *      fetch; else 403) — realpath runs BEFORE the check so a whitelisted-ext
 *      symlink escaping into a credential/browser-profile dir is caught, and
 *      stat/readFile use the realpath (closes the check→open TOCTOU window)
 *   5. file MUST exist as a regular file (dir / ELOOP / ENOENT → 404)
 *
 * Intentionally diverges from localFileProtocol's `normalize === resolve`
 * anti-`..` check: on absolute paths `..` collapses harmlessly, and the
 * extension whitelist + isFile() check already cover the attack surface.
 *
 * Two-step registration mirrors imageProtocol / localFileProtocol:
 *   1. audioFileSchemePrivilege — collected by bootstrap-electron.ts into the
 *      single registerSchemesAsPrivileged() call (before app.whenReady())
 *   2. registerAudioFileProtocolHandler() — after app.whenReady()
 */

import { protocol, type CustomScheme } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from './filePathPolicy';
import { createLogger } from './logger';

const log = createLogger('audioFileProtocol');

const SCHEME = 'xdt-audio';

const AUDIO_EXT_WHITELIST = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.aac',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/** Privilege entry for the one-shot registerSchemesAsPrivileged in bootstrap. */
export const audioFileSchemePrivilege: CustomScheme = {
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: false,
    corsEnabled: false,
  },
};

export type RangeParseResult =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | null;

/** Parse `Range: bytes=START-END` (single range only). Tagged union so the
 *  handler can split 206 / 416 / 200 cleanly:
 *    - null              → header absent or malformed → caller serves 200
 *    - {kind:'range'}    → caller serves 206 with the slice
 *    - {kind:'unsatisfiable'} → caller serves 416
 *  Exported for tests; the protocol handler is the only runtime caller. */
export function parseRangeHeader(
  headerValue: string | null,
  totalSize: number,
): RangeParseResult {
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
    if (totalSize === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (startStr !== '') {
    start = parseInt(startStr, 10);
    const requestedEnd = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
    // A satisfiable byte-range remains valid when its requested end extends
    // past the representation; serve through the final available byte.
    end = Math.min(requestedEnd, totalSize - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  } else {
    return null;
  }
  if (start > end || start >= totalSize) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}

export function registerAudioFileProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'local') return new Response(null, { status: 403 });

      // URLSearchParams.get already percent-decodes the value; calling
      // decodeURIComponent again would corrupt filenames containing a literal
      // `%` (e.g. `100% done.mp3` → URIError → 500).
      const decodedPath = url.searchParams.get('path');
      if (!decodedPath) return new Response(null, { status: 400 });

      const isAbsolute =
        decodedPath.startsWith('/') || WIN_ABS_RE.test(decodedPath);
      if (!isAbsolute) return new Response(null, { status: 403 });

      const resolved = path.resolve(decodedPath);
      const ext = path.extname(resolved).toLowerCase();
      if (!AUDIO_EXT_WHITELIST.has(ext)) {
        return new Response(null, { status: 415 });
      }

      // Sensitive-directory confinement, same boundary as xdt-file /
      // device-link media fetch. Literal (lexical) blocklist FIRST — before
      // realpath — so a sensitive requested path is denied deterministically
      // even if realpath then fails with EACCES/EPERM.
      if (!isPathAllowedAgainst(resolved, getSensitiveMediaBlocklist())) {
        log.warn(`[xdt-audio] blocked sensitive path: ${resolved}`);
        return new Response(null, { status: 403 });
      }
      // Then realpath and re-check: catches a symlink escape whose lexical
      // form looked innocent; serve from the realpath (closes the check→open
      // TOCTOU window). Inner catch mirrors localFileProtocol so a
      // missing/broken target (ENOENT/ENOTDIR) → 404 and a permission failure
      // (EACCES/EPERM) → 403, instead of leaking a 500 via the outer catch.
      let realPath: string;
      try {
        realPath = await fs.realpath(resolved);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return new Response(null, { status: 404 });
        if (code === 'EACCES' || code === 'EPERM') return new Response(null, { status: 403 });
        throw err;
      }
      if (!isPathAllowedAgainst(realPath, getSensitiveMediaBlocklist())) {
        log.warn(`[xdt-audio] blocked sensitive realpath: ${resolved}`);
        return new Response(null, { status: 403 });
      }

      const stat = await fs.stat(realPath);
      if (!stat.isFile()) return new Response(null, { status: 404 });

      const buffer = await fs.readFile(realPath);
      const totalSize = buffer.byteLength;
      const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      const range = parseRangeHeader(
        request.headers.get('range'),
        totalSize,
      );

      if (range && range.kind === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes */${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      }

      if (range && range.kind === 'range') {
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
      if (code === 'ENOENT' || code === 'ELOOP') {
        return new Response(null, { status: 404 });
      }
      // Windows surfaces permission denial as EPERM more often than EACCES.
      if (code === 'EACCES' || code === 'EPERM') {
        return new Response(null, { status: 403 });
      }
      log.error('[xdt-audio] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}

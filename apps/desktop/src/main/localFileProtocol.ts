/**
 * localFileProtocol.ts
 * ---------------------------------------------------------------------------
 * Registers the `xdt-file://` custom protocol used by the renderer to display
 * arbitrary local media files via standard `<img src>` / `<video src>` /
 * fetch requests.
 *
 * Why a custom protocol (not file://):
 *   The renderer is loaded from http(s) (Vite dev) or app file:// (prod).
 *   Chromium blocks cross-scheme `<img src="file://...">` loads when
 *   webSecurity is on (default), so a plain file:// URL silently fails.
 *   A privileged custom scheme bypasses that wall while keeping the
 *   sandboxing we control.
 *
 * URL shape: `xdt-file://local/?path=<percent-encoded-absolute-path>`
 *   - host fixed to `local` so url.host parsing is stable across platforms
 *   - path lives in the query string to dodge Windows-vs-POSIX pathname
 *     normalization weirdness across protocol url parsers
 *
 * Safety rules (all enforced on every request):
 *   1. path must be absolute (Win drive letter OR leading `/`)
 *   2. extension must be in MEDIA_EXT_WHITELIST
 *   3. resolved path must equal the input after path.resolve (no `..` escape)
 *   4. realpath'd target must NOT fall inside a sensitive directory
 *      (credentials / OS internals / browser profiles — see filePathPolicy.ts).
 *      realpath runs BEFORE the check so a symlink escaping into ~/.ssh etc.
 *      is caught, and stat/stream both use the realpath (closes the
 *      check→open TOCTOU window).
 *   5. file must exist and be a regular file (no dirs, no symlink loops)
 *
 * This is directory *confinement*, not a positive allow-list: legitimate
 * `xdt-file://` paths span the whole filesystem (theme logos, agent-cited /
 * `Read` files on any volume, user-pasted paths, attachments served from their
 * original ~/Downloads location, local-session output from any-drive working
 * dirs), so we shrink the read surface by excluding never-legitimate dirs
 * rather than enumerating an (unbounded) allow-set. See filePathPolicy.ts.
 *
 * Body 一律流式(createReadStream → web stream),不整文件进内存——大文件
 * 缓存副本(2GB 视频 / 大 PDF)也能安全供片。支持 HTTP Range(单段
 * bytes=start-end / bytes=start- / bytes=-suffix → 206),<video> 拖进度条
 * 依赖它;非法 Range 回 416。
 *
 * Two-step registration mirrors imageProtocol.ts:
 *   1. localFileSchemePrivilege — collected by protocolPrivileges.ts into the
 *      single registerSchemesAsPrivileged() call (before app.whenReady())
 *   2. registerLocalFileProtocolHandler() — after app.whenReady()
 */

import { protocol } from 'electron';
import { localFileSchemePrivilege } from './protocolPrivileges.js';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from './filePathPolicy';
import { createLogger } from './logger';

const log = createLogger('localFileProtocol');

const SCHEME = localFileSchemePrivilege.scheme;

// Sensitive-directory confinement (credentials / OS internals / browser
// profiles): the lazily-cached blocklist singleton lives in filePathPolicy so
// device-link media fetch enforces the identical boundary. See
// filePathPolicy.ts for why this is a deny-list, not an allow-list.

// 白名单覆盖图片、in-app preview 用的文档类型 (PDF / drawio)、3D 模型
// (GLB / glTF — ModelLightbox 的 model-viewer 走 fetch 拉字节;FBX 故意不在
// 名单里:应用内不预览 FBX,chip 点击是 Finder 定位) 和 Chromium 可原生
// 播放的视频容器 (对应 FileBodyView 的 isVideo 判定)。都是 sandboxed
// renderer 内显示 / 播放, 不在这里开放可执行 / 任意二进制扩展。
const MEDIA_EXT_WHITELIST = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.pdf',
  '.drawio',
  '.glb',
  '.gltf',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  // drawio 文件其实是 XML 文本, application/xml 让 drawio viewer 的 fetch
  // 拿到的 Content-Type 正确, 不影响实际解析。
  '.drawio': 'application/xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // mov 容器 Chromium 只在 H.264/AAC 轨道时可播;编码不支持时 <video> 自身
  // 报错, UI 层有占位卡兜底。
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/**
 * 解析单段 Range 头(bytes=start-end / bytes=start- / bytes=-suffix)。
 * 三态语义与 audioFileProtocol 对齐:
 *   - null            = 头缺失 / 格式非法 → 调用方按无 Range 回 200 全量(RFC:
 *                       malformed Range SHOULD be ignored);
 *   - 'unsatisfiable' = start 越界 / 区间倒置 → 416;
 *   - 'range'         = 有效区间。end 超过文件尾按 RFC 7233 收窄到 size-1
 *                       (不判非法)。多段 Range(bytes=0-1,5-9)不支持,按
 *                       malformed 处理(实践中 <video> 只发单段)。
 * Exported for tests; the protocol handler is the only runtime caller.
 */
export function parseRangeHeader(
  headerValue: string | null,
  size: number,
): { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' } | null {
  if (!headerValue) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    // suffix range: 最后 N 字节
    const n = parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

/** createReadStream → fetch Response 可用的 web ReadableStream。 */
function streamBody(filePath: string, opts?: { start: number; end: number }): ReadableStream {
  return Readable.toWeb(createReadStream(filePath, opts)) as unknown as ReadableStream;
}

/** Privilege entry for the one-shot registerSchemesAsPrivileged at the index.ts entry. */
export { localFileSchemePrivilege };

export function registerLocalFileProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // URLSearchParams.get() already percent-decodes once. Do NOT call
      // decodeURIComponent again here — it throws URIError on filenames
      // containing a literal `%` (e.g. "100% done.png") → 500.
      const decoded = url.searchParams.get('path');
      if (!decoded) return new Response(null, { status: 400 });

      const isAbsolute =
        decoded.startsWith('/') || WIN_ABS_RE.test(decoded);
      if (!isAbsolute) return new Response(null, { status: 403 });

      const resolved = path.resolve(decoded);
      // Ensure path.resolve didn't expand a `..` we missed.
      const normalizedInput = path.normalize(decoded);
      if (resolved !== normalizedInput) {
        // path.normalize keeps separator style; path.resolve doesn't always.
        // Compare with case-insensitive on win32 to avoid false rejections.
        const eq =
          process.platform === 'win32'
            ? resolved.toLowerCase() === normalizedInput.toLowerCase()
            : resolved === normalizedInput;
        if (!eq) return new Response(null, { status: 403 });
      }

      const ext = path.extname(resolved).toLowerCase();
      if (!MEDIA_EXT_WHITELIST.has(ext)) {
        return new Response(null, { status: 415 });
      }

      // Literal (lexical) blocklist FIRST — before realpath — so a sensitive
      // requested path is denied deterministically even when realpath fails
      // with EACCES/EPERM (a permission error must not leak a 500 for a path
      // we already know to reject).
      if (!isPathAllowedAgainst(resolved, getSensitiveMediaBlocklist())) {
        return new Response(null, { status: 403 });
      }

      // Resolve symlinks before serving so a symlink that escapes into a
      // sensitive dir is caught by its real target, and read the real path so
      // a swap between check and open can't smuggle a different file.
      let realPath: string;
      try {
        realPath = await fs.realpath(resolved);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // Missing target / broken symlink / symlink loop → 404 (ELOOP included
        // so a self-referential symlink is a clean 404, not a 500 via the
        // outer catch — parity with xdt-audio).
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
          return new Response(null, { status: 404 });
        }
        // Permission denied (EACCES on POSIX, EPERM common on Windows) → 403,
        // consistent with xdt-audio and the outer catch.
        if (code === 'EACCES' || code === 'EPERM') return new Response(null, { status: 403 });
        throw err;
      }
      // Also deny when the realpath hits the blocklist: catches a symlink
      // escape whose lexical form looked innocent.
      if (!isPathAllowedAgainst(realPath, getSensitiveMediaBlocklist())) {
        return new Response(null, { status: 403 });
      }

      const stat = await fs.stat(realPath);
      if (!stat.isFile()) return new Response(null, { status: 404 });

      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      const range = parseRangeHeader(request.headers.get('Range'), stat.size);

      if (range?.kind === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes */${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      }
      if (range) {
        return new Response(streamBody(realPath, { start: range.start, end: range.end }), {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(range.end - range.start + 1),
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      }

      return new Response(stat.size === 0 ? null : streamBody(realPath), {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return new Response(null, { status: 404 });
      if (code === 'EACCES') return new Response(null, { status: 403 });
      log.error('[xdt-file] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}

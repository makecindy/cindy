/**
 * Sandboxed local HTML preview server (host layer).
 *
 * Serves workspace-local HTML entries over a token-scoped loopback origin so
 * the managed browser can screenshot/verify agent-generated pages WITHOUT
 * opening `file://` or any general localhost navigation:
 *
 *  - one process-level HTTP listener on `127.0.0.1:<random ephemeral port>`;
 *  - each preview gets an unguessable 256-bit capability token bound to the
 *    entry's canonical directory (the serving root), with a TTL so tokens do
 *    not live forever; `sessionId` is recorded for diagnostics only and does
 *    NOT gate requests (per-session revocation is not implemented);
 *  - every request re-validates the path inside that root (lexical + realpath
 *    nearest-existing-ancestor, same semantics as
 *    `packages/lizi-mcps/src/shared/assertInsidePath.ts`), rejects dotfiles,
 *    `..`/backslash/encoded traversal and non-whitelisted extensions;
 *  - GET/HEAD only; `nosniff` + `no-store` + a page-level CSP
 *    (connect-src 'none' + sandbox; no remote subresources) on EVERY
 *    response, error/refusal paths included;
 *  - on listener error/close the origin grant is revoked immediately so a
 *    freed port can never be taken over while the SSRF policy still trusts it.
 *
 * The runtime's SSRF policy only ever sees the one exact origin this server
 * actually listens on (the host calls `applyPreviewOrigins` after a successful
 * bind, and clears it on any error/close). Other loopback hosts/ports and
 * `file://` stay blocked.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import nodePath from 'node:path';

/** Minimal logger surface (matches the unified logger's info/warn/error). */
interface PreviewLogger {
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface LocalPreviewServerDeps {
  logger?: PreviewLogger;
  /** Host hook: (re)install the exact origins the SSRF policy may trust. */
  applyPreviewOrigins(origins: string[]): void;
  /** Capability-token lifetime in ms. Default: 24h. */
  tokenTtlMs?: number;
}

export interface CreatePreviewInput {
  workingDir: string;
  localPath: string;
  sessionId?: string;
}

/**
 * Fail-closed preview error. `message` carries the machine-readable code as a
 * prefix so the L2 MCP boundary can map it to a stable BROWSER_RUNTIME_* error
 * code without parsing exception classes across the package boundary.
 */
export class LocalPreviewError extends Error {
  constructor(
    public readonly code: 'PATH_NOT_ALLOWED' | 'UNSUPPORTED_FILE' | 'NOT_FOUND' | 'UNAVAILABLE',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LocalPreviewError';
  }
}

/** Entry files a preview may open. */
const ENTRY_EXTENSIONS = new Set(['.html', '.htm']);

/** Rendered-page resource whitelist. Anything else is refused — fail-closed. */
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.webmanifest',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/**
 * Page-level hardening for previewed pages: NO remote subresources at all
 * (no https: in any directive), same-origin + inline + data: only. Without
 * this, a preview page could load a third-party script which reads
 * same-origin files and then exfiltrates them — closing remote loads
 * removes that injection surface. Pages that legitimately need CDN assets
 * must vendor them locally first (documented in browser-workflow.md).
 *
 * Exfiltration containment (verified against real Chrome, 2026-08-06):
 *  - `connect-src 'none'`: the page can never fetch/XHR/WS ANYTHING, not
 *    even same-origin files — so a script has no channel to read file
 *    contents it could carry away. (The preview page is a static render
 *    verification target; it does not legitimately need fetch.)
 *  - `sandbox allow-scripts allow-same-origin`: blocks window.open /
 *    popups and sandboxed top-level navigation where Chromium enforces it.
 *    NOTE: `navigate-to` is NOT used — Chromium/Electron do not implement
 *    that directive and silently ignore it (probed: location.href to an
 *    external origin still navigates). With fetch closed and every
 *    subresource directive same-origin-only, a successful self-navigation
 *    carries nothing but the page's own rendered DOM.
 */
const CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "media-src 'self' data:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "sandbox allow-scripts allow-same-origin";

/**
 * Headers applied to EVERY response (200 and all error/refusal paths). A
 * refusal must not be served without CSP/no-store: a page without CSP on
 * this origin would give a script an unprotected execution context to
 * probe the tokenized URLs from (Copilot review, round 4).
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': CSP,
};

// ── path boundary (same semantics as lizi-mcps shared/assertInsidePath) ─────

function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = nodePath.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

async function realpathNearestExisting(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) {
        throw new LocalPreviewError('PATH_NOT_ALLOWED', `无法解析路径的任何父目录: ${p}`);
      }
      current = parent;
    }
  }
}

/** Lexical + symlink/junction-safe containment assert (fail-closed). */
async function assertInsideRoot(root: string, target: string): Promise<void> {
  if (!isInside(root, target)) {
    throw new LocalPreviewError('PATH_NOT_ALLOWED', `路径越界: 解析后不在工作区内 (${root})`);
  }
  const rootReal = await fs.realpath(root).catch(() => {
    throw new LocalPreviewError('PATH_NOT_ALLOWED', `工作区根不存在或不可访问: ${root}`);
  });
  const ancestorReal = await realpathNearestExisting(target);
  if (!isInside(rootReal, ancestorReal)) {
    throw new LocalPreviewError('PATH_NOT_ALLOWED', '路径经 symlink/junction 越界: 指向工作区之外');
  }
}

interface PreviewEntry {
  /** Canonical serving root = dirname(entry file). */
  root: string;
  sessionId?: string;
  createdAt: number;
}

/** Cap on concurrently issued previews (per-process). Oldest is evicted. */
const MAX_PREVIEWS = 1024;

/** Default capability-token lifetime. */
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createLocalPreviewServer(deps: LocalPreviewServerDeps) {
  const { logger, applyPreviewOrigins } = deps;
  const tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  let server: Server | null = null;
  let origin: string | null = null;
  let starting: Promise<string> | null = null;
  let failed = false;
  const tokens = new Map<string, PreviewEntry>();

  /** Drop the SSRF grant for this server's origin (idempotent). */
  function revokeOrigin(): void {
    if (origin) {
      logger?.info?.(`[local-preview] revoking preview origin ${origin}`);
      applyPreviewOrigins([]);
      origin = null;
    }
  }

  async function ensureStarted(): Promise<string> {
    if (origin) return origin;
    if (failed) throw new LocalPreviewError('UNAVAILABLE', '预览服务已不可用');
    if (starting) return starting;
    starting = (async () => {
      // Wrap the async handler: an unhandled rejection would leave the request
      // hanging (no response), so any internal error degrades to a 500.
      const srv = createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          logger?.error?.(`[local-preview] request error: ${String(err)}`);
          try {
            res.writeHead(500, SECURITY_HEADERS);
            res.end();
          } catch {
            res.destroy();
          }
        });
      });
      srv.on('error', (err) => {
        logger?.error?.(`[local-preview] listener error: ${String(err)}`);
        failed = true;
        revokeOrigin();
      });
      srv.on('close', () => {
        // Covers normal dispose AND listener crash — never leave the SSRF
        // policy trusting a port nobody is serving (a local process could
        // otherwise bind the freed port and intercept the token URL).
        revokeOrigin();
      });
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          resolve();
        });
      });
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        failed = true;
        throw new LocalPreviewError('UNAVAILABLE', '无法确定预览监听地址');
      }
      server = srv;
      origin = `http://127.0.0.1:${addr.port}`;
      logger?.info?.(`[local-preview] listening at ${origin}`);
      // Grant the SSRF exception ONLY after a successful bind.
      applyPreviewOrigins([origin]);
      return origin;
    })();
    try {
      return await starting;
    } catch (err) {
      starting = null;
      throw err;
    }
  }

  /**
   * Resolve + verify a served path inside `root`. Returns null for every
   * refusal (traversal, NUL, backslash variants, hidden segments, symlink
   * escape, missing).
   */
  async function resolveServedPath(root: string, relPath: string): Promise<string | null> {
    if (relPath.includes('\0')) return null;
    const segments = relPath.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0) return null; // no directory index
    if (segments.some((s) => s === '..')) return null;
    // Reject hidden segments (e.g. `.git/`, `.config/`, `.github/`) — not just
    // dotfiles — so a previewed page can never read hidden-directory content
    // that happens to match the extension whitelist.
    if (segments.some((s) => s.startsWith('.'))) return null;
    const target = nodePath.resolve(root, ...segments);
    try {
      await assertInsideRoot(root, target);
      // Open the REAL path: any symlink/junction along the way has been
      // resolved, so a concurrent directory swap between this check and the
      // open below cannot redirect the read outside the root.
      const real = await fs.realpath(target);
      await assertInsideRoot(root, real);
      return real;
    } catch (err) {
      if (err instanceof LocalPreviewError && err.code === 'PATH_NOT_ALLOWED') return null;
      // Missing file: not an anomaly, just a 404.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', origin ?? 'http://127.0.0.1');
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    const match = /^\/preview\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
    if (!match) return refuse(res);
    const token = match[1];
    const entry = tokens.get(token);
    if (!entry) return refuse(res);
    // TTL: expired tokens are revoked and rejected.
    if (Date.now() - entry.createdAt > tokenTtlMs) {
      tokens.delete(token);
      return refuse(res);
    }
    // Root identity pinning: the serving root's canonical path must not have
    // changed since the token was issued. A rename-and-swap of the entry dir
    // (replaced by a symlink/junction pointing outside the workspace) would
    // otherwise make both realpaths here resolve to the new target while
    // staying mutually "inside" (codex-connector P1, round 4).
    const currentRoot = await fs.realpath(entry.root).catch(() => null);
    if (!currentRoot || currentRoot !== entry.root) return refuse(res);

    let relPath: string;
    try {
      relPath = decodeURIComponent(match[2]);
    } catch {
      return refuse(res, 400);
    }
    // Windows: URL paths use '/', but the filesystem also treats '\' as a
    // separator — normalize first so %5c-style escapes cannot bypass the
    // boundary check.
    relPath = relPath.replace(/\\/g, '/');

    const abs = await resolveServedPath(entry.root, relPath);
    if (!abs) return refuse(res);
    const ext = nodePath.extname(abs).toLowerCase();
    const baseName = nodePath.basename(abs);
    if (baseName.startsWith('.') || !ALLOWED_EXTENSIONS.has(ext)) return refuse(res);

    // Snapshot the vetted object BEFORE opening (size + nanosecond
    // timestamps). The opened handle must describe the SAME object when
    // re-checked after open: a swap-and-restore of the path (replace `abs`
    // with an outside symlink for fs.open, then restore it before the
    // realpath recheck) would defeat a pathname-only recheck while the fd
    // still references the outside file (codex-connector P1, round 6).
    const preStat = await fs.stat(abs, { bigint: true }).catch(() => null);
    if (!preStat?.isFile()) return refuse(res);
    // Open by file descriptor: closes the TOCTOU window between containment
    // checks and the actual read. Immediately after opening, re-verify the
    // path still resolves to the vetted real path AND the handle's identity
    // fields match the pre-open snapshot.
    const fd = await fs.open(abs, 'r').catch(() => null);
    if (!fd) return refuse(res);
    const recheck = await fs.realpath(abs).catch(() => null);
    if (!recheck || recheck !== abs) {
      await fd.close().catch(() => {});
      return refuse(res);
    }
    let stat;
    try {
      stat = await fd.stat({ bigint: true });
    } catch {
      await fd.close().catch(() => {});
      return refuse(res);
    }
    if (
      !stat.isFile() ||
      stat.size !== preStat.size ||
      stat.mtimeNs !== preStat.mtimeNs ||
      stat.birthtimeNs !== preStat.birthtimeNs
    ) {
      await fd.close().catch(() => {});
      return refuse(res);
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': Number(stat.size),
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') {
      await fd.close().catch(() => {});
      res.end();
      return;
    }
    // Path is ignored at runtime when `fd` is set; passing it keeps the TS
    // signature happy.
    const stream = createReadStream(abs, { fd, autoClose: true });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function refuse(res: ServerResponse, status = 404): void {
    res.writeHead(status, SECURITY_HEADERS);
    res.end();
  }

  async function resolveEntryPath(input: CreatePreviewInput): Promise<string> {
    const workingDir = input.workingDir;
    if (typeof workingDir !== 'string' || workingDir.trim().length === 0) {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', '当前会话无 workingDir,拒绝本地预览');
    }
    const rootAbs = nodePath.resolve(workingDir);
    const targetAbs = nodePath.isAbsolute(input.localPath)
      ? nodePath.resolve(input.localPath)
      : nodePath.resolve(rootAbs, input.localPath);
    await assertInsideRoot(rootAbs, targetAbs);
    const ext = nodePath.extname(targetAbs).toLowerCase();
    if (!ENTRY_EXTENSIONS.has(ext)) {
      throw new LocalPreviewError(
        'UNSUPPORTED_FILE',
        `入口不是 HTML 文件(仅支持 .html/.htm, 收到 "${ext || '(无扩展名)'}")`,
      );
    }
    const stat = await fs.stat(targetAbs).catch(() => null);
    if (!stat?.isFile()) {
      throw new LocalPreviewError('NOT_FOUND', '入口文件不存在或不是普通文件');
    }
    // Resolve the working dir + entry to their REAL paths and re-assert the
    // boundary against those identities: a concurrent rename-and-swap of the
    // entry directory (into a symlink/junction pointing outside the
    // workspace) between the checks above and token issuance must not become
    // the serving root (codex-connector P1, round 5).
    const workingDirReal = await fs.realpath(rootAbs).catch(() => {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', `工作区不可解析: ${rootAbs}`);
    });
    const entryReal = await fs.realpath(targetAbs).catch(() => {
      throw new LocalPreviewError('NOT_FOUND', '入口文件不可解析');
    });
    await assertInsideRoot(workingDirReal, entryReal);
    return entryReal;
  }

  async function createPreviewUrl(input: CreatePreviewInput): Promise<{ url: string }> {
    // Validate the entry FIRST: an invalid request (out-of-workspace, missing,
    // non-HTML) must never start the listener or grant an origin
    // (Copilot review, round 4).
    const entryAbs = await resolveEntryPath(input);
    const base = await ensureStarted();
    // Serving root = the entry's directory: relative resources work, but the
    // page can never reach sibling workspace content outside that directory.
    // `entryAbs` is already the REAL path (resolved + re-asserted above);
    // re-verify the root's physical identity right before pinning it into
    // the token, so a directory swap between validation and issuance cannot
    // pin an external directory as the serving root (codex-connector P1,
    // round 5).
    const root = nodePath.dirname(entryAbs);
    const rootNow = await fs.realpath(root).catch(() => null);
    if (!rootNow || rootNow !== root) {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', '入口目录身份在发放前发生变化');
    }
    const token = crypto.randomBytes(32).toString('hex'); // 256-bit, unguessable
    if (tokens.size >= MAX_PREVIEWS) {
      const oldest = tokens.keys().next().value;
      if (oldest) tokens.delete(oldest);
    }
    tokens.set(token, { root, sessionId: input.sessionId, createdAt: Date.now() });
    return {
      url: `${base}/preview/${token}/${encodeURIComponent(nodePath.basename(entryAbs))}`,
    };
  }

  function dispose(): void {
    tokens.clear();
    // Revoke synchronously — never rely on the async 'close' event for the
    // quit path (the process may exit before it fires). The event handler
    // stays as an idempotent safety net for listener crashes.
    revokeOrigin();
    starting = null;
    if (server) {
      server.close();
      server = null;
    }
  }

  return { createPreviewUrl, dispose };
}

export type LocalPreviewServer = ReturnType<typeof createLocalPreviewServer>;

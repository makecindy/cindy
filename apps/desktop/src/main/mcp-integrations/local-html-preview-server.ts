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
 *  - GET/HEAD only; `nosniff` + `no-store` + a page-level CSP on EVERY
 *    response, error/refusal paths included (see the CSP constant for which
 *    directives are load-bearing and which are not);
 *  - on listener error/close the origin grant is revoked immediately so a
 *    freed port can never be taken over while the SSRF policy still trusts it.
 *
 * The runtime's SSRF policy only ever sees the one exact origin this server
 * actually listens on (the host calls `applyPreviewOrigins` after a successful
 * bind, and clears it on any error/close). Other loopback hosts/ports and
 * `file://` stay blocked.
 *
 * SCOPE — what this module does NOT try to stop, and why:
 *  - Filesystem races (swap a validated path for a symlink mid-request). An
 *    attacker who can win that race already holds filesystem write access and
 *    timing control, and can read the file directly; the defence would guard a
 *    door in a wall that does not exist.
 *  - A preview page exfiltrating its own content (page-initiated navigation,
 *    WebRTC, DNS prefetch). Running arbitrary JS in this browser with
 *    unrestricted network access is an already-accepted capability of the
 *    stack — see the SECURITY POSTURE note in browser-managed-config.ts.
 *  - Another local process impersonating this server after port reuse. That
 *    presupposes an already-compromised machine.
 * What IS defended: an arbitrary local process reading workspace files through
 * this listener (capability token + path containment), the SSRF allowlist
 * widening beyond one exact origin, page persistence via Service Worker, and
 * the page reaching OTHER local services (see the CSP constant).
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
 * Page-level policy for previewed pages.
 *
 * Two directives here are load-bearing; the rest are cheap defence in depth.
 *
 *  - `worker-src 'none'` — LOAD-BEARING. Service Worker scripts fall back to
 *    `script-src` when `worker-src` is absent, so a preview script could
 *    register a SW in the /preview/<token>/ scope. A SW OUTLIVES the preview
 *    and answers later navigations with synthetic responses that carry none
 *    of these headers. Persistence beyond the page is the one thing an
 *    in-page script cannot otherwise obtain here.
 *
 *  - `connect-src 'self'` — LOAD-BEARING. The preview page itself sits on
 *    loopback, and browsers restrict private-page → private-service requests
 *    far less than public-page → private-service ones. Page-context fetch also
 *    does NOT pass through the Node SSRF guard, so the exact-origin allowlist
 *    cannot cover it. `'self'` keeps the page off every OTHER local service
 *    (notably the managed browser's own CDP port) while still letting it read
 *    its own directory — pages that `fetch('./data.json')` to render must keep
 *    working, or the tool stops being usable and callers go back to launching
 *    a raw browser, which is the incident this feature exists to prevent.
 *
 * The remaining directives are not individually load-bearing, but the overall
 * `'self'`/`'none'` posture is: every one of them also denies a request aimed at
 * another local service, including the no-cors shapes `connect-src` never sees
 * (`<img src="http://127.0.0.1:<other-port>/…">`, form posts, framing). Relaxing
 * any of them to a remote scheme — say `img-src https:` so previews can load
 * external images — reopens part of that containment, so treat such a change as
 * a security decision rather than a convenience one.
 *
 * NOT a goal: stopping a preview page from exfiltrating its own content.
 * Page-initiated navigation (`location.href` with data in the URL), WebRTC and
 * DNS prefetch are all left alone, because arbitrary JS with unrestricted
 * network access is already an accepted capability of this browser stack (see
 * the SECURITY POSTURE note in browser-managed-config.ts). `connect-src` does
 * incidentally block cross-origin fetch, but that is a side effect of the
 * local-service containment above, not a claim of exfiltration containment —
 * partial containment would be worse than none, since it invites reliance.
 */
const CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "worker-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "media-src 'self' data:; " +
  "connect-src 'self'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "sandbox allow-scripts allow-same-origin";

/**
 * Headers applied to EVERY response (200 and all error/refusal paths). A
 * refusal must not be served without CSP/no-store: a page without CSP on this
 * origin would give a script an unprotected execution context on the preview
 * origin (Copilot review).
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
  /** In-flight startup, tagged with the generation that began it. */
  let starting: { generation: number; promise: Promise<string> } | null = null;
  /**
   * Incremented by every dispose(). Anything that spans an `await` pins the
   * generation it began in and refuses to act once the value has moved on, so a
   * request that was already in flight when the backend switched can never
   * resurrect the listener or re-grant the SSRF origin behind it. A request
   * that starts AFTER a dispose reads the new value and proceeds normally —
   * dispose → new start stays a supported reuse, which is why this is a counter
   * rather than a sticky "disposed"/"failed" flag. A sticky flag also turned a
   * single transient listener error into a preview channel that stayed dead
   * until the app was restarted, and an unusable channel is exactly what pushes
   * callers back to launching a raw browser.
   */
  let generation = 0;
  const tokens = new Map<string, PreviewEntry>();

  /** Drop the SSRF grant for this server's origin (idempotent). */
  function revokeOrigin(): void {
    if (origin) {
      logger?.info?.(`[local-preview] revoking preview origin ${origin}`);
      applyPreviewOrigins([]);
      origin = null;
    }
  }

  async function ensureStarted(round: number): Promise<string> {
    if (round !== generation) {
      throw new LocalPreviewError('UNAVAILABLE', '预览服务在本次请求处理期间已停用');
    }
    if (origin) return origin;
    if (starting) {
      if (starting.generation === generation) return starting.promise;
      // A startup belonging to a superseded generation is still settling. It
      // will fail its own generation check and clean up after itself; this
      // caller must not join it, and must not be blocked by it either.
      starting = null;
    }
    const promise = (async () => {
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
      // The callbacks must revoke only the origin of THIS start round
      // (P2): dispose() → immediate reuse starts a NEW listener
      // with a NEW origin; the OLD listener's delayed 'close'/'error' event
      // must not drop the new round's grant (otherwise the fresh grant
      // disappears and its preview tabs get closed). `roundOrigin` is set
      // after a successful bind; before that no grant exists to revoke.
      let roundOrigin: string | null = null;
      srv.on('error', (err) => {
        // Fatal to THIS round only. Dropping the grant is the whole cleanup:
        // the next call sees `origin === null` and starts a fresh listener.
        // Latching a process-level failure here would mean one transient bind
        // error leaves previews permanently unavailable until restart
        // (greptile P1).
        logger?.error?.(`[local-preview] listener error: ${String(err)}`);
        if (roundOrigin && origin === roundOrigin) revokeOrigin();
      });
      srv.on('close', () => {
        // Covers normal dispose AND listener crash — never leave the SSRF
        // policy trusting a port nobody is serving (a local process could
        // otherwise bind the freed port and intercept the token URL). Only
        // revoke when this round still owns the grant.
        if (roundOrigin && origin === roundOrigin) revokeOrigin();
      });
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          resolve();
        });
      });
      // dispose() may have run while we were binding: it could not close a
      // listener it had never seen. A superseded round must never hand its
      // origin to the SSRF policy (Copilot P1).
      if (round !== generation) {
        srv.close();
        throw new LocalPreviewError('UNAVAILABLE', '预览服务在启动期间已停用');
      }
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        throw new LocalPreviewError('UNAVAILABLE', '无法确定预览监听地址');
      }
      server = srv;
      origin = `http://127.0.0.1:${addr.port}`;
      roundOrigin = origin; // this round's close/error events revoke only this
      logger?.info?.(`[local-preview] listening at ${origin}`);
      // Grant the SSRF exception ONLY after a successful bind.
      applyPreviewOrigins([origin]);
      return origin;
    })();
    starting = { generation: round, promise };
    try {
      const result = await promise;
      // Clear on settle either way, but only if this round still owns the
      // slot: a newer round may have replaced it while we were awaiting, and
      // dropping that one would make the next caller start a third listener.
      if (starting?.promise === promise) starting = null;
      return result;
    } catch (err) {
      if (starting?.promise === promise) starting = null;
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
      // Re-check hidden segments on the REAL path: a symlink with an ordinary
      // name (e.g. `assets -> .private`) passes the request-path check but
      // resolves into a hidden directory — hidden-directory content must stay
      // unreadable through ANY path form (Greptile P1).
      const realRel = nodePath.relative(root, real);
      if (realRel.split(nodePath.sep).some((s) => s.length > 0 && s.startsWith('.'))) {
        return null;
      }
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

    // `abs` is the realpath produced by resolveServedPath and has already been
    // asserted inside the serving root. We deliberately do NOT re-verify the
    // object's identity between here and the read: defeating a path check by
    // swapping files mid-request requires filesystem write access plus timing
    // control, and an attacker holding those can simply read the file directly
    // — the race defence would be guarding a door in a wall that isn't there.
    const stat = await fs.stat(abs, { bigint: true }).catch(() => null);
    if (!stat?.isFile()) return refuse(res);

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // `stat.size` is a bigint; Number() would lose precision beyond
      // Number.MAX_SAFE_INTEGER and send a wrong Content-Length for very large
      // resources (video/wasm), making clients truncate or hang (Copilot P1).
      'Content-Length': stat.size.toString(),
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(abs);
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
    const rootReal = await fs.realpath(rootAbs).catch(() => {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', `工作区不可解析: ${rootAbs}`);
    });
    await assertInsideRoot(rootAbs, targetAbs);
    // Reject hidden-segment ENTRY paths (e.g. `.private/index.html`): the
    // serving root IS the entry's directory, so the request-stage
    // hidden-segment checks in resolveServedPath can never see the hidden
    // root — the page would be served from hidden-directory content
    // (Greptile P1).
    const relToRoot = nodePath.relative(rootAbs, targetAbs);
    if (relToRoot.split(nodePath.sep).some((s) => s.length > 0 && s.startsWith('.'))) {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', '入口不能位于隐藏目录内');
    }
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
    // Resolve the entry to its REAL path and re-assert the boundary against
    // that identity: `public/index.html` may be a symlink pointing outside the
    // workspace, and its directory is what becomes the serving root. This is a
    // static fact about the link, not a race defence.
    const entryReal = await fs.realpath(targetAbs).catch(() => {
      throw new LocalPreviewError('NOT_FOUND', '入口文件不可解析');
    });
    await assertInsideRoot(rootReal, entryReal);
    // Re-check hidden segments on the REAL entry path: an ordinary-named
    // symlink (e.g. `public -> .private`) passes the lexical check above but
    // resolves into a hidden directory which would BECOME the serving root —
    // the request-stage checks could never see it again (codex-connector P1).
    const entryRel = nodePath.relative(rootReal, entryReal);
    if (entryRel.split(nodePath.sep).some((s) => s.length > 0 && s.startsWith('.'))) {
      throw new LocalPreviewError('PATH_NOT_ALLOWED', '入口不能位于隐藏目录内');
    }
    // Re-check the HTML extension on the REAL entry path (P2): a workspace
    // entry named `index.html` that is a symlink to a plain `.js`/`.json` file
    // passes the lexical check above; after realpath the entry would be served
    // as non-HTML, violating the .html/.htm-only contract (and its directory
    // would become the serving root).
    const realExt = nodePath.extname(entryReal).toLowerCase();
    if (!ENTRY_EXTENSIONS.has(realExt)) {
      throw new LocalPreviewError(
        'UNSUPPORTED_FILE',
        `入口真实文件不是 HTML 文件(仅支持 .html/.htm, 收到 "${realExt || '(无扩展名)'}")`,
      );
    }
    return entryReal;
  }

  async function createPreviewUrl(input: CreatePreviewInput): Promise<{ url: string }> {
    // Pin the generation before the first await. Entry validation touches the
    // filesystem, and the backend can be switched away from the managed browser
    // while it runs; without this the request would sail past the caller's
    // up-front backend check and re-grant an origin the host had already
    // revoked (codex-connector P1).
    const round = generation;
    // Validate the entry FIRST: an invalid request (out-of-workspace, missing,
    // non-HTML) must never start the listener or grant an origin
    // (Copilot review).
    const entryAbs = await resolveEntryPath(input);
    if (round !== generation) {
      throw new LocalPreviewError('UNAVAILABLE', '预览服务在入口校验期间已停用');
    }
    const base = await ensureStarted(round);
    // Serving root = the entry's directory: relative resources work, but the
    // page can never reach sibling workspace content outside that directory.
    // `entryAbs` is already the REAL path (resolved + re-asserted above).
    const root = nodePath.dirname(entryAbs);
    const token = crypto.randomBytes(32).toString('hex'); // 256-bit, unguessable
    // Last checkpoint before the token becomes usable: a dispose that landed
    // while the listener was starting must not leave a live capability behind.
    if (round !== generation) {
      throw new LocalPreviewError('UNAVAILABLE', '预览服务在发放期间已停用');
    }
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
    // Bump FIRST. Every in-flight request pinned the previous value and checks
    // it again at each checkpoint, so moving the counter before any teardown
    // guarantees none of them can complete against a server we are tearing
    // down — including one whose listener has not finished binding yet and
    // which we therefore cannot close here.
    generation += 1;
    tokens.clear();
    // Revoke synchronously — never rely on the async 'close' event for the
    // quit path (the process may exit before it fires). The event handler
    // stays as an idempotent safety net for listener crashes.
    revokeOrigin();
    // `starting` is deliberately left alone: an in-flight round now belongs to
    // a superseded generation and will fail its own check and close its own
    // listener. Clearing it here would only make a concurrent caller start a
    // second listener while the first is still binding.
    if (server) {
      server.close();
      server = null;
    }
  }

  return { createPreviewUrl, dispose };
}

export type LocalPreviewServer = ReturnType<typeof createLocalPreviewServer>;

/**
 * localPathResolver
 * ---------------------------------------------------------------------------
 * Pure-string utilities to classify a markdown link / inline @-chip ref and
 * resolve it to an absolute filesystem path or a `file://` URL.
 *
 * Used by:
 *   - F1 (MarkdownRenderer): split <a href="..."> into external / image-local
 *     / text-local and route to openExternal / ImageLightbox / TextLightbox.
 *   - F2 (UserMessage): turn an inline @-chip ref ("src/App.tsx") into the
 *     absolute path that TextLightbox needs to read.
 *
 * Design notes:
 *   - Sandbox-safe: no `node:path`, no `node:fs`, no IPC. The renderer layer
 *     can't import Node modules, so all path manipulation is pure regex /
 *     string slicing.
 *   - No fs.exists check. If the file is missing, the lightbox's own onError
 *     toast handles the failure.
 *   - Cross-platform: handles Windows backslashes AND POSIX slashes in both
 *     the `cwd` (session.workingDir) and the `href`. The decision uses the
 *     cwd's separator style.
 */

import { stripTrailingPathSeparators } from '../../shared/pathText';

/** Image extension whitelist. Case-insensitive. Allows `?v=2`-style suffix. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?.*)?$/i;
/** 3D model extension whitelist. .glb/.gltf open the in-app ModelLightbox;
 *  .fbx is classified as model too but activates as reveal-in-Finder (no
 *  in-app FBX preview, and openPath would hit macOS Preview's misleading
 *  "damaged file" dialog). Must be checked BEFORE the text fallback in
 *  classifyMarkdownHref — .gltf is JSON underneath and would otherwise be
 *  swallowed by 'text-local'. */
export const MODEL_EXT_RE = /\.(glb|gltf|fbx)(\?.*)?$/i;
/** Has any 1-10 char file extension (e.g. `.tsx`, `.md`, `.txt`). */
const HAS_EXT_RE = /\.[a-z0-9]{1,10}(\?.*)?$/i;
/** Windows absolute path: `C:\foo` or `C:/foo`. */
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/** POSIX absolute path that ends in a file extension (excludes bare `/etc`). */
const POSIX_ABS_PATH_RE = /^\/[^/\s][^\s]*\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** Relative path: at least one separator + ends in extension + no whitespace + no colon. */
const REL_PATH_WITH_SEP_AND_EXT_RE = /^[^\s:]*[\\/][^\s:]+\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** Any URL scheme (http://, https://, file://, ftp://, ...). */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Trailing path separator — distinguishes a directory ref from a file ref. */
const TRAILING_SEP_RE = /[\\/]$/;

export type LocalHrefKind =
  | 'image-local'
  | 'model-local'
  | 'text-local'
  | 'external'
  | 'directory';
export interface KnownLocalFileRef {
  name: string;
  path: string;
}

/**
 * Detect whether a path-shaped string refers to a directory rather than a file.
 *
 * Heuristic: trailing `/` or `\`. Markdown / chat content that wants to point
 * at a folder almost always writes `src/components/`, `./docs/`, `C:\Users\`,
 * etc. We don't (and can't, in renderer) stat the filesystem, so the trailing
 * separator is the only reliable signal we have.
 *
 * Used by both `looksLikeFilePath` (to reject directory shapes upstream) and
 * `classifyMarkdownHref` (to surface the 'directory' kind so callers can
 * choose not to open a file lightbox on a folder click).
 *
 * Pure function. Never throws. No IO.
 */
export function looksLikeDirectoryPath(text: string): boolean {
  if (!text) return false;
  return TRAILING_SEP_RE.test(text);
}

/**
 * Classify a markdown `<a href>` for routing.
 *
 * Decision order (first hit wins):
 *   1. empty / undefined        → 'external' (defensive — caller no-ops)
 *   2. ^https?://               → 'external'
 *   3. ^file:// (then byExt of remainder)
 *   4. POSIX absolute (`^/`)    → byExt
 *   5. Windows absolute         → byExt
 *   6. contains `/` or `\`      → byExt
 *   7. has file extension       → byExt (bare `App.tsx` etc.)
 *   8. otherwise                → 'external' (plain word like `hello`)
 *
 * byExt: IMAGE_EXT_RE → 'image-local', else 'text-local'.
 *
 * Pure function. Never throws. No IO.
 */
/**
 * Decide whether an inline-code text node should be treated as a clickable
 * filesystem path. Stricter than `classifyMarkdownHref`: false positives here
 * are costly because inline code commonly contains identifiers / commands /
 * flags (`useState`, `npm run build`, `--filter desktop`) that would turn
 * into broken click targets if we matched too liberally.
 *
 * Match policy (any one is enough):
 *   1. Windows absolute path (`C:\foo`, `D:/bar`) — drive letter is unambiguous
 *   2. POSIX absolute with file extension (`/Users/me/foo.md`)
 *      — bare `/etc` or `/dev/null` (no dotted extension) does NOT match
 *   3. Relative path with separator + extension + no whitespace + no colon
 *      (`src/App.tsx`, `./foo.md`, `../sib/foo.json`)
 *      — bare `package.json` (no separator) does NOT match (too ambiguous to
 *      know which one in the workspace)
 *
 * URL schemes (`http://`, `file://`, `git+ssh://`, ...) are always rejected;
 * they're URLs, not local paths, even though some resolve to files.
 *
 * Cross-platform: works the same on Windows, macOS, and Linux. A Mac user
 * clicking a Windows-absolute path will get a "file not found" toast from
 * TextLightbox — same failure mode as a markdown link to that path.
 *
 * Pure function. Never throws. No IO.
 */
export function looksLikeFilePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('\n')) return false;
  if (URL_SCHEME_RE.test(text)) return false;
  // Directory shapes (trailing `/` or `\`) are not files; reject early so
  // inline-code chips like `src/components/` or `C:\Users\` don't become
  // TextLightbox triggers. The Windows absolute branch below would otherwise
  // accept `C:\Users\` because WIN_ABS_RE only checks the prefix.
  if (looksLikeDirectoryPath(text)) return false;
  if (WIN_ABS_RE.test(text)) return true;
  if (POSIX_ABS_PATH_RE.test(text)) return true;
  if (REL_PATH_WITH_SEP_AND_EXT_RE.test(text)) return true;
  return false;
}

export function classifyMarkdownHref(href: string | undefined): LocalHrefKind {
  if (!href) return 'external';
  if (/^https?:\/\//i.test(href)) return 'external';
  // In-document anchors (`#section`, `#v1.2`) are scroll targets, not paths.
  // A dotted fragment like `#v1.2` would otherwise trip HAS_EXT_RE below and
  // misclassify as 'text-local'. Routing belongs to the renderer's anchor
  // scroll handler, so surface as 'external' and let it fall through there.
  if (href.startsWith('#')) return 'external';
  // Any URL scheme other than file:// is a non-local target — http(s), and our
  // internal deep links (cindy://session/<uuid>, xdt-audio://...). file://
  // is the one scheme that maps to a local path and is unwrapped below. This
  // mirrors the URL_SCHEME_RE rejection in looksLikeFilePath so the two
  // predicates stay symmetric: without it a session deep link (contains `/`,
  // no extension) slips into the local-file branch and the renderer opens a
  // missing-file lightbox instead of navigating.
  if (URL_SCHEME_RE.test(href) && !href.startsWith('file://')) return 'external';

  let probe = href;
  if (probe.startsWith('file://')) probe = probe.slice(7);

  const looksLocal =
    probe.startsWith('/') ||
    WIN_ABS_RE.test(probe) ||
    probe.includes('/') ||
    probe.includes('\\') ||
    HAS_EXT_RE.test(probe);

  if (!looksLocal) return 'external';
  // A trailing separator on a local-shaped path means the author is pointing
  // at a folder, not a file. Surface as its own kind so renderers can opt out
  // of file-preview behavior (a TextLightbox on a directory makes no sense
  // and the IPC read would just fail with EISDIR).
  if (looksLikeDirectoryPath(probe)) return 'directory';
  if (IMAGE_EXT_RE.test(probe)) return 'image-local';
  // Model check must precede the text fallback: .gltf is a JSON file and
  // would otherwise classify as 'text-local'.
  if (MODEL_EXT_RE.test(probe)) return 'model-local';
  return 'text-local';
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndHash(value: string): string {
  const hashIdx = value.indexOf('#');
  const beforeHash = hashIdx >= 0 ? value.slice(0, hashIdx) : value;
  const queryIdx = beforeHash.indexOf('?');
  return queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
}

function basenameFromPathLike(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function normalizeKnownFileHref(href: string): string {
  const strippedScheme = href.startsWith('file://') ? href.slice(7) : href;
  const decoded = safeDecodeURIComponent(stripQueryAndHash(strippedScheme.trim()));
  return basenameFromPathLike(decoded);
}

/**
 * Resolve a model-authored markdown link against files the user attached in
 * this chat session. LLMs often cite an uploaded document as
 * `[name.docx](name.docx)` because the prompt exposes the original filename,
 * while the real file lives outside the session working directory. In that
 * case, resolve by unique attachment basename before falling back to cwd-based
 * path resolution.
 *
 * Matching is case-insensitive. Windows / macOS-default filesystems are
 * case-insensitive, and LLMs frequently lowercase the basename when authoring
 * the link (e.g. uploaded `Report.docx` cited as `report.docx`). Linux pays a
 * tiny false-positive risk in exchange — the candidate set is the current
 * session's uploads only, and unique-match still applies, so accidental
 * collisions are negligible.
 *
 * Ambiguous duplicate names intentionally return null so callers keep the
 * existing workspace resolver behavior instead of opening the wrong file.
 */
export function resolveKnownLocalFileHref(
  href: string,
  files: readonly KnownLocalFileRef[] | undefined,
): string | null {
  if (!href || !files || files.length === 0) return null;
  const wanted = normalizeKnownFileHref(href).toLowerCase();
  if (!wanted) return null;

  const matches = files.filter((file) => {
    const name = normalizeKnownFileHref(file.name).toLowerCase();
    const pathName = normalizeKnownFileHref(file.path).toLowerCase();
    return wanted === name || wanted === pathName;
  });

  if (matches.length !== 1) return null;
  return matches[0].path;
}

/**
 * Resolve a markdown href / @-chip ref to an absolute filesystem path.
 *
 * Behavior:
 *   - `file://...`                    → decode + strip leading slash on Win
 *   - POSIX absolute (`^/`)           → return as-is
 *   - Windows absolute (`^[A-Za-z]:`) → return as-is
 *   - relative                        → joinPath(cwd, href)
 *       * cwd contains `\` → Windows-style join (use `\`, normalize href `/` → `\`)
 *       * else             → POSIX-style join (use `/`)
 *       * trailing separator on cwd is trimmed before joining
 *
 * No fs.exists check; downstream lightbox handles missing files.
 *
 * @param href markdown href (may have `file://` prefix) OR @-chip ref (no `@`)
 * @param cwd  session.workingDir, expected to be an absolute path
 */
export function resolveLocalPath(href: string, cwd: string): string {
  if (href.startsWith('file://')) {
    // safeDecode: filenames with a literal `%` ("100%完成.md") form invalid
    // escape sequences — a bare decodeURIComponent throws URIError and, since
    // remote sessions call this synchronously during render, took down the
    // whole route with react-router's error page. Fall back to the raw path.
    let p = safeDecodeURIComponent(href.slice(7));
    // Windows file URL: 'file:///C:/x.png' → after slice(7): '/C:/x.png'
    // → strip leading '/' → 'C:/x.png'
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    return p;
  }
  if (href.startsWith('/')) return href;
  if (WIN_ABS_RE.test(href)) return href;
  // UNC share (`\\server\share\...`) is already absolute on Windows — joining
  // it onto the cwd would produce garbage.
  if (href.startsWith('\\\\')) return href;

  const isWin = cwd.includes('\\');
  const sep = isWin ? '\\' : '/';
  const trimmedCwd = stripTrailingPathSeparators(cwd);
  const normalizedHref = isWin ? href.replace(/\//g, '\\') : href;
  return `${trimmedCwd}${sep}${normalizedHref}`;
}

/**
 * Absolutize an agent tool-input file path (Read/Edit/Write `file_path`,
 * Codex file_change target) against the session working directory.
 *
 * Why: the agent runtime resolves a relative path against the session cwd —
 * and some models DO emit relative paths even though the tool spec asks for
 * absolute ones — while every renderer file IPC (`text-file:read-preview`,
 * `shell:show-item-in-folder`, `xdt-file://`) requires an absolute path.
 * Mirroring the runtime semantics here makes the tool's file chip open the
 * same file the agent actually read/wrote.
 *
 *   - absolute (POSIX `/`, drive letter, UNC `\\`) → returned untouched
 *   - relative + known workingDir → resolveLocalPath join (cwd's separator
 *     style; for remote sessions the caller passes the REMOTE workingDir,
 *     which is the cwd the remote agent resolved against)
 *   - relative + empty workingDir (component used outside the chat stream)
 *     → returned untouched, preserving the downstream
 *     "Path must be absolute" error UX instead of producing a garbage path
 */
export function resolveToolFilePath(rawPath: string, workingDir: string): string {
  if (!rawPath || !workingDir) return rawPath;
  return resolveLocalPath(rawPath, workingDir);
}

/**
 * markdown-monorepo-resolve: smart wrapper around the legacy `resolveLocalPath`.
 *
 * In a pnpm monorepo, an LLM frequently writes `src/App.tsx` meaning a path
 * relative to a sub-package (e.g. `apps/desktop/`), not the workspace root
 * we hold in `session.workingDir`. The naive cwd-join produces a path that
 * doesn't exist and the lightbox just shows "file not found".
 *
 * This helper delegates to the main-process `fs:resolve-path` IPC, which:
 *   1. tries `cwd/href` directly (cheap, hot-path),
 *   2. falls back to BFS-searching the workspace for `**\/<href>`,
 *   3. returns 'unique' / 'multiple' / 'none' so the caller can pick UX:
 *        - unique   → open immediately
 *        - multiple → toast "use absolute path", skip
 *        - none     → fall back to the legacy path so the existing
 *                     "file not found" error UX still fires.
 *
 * Degrades silently to legacy behavior when the IPC isn't available
 * (e.g. running outside Electron in unit tests). Callers don't need to
 * special-case this.
 */
export type SmartResolveResult =
  | { status: 'unique'; absPath: string; kind?: 'file' | 'directory' }
  | { status: 'multiple'; candidates: string[] }
  | { status: 'none'; fallbackAbsPath: string };

export async function resolveLocalPathSmart(
  href: string,
  workingDir: string,
): Promise<SmartResolveResult> {
  const fallback = resolveLocalPath(href, workingDir);
  // Main-process resolver expects a native absolute/relative path, not a
  // file:// URL. Keep the public API accepting file:// because markdown links
  // frequently use that form; resolveLocalPath already handles the cross-
  // platform decoding rules.
  const lookupHref = href.startsWith('file://') ? fallback : href;
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
    | { resolvePath?: typeof window.electronAPI.resolvePath }
    | undefined;
  if (!api?.resolvePath) {
    return { status: 'none', fallbackAbsPath: fallback };
  }
  try {
    const r = await api.resolvePath({ href: lookupHref, workingDir });
    if (r.status === 'unique' && r.candidates[0]) {
      return { status: 'unique', absPath: r.candidates[0], ...(r.kind ? { kind: r.kind } : {}) };
    }
    if (r.status === 'multiple') {
      return { status: 'multiple', candidates: r.candidates };
    }
    return { status: 'none', fallbackAbsPath: fallback };
  } catch {
    // IPC failure shouldn't break the click — fall through to legacy.
    return { status: 'none', fallbackAbsPath: fallback };
  }
}

// ── Renderer-side resolution cache ───────────────────────────────────────
// `resolveLocalPathSmart` round-trips to the main process (`fs:resolve-path`),
// which is async even when the main-side answer is already cached. The Markdown
// renderer resolves a target eagerly at render time (chip only when the path
// resolves to a unique file), so without a synchronous renderer-side cache
// every session switch re-fires the IPC and re-flashes plain-text → chip.
//
// This cache lets a re-mounted reference read its prior resolution
// synchronously via `peekResolveLocalPathSmart` (no flash, no IPC) and de-dups
// concurrent lookups of the same (workingDir, href) via
// `resolveLocalPathSmartCached`.
//
// Keyed by `workingDir::href`, mirroring the main-process cache; line/column
// don't affect resolution so they're intentionally excluded. No TTL on
// purpose: switching back to a session minutes later must still paint chips
// instantly, and files cited by chat output are effectively immutable for the
// lifetime of the view. Capacity-bounded (oldest insertion evicted) so a
// long-lived renderer doesn't grow without limit.
const SMART_RESOLVE_CACHE_CAP = 500;
const smartResolveCache = new Map<string, SmartResolveResult>();
const smartResolveInflight = new Map<string, Promise<SmartResolveResult>>();

function smartResolveCacheKey(workingDir: string, href: string): string {
  return `${workingDir}::${href}`;
}

/**
 * Synchronously read a previously-computed `resolveLocalPathSmart` result.
 * Returns `undefined` on a miss so the caller can fall back to the async path.
 */
export function peekResolveLocalPathSmart(
  href: string,
  workingDir: string,
): SmartResolveResult | undefined {
  return smartResolveCache.get(smartResolveCacheKey(workingDir, href));
}

// ── Batch scheduler ──────────────────────────────────────────────────────
// The markdown renderer resolves every path target eagerly at render time, so
// switching to a session mounts hundreds of references at once. Resolving each
// with its own IPC fired hundreds of independent main-process workspace walks
// and froze the window. Instead we collect every cache-missing (workingDir,
// href) registered within one microtask, then issue ONE `resolvePathBatch` IPC
// per workingDir — the main process answers them all in a single async walk.

interface PendingBatchEntry {
  resolvers: Array<(result: SmartResolveResult) => void>;
}
// workingDir → (href → waiters). Swapped for a fresh Map on each flush.
let pendingBatch = new Map<string, Map<string, PendingBatchEntry>>();
let flushScheduled = false;

/** Convert one main-process batch entry into a SmartResolveResult. */
function smartResultFromBatch(
  href: string,
  workingDir: string,
  raw:
    | { status: 'unique' | 'multiple' | 'none'; candidates: string[]; kind?: 'file' | 'directory' }
    | undefined,
): SmartResolveResult {
  if (raw?.status === 'unique' && raw.candidates[0]) {
    return { status: 'unique', absPath: raw.candidates[0], ...(raw.kind ? { kind: raw.kind } : {}) };
  }
  if (raw?.status === 'multiple') {
    return { status: 'multiple', candidates: raw.candidates };
  }
  return { status: 'none', fallbackAbsPath: resolveLocalPath(href, workingDir) };
}

/** Cache a resolved result, evict if over capacity, and wake every waiter. */
function settleSmartResult(
  workingDir: string,
  href: string,
  hrefMap: Map<string, PendingBatchEntry>,
  result: SmartResolveResult,
): void {
  const key = smartResolveCacheKey(workingDir, href);
  // Capacity eviction: drop oldest insertion (Map preserves order).
  if (smartResolveCache.size >= SMART_RESOLVE_CACHE_CAP) {
    const oldest = smartResolveCache.keys().next().value;
    if (oldest !== undefined) smartResolveCache.delete(oldest);
  }
  smartResolveCache.set(key, result);
  smartResolveInflight.delete(key);
  const entry = hrefMap.get(href);
  if (entry) for (const resolve of entry.resolvers) resolve(result);
}

async function runBatchForDir(
  workingDir: string,
  hrefMap: Map<string, PendingBatchEntry>,
): Promise<void> {
  const hrefs = [...hrefMap.keys()];
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
    | { resolvePathBatch?: typeof window.electronAPI.resolvePathBatch }
    | undefined;

  if (!api?.resolvePathBatch) {
    for (const href of hrefs) {
      settleSmartResult(workingDir, href, hrefMap, {
        status: 'none',
        fallbackAbsPath: resolveLocalPath(href, workingDir),
      });
    }
    return;
  }

  // Main resolver wants a native path, not a file:// URL — same rule as
  // `resolveLocalPathSmart`. Map each href to the lookup form it sends.
  const lookupOf = new Map<string, string>();
  for (const href of hrefs) {
    lookupOf.set(href, href.startsWith('file://') ? resolveLocalPath(href, workingDir) : href);
  }
  const lookups = [...new Set(lookupOf.values())];

  try {
    const raw = await api.resolvePathBatch({ hrefs: lookups, workingDir });
    for (const href of hrefs) {
      const result = smartResultFromBatch(href, workingDir, raw[lookupOf.get(href)!]);
      settleSmartResult(workingDir, href, hrefMap, result);
    }
  } catch {
    // IPC failure shouldn't break clicks — every href falls back to legacy.
    for (const href of hrefs) {
      settleSmartResult(workingDir, href, hrefMap, {
        status: 'none',
        fallbackAbsPath: resolveLocalPath(href, workingDir),
      });
    }
  }
}

function flushSmartResolveBatch(): void {
  flushScheduled = false;
  const batches = pendingBatch;
  pendingBatch = new Map();
  for (const [workingDir, hrefMap] of batches) {
    void runBatchForDir(workingDir, hrefMap);
  }
}

function scheduleSmartResolveFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushSmartResolveBatch);
}

/**
 * Cached + batched wrapper around the main-process resolver. A cache hit (or an
 * already in-flight request for the same key) returns immediately; otherwise
 * the (workingDir, href) is registered into the current microtask's batch and
 * resolved by a single `resolvePathBatch` IPC. All statuses are cached
 * (including `none`) so unresolvable refs don't repeatedly trigger a walk.
 */
export async function resolveLocalPathSmartCached(
  href: string,
  workingDir: string,
): Promise<SmartResolveResult> {
  const key = smartResolveCacheKey(workingDir, href);
  const cached = smartResolveCache.get(key);
  if (cached) return cached;
  const inflight = smartResolveInflight.get(key);
  if (inflight) return inflight;

  const promise = new Promise<SmartResolveResult>((resolve) => {
    let hrefMap = pendingBatch.get(workingDir);
    if (!hrefMap) {
      hrefMap = new Map();
      pendingBatch.set(workingDir, hrefMap);
    }
    let entry = hrefMap.get(href);
    if (!entry) {
      entry = { resolvers: [] };
      hrefMap.set(href, entry);
    }
    entry.resolvers.push(resolve);
  });
  smartResolveInflight.set(key, promise);
  scheduleSmartResolveFlush();
  return promise;
}

/** Test-only: drop all cached + in-flight entries and pending batches. */
export function _clearSmartResolveCache(): void {
  smartResolveCache.clear();
  smartResolveInflight.clear();
  pendingBatch = new Map();
  flushScheduled = false;
}

/**
 * Convert an absolute filesystem path to a `file://` URL.
 *
 * NOTE: Chromium blocks `<img src="file://">` from http(s) renderer origins
 * (Vite dev server, prod CSP). For inline image previews, prefer
 * `toLocalFileUrl()` which routes through the privileged `xdt-file://`
 * custom protocol. `toFileUrl` is kept for code paths that legitimately need
 * a file:// URL (e.g. shell.openExternal callers, native file:// consumers).
 *
 * - Backslashes are normalized to forward slashes.
 * - Minimal percent-encoding: only ` `, `#`, `?`, `%` — keeps Chinese / unicode
 *   filenames readable in devtools.
 * - POSIX abs `/abs/x.png` → `file:///abs/x.png`
 *   Win abs `C:/x/a.png`   → `file:///C:/x/a.png`
 */
export function toFileUrl(absPath: string): string {
  const slashes = absPath.replace(/\\/g, '/');
  const encoded = slashes.replace(/[ #?%]/g, (c) => encodeURIComponent(c));
  return slashes.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * Convert an absolute filesystem path to an `xdt-file://` URL that the
 * renderer can load as `<img src>`. Routes through the main-process custom
 * protocol (apps/desktop/src/main/localFileProtocol.ts), which enforces:
 *   - absolute path
 *   - image extension whitelist (png/jpg/jpeg/gif/webp/svg/bmp/ico)
 *   - file existence
 *
 * URL shape: `xdt-file://local/?path=<percent-encoded-abs-path>[&v=<revision>]`
 *
 * The path is fully percent-encoded (encodeURIComponent) so backslashes,
 * spaces, Chinese characters, and `?`/`#` are all safe in the query value.
 */
export function toLocalFileUrl(absPath: string, revision?: string): string {
  const url = `xdt-file://local/?path=${encodeURIComponent(absPath)}`;
  return revision ? `${url}&v=${encodeURIComponent(revision)}` : url;
}

/**
 * Normalize the legacy path-shaped `xdt-file:///...` URL used by older
 * messages into the query-shaped URL understood by the main-process handler.
 *
 * The custom protocol deliberately keeps the absolute path in `?path=` so
 * Chromium cannot reinterpret a Windows drive letter as the URL host. Keep
 * canonical `xdt-file://local/?path=...` URLs byte-for-byte unchanged; this
 * helper is only a compatibility bridge for persisted/history messages.
 */
export function normalizeXdtFileUrlForRenderer(url: string): string {
  if (!url.startsWith('xdt-file:///')) return url;

  const queryOrHash = url.search(/[?#]/);
  const rawPath = url.slice('xdt-file://'.length, queryOrHash >= 0 ? queryOrHash : undefined);
  let absPath = safeDecodeURIComponent(rawPath);
  // URL syntax adds a leading slash before a Windows drive letter.
  if (/^\/[A-Za-z]:[\\/]/.test(absPath)) absPath = absPath.slice(1);
  if (!(absPath.startsWith('/') || WIN_ABS_RE.test(absPath))) return url;

  // Preserve the optional cache-busting revision used by renderer-created
  // URLs, while ignoring unrelated legacy query parameters.
  let revision: string | undefined;
  if (queryOrHash >= 0 && url[queryOrHash] === '?') {
    const match = /(?:^|&)v=([^&#]*)/.exec(url.slice(queryOrHash + 1));
    if (match) revision = safeDecodeURIComponent(match[1]);
  }
  return toLocalFileUrl(absPath, revision);
}

/**
 * Normalize an original Markdown image destination for renderer loading.
 *
 * The caller preserves the original mdast destination before react-markdown
 * serializes it as a URL. That distinction is required because a real space
 * and a literal filename segment `%20` otherwise both reach the custom `img`
 * component as `%20`. Never URI-decode a raw filesystem path. A `file://`
 * destination is the exception: its path is URL-encoded by definition, so
 * decode that scheme payload exactly once (`%2520` remains literal `%20`).
 *
 * Already-routable URLs stay byte-for-byte unchanged. This matters for
 * xdt-file query strings and remote URLs, whose existing escapes belong to
 * their own protocol rather than to a local filesystem path.
 */
export function normalizeMarkdownImageSrc(
  src: string | undefined,
  workingDir: string,
  allowPrivilegedLinks: boolean,
): string | undefined {
  if (!src) return src;
  if (!allowPrivilegedLinks) {
    return /^https?:\/\//i.test(src) ? src : undefined;
  }
  if (
    src.startsWith('data:') ||
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    src.startsWith('cindy-remote-media://')
  ) {
    return src;
  }
  if (src.startsWith('xdt-file://')) return normalizeXdtFileUrlForRenderer(src);

  let localPath = src;
  if (localPath.startsWith('file://')) {
    localPath = safeDecodeURIComponent(localPath.slice(7));
  }
  // file:///C:/x.png -> /C:/x.png after stripping the scheme. Drop the
  // URL-only leading slash before handing the native Windows path onward.
  if (/^\/[A-Za-z]:[\\/]/.test(localPath)) localPath = localPath.slice(1);
  return toLocalFileUrl(resolveLocalPath(localPath, workingDir));
}

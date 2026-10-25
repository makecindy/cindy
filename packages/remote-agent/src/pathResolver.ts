/**
 * pathResolver
 * ---------------------------------------------------------------------------
 * markdown-monorepo-resolve: server-side smart path resolver.
 *
 * Why this exists:
 *   In a pnpm monorepo, AI-generated markdown / chat content frequently
 *   writes paths like `src/App.tsx` meaning `apps/desktop/src/App.tsx`,
 *   while session.workingDir holds the workspace root. A naive
 *   `path.join(cwd, href)` produces a non-existent path and the in-app
 *   preview just shows "file not found".
 *
 * Strategy:
 *   1. Absolute href → stat directly.
 *   2. Direct join `cwd/href` → stat.
 *   3. BFS the workspace looking for files whose absolute path ends with
 *      `/<href>` (path-suffix match). Bounded by maxDepth + maxCandidates.
 *
 * Pure module: no Electron / IPC imports — depends only on `node:fs`,
 * `node:os` and `node:path` so it can be unit-tested against a real tmp
 * directory tree. The host (main/index.ts) injects `isPathAllowed` as
 * defence-in-depth, and may inject `homeDir` (defaults to os.homedir()).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ResolvePathStatus = 'unique' | 'multiple' | 'none';

export interface ResolvePathResult {
  status: ResolvePathStatus;
  candidates: string[];
  /** unique 命中时的目标类型;目录 chip(点击定位侧边栏文件浏览器)靠它区分。
   *  BFS 只搜文件,故 multiple 恒为文件、不带此字段。缺省按 file 理解。 */
  kind?: 'file' | 'directory';
}

export interface ResolveOptions {
  /** Optional path-allowlist guard, applied to every candidate. */
  isPathAllowed?: (absPath: string) => boolean;
  /** Stop BFS after this many file matches. Default 10. */
  maxCandidates?: number;
  /** Cap BFS depth to keep CPU bounded. Default 8. */
  maxDepth?: number;
  /** Directory names to skip during BFS. Defaults to DEFAULT_IGNORE_DIRS. */
  ignoreDirs?: ReadonlySet<string>;
  /** Home dir used to expand a leading `~`. Defaults to os.homedir(); injected in tests. */
  homeDir?: string;
}

/** Ignore dirs known to be heavy or irrelevant for source-file lookups. */
export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.cache',
  '.vscode',
  '.idea',
  'coverage',
  '.sivi',
  '.cursor',
  'build',
  'dist',
  'out',
  '.next',
  '.turbo',
  '.vite',
  '.pnpm-store',
]);

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/);
}

function safeDecodeHrefForLookup(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }

  // Decoding is for filename characters such as spaces/CJK only. Do not let a
  // percent-encoded segment become path syntax like "../" or Windows "\..\".
  const separatorChanged =
    (decoded.match(/\//g) ?? []).length !== (value.match(/\//g) ?? []).length ||
    (decoded.match(/\\/g) ?? []).length !== (value.match(/\\/g) ?? []).length;
  if (separatorChanged && !path.win32.isAbsolute(decoded)) return null;
  if (URL_SCHEME_RE.test(decoded)) return null;
  const beforeSegments = pathSegments(value);
  const afterSegments = pathSegments(decoded);
  if (afterSegments.some((segment, index) => segment === '..' && beforeSegments[index] !== '..')) {
    return null;
  }
  return decoded;
}

export const _pathResolverTesting = {
  safeDecodeHrefForLookup,
};

/**
 * Expand a leading `~` (current user's home) so the resolver's "absolute →
 * stat" fast path can find files written in shell-home form (`~/Desktop/1.txt`,
 * common in macOS/Linux chat output where `~` is a shell convention).
 *
 * Strictly additive — only three current-user forms are touched:
 *   - `~`        → homeDir
 *   - `~/x`      → homeDir + /x
 *   - `~\x`      → homeDir + \x   (Windows agent output)
 * Everything else is returned byte-for-byte:
 *   - `~otheruser/x` is NOT expanded (needs the system user table; rare) — it
 *     stays a non-absolute string and resolves exactly as before.
 *   - any input not starting with `~` (ordinary prose, relative/absolute paths)
 *     is returned verbatim, so existing classification is never altered.
 *
 * Uses `path.join`, so separators / `.`/`..` are normalized per platform.
 */
function expandTilde(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

function normalizeForSuffix(p: string): string {
  // Unify separators so the suffix test works cross-platform; lowercase on
  // win32 to mirror the case-insensitive policy that filesystem matching
  // uses on Windows. Linux/macOS keep their case-sensitive comparison.
  const slashed = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * BFS-walk `root` looking for files whose absolute path ends with `/<href>`.
 * Stops when `maxCandidates` matches are found OR the queue empties.
 *
 * Exported separately so tests can drive the BFS without the upstream
 * stat-then-fallback flow getting in the way.
 */
export function bfsFindBySuffix(
  root: string,
  href: string,
  options: ResolveOptions = {},
): string[] {
  const maxCandidates = options.maxCandidates ?? 10;
  const maxDepth = options.maxDepth ?? 8;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const isPathAllowed = options.isPathAllowed ?? (() => true);

  const suffix = '/' + normalizeForSuffix(href).replace(/^\/+/, '');
  const out: string[] = [];
  // Depth-tagged queue so we can cut off at maxDepth without recursion.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && out.length < maxCandidates) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= maxCandidates) break;
      if (ent.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (ignoreDirs.has(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      } else if (ent.isFile()) {
        const abs = path.join(dir, ent.name);
        if (normalizeForSuffix(abs).endsWith(suffix) && isPathAllowed(abs)) {
          out.push(abs);
        }
      }
    }
  }
  return out;
}

/**
 * The full resolve flow used by the `fs:resolve-path` IPC handler.
 *
 * Returns 'none' on bad input (URL scheme, newline, non-absolute cwd) so the
 * renderer can silently fall back to the legacy join behavior.
 */
export async function resolveWorkspacePath(
  href: string,
  workingDir: string,
  options: ResolveOptions = {},
): Promise<ResolvePathResult> {
  if (!href || !workingDir) return { status: 'none', candidates: [] };
  if (href.includes('\n')) return { status: 'none', candidates: [] };
  if (URL_SCHEME_RE.test(href)) return { status: 'none', candidates: [] };
  if (!path.isAbsolute(workingDir)) return { status: 'none', candidates: [] };

  const isPathAllowed = options.isPathAllowed ?? (() => true);
  const decodedHref = safeDecodeHrefForLookup(href);
  if (decodedHref === null) return { status: 'none', candidates: [] };
  // Expand a leading `~` first; for any non-`~` input `probe === href`, so the
  // path below is unchanged for every existing case.
  const probe = expandTilde(decodedHref, options.homeDir ?? os.homedir());

  // Path 1: probe is absolute (incl. an expanded `~`) — just stat it. A `~`
  // path that misses returns 'none' here rather than falling through to the
  // workspace BFS: `~` names the home dir explicitly, not a workspace-relative
  // suffix, so a BFS fallthrough would be wrong.
  if (path.isAbsolute(probe)) {
    try {
      const s = await fs.promises.stat(probe);
      if (s.isFile() && isPathAllowed(probe)) {
        return { status: 'unique', candidates: [probe], kind: 'file' };
      }
      // 目录也算 unique 命中:目录 chip 点击定位进侧边栏文件浏览器。
      if (s.isDirectory() && isPathAllowed(probe)) {
        return { status: 'unique', candidates: [probe], kind: 'directory' };
      }
    } catch { /* fall through to none */ }
    return { status: 'none', candidates: [] };
  }

  // Path 2: direct join with workingDir.
  const direct = path.join(workingDir, decodedHref);
  try {
    const s = await fs.promises.stat(direct);
    if (s.isFile() && isPathAllowed(direct)) {
      return { status: 'unique', candidates: [direct], kind: 'file' };
    }
    if (s.isDirectory() && isPathAllowed(direct)) {
      return { status: 'unique', candidates: [direct], kind: 'directory' };
    }
  } catch { /* fall through to BFS */ }

  // Path 3: BFS the workspace.
  const candidates = bfsFindBySuffix(workingDir, decodedHref, options);
  if (candidates.length === 0) return { status: 'none', candidates: [] };
  if (candidates.length === 1) return { status: 'unique', candidates, kind: 'file' };
  return { status: 'multiple', candidates };
}

// ── LRU + TTL cache for the IPC handler ──────────────────────────────────
// The cache is module-scoped state shared across the IPC handler's lifetime.
// Clearing it is exposed as a helper so tests can isolate scenarios.

const CACHE_TTL_MS = 30_000;
const CACHE_CAP = 200;

interface CacheEntry {
  result: ResolvePathResult;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

function makeCacheKey(workingDir: string, href: string): string {
  return `${workingDir}::${href}`;
}

/**
 * Cached wrapper around `resolveWorkspacePath`. Same input → cached result
 * for `CACHE_TTL_MS`. Expired entries are evicted on read; the oldest entry
 * is dropped when the cache hits `CACHE_CAP`.
 */
export async function resolveWorkspacePathCached(
  href: string,
  workingDir: string,
  options: ResolveOptions = {},
): Promise<ResolvePathResult> {
  const key = makeCacheKey(workingDir, href);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expireAt > now) return hit.result;
  if (hit) cache.delete(key);

  const result = await resolveWorkspacePath(href, workingDir, options);

  // Capacity eviction: drop oldest insertion (Map preserves insertion order).
  if (cache.size >= CACHE_CAP) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { result, expireAt: now + CACHE_TTL_MS });
  return result;
}

/**
 * Async BFS that resolves MANY href suffixes in a SINGLE directory-tree walk.
 *
 * Each href gets its own candidate bucket (capped at `maxCandidates`). Every
 * file visited is suffix-tested against all not-yet-full buckets, so one walk
 * answers every href at once. The walk stops early when all buckets are full,
 * otherwise when the queue drains or `maxDepth` is reached.
 *
 * Uses async `fs.promises.readdir` (unlike the sync `bfsFindBySuffix`) so a
 * large-workspace walk yields to the event loop between directories and never
 * freezes the main process while it runs.
 */
export async function bfsFindManyBySuffix(
  root: string,
  hrefs: readonly string[],
  options: ResolveOptions = {},
): Promise<Map<string, string[]>> {
  const maxCandidates = options.maxCandidates ?? 10;
  const maxDepth = options.maxDepth ?? 8;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const isPathAllowed = options.isPathAllowed ?? (() => true);

  // One bucket per unique href; suffix precomputed for the endsWith test.
  const buckets = new Map<string, { suffix: string; out: string[] }>();
  for (const href of hrefs) {
    if (buckets.has(href)) continue;
    buckets.set(href, {
      suffix: '/' + normalizeForSuffix(href).replace(/^\/+/, ''),
      out: [],
    });
  }
  const result = new Map<string, string[]>();
  for (const [href, bucket] of buckets) result.set(href, bucket.out);

  const allFull = (): boolean => {
    for (const bucket of buckets.values()) {
      if (bucket.out.length < maxCandidates) return false;
    }
    return true;
  };

  // Depth-tagged queue so we can cut off at maxDepth without recursion.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && !allFull()) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (ignoreDirs.has(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      } else if (ent.isFile()) {
        const abs = path.join(dir, ent.name);
        const norm = normalizeForSuffix(abs);
        for (const bucket of buckets.values()) {
          if (bucket.out.length >= maxCandidates) continue;
          if (norm.endsWith(bucket.suffix) && isPathAllowed(abs)) {
            bucket.out.push(abs);
          }
        }
      }
    }
  }
  return result;
}

/**
 * Batch variant of `resolveWorkspacePath`: resolve many hrefs against one
 * workspace, sharing a single BFS pass for everything that misses the cheap
 * fast paths.
 *
 * Per href the cheap paths run first (absolute stat, direct `cwd/href` join);
 * only the leftovers go through the one shared `bfsFindManyBySuffix` walk. Same
 * per-href result semantics as `resolveWorkspacePath` ('unique' | 'multiple' |
 * 'none'). Duplicate hrefs collapse to a single resolution.
 */
export async function resolveWorkspacePathBatch(
  hrefs: readonly string[],
  workingDir: string,
  options: ResolveOptions = {},
): Promise<Record<string, ResolvePathResult>> {
  const out: Record<string, ResolvePathResult> = {};
  if (!workingDir || !path.isAbsolute(workingDir)) {
    for (const href of hrefs) out[href] = { status: 'none', candidates: [] };
    return out;
  }
  const isPathAllowed = options.isPathAllowed ?? (() => true);
  const homeDir = options.homeDir ?? os.homedir();

  const needBfs: string[] = [];
  const decodedNeedBfs = new Map<string, string>();
  const seen = new Set<string>();
  for (const href of hrefs) {
    if (seen.has(href)) continue;
    seen.add(href);

    if (!href || href.includes('\n') || URL_SCHEME_RE.test(href)) {
      out[href] = { status: 'none', candidates: [] };
      continue;
    }
    const decodedHref = safeDecodeHrefForLookup(href);
    if (decodedHref === null) {
      out[href] = { status: 'none', candidates: [] };
      continue;
    }
    // Expand a leading `~`; non-`~` hrefs are unchanged (probe === href). The
    // result key stays the original href so the renderer cache lines up.
    const probe = expandTilde(decodedHref, homeDir);
    if (path.isAbsolute(probe)) {
      try {
        const s = await fs.promises.stat(probe);
        if (s.isFile() && isPathAllowed(probe)) {
          out[href] = { status: 'unique', candidates: [probe], kind: 'file' };
          continue;
        }
        // 目录同样算 unique(镜像单发 resolveWorkspacePath——markdown 冷缓存
        // 走的是 batch,不镜像的话目录 chip 首渲永远点不亮)。
        if (s.isDirectory() && isPathAllowed(probe)) {
          out[href] = { status: 'unique', candidates: [probe], kind: 'directory' };
          continue;
        }
      } catch { /* fall through to none */ }
      out[href] = { status: 'none', candidates: [] };
      continue;
    }
    const direct = path.join(workingDir, decodedHref);
    try {
      const s = await fs.promises.stat(direct);
      if (s.isFile() && isPathAllowed(direct)) {
        out[href] = { status: 'unique', candidates: [direct], kind: 'file' };
        continue;
      }
      if (s.isDirectory() && isPathAllowed(direct)) {
        out[href] = { status: 'unique', candidates: [direct], kind: 'directory' };
        continue;
      }
    } catch { /* fall through to BFS */ }
    needBfs.push(href);
    decodedNeedBfs.set(href, decodedHref);
  }

  if (needBfs.length > 0) {
    const found = await bfsFindManyBySuffix(
      workingDir,
      [...new Set(decodedNeedBfs.values())],
      options,
    );
    for (const href of needBfs) {
      const candidates = found.get(decodedNeedBfs.get(href) ?? href) ?? [];
      if (candidates.length === 0) out[href] = { status: 'none', candidates: [] };
      else if (candidates.length === 1) out[href] = { status: 'unique', candidates, kind: 'file' };
      else out[href] = { status: 'multiple', candidates };
    }
  }
  return out;
}

/**
 * Cached batch resolver used by the `fs:resolve-path-batch` IPC handler. Reads
 * each href from the shared TTL cache; only misses go through one
 * `resolveWorkspacePathBatch` pass, and their results are written back so later
 * single-point (`resolveWorkspacePathCached`) and batch calls share them.
 */
export async function resolveWorkspacePathBatchCached(
  hrefs: readonly string[],
  workingDir: string,
  options: ResolveOptions = {},
): Promise<Record<string, ResolvePathResult>> {
  const now = Date.now();
  const out: Record<string, ResolvePathResult> = {};
  const miss: string[] = [];
  const seen = new Set<string>();

  for (const href of hrefs) {
    if (seen.has(href)) continue;
    seen.add(href);
    const key = makeCacheKey(workingDir, href);
    const hit = cache.get(key);
    if (hit && hit.expireAt > now) {
      out[href] = hit.result;
    } else {
      if (hit) cache.delete(key);
      miss.push(href);
    }
  }

  if (miss.length > 0) {
    const resolved = await resolveWorkspacePathBatch(miss, workingDir, options);
    for (const href of miss) {
      const result = resolved[href] ?? { status: 'none', candidates: [] };
      // Capacity eviction: drop oldest insertion (Map preserves order).
      if (cache.size >= CACHE_CAP) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(makeCacheKey(workingDir, href), { result, expireAt: now + CACHE_TTL_MS });
      out[href] = result;
    }
  }
  return out;
}

/** Test-only: drop all cached entries. */
export function _clearResolveCache(): void {
  cache.clear();
}

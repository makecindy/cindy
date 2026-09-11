/**
 * Workdir File Browser — ignore matcher.
 *
 * Combines two sources to decide whether a path inside `workdir` should be
 * hidden from the file tree:
 *
 *   1. Optional workdir-local ignore file: `.gitignore` first, fallback to `.p4ignore`
 *      (Perforce projects don't have .gitignore; .p4ignore syntax is close
 *      enough that the npm `ignore` package treats it correctly for the
 *      patterns we care about — folder names + extension globs).
 *
 *   2. BUILTIN_IGNORE — never-walk-into directories regardless of vcs config.
 *      Covers the "always huge / always cache" set: VCS, package managers,
 *      Unity build artifacts, Mac/Win OS junk. Real benchmark on Unity client
 *      `Lizi/Client` with this list applied: 698k entries → still
 *      large but tractable for *lazy* (per-folder) reads (<12ms even for the
 *      worst folder).
 *
 * Public API: `loadIgnoreMatcher(workdir)` returns a matcher with one method
 * `ignores(relPath, isDir)`. Path is workdir-relative POSIX (forward slashes),
 * matching `ignore` lib expectations. The renderer never sees this layer —
 * scanner.ts calls it before returning entries.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignoreLib from 'ignore';

import { scopedLogger } from './logging.js';

const log = scopedLogger('file-browser/ignore');

/**
 * Folder names (last path segment) that should never be walked into,
 * regardless of vcs ignore files. Patterns are folder-name-only (no globs)
 * because `ignore` lib treats them as "match anywhere in the path".
 *
 * 分两层,因为「用户看得见的工程目录」和「纯噪音」不是一回事:
 *   - ALWAYS:VCS 元数据与 OS 垃圾 —— 任何设置下都不列、不递归。
 *   - REVEALABLE:依赖 / 构建产物 / 缓存 / IDE 缓存 —— 默认隐藏(Unity 的
 *     Library 之类目录动辄数十万条,默认列出会让文件树不可用),但用户可在
 *     设置里开「显示被忽略的目录」放行。
 */
const BUILTIN_IGNORE_ALWAYS = [
  // VCS metadata: never part of the project's own file tree.
  '.git/',
  '.svn/',
  '.hg/',
  // OS junk
  '.DS_Store',
  'Thumbs.db',
];

const BUILTIN_IGNORE_REVEALABLE = [
  // Package managers
  'node_modules/',
  '__pycache__/',
  'vendor/',
  '.venv/',
  '.cache/',
  // Editor / IDE caches
  '.vs/',
  '.idea/',
  '.vscode-test/',
  // Generic build outputs
  'dist/',
  'build/',
  'out/',
  '.next/',
  'target/',
  'bin/',
  'obj/',
  // Unity-specific (huge caches; .gitignore usually has them but be defensive)
  'Library/',
  'Temp/',
  'Logs/',
  'UserSettings/',
  // Project-internal generated dirs (seen on real Unity workdirs)
  'AssetDepotOutput/',
  'ChuangXiangEditorCache/',
  // .meta files (Unity per-asset metadata) — rendered behind a "show meta"
  // user toggle; defaulting to hidden cuts ~47% of typical Unity entries.
  // Toggle is honored by Matcher.shouldShowMeta below.
  // Note: NOT added here — handled separately because it's user-toggleable
  // per session via `hideMetaFiles`.
];

export interface Matcher {
  /**
   * @param relPath  workdir-relative path with `/` separators, no leading slash
   *                 ('Assets/Scripts/Foo.cs', 'Assets/' for a folder)
   * @param isDir    true if entry is a directory
   * @returns true if the entry should be hidden from the tree
   */
  ignores(relPath: string, isDir: boolean): boolean;
}

const VCS_IGNORE_DISABLED_SOURCE = '__vcs-disabled';

interface CacheEntry {
  matcher: Matcher;
  /** Filename loaded to build the matcher (`.gitignore` / `.p4ignore`); null if neither existed. */
  sourceName: string | null;
  /** mtime of the source file at build time; 0 when no source. */
  sourceMtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Matcher>>();

function cacheKey(
  workdir: string,
  hideMetaFiles: boolean,
  honorVcsIgnore: boolean,
  showIgnoredDirs: boolean,
): string {
  return `${workdir} ${hideMetaFiles ? '1' : '0'} ${honorVcsIgnore ? 'vcs' : 'tree'}${showIgnoredDirs ? ' reveal' : ''}`;
}

/**
 * Build the matcher for one workdir. Reads `.gitignore` if present, else
 * `.p4ignore`. Always layers BUILTIN_IGNORE on top.
 *
 * Cached per (workdir, hideMetaFiles) and deduped via inflight Map: a burst
 * of concurrent LIST_DIR calls (typical right after switching session into
 * a git project — the file tree restores N previously-expanded folders in
 * parallel) only triggers one parse. Without dedup the synchronous
 * `ig.add(raw)` of each rebuild would serialize on the event loop and stall
 * the main process for hundreds of ms on large `.gitignore` files.
 *
 * Cache entries are validated against the source file's mtime, so manual
 * `.gitignore` edits are picked up on the next call after save.
 */
export async function loadIgnoreMatcher(
  workdir: string,
  opts: {
    hideMetaFiles?: boolean;
    honorVcsIgnore?: boolean;
    /**
     * 用户开关「显示被忽略的目录」:true 时放行 BUILTIN_IGNORE_REVEALABLE
     * (依赖 / 构建产物 / 缓存 / IDE 缓存)。默认 false = 保持历史行为。
     * 只影响内置清单,VCS 元数据与 OS 垃圾永远隐藏,`*.meta` 仍由
     * hideMetaFiles 单独决定。
     */
    showIgnoredDirs?: boolean;
  } = {},
): Promise<Matcher> {
  const hideMetaFiles = opts.hideMetaFiles ?? true;
  const honorVcsIgnore = opts.honorVcsIgnore ?? true;
  const showIgnoredDirs = opts.showIgnoredDirs ?? false;
  const key = cacheKey(workdir, hideMetaFiles, honorVcsIgnore, showIgnoredDirs);

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<Matcher> => {
    const cached = cache.get(key);
    if (cached && (await isCacheFresh(workdir, cached))) {
      return cached.matcher;
    }
    const built = await buildMatcher(workdir, hideMetaFiles, honorVcsIgnore, showIgnoredDirs);
    cache.set(key, built);
    return built.matcher;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function isCacheFresh(workdir: string, entry: CacheEntry): Promise<boolean> {
  if (entry.sourceName === VCS_IGNORE_DISABLED_SOURCE) return true;
  // If a higher-priority `.gitignore` has appeared since this entry was built,
  // invalidate regardless of what was originally cached. Covers two transitions:
  //   - sourceName === null  →  any ignore file appeared
  //   - sourceName === '.p4ignore'  →  a `.gitignore` overruled the fallback
  if (entry.sourceName !== '.gitignore') {
    try {
      await fs.stat(path.join(workdir, '.gitignore'));
      return false;
    } catch {
      // .gitignore still absent
    }
  }
  if (entry.sourceName === null) {
    try {
      await fs.stat(path.join(workdir, '.p4ignore'));
      return false;
    } catch {
      // .p4ignore still absent
    }
    return true;
  }
  try {
    const st = await fs.stat(path.join(workdir, entry.sourceName));
    return st.mtimeMs === entry.sourceMtimeMs;
  } catch {
    return false; // source removed → rebuild
  }
}

async function buildMatcher(
  workdir: string,
  hideMetaFiles: boolean,
  honorVcsIgnore: boolean,
  showIgnoredDirs: boolean,
): Promise<CacheEntry> {
  const ig = ignoreLib();
  ig.add(BUILTIN_IGNORE_ALWAYS);
  if (!showIgnoredDirs) ig.add(BUILTIN_IGNORE_REVEALABLE);

  let sourceName: string | null = honorVcsIgnore ? null : VCS_IGNORE_DISABLED_SOURCE;
  let sourceMtimeMs = 0;

  if (honorVcsIgnore) {
    for (const name of ['.gitignore', '.p4ignore']) {
      try {
        const filePath = path.join(workdir, name);
        // stat → read → stat: bracket the read with two stats and only accept
        // the (content, mtime) pair if both stats agree. Either single-stat
        // ordering races on a concurrent write — read-then-stat traps us with
        // (old content + new mtime) so `isCacheFresh` later sees the new mtime
        // already cached and never rebuilds; stat-then-read self-corrects on
        // the next call but still serves stale rules in the interim. The
        // bracketed verify catches the race and we retry. After 3 lost races
        // (pathological hot-write loop) fall back to stat-then-read so the
        // stored mtime is ≤ the content's true mtime — any further edit then
        // strictly exceeds it and triggers a rebuild.
        let raw: string | null = null;
        let mtimeMs = 0;
        for (let attempt = 0; attempt < 3 && raw === null; attempt++) {
          const before = await fs.stat(filePath);
          const content = await fs.readFile(filePath, 'utf8');
          const after = await fs.stat(filePath);
          if (before.mtimeMs === after.mtimeMs) {
            raw = content;
            mtimeMs = after.mtimeMs;
          }
        }
        if (raw === null) {
          const st = await fs.stat(filePath);
          raw = await fs.readFile(filePath, 'utf8');
          mtimeMs = st.mtimeMs;
        }
        ig.add(raw);
        sourceName = name;
        sourceMtimeMs = mtimeMs;
        log.info(`loaded ${name} for ${workdir}`);
        break; // .gitignore wins if both present
      } catch {
        // fall through
      }
    }
  }

  if (hideMetaFiles) {
    // Single rule covers both `Foo.cs.meta` and `Folder.meta`.
    ig.add('*.meta');
  }

  const matcher: Matcher = {
    ignores(relPath: string, isDir: boolean): boolean {
      // `ignore` lib expects directory paths to end with `/` to apply
      // dir-specific patterns ('Library/' should match folder 'Library' but
      // not file 'Library.txt'). Normalize before query.
      const normalized = isDir && !relPath.endsWith('/') ? `${relPath}/` : relPath;
      return ig.ignores(normalized);
    },
  };

  return { matcher, sourceName, sourceMtimeMs };
}

/**
 * Test-only: reset the module-level cache + inflight maps. Production code
 * never needs this — the cache is keyed per (workdir, hideMetaFiles) and
 * `mkdtemp`-based test workdirs already produce unique keys per run, so
 * collisions don't happen by accident. But future tests that construct paths
 * manually (e.g., rename / negative-case scenarios) could otherwise see stale
 * hits left behind by earlier tests in the same file. Calling this in
 * `beforeEach` makes the isolation explicit instead of incidental.
 */
export function __clearCacheForTesting(): void {
  cache.clear();
  inflight.clear();
}

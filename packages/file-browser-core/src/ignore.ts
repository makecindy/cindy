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
import {
  BUILTIN_IGNORE_ALWAYS,
  BUILTIN_IGNORE_REVEALABLE,
  WATCH_ALWAYS_IGNORE,
} from './ignoreNames.js';

// 名单真源在 ignoreNames.ts(desktop renderer 也消费同一份);这里 re-export
// 保持既有 API —— 包内与 daemon 都直接取 WATCH_ALWAYS_IGNORE。
export { WATCH_ALWAYS_IGNORE } from './ignoreNames.js';

const log = scopedLogger('file-browser/ignore');

// 名单定义已搬到 ignoreNames.ts(desktop renderer 也消费同一份);本文件只留
// matcher 逻辑。

export interface Matcher {
  /**
   * @param relPath  workdir-relative path with `/` separators, no leading slash
   *                 ('Assets/Scripts/Foo.cs', 'Assets/' for a folder)
   * @param isDir    true if entry is a directory
   * @returns true if the entry should be hidden from the tree
   */
  ignores(relPath: string, isDir: boolean): boolean;
}

/**
 * 事件侧的恒真过滤层:只吃 BUILTIN_IGNORE_ALWAYS + WATCH_ALWAYS_IGNORE,不读
 * `.gitignore`、不随 showIgnoredDirs 变化。
 *
 * 用途:daemon 的 watcher 需要在「开关打开后仍然不推事件」的方向上兜底 —— 它
 * 没有 desktop 侧的 parcel 预过滤层可用,`fs.watch recursive` 照样把这些目录的
 * 事件推上来,只能自己丢。
 *
 * 目录模式(`Library/`)对 `ignore` 库是「匹配该名字的目录及其全部后代」,且与
 * BUILTIN_IGNORE_* 一样是「路径任意位置命中」,所以 `Assets/Library/x` 也算了
 * (`src/node_modules/a.js` 同理) —— 与文件树的隐藏口径保持一致。
 *
 * 无 workdir 依赖(不读盘),可以当成常量用。
 */
export function createEventIgnoreMatcher(): Matcher {
  const ig = ignoreLib();
  ig.add(BUILTIN_IGNORE_ALWAYS);
  ig.add(WATCH_ALWAYS_IGNORE.map((name) => `${name}/`));
  return {
    ignores(relPath: string, isDir: boolean): boolean {
      const normalized = isDir && !relPath.endsWith('/') ? `${relPath}/` : relPath;
      return ig.ignores(normalized);
    },
  };
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

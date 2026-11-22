/**
 * Main-process V8 compile cache.
 *
 * The main bundle is tens of MB, and V8 compiles it again on every launch; the
 * bootstrap chunk alone takes about 0.4 s. Node's module compile cache lets later
 * launches reuse the previous compilation (measured 390 ms → 25 ms for that chunk).
 *
 * Security boundary: V8 runs the cached bytecode as it is, so whoever can write the
 * cache can run code in the main process. Packaged builds enable it only where the
 * same user can already replace the app's own files: Windows installs under the user
 * profile (the installer default). macOS, Linux and Windows installs in protected
 * directories stay off, because there the cache would bypass the ASAR integrity fuse
 * and, on macOS, lend the app's system permissions. Source runs have no such fuse.
 *
 * Location and lifecycle: `userData/main-compile-cache/<build id>/`. Node adds a
 * per-Node/V8-version subdirectory and keys entries by module file name. After the
 * bootstrap chunk loads, directories of other builds are removed, and all of them
 * when this launch does not use the cache, so at most one build's cache stays on
 * disk. It holds only compiled code, no credentials or user data; a missing, corrupt
 * or rejected entry just means V8 compiles as before.
 *
 * Node writes the cache only on a clean exit. `process.exit()` (the Windows updater's
 * forced quit) and crashes skip it, so the caller flushes once the bundle has loaded;
 * with every entry already cached there is nothing new to write.
 *
 * `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
 */
import { constants, enableCompileCache, flushCompileCache } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('main-compile-cache');

/** Directory under userData that holds one subdirectory per build. */
const CACHE_ROOT_DIR_NAME = 'main-compile-cache';

const { compileCacheStatus } = constants;
const STATUS_NAMES: Record<number, string> = {
  [compileCacheStatus.FAILED]: 'failed',
  [compileCacheStatus.ENABLED]: 'enabled',
  [compileCacheStatus.ALREADY_ENABLED]: 'already-enabled',
  [compileCacheStatus.DISABLED]: 'disabled',
};

/** Facts about the running install that decide whether the cache is allowed. */
export interface MainCompileCacheInstall {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `process.resourcesPath`: the directory holding the app's code. */
  resourcesPath: string;
  homeDir: string;
}

export interface MainCompileCacheOptions extends MainCompileCacheInstall {
  userDataDir: string;
  /** Distinct per build, so a new build never reuses or keeps another build's entries. */
  buildId: string;
}

/** Node's compile cache entry points; tests pass fakes so the test process stays unaffected. */
export interface MainCompileCacheRuntime {
  enableCompileCache(directory: string): { status: number };
  flushCompileCache(): void;
}

/** Controls for the compile cache started at launch. */
export interface MainCompileCache {
  /** Writes modules compiled since launch; Node otherwise writes only on a clean exit. */
  flush(): void;
  /** Removes cache directories this launch does not use. */
  pruneUnused(): Promise<void>;
}

/**
 * Whether the cache adds nobody new who can change the code the main process runs:
 * source runs, or Windows installs whose code sits under the user's own profile.
 */
export function mainCompileCacheAllowed(install: MainCompileCacheInstall): boolean {
  if (!install.isPackaged) return true;
  if (install.platform !== 'win32') return false;
  const relative = path.win32.relative(install.homeDir, install.resourcesPath);
  return relative !== ''
    && relative.split(path.win32.sep)[0] !== '..'
    && !path.win32.isAbsolute(relative);
}

const nodeRuntime: MainCompileCacheRuntime = {
  enableCompileCache: (directory) => enableCompileCache(directory),
  flushCompileCache: () => flushCompileCache(),
};

/**
 * Enables the cache for modules loaded after this call when the install allows it.
 * When it stays off, or `NODE_COMPILE_CACHE` already enabled another directory,
 * flush does nothing and pruning removes every build's directory.
 */
export function startMainCompileCache(
  options: MainCompileCacheOptions,
  runtime: MainCompileCacheRuntime = nodeRuntime,
): MainCompileCache {
  const root = path.join(options.userDataDir, CACHE_ROOT_DIR_NAME);
  let status = 'not-allowed';
  let enabled = false;
  if (mainCompileCacheAllowed(options)) {
    try {
      const result = runtime.enableCompileCache(path.join(root, options.buildId)).status;
      status = STATUS_NAMES[result] ?? String(result);
      enabled = result === compileCacheStatus.ENABLED;
    } catch (error) {
      status = 'failed';
      log.warn('compile cache unavailable', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  // Status only: Node's failure message carries the userData path.
  log.info('compile cache', { status });
  const keep = enabled ? options.buildId : null;

  return {
    flush() {
      if (!enabled) return;
      try {
        runtime.flushCompileCache();
      } catch (error) {
        log.warn('compile cache flush failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    },
    async pruneUnused() {
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch {
        return;
      }
      await Promise.all(names.filter((name) => name !== keep).map(async (name) => {
        try {
          await fs.rm(path.join(root, name), { recursive: true, force: true });
        } catch (error) {
          // Another instance may still be writing it; the next launch retries.
          log.warn('compile cache prune failed', { error: error instanceof Error ? error.name : 'unknown' });
        }
      }));
    },
  };
}

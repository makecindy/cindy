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
 * This gate only decides whether Cindy turns the cache on. `NODE_COMPILE_CACHE` in the
 * launch environment makes Node enable it before any app code runs, in every build and
 * before this module existed; the NODE_OPTIONS fuse does not cover it, and by the time
 * this runs the entry chunks are already loaded, so app code cannot close it. Where the
 * gate says no, that case is logged as a warning for diagnosis.
 *
 * Location and lifecycle: `userData/main-compile-cache/<packaged|source>/<build id>/`,
 * where the build id comes from `mainBundleBuildId`. Node adds a per-Node/V8-version
 * subdirectory and keys entries by module file name, so a build id that missed a chunk
 * change would let stale entries pile up in one directory. A source run and the installed
 * app may share one userData and run at the same time, so each flavor owns its own
 * namespace. After the bootstrap chunk loads, other builds in the own namespace are
 * removed, and all of them when this launch does not use the cache; the other flavor's
 * namespace is never touched. At most one build per flavor stays on disk. It holds only
 * compiled code, no credentials or user data; a missing, corrupt or rejected entry just
 * means V8 compiles as before.
 *
 * Node writes the cache only on a clean exit. `process.exit()` (the Windows updater's
 * forced quit) and crashes skip it, so the caller flushes once the bundle has loaded;
 * with every entry already cached there is nothing new to write.
 *
 * `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
 */
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { constants, enableCompileCache, flushCompileCache, getCompileCacheDir } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('main-compile-cache');

/** Directory under userData that holds one namespace per flavor, each with one directory per build. */
const CACHE_ROOT_DIR_NAME = 'main-compile-cache';

/** Flavor namespaces: the installed app and a source run, which may share a userData. */
const PACKAGED_DIR = 'packaged';
const SOURCE_DIR = 'source';

/**
 * Identifies the main bundle build. Every chunk is named after its content hash, so the
 * set of `.js` names in the bundle directory changes whenever any chunk does, whichever
 * chunk holds the calling code (today a hashed shared chunk, not the fixed `index.js`
 * entry). The version keeps release caches apart. Reading the directory is one small
 * listing before the window exists; if it fails, the id falls back to the version alone.
 */
export function mainBundleBuildId(
  version: string,
  bundleDir: string,
  listFiles: (dir: string) => string[] = (dir) => readdirSync(dir),
): string {
  let names: string[] = [];
  try {
    names = listFiles(bundleDir).filter((name) => name.endsWith('.js')).sort();
  } catch {
    // Keep the version-only id; the cache still works, it just cannot tell rebuilds apart.
  }
  return `${version}-${createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12)}`;
}

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
  /** Directory of a cache that is already on, e.g. from `NODE_COMPILE_CACHE` at launch. */
  getCompileCacheDir(): string | undefined;
  /** Canonical filesystem path with junctions and links resolved; throws when it cannot be read. */
  realpath(target: string): string;
}

/** Controls for the compile cache started at launch. */
export interface MainCompileCache {
  /**
   * What launch did: enabled, already-enabled, disabled, failed, not-allowed, or
   * enabled-by-environment (the install does not allow it, but the launch environment
   * turned it on before app code ran).
   */
  readonly status: string;
  /** Writes modules compiled since launch; Node otherwise writes only on a clean exit. */
  flush(): void;
  /** Removes cache directories this launch does not use. */
  pruneUnused(): Promise<void>;
}

/**
 * Whether the cache adds nobody new who can change the code the main process runs:
 * source runs, or Windows installs whose code sits under the user's own profile.
 * Compares the paths as given; `startMainCompileCache` passes canonical paths.
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
  getCompileCacheDir: () => getCompileCacheDir(),
  realpath: (target) => realpathSync.native(target),
};

/**
 * The install with the paths the allow decision depends on resolved through the filesystem.
 * A protected install launched through a junction under the profile only looks like a
 * per-user install by its lexical path. Returns null when the paths cannot be verified, so
 * the cache stays off.
 */
function canonicalInstall(
  install: MainCompileCacheInstall,
  runtime: MainCompileCacheRuntime,
): MainCompileCacheInstall | null {
  if (!install.isPackaged || install.platform !== 'win32') return install;
  try {
    return { ...install, resourcesPath: runtime.realpath(install.resourcesPath), homeDir: runtime.realpath(install.homeDir) };
  } catch {
    return null;
  }
}

/**
 * Enables the cache for modules loaded after this call when the install allows it.
 * When it stays off, flush does nothing and pruning empties this flavor's namespace.
 * When the launch environment (`NODE_COMPILE_CACHE`) already turned a cache on, that
 * directory may be anywhere, even inside this namespace, so nothing is pruned; on an
 * allowed install it is still flushed, because it is the cache this process uses.
 */
export function startMainCompileCache(
  options: MainCompileCacheOptions,
  runtime: MainCompileCacheRuntime = nodeRuntime,
): MainCompileCache {
  const root = path.join(options.userDataDir, CACHE_ROOT_DIR_NAME);
  const ownRoot = path.join(root, options.isPackaged ? PACKAGED_DIR : SOURCE_DIR);
  let status = 'not-allowed';
  let enabled = false;
  // A cache this launch did not create, at a directory it does not know.
  let preEnabled = false;
  // On an allowed install a pre-enabled cache is the one in use; a disallowed install never adopts it.
  let flushable = false;
  const install = canonicalInstall(options, runtime);
  if (install && mainCompileCacheAllowed(install)) {
    try {
      const result = runtime.enableCompileCache(path.join(ownRoot, options.buildId)).status;
      status = STATUS_NAMES[result] ?? String(result);
      enabled = result === compileCacheStatus.ENABLED;
      preEnabled = result === compileCacheStatus.ALREADY_ENABLED;
      flushable = enabled || preEnabled;
    } catch (error) {
      status = 'failed';
      log.warn('compile cache unavailable', { error: error instanceof Error ? error.name : 'unknown' });
    }
  } else if (runtime.getCompileCacheDir()) {
    // NODE_COMPILE_CACHE at launch: already in use for the entry chunks and cannot be undone here.
    status = 'enabled-by-environment';
    preEnabled = true;
  }
  // Status only, never the directory: it carries the userData path.
  if (status === 'enabled-by-environment') log.warn('compile cache enabled by the launch environment', { status });
  else log.info('compile cache', { status });
  const keep = enabled ? options.buildId : null;

  return {
    status,
    flush() {
      if (!flushable) return;
      try {
        runtime.flushCompileCache();
      } catch (error) {
        log.warn('compile cache flush failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    },
    async pruneUnused() {
      // The environment's cache directory is unknown and may sit inside this namespace.
      if (preEnabled) return;
      // Own namespace: every build except the one this launch uses.
      await removeEntries(ownRoot, (name) => name !== keep);
      // Root: only entries outside both namespaces (layouts from earlier builds of this
      // feature). The other flavor's namespace belongs to an instance that may be running.
      await removeEntries(root, (name) => name !== PACKAGED_DIR && name !== SOURCE_DIR);
    },
  };
}

/** Removes the matching entries of a directory; a missing directory has nothing to remove. */
async function removeEntries(dir: string, shouldRemove: (name: string) => boolean): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter(shouldRemove).map(async (name) => {
    try {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
    } catch (error) {
      // Another instance may still be writing it; the next launch retries.
      log.warn('compile cache prune failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }));
}

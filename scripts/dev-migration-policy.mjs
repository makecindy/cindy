import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRIZZLE_PATH = 'apps/desktop/drizzle';
// Mirrors BRAND_IDENTITY.userDataDirNameByRegion + legacyUserDataDirNames.
// scripts/__tests__/brand-identity-sync.test.mjs prevents drift from the TS source.
export const PROTECTED_USER_DATA_DIR_NAMES = Object.freeze([
  'Cindy',
  'CindyGlobal',
  'CindyDev',
  'xdt-maker',
]);

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function resolveMigrationBaseRef(repoRoot) {
  const baseRef = 'origin/main';
  if (
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      allowFailure: true,
    }).status === 0
  ) {
    return baseRef;
  }
  throw new Error(
    'cannot resolve origin/main; fetch origin before starting shared desktop dev',
  );
}

/** Find committed branch-only and uncommitted migration artifacts. */
export function findUnmergedMigrationArtifacts(repoRoot) {
  const baseRef = resolveMigrationBaseRef(repoRoot);
  const committed = git(repoRoot, [
    'diff',
    '--name-only',
    `${baseRef}...HEAD`,
    '--',
    DRIZZLE_PATH,
  ]).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const workingTree = git(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    DRIZZLE_PATH,
  ]).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    baseRef,
    committed: [...new Set(committed)].sort(),
    workingTree: [...new Set(workingTree)].sort(),
  };
}

export function resolveDesktopUserDataRoot(
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fallbackHome = () => {
    try {
      return homedir();
    } catch {
      return '';
    }
  };
  let root;
  if (platform === 'win32') {
    if (env.APPDATA) {
      root = env.APPDATA;
    } else {
      const home = env.USERPROFILE || fallbackHome();
      root = home ? pathApi.join(home, 'AppData', 'Roaming') : '';
    }
  } else if (platform === 'darwin') {
    const home = env.HOME || fallbackHome();
    root = home ? pathApi.join(home, 'Library', 'Application Support') : '';
  } else if (env.XDG_CONFIG_HOME) {
    root = env.XDG_CONFIG_HOME;
  } else {
    const home = env.HOME || fallbackHome();
    root = home ? pathApi.join(home, '.config') : '';
  }
  if (!root || !pathApi.isAbsolute(root)) {
    throw new Error(
      'cannot resolve an absolute OS userData root; set APPDATA/USERPROFILE on Windows, ' +
        'HOME on macOS, or XDG_CONFIG_HOME/HOME on Linux',
    );
  }
  return root;
}

function defaultSharedUserDataDirs(env, platform, homedir) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const root = resolveDesktopUserDataRoot(env, platform, homedir);
  return PROTECTED_USER_DATA_DIR_NAMES.map((dirName) => pathApi.join(root, dirName));
}

function canonicalUserDataPath(value, { platform, realpath }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let canonical = pathApi.resolve(value);
  try {
    canonical = realpath(canonical);
  } catch {
    // A not-yet-created directory still gets a stable lexical identity.
  }
  return platform === 'win32' || platform === 'darwin'
    ? canonical.toLocaleLowerCase('en-US')
    : canonical;
}

export function userDataOverrideTargetsSharedUserData(
  override,
  env = process.env,
  {
    platform = process.platform,
    realpath = realpathSync.native,
    homedir = os.homedir,
  } = {},
) {
  if (!override?.trim()) return false;
  const options = { platform, realpath };
  const candidate = canonicalUserDataPath(override, options);
  return defaultSharedUserDataDirs(env, platform, homedir).some(
    (shared) => candidate === canonicalUserDataPath(shared, options),
  );
}

function declaresIsolatedUserData(argv, env) {
  return (
    argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated=')) ||
    env.XDT_ISOLATED === '1'
  );
}

export function usesIsolatedUserData(argv, env = process.env, options = {}) {
  const declaredIsolated = declaresIsolatedUserData(argv, env);
  if (!declaredIsolated) return false;
  return !userDataOverrideTargetsSharedUserData(env.XDT_USER_DATA_DIR, env, options);
}

export function usesPassiveUserData(argv, env = process.env) {
  return (
    argv.includes('--passive') ||
    argv.includes('--preserve-running') ||
    env.XDT_SCHEDULER_PASSIVE === '1'
  );
}

/**
 * A primary dev process must never migrate the shared userData directory. The
 * directory may belong to an older packaged release, and a migration from this
 * checkout can make that release unable to open it. Passive previews remain
 * read-only, while isolated dev gets its own migration history.
 *
 * Run this before the restart pipeline stops any existing Cindy instance.
 */
export function assertSharedDevMigrationPolicy(
  _repoRoot,
  argv,
  env = process.env,
  options = {},
) {
  const declaredIsolated = declaresIsolatedUserData(argv, env);
  if (usesIsolatedUserData(argv, env, options)) return;
  // Passive may share release data only when it is not also claiming isolated
  // semantics. The contradictory combination would leave migrations enabled.
  if (!declaredIsolated && usesPassiveUserData(argv, env)) return;
  throw new Error(
    'Primary desktop dev cannot migrate shared Cindy userData because it may upgrade the release database and prevent an older release from opening it.\n' +
      'Restart with --isolated=<name> for writable dev data, or use --passive / --preserve-running for a shared read-only preview.',
  );
}

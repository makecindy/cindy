import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const DRIZZLE_PATH = 'apps/desktop/drizzle';
const SHARED_USER_DATA_DIR_NAME = 'Cindy';

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

function defaultSharedUserDataDir(env, platform) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, SHARED_USER_DATA_DIR_NAME);
  }
  if (platform === 'darwin') {
    return path.join(env.HOME || '', 'Library', 'Application Support', SHARED_USER_DATA_DIR_NAME);
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config');
  return path.join(xdgConfig, SHARED_USER_DATA_DIR_NAME);
}

function canonicalUserDataPath(value, { platform, realpath }) {
  let canonical = path.resolve(value);
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
  } = {},
) {
  if (!override?.trim()) return false;
  const options = { platform, realpath };
  return (
    canonicalUserDataPath(override, options) ===
    canonicalUserDataPath(defaultSharedUserDataDir(env, platform), options)
  );
}

export function usesIsolatedUserData(argv, env = process.env, options = {}) {
  const declaredIsolated =
    argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated=')) ||
    env.XDT_ISOLATED === '1';
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
  if (usesIsolatedUserData(argv, env, options) || usesPassiveUserData(argv, env)) return;
  throw new Error(
    'Primary desktop dev cannot migrate shared Cindy userData because it may upgrade the release database and prevent an older release from opening it.\n' +
      'Restart with --isolated=<name> for writable dev data, or use --passive / --preserve-running for a shared read-only preview.',
  );
}

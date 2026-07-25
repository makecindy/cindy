import { spawnSync } from 'node:child_process';

const DRIZZLE_PATH = 'apps/desktop/drizzle';

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

export function usesIsolatedUserData(argv, env = process.env) {
  return (
    argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated=')) ||
    env.XDT_ISOLATED === '1' ||
    Boolean(env.XDT_USER_DATA_DIR?.trim())
  );
}

export function usesPassiveUserData(argv) {
  return argv.includes('--passive') || argv.includes('--preserve-running');
}

/**
 * A primary dev process must never migrate the shared userData directory. The
 * directory may belong to an older packaged release, and a migration from this
 * checkout can make that release unable to open it. Passive previews remain
 * read-only, while isolated dev gets its own migration history.
 *
 * Run this before the restart pipeline stops any existing Cindy instance.
 */
export function assertSharedDevMigrationPolicy(_repoRoot, argv, env = process.env) {
  if (usesIsolatedUserData(argv, env) || usesPassiveUserData(argv)) return;
  throw new Error(
    'Primary desktop dev cannot migrate shared Cindy userData because it may upgrade the release database and prevent an older release from opening it.\n' +
      'Use pnpm restart:desktop:remote -- --isolated=<name> for dev migrations, or --passive for a shared read-only preview.',
  );
}

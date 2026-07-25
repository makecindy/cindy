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

export function usesIsolatedUserData(argv) {
  return argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='));
}

/**
 * Shared userData may only execute migrations that are already canonical on origin/main.
 * Run this before the restart pipeline stops any existing Cindy instance.
 */
export function assertSharedDevMigrationPolicy(repoRoot, argv) {
  if (usesIsolatedUserData(argv)) return;
  const artifacts = findUnmergedMigrationArtifacts(repoRoot);
  if (artifacts.committed.length === 0 && artifacts.workingTree.length === 0) return;
  const detail = [
    ...artifacts.committed.map((file) => `committed: ${file}`),
    ...artifacts.workingTree.map((line) => `working tree: ${line}`),
  ].join('\n  ');
  throw new Error(
    `Shared Cindy userData cannot run migration artifacts that are not canonical on ${artifacts.baseRef}.\n` +
      `  ${detail}\n` +
      'Rebase and renumber the migration before shared testing, or explicitly use a named sandbox: ' +
      'pnpm restart:desktop:remote -- --isolated=<name>',
  );
}

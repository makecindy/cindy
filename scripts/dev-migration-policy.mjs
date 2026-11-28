import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

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

const journalPath = DRIZZLE_PATH + '/meta/_journal.json';
const pinKey = 'cindy.reviewedMigrationPrefix';
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// A local operator pins the deployed personal layout and the upstream layout
// reviewed alongside it. Neither a branch name nor a file supplied by the branch is an approval.
function matchesReviewedMigrationPrefix(repoRoot, baseRef) {
  const config = git(repoRoot, ['config', '--local', '--no-includes', '--null', '--get-all', pinKey], {
    allowFailure: true,
  });
  if (config.status !== 0) return false;
  const values = config.stdout.split('\0');
  if (values.length !== 2 || values[1] !== '') return false;
  const commits = values[0].split(' ');
  if (commits.length !== 2 || !commits.every(id => commitId.test(id))) return false;
  const [personal, anchor] = commits;
  const run = (...args) => git(repoRoot, args).stdout;
  const [head, upstream] = run('rev-parse', 'HEAD^{commit}', baseRef + '^{commit}').trim().split('\n');
  const ancestor = (a, b) =>
    git(repoRoot, ['merge-base', '--is-ancestor', a, b], { allowFailure: true }).status === 0;
  if (!ancestor(personal, head) || !ancestor(anchor, upstream)) return false;
  if (run('rev-parse', personal + ':' + DRIZZLE_PATH) !== run('rev-parse', head + ':' + DRIZZLE_PATH)) return false;

  const readJournal = commit => JSON.parse(run('show', commit + ':' + journalPath));
  const before = readJournal(anchor);
  const after = readJournal(upstream);
  const last = before.entries.at(-1)?.idx;
  if (!Number.isSafeInteger(last) || last < 0 || readJournal(personal).entries.at(-1)?.idx !== last) return false;
  const prefix = after.entries.slice(0, before.entries.length);
  if (!isDeepStrictEqual(before, { ...after, entries: prefix })) return false;

  const allowedAdds = new Set();
  const requiredSql = new Set();
  for (const [offset, entry] of after.entries.slice(before.entries.length).entries()) {
    const expected = last + offset + 1;
    const number = String(expected).padStart(4, '0');
    if (entry.idx !== expected || typeof entry.tag !== 'string' ||
        !/^\d+_[\w-]+$/.test(entry.tag) || !entry.tag.startsWith(number + '_')) return false;
    const sql = DRIZZLE_PATH + '/' + entry.tag + '.sql';
    requiredSql.add(sql);
    allowedAdds.add(sql);
    allowedAdds.add(DRIZZLE_PATH + '/scripts/' + entry.tag + '.ts');
    allowedAdds.add(DRIZZLE_PATH + '/meta/' + number + '_snapshot.json');
  }

  // With renames disabled, deleting or moving a historical file always leaves a deletion.
  const changes = run(
    'diff', '--raw', '-z', '--no-renames', '--ignore-submodules=none', anchor, upstream, '--', DRIZZLE_PATH,
  ).split('\0');
  for (let i = 0; i < changes.length - 1; i += 2) {
    const [oldMode, mode, , , status] = changes[i].split(' ');
    const file = changes[i + 1];
    if (file === journalPath && status === 'M' && oldMode === ':100644' && mode === '100644') continue;
    if (status !== 'A' || mode !== '100644' || !allowedAdds.has(file)) return false;
    requiredSql.delete(file);
  }
  return requiredSql.size === 0;
}

export function usesIsolatedUserData(argv) {
  return argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='));
}

/**
 * Shared userData requires canonical migrations or an explicitly pinned, previously deployed layout.
 * Run this before the restart pipeline stops any existing Cindy instance.
 */
export function assertSharedDevMigrationPolicy(repoRoot, argv) {
  if (usesIsolatedUserData(argv)) return;
  const artifacts = findUnmergedMigrationArtifacts(repoRoot);
  if (artifacts.committed.length === 0 && artifacts.workingTree.length === 0) return;
  if (artifacts.workingTree.length === 0 && argv.includes('--shared') &&
      matchesReviewedMigrationPrefix(repoRoot, artifacts.baseRef)) return;
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

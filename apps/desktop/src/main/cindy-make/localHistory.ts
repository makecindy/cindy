import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { snapshotContent, PERSONAL_UPSTREAM_REF, type ContentGit } from './sourceContent.js';

export const MAKE_GIT_IDENTITY = [
  '-c',
  'user.name=Cindy Make',
  '-c',
  'user.email=cindy-make@localhost.invalid',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.editor=true',
];
export const historyError = (code: 'dirty' | 'baselineChanged' | 'gitFailed') =>
  Object.assign(new Error(code), { code });
const HASH = /^[0-9a-f]{40,64}$/i;
export async function gitOperationExists(
  git: ContentGit,
  cwd: string,
  name: string,
): Promise<boolean> {
  const file = (await git(['rev-parse', '--path-format=absolute', '--git-path', name], cwd)).trim();
  try {
    await lstat(path.resolve(cwd, file));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function assertNoGitOperation(
  git: ContentGit,
  cwd: string,
  allowMerge = false,
): Promise<void> {
  for (const name of [
    'rebase-merge',
    'rebase-apply',
    'CHERRY_PICK_HEAD',
    ...(allowMerge ? [] : ['MERGE_HEAD']),
  ])
    if (await gitOperationExists(git, cwd, name)) throw historyError('dirty');
  if ((await git(['ls-files', '--unmerged'], cwd)).trim()) throw historyError('dirty');
}
/** Keep original history, staged-only content and working files reachable before any conversion. */
export async function backupLocalHistory(
  git: ContentGit,
  cwd: string,
  id = randomUUID(),
): Promise<{ head: string; tree: string }> {
  const head = (await git(['rev-parse', 'HEAD'], cwd)).trim();
  const tree = await snapshotContent(git, cwd);
  const index = (await git(['write-tree'], cwd)).trim();
  if (![head, tree, index].every((value) => HASH.test(value))) throw historyError('gitFailed');
  const root = 'refs/cindy-make/history-backups/' + id;
  await git(['update-ref', root + '/head', head], cwd);
  await git(['update-ref', root + '/files', tree], cwd);
  await git(['update-ref', root + '/index', index], cwd);
  return { head, tree };
}
/** Called only at explicit completion/integration boundaries; never pushes or creates empty snapshots. */
export async function commitLocalFiles(
  git: ContentGit,
  cwd: string,
  message: string,
  allowMerge = false,
  expectedTree?: string,
): Promise<{ commit: string; tree: string }> {
  await assertNoGitOperation(git, cwd, allowMerge);
  const tree = await snapshotContent(git, cwd);
  if (expectedTree !== undefined && tree !== expectedTree) throw historyError('baselineChanged');
  const before = (await git(['rev-parse', 'HEAD^{tree}'], cwd)).trim();
  const merging = allowMerge && (await gitOperationExists(git, cwd, 'MERGE_HEAD'));
  if (tree !== before || merging) {
    await backupLocalHistory(git, cwd);
    await git(['diff', '--check', before, tree], cwd);
    await git(['add', '--all', '--', '.'], cwd);
    if (
      (await git(['write-tree'], cwd)).trim() !== tree ||
      (await snapshotContent(git, cwd)) !== tree
    )
      throw historyError('baselineChanged');
    await git(
      [
        ...MAKE_GIT_IDENTITY,
        'commit',
        '--signoff',
        '--author=Cindy Make <cindy-make@localhost.invalid>',
        '-m',
        message,
      ],
      cwd,
    );
  }
  const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
  if (
    !HASH.test(commit) ||
    (await git(['rev-parse', 'HEAD^{tree}'], cwd)).trim() !== tree ||
    (await snapshotContent(git, cwd)) !== tree
  )
    throw historyError('baselineChanged');
  return { commit, tree };
}
/** Migrate old file-only integrations: official files become the base, only personal differences are committed. */
export async function commitPersonalFiles(
  git: ContentGit,
  source: string,
): Promise<{ commit: string; tree: string }> {
  await assertNoGitOperation(git, source);
  const recorded = (
    await git(['rev-parse', '--verify', PERSONAL_UPSTREAM_REF + '^{commit}'], source).catch(
      (error) => {
        if ((error as { exitCode?: number }).exitCode === 128) return '';
        throw error;
      },
    )
  ).trim();
  const head = (await git(['rev-parse', 'HEAD'], source)).trim();
  if (recorded && recorded !== head) {
    let basedOnRecorded = true;
    try {
      await git(['merge-base', '--is-ancestor', recorded, head], source);
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode !== 1) throw error;
      basedOnRecorded = false;
    }
    if (!basedOnRecorded) {
      const saved = await backupLocalHistory(git, source);
      if (saved.head !== head) throw historyError('baselineChanged');
      // --mixed deliberately keeps every working file. The old index/history also have durable backup refs.
      await git(['reset', '--mixed', recorded], source);
      if ((await snapshotContent(git, source)) !== saved.tree)
        throw historyError('baselineChanged');
    }
  }
  return commitLocalFiles(git, source, 'Cindy Make: preserve personal changes');
}

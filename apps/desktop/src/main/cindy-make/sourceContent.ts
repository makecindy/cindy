import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A private index is used only for content snapshots, never the user's staging area. */
export type ContentGit = (args: string[], cwd: string, indexFile?: string) => Promise<string>;
export const PERSONAL_UPSTREAM_REF = 'refs/cindy-make/personal-upstream';
export function taskCommitRef(runId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(runId)) throw new Error('Invalid task identity');
  return `refs/cindy-make/tasks/${runId}/complete-commit`;
}
const HASH = /^[0-9a-f]{40,64}$/i;
export function taskContentRef(
  runId: string,
  kind: 'base' | 'complete' | 'integrated' | 'initialized',
): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(runId)) throw new Error('Invalid task identity');
  return `refs/cindy-make/tasks/${runId}/${kind}`;
}

export async function contentRef(
  git: ContentGit,
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const value = (await git(['rev-parse', '--verify', `${ref}^{tree}`], cwd)).trim();
    if (!HASH.test(value)) throw new Error('Invalid content snapshot');
    return value;
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 128) return undefined;
    throw error;
  }
}

/** Includes tracked and non-ignored new files, leaving branch history and the real index untouched. */
export async function snapshotContent(git: ContentGit, cwd: string, ref?: string): Promise<string> {
  if ((await git(['ls-files', '--unmerged'], cwd)).trim())
    throw Object.assign(new Error('Unresolved file conflicts'), { code: 'dirty' });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-content-'));
  try {
    const index = path.join(temporary, 'index');
    const original = (
      await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], cwd)
    ).trim();
    await copyFile(original, index);
    await git(['add', '--all', '--', '.'], cwd, index);
    const tree = (await git(['write-tree'], cwd, index)).trim();
    if (!HASH.test(tree)) throw new Error('Invalid content snapshot');
    // Tree refs keep file contents alive through Git GC without creating any commits.
    if (ref) await git(['update-ref', ref, tree], cwd);
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Populate ONLY a newly-created, disposable worktree with an existing snapshot. */
export async function populateContent(git: ContentGit, cwd: string, tree: string): Promise<void> {
  if (!HASH.test(tree)) throw new Error('Invalid content snapshot');
  await git(['read-tree', '--reset', '-u', tree], cwd);
}

/** Binary patches are files: never pass large diffs through the bounded Git stdout buffer. */
export async function applyContent(
  git: ContentGit,
  cwd: string,
  before: string,
  after: string,
  threeWay = false,
): Promise<void> {
  if (!HASH.test(before) || !HASH.test(after)) throw new Error('Invalid content snapshot');
  if (before === after) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-patch-'));
  try {
    const patch = path.join(temporary, 'changes.patch');
    await git(
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        `--output=${patch}`,
        before,
        after,
        '--',
      ],
      cwd,
    );
    if (!(await stat(patch)).size) return;
    if (threeWay) {
      // Recovery after files were adopted but their receipt was not persisted.
      // Only skip when the entire delta is already present, not merely its branch history.
      try {
        await git(['apply', '--reverse', '--check', '--whitespace=nowarn', patch], cwd);
        return;
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode !== 1) throw error;
      }
      // Conflicts stay in this isolated candidate for explicit resolution.
      await git(['apply', '--3way', '--index', '--whitespace=nowarn', patch], cwd);
    } else {
      // No --reject: Git validates the entire patch before touching any live files.
      await git(['apply', '--check', '--whitespace=nowarn', patch], cwd);
      await git(['apply', '--whitespace=nowarn', patch], cwd);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

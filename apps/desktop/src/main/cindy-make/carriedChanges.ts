import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import type { ContentGit } from './sourceContent.js';

const COMMIT = /^[0-9a-f]{40}$/i;
const IDENTITY_FORMAT = '%an%x00%ae%x00%at%x00%s';
const checksFailed = () => Object.assign(new Error('checksFailed'), { code: 'checksFailed' });

/** A truncated history must not silently omit a change from the preservation check. */
async function listedCommits(git: ContentGit, cwd: string, args: string[]): Promise<string[]> {
  const lines = (await git(['log', ...args], cwd)).split(/\r?\n/).filter(Boolean);
  const count = Number(
    (
      await git(['rev-list', '--count', ...args.filter((arg) => !arg.startsWith('--format='))], cwd)
    ).trim(),
  );
  if (!Number.isSafeInteger(count) || count !== lines.length) throw checksFailed();
  return lines;
}

/** Reapplying the original three-tree change must leave the checked tree unchanged. */
async function alreadyCarried(
  git: ContentGit,
  cwd: string,
  base: string,
  commit: string,
  result: string,
  resultTree: string,
): Promise<boolean> {
  if (!COMMIT.test(resultTree)) return false;
  try {
    const merged = await git(
      ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, result, commit],
      cwd,
    );
    return merged.split(/\r?\n/)[0]?.trim() === resultTree;
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 1) return false;
  }
  // Older Git has no merge-tree --merge-base. read-tree compares the original
  // blobs and modes at their actual paths, without fuzzy patch placement. It
  // cannot prove every text merge; an ambiguous result goes to user review.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-carried-'));
  try {
    const index = path.join(temporary, 'index');
    await git(['read-tree', '-m', base, result, commit], cwd, index);
    if ((await git(['ls-files', '--unmerged'], cwd, index)).trim()) return false;
    return (await git(['write-tree'], cwd, index)).trim() === resultTree;
  } catch {
    return false;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Changes missing from the adopted result. Identity only locates a possible
 * rewrite: its original, position-aware tree change must be present there too.
 * Neither patch-id (which drops hunk positions) nor words surviving somewhere in
 * a file prove that an edit kept its target or its execution conditions.
 */
export async function uncarriedChanges(
  git: ContentGit,
  cwd: string,
  replayed: string,
  onto: string,
  result: string,
): Promise<string[]> {
  if (!COMMIT.test(replayed) || !COMMIT.test(onto) || !COMMIT.test(result)) throw checksFailed();
  const sides = `${result}...${replayed}`;
  const candidates = await listedCommits(git, cwd, [
    '--right-only',
    '--no-merges',
    `--format=%H%x00${IDENTITY_FORMAT}`,
    sides,
  ]);
  const resultTree = (await git(['rev-parse', `${result}^{tree}`], cwd)).trim();
  if (!COMMIT.test(resultTree)) throw checksFailed();
  const missing: string[] = [];
  type Voucher = { commit: string; key: string; used: boolean };
  const vouchers = new Map<string, Voucher[]>();
  for (const line of candidates) {
    const [commit, ...fields] = line.split('\0');
    if (!COMMIT.test(commit) || fields.length !== 4) throw checksFailed();
    if (await alreadyCarried(git, cwd, `${commit}^`, commit, result, resultTree)) continue;
    const key = fields.join('\0');
    const email = fields[1];
    let pool = vouchers.get(email);
    if (!pool) {
      pool = [];
      for (const line of await listedCommits(git, cwd, [
        '--left-only',
        '--no-merges',
        '--fixed-strings',
        `--author=<${email}>`,
        `--format=%H%x00${IDENTITY_FORMAT}`,
        sides,
      ])) {
        const [hash, ...identity] = line.split('\0');
        if (!COMMIT.test(hash) || identity.length !== 4) throw checksFailed();
        pool.push({ commit: hash, key: identity.join('\0'), used: false });
      }
      vouchers.set(email, pool);
    }
    let vouched = false;
    for (const voucher of pool) {
      if (voucher.used || voucher.key !== key) continue;
      const tree = (await git(['rev-parse', `${voucher.commit}^{tree}`], cwd)).trim();
      if (!(await alreadyCarried(git, cwd, `${commit}^`, commit, voucher.commit, tree))) continue;
      // A later personal change may intentionally supersede an earlier one. Its
      // corresponding replay commit can prove that the earlier edit was applied,
      // but one commit must never vouch for two same-identity changes.
      voucher.used = true;
      vouched = true;
      break;
    }
    if (!vouched) missing.push(commit);
  }
  const merges = await listedCommits(git, cwd, [
    '--merges',
    '--format=%H',
    `${result}..${replayed}`,
  ]);
  for (const merge of merges) {
    if (!COMMIT.test(merge)) throw checksFailed();
    if (
      !(
        await git(
          [
            'show',
            '--remerge-diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--format=',
            '--name-only',
            merge,
          ],
          cwd,
        )
      ).trim()
    )
      continue;
    if (!(await alreadyCarried(git, cwd, `${merge}^1`, merge, result, resultTree)))
      missing.push(merge);
  }
  return missing;
}

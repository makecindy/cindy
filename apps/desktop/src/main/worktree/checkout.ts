import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { gitExec, GitExecError } from './gitExec';
import { fetchCheckoutSource, withBranchMutation } from './branchSync';
import type {
  CheckoutStatus,
  CheckoutSession,
  CheckoutResult,
  CheckoutReceipt,
  CheckoutBlock,
} from '../../shared/worktreeCheckout';

export interface CheckoutActivity extends CheckoutSession {
  workDir: string;
  remoteHostId?: string | null;
}
type Receipt = CheckoutReceipt & { repo: string; head: string; stash?: string };
const readOpts = { timeoutMs: 5_000, extraEnv: { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } };
const writeOpts = { extraEnv: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } };
const stashPrefix = ' [cindy-checkout-v1:';
const inside = (root: string, dir: string) => {
  const rel = path.relative(root, dir);
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const git = async (repo: string, ...args: string[]) =>
  (await gitExec(args, repo, readOpts)).stdout.trim();
const write = async (repo: string, ...args: string[]) => {
  await gitExec(args, repo, writeOpts);
};
async function optional(repo: string, ...args: string[]) {
  try {
    return await git(repo, ...args);
  } catch (e) {
    if (e instanceof GitExecError && e.exitCode !== null && !e.timedOut) return undefined;
    throw e;
  }
}
const localBranch = (branch: string) => branch.replace(/^refs\/remotes\/origin\//, '');

/** Checkout owns no preference or database state. Saved changes remain reachable in refs/stash. */
export function createCheckoutService(listActivity: () => Promise<CheckoutActivity[]>) {
  const receipts = new Map<string, Receipt>();
  const active = new Set<string>();
  async function root(input: string) {
    const repo = await fs.realpath(input);
    const top = await fs.realpath(await git(repo, 'rev-parse', '--show-toplevel'));
    const common = await fs.realpath(
      await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    );
    const own = await fs.realpath(await git(repo, 'rev-parse', '--absolute-git-dir'));
    if (repo !== top || common !== own) throw new Error('Checkout requires the main checkout');
    return repo;
  }
  async function stashes(repo: string) {
    const output = await git(repo, 'stash', 'list', '--format=%H%x00%gs');
    const result: Array<{ id: string; branch: string }> = [];
    for (const line of output.split('\n')) {
      const [id, subject] = line.split('\0');
      const at = subject?.indexOf(stashPrefix) ?? -1;
      if (at < 0) continue;
      try {
        const saved = JSON.parse(
          Buffer.from(subject.slice(at + stashPrefix.length, -1), 'base64url').toString('utf8'),
        );
        if (saved.repo === repo && typeof saved.branch === 'string')
          result.push({ id, branch: saved.branch });
      } catch {
        /* Unrelated user stash. */
      }
    }
    return result;
  }
  async function status(input: string, target?: string, ownLock = false): Promise<CheckoutStatus> {
    const repo = await root(input);
    if (target) await git(repo, 'check-ref-format', '--branch', localBranch(target));
    const head = await git(repo, 'rev-parse', 'HEAD');
    const current = (await optional(repo, 'symbolic-ref', '--short', 'HEAD')) ?? head;
    const treeOutput = (await gitExec(['worktree', 'list', '--porcelain', '-z'], repo, readOpts))
      .stdout;
    const trees = await Promise.all(
      treeOutput
        .split('\0\0')
        .filter(Boolean)
        .map(async (block) => {
          const fields = block.split('\0');
          const dir = fields.find((x) => x.startsWith('worktree '))!.slice(9);
          // A prunable checkout still occupies its branch, but has no running sessions.
          const physical = await fs.realpath(dir).catch(() => path.resolve(dir));
          return {
            dir: physical,
            branch: fields.find((x) => x.startsWith('branch refs/heads/'))?.slice(18),
          };
        }),
    );
    const occupied = trees.filter((t) => t.dir !== repo && t.branch).map((t) => t.branch!);
    const porcelain = (
      await gitExec(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
        repo,
        readOpts,
      )
    ).stdout;
    const fields = porcelain.split('\0');
    const files: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      if (!fields[i]) continue;
      files.push(fields[i].slice(3));
      if (/[RC]/.test(fields[i].slice(0, 2))) i++;
    }
    const hash = createHash('sha256').update(head).update(porcelain);
    hash.update(
      (await gitExec(['diff', '--cached', '--raw', '-z', 'HEAD', '--'], repo, readOpts)).stdout,
    );
    // Include untracked bytes: a confirmation must not silently include subsequently edited files.
    for (const file of files) {
      const full = path.join(repo, file);
      const stat = await fs.lstat(full).catch(() => null);
      if (stat?.isSymbolicLink()) hash.update(await fs.readlink(full));
      else if (stat?.isFile()) {
        for await (const chunk of createReadStream(full)) hash.update(chunk);
      }
    }
    let blocked: CheckoutBlock | undefined = fields.some((row) => /^(?:.U|U.|AA|DD) /.test(row))
      ? 'operation'
      : undefined;
    const gitDir = await git(repo, 'rev-parse', '--absolute-git-dir');
    for (const marker of [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-apply',
      'rebase-merge',
      'sequencer',
      'BISECT_LOG',
    ]) {
      if (
        await fs.stat(path.join(gitDir, marker)).then(
          () => true,
          () => false,
        )
      )
        blocked = 'operation';
    }
    if (!blocked && target && occupied.includes(localBranch(target))) blocked = 'occupied';
    let carryAllowed = true;
    if (target) {
      const targetRef = target.startsWith('refs/remotes/origin/') ? target : `refs/heads/${target}`;
      const commit = await optional(repo, 'rev-parse', '--verify', `${targetRef}^{commit}`);
      if (!commit) blocked ??= 'missing';
      else if (files.length) {
        try {
          // Git's two-tree merge accounts for index contents, working files and
          // untracked collisions. In particular, staged content already matching
          // the target is safe even though the same path changed between branches.
          await gitExec(['read-tree', '-m', '-u', '-n', 'HEAD', commit], repo, readOpts);
          // read-tree permits ignored files to be overwritten, unlike our switch
          // --no-overwrite-ignore. Keep that additional protection in the preview.
          const ignored = (
            await gitExec(
              ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
              repo,
              readOpts,
            )
          ).stdout
            .split('\0')
            .filter(Boolean)
            .map((file) => file.replace(/\/$/, ''));
          if (ignored.length) {
            const changes = (
              await gitExec(['diff', '--name-only', '-z', 'HEAD', commit, '--'], repo, readOpts)
            ).stdout
              .split('\0')
              .filter(Boolean);
            carryAllowed = !ignored.some((a) =>
              changes.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)),
            );
          }
        } catch {
          // A failed or indeterminate dry-run must not enable the carry action.
          carryAllowed = false;
        }
      }
    }
    const sessions: CheckoutSession[] = [];
    for (const s of await listActivity()) {
      if (s.remoteHostId) continue;
      const dir = await fs.realpath(s.workDir).catch(() => null);
      if (!dir || !inside(repo, dir)) continue;
      const owner = trees
        .filter((t) => inside(t.dir, dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (owner?.dir === repo) sessions.push({ id: s.id, name: s.name, running: s.running });
    }
    if (sessions.some((s) => s.running) || (!ownLock && active.has(repo))) blocked = 'busy';
    return {
      current,
      head,
      files,
      fingerprint: hash.digest('hex'),
      sessions,
      occupied,
      blocked,
      carryAllowed,
      stashes: (await stashes(repo)).filter((s) => s.branch === current),
    };
  }
  async function applyStash(repo: string, id: string) {
    // Apply first, drop only after success; conflicts always leave the named stash recoverable.
    await write(repo, 'stash', 'apply', '--index', id);
    const ids = (await git(repo, 'stash', 'list', '--format=%H')).split('\n');
    const index = ids.indexOf(id);
    if (index >= 0) await write(repo, 'stash', 'drop', `stash@{${index}}`);
  }
  async function locked<T>(repo: string, fn: () => Promise<T>) {
    if (active.has(repo)) throw new Error('Checkout already running');
    active.add(repo);
    try {
      return await withBranchMutation(repo, fn);
    } finally {
      active.delete(repo);
    }
  }
  // The service lock is excluded from its own preflight, while competing callers remain blocked.
  async function preflight(repo: string, target?: string) {
    return status(repo, target, true);
  }
  return {
    status,
    async switch(
      input: string,
      branch: string,
      expected: string,
      fingerprint: string,
      strategy: 'carry' | 'stash',
      assertScope: () => void = () => {},
    ): Promise<CheckoutResult> {
      const repo = await root(input);
      return locked(repo, async () => {
        let before = await preflight(repo, branch);
        if (before.blocked) return { status: before, blocked: before.blocked };
        if (before.current !== expected || before.fingerprint !== fingerprint)
          return { status: before, blocked: 'changed' };
        const target = localBranch(branch);
        if (branch.startsWith('refs/remotes/origin/')) {
          assertScope();
          const fetched = await fetchCheckoutSource({ baseRepo: repo, branch });
          if (fetched.status.blocked) return { status: before, blocked: 'git' };
          const local = await optional(
            repo,
            'rev-parse',
            '--verify',
            `refs/heads/${target}^{commit}`,
          );
          const remote = await git(repo, 'rev-parse', branch);
          if (local) {
            const counts = (
              await git(repo, 'rev-list', '--left-right', '--count', `${local}...${remote}`)
            )
              .split(/\s+/)
              .map(Number);
            if (counts[0] && counts[1]) return { status: before, blocked: 'diverged' };
          }
        }
        // Fetch can take time: recheck all sessions and the checkout immediately before writing.
        before = await preflight(repo, branch);
        if (before.blocked) return { status: before, blocked: before.blocked };
        if (before.current !== expected || before.fingerprint !== fingerprint)
          return { status: before, blocked: 'changed' };
        if (strategy === 'carry' && !before.carryAllowed)
          return { status: before, blocked: 'conflict' };
        assertScope();
        let stash: string | undefined;
        if (strategy === 'stash' && before.files.length) {
          const previousStash = await optional(repo, 'rev-parse', '--verify', 'refs/stash');
          await write(
            repo,
            'stash',
            'push',
            '--include-untracked',
            '--message',
            `Cindy: before switching to ${target}${stashPrefix}${Buffer.from(JSON.stringify({ repo, branch: before.current })).toString('base64url')}]`,
          );
          stash = await optional(repo, 'rev-parse', '--verify', 'refs/stash');
          const saved = await preflight(repo, branch);
          // Git does not stash modified submodule contents. Never mistake an older
          // stash for this operation, or carry leftover files after choosing 'stash'.
          if (
            !stash ||
            stash === previousStash ||
            saved.files.length ||
            saved.blocked ||
            saved.current !== before.current
          )
            return { status: saved, blocked: saved.blocked ?? 'changed' };
        }
        assertScope();
        let partialFailure = false;
        try {
          if (
            branch.startsWith('refs/remotes/origin/') &&
            !(await optional(repo, 'rev-parse', '--verify', `refs/heads/${target}^{commit}`))
          ) {
            await write(repo, 'switch', '--no-overwrite-ignore', '-c', target, '--track', branch);
          } else {
            await write(repo, 'switch', '--no-overwrite-ignore', target);
          }
          if (branch.startsWith('refs/remotes/origin/')) {
            assertScope();
            await write(
              repo,
              'merge',
              '--ff-only',
              '--no-autostash',
              '--no-overwrite-ignore',
              branch,
            );
          }
        } catch {
          const current = await optional(repo, 'symbolic-ref', '--short', 'HEAD');
          if (current === before.current) {
            // Only compensate on the original branch. Apply never drops the stash on conflict.
            if (stash) await applyStash(repo, stash).catch(() => undefined);
            return { status: await preflight(repo), blocked: 'git' };
          }
          if (current !== target) return { status: await preflight(repo), blocked: 'changed' };
          // Checkout succeeded but a later fast-forward failed. Keep a usable undo receipt.
          partialFailure = true;
        }
        const receipt: Receipt = {
          id: randomUUID(),
          repo,
          from: before.current,
          head: before.head,
          to: target,
          strategy,
          hadChanges: !!before.files.length,
          stash,
          sessions: before.sessions,
        };
        receipts.set(receipt.id, receipt);
        return {
          status: await preflight(repo),
          receipt,
          ...(partialFailure ? { blocked: 'git' as const } : {}),
        };
      });
    },
    async undo(
      input: string,
      id: string,
      assertScope: () => void = () => {},
    ): Promise<CheckoutResult> {
      const repo = await root(input);
      return locked(repo, async () => {
        const receipt = receipts.get(id);
        const before = await preflight(repo);
        if (!receipt || receipt.repo !== repo || before.current !== receipt.to)
          return { status: before, blocked: 'changed' };
        if (before.blocked) return { status: before, blocked: before.blocked };
        if (receipt.stash && before.files.length) return { status: before, blocked: 'dirty' };
        if (before.occupied.includes(receipt.from)) return { status: before, blocked: 'occupied' };
        if (receipt.stash && !(await stashes(repo)).some((s) => s.id === receipt.stash))
          return { status: before, blocked: 'changed' };
        assertScope();
        const detached = receipt.from === receipt.head;
        await write(
          repo,
          'switch',
          '--no-overwrite-ignore',
          ...(detached ? ['--detach', receipt.head] : [receipt.from]),
        );
        try {
          if (receipt.stash) await applyStash(repo, receipt.stash);
        } catch {
          return { status: await preflight(repo), blocked: 'git', undoApplied: true };
        }
        receipts.delete(id);
        return { status: await preflight(repo), undoApplied: true };
      });
    },
    async restore(
      input: string,
      id: string,
      expected: string,
      assertScope: () => void = () => {},
    ): Promise<CheckoutResult> {
      const repo = await root(input);
      return locked(repo, async () => {
        const before = await preflight(repo);
        if (before.blocked) return { status: before, blocked: before.blocked };
        if (before.current !== expected || !before.stashes.some((s) => s.id === id))
          return { status: before, blocked: 'changed' };
        if (before.files.length) return { status: before, blocked: 'dirty' };
        assertScope();
        await applyStash(repo, id);
        return { status: await preflight(repo) };
      });
    },
  };
}

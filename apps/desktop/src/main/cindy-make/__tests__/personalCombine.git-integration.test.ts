import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  applyUpstreamMerge,
  cancelUpstreamMerge,
  mergeWorktree,
  preparePersonalCombine,
} from '../upstreamMerge';
import { PERSONAL_TRACKING_REF } from '../personalRemote';
import { PERSONAL_UPSTREAM_REF } from '../sourceContent';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';

/**
 * Official repository, the user's fork and two computers that each changed the
 * shared personal version on the same official base.
 */
/**
 * `generic`: personal commits use Cindy Make's shared task identity and message, as
 * real task commits do, so only the author time tells them apart.
 */
async function fixture(sameFile: boolean, generic = false) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-personal-combine-'));
  const source = makeSourceCheckoutPath(userData);
  const official = path.join(userData, 'official');
  const fork = path.join(userData, 'fork.git');
  const other = path.join(userData, 'other');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[], cwd: string, indexFile?: string) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args,
      cwd,
      AbortSignal.timeout(30_000),
    );
  const commit = async (cwd: string, message: string) => {
    const task = generic && !message.startsWith('official');
    await git(['add', '.'], cwd);
    await git(
      [
        '-c',
        `user.name=${task ? 'Cindy Make' : 'Test'}`,
        '-c',
        `user.email=${task ? 'cindy-make@localhost.invalid' : 'test@example.invalid'}`,
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-s',
        '-m',
        task ? 'Cindy Make: complete personal change' : message,
      ],
      cwd,
    );
  };
  const clean = () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    await mkdir(official);
    await mkdir(path.dirname(source), { recursive: true });
    await git(['init', '--initial-branch=main'], official);
    await writeFile(path.join(official, 'feature.txt'), 'base\n');
    await writeFile(path.join(official, 'other.txt'), 'other base\n');
    await commit(official, 'official base');
    const base = (await git(['rev-parse', 'HEAD'], official)).trim();
    await git(['clone', '--bare', official, fork], userData);
    await git(['clone', official, source], userData);
    await git(['checkout', '-b', 'cindy-personal'], source);
    await git(['update-ref', PERSONAL_UPSTREAM_REF, base], source);
    await writeFile(path.join(source, 'shared.txt'), 'shared personal change\n');
    await commit(source, 'shared personal change');
    await git(['push', fork, 'cindy-personal'], source);

    // The other computer uploads its change first.
    await git(['clone', '--branch', 'cindy-personal', fork, other], userData);
    await writeFile(
      path.join(other, sameFile ? 'feature.txt' : 'other.txt'),
      'from the other computer\n',
    );
    await commit(other, 'other computer change');
    await git(['push', 'origin', 'cindy-personal'], other);
    const remoteTip = (await git(['rev-parse', 'HEAD'], other)).trim();

    // This computer changed the same (or a different) file meanwhile.
    await writeFile(path.join(source, 'feature.txt'), 'from this computer\n');
    await commit(source, 'this computer change');
    const local = (await git(['rev-parse', 'HEAD'], source)).trim();
    // What the last sync fetched from the fork.
    await git(['fetch', fork, `+refs/heads/cindy-personal:${PERSONAL_TRACKING_REF}`], source);
    const main = (await git(['rev-parse', 'main'], source)).trim();

    const state: CindyMakeMergeState = {
      id: randomUUID(),
      status: 'merging',
      ref: 'github',
      upstreamCommit: remoteTip,
      remote: { base },
    };
    return { userData, source, git, clean, state, base, remoteTip, local, main };
  } catch (error) {
    await clean();
    throw error;
  }
}

it('keeps both computers’ changes through a conflict resolved in the isolated candidate', async () => {
  const h = await fixture(true);
  try {
    const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
    expect(result).toMatchObject({
      status: 'conflict',
      strategy: 'combine',
      remote: { base: h.base },
    });
    // Nothing moved on this computer while the conflict waits.
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(h.local);
    expect((await h.git(['rev-parse', 'main'], h.source)).trim()).toBe(h.main);
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('from this computer\n');
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');

    // The resolution task combines both sides and finishes the rebase.
    const worktree = mergeWorktree(h.userData, h.state.id);
    expect(await h.git(['diff', '--name-only', '--diff-filter=U'], worktree)).toContain(
      'feature.txt',
    );
    await writeFile(
      path.join(worktree, 'feature.txt'),
      'from the other computer\nfrom this computer\n',
    );
    await h.git(['add', '.'], worktree);
    await h.git(
      [
        '-c',
        'user.name=Cindy Make',
        '-c',
        'user.email=cindy-make@localhost.invalid',
        '-c',
        'core.editor=true',
        '-c',
        'commit.gpgSign=false',
        'rebase',
        '--continue',
      ],
      worktree,
    );
    const applied = await applyUpstreamMerge(h.userData, result, h.git);
    expect(applied.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      'from the other computer\nfrom this computer\n',
    );
    expect(await readFile(path.join(h.source, 'shared.txt'), 'utf8')).toBe(
      'shared personal change\n',
    );
    // The GitHub version is contained, the official base and main are unchanged.
    await h.git(['merge-base', '--is-ancestor', h.remoteTip, 'cindy-personal'], h.source);
    expect((await h.git(['rev-parse', PERSONAL_UPSTREAM_REF], h.source)).trim()).toBe(h.base);
    expect((await h.git(['rev-parse', 'main'], h.source)).trim()).toBe(h.main);
    // This computer's previous version stays recoverable.
    expect(
      (
        await h.git(['rev-parse', `refs/cindy-make/backups/${h.state.id}/personal`], h.source)
      ).trim(),
    ).toBe(h.local);
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 60_000);

it('adopts a combine without overlapping edits directly', async () => {
  const h = await fixture(false);
  try {
    const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('from this computer\n');
    expect(await readFile(path.join(h.source, 'other.txt'), 'utf8')).toBe(
      'from the other computer\n',
    );
    expect((await h.git(['rev-parse', 'cindy-personal^'], h.source)).trim()).toBe(h.remoteTip);
    expect((await h.git(['rev-parse', PERSONAL_UPSTREAM_REF], h.source)).trim()).toBe(h.base);
  } finally {
    await h.clean();
  }
}, 60_000);

it('refuses a GitHub version other than the one the last sync fetched', async () => {
  const h = await fixture(true);
  try {
    await expect(
      preparePersonalCombine(
        h.userData,
        { ...h.state, upstreamCommit: h.local },
        h.git,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'baselineChanged' });
    await expect(stat(mergeWorktree(h.userData, h.state.id))).rejects.toBeTruthy();
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(h.local);
  } finally {
    await h.clean();
  }
}, 60_000);

it('cancels a conflicting combine and leaves this computer exactly as it was', async () => {
  const h = await fixture(true);
  try {
    const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('conflict');
    await cancelUpstreamMerge(h.userData, result, h.git);
    await expect(stat(mergeWorktree(h.userData, h.state.id))).rejects.toBeTruthy();
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(h.local);
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('from this computer\n');
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 60_000);

/** One computer already moved its personal version to a newer official release. */
async function versionsFixture(newer: 'remote' | 'local') {
  const h = await fixture(false);
  const official = path.join(h.userData, 'official');
  const other = path.join(h.userData, 'other');
  const fork = path.join(h.userData, 'fork.git');
  const commit = async (cwd: string, message: string) => {
    await h.git(['add', '.'], cwd);
    await h.git(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message],
      cwd,
    );
  };
  await writeFile(path.join(official, 'release.txt'), 'official 2\n');
  await commit(official, 'official release 2');
  const newerBase = (await h.git(['rev-parse', 'HEAD'], official)).trim();
  const rebaseOnto = async (cwd: string) => {
    await h.git(['fetch', official, 'main'], cwd);
    await h.git(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'rebase',
        '--onto',
        newerBase,
        h.base,
      ],
      cwd,
    );
  };
  if (newer === 'remote') {
    // The other computer updated to release 2 and uploaded.
    await rebaseOnto(other);
    await h.git(['push', '--force', 'origin', 'cindy-personal'], other);
  } else {
    // This computer updated to release 2 first.
    await rebaseOnto(h.source);
    await h.git(['update-ref', PERSONAL_UPSTREAM_REF, newerBase], h.source);
  }
  await h.git(['fetch', fork, `+refs/heads/cindy-personal:${PERSONAL_TRACKING_REF}`], h.source);
  const remoteTip = (await h.git(['rev-parse', PERSONAL_TRACKING_REF], h.source)).trim();
  const local = (await h.git(['rev-parse', 'HEAD'], h.source)).trim();
  const state: CindyMakeMergeState = {
    id: randomUUID(),
    status: 'merging',
    ref: 'github',
    upstreamCommit: remoteTip,
    remote: { base: newer === 'remote' ? newerBase : h.base, commit: remoteTip },
  };
  return { ...h, state, newerBase, remoteTip, local };
}

it.each(['remote', 'local'] as const)(
  'combines when the %s side is on the newer official version, keeping every change once',
  async (newer) => {
    const h = await versionsFixture(newer);
    try {
      const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
      expect(result).toMatchObject({
        status: 'merged',
        upstreamCommit: newer === 'remote' ? h.remoteTip : h.local,
        remote: { base: h.newerBase, commit: h.remoteTip },
      });
      for (const [file, content] of [
        ['feature.txt', 'from this computer\n'],
        ['other.txt', 'from the other computer\n'],
        ['shared.txt', 'shared personal change\n'],
        ['release.txt', 'official 2\n'],
      ])
        expect(await readFile(path.join(h.source, file), 'utf8')).toBe(content);
      // The side on the newer version is kept as is; the official base is that version.
      await h.git(
        ['merge-base', '--is-ancestor', newer === 'remote' ? h.remoteTip : h.local, 'HEAD'],
        h.source,
      );
      expect((await h.git(['rev-parse', PERSONAL_UPSTREAM_REF], h.source)).trim()).toBe(
        h.newerBase,
      );
      // The shared personal change is not duplicated.
      const personal = (
        await h.git(['log', '--format=%s', `${h.newerBase}..HEAD`], h.source)
      ).trim();
      expect(personal.split('\n').filter((line) => line === 'shared personal change')).toHaveLength(
        1,
      );
    } finally {
      await h.clean();
    }
  },
  60_000,
);

it.each([false, true])(
  'refuses to adopt a combine that dropped one side’s change (task identity: %s)',
  async (generic) => {
    const h = await fixture(true, generic);
    try {
      const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
      expect(result.status).toBe('conflict');
      const worktree = mergeWorktree(h.userData, h.state.id);
      // The resolver skips this computer's conflicting change instead of combining it.
      await h.git(['-c', 'core.editor=true', 'rebase', '--skip'], worktree);
      await expect(applyUpstreamMerge(h.userData, result, h.git)).rejects.toMatchObject({
        code: 'checksFailed',
      });
      // Nothing was adopted; the candidate stays for the task.
      expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(h.local);
      expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
        'from this computer\n',
      );
      await expect(stat(worktree)).resolves.toBeTruthy();
    } finally {
      await h.clean();
    }
  },
  60_000,
);

it('adopts a resolved conflict between commits that share the task identity', async () => {
  const h = await fixture(true, true);
  try {
    const result = await preparePersonalCombine(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, h.state.id);
    await writeFile(
      path.join(worktree, 'feature.txt'),
      'from the other computer\nfrom this computer\n',
    );
    await h.git(['add', '.'], worktree);
    await h.git(
      [
        '-c',
        'user.name=Cindy Make',
        '-c',
        'user.email=cindy-make@localhost.invalid',
        '-c',
        'core.editor=true',
        '-c',
        'commit.gpgSign=false',
        'rebase',
        '--continue',
      ],
      worktree,
    );
    await expect(applyUpstreamMerge(h.userData, result, h.git)).resolves.toMatchObject({
      status: 'merged',
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('adopts a combine whose replayed change was already present on the kept side', async () => {
  const h = await fixture(false, true);
  try {
    // The other computer already has this computer's exact edit, made as its own commit.
    const other = path.join(h.userData, 'other');
    await writeFile(path.join(other, 'feature.txt'), 'from this computer\n');
    await h.git(['add', '.'], other);
    await h.git(
      [
        '-c',
        'user.name=Other',
        '-c',
        'user.email=other@example.invalid',
        'commit',
        '-m',
        'same edit, written differently on the other computer',
      ],
      other,
    );
    await h.git(['push', 'origin', 'cindy-personal'], other);
    const fork = path.join(h.userData, 'fork.git');
    await h.git(['fetch', fork, `+refs/heads/cindy-personal:${PERSONAL_TRACKING_REF}`], h.source);
    const remoteTip = (await h.git(['rev-parse', PERSONAL_TRACKING_REF], h.source)).trim();
    const result = await preparePersonalCombine(
      h.userData,
      { ...h.state, upstreamCommit: remoteTip, remote: { base: h.base, commit: remoteTip } },
      h.git,
      async () => {},
    );
    expect(result.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('from this computer\n');
  } finally {
    await h.clean();
  }
}, 60_000);

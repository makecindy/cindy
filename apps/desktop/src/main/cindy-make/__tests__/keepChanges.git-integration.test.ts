import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  applyUpstreamMerge,
  mergeWorktree,
  preparePersonalCombine,
  prepareUpstreamMerge,
  uncarriedChanges,
  type MergeGit,
} from '../upstreamMerge';
import { PERSONAL_TRACKING_REF } from '../personalRemote';
import { PERSONAL_UPSTREAM_REF } from '../sourceContent';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';

/**
 * Neither an official update nor a combine may lose a personal change unnoticed:
 * every replayed change must be in the adopted result, or the user decides.
 */
const LINES = ['1', '2', '3', '4', '5', '6', '7', '8'];
const text = (lines: string[]) => lines.join('\n') + '\n';
const replace = (index: number, value: string, lines = LINES) =>
  lines.map((line, at) => (at === index ? value : line));

async function repos() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-keep-changes-'));
  const source = makeSourceCheckoutPath(userData);
  const official = path.join(userData, 'official');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git: MergeGit = (args, cwd, indexFile) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args.map((arg) => (arg === 'https://github.com/makecindy/cindy.git' ? official : arg)),
      cwd,
      AbortSignal.timeout(30_000),
    );
  const identity = (task: boolean) => [
    '-c',
    `user.name=${task ? 'Cindy Make' : 'Test'}`,
    '-c',
    `user.email=${task ? 'cindy-make@localhost.invalid' : 'test@example.invalid'}`,
    '-c',
    'commit.gpgSign=false',
    '-c',
    'core.editor=true',
  ];
  /** Task commits share one identity and message, like real ones; `at` keeps them apart. */
  const commit = async (cwd: string, message: string, at?: number) => {
    await git(['add', '-A'], cwd);
    const task = at !== undefined;
    const date = task ? [`--date=${1_700_000_000 + at} +0000`] : [];
    await git(
      [...identity(task), 'commit', '-s', ...date, '-m', task ? 'Cindy Make: complete personal change' : message],
      cwd,
    );
    return (await git(['rev-parse', 'HEAD'], cwd)).trim();
  };
  const write = (cwd: string, file: string, lines: string[]) =>
    writeFile(path.join(cwd, file), text(lines));
  const clean = () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  await mkdir(official);
  await mkdir(path.dirname(source), { recursive: true });
  await git(['init', '--initial-branch=main'], official);
  await write(official, 'feature.txt', LINES);
  // A binary file in the base: binary changes have no lines to compare later.
  await writeFile(path.join(official, 'logo.bin'), Buffer.from([0x00, 0x41, 0x00]));
  const base = await commit(official, 'official base');
  await git(['clone', official, source], userData);
  await git(['checkout', '-b', 'cindy-personal'], source);
  await git(['update-ref', PERSONAL_UPSTREAM_REF, base], source);
  return { userData, source, official, git, identity, commit, write, clean, base };
}
type Repos = Awaited<ReturnType<typeof repos>>;

const update = (h: Repos, upstreamCommit: string): CindyMakeMergeState => ({
  id: randomUUID(),
  status: 'fetching',
  ref: 'v2',
  upstreamCommit,
});

/** What a resolver does when it gives up a conflicting change instead of combining it. */
const skip = (h: Repos, state: CindyMakeMergeState) =>
  h.git([...h.identity(true), 'rebase', '--skip'], mergeWorktree(h.userData, state.id));

it('names a personal change an official update dropped, and adopts only on the user’s word', async () => {
  const h = await repos();
  try {
    await h.write(h.source, 'personal.txt', ['kept']);
    await h.commit(h.source, '', 1_000);
    await h.write(h.source, 'feature.txt', replace(0, 'mine'));
    const dropped = await h.commit(h.source, '', 2_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');

    const state = update(h, target);
    const conflict = await prepareUpstreamMerge(h.userData, state, h.git, async () => {});
    expect(conflict.status).toBe('conflict');
    await skip(h, conflict);
    const refused = await applyUpstreamMerge(h.userData, conflict, h.git).catch((error) => error);
    expect(refused).toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [dropped] },
    });
    // Nothing moved on this computer.
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      text(replace(0, 'mine')),
    );
    // The decision is bound to the checked result: one changed since is checked again.
    await expect(
      applyUpstreamMerge(h.userData, conflict, h.git, () => true, { acceptMissing: true }),
    ).rejects.toMatchObject({ code: 'checksFailed' });
    const adopted = await applyUpstreamMerge(
      h.userData,
      { ...conflict, missing: refused.missing },
      h.git,
      () => true,
      { acceptMissing: true },
    );
    expect(adopted.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'personal.txt'), 'utf8')).toBe('kept\n');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      text(replace(0, 'official')),
    );
  } finally {
    await h.clean();
  }
}, 60_000);

it('adopts an official update that already contains a personal change as the same patch', async () => {
  const h = await repos();
  try {
    await h.write(h.source, 'feature.txt', replace(3, 'adopted'));
    await h.commit(h.source, '', 1_000);
    // The official project took the change (for example a merged pull request).
    await h.write(h.official, 'feature.txt', replace(3, 'adopted'));
    await h.commit(h.official, 'feat: adopted upstream');
    await h.write(h.official, 'other.txt', ['other']);
    const target = await h.commit(h.official, 'official v2');
    const result = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(result.status).toBe('merged');
  } finally {
    await h.clean();
  }
}, 60_000);

it('adopts a resolved official update whose task commits share one identity', async () => {
  const h = await repos();
  try {
    // Two task commits in the same second: the clean one must not vouch for the conflicting one.
    await h.write(h.source, 'feature.txt', replace(0, 'mine'));
    await h.commit(h.source, '', 5_000);
    await h.write(h.source, 'clean.txt', ['clean']);
    await h.commit(h.source, '', 5_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', replace(0, 'official and mine'));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).resolves.toMatchObject({
      status: 'merged',
    });
    expect(await readFile(path.join(h.source, 'clean.txt'), 'utf8')).toBe('clean\n');
  } finally {
    await h.clean();
  }
}, 60_000);

it('refuses when the conflicting one of two same-second task commits is skipped', async () => {
  const h = await repos();
  try {
    await h.write(h.source, 'feature.txt', replace(0, 'mine'));
    const conflicting = await h.commit(h.source, '', 5_000);
    await h.write(h.source, 'clean.txt', ['clean']);
    await h.commit(h.source, '', 5_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    await skip(h, state);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      missing: { count: 1, commits: [conflicting] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a change whose edits a resolved rebase kept only half of', async () => {
  const h = await repos();
  try {
    // One change, two edits; the conflict resolution keeps only the second one.
    await h.write(h.source, 'feature.txt', replace(0, 'alpha', replace(4, 'beta')));
    const partial = await h.commit(h.source, '', 3_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    // The replayed commit keeps the author, time and title of `partial`, but its
    // first edit is gone: identity alone must not mark the change as kept.
    await h.write(worktree, 'feature.txt', replace(0, 'official', replace(4, 'beta')));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [partial] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a change whose added line a resolved rebase only reordered', async () => {
  const h = await repos();
  try {
    // One change adds a line; the conflict resolution keeps its words but flips
    // their order — the same unordered word set, a different meaning.
    await h.write(h.source, 'feature.txt', replace(0, 'return a - b'));
    const reordered = await h.commit(h.source, '', 4_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', replace(0, 'return b - a'));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [reordered] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a change whose deletion a resolved rebase kept only wrapped in punctuation', async () => {
  const h = await repos();
  try {
    // One change deletes a line and edits another; the resolution keeps the edit
    // but retains the deleted code wrapped in new punctuation (`2` as `(2)`) —
    // the whitespace tokens cannot see through the wrap, yet the deletion was
    // not applied and must not vouch for the change.
    await h.write(h.source, 'feature.txt', [
      'mine',
      ...LINES.slice(1).filter((line) => line !== '2'),
    ]);
    const deleted = await h.commit(h.source, '', 6_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', ['mine', '(2)', ...LINES.slice(2)]);
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [deleted] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a binary change whose same-identity replacement has different content', async () => {
  const h = await repos();
  try {
    // One change replaces the binary file; the official version replaces it too.
    await writeFile(path.join(h.source, 'logo.bin'), Buffer.from([0x00, 0x58, 0x00, 0x01]));
    const changed = await h.commit(h.source, '', 2_000);
    await writeFile(path.join(h.official, 'logo.bin'), Buffer.from([0x00, 0x59, 0x00]));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    // The replayed commit keeps the author, time and title of `changed`, but the
    // binary content is someone else's: after the `index` rows are dropped the two
    // diffs read identically, so they must never be compared without the object IDs.
    await writeFile(path.join(worktree, 'logo.bin'), Buffer.from([0x00, 0x5a]));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [changed] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a change whose deleted line a resolved rebase kept adapted', async () => {
  const h = await repos();
  try {
    // One change deletes `5` and edits another line.
    await h.write(h.source, 'feature.txt', replace(0, 'mine', ['1', '2', '3', '4', '6', '7', '8']));
    const dropped = await h.commit(h.source, '', 4_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    // The replayed commit keeps the text edit, but the deleted line survives in
    // adapted form: the deletion did not happen and must not be vouched for.
    await h.write(
      worktree,
      'feature.txt',
      replace(0, 'official and mine', ['1', '2', '3', '4', '5 // upstream note', '6', '7', '8']),
    );
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [dropped] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('journals the adopted rewrite as unverified before the source moves', async () => {
  const h = await repos();
  try {
    await h.write(h.source, 'feature.txt', replace(0, 'mine'));
    await h.commit(h.source, '', 1_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', replace(0, 'official and mine'));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    const timeline: string[] = [];
    const git: MergeGit = (args, cwd, index) => {
      if (args[0] === 'reset' && args[1] === '--keep') timeline.push('moved');
      return h.git(args, cwd, index);
    };
    const journaled: CindyMakeMergeState[] = [];
    const merged = await applyUpstreamMerge(h.userData, state, git, () => true, {
      journal: (record) => {
        timeline.push('journaled');
        journaled.push(record);
      },
    });
    expect(merged).toMatchObject({ status: 'merged' });
    // The rewritten result's provenance is durable before the source moves: a crash
    // right after the move can never leave the carried content looking verified.
    expect(timeline).toEqual(['journaled', 'moved']);
    expect(journaled[0]).toMatchObject({ status: 'merged', commit: merged.commit });
  } finally {
    await h.clean();
  }
}, 60_000);

it('journals a clean fast-path adopt before the source moves', async () => {
  const h = await repos();
  try {
    // No conflict at all: `prepareUpstreamMerge`'s own fast path adopts the
    // result — and must journal its provenance before moving, like the task path.
    await h.write(h.source, 'feature.txt', replace(3, 'mine'));
    await h.commit(h.source, '', 1_000);
    await h.write(h.official, 'other.txt', ['other']);
    const target = await h.commit(h.official, 'official v2');
    const timeline: string[] = [];
    const git: MergeGit = (args, cwd, index) => {
      if (args[0] === 'reset' && args[1] === '--keep') timeline.push('moved');
      return h.git(args, cwd, index);
    };
    const journaled: CindyMakeMergeState[] = [];
    const merged = await prepareUpstreamMerge(
      h.userData,
      update(h, target),
      git,
      async () => {},
      () => true,
      {
        journal: (record) => {
          timeline.push('journaled');
          journaled.push(record);
        },
      },
    );
    expect(merged).toMatchObject({ status: 'merged' });
    expect(timeline).toEqual(['journaled', 'moved']);
    expect(journaled[0]).toMatchObject({ status: 'merged', commit: merged.commit });
  } finally {
    await h.clean();
  }
}, 60_000);

it('keeps the source in place when the provenance journal cannot be written', async () => {
  const h = await repos();
  try {
    await h.write(h.source, 'feature.txt', replace(0, 'mine'));
    await h.commit(h.source, '', 1_000);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', replace(0, 'official and mine'));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    const timeline: string[] = [];
    const git: MergeGit = (args, cwd, index) => {
      if (args[0] === 'reset' && args[1] === '--keep') timeline.push('moved');
      return h.git(args, cwd, index);
    };
    const before = (await h.git(['rev-parse', 'HEAD'], h.source)).trim();
    await expect(
      applyUpstreamMerge(h.userData, state, git, () => true, {
        // A full disk cannot record the carried content's provenance: the adoption
        // itself must stop, never land unrecorded content in the source.
        journal: () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      }),
    ).rejects.toThrow('disk full');
    expect(timeline).not.toContain('moved');
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(before);
  } finally {
    await h.clean();
  }
}, 60_000);

it('names a change whose added duplicate line a resolved rebase dropped', async () => {
  const h = await repos();
  try {
    // The change adds a line that already exists in the file and replaces
    // another; the resolution fuses the replacement but drops the added copy —
    // one pre-existing line must not vouch for the missing occurrence.
    await h.write(h.source, 'feature.txt', ['2', ...replace(0, 'alpha')]);
    const duplicated = await h.commit(h.source, '', 3_200);
    await h.write(h.official, 'feature.txt', replace(0, 'official'));
    const target = await h.commit(h.official, 'official v2');
    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'feature.txt', replace(0, 'official and alpha'));
    await h.git(['add', '-A'], worktree);
    await h.git([...h.identity(true), 'rebase', '--continue'], worktree);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      code: 'checksFailed',
      missing: { count: 1, commits: [duplicated] },
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('keeps a merge commit’s own edits: missing until the resolver puts them back', async () => {
  const h = await repos();
  try {
    await h.git(['checkout', '-b', 'side'], h.source);
    await h.write(h.source, 'side.txt', ['side']);
    await h.commit(h.source, 'side change');
    await h.git(['checkout', 'cindy-personal'], h.source);
    await h.write(h.source, 'main.txt', ['main']);
    await h.commit(h.source, 'main change');
    // An edit made only in the merge commit itself.
    await h.git([...h.identity(false), 'merge', '--no-commit', '--no-ff', 'side'], h.source);
    await h.write(h.source, 'merge-only.txt', ['only in the merge']);
    await h.commit(h.source, 'merge side');
    const merge = (await h.git(['rev-parse', 'HEAD'], h.source)).trim();
    await h.write(h.official, 'official.txt', ['v2']);
    const target = await h.commit(h.official, 'official v2');

    const state = await prepareUpstreamMerge(h.userData, update(h, target), h.git, async () => {});
    expect(state).toMatchObject({ status: 'conflict', rebaseReview: true });
    await expect(applyUpstreamMerge(h.userData, state, h.git)).rejects.toMatchObject({
      missing: { count: 1, commits: [merge] },
    });
    const worktree = mergeWorktree(h.userData, state.id);
    await h.write(worktree, 'merge-only.txt', ['only in the merge']);
    await expect(applyUpstreamMerge(h.userData, state, h.git)).resolves.toMatchObject({
      status: 'merged',
    });
    expect(await readFile(path.join(h.source, 'merge-only.txt'), 'utf8')).toBe(
      'only in the merge\n',
    );
  } finally {
    await h.clean();
  }
}, 60_000);

it('accepts the other computer’s own rewrite of a change it already carries', async () => {
  const h = await repos();
  try {
    const fork = path.join(h.userData, 'fork.git');
    const other = path.join(h.userData, 'other');
    // This computer's change, shared through GitHub.
    await h.write(h.source, 'feature.txt', replace(4, 'mine'));
    const mine = await h.commit(h.source, '', 1_000);
    await h.git(['clone', '--bare', h.source, fork], h.userData);
    // An official update right next to it: the other computer's rebase had to resolve it.
    await h.write(h.official, 'feature.txt', replace(3, 'official'));
    const officialV2 = await h.commit(h.official, 'official v2');
    await h.git(['clone', '--branch', 'cindy-personal', fork, other], h.userData);
    await h.git(['fetch', h.official, officialV2], other);
    await h
      .git([...h.identity(true), 'rebase', '--onto', officialV2, h.base], other)
      .catch(() => '');
    await h.write(other, 'feature.txt', replace(4, 'mine', replace(3, 'official')));
    await h.git(['add', '-A'], other);
    await h.git([...h.identity(true), 'rebase', '--continue'], other);
    await h.git(['push', '--force', 'origin', 'cindy-personal'], other);
    const remote = (await h.git(['rev-parse', 'HEAD'], other)).trim();
    expect(remote).not.toBe(mine);

    // Meanwhile this computer made another change on the older official version.
    await h.write(h.source, 'later.txt', ['later']);
    await h.commit(h.source, '', 2_000);
    await h.git(['fetch', fork, `+refs/heads/cindy-personal:${PERSONAL_TRACKING_REF}`], h.source);
    const state: CindyMakeMergeState = {
      id: randomUUID(),
      status: 'merging',
      ref: 'github',
      upstreamCommit: remote,
      remote: { base: officialV2, commit: remote },
    };
    const result = await preparePersonalCombine(h.userData, state, h.git, async () => {});
    if (result.status === 'conflict') {
      // Replaying the original next to the resolved rewrite conflicts; the resolver keeps
      // the rewrite, which leaves the original empty.
      await skip(h, result);
      await expect(applyUpstreamMerge(h.userData, result, h.git)).resolves.toMatchObject({
        status: 'merged',
      });
    } else expect(result.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      text(replace(4, 'mine', replace(3, 'official'))),
    );
    expect(await readFile(path.join(h.source, 'later.txt'), 'utf8')).toBe('later\n');
  } finally {
    await h.clean();
  }
}, 60_000);

it('never trusts Git output cut at the capture limit', async () => {
  const commit = 'a'.repeat(40);
  const git: MergeGit = async (args) => {
    if (args[0] === 'log') return ['b'.repeat(40), 'Cindy Make', 'x@y', '1', 's'].join('\0') + '\n';
    if (args[0] === 'rev-list') return '2\n';
    return '';
  };
  await expect(uncarriedChanges(git, '.', commit, commit, commit)).rejects.toMatchObject({
    code: 'checksFailed',
  });
});

it('checks a change is already there with an older Git that has no merge-tree --merge-base', async () => {
  const h = await repos();
  // Git before 2.40 rejects the option as a usage error (exit 129).
  const olderGit: MergeGit = (args, cwd, index) =>
    args[0] === 'merge-tree'
      ? Promise.reject(Object.assign(new Error('usage'), { exitCode: 129 }))
      : h.git(args, cwd, index);
  try {
    await h.git(['checkout', '-b', 'side'], h.source);
    await h.write(h.source, 'side.txt', ['side']);
    await h.commit(h.source, 'side change');
    await h.git(['checkout', 'cindy-personal'], h.source);
    await h.write(h.source, 'main.txt', ['main']);
    await h.commit(h.source, 'main change');
    await h.git([...h.identity(false), 'merge', '--no-commit', '--no-ff', 'side'], h.source);
    await h.write(h.source, 'merge-only.txt', ['only in the merge']);
    await h.commit(h.source, 'merge side');
    const merge = (await h.git(['rev-parse', 'HEAD'], h.source)).trim();
    await h.write(h.official, 'official.txt', ['v2']);
    const target = await h.commit(h.official, 'official v2');

    const state = await prepareUpstreamMerge(h.userData, update(h, target), olderGit, async () => {});
    await expect(applyUpstreamMerge(h.userData, state, olderGit)).rejects.toMatchObject({
      missing: { count: 1, commits: [merge] },
    });
    await h.write(mergeWorktree(h.userData, state.id), 'merge-only.txt', ['only in the merge']);
    await expect(applyUpstreamMerge(h.userData, state, olderGit)).resolves.toMatchObject({
      status: 'merged',
    });
  } finally {
    await h.clean();
  }
}, 60_000);

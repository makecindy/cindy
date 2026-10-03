import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PersonalSync, type PersonalSyncRecord } from '../personalSync';
import {
  PersonalRemoteController,
  adoptedRewrite,
  personalGitEnv,
  type PersonalRemoteGitOptions,
  type PersonalRemoteRecord,
} from '../personalRemote';
import { UpstreamMergeController, type SavedUpstreamMerge } from '../upstreamMergeController';
import {
  applyUpstreamMerge,
  cancelUpstreamMerge,
  cleanupMergedCandidate,
  discardFeatureMerge,
  mergeWorktree,
  preparePersonalCombine,
  prepareUpstreamMerge,
  type MergeGit,
} from '../upstreamMerge';
import { PERSONAL_UPSTREAM_REF } from '../sourceContent';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';
import type { CindyMakeSyncState } from '../../../shared/cindyMakeSync';

/**
 * End-to-end journeys of the single Sync with real Git and the real controllers: an
 * official repository that publishes releases, the user's fork on GitHub (a bare
 * repository) and one or two computers. Only the conflict task's Agent is played by
 * the test, the way a resolver works in its isolated folder.
 */
const OFFICIAL_URL = 'https://github.com/makecindy/cindy.git';
const FORK_URL = 'https://github.com/octo/cindy.git';
const TOKEN = 'gho_fake-token-for-tests';
const TASK_IDENTITY = [
  '-c',
  'user.name=Cindy Make',
  '-c',
  'user.email=cindy-make@localhost.invalid',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.editor=true',
];
const LINES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const text = (lines: string[]) => lines.join('\n') + '\n';
const set = (index: number, value: string, lines = LINES) =>
  lines.map((line, at) => (at === index ? value : line));

async function world() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-sync-journeys-'));
  const official = path.join(root, 'official');
  const fork = path.join(root, 'fork.git');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const raw = (args: string[], cwd: string) =>
    runSourceGit(env, args, cwd, AbortSignal.timeout(60_000));
  const head = async (cwd: string, ref = 'HEAD') =>
    (await raw(['rev-parse', '--verify', ref], cwd)).trim();
  await mkdir(official);
  await raw(['init', '--initial-branch=main'], official);
  await writeFile(path.join(official, 'feature.txt'), text(LINES));
  await raw(['add', '-A'], official);
  await raw(
    ['-c', 'user.name=Official', '-c', 'user.email=official@example.invalid', 'commit', '-m', 'v1'],
    official,
  );
  // The user's fork of the official repository, before any personal version is saved.
  await raw(['clone', '--bare', official, fork], root);
  /** The official project publishes a release; Sync targets it. */
  const release = async (ref: string, file: string, lines: string[]) => {
    await writeFile(path.join(official, file), text(lines));
    await raw(['add', '-A'], official);
    await raw(
      ['-c', 'user.name=Official', '-c', 'user.email=official@example.invalid', 'commit', '-m', ref],
      official,
    );
    return { ref, commit: await head(official) };
  };
  const forkTip = (ref = 'refs/heads/cindy-personal') =>
    head(fork, ref).catch(() => undefined);
  return {
    root,
    official,
    fork,
    env,
    raw,
    head,
    release,
    forkTip,
    clean: () => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** One computer: its managed source, the shared source-operation lifecycle, GitHub and Sync. */
async function computer(w: World, name: string) {
  const userData = path.join(w.root, name);
  const source = makeSourceCheckoutPath(userData);
  await mkdir(path.dirname(source), { recursive: true });
  await w.raw(['clone', w.official, source], w.root);
  await w.raw(['checkout', '-b', 'cindy-personal'], source);
  await w.raw(['update-ref', PERSONAL_UPSTREAM_REF, await w.head(source)], source);
  const timeout = () => AbortSignal.timeout(60_000);
  const mergeGit: MergeGit = (args, cwd, indexFile) =>
    runSourceGit(
      { ...w.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args.map((arg) => (arg === OFFICIAL_URL ? w.official : arg)),
      cwd,
      timeout(),
    );
  const remoteGit = async (args: string[], cwd: string, options?: PersonalRemoteGitOptions) => {
    const output = await runSourceGit(
      personalGitEnv(w.env, options),
      args.map((arg) => (arg === FORK_URL ? w.fork : arg)),
      cwd,
      timeout(),
    );
    return output.trim() === w.fork ? FORK_URL : output;
  };
  const readRef = async (ref: string) =>
    (await w.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], source).catch(() => ''))
      .trim() || undefined;
  const isAncestor = (ancestor: string, descendant: string) =>
    w.raw(['merge-base', '--is-ancestor', ancestor, descendant], source).then(
      () => true,
      (error) => {
        if ((error as { exitCode?: number }).exitCode === 1) return false;
        throw error;
      },
    );

  // Durable records survive a restart; the controllers are rebuilt from them.
  let record: PersonalRemoteRecord = { schema: 1 };
  let saved: SavedUpstreamMerge | undefined;
  let syncRecord: PersonalSyncRecord = {};
  let target = { ref: 'v1', commit: await w.head(source) };
  const sessions: string[] = [];
  const reminders: string[] = [];
  const states: CindyMakeSyncState[] = [];
  let remote!: PersonalRemoteController;
  let merge!: UpstreamMergeController;
  let sync: PersonalSync | undefined;

  const build = () => {
    sync = undefined;
    remote = new PersonalRemoteController({
      source,
      read: () => structuredClone(record),
      write: (next) => {
        record = structuredClone(next);
      },
      identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
      ensureFork: async () => 'octo/cindy',
      findPersonalFork: async () => ((await w.forkTip()) ? 'octo/cindy' : undefined),
      git: remoteGit,
      sourceExists: () => existsSync(path.join(source, '.git')),
      withProject: (run) => run(),
      withSourceUse: (run) => run(),
      hasUnbuiltChanges: async () => false,
      isBuilt: () => false,
      sourceSettled: () => true,
      officialBase: () => readRef(PERSONAL_UPSTREAM_REF),
      sourceChanged: () => {},
      publish: () => {},
      sleep: async () => {},
      now: () => Date.now(),
    });
    merge = new UpstreamMergeController({
      read: () => (saved ? structuredClone(saved) : undefined),
      write: (next) => {
        saved = structuredClone(next);
      },
      publish: (state) => {
        // Every adopted update or combine is lineage for the next upload (as in the app),
        // and a combine's fork tip is unverified here until a version covers it.
        const rewrite = state && adoptedRewrite(state);
        if (rewrite) {
          if (state.remote?.commit) remote.recordUnverifiedRemote(state.remote.commit);
          remote.recordRewrite(rewrite.from, rewrite.to);
        }
        sync?.operationChanged(state);
      },
      owner: () => 'owner',
      hasWorkspace: (state) => existsSync(mergeWorktree(userData, state.id)),
      exclusive: (run) => run(),
      latest: async () => target,
      prepare: (state, publish, isCurrent) =>
        prepareUpstreamMerge(userData, state, mergeGit, publish, isCurrent),
      prepareCombine: (state, publish, isCurrent) =>
        preparePersonalCombine(userData, state, mergeGit, publish, isCurrent),
      apply: (state, isCurrent, _publish, options) =>
        applyUpstreamMerge(userData, state, mergeGit, isCurrent, options),
      session: async (state, _options, bind) => {
        const id = state.sessionId ?? `resolver-${sessions.length + 1}`;
        bind(id);
        if (!sessions.includes(id)) sessions.push(id);
        return id;
      },
      running: () => false,
      remind: async (state) => {
        reminders.push(state.id);
      },
      sleep: async () => {},
      refresh: async () => {},
      cleanup: (state, isCurrent) => cleanupMergedCandidate(userData, state, mergeGit, isCurrent),
      cancel: (state, isCurrent) => cancelUpstreamMerge(userData, state, mergeGit, isCurrent),
      discard: (state, isCurrent) => discardFeatureMerge(userData, state, mergeGit, isCurrent),
    });
    sync = new PersonalSync({
      remote: () =>
        record.repository && record.choice === 'github'
          ? {
              sync: () => remote.syncNow(),
              tips: () => remote.fetchedTips(),
              keep: (side) => remote.keepSide(side),
            }
          : undefined,
      // Like the app's target lookup, the returned commit is available locally.
      target: async () => {
        await w.raw(['fetch', '--no-tags', '--no-write-fetch-head', w.official, target.commit], source);
        return target;
      },
      base: () => readRef(PERSONAL_UPSTREAM_REF),
      isAncestor,
      unbuilt: async () => false,
      operation: () => merge.status(),
      resume: (options) => merge.resumeForSync(options),
      combine: (tips, options) => merge.combine(tips, options, true),
      update: (next, options) => merge.update(options, undefined, { target: next, autoResolve: true }),
      abandon: (id) => merge.abandon(id),
      accept: (id) => merge.acceptMissing(id),
      reserve: () => () => {},
      load: () => structuredClone(syncRecord),
      save: (next) => {
        syncRecord = structuredClone(next);
      },
      publish: (state) => states.push(state),
      now: () => 1,
    });
  };
  build();

  let at = 1_700_000_000 + name.charCodeAt(0) * 100_000;
  /** A finished task's change, committed like Cindy Make does. */
  const change = async (file: string, lines: string[]) => {
    await writeFile(path.join(source, file), text(lines));
    await w.raw(['add', '-A'], source);
    at += 10;
    await w.raw(
      [
        ...TASK_IDENTITY,
        'commit',
        '-s',
        `--date=${at} +0000`,
        '-m',
        'Cindy Make: complete personal change',
      ],
      source,
    );
    return w.head(source);
  };
  const operation = () => merge.status();
  const run = async (step: () => unknown) => {
    await step();
    await sync!.settled();
    return sync!.state();
  };
  /** The conflict task's Agent: resolve the files, finish the rebase, end its turn. */
  const resolve = async (file: string, lines: string[] | 'skip') => {
    const state = operation()!;
    const worktree = mergeWorktree(userData, state.id);
    if (lines === 'skip') await w.raw([...TASK_IDENTITY, 'rebase', '--skip'], worktree);
    else {
      await writeFile(path.join(worktree, file), text(lines));
      await w.raw(['add', '-A'], worktree);
      await w.raw([...TASK_IDENTITY, 'rebase', '--continue'], worktree);
    }
    await turnEnds();
  };
  const turnEnds = async () => {
    const sessionId = operation()!.sessionId!;
    merge.prepareTurn(sessionId)();
    await merge.finish(sessionId);
    await sync!.settled();
  };
  return {
    userData,
    source,
    read: (file: string) => readFile(path.join(source, file), 'utf8'),
    tip: () => w.head(source),
    base: () => readRef(PERSONAL_UPSTREAM_REF),
    change,
    resolve,
    turnEnds,
    operation,
    reminders,
    states,
    target: (next: { ref: string; commit: string }) => {
      target = next;
    },
    /** Save to GitHub through the consent card (also uses an existing personal version). */
    save: async () => {
      remote.save();
      await remote.settled();
      return structuredClone(record);
    },
    record: () => structuredClone(record),
    sync: () => run(() => sync!.sync()),
    abandon: () => run(() => sync!.abandon()),
    accept: () => run(() => sync!.accept()),
    keep: (side: 'github' | 'local') => run(() => sync!.keep(side)),
    state: () => sync!.state(),
    /** Cindy quits and starts again: everything is rebuilt from the durable records. */
    restart: () => build(),
  };
}

const journey = (name: string, body: (w: World) => Promise<void>) =>
  it(
    name,
    async () => {
      const w = await world();
      try {
        await body(w);
      } finally {
        await w.clean();
      }
    },
    180_000,
  );

journey('without GitHub: Sync moves the personal version to a new official release', async (w) => {
  const a = await computer(w, 'a');
  await a.change('personal.txt', ['mine']);
  const v2 = await w.release('v2', 'official.txt', ['new']);
  a.target(v2);
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await a.read('personal.txt')).toBe('mine\n');
  expect(await a.read('official.txt')).toBe('new\n');
  expect(await a.base()).toBe(v2.commit);
  // Already there: a second Sync changes nothing.
  const tip = await a.tip();
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await a.tip()).toBe(tip);
});

journey('without GitHub: a conflict is resolved in its task and Sync continues by itself', async (w) => {
  const a = await computer(w, 'a');
  await a.change('feature.txt', set(2, 'mine'));
  const v2 = await w.release('v2', 'feature.txt', set(2, 'official'));
  a.target(v2);
  expect((await a.sync()).waiting).toMatchObject({ kind: 'official', reason: 'working' });
  // Nothing moved on this computer while it waits.
  expect(await a.read('feature.txt')).toBe(text(set(2, 'mine')));
  await a.resolve('feature.txt', set(2, 'official and mine'));
  expect(a.state()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await a.read('feature.txt')).toBe(text(set(2, 'official and mine')));
  expect(await a.base()).toBe(v2.commit);
  expect(a.operation()).toMatchObject({ status: 'merged', hasWorkspace: false });
});

journey('a dropped change is noticed, the task is reminded once, then the user decides', async (w) => {
  const a = await computer(w, 'a');
  await a.change('kept.txt', ['kept']);
  await a.change('feature.txt', set(2, 'mine'));
  const v2 = await w.release('v2', 'feature.txt', set(2, 'official'));
  a.target(v2);
  await a.sync();
  // The Agent gives the conflicting change up instead of combining it.
  await a.resolve('feature.txt', 'skip');
  expect(a.reminders).toHaveLength(1);
  expect(a.state().waiting).toMatchObject({ reason: 'working' });
  // It ends its next turn without putting it back: the user decides.
  await a.turnEnds();
  expect(a.state().waiting).toMatchObject({ reason: 'missing', missing: 1 });
  expect(await a.read('feature.txt')).toBe(text(set(2, 'mine')));
  expect(await a.accept()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await a.read('feature.txt')).toBe(text(set(2, 'official')));
  expect(await a.read('kept.txt')).toBe('kept\n');
});

journey('a restart while the conflict is handled continues from the same task', async (w) => {
  const a = await computer(w, 'a');
  await a.change('feature.txt', set(2, 'mine'));
  const v2 = await w.release('v2', 'feature.txt', set(2, 'official'));
  a.target(v2);
  await a.sync();
  a.restart();
  expect(a.state().waiting).toMatchObject({ kind: 'official', reason: 'interrupted' });
  // The user says "continue" in the task; its Agent finishes the work.
  await a.resolve('feature.txt', set(2, 'official and mine'));
  expect(a.state()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await a.read('feature.txt')).toBe(text(set(2, 'official and mine')));
});

journey('Abandon leaves the personal version exactly as it was', async (w) => {
  const a = await computer(w, 'a');
  const tip = await a.change('feature.txt', set(2, 'mine'));
  const v2 = await w.release('v2', 'feature.txt', set(2, 'official'));
  a.target(v2);
  await a.sync();
  expect(await a.abandon()).toEqual({ error: 'cancelled', abandoned: 'official' });
  expect(await a.tip()).toBe(tip);
  expect(a.operation()).toMatchObject({ status: 'cancelled', hasWorkspace: false });
  // Sync can be tried again later.
  expect((await a.sync()).waiting).toMatchObject({ kind: 'official' });
});

journey('a second computer uses the personal version saved on GitHub', async (w) => {
  const a = await computer(w, 'a');
  await a.change('personal.txt', ['from a']);
  expect(await a.save()).toMatchObject({ repository: 'octo/cindy', sync: 'synced' });
  expect(await w.forkTip()).toBe(await a.tip());
  expect(await w.forkTip('refs/heads/cindy-personal-base')).toBe(await a.base());

  const b = await computer(w, 'b');
  expect(await b.save()).toMatchObject({ repository: 'octo/cindy', sync: 'retrieved' });
  expect(await b.tip()).toBe(await a.tip());
  expect(await b.read('personal.txt')).toBe('from a\n');
});

journey('both computers changed different places: Sync combines and both end up equal', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.change('a.txt', ['a']);
  await a.save();
  await b.save();
  await a.change('a2.txt', ['a2']);
  expect((await a.sync()).done).toBeTruthy();
  await b.change('b.txt', ['b']);
  expect(await b.sync()).toEqual({ done: { at: 1, ref: 'v1' } });
  expect(await w.forkTip()).toBe(await b.tip());
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v1' } });
  expect(await a.tip()).toBe(await b.tip());
  for (const file of ['a.txt', 'a2.txt', 'b.txt']) expect(await a.read(file)).toBeTruthy();
});

journey('both computers changed the same line: the conflict task keeps both, then it is shared', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.save();
  await b.save();
  await a.change('feature.txt', set(4, 'from a'));
  await a.sync();
  await b.change('feature.txt', set(4, 'from b'));
  expect((await b.sync()).waiting).toMatchObject({ kind: 'combine', reason: 'working' });
  // GitHub keeps the other computer's version until the result is adopted.
  expect(await w.forkTip()).toBe(await a.tip());
  await b.resolve('feature.txt', set(4, 'from a and b'));
  expect(b.state()).toEqual({ done: { at: 1, ref: 'v1' } });
  // The combine adopted the fork's tip through the shared merge lifecycle: its
  // content is unverified on this computer until a generated version covers it.
  expect(b.record().unverifiedRemote ?? []).toContain(await a.tip());
  expect(await w.forkTip()).toBe(await b.tip());
  await a.sync();
  expect(await a.read('feature.txt')).toBe(text(set(4, 'from a and b')));
});

journey('a combine that cannot be settled: give it up, then keep one side (backed up)', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.save();
  await b.save();
  const fromA = await a.change('feature.txt', set(4, 'from a'));
  await a.sync();
  const fromB = await b.change('feature.txt', set(4, 'from b'));
  await b.sync();
  expect(await b.abandon()).toEqual({ error: 'cancelled', abandoned: 'combine' });
  expect(await b.tip()).toBe(fromB);
  expect(await w.forkTip()).toBe(fromA);

  // B keeps its own version; the version on GitHub is backed up there first.
  expect(await b.keep('local')).toEqual({ done: { at: 1, ref: 'v1' } });
  expect(await w.forkTip()).toBe(fromB);
  expect(await w.forkTip(`refs/heads/cindy-personal-backup/${fromA.slice(0, 12)}`)).toBe(fromA);

  // A, with a new change of its own, meets the conflict too, gives it up and keeps the
  // GitHub version instead; its own version stays in a local backup.
  const a2 = await a.change('a2.txt', ['a2']);
  await a.sync();
  expect(a.state().waiting).toMatchObject({ kind: 'combine' });
  await a.abandon();
  expect(await a.keep('github')).toEqual({ done: { at: 1, ref: 'v1' } });
  expect(await a.tip()).toBe(fromB);
  expect(await a.read('feature.txt')).toBe(text(set(4, 'from b')));
  expect(await w.head(a.source, `refs/cindy-make/backups/personal-remote-local/${a2}`)).toBe(a2);
});

journey('a computer with nothing new follows the version the other computer chose', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.save();
  await b.save();
  const fromA = await a.change('feature.txt', set(4, 'from a'));
  await a.sync();
  const fromB = await b.change('feature.txt', set(4, 'from b'));
  await b.sync();
  await b.abandon();
  await b.keep('local');
  // A changed nothing since it uploaded: it takes the chosen version, keeping a backup.
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v1' } });
  expect(await a.tip()).toBe(fromB);
  expect(await w.head(a.source, `refs/cindy-make/backups/personal-remote-local/${fromA}`)).toBe(
    fromA,
  );
});

journey('an official release reaches both computers through one update and GitHub', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.change('personal.txt', ['mine']);
  await a.save();
  await b.save();
  const v2 = await w.release('v2', 'official.txt', ['new']);
  a.target(v2);
  b.target(v2);
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  // The rewritten version replaces the old one on GitHub, with its new official base.
  expect(await w.forkTip()).toBe(await a.tip());
  expect(await w.forkTip('refs/heads/cindy-personal-base')).toBe(v2.commit);
  // The other computer takes it in instead of updating again.
  expect(await b.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await b.tip()).toBe(await a.tip());
  expect(await b.base()).toBe(v2.commit);
  expect(b.operation()).toBeUndefined();
});

journey('a conflicting official release is resolved once; the other computer takes the result', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.change('feature.txt', set(2, 'mine'));
  await a.save();
  await b.save();
  const v2 = await w.release('v2', 'feature.txt', set(2, 'official'));
  a.target(v2);
  b.target(v2);
  expect((await a.sync()).waiting).toMatchObject({ kind: 'official' });
  await a.resolve('feature.txt', set(2, 'official and mine'));
  expect(a.state()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await w.forkTip()).toBe(await a.tip());
  // No second conflict on the other computer: it uses the resolved version.
  expect(await b.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(b.operation()).toBeUndefined();
  expect(await b.read('feature.txt')).toBe(text(set(2, 'official and mine')));
});

journey('a change made while the other computer updated is combined onto the newer version', async (w) => {
  const a = await computer(w, 'a');
  const b = await computer(w, 'b');
  await a.change('a.txt', ['a']);
  await a.save();
  await b.save();
  const v2 = await w.release('v2', 'official.txt', ['new']);
  a.target(v2);
  b.target(v2);
  // A moves to v2 and shares it; B meanwhile adds a change on v1.
  expect(await a.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  await b.change('b.txt', ['b']);
  expect(await b.sync()).toEqual({ done: { at: 1, ref: 'v2' } });
  expect(await b.base()).toBe(v2.commit);
  for (const file of ['a.txt', 'b.txt', 'official.txt']) expect(await b.read(file)).toBeTruthy();
  expect(await w.forkTip()).toBe(await b.tip());
  await a.sync();
  expect(await a.tip()).toBe(await b.tip());
});

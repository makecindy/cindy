import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { PersonalContribution, type ContributionRecord } from '../personalContribution';
import { personalGitEnv, type PersonalRemoteGitOptions } from '../personalRemote';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';

const TOKEN = 'gho_fake-token-for-tests';
const FORK_URL = 'https://github.com/octo/cindy.git';
const OFFICIAL_URL = 'https://github.com/makecindy/cindy.git';

/** Official repository, the author's fork and a personal checkout with one finished change. */
async function fixture(conflict: boolean) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-contribution-'));
  const source = makeSourceCheckoutPath(userData);
  const official = path.join(userData, 'official');
  const fork = path.join(userData, 'fork.git');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const raw = (args: string[], cwd: string) =>
    runSourceGit(env, args, cwd, AbortSignal.timeout(30_000));
  const git = async (args: string[], cwd: string, options?: PersonalRemoteGitOptions) => {
    return runSourceGit(
      personalGitEnv(env, options),
      args.map((arg) => (arg === FORK_URL ? fork : arg === OFFICIAL_URL ? official : arg)),
      cwd,
      AbortSignal.timeout(30_000),
    );
  };
  const commit = async (cwd: string, message: string) => {
    await raw(['add', '.'], cwd);
    await raw(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-s',
        '-m',
        message,
      ],
      cwd,
    );
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  await mkdir(official);
  await mkdir(path.dirname(source), { recursive: true });
  await raw(['init', '--initial-branch=main'], official);
  await writeFile(path.join(official, 'app.txt'), 'line one\nline two\n');
  await writeFile(path.join(official, 'other.txt'), 'other\n');
  await commit(official, 'official base');
  await raw(['clone', '--bare', official, fork], userData);
  await raw(['clone', official, source], userData);
  await raw(['checkout', '-b', 'cindy-personal'], source);
  // An earlier personal change that must not be part of this contribution.
  await writeFile(path.join(source, 'unrelated-personal.txt'), 'mine only\n');
  await commit(source, 'unrelated personal change');
  await raw(['remote', 'add', 'personal', fork], source);
  // The task starts from the personal version and changes one line.
  const baseTree = (await raw(['rev-parse', 'HEAD^{tree}'], source)).trim();
  await writeFile(path.join(source, 'app.txt'), 'line one\nline two changed\n');
  await commit(source, 'task change');
  const tree = (await raw(['rev-parse', 'HEAD^{tree}'], source)).trim();
  // Official main moves on before the contribution.
  if (conflict) await writeFile(path.join(official, 'app.txt'), 'line one\nline two official\n');
  else await writeFile(path.join(official, 'other.txt'), 'other updated\n');
  await commit(official, 'official update');

  let store: Record<string, ContributionRecord> = {};
  const github = { number: 7, state: 'open' };
  const pull = () => ({
    number: github.number,
    html_url: `https://github.com/makecindy/cindy/pull/${github.number}`,
    state: github.state,
  });
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (
      target === 'https://api.github.com/repos/makecindy/cindy/pulls' &&
      init?.method === 'POST'
    ) {
      if (github.state === 'closed')
        Object.assign(github, { number: github.number + 1, state: 'open' });
      return new Response(JSON.stringify(pull()), { status: 201 });
    }
    if (target.endsWith(`/pulls/${github.number}`) && ['GET', 'PATCH'].includes(init?.method ?? ''))
      return new Response(JSON.stringify(pull()), { status: 200 });
    // The open-pull lookup for a head: a confirmed empty list (never a guess).
    if (target.startsWith('https://api.github.com/repos/makecindy/cindy/pulls?state=open&head='))
      return new Response('[]', { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const contribution = new PersonalContribution({
    source,
    ownerScope: () => 'owner-1',
    binding: () => ({ schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' }),
    identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
    inspectFork: async () => ({ repository: 'octo/cindy', archived: false, canPush: true }),
    git,
    change: (runId) =>
      runId === 'run-1'
        ? { title: '把第二行改得更清楚', request: '让第二行更清楚', baseTree, tree }
        : undefined,
    ledgerPath: () => 'ledger.json',
    readStore: () => structuredClone(store),
    writeStore: (_file, next) => {
      store = structuredClone(next);
    },
    fetch: fetchFn as unknown as typeof fetch,
    gitIdentity: async () => ({ name: 'Ada Author', email: 'ada@example.com' }),
    withSourceUse: (run) => run(),
    now: () => 1_000,
  });
  return {
    userData,
    source,
    fork,
    official,
    raw,
    contribution,
    fetchFn,
    github,
    store: () => store,
    clean: () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

it('opens a pull request with only this change, on the latest official main, signed by the author', async () => {
  const h = await fixture(false);
  try {
    const draft = await h.contribution.draft('run-1');
    expect(draft).toMatchObject({
      title: 'feat: 把第二行改得更清楚',
      name: 'Ada Author',
      email: 'ada@example.com',
      files: ['app.txt'],
      touchesUi: false,
    });
    expect(draft.body).toContain('引用的设计规范：不涉及');

    const view = await h.contribution.submit({ ...draft, runId: 'run-1' });
    expect(view).toMatchObject({ number: 7, url: 'https://github.com/makecindy/cindy/pull/7' });
    const branch = 'refs/heads/cindy-make-pr/run-1';
    const head = (await h.raw(['rev-parse', branch], h.fork)).trim();
    const officialMain = (await h.raw(['rev-parse', 'main'], h.official)).trim();
    expect((await h.raw(['rev-parse', `${head}^`], h.fork)).trim()).toBe(officialMain);
    expect((await h.raw(['show', `${head}:app.txt`], h.fork)).trim()).toBe(
      'line one\nline two changed',
    );
    expect((await h.raw(['show', `${head}:other.txt`], h.fork)).trim()).toBe('other updated');
    await expect(h.raw(['show', `${head}:unrelated-personal.txt`], h.fork)).rejects.toBeTruthy();
    expect((await h.raw(['log', '-1', '--format=%an <%ae>%n%B', head], h.fork)).trim()).toBe(
      'Ada Author <ada@example.com>\nfeat: 把第二行改得更清楚\n\nSigned-off-by: Ada Author <ada@example.com>',
    );
    const pullRequest = h.fetchFn.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(pullRequest?.[1]?.body))).toMatchObject({
      head: 'octo:cindy-make-pr/run-1',
      base: 'main',
      title: 'feat: 把第二行改得更清楚',
      maintainer_can_modify: true,
    });
    expect(h.store()['run-1']).toMatchObject({
      number: 7,
      branch: 'cindy-make-pr/run-1',
      commit: head,
    });

    // Submitting again updates the same branch and pull request.
    await h.contribution.submit({ ...draft, runId: 'run-1', title: 'feat: 更新后的标题' });
    expect(h.fetchFn.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    expect((await h.raw(['log', '-1', '--format=%s', branch], h.fork)).trim()).toBe(
      'feat: 更新后的标题',
    );

    // Once maintainers close it and delete its branch, a resubmission is a new pull
    // request from a recreated branch; the closed one is left exactly as it was.
    h.github.state = 'closed';
    await h.raw(['update-ref', '-d', branch], h.fork);
    const patches = () =>
      h.fetchFn.mock.calls.filter(([, init]) => init?.method === 'PATCH').length;
    const patchedBefore = patches();
    await expect(
      h.contribution.submit({ ...draft, runId: 'run-1', title: 'feat: 再次提交' }),
    ).resolves.toMatchObject({ number: 8, state: 'open' });
    expect(h.fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(patches()).toBe(patchedBefore);
    expect((await h.raw(['log', '-1', '--format=%s', branch], h.fork)).trim()).toBe(
      'feat: 再次提交',
    );
    expect(h.store()['run-1']).toMatchObject({ number: 8, branch: 'cindy-make-pr/run-1' });

    // With the closed pull request's branch still on the fork, the resubmission is
    // again a new pull request — from a new branch, leaving the old commits alone.
    h.github.state = 'closed';
    const oldHead = (await h.raw(['rev-parse', branch], h.fork)).trim();
    await expect(
      h.contribution.submit({ ...draft, runId: 'run-1', title: 'feat: 不改写旧分支' }),
    ).resolves.toMatchObject({ number: 9, state: 'open' });
    expect((await h.raw(['rev-parse', branch], h.fork)).trim()).toBe(oldHead);
    expect((await h.raw(['log', '-1', '--format=%s', branch], h.fork)).trim()).toBe(
      'feat: 再次提交',
    );
    const resubmitted = 'refs/heads/cindy-make-pr/run-1-2';
    expect((await h.raw(['log', '-1', '--format=%s', resubmitted], h.fork)).trim()).toBe(
      'feat: 不改写旧分支',
    );
    expect(h.store()['run-1']).toMatchObject({ number: 9, branch: 'cindy-make-pr/run-1-2' });
    const created = h.fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1);
    expect(JSON.parse(String(created?.[1]?.body))).toMatchObject({
      head: 'octo:cindy-make-pr/run-1-2',
    });
  } finally {
    await h.clean();
  }
}, 60_000);

it('reports a conflict with the latest official code instead of submitting', async () => {
  const h = await fixture(true);
  try {
    const draft = await h.contribution.draft('run-1');
    await expect(h.contribution.submit({ ...draft, runId: 'run-1' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      h.raw(['rev-parse', 'refs/heads/cindy-make-pr/run-1'], h.fork),
    ).rejects.toBeTruthy();
    expect(h.fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    // The personal checkout is untouched.
    expect((await h.raw(['status', '--porcelain'], h.source)).trim()).toBe('');
  } finally {
    await h.clean();
  }
}, 60_000);

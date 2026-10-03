import { describe, expect, it, vi } from 'vitest';
import {
  PersonalContribution,
  contributionBody,
  parseContributionStore,
  type ContributionDeps,
  type ContributionRecord,
} from '../personalContribution';
import { PersonalRemoteError } from '../personalRemote';

const TOKEN = 'gho_fake-token-for-tests';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const record = (runId: string, number: number): ContributionRecord => ({
  runId,
  number,
  url: `https://github.com/makecindy/cindy/pull/${number}`,
  branch: `cindy-make-pr/${runId}`,
  commit: A,
  submittedAt: 1,
});

function harness(overrides: Partial<ContributionDeps> = {}) {
  let store: Record<string, ContributionRecord> = {};
  const deps: ContributionDeps = {
    source: 'source',
    ownerScope: () => 'owner-1',
    binding: () => ({ schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' }),
    identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
    inspectFork: async () => ({ repository: 'octo/cindy', archived: false, canPush: true }),
    git: vi.fn(async (args: string[]) => {
      if (args[0] === 'diff') return ['apps/desktop/src/renderer/x.tsx', 'docs/a.md'].join('\0');
      throw new Error('unexpected git ' + args.join(' '));
    }),
    change: (runId) =>
      runId === 'run'
        ? { title: '加一个按钮', request: '我想要按钮', baseTree: A, tree: B }
        : undefined,
    ledgerPath: () => 'ledger.json',
    readStore: () => structuredClone(store),
    writeStore: (_file, next) => {
      store = structuredClone(next);
    },
    fetch: vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    gitIdentity: async () => ({}),
    withSourceUse: (run) => run(),
    now: () => 10_000,
    ...overrides,
  };
  return {
    contribution: new PersonalContribution(deps),
    deps,
    setStore: (next: typeof store) => (store = next),
  };
}

describe('parseContributionStore', () => {
  it('keeps only well-formed records pointing at official pull requests', () => {
    expect(
      parseContributionStore(
        JSON.stringify({
          good: record('good', 3),
          wrong: { ...record('wrong', 4), url: 'https://example.com/pull/4' },
          mismatch: record('other', 5),
        }),
      ),
    ).toEqual({ good: record('good', 3) });
    expect(parseContributionStore('nope')).toEqual({});
    expect(parseContributionStore(null)).toEqual({});
  });
});

describe('contributionBody', () => {
  it('follows the PR template and asks for the design basis only for UI changes', () => {
    const ui = contributionBody({
      title: 'feat: x',
      request: '需求',
      files: ['a.css'],
      touchesUi: true,
    });
    for (const heading of ['## 这次改了什么', '## 怎么验证的', '## 风险', '### 提交前检查'])
      expect(ui).toContain(heading);
    expect(ui).toContain('- [x] `feat` 新功能');
    expect(ui).toContain('引用的设计规范：docs/design-rules/DESIGN.md');
    expect(
      contributionBody({ title: 'fix: y', request: '', files: ['a.ts'], touchesUi: false }),
    ).toContain('引用的设计规范：不涉及：');
  });
});

describe('PersonalContribution', () => {
  it('prefills a draft with the author identity from the GitHub profile when Git has none', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: 'Octo Cat', email: 'octo@example.com' }), {
          status: 200,
        }),
    );
    const { contribution } = harness({ fetch: fetchFn as unknown as typeof fetch });
    await expect(contribution.draft('run')).resolves.toMatchObject({
      title: 'feat: 加一个按钮',
      name: 'Octo Cat',
      email: 'octo@example.com',
      touchesUi: true,
      files: ['apps/desktop/src/renderer/x.tsx', 'docs/a.md'],
      repository: 'octo/cindy',
    });
  });

  it('tells the draft whether the earlier pull request is still open', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/pulls/3')
        ? new Response(JSON.stringify({ state: 'closed', merged_at: null }), { status: 200 })
        : new Response('{}', { status: 404 }),
    );
    const { contribution, setStore } = harness({ fetch: fetchFn as unknown as typeof fetch });
    setStore({ run: record('run', 3) });
    await expect(contribution.draft('run')).resolves.toMatchObject({
      existing: { number: 3, state: 'closed' },
    });
  });

  it('leaves the email for the author to fill in rather than inventing one', async () => {
    const { contribution } = harness();
    await expect(contribution.draft('run')).resolves.toMatchObject({ name: 'octo', email: '' });
  });

  it.each([
    ['notBound', { binding: () => ({ schema: 1 as const }) }],
    ['github', { identity: async () => ({ status: 'missing' as const }) }],
    [
      'account',
      {
        identity: async () => ({
          status: 'connected' as const,
          identity: { login: 'someone', token: TOKEN },
        }),
      },
    ],
    ['unavailable', { change: () => undefined }],
    ['empty', { change: () => ({ title: 't', request: 'r', baseTree: A, tree: A }) }],
    [
      'notBound',
      {
        inspectFork: async () => {
          throw new PersonalRemoteError('forkMissing');
        },
      },
    ],
  ])('refuses a draft when %s', async (code, overrides) => {
    await expect(harness(overrides).contribution.draft('run')).rejects.toMatchObject({ code });
  });

  it('validates the confirmed fields before touching Git or GitHub', async () => {
    const { contribution, deps } = harness();
    for (const input of [
      { title: '', body: '', name: 'Ada', email: 'ada@example.com' },
      { title: 'feat: x', body: '', name: '', email: 'ada@example.com' },
      { title: 'feat: x', body: '', name: 'Ada', email: 'not-an-email' },
      { title: 'feat:\nx', body: '', name: 'Ada', email: 'ada@example.com' },
    ])
      await expect(contribution.submit({ runId: 'run', ...input })).rejects.toMatchObject({
        code: 'invalid',
      });
    expect(deps.git).not.toHaveBeenCalled();
  });

  it('stops the submission when the Cindy account changes while it runs', async () => {
    let scope = 'owner-1';
    const writes: unknown[] = [];
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
          return '';
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
          return B;
        case 'commit-tree':
          // The account switch happens while the submission is doing its Git work.
          scope = 'owner-2';
          return A;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    const { contribution } = harness({
      ownerScope: () => scope,
      git: git as unknown as ContributionDeps['git'],
      writeStore: (_file, store) => {
        writes.push(store);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'account' });
    // The other account's ledger stays empty and its identity never pushes.
    expect(writes).toEqual([]);
    expect(git.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });

  it('records the moved branch before updating the pull request', async () => {
    let store: Record<string, ContributionRecord> = {
      run: {
        runId: 'run',
        number: 3,
        url: 'https://github.com/makecindy/cindy/pull/3',
        branch: 'cindy-make-pr/run',
        commit: A,
        submittedAt: 1,
      },
    };
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
        case 'push':
          return '';
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
          return B;
        case 'commit-tree':
          return B;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new Error('offline');
      if (String(url).endsWith('/pulls/3'))
        return new Response(
          JSON.stringify({
            number: 3,
            html_url: 'https://github.com/makecindy/cindy/pull/3',
            state: 'open',
          }),
          { status: 200 },
        );
      return new Response('{}', { status: 404 });
    });
    const { contribution } = harness({
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
      ledgerPath: () => 'ledger.json',
      readStore: () => structuredClone(store),
      writeStore: (_file, next) => {
        store = structuredClone(next);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'network' });
    // The push this client already made is recorded: a retry leases against it
    // instead of failing forever against a branch this client itself moved.
    expect(store.run).toMatchObject({ number: 3, branch: 'cindy-make-pr/run', commit: B });
  });

  it('records the pushed commit in the initiating ledger even when the account switches', async () => {
    let scope = 'owner-1';
    let store: Record<string, ContributionRecord> = {
      run: {
        runId: 'run',
        number: 3,
        url: 'https://github.com/makecindy/cindy/pull/3',
        branch: 'cindy-make-pr/run',
        commit: A,
        submittedAt: 1,
      },
    };
    const writes: Record<string, ContributionRecord>[] = [];
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
          return '';
        case 'push':
          // The account switches while the push is awaited.
          scope = 'owner-2';
          return '';
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
        case 'commit-tree':
          return B;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/pulls/3')
        ? new Response(
            JSON.stringify({
              number: 3,
              html_url: 'https://github.com/makecindy/cindy/pull/3',
              state: 'open',
            }),
            { status: 200 },
          )
        : new Response('{}', { status: 404 }),
    );
    const { contribution } = harness({
      ownerScope: () => scope,
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
      ledgerPath: () => 'ledger.json',
      readStore: () => structuredClone(store),
      writeStore: (file, next) => {
        expect(file).toBe('ledger.json');
        writes.push(structuredClone(next));
        store = structuredClone(next);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'account' });
    // The push this client already made is recorded in the ledger pinned at entry:
    // a retry leases against this commit instead of failing forever.
    expect(writes.at(-1)?.run).toMatchObject({ number: 3, commit: B });
  });

  it('aborts instead of guessing when the earlier push lookup is unknown', async () => {
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
          return '';
        case 'push':
          throw Object.assign(new Error('rejected'), { stderr: ' ! [rejected] stale info' });
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
        case 'commit-tree':
          return B;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('offline');
    });
    const { contribution } = harness({
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'network' });
    // Unknown is not "no pull request": nothing was opened behind the user's back.
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('never guesses a new pull request when the earlier state is unknown', async () => {
    let store: Record<string, ContributionRecord> = { run: record('run', 3) };
    const git = vi.fn(async () => {
      throw new Error('unexpected git');
    });
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    });
    const { contribution } = harness({
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
      ledgerPath: () => 'ledger.json',
      readStore: () => structuredClone(store),
      writeStore: (_file, next) => {
        store = structuredClone(next);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'network' });
    // Nothing moved and no second public PR was opened behind the user's back.
    expect(git).not.toHaveBeenCalled();
  });

  it('aborts instead of opening a second pull request when the first closes mid-flight', async () => {
    let store: Record<string, ContributionRecord> = {
      run: {
        runId: 'run',
        number: 3,
        url: 'https://github.com/makecindy/cindy/pull/3',
        branch: 'cindy-make-pr/run',
        commit: A,
        submittedAt: 1,
      },
    };
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
        case 'push':
          return '';
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
        case 'commit-tree':
          return B;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    let reads = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/pulls/3')) {
        reads += 1;
        return new Response(
          JSON.stringify({
            number: 3,
            html_url: 'https://github.com/makecindy/cindy/pull/3',
            // Open when the submission checked, closed before it could update.
            state: reads === 1 ? 'open' : 'closed',
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    const { contribution } = harness({
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
      ledgerPath: () => 'ledger.json',
      readStore: () => structuredClone(store),
      writeStore: (_file, next) => {
        store = structuredClone(next);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    // The dialog promised "update": no second public PR was created behind it.
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('reconciles a lost pull request response on any occupied candidate before renaming', async () => {
    const HASH_TIP = 'd'.repeat(40);
    const pushes: string[] = [];
    const git = vi.fn(async (args: string[]) => {
      const op = args.includes('commit-tree')
        ? 'commit-tree'
        : args.includes('write-tree')
          ? 'write-tree'
          : args[0];
      switch (op) {
        case 'fetch':
        case 'read-tree':
        case 'apply':
          return '';
        case 'push': {
          const lease = args
            .find((arg) => arg.startsWith('--force-with-lease='))!
            .split(':')
            .at(-1)!;
          const branch = args.at(-1)!.split(':').at(-1)!;
          pushes.push(`${branch}:${lease}`);
          // The canonical name belongs to an earlier closed pull request's
          // branch; `-2` is this client's own earlier push whose pull request
          // response was lost (its absent lease fails).
          if (lease === '') throw new Error('remote ref already exists');
          return '';
        }
        case 'ls-remote':
          return `${HASH_TIP}\trefs/heads/${args.at(-1)}\n`;
        case 'diff':
          return args.includes('--name-only') ? 'app.txt\0' : '';
        case 'ls-files':
          return '';
        case 'rev-parse':
          return args[1]?.includes('{tree}') ? A : B;
        case 'write-tree':
        case 'commit-tree':
          return B;
        default:
          throw new Error('unexpected git ' + args.join(' '));
      }
    });
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) {
        const head = new URL(target).searchParams.get('head') ?? '';
        // The canonical name has no open pull request (earlier one is closed);
        // `-2` holds the open pull request whose creation response was lost.
        return new Response(
          JSON.stringify(
            head.endsWith('cindy-make-pr/run-2')
              ? [{ number: 7, html_url: 'https://github.com/makecindy/cindy/pull/7' }]
              : [],
          ),
          { status: 200 },
        );
      }
      if (target.endsWith('/pulls/7'))
        return new Response(
          JSON.stringify({
            number: 7,
            html_url: 'https://github.com/makecindy/cindy/pull/7',
            state: 'open',
          }),
          { status: 200 },
        );
      return new Response('{}', { status: 404 });
    });
    let store: Record<string, ContributionRecord> = {};
    const { contribution } = harness({
      git: git as unknown as ContributionDeps['git'],
      fetch: fetchFn as unknown as typeof fetch,
      ledgerPath: () => 'ledger.json',
      readStore: () => structuredClone(store),
      writeStore: (_file, next) => {
        store = structuredClone(next);
      },
    });
    await expect(
      contribution.submit({
        runId: 'run',
        title: 'feat: x',
        body: '',
        name: 'Ada',
        email: 'ada@example.com',
      }),
    ).resolves.toMatchObject({ number: 7, state: 'open' });
    // The occupied `-2` is reconciled against its own open pull request: the
    // change lands there and no third name or second public PR is published.
    expect(pushes).toEqual([
      'refs/heads/cindy-make-pr/run:',
      'refs/heads/cindy-make-pr/run-2:',
      `refs/heads/cindy-make-pr/run-2:${HASH_TIP}`,
    ]);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    expect(store.run).toMatchObject({ number: 7, branch: 'cindy-make-pr/run-2', commit: B });
  });

  it('reports pull request states and caches them briefly', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/1')
        ? new Response(JSON.stringify({ state: 'closed', merged_at: '2026-10-01' }), {
            status: 200,
          })
        : String(url).endsWith('/2')
          ? new Response(JSON.stringify({ state: 'closed', merged_at: null }), { status: 200 })
          : new Response(JSON.stringify({ state: 'open' }), { status: 200 }),
    );
    const { contribution, setStore } = harness({ fetch: fetchFn as unknown as typeof fetch });
    setStore({ a: record('a', 1), b: record('b', 2), c: record('c', 3) });
    const states = await contribution.statuses();
    expect(Object.fromEntries(states.map((view) => [view.runId, view.state]))).toEqual({
      a: 'merged',
      b: 'closed',
      c: 'open',
    });
    await contribution.statuses();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

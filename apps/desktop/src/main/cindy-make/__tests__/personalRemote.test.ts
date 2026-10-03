import os from 'node:os';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PersonalRemoteController,
  PersonalRemoteError,
  classifyRemoteGitError,
  ensureOfficialFork,
  githubAuthEnv,
  inspectPersonalFork,
  parsePersonalRemoteRecord,
  parsePersonalRemoteTrust,
  readGithubIdentity,
  type PersonalForkHealth,
  type PersonalRemoteDeps,
  type PersonalRemoteGitOptions,
  type PersonalRemoteRecord,
} from '../personalRemote';
import type { CindyMakePersonalRemoteState } from '../../../shared/cindyMakePersonalRemote';

vi.mock('../localHistory', async (load) => ({
  ...(await load<typeof import('../localHistory')>()),
  assertNoGitOperation: vi.fn(async () => {}),
  commitPersonalFiles: vi.fn(async () => ({ commit: 'c'.repeat(40), tree: 't'.repeat(40) })),
}));

const TOKEN = 'gho_fake-token-for-tests';
const LOCAL = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const MERGED_TREE = '9'.repeat(40);
const COMBINED = '8'.repeat(40);
const FORK_URL = 'https://github.com/octo/cindy.git';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('parsePersonalRemoteRecord', () => {
  it('keeps a consistent binding and drops invalid or inconsistent fields', () => {
    expect(
      parsePersonalRemoteRecord(
        JSON.stringify({
          schema: 1,
          choice: 'github',
          login: 'Octo',
          repository: 'octo/cindy',
          confirmedAt: 1,
          sync: 'synced',
          syncedAt: 2,
          running: 'save',
        }),
      ),
    ).toEqual({
      schema: 1,
      choice: 'github',
      login: 'Octo',
      repository: 'octo/cindy',
      confirmedAt: 1,
      sync: 'synced',
      syncedAt: 2,
      running: 'save',
    });
    expect(
      parsePersonalRemoteRecord(
        JSON.stringify({ schema: 1, login: 'octo', repository: 'someone/cindy', sync: 'synced' }),
      ),
    ).toEqual({ schema: 1 });
    expect(
      parsePersonalRemoteRecord(
        JSON.stringify({ schema: 1, choice: 'cloud', repository: 'octo/../x', error: 'nope' }),
      ),
    ).toEqual({ schema: 1 });
    expect(parsePersonalRemoteRecord('{not json')).toEqual({ schema: 1 });
    expect(
      parsePersonalRemoteRecord(
        JSON.stringify({ schema: 1, unverifiedRemote: [OTHER, OTHER, 'zz', 3] }),
      ),
    ).toEqual({ schema: 1, unverifiedRemote: [OTHER] });
    // Rewrite lineage survives a disconnect (no binding in the record any more).
    expect(
      parsePersonalRemoteRecord(
        JSON.stringify({
          schema: 1,
          choice: 'local',
          rewrites: [{ from: [OTHER], to: NEWER }],
          unverifiedRemote: [OTHER],
        }),
      ),
    ).toEqual({
      schema: 1,
      choice: 'local',
      rewrites: [{ from: [OTHER], to: NEWER }],
      unverifiedRemote: [OTHER],
    });
    expect(parsePersonalRemoteRecord(JSON.stringify({ schema: 2, choice: 'local' }))).toEqual({
      schema: 1,
    });
    expect(parsePersonalRemoteRecord(null)).toEqual({ schema: 1 });
  });
});

describe('parsePersonalRemoteTrust', () => {
  it('reads the trust facts of a well-formed record and the absence of one', () => {
    expect(parsePersonalRemoteTrust(null)).toEqual({});
    expect(
      parsePersonalRemoteTrust(
        JSON.stringify({
          schema: 1,
          choice: 'local',
          unverifiedRemote: [OTHER],
          rewrites: [{ from: [LOCAL], to: NEWER }],
        }),
      ),
    ).toEqual({ unverifiedRemote: [OTHER], rewrites: [{ from: [LOCAL], to: NEWER }] });
  });

  it('refuses to prove trust from corrupt content or an unknown schema', () => {
    // A tip taken over before the file was corrupted must never read as "no
    // unverified content": the guarded install path has to stay in place.
    for (const raw of [
      '{truncated',
      'null',
      '[]',
      JSON.stringify({ schema: 2, unverifiedRemote: [OTHER] }),
    ]) {
      expect(() => parsePersonalRemoteTrust(raw)).toThrow('unprovable content trust');
    }
  });
});

describe('githubAuthEnv', () => {
  it('scopes the credential to the fork URL and disables other credential prompts', () => {
    const env = githubAuthEnv('octo/cindy', TOKEN, {
      PATH: 'x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_VALUE_0: 'true',
    });
    expect(env).toMatchObject({
      PATH: 'x',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_COUNT: '6',
      GIT_CONFIG_KEY_1: `http.${FORK_URL}.extraheader`,
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'core.hooksPath',
      GIT_CONFIG_VALUE_4: os.devNull,
      GIT_CONFIG_KEY_5: 'core.fsmonitor',
      GIT_CONFIG_VALUE_5: 'false',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(env.GIT_CONFIG_VALUE_1).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
    // The token only appears inside the header value, never in a key or URL.
    const keys = Object.entries(env)
      .filter(([key]) => key !== 'GIT_CONFIG_VALUE_1')
      .map(([key, value]) => key + '=' + value)
      .join('\n');
    expect(keys).not.toContain(TOKEN);
    expect(() => githubAuthEnv('octo/../../etc', TOKEN, {})).toThrow(PersonalRemoteError);
  });
});

describe('classifyRemoteGitError', () => {
  it.each([
    [
      {
        stderr:
          'refusing to allow an OAuth App to create or update workflow without `workflow` scope',
      },
      'workflowScope',
    ],
    [{ stderr: 'fatal: Authentication failed for [REDACTED_URL]' }, 'github'],
    [
      { stderr: 'fatal: unable to access [REDACTED_URL]: The requested URL returned error: 403' },
      'github',
    ],
    [
      { stderr: 'fatal: unable to access [REDACTED_URL]: Could not resolve host: github.com' },
      'network',
    ],
    [{ code: 'cancelled' }, 'network'],
    [{ code: 'busy' }, 'source'],
    [{ stderr: ' ! [rejected] stale info' }, 'failed'],
    [new PersonalRemoteError('forkConflict'), 'forkConflict'],
  ])('maps %o to %s', (error, code) => {
    expect(classifyRemoteGitError(error)).toBe(code);
  });
});

describe('readGithubIdentity', () => {
  it('reports a missing, rejected, unreachable or connected GitHub account', async () => {
    const fetchOk = vi.fn(async () => jsonResponse(200, { login: 'octo' }));
    await expect(
      readGithubIdentity({ readToken: async () => null, fetch: fetchOk }),
    ).resolves.toEqual({
      status: 'missing',
    });
    await expect(
      readGithubIdentity({
        readToken: async () => TOKEN,
        fetch: async () => jsonResponse(401, {}),
      }),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      readGithubIdentity({
        readToken: async () => TOKEN,
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      readGithubIdentity({ readToken: async () => TOKEN, fetch: fetchOk }),
    ).resolves.toEqual({
      status: 'connected',
      identity: { login: 'octo', token: TOKEN },
    });
    expect(fetchOk).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });
});

describe('ensureOfficialFork', () => {
  const identity = { login: 'Octo', token: TOKEN };
  const fork = {
    full_name: 'octo/cindy-1',
    fork: true,
    owner: { login: 'octo' },
    parent: { full_name: 'makecindy/cindy' },
  };

  it('accepts the account fork of the official repository, even when renamed', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(202, fork));
    await expect(ensureOfficialFork(fetchFn, identity)).resolves.toBe('octo/cindy-1');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/makecindy/cindy/forks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ default_branch_only: true }),
      }),
    );
  });

  it('reads the repository when the fork response omits its parent', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { ...fork, parent: undefined }))
      .mockResolvedValueOnce(jsonResponse(200, fork));
    await expect(ensureOfficialFork(fetchFn, identity)).resolves.toBe('octo/cindy-1');
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/octo/cindy-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each([
    [{ ...fork, fork: false }, 'forkConflict'],
    [{ ...fork, parent: { full_name: 'someone/cindy' } }, 'forkConflict'],
    [{ ...fork, full_name: 'someone/cindy', owner: { login: 'someone' } }, 'forkConflict'],
  ])('rejects a repository that is not the account official fork', async (body, code) => {
    await expect(
      ensureOfficialFork(async () => jsonResponse(202, body), identity),
    ).rejects.toMatchObject({ code });
  });

  it('maps rejected credentials and network failures', async () => {
    await expect(
      ensureOfficialFork(async () => jsonResponse(403, {}), identity),
    ).rejects.toMatchObject({ code: 'github' });
    await expect(
      ensureOfficialFork(async () => {
        throw new Error('offline');
      }, identity),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('reuses the account existing fork when a fork cannot be created again', async () => {
    // A repeated fork request that cannot create anything answers 422 instead of
    // the repository; the account's own fork is then accepted on the same checks.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, {}))
      .mockResolvedValueOnce(jsonResponse(200, fork));
    await expect(ensureOfficialFork(fetchFn, identity)).resolves.toBe('octo/cindy-1');
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/Octo/cindy',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('locates a renamed existing fork through the account repositories on 422', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, [{ full_name: 'octo/cindy-1', fork: true }]))
      .mockResolvedValueOnce(jsonResponse(200, fork));
    await expect(ensureOfficialFork(fetchFn, identity)).resolves.toBe('octo/cindy-1');
  });

  it('still rejects on 422 when the account has no official fork', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ...fork, fork: false }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    await expect(ensureOfficialFork(fetchFn, identity)).rejects.toMatchObject({
      code: 'forkConflict',
    });
  });

  it('keeps looking past the first pages of the account repositories', async () => {
    const page = (n: number) =>
      jsonResponse(
        200,
        Array.from({ length: 100 }, (_, i) => ({ full_name: `octo/r${n}-${i}`, fork: false })),
      );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3))
      .mockResolvedValueOnce(jsonResponse(200, [{ full_name: 'octo/cindy-1', fork: true }]))
      .mockResolvedValueOnce(jsonResponse(200, fork));
    await expect(ensureOfficialFork(fetchFn, identity)).resolves.toBe('octo/cindy-1');
  });
});

/** In-memory model of the managed checkout and the fork, driven by the exact Git commands. */
function harness(
  options: {
    record?: PersonalRemoteRecord;
    remote?: string;
    local?: string;
    ancestors?: Array<[string, string]>;
    unbuilt?: boolean;
    identity?: 'connected' | 'missing';
    login?: string;
    pushError?: unknown;
    forkReadyAfter?: number;
    sourceExists?: boolean;
    gitVersion?: string;
    cherry?: string;
    failedBuild?: boolean;
    merges?: string[];
    remergeDiff?: string;
    clearing?: boolean;
    remoteBase?: string;
    officialBase?: string;
    built?: string[];
    settled?: boolean;
    existing?: string;
    forkPoint?: string;
    /** Answer the plumbing that combines this computer's change onto the fork. */
    replay?: boolean;
    replayConflict?: boolean;
    /** Commits that no longer exist locally (for example after clearing the source). */
    missing?: string[];
    /** Never answer this exact Git command, until the test releases it. */
    hangOn?: string;
    /** The source is reserved by Sync: busy for everyone except Sync's own run. */
    reservedBySync?: boolean;
    /** Another local operation moves the personal branch while the upload runs. */
    movedDuringPush?: string;
    /** What GitHub says about the bound repository. */
    health?: PersonalForkHealth | Error;
  } = {},
) {
  let record: PersonalRemoteRecord = options.record ?? { schema: 1 };
  let remoteUrl: string | undefined;
  let remoteTip = options.remote;
  let remoteBase = options.remoteBase;
  let localTip = options.local ?? LOCAL;
  let now = 1_000;
  let lsRemoteCalls = 0;
  let released = false;
  const pendingHang: Array<() => void> = [];
  const calls: Array<{ args: string[]; auth: boolean }> = [];
  const states: CindyMakePersonalRemoteState[] = [];
  const ancestors = new Set((options.ancestors ?? []).map(([a, b]) => a + '>' + b));
  const replayed: Array<{ identity?: PersonalRemoteGitOptions['identity']; message: string }> = [];
  const git = vi.fn(async (args: string[], _cwd: string, opts?: PersonalRemoteGitOptions) => {
    calls.push({ args, auth: !!opts?.auth });
    if (options.hangOn === args.join(' '))
      return new Promise<string>((resolve) => {
        if (released) resolve(localTip);
        else pendingHang.push(() => resolve(localTip));
      });
    // Commits without a patch-equivalent on the other side (`options.cherry` lists them).
    const unique = (options.cherry ?? '')
      .split('\n')
      .filter((line) => line.startsWith('+ '))
      .map((line) => line.slice(2).trim());
    if (args[0] === 'rev-list' && args.includes('--cherry-pick'))
      return args[1] === '--count' ? String(unique.length) : unique.join('\n');
    if (args[0] === 'rev-list' && args.includes('--merges'))
      return args[1] === '--count'
        ? String((options.merges ?? []).length)
        : (options.merges ?? []).join('\n');
    if (options.replay) {
      if (args[0] === 'rev-list' && args[1] === '--reverse') return LOCAL;
      if (args[0] === 'rev-list' && args[1] === '--count') return '1';
      if (args[0] === 'merge-tree') {
        // Git exits 1 when both sides changed the same lines.
        if (options.replayConflict) throw Object.assign(new Error('conflict'), { exitCode: 1 });
        return MERGED_TREE;
      }
      if (args[0] === 'cat-file')
        return [
          `tree ${'e'.repeat(40)}`,
          `parent ${options.forkPoint}`,
          'author Ada Lovelace <ada@example.com> 1700000000 +0800',
          'committer Someone Else <else@example.com> 1700000100 +0800',
          'gpgsig -----BEGIN PGP SIGNATURE-----',
          ' ',
          ' abc',
          ' -----END PGP SIGNATURE-----',
          '',
          'Add a blue button',
          '',
          'Signed-off-by: Ada Lovelace <ada@example.com>',
        ].join('\n');
      if (args.includes('commit-tree')) {
        replayed.push({
          identity: opts?.identity,
          message: readFileSync(args[args.indexOf('-F') + 1], 'utf8'),
        });
        return COMBINED;
      }
      if (args.length === 2 && args[0] === 'rev-parse' && args[1].endsWith('^'))
        return options.forkPoint ?? '';
    }
    if (opts?.auth)
      expect(opts.auth).toEqual({
        repository:
          options.health && !(options.health instanceof Error)
            ? options.health.repository
            : 'octo/cindy',
        token: TOKEN,
      });
    const command = args.join(' ');
    if (command === '--version') return options.gitVersion ?? 'git version 2.45.1';
    if (args[0] === 'rev-list' && args[1] === '--merges') return (options.merges ?? []).join('\n');
    if (args[0] === 'show' && args[1] === '--remerge-diff') return options.remergeDiff ?? '';
    if (args[0] === 'cherry') return options.cherry ?? '';
    if (args[0] === 'show-ref') {
      if (options.failedBuild) return '';
      throw Object.assign(new Error('missing'), { exitCode: 1 });
    }
    if (command === 'rev-parse --verify --quiet refs/heads/cindy-personal^{commit}')
      return localTip;
    if (command === 'rev-parse --verify --quiet refs/remotes/personal/cindy-personal^{commit}')
      return remoteTip ?? '';
    if (command === 'rev-parse --verify --quiet refs/remotes/personal/cindy-personal-base^{commit}')
      return remoteBase ?? '';
    if (args[0] === 'reset' && args[1] === '--keep') {
      localTip = args[2];
      return '';
    }
    if (command === 'rev-parse --abbrev-ref HEAD') return 'cindy-personal';
    if (command.startsWith('rev-parse ') && command.endsWith('^{tree}')) return 'e'.repeat(40);
    if (command === 'status --porcelain') return '';
    if (command === 'config --get remote.personal.url') {
      if (remoteUrl === undefined) throw Object.assign(new Error('missing'), { exitCode: 1 });
      return remoteUrl;
    }
    if (args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url')) {
      remoteUrl = args[3];
      return '';
    }
    if (command === 'remote remove personal') {
      remoteUrl = undefined;
      return '';
    }
    if (command === `ls-remote --heads ${FORK_URL}`) {
      lsRemoteCalls += 1;
      if (lsRemoteCalls <= (options.forkReadyAfter ?? 0))
        throw Object.assign(new Error('not found'), { stderr: 'fatal: repository not found' });
      return `${OTHER}\trefs/heads/main`;
    }
    if (
      command ===
      'ls-remote --refs personal refs/heads/cindy-personal refs/heads/cindy-personal-base'
    )
      return [
        remoteTip ? `${remoteTip}\trefs/heads/cindy-personal` : '',
        remoteBase ? `${remoteBase}\trefs/heads/cindy-personal-base` : '',
      ].join('\n');
    if (args[0] === 'fetch' || args[0] === 'update-ref') return '';
    if (args[0] === 'merge-base' && options.missing?.some((commit) => args.includes(commit)))
      throw Object.assign(new Error('not a valid commit'), { exitCode: 128 });
    if (args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
      if (options.forkPoint) return options.forkPoint;
      throw Object.assign(new Error('no merge base'), { exitCode: 1 });
    }
    if (args[0] === 'merge-base') {
      if (ancestors.has(args[2] + '>' + args[3])) return '';
      throw Object.assign(new Error('not ancestor'), { exitCode: 1 });
    }
    if (args[0] === 'push') {
      if (options.pushError) throw options.pushError;
      for (const spec of args.filter((arg) => /^[0-9a-f]{40}:refs\/heads\//.test(arg))) {
        const [commit, ref] = spec.split(':');
        if (ref === 'refs/heads/cindy-personal') remoteTip = commit;
        if (ref === 'refs/heads/cindy-personal-base') remoteBase = commit;
      }
      if (options.movedDuringPush) localTip = options.movedDuringPush;
      return '';
    }
    throw new Error('unexpected git ' + command);
  });
  const ensureFork = vi.fn(async () => 'octo/cindy');
  const deps: PersonalRemoteDeps = {
    source: 'source',
    read: () => structuredClone(record),
    write: (next) => {
      record = structuredClone(next);
    },
    identity: async () =>
      options.identity === 'missing'
        ? { status: 'missing' }
        : { status: 'connected', identity: { login: options.login ?? 'octo', token: TOKEN } },
    ensureFork,
    git,
    sourceExists: () => options.sourceExists ?? true,
    withProject: (run) => run(),
    withSourceUse: (run) => {
      if (options.clearing) throw Object.assign(new Error('clearing'), { code: 'busy' });
      return run();
    },
    hasUnbuiltChanges: async () => options.unbuilt ?? false,
    findPersonalFork: async () => options.existing,
    ...(options.health
      ? {
          inspectFork: async () => {
            if (options.health instanceof Error) throw options.health;
            return options.health!;
          },
        }
      : {}),
    isBuilt: (commit) => (options.built ?? []).includes(commit),
    sourceSettled: (withinSync) =>
      options.reservedBySync ? withinSync : (options.settled ?? true),
    officialBase: async () => options.officialBase,
    sourceChanged: vi.fn(),
    publish: (state) => states.push(state),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  const controller = new PersonalRemoteController(deps);
  return {
    controller,
    calls,
    states,
    ensureFork,
    releaseHang: () => {
      released = true;
      for (const release of pendingHang.splice(0)) release();
    },
    record: () => record,
    remoteTip: () => remoteTip,
    remoteBase: () => remoteBase,
    localTip: () => localTip,
    setLocal: (commit: string) => {
      localTip = commit;
    },
    addAncestor: (ancestor: string, descendant: string) =>
      ancestors.add(ancestor + '>' + descendant),
    sourceChanged: deps.sourceChanged as ReturnType<typeof vi.fn>,
    remoteUrl: () => remoteUrl,
    pushes: () => calls.filter((call) => call.args[0] === 'push').map((call) => call.args),
    replayed,
    commands: () => calls.map((call) => call.args.join(' ')),
  };
}

describe('inspectPersonalFork', () => {
  const identity = { login: 'octo', token: TOKEN };
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

  it('reads the repository without following redirects with the credential', async () => {
    const fetchFn = vi.fn(async () =>
      reply(200, {
        full_name: 'octo/cindy',
        archived: false,
        fork: true,
        owner: { login: 'octo' },
        parent: { full_name: 'makecindy/cindy' },
        permissions: { push: true },
      }),
    );
    await expect(
      inspectPersonalFork(fetchFn as unknown as typeof fetch, identity, 'octo/cindy'),
    ).resolves.toEqual({ repository: 'octo/cindy', archived: false, canPush: true });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/octo/cindy',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('reports a deleted repository and finds a renamed one through the account’s fork', async () => {
    const missing = vi.fn(async () => reply(404));
    await expect(
      inspectPersonalFork(missing as unknown as typeof fetch, identity, 'octo/cindy'),
    ).rejects.toMatchObject({ code: 'forkMissing' });

    const renamed = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/octo/cindy'))
        return reply(301, undefined, { Location: 'https://api.github.com/repositories/1' });
      if (url === 'https://api.github.com/repositories/1')
        return reply(200, {
          full_name: 'octo/my-cindy',
          archived: false,
          fork: true,
          owner: { login: 'octo' },
          parent: { full_name: 'makecindy/cindy' },
          permissions: { push: true },
        });
      throw new Error('unexpected ' + url);
    });
    await expect(
      inspectPersonalFork(renamed as unknown as typeof fetch, identity, 'octo/cindy'),
    ).resolves.toMatchObject({ repository: 'octo/my-cindy' });
    // Never creates a fork, and never follows a redirect elsewhere with the credential.
    expect(renamed.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/octo/cindy',
      'https://api.github.com/repositories/1',
    ]);
    const elsewhere = vi.fn(async () =>
      reply(301, undefined, { Location: 'https://example.com/repositories/1' }),
    );
    await expect(
      inspectPersonalFork(elsewhere as unknown as typeof fetch, identity, 'octo/cindy'),
    ).rejects.toMatchObject({ code: 'forkMissing' });
    expect(elsewhere).toHaveBeenCalledOnce();
  });

  it('reports a stale binding when the saved name is no longer the official fork', async () => {
    // The fork was deleted and an unrelated repository now answers under the name:
    // the managed branches must never be pushed into it.
    const unrelated = vi.fn(async () =>
      reply(200, {
        full_name: 'octo/cindy',
        archived: false,
        fork: false,
        owner: { login: 'octo' },
        permissions: { push: true },
      }),
    );
    await expect(
      inspectPersonalFork(unrelated as unknown as typeof fetch, identity, 'octo/cindy'),
    ).rejects.toMatchObject({ code: 'forkMissing' });
    const foreignFork = vi.fn(async () =>
      reply(200, {
        full_name: 'octo/cindy',
        archived: false,
        fork: true,
        owner: { login: 'octo' },
        parent: { full_name: 'someone/else' },
        permissions: { push: true },
      }),
    );
    await expect(
      inspectPersonalFork(foreignFork as unknown as typeof fetch, identity, 'octo/cindy'),
    ).rejects.toMatchObject({ code: 'forkMissing' });
  });
});

describe('PersonalRemoteController', () => {
  it('keeps offering GitHub until it is bound or the user keeps the version local', async () => {
    const h = harness();
    expect(await h.controller.refresh()).toMatchObject({ offerMigration: true, sourceReady: true });
    expect((await harness({ identity: 'missing' }).controller.refresh()).offerMigration).toBe(
      false,
    );
    // Without a prepared source the offer stays; saving prepares the source first.
    expect(await harness({ sourceExists: false }).controller.refresh()).toMatchObject({
      offerMigration: true,
      sourceReady: false,
    });
    expect(
      (await harness({ record: { schema: 1, choice: 'local' } }).controller.refresh())
        .offerMigration,
    ).toBe(false);
    expect(
      (
        await harness({
          record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
        }).controller.refresh()
      ).offerMigration,
    ).toBe(false);
  });

  it('tells a new computer that the account already has a personal version', async () => {
    const h = harness({ existing: 'octo/cindy' });
    expect((await h.controller.refresh()).existingPersonal).toBe('octo/cindy');
  });

  it('binds the fork and uploads the established personal version with an empty lease', async () => {
    const h = harness();
    expect(h.controller.save()).toMatchObject({ running: 'save', step: 'waiting' });
    await h.controller.settled();
    expect(h.record()).toMatchObject({
      schema: 1,
      choice: 'github',
      login: 'octo',
      repository: 'octo/cindy',
      sync: 'synced',
      syncedAt: expect.any(Number),
    });
    expect(h.record().running).toBeUndefined();
    expect(h.remoteUrl()).toBe(FORK_URL);
    expect(h.pushes()).toEqual([
      [
        'push',
        '--porcelain',
        '--atomic',
        '--no-verify',
        '--no-follow-tags',
        '--force-with-lease=refs/heads/cindy-personal:',
        'personal',
        `${LOCAL}:refs/heads/cindy-personal`,
      ],
    ]);
    // Only network commands carry the credential.
    for (const call of h.calls)
      expect(call.auth).toBe(['ls-remote', 'fetch', 'push'].includes(call.args[0]));
    expect(h.record().syncedCommit).toBe(LOCAL);
    expect(h.states.map((state) => state.step).filter(Boolean)).toEqual(
      expect.arrayContaining(['waiting', 'preparing', 'fork', 'connecting', 'uploading']),
    );
    expect(h.states.at(-1)).toMatchObject({
      repository: 'octo/cindy',
      sync: 'synced',
      offerMigration: false,
    });
    expect(h.states.at(-1)?.running).toBeUndefined();
  });

  it('fast-forwards the fork with a lease on the remote commit it was compared against', async () => {
    const h = harness({ remote: OLDER, ancestors: [[OLDER, LOCAL]] });
    h.controller.save();
    await h.controller.settled();
    expect(h.pushes()[0]).toContain(`--force-with-lease=refs/heads/cindy-personal:${OLDER}`);
    expect(h.record().sync).toBe('synced');
  });

  it.each([
    [{ remote: LOCAL }, 'synced'],
    [{ remote: NEWER, ancestors: [[LOCAL, NEWER]] as Array<[string, string]> }, 'remoteAhead'],
    [{ remote: OTHER }, 'diverged'],
    [{ unbuilt: true }, 'pendingBuild'],
  ])('never overwrites the fork when it is not strictly behind (%o)', async (options, sync) => {
    const h = harness(options);
    h.controller.save();
    await h.controller.settled();
    expect(h.pushes()).toEqual([]);
    expect(h.record()).toMatchObject({ repository: 'octo/cindy', sync });
    expect(h.record().error).toBeUndefined();
  });

  it('waits for a newly created fork to serve refs', async () => {
    const h = harness({ forkReadyAfter: 2 });
    h.controller.save();
    await h.controller.settled();
    expect(h.record().sync).toBe('synced');
  });

  it('gives up on a fork that never becomes reachable, without binding it', async () => {
    const h = harness({ forkReadyAfter: Number.POSITIVE_INFINITY });
    h.controller.save();
    await h.controller.settled();
    expect(h.record()).toEqual({ schema: 1, error: 'forkUnavailable' });
    // The offer stays, now carrying the reason, so saving again is the retry.
    expect(h.controller.state()).toMatchObject({ offerMigration: true, error: 'forkUnavailable' });
  });

  it('retrieves a newer version another computer uploaded and keeps it marked until generated', async () => {
    const BASE = 'e'.repeat(40);
    const h = harness({
      remote: NEWER,
      remoteBase: BASE,
      ancestors: [
        [LOCAL, NEWER],
        [BASE, NEWER],
      ],
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.pushes()).toEqual([]);
    expect(h.commands()).toContain(
      `update-ref refs/cindy-make/backups/personal-remote-local/${LOCAL} ${LOCAL}`,
    );
    expect(h.commands()).toContain(`reset --keep ${NEWER}`);
    expect(h.commands()).toContain(`update-ref refs/cindy-make/personal-upstream ${BASE}`);
    expect(h.localTip()).toBe(NEWER);
    expect(h.record()).toMatchObject({ sync: 'retrieved', syncedCommit: NEWER });
    expect(h.sourceChanged).toHaveBeenCalledOnce();
    // Still not generated: a later check keeps saying so.
    h.controller.sync();
    await h.controller.settled();
    expect(h.record().sync).toBe('retrieved');
  });

  it('does not move the personal source while a generation or official update owns it', async () => {
    const h = harness({
      remote: NEWER,
      remoteBase: 'e'.repeat(40),
      ancestors: [[LOCAL, NEWER]],
      settled: false,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.localTip()).toBe(LOCAL);
    // Reported as busy, so Sync says to try again rather than offering to replace anything.
    expect(h.record().sync).toBe('pending');
  });

  it('starts a fresh computer from the version on GitHub', async () => {
    const BASE = 'e'.repeat(40);
    const h = harness({
      remote: NEWER,
      remoteBase: BASE,
      officialBase: LOCAL,
      cherry: `+ ${LOCAL}`,
      ancestors: [[BASE, NEWER]],
    });
    h.controller.save();
    await h.controller.settled();
    expect(h.localTip()).toBe(NEWER);
    expect(h.record()).toMatchObject({
      repository: 'octo/cindy',
      sync: 'retrieved',
      // The taken-over fork tip is content this computer has not verified yet.
      unverifiedRemote: [NEWER],
    });
  });

  it('publishes the official base next to the personal version', async () => {
    const BASE = 'e'.repeat(40);
    const h = harness({ officialBase: BASE, ancestors: [[BASE, LOCAL]] });
    h.controller.save();
    await h.controller.settled();
    expect(h.pushes()[0]).toEqual(
      expect.arrayContaining([
        '--force-with-lease=refs/heads/cindy-personal-base:',
        `${BASE}:refs/heads/cindy-personal-base`,
      ]),
    );
    expect(h.remoteBase()).toBe(BASE);
  });

  it('synchronizes once before a new task starts', async () => {
    const h = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await h.controller.syncBeforeTask();
    expect(h.pushes()).toHaveLength(1);
    await harness().controller.syncBeforeTask();
  });

  it('waits for an operation already running only up to the task budget', async () => {
    const h = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
      hangOn: 'rev-parse --verify --quiet refs/heads/cindy-personal^{commit}',
    });
    h.controller.sync();
    const started = Date.now();
    await h.controller.syncBeforeTask(25);
    // The new task is not held hostage by the slow earlier operation.
    expect(Date.now() - started).toBeLessThan(2_000);
    h.releaseHang();
    await h.controller.settled();
    expect(h.pushes()).toHaveLength(1);
  });

  it('remembers taken-over fork tips without repeating them', () => {
    const h = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    h.controller.recordUnverifiedRemote(OTHER);
    h.controller.recordUnverifiedRemote(OTHER);
    h.controller.recordUnverifiedRemote('not-a-commit');
    expect(h.record().unverifiedRemote).toEqual([OTHER]);
    // An adopted rewrite carries the unverified content under its new commit:
    // the tip list follows the content, however often history is rewritten.
    h.controller.recordRewrite([LOCAL], NEWER);
    expect(h.record().unverifiedRemote).toEqual([OTHER, NEWER]);
    // Old entries are never evicted by new ones: a live source stays listed until
    // a generated personal version covers it (see `remoteContentScriptsUnverified`).
    for (let i = 0; i < 20; i += 1) h.controller.recordUnverifiedRemote(String(i).padStart(40, 'a'));
    expect(h.record().unverifiedRemote).toContain(OTHER);
    expect(h.record().unverifiedRemote).toHaveLength(22);
  });

  it('carries unverified provenance through rewrites even without a binding', () => {
    const h = harness({ record: { schema: 1, unverifiedRemote: [OTHER] } });
    h.controller.recordRewrite([LOCAL], NEWER);
    expect(h.record().rewrites).toEqual([{ from: [LOCAL], to: NEWER }]);
    expect(h.record().unverifiedRemote).toEqual([OTHER, NEWER]);
  });

  it('requires a connected GitHub account and the bound login', async () => {
    const missing = harness({ identity: 'missing' });
    missing.controller.save();
    await missing.controller.settled();
    expect(missing.ensureFork).not.toHaveBeenCalled();
    expect(missing.record()).toEqual({ schema: 1, error: 'github' });

    const mismatch = harness({
      login: 'someone',
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        sync: 'synced',
      },
    });
    expect((await mismatch.controller.refresh()).error).toBe('account');
    mismatch.controller.sync();
    await mismatch.controller.settled();
    expect(mismatch.pushes()).toEqual([]);
    expect(mismatch.record().error).toBe('account');
  });

  it('keeps the binding and marks the upload pending when pushing fails', async () => {
    const h = harness({
      pushError: Object.assign(new Error('push failed'), {
        stderr:
          'refusing to allow an OAuth App to create or update workflow without workflow scope',
      }),
    });
    h.controller.save();
    await h.controller.settled();
    expect(h.record()).toMatchObject({
      repository: 'octo/cindy',
      sync: 'pending',
      error: 'workflowScope',
    });
  });

  it('turns an operation interrupted by a restart into a visible, non-replayed failure', () => {
    const h = harness({
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        running: 'sync',
      },
    });
    expect(h.record()).toEqual({
      schema: 1,
      choice: 'github',
      login: 'octo',
      repository: 'octo/cindy',
      error: 'interrupted',
    });
    expect(h.calls).toEqual([]);
  });

  it('records a local-only choice and disconnects without touching the fork', async () => {
    const local = harness();
    expect(local.controller.keepLocal()).toMatchObject({ choice: 'local', offerMigration: false });

    const bound = harness();
    bound.controller.save();
    await bound.controller.settled();
    await expect(bound.controller.disconnect()).resolves.toMatchObject({ choice: 'local' });
    expect(bound.remoteUrl()).toBeUndefined();
    expect(bound.record()).toEqual({ schema: 1, choice: 'local' });
    expect(bound.pushes()).toHaveLength(1);
  });

  it('replaces its own upload after an official update rewrote the hashes, keeping a backup', async () => {
    const h = harness({
      remote: OLDER,
      cherry: `- ${OLDER}`,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        sync: 'synced',
        syncedCommit: OLDER,
      },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.commands()).toContain(
      `update-ref refs/cindy-make/backups/personal-remote/${OLDER} ${OLDER}`,
    );
    expect(h.pushes()[0]).toContain(`--force-with-lease=refs/heads/cindy-personal:${OLDER}`);
    expect(h.record()).toMatchObject({ sync: 'synced', syncedCommit: LOCAL });
  });

  it('accepts integration merges that add nothing beyond their automatic result', async () => {
    const h = harness({
      remote: OLDER,
      cherry: `- ${OLDER}`,
      merges: [OTHER],
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: OLDER,
      },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.record().sync).toBe('synced');
    expect(h.commands()).toContain(
      `show --remerge-diff --no-ext-diff --no-color --format= ${OTHER}`,
    );
  });

  it.each([
    ['another computer wrote the fork version', { syncedCommit: NEWER, cherry: `- ${OLDER}` }],
    ['the fork has a change this computer lacks', { syncedCommit: OLDER, cherry: `+ ${OLDER}` }],
    [
      'a merge on the fork carries its own resolution',
      { syncedCommit: OLDER, cherry: `- ${OLDER}`, merges: [OTHER], remergeDiff: '+resolved' },
    ],
  ])('refuses to replace a rewritten fork when %s', async (_case, options) => {
    const h = harness({
      remote: OLDER,
      cherry: options.cherry,
      merges: 'merges' in options ? options.merges : undefined,
      remergeDiff: 'remergeDiff' in options ? options.remergeDiff : undefined,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: options.syncedCommit,
      },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.pushes()).toEqual([]);
    expect(h.record().sync).toBe('diverged');
  });

  const BASE = 'f'.repeat(40);
  /** The fork and this computer each added a change on the same published official base. */
  const bothChanged = {
    remote: OTHER,
    remoteBase: BASE,
    cherry: `+ ${LOCAL}`,
    officialBase: BASE,
    forkPoint: BASE,
    ancestors: [
      [BASE, OTHER],
      [BASE, BASE],
    ] as Array<[string, string]>,
    replay: true,
  };

  it('uploads the combined version first, then moves this computer to it', async () => {
    const h = harness(bothChanged);
    h.controller.save();
    await h.controller.settled();
    expect(h.pushes()).toHaveLength(1);
    expect(h.pushes()[0]).toContain(`${COMBINED}:refs/heads/cindy-personal`);
    expect(h.pushes()[0]).toContain(`--force-with-lease=refs/heads/cindy-personal:${OTHER}`);
    expect(h.localTip()).toBe(COMBINED);
    expect(h.record()).toMatchObject({ sync: 'retrieved', syncedCommit: COMBINED });
    const commands = h.commands();
    expect(commands.indexOf(`reset --keep ${COMBINED}`)).toBeGreaterThan(
      commands.findIndex((command) => command.startsWith('push ')),
    );
    expect(commands).toContain(
      `update-ref refs/cindy-make/backups/personal-remote-local/${LOCAL} ${LOCAL}`,
    );
    // The raw commit keeps its author, date and exact message; signatures are not copied.
    expect(h.replayed).toEqual([
      {
        identity: { name: 'Ada Lovelace', email: 'ada@example.com', date: '1700000000 +0800' },
        message: 'Add a blue button\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n',
      },
    ]);
  });

  it('leaves this computer untouched when the combined upload fails', async () => {
    const h = harness({
      ...bothChanged,
      pushError: Object.assign(new Error('offline'), { stderr: 'Could not resolve host' }),
    });
    h.controller.save();
    await h.controller.settled();
    expect(h.localTip()).toBe(LOCAL);
    expect(h.commands().some((command) => command.startsWith('reset'))).toBe(false);
    expect(h.record()).toMatchObject({ sync: 'pending', error: 'network' });
  });

  it('keeps a change made during the upload and combines again next time', async () => {
    const h = harness({ ...bothChanged, movedDuringPush: NEWER });
    h.controller.save();
    await h.controller.settled();
    expect(h.localTip()).toBe(NEWER);
    expect(h.commands().some((command) => command.startsWith('reset'))).toBe(false);
    // The fork holds what this computer uploaded, so a later sync may build on it.
    expect(h.record()).toMatchObject({ sync: 'pending', syncedCommit: COMBINED });
  });

  it.each([
    // An isolated rebase still works with an older Git; the user starts it.
    ['Git cannot combine without a checkout', { gitVersion: 'git version 2.39.2' }, 'needsMerge'],
    // Official lines that do not follow each other cannot be combined safely.
    ['the fork is on an unrelated official version', { remoteBase: NEWER }, 'diverged'],
    // Without a published base the fork may already contain a newer official version.
    ['the fork publishes no official base', { remoteBase: undefined }, 'diverged'],
    // Temporary: combined once the source is idle again.
    ['a generation is still running', { settled: false }, 'pending'],
  ])('reports both sides instead of combining them when %s', async (_case, extra, sync) => {
    const h = harness({ ...bothChanged, ...extra });
    h.controller.save();
    await h.controller.settled();
    expect(h.commands().some((command) => command.startsWith('merge-tree'))).toBe(false);
    expect(h.pushes()).toEqual([]);
    expect(h.localTip()).toBe(LOCAL);
    expect(h.record().sync).toBe(sync);
  });

  it('asks for a combine when both sides changed the same place', async () => {
    const h = harness({ ...bothChanged, replayConflict: true });
    h.controller.save();
    await h.controller.settled();
    // The automatic replay hits a conflict: nothing moves, the user decides.
    expect(h.pushes()).toEqual([]);
    expect(h.localTip()).toBe(LOCAL);
    expect(h.record().sync).toBe('needsMerge');
  });

  it('gives Sync the fetched GitHub version and marks the upload after its combine', async () => {
    const h = harness({
      ...bothChanged,
      replayConflict: true,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: OLDER,
      },
    });
    await expect(h.controller.syncNow()).resolves.toBe('needsMerge');
    await expect(h.controller.fetchedTips()).resolves.toEqual({ commit: OTHER, base: BASE });
    // Sync combined and adopted it: the upload says the other computer's changes need generating.
    h.controller.recordRewrite([LOCAL, OTHER], COMBINED);
    h.setLocal(COMBINED);
    h.addAncestor(OTHER, COMBINED);
    await expect(h.controller.syncNow()).resolves.toBe('retrieved');
    expect(h.pushes()[0]).toContain(`${COMBINED}:refs/heads/cindy-personal`);
    expect(h.record().syncedCommit).toBe(COMBINED);
  });

  it.each([
    ['deleted', new PersonalRemoteError('forkMissing'), 'forkMissing'],
    ['archived', { repository: 'octo/cindy', archived: true, canPush: true }, 'forkArchived'],
    ['read-only', { repository: 'octo/cindy', archived: false, canPush: false }, 'github'],
  ] as const)('stops before uploading to a %s repository', async (_case, health, error) => {
    const h = harness({
      health,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.syncNow()).rejects.toMatchObject({ code: error });
    expect(h.pushes()).toEqual([]);
    // The binding stays, so the row can offer the right fix.
    expect(h.record().repository).toBe('octo/cindy');
  });

  it('follows a repository renamed on GitHub under the same account', async () => {
    const h = harness({
      health: { repository: 'octo/my-cindy', archived: false, canPush: true },
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await h.controller.syncNow();
    expect(h.record().repository).toBe('octo/my-cindy');
    expect(h.remoteUrl()).toBe('https://github.com/octo/my-cindy.git');
  });

  it('never follows a rename to another account', async () => {
    const h = harness({
      health: { repository: 'mallory/cindy', archived: false, canPush: true },
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.syncNow()).rejects.toMatchObject({ code: 'forkConflict' });
    expect(h.record().repository).toBe('octo/cindy');
  });

  it('takes another computer’s rewrite of the version this computer last synced', async () => {
    // Nothing new here since the last sync: the newer GitHub version is used as it is.
    const h = harness({
      ...bothChanged,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: LOCAL,
      },
    });
    await expect(h.controller.syncNow()).resolves.toBe('retrieved');
    expect(h.localTip()).toBe(OTHER);
    expect(h.pushes()).toEqual([]);
    expect(h.commands()).toContain(
      `update-ref refs/cindy-make/backups/personal-remote-local/${LOCAL} ${LOCAL}`,
    );
  });

  it('keeps the GitHub version when chosen, backing up this computer’s', async () => {
    const h = harness({
      ...bothChanged,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.keepSide('github')).resolves.toBe('retrieved');
    expect(h.localTip()).toBe(OTHER);
    expect(h.pushes()).toEqual([]);
    expect(h.commands()).toContain(
      `update-ref refs/cindy-make/backups/personal-remote-local/${LOCAL} ${LOCAL}`,
    );
    expect(h.record()).toMatchObject({ sync: 'retrieved', syncedCommit: OTHER });
  });

  it('keeps this computer’s version when chosen, backing up GitHub’s on GitHub too', async () => {
    const h = harness({
      ...bothChanged,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.keepSide('local')).resolves.toBe('synced');
    const [push] = h.pushes();
    expect(push).toEqual(
      expect.arrayContaining([
        '--atomic',
        `--force-with-lease=refs/heads/cindy-personal-backup/${OTHER.slice(0, 12)}:`,
        `--force-with-lease=refs/heads/cindy-personal:${OTHER}`,
        `${OTHER}:refs/heads/cindy-personal-backup/${OTHER.slice(0, 12)}`,
        `${LOCAL}:refs/heads/cindy-personal`,
      ]),
    );
    expect(h.remoteTip()).toBe(LOCAL);
    expect(h.localTip()).toBe(LOCAL);
  });

  it('never uploads a version that is not generated, even when chosen', async () => {
    const h = harness({
      ...bothChanged,
      unbuilt: true,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.keepSide('local')).resolves.toBe('buildFirst');
    expect(h.pushes()).toEqual([]);
  });

  it('asks to generate first when both computers changed it and this one’s are not generated', async () => {
    const h = harness({
      ...bothChanged,
      unbuilt: true,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(h.controller.syncNow()).resolves.toBe('buildFirst');
    expect(h.pushes()).toEqual([]);
    expect(h.localTip()).toBe(LOCAL);
  });

  it('decides on the current facts after a run that was already in progress', async () => {
    const h = harness({
      ...bothChanged,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    // An automatic run started before Sync reserved the source.
    h.controller.autoSync();
    const synced = h.controller.syncNow();
    await expect(synced).resolves.toBeDefined();
    // Two runs: the automatic one and Sync's own.
    expect(h.calls.filter((call) => call.args[0] === 'ls-remote')).toHaveLength(2);
  });

  it('reports a failed sync to the Sync pipeline as its error code', async () => {
    const h = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
      identity: 'missing',
    });
    await expect(h.controller.syncNow()).rejects.toMatchObject({ code: 'github' });
  });

  it.each([
    // An official update whose conflict resolution changed this computer's patches.
    ['an official update rewrote this computer’s upload', [[OLDER], COMBINED], OLDER],
    // This computer was on the newer official version; GitHub's changes went onto it.
    ['a combine carried GitHub’s version into this one', [[OLDER, OTHER], COMBINED], OTHER],
  ] as const)('replaces the fork when %s', async (_case, [from, to], remote) => {
    const h = harness({
      remote,
      local: COMBINED,
      cherry: `+ ${remote}`,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: OLDER,
        rewrites: [{ from: [...from], to }],
      },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.pushes()[0]).toContain(`--force-with-lease=refs/heads/cindy-personal:${remote}`);
    expect(h.commands()).toContain(
      `update-ref refs/cindy-make/backups/personal-remote/${remote} ${remote}`,
    );
  });

  it('never lets old lineage replace the fork with a freshly prepared source', async () => {
    const BASE = 'f'.repeat(40);
    // The source was cleared and prepared again: only official commits, no personal ones.
    const h = harness({
      remote: COMBINED,
      local: BASE,
      officialBase: BASE,
      ancestors: [[BASE, COMBINED]],
      cherry: `+ ${COMBINED}`,
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        syncedCommit: COMBINED,
        rewrites: [{ from: [OLDER], to: COMBINED }],
      },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.pushes()).toEqual([]);
    expect(h.localTip()).toBe(COMBINED);
    expect(h.record().sync).toBe('retrieved');
  });

  it('asks for a combine when one computer is on a newer official version', async () => {
    const h = harness({
      ...bothChanged,
      remoteBase: NEWER,
      ancestors: [...bothChanged.ancestors, [BASE, NEWER], [NEWER, OTHER]],
    });
    h.controller.save();
    await h.controller.settled();
    expect(h.commands().some((command) => command.startsWith('merge-tree'))).toBe(false);
    expect(h.pushes()).toEqual([]);
    expect(h.record().sync).toBe('needsMerge');
  });

  it('does not count Sync’s own source reservation as busy', async () => {
    // Automatic syncs see the reserved source as busy and wait.
    const automatic = harness({ ...bothChanged, replayConflict: true, reservedBySync: true });
    automatic.controller.save();
    await automatic.controller.settled();
    expect(automatic.record().sync).toBe('pending');
    // Sync's own run can still combine.
    const own = harness({
      ...bothChanged,
      replayConflict: true,
      reservedBySync: true,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    await expect(own.controller.syncNow()).resolves.toBe('needsMerge');
  });

  it('ignores lineage about commits a re-prepared source no longer has', async () => {
    const BASE = 'f'.repeat(40);
    const GONE = '7'.repeat(40);
    const h = harness({
      remote: COMBINED,
      local: BASE,
      officialBase: BASE,
      ancestors: [[BASE, COMBINED]],
      missing: [GONE],
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        rewrites: [{ from: [GONE], to: GONE }],
      },
    });
    // The stale record must not break Sync: GitHub's version is retrieved as usual.
    await expect(h.controller.syncNow()).resolves.toBe('retrieved');
    expect(h.localTip()).toBe(COMBINED);

    // Also where the replace check consults the lineage: it proves nothing, nothing breaks.
    const other = harness({
      remote: COMBINED,
      local: NEWER,
      officialBase: NEWER,
      missing: [GONE],
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        rewrites: [{ from: [GONE], to: GONE }],
      },
    });
    await expect(other.controller.syncNow()).resolves.toBe('diverged');
    expect(other.pushes()).toEqual([]);
  });

  it('records each adopted rewrite once and keeps the newest ones', () => {
    const h = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    h.controller.recordRewrite([OLDER], NEWER);
    h.controller.recordRewrite([OLDER], NEWER);
    h.controller.recordRewrite(['not-a-commit'], OTHER);
    expect(h.record().rewrites).toEqual([{ from: [OLDER], to: NEWER }]);
  });

  it('never uploads a commit retained by a failed generation', async () => {
    const h = harness({ failedBuild: true });
    h.controller.save();
    await h.controller.settled();
    expect(h.pushes()).toEqual([]);
    expect(h.record().sync).toBe('pendingBuild');
  });

  it('stops before creating a fork when Git cannot carry a per-command credential', async () => {
    const h = harness({ gitVersion: 'git version 2.35.1' });
    h.controller.save();
    await h.controller.settled();
    expect(h.ensureFork).not.toHaveBeenCalled();
    expect(h.record()).toEqual({ schema: 1, error: 'gitOutdated' });
  });

  it('clears connection errors that a reconnect or login switch resolved', async () => {
    const github = harness({ record: { schema: 1, error: 'github' } });
    expect((await github.controller.refresh()).error).toBeUndefined();
    const account = harness({
      record: { schema: 1, login: 'octo', repository: 'octo/cindy', error: 'account' },
    });
    expect((await account.controller.refresh()).error).toBeUndefined();
    const workflow = harness({
      record: { schema: 1, login: 'octo', repository: 'octo/cindy', error: 'workflowScope' },
    });
    expect((await workflow.controller.refresh()).error).toBe('workflowScope');
  });

  it('shows new local content as not yet synced', async () => {
    const h = harness({
      record: {
        schema: 1,
        choice: 'github',
        login: 'octo',
        repository: 'octo/cindy',
        sync: 'synced',
        syncedCommit: OLDER,
      },
    });
    expect((await h.controller.refresh()).sync).toBe('pending');
  });

  it('synchronizes automatically only for a bound GitHub choice', async () => {
    const unbound = harness();
    unbound.controller.autoSync();
    await unbound.controller.settled();
    expect(unbound.calls).toEqual([]);

    const bound = harness({
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    bound.controller.autoSync();
    await bound.controller.settled();
    expect(bound.pushes()).toHaveLength(1);
    expect(bound.record().sync).toBe('synced');
  });

  it('does not touch a checkout that is being cleared', async () => {
    const h = harness({
      clearing: true,
      record: { schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' },
    });
    h.controller.sync();
    await h.controller.settled();
    expect(h.calls).toEqual([]);
    expect(h.record().error).toBe('source');
  });

  it('refuses a sync request without a bound repository', () => {
    expect(() => harness().controller.sync()).toThrow(PersonalRemoteError);
  });
});

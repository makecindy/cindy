import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSourceRevisions } from '../sourceRevisions.js';
import { runSourceGit } from '../sourceGit.js';
import type { MakeToolchainEnvironment } from '../toolchainEnvironment.js';

vi.mock('../sourceGit.js', () => ({ runSourceGit: vi.fn() }));

const personal = 'a'.repeat(40);
const baseline = 'b'.repeat(40);
const localMain = 'c'.repeat(40);
const remoteMain = 'd'.repeat(40);
const env = { processEnvironment: () => ({}) } as MakeToolchainEnvironment;
let outputs: Record<string, string | Error>;

beforeEach(() => {
  outputs = {
    ['merge-base ' + personal + ' ' + remoteMain]: baseline,
    'rev-parse --verify refs/heads/main^{commit}': localMain,
    'rev-parse --verify refs/remotes/origin/main^{commit}': remoteMain,
    'rev-parse --abbrev-ref HEAD': 'main',
    ['rev-list --left-right --count ' + localMain + '...' + remoteMain]: '0	4',
  };
  vi.mocked(runSourceGit)
    .mockReset()
    .mockImplementation(async (_env, args) => {
      const result = outputs[args.join(' ')];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error('Unexpected Git query: ' + args.join(' '));
      return result;
    });
});

const read = (signal = new AbortController().signal) =>
  readSourceRevisions(env, 'managed-source', personal, remoteMain, signal);

describe('source revision snapshot', () => {
  it('distinguishes the personal ancestor, local main, and fetched origin/main', async () => {
    await expect(read()).resolves.toEqual({
      baseCommit: baseline,
      currentBranch: 'main',
      mainCommit: localMain,
      mainRemoteCommit: remoteMain,
      mainBehind: 4,
      mainAhead: 0,
    });
    expect(runSourceGit).toHaveBeenCalledTimes(6);
    expect(vi.mocked(runSourceGit).mock.calls.every(([, , cwd]) => cwd === 'managed-source')).toBe(
      true,
    );
  });

  it.each([
    [0, 0],
    [2, 0],
    [2, 3],
  ])('keeps ahead=%i and behind=%i distinct', async (ahead, behind) => {
    outputs['rev-list --left-right --count ' + localMain + '...' + remoteMain] =
      ahead + '	' + behind;
    await expect(read()).resolves.toMatchObject({ mainAhead: ahead, mainBehind: behind });
  });

  it.each(['refs/heads/main', 'refs/remotes/origin/main'])(
    'does not fail preparation or invent a comparison when %s is missing',
    async (ref) => {
      outputs['rev-parse --verify ' + ref + '^{commit}'] = new Error('missing ref');
      const result = await read();
      expect(result.baseCommit).toBe(baseline);
      expect(result.mainBehind).toBeUndefined();
      expect(result.mainAhead).toBeUndefined();
      expect(result[ref === 'refs/heads/main' ? 'mainCommit' : 'mainRemoteCommit']).toBeUndefined();
      expect(runSourceGit).toHaveBeenCalledTimes(5);
    },
  );

  it('does not substitute the latest upstream commit for an unknown personal ancestor', async () => {
    outputs['merge-base ' + personal + ' ' + remoteMain] = new Error('unrelated histories');
    await expect(read()).resolves.toMatchObject({ baseCommit: undefined, mainBehind: 4 });
  });

  it('reports the explicitly adopted upstream even when personal HEAD has not moved', async () => {
    outputs['rev-parse --verify refs/cindy-make/personal-upstream^{commit}'] = remoteMain;
    await expect(read()).resolves.toMatchObject({ baseCommit: remoteMain });
    expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
  });

  it.each(['', '-1 2', '0 1.5', '0 9007199254740992', 'failed', new Error('count failed')])(
    'omits unavailable or invalid comparison counts: %s',
    async (output) => {
      outputs['rev-list --left-right --count ' + localMain + '...' + remoteMain] = output;
      const result = await read();
      expect(result.mainCommit).toBe(localMain);
      expect(result.mainBehind).toBeUndefined();
      expect(result.mainAhead).toBeUndefined();
    },
  );

  it('ignores invalid commit output', async () => {
    outputs['rev-parse --verify refs/heads/main^{commit}'] = 'refs/heads/main';
    await expect(read()).resolves.toMatchObject({
      mainCommit: undefined,
      mainRemoteCommit: remoteMain,
    });
  });

  it.each(['main', 'cindy-personal', 'feature/personal-change', '个人版'])(
    'reads the actual checkout branch %s',
    async (branch) => {
      outputs['rev-parse --abbrev-ref HEAD'] = branch;
      await expect(read()).resolves.toMatchObject({ currentBranch: branch });
    },
  );

  it('distinguishes a detached checkout from an unavailable branch name', async () => {
    outputs['rev-parse --abbrev-ref HEAD'] = 'HEAD';
    await expect(read()).resolves.toMatchObject({ currentBranch: null });
  });

  it.each(['', 'invalid\nbranch', 'a'.repeat(256), new Error('branch unavailable')])(
    'does not invent a current branch for %s',
    async (value) => {
      outputs['rev-parse --abbrev-ref HEAD'] = value;
      await expect(read()).resolves.toMatchObject({ currentBranch: undefined });
    },
  );

  it('propagates cancellation during an optional query', async () => {
    const controller = new AbortController();
    vi.mocked(runSourceGit).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('cancelled');
    });
    await expect(read(controller.signal)).rejects.toThrow();
    expect(runSourceGit).toHaveBeenCalledTimes(1);
  });
});

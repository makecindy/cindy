import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyUpstreamMerge,
  cancelUpstreamMerge,
  mergeWorktree,
  prepareUpstreamMerge,
  type MergeGit,
} from '../upstreamMerge';
import { makeSourceCheckoutPath } from '../sourcePaths';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
vi.mock('../sourceContent', () => ({
  snapshotContent: async (git: MergeGit, cwd: string) => {
    if ((await git(['ls-files', '--unmerged'], cwd)).trim())
      throw Object.assign(new Error('conflicts'), { code: 'dirty' });
    return 'e'.repeat(40);
  },
  populateContent: async () => {},
  applyContent: async (git: MergeGit, cwd: string) => git(['apply-files'], cwd),
  PERSONAL_UPSTREAM_REF: 'refs/cindy-make/personal-upstream',
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  realpath: vi.fn(async (p: string) => p),
  lstat: vi.fn(async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }),
}));
vi.mock('../localHistory', async (load) => ({
  ...(await load<typeof import('../localHistory')>()),
  commitPersonalFiles: async (git: MergeGit, cwd: string) => ({
    commit: await git(['rev-parse', 'HEAD'], cwd),
    tree: 'e'.repeat(40),
  }),
}));
const userData = path.resolve('fake-user-data');
const state: CindyMakeMergeState = {
  id: '12345678-1234-1234-1234-123456789abc',
  status: 'merging',
  ref: 'main',
  upstreamCommit: 'a'.repeat(40),
  baselineCommit: 'b'.repeat(40),
  hasWorkspace: true,
};
let git: ReturnType<typeof vi.fn<MergeGit>>;
const source = makeSourceCheckoutPath(userData);
beforeEach(() => {
  vi.mocked(realpath).mockImplementation(async (p) => String(p));
  vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  git = vi.fn(async (args, cwd) => {
    const command = args.join(' ');
    if (command === 'rev-parse --path-format=absolute --git-common-dir')
      return path.join(source, '.git');
    if (command === 'rev-parse --show-toplevel') return source;
    if (command === 'branch --show-current')
      return cwd === source ? 'cindy-personal' : `cindy-merge/${state.id}`;
    if (command === 'rev-parse HEAD')
      return cwd === source ? state.baselineCommit! : 'c'.repeat(40);
    if (args[0] === 'rev-parse' && args[1]?.endsWith('^{tree}')) return 'e'.repeat(40);
    if (command === 'rev-parse FETCH_HEAD^{commit}') return state.upstreamCommit;
    if (command === 'rev-parse --verify refs/cindy-make/personal-upstream^{commit}')
      return state.baselineCommit!;
    return '';
  });
});
describe('upstream merge protection', () => {
  it('stops automatic source preparation after an account switch before changing refs', async () => {
    let current = true;
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd) => {
      if (args[0] === 'fetch') current = false;
      return original(args, cwd);
    });
    await expect(
      prepareUpstreamMerge(
        userData,
        { ...state, taskOwned: true },
        git,
        async () => {},
        () => current,
      ),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(
      git.mock.calls.some(([args]) =>
        ['update-ref', 'worktree', 'rebase', 'reset'].includes(args[0]),
      ),
    ).toBe(false);
  });
  it('rejects cancellation of an assigned task or invalid operation before touching Git', async () => {
    for (const candidate of [
      { ...state, status: 'conflict' as const, sessionId: 'existing-task' },
      { ...state, status: 'conflict' as const, id: '../source' },
      { ...state, status: 'merged' as const },
    ]) {
      await expect(cancelUpstreamMerge(userData, candidate, git)).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
    expect(git).not.toHaveBeenCalled();
  });
  it('refuses to cancel a candidate whose physical path points elsewhere', async () => {
    const worktree = mergeWorktree(userData, state.id);
    vi.mocked(lstat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof lstat>>);
    vi.mocked(realpath).mockImplementation(async (p) =>
      String(p) === worktree ? source : String(p),
    );
    await expect(
      cancelUpstreamMerge(userData, { ...state, status: 'conflict' }, git),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(
      git.mock.calls.some(([args]) =>
        ['rebase', 'merge', 'worktree', 'update-ref'].includes(args[0]),
      ),
    ).toBe(false);
  });
  it.each(['other-worktree', 'owner-changed'] as const)(
    'keeps the candidate branch if %s during cancellation',
    async (reason) => {
      let current = true;
      const original = git.getMockImplementation()!;
      git.mockImplementation(async (args, cwd) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') return 'c'.repeat(40);
        if (args[0] === 'worktree' && args[1] === 'list') {
          if (reason === 'owner-changed') current = false;
          else return `branch refs/heads/cindy-merge/${state.id}\0`;
        }
        return original(args, cwd);
      });
      await expect(
        cancelUpstreamMerge(userData, { ...state, status: 'conflict' }, git, () => current),
      ).rejects.toMatchObject({ code: 'busy' });
      expect(git.mock.calls.some(([args]) => args[0] === 'update-ref')).toBe(false);
    },
  );
  it('rejects invalid operation identities before mutating refs', async () => {
    await expect(
      prepareUpstreamMerge(userData, { ...state, id: '../bad' }, git, async () => {}),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(git).not.toHaveBeenCalled();
  });
  it('refuses unresolved personal conflicts before fetch or backup', async () => {
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd) =>
      args[0] === 'ls-files' ? 'unmerged file' : original(args, cwd),
    );
    await expect(prepareUpstreamMerge(userData, state, git, async () => {})).rejects.toMatchObject({
      code: 'dirty',
    });
    expect(
      git.mock.calls.some(([args]) => ['fetch', 'update-ref', 'worktree'].includes(args[0])),
    ).toBe(false);
  });
  it('preserves a customized main instead of moving it backwards', async () => {
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd) => {
      if (args.join(' ') === 'rev-parse --verify refs/heads/main^{commit}') return 'd'.repeat(40);
      if (args[0] === 'merge-base')
        throw Object.assign(new Error('not ancestor'), { exitCode: 1 });
      return original(args, cwd);
    });
    await expect(prepareUpstreamMerge(userData, state, git, async () => {})).rejects.toMatchObject({
      code: 'localMain',
    });
    expect(git.mock.calls.some(([args]) => args.includes('--force'))).toBe(false);
  });
  it('reports a newer main separately from a divergent main', async () => {
    const original = git.getMockImplementation()!;
    let ancestryChecks = 0;
    git.mockImplementation(async (args, cwd) => {
      if (args.join(' ') === 'rev-parse --verify refs/heads/main^{commit}') return 'd'.repeat(40);
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        ancestryChecks += 1;
        if (ancestryChecks === 2) return '';
        throw Object.assign(new Error('not ancestor'), { exitCode: 1 });
      }
      return original(args, cwd);
    });
    await expect(prepareUpstreamMerge(userData, state, git, async () => {})).rejects.toMatchObject({
      code: 'localMainAhead',
    });
    expect(git.mock.calls.some(([args]) => ['update-ref', 'branch', 'worktree'].includes(args[0]) && args[1] !== '--show-current')).toBe(false);
  });
  it.each([1, 2])('does not report divergence when ancestry check %s fails to run', async (check) => {
    const original = git.getMockImplementation()!;
    const failure = Object.assign(new Error('Git object unavailable'), { exitCode: 128 });
    let ancestryChecks = 0;
    git.mockImplementation(async (args, cwd) => {
      if (args.join(' ') === 'rev-parse --verify refs/heads/main^{commit}') return 'd'.repeat(40);
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        if (++ancestryChecks === check) throw failure;
        throw Object.assign(new Error('not ancestor'), { exitCode: 1 });
      }
      return original(args, cwd);
    });
    await expect(prepareUpstreamMerge(userData, state, git, async () => {})).rejects.toBe(failure);
    expect(git.mock.calls.some(([args]) => args.includes('--force'))).toBe(false);
  });
  it('does not call a generic merge failure a conflict', async () => {
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd) => {
      if (args.includes('rebase')) throw new Error('index.lock');
      return original(args, cwd);
    });
    await expect(prepareUpstreamMerge(userData, state, git, async () => {})).rejects.toThrow(
      'index.lock',
    );
  });
  it('will not apply a candidate that dropped either pinned history', async () => {
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd) => {
      if (args[0] === 'merge-base' && args[2] === state.upstreamCommit)
        throw new Error('missing upstream');
      return original(args, cwd);
    });
    await expect(applyUpstreamMerge(userData, state, git)).rejects.toThrow('missing upstream');
    expect(git.mock.calls.some(([args]) => args.includes('--ff-only'))).toBe(false);
  });
  it('rechecks the task/account guard immediately before applying', async () => {
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(applyUpstreamMerge(userData, state, git, current)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(git.mock.calls.some(([args]) => args.includes('--ff-only'))).toBe(false);
  });
});

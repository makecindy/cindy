import path from 'node:path';
import originalFs from 'original-fs';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  paths: new Set<string>(),
  links: new Set<string>(),
  patchedRm: vi.fn(async () => {
    throw new Error('Electron ASAR-aware removal must not be used');
  }),
}));
vi.mock('../sourceContent', () => ({
  contentRef: async () => undefined,
  taskContentRef: () => 'ref',
}));
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async (p: string) => {
    if (!h.paths.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isSymbolicLink: () => h.links.has(p), isDirectory: () => true };
  }),
  realpath: vi.fn(async (p: string) => p),
  rm: h.patchedRm,
}));
vi.mock('original-fs', () => ({
  default: {
    promises: {
      rm: vi.fn(async (p: string) => {
        h.paths.delete(p);
      }),
    },
  },
}));
const { rm } = originalFs.promises;
import { manageCindyMakeWorkspace } from '../taskCleanup.js';
import {
  makeSourceCheckoutPath,
  makeTaskWorktreePath,
  makeTaskBranch,
  makeWorktreesRoot,
} from '../sourcePaths.js';

const profile = path.join(os.tmpdir(), 'make-cleanup-unit');
const source = makeSourceCheckoutPath(profile);
const target = makeTaskWorktreePath(profile, 'run');
const branch = makeTaskBranch('run');
function fixture() {
  const state = {
    merged: false,
    dirty: false,
    head: 'changed',
    branchExists: true,
    registered: true,
  };
  const git = vi.fn(async (_env: unknown, args: string[], cwd: string) => {
    if (args[0] === '-c') args = args.slice(2);
    if (args[0] === 'branch' && args[1] === '--list') return state.branchExists ? branch : '';
    if (args[0] === 'branch') {
      state.branchExists = false;
      return '';
    }
    if (args[0] === 'worktree' && args[1] === 'list')
      return (
        'worktree ' +
        (state.registered ? target : source) +
        '\0branch refs/heads/' +
        (state.registered ? branch : 'cindy-personal') +
        '\0\0'
      );
    if (args[0] === 'worktree' && args[1] === 'remove') {
      h.paths.delete(target);
      return '';
    }
    if (args.includes('--git-common-dir')) return path.join(source, '.git');
    if (args.includes('--abbrev-ref')) return cwd === target ? branch : 'cindy-personal';
    if (args[0] === 'rev-parse') return state.head;
    if (args[0] === 'status') return state.dirty ? ' M code.ts' : '';
    if (args[0] === 'merge-base') {
      if (!state.merged) throw Object.assign(new Error('not merged'), { exitCode: 1 });
      return '';
    }
    if (args.includes('merge')) {
      state.merged = true;
      return '';
    }
    return '';
  });
  const manage = (
    action: 'end' | 'finish' | 'delete' | 'archive' | 'inspect',
    checkCurrent?: () => void,
    preparedWorkspace?: { path: string; branch: string },
  ) =>
    manageCindyMakeWorkspace(profile, 'run', action, {}, new AbortController().signal, {
      git,
      baseCommit: 'base',
      checkCurrent,
      preparedWorkspace,
    });
  return { state, git, manage };
}
beforeEach(() => {
  vi.mocked(rm).mockClear();
  h.patchedRm.mockClear();
  h.links.clear();
  h.paths = new Set([
    profile,
    path.dirname(source),
    source,
    path.join(source, '.git'),
    makeWorktreesRoot(profile),
    target,
  ]);
});
describe('managed task cleanup', () => {
  it('keeps unintegrated committed work on finish without merging or deleting it', async () => {
    const f = fixture();
    await expect(f.manage('finish')).resolves.toBe(false);
    expect(
      f.git.mock.calls.some(([, args]) => args.includes('merge') || args.includes('remove')),
    ).toBe(false);
    expect(h.paths.has(target)).toBe(true);
  });
  it.each(['dirty', 'unmerged', 'unchanged'] as const)(
    'retains %s work when merely archived',
    async (kind) => {
      const f = fixture();
      f.state.dirty = kind === 'dirty';
      f.state.head = kind === 'unchanged' ? 'base' : 'changed';
      await expect(f.manage('archive')).resolves.toBe(false);
      expect(h.paths.has(target)).toBe(true);
      expect(f.state.branchExists).toBe(true);
    },
  );
  it('keeps an archived task even when its changes are already merged', async () => {
    const f = fixture();
    f.state.merged = true;
    await expect(f.manage('archive')).resolves.toBe(false);
    expect(h.paths.has(target)).toBe(true);
    expect(f.git).not.toHaveBeenCalled();
    expect(f.git.mock.calls.some(([, args]) => args.includes('merge'))).toBe(false);
  });
  it('retains finished uncommitted changes but explicit delete discards them', async () => {
    const f = fixture();
    f.state.dirty = true;
    await expect(f.manage('finish')).resolves.toBe(false);
    expect(h.paths.has(target)).toBe(true);
    await expect(f.manage('delete')).resolves.toBe(true);
    expect(f.git.mock.calls.at(-1)?.[1]).toEqual(['branch', '-D', branch]);
  });
  it.each([true, false])(
    'explicit end cleans integrated or unintegrated work (merged: %s)',
    async (merged) => {
      const f = fixture();
      f.state.merged = merged;
      f.state.dirty = !merged;
      await expect(f.manage('end')).resolves.toBe(true);
      expect(h.paths.has(target)).toBe(false);
      expect(f.state.branchExists).toBe(false);
      expect(
        f.git.mock.calls.some(([, args]) => args.includes('merge') || args.includes('commit')),
      ).toBe(false);
    },
  );
  it.each([true, false])(
    'inspection reports integration without cleaning (merged: %s)',
    async (merged) => {
      const f = fixture();
      f.state.merged = merged;
      await expect(f.manage('inspect')).resolves.toBe(merged);
      expect(h.paths.has(target)).toBe(true);
      expect(f.state.branchExists).toBe(true);
      expect(
        f.git.mock.calls.some(([, args]) => args.includes('remove') || args.includes('update-ref')),
      ).toBe(false);
    },
  );
  it('retries after worktree removal succeeded but branch removal failed', async () => {
    const f = fixture();
    h.paths.delete(target);
    await expect(f.manage('delete')).resolves.toBe(true);
    await expect(f.manage('delete')).resolves.toBe(true);
    expect(f.state.branchExists).toBe(false);
  });
  it('never removes substituted or unregistered directories', async () => {
    const f = fixture();
    h.links.add(makeWorktreesRoot(profile));
    await expect(f.manage('delete')).rejects.toMatchObject({ code: 'unavailable' });
    h.links.clear();
    f.state.registered = false;
    await expect(f.manage('delete')).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.paths.has(target)).toBe(true);
  });
  it('stops before mutation when the account changes', async () => {
    const f = fixture();
    await expect(
      f.manage('delete', () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
    expect(h.paths.has(target)).toBe(true);
    expect(f.git).not.toHaveBeenCalled();
  });
  it('resumes a partial deletion using the exact persisted preparation identity', async () => {
    const f = fixture();
    f.state.registered = false;
    await expect(f.manage('delete', undefined, { path: target, branch })).resolves.toBe(true);
    expect(rm).toHaveBeenCalledWith(target, expect.objectContaining({ recursive: true }));
    expect(h.paths.has(target)).toBe(false);
    expect(f.state.branchExists).toBe(false);
    expect(h.patchedRm).not.toHaveBeenCalled();
  });
  it.each(['wrong-path', 'wrong-branch', 'git-marker', 'junction', 'no-branch'])(
    'rejects unsafe residual recovery: %s',
    async (kind) => {
      const f = fixture();
      f.state.registered = false;
      if (kind === 'git-marker') h.paths.add(path.join(target, '.git'));
      if (kind === 'junction') h.links.add(target);
      if (kind === 'no-branch') f.state.branchExists = false;
      await expect(
        f.manage('delete', undefined, {
          path: kind === 'wrong-path' ? source : target,
          branch: kind === 'wrong-branch' ? 'another-branch' : branch,
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(rm).not.toHaveBeenCalled();
      expect(h.paths.has(target)).toBe(true);
    },
  );
  it('preserves the branch and reports occupied files until a retry succeeds', async () => {
    const f = fixture();
    f.state.registered = false;
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }));
    await expect(f.manage('delete', undefined, { path: target, branch })).rejects.toMatchObject({
      code: 'directoryBusy',
    });
    expect(f.state.branchExists).toBe(true);
    await expect(f.manage('delete', undefined, { path: target, branch })).resolves.toBe(true);
  });
  it('continues when Git removes its registration but leaves files behind', async () => {
    const f = fixture();
    const original = f.git.getMockImplementation()!;
    f.git.mockImplementation(async (...args) => {
      if (args[1].includes('remove')) {
        f.state.registered = false;
        throw new Error('unable to delete directory');
      }
      return original(...args);
    });
    await expect(f.manage('delete')).resolves.toBe(true);
    expect(rm).toHaveBeenCalled();
    expect(f.state.branchExists).toBe(false);
  });
  it('never attempts a merge on finish', async () => {
    const f = fixture();
    const original = f.git.getMockImplementation()!;
    f.git.mockImplementation(async (...args) => {
      if (args[1].includes('merge')) throw new Error('conflict');
      return original(...args);
    });
    await expect(f.manage('finish')).resolves.toBe(false);
    expect(h.paths.has(target)).toBe(true);
    expect(f.state.branchExists).toBe(true);
  });
});

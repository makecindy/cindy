import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { lstat } from 'node:fs/promises';
import { assertCindyMakeWorkspace, withCindyMakeProjectUse } from '../projectAccess.js';
import { makeSourceCheckoutPath, makeTaskWorktreePath } from '../sourcePaths.js';

vi.mock('node:fs/promises', () => ({ lstat: vi.fn() }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));

const userData = path.join(os.tmpdir(), 'cindy-make-access-fixture');
const workingDir = makeTaskWorktreePath(userData, 'task-run');
const worktreeGit = path.join(workingDir, '.git');
const sourceGit = path.join(makeSourceCheckoutPath(userData), '.git');

function metadata(kind: 'directory' | 'file' | 'symlink') {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  } as Awaited<ReturnType<typeof lstat>>;
}

beforeEach(() => {
  vi.mocked(lstat)
    .mockReset()
    .mockImplementation(async (file) => metadata(file === worktreeGit ? 'file' : 'directory'));
});

describe('Cindy Make project send access', () => {
  it('also blocks a missing upstream-merge workspace without recreating it as an ordinary project', async () => {
    const mergeDir = path.join(userData, 'cindy-make', 'merge-worktrees', '12345678-1234-1234-1234-123456789abc');
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const send = vi.fn(async () => 'accepted');
    await expect(withCindyMakeProjectUse(userData, mergeDir, send)).rejects.toThrow('PRECONDITION_FAILED');
    expect(send).not.toHaveBeenCalled();
  });
  it('checks the worktree and original checkout before dispatch', async () => {
    const send = vi.fn(async () => 'accepted');
    await expect(withCindyMakeProjectUse(userData, workingDir, send)).resolves.toBe('accepted');
    expect(lstat).toHaveBeenCalledWith(workingDir);
    expect(lstat).toHaveBeenCalledWith(worktreeGit);
    expect(lstat).toHaveBeenCalledWith(sourceGit);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([workingDir, worktreeGit, sourceGit])(
    'does not dispatch or recreate a missing %s',
    async (missing) => {
      vi.mocked(lstat).mockImplementation(async (file) => {
        if (file === missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return metadata(file === worktreeGit ? 'file' : 'directory');
      });
      const send = vi.fn(async () => undefined);
      await expect(withCindyMakeProjectUse(userData, workingDir, send)).rejects.toThrow(
        'cindyMake.code.workspaceUnavailable',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['file', 'symlink'] as const)('rejects a worktree replaced by a %s', async (kind) => {
    vi.mocked(lstat).mockImplementation(async (file) =>
      metadata(file === workingDir ? kind : file === worktreeGit ? 'file' : 'directory'),
    );
    await expect(assertCindyMakeWorkspace(userData, workingDir)).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
  });

  it('leaves ordinary projects and missing working directory defaults unchanged', async () => {
    const send = vi.fn(async () => 'accepted');
    for (const directory of [undefined, path.join(os.tmpdir(), 'ordinary-project')])
      await expect(withCindyMakeProjectUse(userData, directory, send)).resolves.toBe('accepted');
    expect(lstat).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

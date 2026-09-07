import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkingDirectoryRecovery } from '../workingDirectoryRecovery';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('working directory conversation recovery', () => {
  it('notifies physical aliases while preserving unrelated pending recovery', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-cwd-alias-'));
    roots.push(root);
    const parent = path.join(root, 'parent');
    const alias = path.join(root, 'alias');
    await fsp.mkdir(parent);
    await fsp.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const dir = path.join(parent, 'project');
    const aliasDir = path.join(alias, 'project');
    const other = path.join(root, 'other');
    const recovery = createWorkingDirectoryRecovery();
    await recovery.recover('other', other);
    const otherNote = recovery.peek('other', other);
    await recovery.recover('first', dir, null, [
      { id: 'alias', workingDir: aliasDir }, { id: 'other', workingDir: other },
    ]);
    expect(recovery.peek('alias', aliasDir)).toContain('previous files have not been recovered');
    expect(recovery.peek('other', other)).toBe(otherNote);
    recovery.consume('first', recovery.peek('first', dir)!);
    expect(recovery.peek('alias', aliasDir)).not.toBeNull();
  });

  it('does not revive an alias cleared while physical identity is being resolved', async () => {
    let finish!: (dir: string) => void;
    const realpath = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir: vi.fn(async () => {}),
      realpath,
    });
    const recovering = recovery.recover('first', '/project', null, [{ id: 'alias', workingDir: '/alias' }]);
    await vi.waitFor(() => expect(realpath).toHaveBeenCalledOnce());
    recovery.discard('alias');
    realpath.mockResolvedValue('/physical');
    finish('/physical');
    expect(await recovering).toBe(true);
    expect(recovery.peek('alias', '/alias')).toBeNull();
    expect(recovery.peek('first', '/project')).not.toBeNull();
  });

  it('keeps shared-directory notices independent and drops a notice after moving away', async () => {
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir: vi.fn(async () => {}),
    });
    await recovery.recover('first', '/project', null, ['second', 'third'].map((id) => ({ id, workingDir: '/project' })));
    const note = recovery.peek('first', '/project')!;
    recovery.consume('first', note);
    expect(recovery.peek('first', '/project')).toBeNull();
    expect(recovery.peek('second', '/project')).toBe(note);
    expect(recovery.peek('third', '/elsewhere')).toBeNull();
    expect(recovery.peek('third', '/project')).toBeNull();
    recovery.consume('second', note);
    expect(recovery.peek('second', '/project')).toBeNull();
  });

  it('does not revive sibling notices cleared or moved during shared-directory IO', async () => {
    let finish!: () => void;
    const mkdir = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir,
    });
    const recovering = recovery.recover('first', '/project', null, ['cleared', 'moved', 'remaining'].map((id) => ({ id, workingDir: '/project' })));
    await vi.waitFor(() => expect(mkdir).toHaveBeenCalled());
    recovery.discard('cleared');
    expect(recovery.peek('moved', '/elsewhere')).toBeNull();
    finish();
    expect(await recovering).toBe(true);
    expect(recovery.peek('cleared', '/project')).toBeNull();
    expect(recovery.peek('moved', '/project')).toBeNull();
    expect(recovery.peek('remaining', '/project')).toBe(recovery.peek('first', '/project'));
    expect(recovery.peek('remaining', '/project')).toContain('previous files have not been recovered');
  });

  it('passes the similar-path diagnostic to the agent while keeping the conversation available', async () => {
    const mkdir = vi.fn(async () => {});
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir,
    });
    expect(await recovery.recover('task', '/project', '/project ')).toBe(true);
    expect(mkdir).toHaveBeenCalledWith('/project', { recursive: true });
    expect(recovery.peek('task')).toContain(JSON.stringify('/project '));
    expect(recovery.peek('task')).toContain('Inspect this candidate before reading or creating project files');
    expect(recovery.peek('task')).toContain('previous files have not been recovered');
  });

  it('keeps the recovery note when another probe sees the directory before mkdir settles', async () => {
    let finish!: () => void;
    const mkdir = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn().mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        .mockResolvedValue({ isDirectory: () => true }),
      mkdir,
    });
    const first = recovery.recover('task', '/project');
    await vi.waitFor(() => expect(mkdir).toHaveBeenCalled());
    expect(await recovery.recover('task', '/project')).toBe(true);
    finish();
    expect(await first).toBe(true);
    expect(recovery.peek('task')).toContain('previous files have not been recovered');
  });

  it.each(['discard', 'clear'] as const)('does not restore a discarded note after late IO: %s', async (operation) => {
    let finish!: () => void;
    const mkdirDone = new Promise<void>((resolve) => { finish = resolve; });
    const mkdir = vi.fn(() => mkdirDone);
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir,
    });
    const recovering = recovery.recover('task', '/project');
    await vi.waitFor(() => expect(mkdir).toHaveBeenCalled());
    if (operation === 'discard') recovery.discard('task');
    else recovery.clear();
    finish();
    expect(await recovering).toBe(true);
    expect(recovery.peek('task')).toBeNull();
  });

  it('discards closed or cleared tasks and clears all notes at an owner boundary', async () => {
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir: vi.fn(async () => {}),
    });
    await recovery.recover('first', '/first');
    await recovery.recover('second', '/second');
    recovery.discard('first');
    expect(recovery.peek('first')).toBeNull();
    expect(recovery.peek('second')).not.toBeNull();
    recovery.clear();
    expect(recovery.peek('second')).toBeNull();
  });

  it('recreates the original directory and keeps its notice through repeated probes until acknowledged', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-cwd-recovery-'));
    roots.push(root);
    const dir = path.join(root, 'removed-parent', 'project');
    const recovery = createWorkingDirectoryRecovery();
    expect(await recovery.recover('task', dir)).toBe(true);
    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
    const note = recovery.peek('task');
    expect(note).toContain(JSON.stringify(dir));
    expect(note).toContain('previous files have not been recovered');
    expect(await recovery.recover('task', dir)).toBe(true);
    expect(recovery.peek('task')).toBe(note);
    recovery.consume('task', 'stale note');
    expect(recovery.peek('task')).toBe(note);
    recovery.consume('task', note!);
    expect(recovery.peek('task')).toBeNull();
  });

  it('does not replace an existing file or invent a recovery notice for an existing directory', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-cwd-recovery-'));
    roots.push(root);
    const file = path.join(root, 'project');
    await fsp.writeFile(file, 'keep');
    const recovery = createWorkingDirectoryRecovery();
    expect(await recovery.recover('task', file)).toBe(false);
    expect(await fsp.readFile(file, 'utf8')).toBe('keep');
    expect(await recovery.recover('task', root)).toBe(true);
    expect(recovery.peek('task')).toBeNull();
  });

  it.each(['EACCES', 'ENOTDIR', 'EIO'])('does not recreate a path after %s', async (code) => {
    const mkdir = vi.fn();
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error(code), { code }); }), mkdir,
    });
    expect(await recovery.recover('task', '/unavailable')).toBe(false);
    expect(mkdir).not.toHaveBeenCalled();
    expect(recovery.peek('task')).toBeNull();
  });

  it('does not claim recovery if directory creation fails', async () => {
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      mkdir: vi.fn(async () => { throw new Error('read-only volume'); }),
    });
    expect(await recovery.recover('task', '/unavailable')).toBe(false);
    expect(recovery.peek('task')).toBeNull();
  });
});

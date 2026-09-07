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
  it.runIf(process.platform === 'darwin')('distinguishes a bare /Volumes mount point from an alias to the system disk', async () => {
    const allocate = vi.fn(async () => '/conversation');
    const recovery = createWorkingDirectoryRecovery({
      stat: async () => ({ isDirectory: () => true, dev: 1 }), mkdir: vi.fn(),
      realpath: async (dir) => dir === '/Volumes/System' ? '/' : dir,
    }, allocate);
    expect(await recovery.recover('system', '/Volumes/System/project')).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
    const diagnostic = vi.fn(async () => null);
    expect(await recovery.recover('external', '/Volumes/External/project', diagnostic)).toBe(true);
    expect(allocate).toHaveBeenCalledOnce();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses a conversation workspace after the observed volume disappears (shadow exists: %s)', async (shadowExists) => {
    const dir = path.resolve('/mounted/project');
    const fallback = path.resolve('/conversation');
    let mounted = true;
    const mkdir = vi.fn();
    const recovery = createWorkingDirectoryRecovery({
      stat: vi.fn(async (target) => {
        if (!mounted && target === dir && !shadowExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isDirectory: () => true, dev: mounted ? 2 : 1 };
      }),
      mkdir,
      realpath: async (target) => target,
    }, async () => fallback);
    await recovery.observe('task', dir);
    mounted = false;
    expect(await recovery.recover('task', dir)).toBe(true);
    expect(mkdir).not.toHaveBeenCalled();
    expect(recovery.resolve('task', dir)).toBe(fallback);
    const note = recovery.peek('task', fallback)!;
    expect(note).toContain('not been restored or copied');
    expect(note).toContain(JSON.stringify(dir));
    recovery.consume('task', note);
    mounted = true;
    expect(await recovery.recover('task', dir)).toBe(true);
    expect(recovery.resolve('task', dir)).toBe(fallback);
    expect(recovery.peek('task', fallback)).toBeNull();
    expect(recovery.resolve('task', '/chosen-project')).toBe('/chosen-project');
    expect(recovery.resolve('task', dir)).toBe(dir);
  });

  it('recreates a deleted child on the same observed volume', async () => {
    const dir = path.resolve('/mounted/project');
    let missing = false;
    const mkdir = vi.fn();
    const allocate = vi.fn(async () => '/conversation');
    const recovery = createWorkingDirectoryRecovery({
      stat: async (target) => {
        if (missing && target === dir) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isDirectory: () => true, dev: 2 };
      }, mkdir,
    }, allocate);
    await recovery.observe('task', dir);
    missing = true;
    expect(await recovery.recover('task', dir)).toBe(true);
    expect(mkdir).toHaveBeenCalledWith(dir, { recursive: true });
    expect(allocate).not.toHaveBeenCalled();
  });

  it('recreates a deleted fallback without returning to the original mount', async () => {
    const mkdir = vi.fn();
    const recovery = createWorkingDirectoryRecovery({
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mkdir,
    }, async () => '/conversation');
    expect(await recovery.recover('task', '/offline/project')).toBe(true);
    recovery.consume('task', recovery.peek('task')!);
    expect(await recovery.recover('task', '/conversation')).toBe(true);
    expect(mkdir).toHaveBeenCalledWith(path.resolve('/conversation'), { recursive: true });
    expect(recovery.resolve('task', '/offline/project')).toBe(path.resolve('/conversation'));
    expect(recovery.peek('task')).toContain('previous files have not been recovered');
  });

  it.each(['EIO', 'ENOTCONN', 'ENODEV', 'WORKDIR_PROBE_TIMEOUT'])('uses fallback for an unavailable filesystem probe: %s', async (code) => {
    const mkdir = vi.fn();
    const recovery = createWorkingDirectoryRecovery({
      stat: async () => { throw Object.assign(new Error('unavailable'), { code }); }, mkdir,
    }, async () => '/conversation');
    expect(await recovery.recover('task', '/network/project')).toBe(true);
    expect(mkdir).not.toHaveBeenCalled();
    expect(recovery.resolve('task', '/network/project')).toBe(path.resolve('/conversation'));
  });

  it('does not revive a fallback after cleanup during allocation', async () => {
    let finish!: (dir: string) => void;
    const allocate = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const recovery = createWorkingDirectoryRecovery({
      stat: async () => { throw Object.assign(new Error('missing drive'), { code: 'ENOENT' }); }, mkdir: vi.fn(),
    }, allocate);
    const recovering = recovery.recover('task', '/unavailable/project');
    await vi.waitFor(() => expect(allocate).toHaveBeenCalled());
    recovery.discard('task');
    finish('/conversation');
    expect(await recovering).toBe(false);
    expect(recovery.resolve('task', '/unavailable/project')).toBe('/unavailable/project');
    expect(recovery.peek('task')).toBeNull();
  });

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

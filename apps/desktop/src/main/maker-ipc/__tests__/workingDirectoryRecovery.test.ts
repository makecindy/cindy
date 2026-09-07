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

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createDialogueWorkspaceHandlers, customDialogueWorkspaceRoot, checkDialogueDirectoryWritable } from '../dialogue-workspace-ipc';

function setup(defaultDirectory = path.resolve('default')) {
  let scope = 'owner-a:1';
  let directory = defaultDirectory;
  const deps = {
    captureScope: () => scope,
    isScopeCurrent: (captured: string) => scope === captured,
    read: () => ({ directory, isCustomized: directory !== defaultDirectory }),
    write: vi.fn(async (next: string | null) => { directory = next ?? defaultDirectory; }),
    chooseDirectory: vi.fn(async (): Promise<string | null> => path.resolve('selected')),
    resolveDirectory: (selected: string) => path.join(selected, 'dialogues', 'owner-a'),
    checkWritable: vi.fn(async () => {}),
    openDirectory: vi.fn(async (_directory: string) => ''),
  };
  return { deps, handlers: createDialogueWorkspaceHandlers(deps), changeOwner: () => { scope = 'owner-b:2'; } };
}

describe('dialogue directory settings IPC', () => {
  it('does not recreate an offline custom workspace and opens it after it returns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-dialogue-offline-'));
    try {
      const mount = path.join(root, 'volume');
      const detached = path.join(root, 'detached');
      const directory = path.join(mount, 'dialogues', 'owner-a');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'keep.txt'), 'keep');
      const { deps, handlers } = setup(path.join(root, 'default'));
      await deps.write(directory);
      await fs.rename(mount, detached);
      await fs.mkdir(mount); // An unmounted POSIX volume can leave a writable mount point.
      await expect(handlers.open()).rejects.toMatchObject({ code: 'ENOENT' });
      expect(deps.openDirectory).not.toHaveBeenCalled();
      expect(await fs.readdir(mount)).toEqual([]);
      expect(handlers.get()).toEqual({ directory, isCustomized: true });
      await fs.rmdir(mount);
      await fs.rename(detached, mount);
      expect(await handlers.open()).toEqual({ success: true });
      expect(deps.openDirectory).toHaveBeenCalledWith(directory);
      expect(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['', 'file manager unavailable'])('creates a missing default directory before opening and reports shell result %j', async (shellError) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-dialogue-open-'));
    try {
      const directory = path.join(root, 'dialogues');
      const { deps, handlers } = setup(directory);
      handlers.get();
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      deps.openDirectory.mockImplementation(async (opened: string) => {
        expect(opened).toBe(directory);
        expect((await fs.stat(opened)).isDirectory()).toBe(true);
        return shellError;
      });
      expect(await handlers.open()).toEqual({ success: shellError === '' });
      const file = path.join(directory, 'existing.txt');
      await fs.writeFile(file, 'keep');
      await handlers.open();
      expect(await fs.readFile(file, 'utf8')).toBe('keep');
      expect(deps.write).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not open or overwrite an existing file when directory creation fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-dialogue-open-'));
    try {
      const file = path.join(root, 'dialogues');
      await fs.writeFile(file, 'keep');
      const { deps, handlers } = setup(file);
      await expect(handlers.open()).rejects.toThrow();
      expect(deps.openDirectory).not.toHaveBeenCalled();
      expect(await fs.readFile(file, 'utf8')).toBe('keep');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not open the previous owner directory after an account switch', async () => {
    const { deps, handlers, changeOwner } = setup();
    const mkdir = vi.spyOn(fs, 'mkdir').mockImplementation(async () => { changeOwner(); return undefined; });
    try {
      await expect(handlers.open()).rejects.toThrow('PRECONDITION_FAILED');
      expect(deps.openDirectory).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
  });

  it('builds owner-isolated locations using the target platform path API', () => {
    expect(customDialogueWorkspaceRoot('D:\\My Files', 'owner-a', path.win32))
      .toBe(path.win32.join('D:\\My Files', 'dialogues', 'owner-a'));
    expect(customDialogueWorkspaceRoot('\\\\server\\share', 'owner-a', path.win32))
      .toBe(path.win32.join('\\\\server\\share', 'dialogues', 'owner-a'));
    for (const selected of ['/Volumes/Work Drive', '/home/me/资料', '/mnt/back\\slash']) {
      expect(customDialogueWorkspaceRoot(selected, 'owner-a', path.posix))
        .toBe(path.posix.join(selected, 'dialogues', 'owner-a'));
    }
  });

  it('probes a real directory without leaving files and rejects a file as a directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-dialogue-probe-'));
    try {
      const selected = path.join(root, 'workspace');
      await checkDialogueDirectoryWritable(selected);
      expect(await fs.readdir(selected)).toEqual([]);
      const file = path.join(root, 'existing.txt');
      await fs.writeFile(file, 'keep');
      await expect(checkDialogueDirectoryWritable(file)).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe('keep');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('checks the dedicated directory before committing and supports reset', async () => {
    const { deps, handlers } = setup();
    const directory = path.resolve('selected', 'dialogues', 'owner-a');
    expect(await handlers.choose()).toEqual({ directory, isCustomized: true });
    expect(deps.checkWritable).toHaveBeenCalledWith(directory);
    expect(deps.checkWritable.mock.invocationCallOrder[0]).toBeLessThan(deps.write.mock.invocationCallOrder[0]);
    expect(await handlers.reset()).toEqual({ directory: path.resolve('default'), isCustomized: false });
    expect(deps.write).toHaveBeenLastCalledWith(null);
  });

  it('cancellation leaves the previous setting untouched', async () => {
    const { deps, handlers } = setup();
    deps.chooseDirectory.mockResolvedValue(null);
    await handlers.choose();
    expect(deps.checkWritable).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('an unwritable directory never becomes the saved setting', async () => {
    const { deps, handlers } = setup();
    deps.checkWritable.mockRejectedValue(new Error('denied'));
    await expect(handlers.choose()).rejects.toThrow('denied');
    expect(deps.write).not.toHaveBeenCalled();
  });

  it.each(['picker', 'probe'] as const)('rejects owner changes during the %s', async (stage) => {
    const { deps, handlers, changeOwner } = setup();
    if (stage === 'picker') {
      deps.chooseDirectory.mockImplementation(async () => { changeOwner(); return path.resolve('selected'); });
    } else {
      deps.checkWritable.mockImplementation(async () => { changeOwner(); });
    }
    await expect(handlers.choose()).rejects.toThrow('PRECONDITION_FAILED');
    expect(deps.write).not.toHaveBeenCalled();
    if (stage === 'picker') expect(deps.checkWritable).not.toHaveBeenCalled();
  });

  it('does not let reset overtake an open folder picker', async () => {
    const { deps, handlers } = setup();
    let finish!: (value: string | null) => void;
    deps.chooseDirectory.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = handlers.choose();
    await expect(handlers.reset()).rejects.toThrow('PRECONDITION_FAILED');
    finish(null);
    await pending;
    await handlers.reset();
    expect(deps.write).toHaveBeenCalledOnce();
  });
});

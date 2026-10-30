import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiRemoteFileOps } from '../../base-agent.js';
import { readPiGlobalContext } from '../global-context.js';

describe('Pi global context snapshot', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'pi-global-context-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads only native context candidates and follows a user symlink outside Pi home', async () => {
    const home = path.join(root, 'pi');
    await fs.mkdir(home);
    const target = path.join(root, 'shared-global.md');
    await fs.writeFile(target, 'shared rules');
    try {
      await fs.symlink(target, path.join(home, 'AGENTS.md'));
    } catch (error) {
      // Windows runners without symlink privilege still exercise ordinary files.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fs.copyFile(target, path.join(home, 'AGENTS.md'));
    }
    for (const name of ['CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'settings.json', 'auth.json']) {
      await fs.writeFile(path.join(home, name), name);
    }
    expect(await readPiGlobalContext(home)).toEqual([
      { name: 'AGENTS.md', content: 'shared rules' },
    ]);
    await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'override');
    expect(await readPiGlobalContext(home)).toEqual([{ name: 'AGENTS.override.md', content: 'override' }]);
  });

  it('allows missing context and skips non-files like native Pi', async () => {
    expect(await readPiGlobalContext(undefined)).toEqual([]);
    expect(await readPiGlobalContext(root)).toEqual([]);
    await fs.mkdir(path.join(root, 'AGENTS.md'));
    await fs.writeFile(path.join(root, 'CLAUDE.MD'), 'uppercase fallback');
    const files = await readPiGlobalContext(root);
    expect(files).toMatchObject([{ content: 'uppercase fallback' }]);
    expect(files[0].name.toLowerCase()).toBe('claude.md');
  });

  it('uses only remote file operations and rejects truncated remote reads', async () => {
    const remote = {
      stat: vi.fn(async (file: string) => ({ isFile: file.endsWith('/AGENTS.md') })),
      readFile: vi.fn(async () => 'remote rules'),
    } as unknown as PiRemoteFileOps;
    expect(await readPiGlobalContext('$HOME/.pi/agent', remote)).toEqual([
      { name: 'AGENTS.md', content: 'remote rules' },
    ]);
    expect(remote.readFile).toHaveBeenCalledWith('$HOME/.pi/agent/AGENTS.md', 4_194_304);
    vi.mocked(remote.readFile).mockResolvedValue('x'.repeat(4_194_304));
    await expect(readPiGlobalContext('$HOME/.pi/agent', remote)).rejects.toThrow('remote read limit');
    vi.mocked(remote.readFile).mockRejectedValue(new Error('SSH unavailable'));
    await expect(readPiGlobalContext('$HOME/.pi/agent', remote)).rejects.toThrow('SSH unavailable');
    vi.mocked(remote.readFile).mockClear();
    vi.mocked(remote.stat).mockRejectedValue(new Error('remote stat failed (exit 1): EACCES'));
    await expect(readPiGlobalContext('$HOME/.pi/agent', remote)).rejects.toThrow('EACCES');
    expect(remote.readFile).not.toHaveBeenCalled();
  });
});

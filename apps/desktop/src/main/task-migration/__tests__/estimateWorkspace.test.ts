import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateWorkspace } from '../workspace';

// Real Git (registered worktrees) is covered in workspace.git-integration.test.ts; here every
// root is a plain directory, so the repository probe answers "not a git repository".
vi.mock('../../worktree/gitExec', async (original) => {
  const actual = await original<typeof import('../../worktree/gitExec')>();
  return {
    ...actual,
    gitExec: async (args: string[]) => {
      throw new actual.GitExecError({
        args,
        exitCode: 128,
        stderr: 'fatal: not a git repository',
        stdout: '',
      });
    },
  };
});

it('counts hidden and nested files, skips root Git metadata and does not count directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'objects'), 'excluded');
    await fs.writeFile(path.join(root, '.env'), 'abc');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'file'), '12345');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 8 });
    await expect(
      estimateWorkspace(root, () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('stops an oversized directory before statting its entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const lstat = vi.spyOn(fs, 'lstat');
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), '')),
    );
    lstat.mockClear();
    await expect(estimateWorkspace(root, () => {}, 10)).rejects.toThrow('MIGRATION_TOO_MANY_FILES');
    // Only the repository probe ran; none of the 300 files were statted.
    expect(lstat.mock.calls.filter(([file]) => !String(file).endsWith('.git'))).toEqual([]);
  } finally {
    lstat.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('counts a wide, deep tree and stops once the file cap is exceeded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    for (let i = 0; i < 40; i++) {
      const directory = path.join(root, `d${i}`, 'nested');
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(
        [0, 1, 2].map((j) => fs.writeFile(path.join(directory, `f${j}`), 'x'.repeat(j))),
      );
    }
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 120, bytes: 120 });
    expect(await estimateWorkspace(root, () => {}, 120)).toEqual({ fileCount: 120, bytes: 120 });
    await expect(estimateWorkspace(root, () => {}, 119)).rejects.toThrow(
      'MIGRATION_TOO_MANY_FILES',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('stops at the file cap even when every entry type is unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const readdir = fs.readdir.bind(fs);
  const unknown = vi.spyOn(fs, 'readdir').mockImplementation((async (
    directory: string,
    options: unknown,
  ) =>
    (await readdir(directory, options as { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    }))) as never);
  const lstat = vi.spyOn(fs, 'lstat');
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), '')),
    );
    lstat.mockClear();
    await expect(estimateWorkspace(root, () => {}, 10)).rejects.toThrow('MIGRATION_TOO_MANY_FILES');
    // Classifying the 11th file is the last per-file work; the other 289 are never statted.
    expect(lstat.mock.calls.length).toBeLessThanOrEqual(11);
  } finally {
    lstat.mockRestore();
    unknown.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('classifies entries of unknown type with lstat instead of rejecting them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const readdir = fs.readdir.bind(fs);
  const unknown = vi.spyOn(fs, 'readdir').mockImplementation((async (
    directory: string,
    options: unknown,
  ) =>
    (await readdir(directory, options as { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    }))) as never);
  try {
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'file'), '12345');
    await fs.writeFile(path.join(root, 'top'), 'ab');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 7 });
  } finally {
    unknown.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

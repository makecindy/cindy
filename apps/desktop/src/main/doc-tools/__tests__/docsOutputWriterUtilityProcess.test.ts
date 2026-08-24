import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocsOutputWriteRequest } from '../docsOutputWriterProtocol.js';
import { runDocsOutputWrite } from '../docsOutputWriterUtilityProcess.js';

let root: string;
const cleanup: string[] = [];

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-writer-'));
  cleanup.push(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) {
    await fs.promises.rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

async function request(
  targetName: string,
  data: string,
  overwrite: boolean,
  parent = root,
): Promise<DocsOutputWriteRequest> {
  const stat = await fs.promises.lstat(parent, { bigint: true });
  const rootStat = await fs.promises.lstat(root, { bigint: true });
  const rootRealPath = await fs.promises.realpath(root);
  const parentRealPath = await fs.promises.realpath(parent);
  return {
    expectedRoot: {
      realPath: rootRealPath,
      dev: rootStat.dev,
      ino: rootStat.ino,
    },
    expectedParent: {
      realPath: parentRealPath,
      dev: stat.dev,
      ino: stat.ino,
    },
    parentRelativePath: path.relative(rootRealPath, parentRealPath),
    targetName,
    data: Buffer.from(data),
    overwrite,
  };
}

describe('docs output cwd-bound writer', () => {
  it('creates exclusively and never truncates an existing file by default', async () => {
    const first = await request('report.bin', 'one', false);
    await runDocsOutputWrite(first, root);
    await expect(
      runDocsOutputWrite(await request('report.bin', 'two', false), root),
    ).rejects.toMatchObject({ code: 'FILE_EXISTS' });
    expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('one');
  });

  it('atomically replaces an existing regular file', async () => {
    await fs.promises.writeFile(path.join(root, 'report.bin'), 'old');
    await runDocsOutputWrite(await request('report.bin', 'new', true), root);
    expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('new');
    expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
      false,
    );
  });

  it('uses the recoverable Windows replace fallback for EPERM', async () => {
    await fs.promises.writeFile(path.join(root, 'report.bin'), 'old');
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('replace denied'), { code: 'EPERM' }))
      .mockImplementation(originalRename);

    await runDocsOutputWrite(await request('report.bin', 'new', true), root);
    expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('new');
    expect(
      (await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-backup-')),
    ).toBe(false);
  });

  it('rejects a parent path rebound to an outside symlink before the final operation', async () => {
    const safe = path.join(root, 'safe');
    const moved = path.join(root, 'safe-original');
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
    cleanup.push(outside);
    await fs.promises.mkdir(safe);
    const pending = await request('report.bin', 'blocked', false, safe);
    await fs.promises.rename(safe, moved);
    await fs.promises.symlink(outside, safe, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runDocsOutputWrite(pending, root)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(fs.promises.stat(path.join(outside, 'report.bin'))).rejects.toThrow();
  });

  it('anchors the final write at the session root when the parent inode moves away', async () => {
    const safe = path.join(root, 'safe');
    const moved = path.join(root, 'safe-original');
    await fs.promises.mkdir(safe);
    const pending = await request('report.bin', 'blocked', false, safe);
    await fs.promises.rename(safe, moved);

    await expect(runDocsOutputWrite(pending, root)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(fs.promises.stat(path.join(moved, 'report.bin'))).rejects.toThrow();
  });
});

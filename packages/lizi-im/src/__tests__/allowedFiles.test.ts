import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openAllowedOutboundFile } from '../allowedFiles.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('openAllowedOutboundFile', () => {
  it('confines outbound files to an allowed root and returns an opened canonical file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-outside-'));
    tempDirs.push(root, outside);
    const allowedFile = path.join(root, 'report.txt');
    const outsideFile = path.join(outside, 'secret.txt');
    await Promise.all([
      fs.writeFile(allowedFile, 'report'),
      fs.writeFile(outsideFile, 'secret'),
    ]);

    const opened = await openAllowedOutboundFile(allowedFile, [root]);
    expect(opened?.canonicalPath).toBe(await fs.realpath(allowedFile));
    expect(opened?.size).toBe(Buffer.byteLength('report'));
    await expect(opened?.handle.readFile({ encoding: 'utf8' })).resolves.toBe('report');
    await opened?.handle.close();

    await expect(openAllowedOutboundFile(outsideFile, [root])).resolves.toBeNull();
    await expect(openAllowedOutboundFile(allowedFile, [])).resolves.toBeNull();
  });

  it('rejects a lexical in-root path whose realpath escapes the root', async () => {
    const root = path.resolve('workspace');
    const candidate = path.join(root, 'linked', 'secret.txt');
    const escaped = path.resolve('outside', 'secret.txt');
    const realpath = async (target: string): Promise<string> => (target === root ? root : escaped);

    await expect(
      openAllowedOutboundFile(candidate, [root], {
        realpath,
        open: (target) => fs.open(target, 'r'),
        stat: (target) => fs.stat(target, { bigint: true }),
      }),
    ).resolves.toBeNull();
  });

  it('opens an in-root directory alias at its canonical target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-link-'));
    tempDirs.push(root);
    const actualDir = path.join(root, 'actual');
    const linkedDir = path.join(root, 'alias');
    const allowedFile = path.join(actualDir, 'report.txt');
    await fs.mkdir(actualDir);
    await fs.writeFile(allowedFile, 'report');
    await fs.symlink(actualDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

    const opened = await openAllowedOutboundFile(path.join(linkedDir, 'report.txt'), [root]);
    expect(opened?.canonicalPath).toBe(await fs.realpath(allowedFile));
    await expect(opened?.handle.readFile({ encoding: 'utf8' })).resolves.toBe('report');
    await opened?.handle.close();
  });

  it.skipIf(process.platform === 'win32')(
    'keeps reading the validated inode after its path is replaced',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-handle-'));
      tempDirs.push(root);
      const candidate = path.join(root, 'report.txt');
      const moved = path.join(root, 'report-original.txt');
      await fs.writeFile(candidate, 'trusted bytes');

      const opened = await openAllowedOutboundFile(candidate, [root]);
      expect(opened).not.toBeNull();
      try {
        await fs.rename(candidate, moved);
        await fs.writeFile(candidate, 'replacement bytes');
        await expect(opened!.handle.readFile({ encoding: 'utf8' })).resolves.toBe('trusted bytes');
      } finally {
        await opened?.handle.close();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the opened inode when the path is replaced after open',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-race-root-'));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-race-outside-'));
      tempDirs.push(root, outside);
      const candidate = path.join(root, 'report.txt');
      const replacement = path.join(outside, 'secret.txt');
      await Promise.all([
        fs.writeFile(candidate, 'report'),
        fs.writeFile(replacement, 'secret'),
      ]);

      const opened = await openAllowedOutboundFile(candidate, [root], {
        realpath: (target) => fs.realpath(target),
        open: async (target) => {
          const handle = await fs.open(target, 'r');
          // Path replacement after open must not re-bind the handle. Upload
          // stays on the inode that matched the pre-open in-root stat.
          await fs.rename(candidate, path.join(root, 'report-original.txt'));
          await fs.copyFile(replacement, candidate);
          return handle;
        },
        stat: (target) => fs.stat(target, { bigint: true }),
      });
      expect(opened).not.toBeNull();
      await expect(opened?.handle.readFile({ encoding: 'utf8' })).resolves.toBe('report');
      await opened?.handle.close();
    },
  );

  it('rejects when the opened inode does not match the pre-open in-root file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-swap-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-swap-outside-'));
    tempDirs.push(root, outside);
    const candidate = path.join(root, 'report.txt');
    const escaped = path.join(outside, 'secret.txt');
    await Promise.all([
      fs.writeFile(candidate, 'report'),
      fs.writeFile(escaped, 'secret'),
    ]);

    await expect(
      openAllowedOutboundFile(candidate, [root], {
        realpath: (target) => fs.realpath(target),
        open: () => fs.open(escaped, 'r'),
        stat: (target) => fs.stat(target, { bigint: true }),
      }),
    ).resolves.toBeNull();
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAllowedOutboundFile } from '../allowedFiles.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('resolveAllowedOutboundFile', () => {
  it('confines outbound files to an allowed root and returns the canonical path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-outside-'));
    tempDirs.push(root, outside);
    const allowedFile = path.join(root, 'report.txt');
    const outsideFile = path.join(outside, 'secret.txt');
    await Promise.all([
      fs.writeFile(allowedFile, 'report'),
      fs.writeFile(outsideFile, 'secret'),
    ]);

    const allowed = await resolveAllowedOutboundFile(allowedFile, [root]);
    expect(allowed?.absPath).toBe(await fs.realpath(allowedFile));
    await allowed?.handle.close();
    await expect(resolveAllowedOutboundFile(outsideFile, [root])).resolves.toBeNull();
    await expect(resolveAllowedOutboundFile(allowedFile, [])).resolves.toBeNull();
  });

  it('rejects a lexical in-root path whose realpath escapes the root', async () => {
    const root = path.resolve('workspace');
    const candidate = path.join(root, 'linked', 'secret.txt');
    const escaped = path.resolve('outside', 'secret.txt');
    const realpath = async (target: string): Promise<string> =>
      target === root ? root : escaped;

    await expect(
      resolveAllowedOutboundFile(candidate, [root], realpath),
    ).resolves.toBeNull();
  });

  it('rejects when a later realpath of the caller path escapes the root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-recheck-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-recheck-out-'));
    tempDirs.push(root, outside);
    const allowedFile = path.join(root, 'report.txt');
    const outsideFile = path.join(outside, 'secret.txt');
    await Promise.all([
      fs.writeFile(allowedFile, 'report'),
      fs.writeFile(outsideFile, 'secret'),
    ]);
    const outsideReal = await fs.realpath(outsideFile);
    let calls = 0;
    const realpath = async (target: string): Promise<string> => {
      calls += 1;
      if (calls >= 3) return outsideReal;
      return fs.realpath(target);
    };

    await expect(resolveAllowedOutboundFile(allowedFile, [root], realpath)).resolves.toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'opens an in-root symlink at its canonical target',
    async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-link-'));
    tempDirs.push(root);
    const allowedFile = path.join(root, 'report.txt');
    const linked = path.join(root, 'alias.txt');
    await fs.writeFile(allowedFile, 'report');
    await fs.symlink(allowedFile, linked);

    const allowed = await resolveAllowedOutboundFile(linked, [root]);
    expect(allowed?.absPath).toBe(await fs.realpath(allowedFile));
    expect(await allowed?.handle.readFile({ encoding: 'utf8' })).toBe('report');
    await allowed?.handle.close();
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the opened inode when the path is later replaced with an escaping symlink',
    async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-toctou-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-allowed-toctou-out-'));
    tempDirs.push(root, outside);
    const allowedFile = path.join(root, 'report.txt');
    const outsideFile = path.join(outside, 'secret.txt');
    await Promise.all([
      fs.writeFile(allowedFile, 'report'),
      fs.writeFile(outsideFile, 'secret'),
    ]);

    const allowed = await resolveAllowedOutboundFile(allowedFile, [root]);
    expect(allowed).not.toBeNull();
    await fs.rm(allowedFile);
    await fs.symlink(outsideFile, allowedFile);

    expect(await allowed?.handle.readFile({ encoding: 'utf8' })).toBe('report');
    await allowed?.handle.close();
    await expect(resolveAllowedOutboundFile(allowedFile, [root])).resolves.toBeNull();
  });
});

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

    await expect(resolveAllowedOutboundFile(allowedFile, [root])).resolves.toBe(
      await fs.realpath(allowedFile),
    );
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
});

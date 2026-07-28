import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUploadFiles } from '../rsb-webview-upload-policy.js';

let tempRoot = '';
let allowedRoot = '';
let outsideRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-upload-test-'));
  allowedRoot = path.join(tempRoot, 'workspace');
  outsideRoot = path.join(tempRoot, 'outside');
  await fs.mkdir(allowedRoot);
  await fs.mkdir(outsideRoot);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('resolveUploadFiles', () => {
  it('accepts ordinary files inside an allowed root', async () => {
    const file = path.join(allowedRoot, 'report.txt');
    await fs.writeFile(file, 'hello');

    await expect(resolveUploadFiles([file], [allowedRoot])).resolves.toEqual([
      await fs.realpath(file),
    ]);
  });

  it('rejects files outside the session roots and sensitive names', async () => {
    const outside = path.join(outsideRoot, 'outside.txt');
    const secret = path.join(allowedRoot, '.env.local');
    await fs.writeFile(outside, 'outside');
    await fs.writeFile(secret, 'TOKEN=not-real');

    await expect(resolveUploadFiles([outside], [allowedRoot])).rejects.toThrow(
      'inside the current session directory',
    );
    await expect(resolveUploadFiles([secret], [allowedRoot])).rejects.toThrow(
      'blocked for sensitive file',
    );
  });

  it('resolves links before checking containment', async () => {
    const outside = path.join(outsideRoot, 'linked.txt');
    const linkDir = path.join(allowedRoot, 'linked-outside');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outsideRoot, linkDir, 'junction');

    await expect(
      resolveUploadFiles([path.join(linkDir, 'linked.txt')], [allowedRoot]),
    ).rejects.toThrow('inside the current session directory');
  });
});

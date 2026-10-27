import fs from 'node:fs/promises';
import nodeFs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRecipeHost, recipeDiagnosticPath, recipeOutputPath, statRecipeFileSync } from '../../../../../../../packages/opencli-vendor/cindy/host.js';

import { resolveUploadFiles, openRecipeInputFileSync, readRecipeInputFileSync, createRecipeFileBroker } from '../rsb-webview-upload-policy.js';

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
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('resolveUploadFiles', () => {
  // #6826 output TOCTOU: the real Desktop capability factory must not grant
  // task-path writes. A valid output name is sufficient to expose the old
  // path-returning grant; metadata and invocation-owned scratch still work.
  it('grants metadata and temporary output without granting task-path writes', async () => {
    const file = path.join(allowedRoot, 'report.txt');
    await fs.writeFile(file, 'original');
    await withRecipeHost(undefined, async () => {
      expect(statRecipeFileSync(file).size).toBe(8);
      expect(() => recipeOutputPath(file)).toThrow('Local recipe file export');
      const scratch = recipeDiagnosticPath('scratch.txt');
      await fs.writeFile(recipeOutputPath(scratch), 'scratch');
      expect(await fs.readFile(scratch, 'utf8')).toBe('scratch');
    }, createRecipeFileBroker([allowedRoot], [allowedRoot]));
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });
  // #6826 input TOCTOU. Real host open/read entries, unit tier; earlier tests
  // only validated path strings. Minimum interleaving: replace a checked file
  // or its parent immediately before open; no unapproved bytes may be read.
  it.each(['file', 'parent'])('rejects a %s replacement before opening input', async kind => {
    const parent = path.join(allowedRoot, 'media');
    await fs.mkdir(parent);
    const file = path.join(parent, 'image.png');
    await fs.writeFile(file, 'approved');
    await fs.writeFile(path.join(outsideRoot, 'image.png'), 'private');
    const actualOpen = nodeFs.openSync;
    const close = vi.spyOn(nodeFs, 'closeSync');
    let opened: number | undefined;
    vi.spyOn(nodeFs, 'openSync').mockImplementation(((candidate: string, flags: number, mode: number) => {
      if (candidate === realpathSync(file)) {
        if (kind === 'file') {
          nodeFs.renameSync(file, `${file}.old`);
          nodeFs.writeFileSync(file, 'replacement');
        } else {
          nodeFs.renameSync(parent, `${parent}.old`);
          nodeFs.symlinkSync(outsideRoot, parent, 'junction');
        }
      }
      opened = actualOpen(candidate, flags, mode);
      return opened;
    }) as typeof nodeFs.openSync);
    expect(() => readRecipeInputFileSync(file, [allowedRoot])).toThrow();
    if (opened !== undefined) expect(close).toHaveBeenCalledWith(opened);
  });

  it('reads the checked descriptor after the pathname is replaced and closes on read failure', async () => {
    const file = path.join(allowedRoot, 'image.png');
    await fs.writeFile(file, 'approved');
    const actualRead = nodeFs.readSync;
    vi.spyOn(nodeFs, 'readSync').mockImplementation(((...args: Parameters<typeof nodeFs.readSync>) => {
      nodeFs.renameSync(file, `${file}.old`);
      nodeFs.writeFileSync(file, 'replacement');
      return actualRead(...args);
    }) as typeof nodeFs.readSync);
    expect(readRecipeInputFileSync(file, [allowedRoot]).toString()).toBe('approved');
    vi.restoreAllMocks();
    const descriptor = openRecipeInputFileSync(file, [allowedRoot]);
    expect(nodeFs.readFileSync(descriptor, 'utf8')).toBe('replacement');
    nodeFs.closeSync(descriptor);
    const close = vi.spyOn(nodeFs, 'closeSync');
    vi.spyOn(nodeFs, 'readSync').mockImplementation(() => { throw new Error('fixture read failure'); });
    expect(() => readRecipeInputFileSync(file, [allowedRoot])).toThrow('fixture read failure');
    expect(close).toHaveBeenCalledOnce();
  });
  // #6826: sanitized temporary upload copies must stay within the invoking
  // browser task's existing artifact root. Minimum input: one temporary PNG;
  // the earlier output tests had no subsequent native-upload policy check.
  it('accepts own temporary upload copies without granting another task access', async () => {
    let file = '';
    await withRecipeHost(undefined, async () => {
      file = recipeDiagnosticPath('upload-copy.png');
      await fs.writeFile(file, 'test-only-image');
      await expect(resolveUploadFiles([file], [allowedRoot])).resolves.toEqual([realpathSync(file)]);
      await expect(resolveUploadFiles([file], [outsideRoot])).rejects.toThrow('inside the current session directory');
    }, { read: () => Buffer.alloc(0), open: () => -1, temporaryRoot: allowedRoot });
    await expect(fs.access(path.dirname(file))).rejects.toThrow();
  });

  it('accepts ordinary files inside an allowed root', async () => {
    const file = path.join(allowedRoot, 'report.txt');
    await fs.writeFile(file, 'hello');

    await expect(resolveUploadFiles([file], [allowedRoot])).resolves.toEqual([
      realpathSync(file),
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  sameGhostSnapshotInodeIdentity,
  sameGhostSnapshotTargetIdentity,
} from '../ghostSnapshotIdentity';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess';

let workDir: string;

afterEach(async () => {
  if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('sameGhostSnapshotTargetIdentity', () => {
  it('rejects a directory replacement even when the replacement has the same contents', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-identity-'));
    const original = path.join(workDir, 'original');
    const replacement = path.join(workDir, 'replacement');
    await fs.promises.mkdir(original);
    await fs.promises.mkdir(replacement);

    const expectedStats = await fs.promises.lstat(original, { bigint: true });
    const expected = {
      realPath: await fs.promises.realpath(original),
      dev: expectedStats.dev,
      ino: expectedStats.ino,
    };
    const replacementStats = await fs.promises.lstat(replacement, { bigint: true });

    expect(
      sameGhostSnapshotTargetIdentity(expectedStats, expected.realPath, expected),
    ).toBe(true);
    expect(
      sameGhostSnapshotTargetIdentity(
        replacementStats,
        await fs.promises.realpath(replacement),
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a linked target even when its resolved directory matches the expected path', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-identity-'));
    const target = path.join(workDir, 'target');
    const link = path.join(workDir, 'link');
    await fs.promises.mkdir(target);
    const expectedStats = await fs.promises.lstat(target, { bigint: true });
    const expected = {
      realPath: await fs.promises.realpath(target),
      dev: expectedStats.dev,
      ino: expectedStats.ino,
    };
    try {
      await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const linkStats = await fs.promises.lstat(link, { bigint: true });
    expect(
      sameGhostSnapshotTargetIdentity(linkStats, await fs.promises.realpath(link), expected),
    ).toBe(false);
  });

  it('rejects a renamed directory when the caller still requires the original path', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-identity-'));
    const original = path.join(workDir, 'original');
    const quarantined = path.join(workDir, 'original.remove-1');
    await fs.promises.mkdir(original);
    const expectedStats = await fs.promises.lstat(original, { bigint: true });
    const expected = {
      realPath: await fs.promises.realpath(original),
      dev: expectedStats.dev,
      ino: expectedStats.ino,
    };
    await fs.promises.rename(original, quarantined);
    const movedStats = await fs.promises.lstat(quarantined, { bigint: true });
    const movedRealPath = await fs.promises.realpath(quarantined);

    expect(sameGhostSnapshotInodeIdentity(movedStats, expected)).toBe(true);
    expect(sameGhostSnapshotTargetIdentity(movedStats, movedRealPath, expected)).toBe(false);
  });
});

describe('runGhostSnapshotWorkerRequest remove', () => {
  it('deletes a real directory after renaming it to a quarantine path', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-remove-'));
    const target = path.join(workDir, 'skilled');
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(path.join(target, 'SKILL.md'), 'approved');
    const parentStats = await fs.promises.lstat(workDir, { bigint: true });

    await runGhostSnapshotWorkerRequest({
      expectedParent: {
        realPath: await fs.promises.realpath(workDir),
        dev: parentStats.dev,
        ino: parentStats.ino,
      },
      operation: 'remove',
      targetName: 'skilled',
    }, workDir);

    expect(fs.existsSync(target)).toBe(false);
    expect((await fs.promises.readdir(workDir)).some((name) => name.startsWith('skilled.remove-'))).toBe(false);
  });
});

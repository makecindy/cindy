import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureGhostSnapshotTargetIdentity,
  sameCapturedGhostSnapshotTargetIdentity,
  sameGhostSnapshotInodeIdentity,
  sameGhostSnapshotTargetIdentity,
} from '../ghostSnapshotIdentity';
import { hashApprovedSkillContent } from '../ghostInstallReceipt';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess';
import { validateGhostManifest } from '../../../shared/ghost';

let workDir: string;

afterEach(async () => {
  vi.restoreAllMocks();
  if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('sameGhostSnapshotTargetIdentity', () => {
  it('rejects a directory replacement even when the replacement has the same contents', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-identity-'));
    const original = path.join(workDir, 'original');
    const replacement = path.join(workDir, 'replacement');
    await fs.promises.mkdir(original);
    await fs.promises.mkdir(replacement);

    const expected = await captureGhostSnapshotTargetIdentity(original);
    const replacementStats = await fs.promises.lstat(replacement, { bigint: true });

    expect(
      sameGhostSnapshotTargetIdentity(
        await fs.promises.lstat(original, { bigint: true }),
        expected.realPath,
        expected,
      ),
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
    const expected = await captureGhostSnapshotTargetIdentity(target);
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
    const expected = await captureGhostSnapshotTargetIdentity(original);
    await fs.promises.rename(original, quarantined);
    const movedStats = await fs.promises.lstat(quarantined, { bigint: true });
    const movedRealPath = await fs.promises.realpath(quarantined);

    expect(sameGhostSnapshotInodeIdentity(movedStats, expected)).toBe(true);
    expect(sameGhostSnapshotTargetIdentity(movedStats, movedRealPath, expected)).toBe(false);
  });

  it('rejects a recapture that reused the inode but not the timestamps', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-identity-'));
    const original = path.join(workDir, 'original');
    await fs.promises.mkdir(original);
    const expected = await captureGhostSnapshotTargetIdentity(original);
    const reused = {
      ...expected,
      mtimeNs: expected.mtimeNs + 1n,
      ctimeNs: expected.ctimeNs + 1n,
    };

    expect(sameCapturedGhostSnapshotTargetIdentity(reused, expected)).toBe(false);
  });
});

describe('captureGhostSnapshotTargetIdentity', () => {
  it('rejects a replacement between lstat and realpath', async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-capture-'));
    const target = path.join(workDir, 'target');
    const replacement = path.join(workDir, 'replacement');
    await fs.promises.mkdir(target);
    await fs.promises.mkdir(replacement);
    const originalStat = await fs.promises.lstat(target, { bigint: true });
    const realLstat = fs.promises.lstat;
    const realRealpath = fs.promises.realpath;
    let lstatCalls = 0;

    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(target) && lstatCalls === 0) {
        lstatCalls += 1;
        return originalStat;
      }
      return realLstat(candidate, options as never);
    });
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
        await fs.promises.rename(replacement, target);
      }
      return realRealpath(candidate, options as never);
    });

    await expect(captureGhostSnapshotTargetIdentity(target)).rejects.toThrow(
      'snapshot target identity changed while capturing',
    );
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

describe('runGhostSnapshotWorkerRequest ensure fast path', () => {
  it('rejects an ABA replacement of the snapshot root during matches()', async () => {
    // GH Windows runners expose os.tmpdir() as an 8.3 short path while the
    // worker resolves roots via realpath (long-name canonical). Canonicalize
    // here so the readdir mock's path prefix matches the paths the worker
    // actually reads, otherwise the swap never fires and the test no-ops.
    workDir = fs.realpathSync.native(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-aba-')),
    );
    const idDir = path.join(workDir, 'skilled');
    const revision = '11111111-1111-4111-8111-111111111111';
    const target = path.join(idDir, revision);
    const replacement = path.join(workDir, 'replacement');
    const skillMd = '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n';
    await fs.promises.mkdir(path.join(target, 'skills', 'demo'), { recursive: true });
    await fs.promises.mkdir(path.join(replacement, 'skills', 'demo'), { recursive: true });
    await fs.promises.writeFile(path.join(target, 'skills', 'demo', 'SKILL.md'), skillMd);
    await fs.promises.writeFile(path.join(replacement, 'skills', 'demo', 'SKILL.md'), skillMd);

    const validated = validateGhostManifest({
      schemaVersion: 2,
      id: 'skilled',
      name: 'Skilled',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool', 'skill'],
      tools: [{ name: 'do_thing', description: 'do' }],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    });
    if (!validated.ok) throw new Error(validated.reason);
    const skillContentSha256 = await hashApprovedSkillContent(validated.manifest, target);
    const parentStats = await fs.promises.lstat(workDir, { bigint: true });
    const realReaddir = fs.promises.readdir;
    let swapped = false;

    vi.spyOn(fs.promises, 'readdir').mockImplementation(((
      candidate: fs.PathLike,
      options?: Parameters<typeof realReaddir>[1],
    ) => {
      const run = async () => {
        if (!swapped && path.resolve(String(candidate)).startsWith(path.resolve(target))) {
          swapped = true;
          await fs.promises.rename(target, `${target}.original`);
          await fs.promises.rename(replacement, target);
        }
        return realReaddir(candidate, options as never);
      };
      return run();
    }) as typeof fs.promises.readdir);

    await expect(runGhostSnapshotWorkerRequest({
      expectedParent: {
        realPath: await fs.promises.realpath(workDir),
        dev: parentStats.dev,
        ino: parentStats.ino,
      },
      operation: 'ensure',
      targetName: `skilled/${revision}`,
      sourceDir: target,
      receipt: {
        manifest: validated.manifest,
        skillContentSha256,
      },
    }, workDir)).rejects.toThrow(/ghost content root changed while reading|snapshot target identity changed/);
  });
});

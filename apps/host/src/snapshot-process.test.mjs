import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotProcess } from './snapshot-process.mjs';
import { configureGhostSnapshotProcess, mutateGhostSnapshotWithStableParent } from '../../desktop/src/main/cindy-brain/ghostSnapshotCapability.js';

test('Node snapshot worker preserves parent identity checks before removing a snapshot', async t => {
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-'));
  t.after(() => fs.rm(parentDir, { recursive: true, force: true }));
  const stats = await fs.lstat(parentDir, { bigint: true });
  const expectedParent = { realPath: await fs.realpath(parentDir), dev: stats.dev, ino: stats.ino };
  const target = path.join(parentDir, 'sample');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'approved content');
  configureGhostSnapshotProcess(createSnapshotProcess);
  await assert.rejects(mutateGhostSnapshotWithStableParent({ parentDir, expectedParent: { ...expectedParent, ino: stats.ino + 1n }, operation: 'remove', targetName: 'sample' }));
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'approved content');
  await mutateGhostSnapshotWithStableParent({ parentDir, expectedParent, operation: 'remove', targetName: 'sample' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

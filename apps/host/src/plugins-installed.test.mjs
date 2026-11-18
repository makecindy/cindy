import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHostGhostManager, listInstalledGhosts } from './plugins-installed.ts';
import { writeTestCindyPackage } from '../../desktop/src/main/cindy-brain/__tests__/cindyPackageFixture.ts';
import { GhostInstallReceiptStore } from '../../desktop/src/main/cindy-brain/ghostInstallReceipt.ts';
import { installedGhostPhysicalRelId } from '../../desktop/src/shared/pluginIdentity.ts';

test('an owner without plugins lists nothing instead of failing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ghosts-'));
  try {
    const ghosts = await listInstalledGhosts({ userDataDir: root, ownerId: 'owner-a' });
    assert.deepEqual(ghosts, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// #10130 / 4560691468: the read-only Host factory must not finish an uninstall
// without its credential service. Unit tier; actual package and journal, no
// handwritten install/approval records or real waits.
test('Host keeps an interrupted uninstall until the same cleanup port is available', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-uninstall-')));
  const base = { userDataDir: root, ownerId: 'owner-a' };
  let blocked = true;
  const cleanup = async () => { if (blocked) throw new Error('vault unavailable'); };
  const options = { ...base, onUninstallSourceState: cleanup };
  try {
    let manager = createHostGhostManager(options);
    const packageFile = await writeTestCindyPackage(path.join(root, 'plugin.cindy'), {
      schemaVersion: 2, id: 'journal-source', name: 'Source', version: '1.0.0', kind: 'chip',
      entry: 'main.js', slots: ['tool'], tools: [{ name: 'run', description: 'run' }],
    });
    const result = await manager.install(packageFile);
    assert.ok('ghost' in result, JSON.stringify(result));
    const id = installedGhostPhysicalRelId(result.ghost);
    const store = new GhostInstallReceiptStore(() => manager.approvalStateRoot());
    assert.equal((await manager.uninstall(id)).rejection?.code, 'io');
    manager = createHostGhostManager(base);
    await manager.retryInterruptedMutationsAfterDbReady();
    assert.equal(fs.existsSync(result.ghost.dir), true);
    assert.equal(store.readPendingMutationSync(id).state, 'valid');
    assert.ok('rejection' in await manager.install(packageFile));
    blocked = false;
    manager = createHostGhostManager(options);
    await manager.retryInterruptedMutationsAfterDbReady();
    assert.equal(fs.existsSync(result.ghost.dir), false);
    assert.equal(store.readPendingMutationSync(id).state, 'missing');
    assert.ok('ghost' in await manager.install(packageFile));
    manager.disposeNotificationIndex();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

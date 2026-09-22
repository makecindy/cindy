import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { GhostManager } from '../GhostManager.js';
import {
  GhostInstallReceiptStore,
  createGhostInstallReceipt,
  hashApprovedSkillContent,
} from '../ghostInstallReceipt.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import JSZip from 'jszip';

let workDir: string;
let rootDir: string;
let manager: GhostManager;

beforeEach(async () => {
  workDir = fs.realpathSync.native(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ns-mig-mgr-')),
  );
  rootDir = path.join(workDir, 'ghosts');
  manager = new GhostManager({
    getRootDir: () => rootDir,
    mutateSnapshot: async (request) => {
      const { parentDir, ...workerRequest } = request;
      await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
    },
  });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function manifest(id = 'hello'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: 'do' }],
  };
}

async function plantLegacyInstall(id: string): Promise<void> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest(id)));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  const store = new GhostInstallReceiptStore(
    () => stateRoot,
    async ({ parentDir, targetName, operation }) => {
      if (operation === 'remove') {
        await fs.promises.rm(path.join(parentDir, targetName), { recursive: true, force: true });
      }
    },
  );
  const normalized = manifest(id) as never;
  await store.write(
    createGhostInstallReceipt({
      manifest: {
        schemaVersion: 2,
        id,
        name: 'Hello',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'do_thing', description: 'do' }],
      } as InstalledGhost['manifest'],
      localeResources: {},
      enabled: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      skillContentSha256: await hashApprovedSkillContent(
        { skill: undefined } as InstalledGhost['manifest'],
        dir,
      ),
    }),
    { skillSourceDir: dir },
  );
  void normalized;
}

async function makeCindy(id: string): Promise<string> {
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify(manifest(id)));
  zip.file('main.js', '// ok\n');
  const filePath = path.join(workDir, `${id}.cindy`);
  await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

describe('GhostManager namespace migration census', () => {
  it('captures a pre-namespace root install as pending and does not treat a later install as pending', async () => {
    await plantLegacyInstall('xd-feishu');
    const listed = manager.list();
    expect(listed).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'xd-feishu' }),
        namespaceMigration: 'pending',
      }),
    ]);
    expect(listed[0]?.namespace).toBeUndefined();

    const planted = await makeCindy('helper');
    const installed = await manager.install(planted);
    expect('ghost' in installed).toBe(true);
    const helperGhost = (installed as { ghost: { manifest: { id: string }; namespace?: unknown } }).ghost;
    expect(helperGhost.manifest.id).toBe('helper');
    expect(Object.prototype.hasOwnProperty.call(helperGhost, 'namespace')).toBe(false);
    const helper = manager.list().find((ghost) => ghost.manifest.id === 'helper');
    expect(helper).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(helper, 'namespace')).toBe(false);
    expect(helper?.namespaceMigration).toBeUndefined();
  });

  it('commits a pending builtin-looking install as root without moving the directory', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await expect(manager.commitPendingRootNamespace('hello', 'builtin')).resolves.toEqual({ ok: true });
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'hello' },
      namespace: null,
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(ghost?.dir).toBe(path.join(rootDir, 'hello'));
  });

  it('blocks a same-name organization install while the root instance is still pending', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('allows the organization instance after the pending root install is classified', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingRootNamespace('hello', 'market-public');
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      ghost: { namespace: 'acme', dir: path.join(rootDir, '_ns', 'acme', 'hello') },
    });
    expect(manager.list().map((ghost) => [ghost.namespace ?? null, ghost.manifest.id])).toEqual(
      expect.arrayContaining([
        [null, 'hello'],
        ['acme', 'hello'],
      ]),
    );
  });

  it('commits an organization namespace in place without moving the directory or storage key', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    await expect(manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization')).resolves.toEqual({
      ok: true,
    });
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
      dir: path.join(rootDir, 'xd-feishu'),
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    const { installedGhostStoragePart, installedGhostRuntimeId } = await import('../../../shared/pluginIdentity.js');
    expect(installedGhostStoragePart(ghost!)).toBe('xd-feishu');
    expect(installedGhostRuntimeId(ghost!)).toBe('xd-feishu');
  });

  it('disables and uninstalls an in-place namespaced plugin without inventing _ns paths', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    await expect(manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization')).resolves.toEqual({
      ok: true,
    });
    await expect(manager.setEnabled('_ns/xd/xd-feishu', false)).resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'xd-feishu'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    await expect(manager.setEnabled('xd-feishu', true)).resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.enabled).toBe(true);
    await expect(manager.uninstall('_ns/xd/xd-feishu', { notify: false })).resolves.toEqual({ ok: true });
    expect(fs.existsSync(path.join(rootDir, 'xd-feishu'))).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('treats a later install of the same organization identity as already installed', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'already-installed' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('recovers a half-written commit from the receipt instead of reclassifying', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    const stateRoot = path.join(workDir, 'ghosts-install-state');
    const store = new GhostInstallReceiptStore(
      () => stateRoot,
      async ({ parentDir, targetName, operation }) => {
        if (operation === 'remove') {
          await fs.promises.rm(path.join(parentDir, targetName), { recursive: true, force: true });
        }
      },
    );
    const current = store.read('xd-feishu');
    expect(current.state).toBe('approved');
    if (current.state !== 'approved') return;
    await store.write(
      { ...current.receipt, namespace: 'xd' },
      { skillSourceDir: path.join(rootDir, 'xd-feishu'), requireSkillSnapshot: false, relId: 'xd-feishu' },
    );
    await expect(manager.commitPendingNamespace('xd-feishu', null, 'builtin')).resolves.toEqual({
      ok: true,
    });
    expect(manager.list()[0]).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
    });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('skips the first namespace stamp while the plugin is busy', async () => {
    await plantLegacyInstall('hello');
    const busyManager = new GhostManager({
      getRootDir: () => rootDir,
      isNamespaceMigrationBusy: () => true,
      mutateSnapshot: async (request) => {
        const { parentDir, ...workerRequest } = request;
        await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
      },
    });
    busyManager.list();
    await expect(busyManager.commitPendingNamespace('hello', null, 'builtin')).resolves.toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(busyManager.list()[0]?.namespaceMigration).toBe('pending');
  });


});

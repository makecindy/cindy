import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { ghostSecretStorageKey } from '../../../shared/providerSecrets.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
import { pluginInstanceRegistryPath, type PluginInstanceRegistry } from '../pluginInstanceRegistry.js';
import { pendingCensusMismatches } from '../pluginInstanceRegistryService.js';
import {
  authorizeGhostHostPrimitive,
  authorizeGhostTokenBroker,
  resolveGhostFirstPartyPrivilege,
  type GhostFirstPartyFacts,
} from '../ghostFirstPartyPrivilege.js';
import {
  createGhostInstallReceipt,
  GhostInstallReceiptStore,
  hashApprovedSkillContent,
} from '../ghostInstallReceipt.js';
import { createGhostKvStore } from '../ghostKvStore.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';

const SHA = 'ab'.repeat(32);
const CLASSES = ['public-tool', 'manual-tool', 'xd-feishu', 'cindy-helper'] as const;
type PluginClass = (typeof CLASSES)[number];

let workDir: string;
let rootDir: string;
let dataRoot: string;
let manager: GhostManager;

const mutateSnapshot: NonNullable<GhostManagerOptions['mutateSnapshot']> = async ({ parentDir, ...request }) => {
  await runGhostSnapshotWorkerRequest(request, parentDir);
};

function createManager(options: Omit<GhostManagerOptions, 'getRootDir' | 'getStateDir'> = {}): GhostManager {
  return new GhostManager({
    getRootDir: () => rootDir,
    getStateDir: () => path.join(workDir, 'ghosts-install-state'),
    mutateSnapshot,
    ...options,
  });
}

function manifest(id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: 'do' }],
  };
}

async function plant(id: string): Promise<void> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const declared = manifest(id);
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(declared));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  const store = new GhostInstallReceiptStore(
    () => path.join(workDir, 'ghosts-install-state'),
    mutateSnapshot,
  );
  await store.write(createGhostInstallReceipt({
    manifest: declared as InstalledGhost['manifest'],
    localeResources: {},
    enabled: true,
    trust: { level: 'unverified', publisherSigned: false, publisherVerified: false, reviewed: false },
    skillContentSha256: await hashApprovedSkillContent(declared as InstalledGhost['manifest'], dir),
    packageSha256: SHA,
  }), { skillSourceDir: dir });
}

async function makeCindy(id: string): Promise<string> {
  return writeTestCindyPackage(path.join(workDir, id + '.cindy'), manifest(id), { 'main.js': '// next\n' });
}

function kv() {
  return createGhostKvStore({ getRootDir: () => path.join(dataRoot, 'kv') });
}

function writeOwnedData(instanceKey: string, payload: string): void {
  kv().write(instanceKey, { payload });
  fs.mkdirSync(path.join(dataRoot, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'secrets', ghostSecretStorageKey(instanceKey, 'token')), payload);
  fs.mkdirSync(path.join(dataRoot, 'oauth'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'oauth', instanceKey + '.json'), JSON.stringify({ refresh: payload }));
  const library = path.join(dataRoot, 'libraries', instanceKey);
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'marker.txt'), payload);
}

function expectOwnedData(instanceKey: string, payload: string): void {
  expect(kv().read(instanceKey)).toEqual({ payload });
  expect(fs.readFileSync(path.join(dataRoot, 'secrets', ghostSecretStorageKey(instanceKey, 'token')), 'utf8')).toBe(payload);
  expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'oauth', instanceKey + '.json'), 'utf8'))).toEqual({ refresh: payload });
  expect(fs.readFileSync(path.join(dataRoot, 'libraries', instanceKey, 'marker.txt'), 'utf8')).toBe(payload);
}


function censusMismatches(): string[] {
  const file = pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state'));
  return pendingCensusMismatches(JSON.parse(fs.readFileSync(file, 'utf8')) as PluginInstanceRegistry, 'strict');
}

function byId(id: string): InstalledGhost {
  const ghost = manager.list().find((item) => item.manifest.id === id);
  if (!ghost) throw new Error('missing ' + id);
  return ghost;
}

function factsFor(id: PluginClass, namespace: string | null, pending: boolean): GhostFirstPartyFacts {
  const org = id === 'xd-feishu'
    ? { organizationId: 'org-xd', orgSlug: 'xd' as string | null, pluginPrefix: 'xd' }
    : null;
  return {
    ghostId: id,
    namespace,
    builtin: false,
    installOrigin: 'manual',
    legacyPendingNamespace: pending && id === 'xd-feishu',
    legacyFirstPartyEligible: id === 'cindy-helper',
    currentOrganization: org,
    approvedPackageSha256: SHA,
    marketRecord: id === 'public-tool' || id === 'cindy-helper'
      ? {
          scope: 'public', source: 'market', installed: true, organizationId: null,
          sha256: SHA, approvedPackageSha256: SHA,
        }
      : id === 'xd-feishu'
        ? {
            scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
            sha256: SHA, approvedPackageSha256: SHA,
          }
        : null,
  };
}

function expectPrivileges(id: PluginClass, namespace: string | null, pending: boolean, broker: boolean, host: boolean): void {
  const facts = factsFor(id, namespace, pending);
  const resolved = resolveGhostFirstPartyPrivilege(facts);
  expect(resolved.brokerEligible).toBe(broker);
  expect(resolved.hostPrimitiveEligible).toBe(host);
  expect(authorizeGhostTokenBroker(id, { kind: 'ready', facts })).toBe(broker);
  expect(authorizeGhostHostPrimitive(id, { kind: 'ready', facts })).toBe(host);
}

beforeEach(async () => {
  workDir = fs.realpathSync.native(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ns-matrix-')));
  rootDir = path.join(workDir, 'ghosts');
  dataRoot = path.join(workDir, 'owner-a-data');
  manager = createManager();
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('namespace downgrade matrix', () => {
  it('keeps all four plugin classes usable offline after the upgrade census', async () => {
    for (const id of CLASSES) await plant(id);
    manager.list();
    const keys = Object.fromEntries(CLASSES.map((id) => [id, installedGhostStoragePart(byId(id))])) as Record<PluginClass, string>;
    for (const id of CLASSES) writeOwnedData(keys[id], 'data:' + id);
    await manager.reconcilePendingRootNamespaces(false);

    expect(manager.list().map((ghost) => ghost.manifest.id).sort()).toEqual([...CLASSES].sort());
    for (const id of CLASSES) {
      const ghost = byId(id);
      expect(ghost.enabled).toBe(true);
      expect(ghost.dir).toBe(path.join(rootDir, id));
      expect(installedGhostStoragePart(ghost)).toBe(keys[id]);
      expect(ghost.namespaceMigration).toBe('pending');
      expect(manager.readDeliveryNamespace(keys[id])).toBeUndefined();
      expectOwnedData(keys[id], 'data:' + id);
    }
    expect(kv().read(keys['public-tool'])).not.toEqual(kv().read(keys['xd-feishu']));
    expectPrivileges('public-tool', null, true, false, false);
    expectPrivileges('manual-tool', null, true, false, false);
    expectPrivileges('xd-feishu', null, true, true, true);
    expectPrivileges('cindy-helper', null, true, true, true);
  });

  it('survives an old client editing each class and still restores only confirmed privileges', async () => {
    for (const id of CLASSES) await plant(id);
    await manager.commitPendingNamespace('public-tool', null, 'market-public');
    await manager.commitPendingNamespace('manual-tool', null, 'manual-after-sync');
    await manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization');
    await manager.commitPendingNamespace('cindy-helper', null, 'builtin');
    const keys = Object.fromEntries(CLASSES.map((id) => [id, installedGhostStoragePart(byId(id))])) as Record<PluginClass, string>;
    for (const id of CLASSES) writeOwnedData(keys[id], 'kept:' + id);

    for (const id of CLASSES) {
      const store = new GhostInstallReceiptStore(() => path.join(workDir, 'ghosts-install-state'), mutateSnapshot);
      const approval = store.read(id);
      if (approval.state !== 'approved') throw new Error('expected approval');
      const { namespace: _namespace, ...downgraded } = approval.receipt;
      await store.write({ ...downgraded, enabled: id !== 'public-tool', packageSha256: SHA }, {
        relId: id, requireSkillSnapshot: false,
      });
      const marker = path.join(rootDir, id, '.disabled');
      if (id === 'public-tool') fs.writeFileSync(marker, '');
      else fs.rmSync(marker, { force: true });
    }
    manager = createManager();
    expect(byId('public-tool').enabled).toBe(false);
    await expect(manager.setEnabled('public-tool', true)).resolves.toEqual({ ok: true });
    await expect(manager.setEnabled('xd-feishu', false)).resolves.toEqual({ ok: true });
    await expect(manager.setEnabled('xd-feishu', true)).resolves.toEqual({ ok: true });
    const updated = await manager.update(await makeCindy('cindy-helper'), {
      expectedInstalledApproval: ghostInstallApprovalToken(byId('cindy-helper').approval),
      namespace: null,
    });
    expect(updated).toMatchObject({ ghost: { dir: path.join(rootDir, 'cindy-helper') } });
    await expect(manager.uninstall('manual-tool', { notify: false })).resolves.toEqual({ ok: true });
    await expect(manager.install(await makeCindy('manual-tool'))).resolves.toMatchObject({
      ghost: { instanceKey: keys['manual-tool'], namespace: null },
    });

    for (const id of CLASSES) {
      const ghost = byId(id);
      expect(ghost.dir).toBe(path.join(rootDir, id));
      expect(installedGhostStoragePart(ghost)).toBe(keys[id]);
      expectOwnedData(keys[id], 'kept:' + id);
      expect(manager.readDeliveryNamespace(keys[id])).not.toBe('xd');
    }
    expect(byId('xd-feishu').namespaceState).toBe('unconfirmed');
    expectPrivileges('xd-feishu', null, false, false, false);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);

    manager = createManager({
      readUnconfirmedConfirmationEvidence: (record) => record.ghostId === 'xd-feishu' ? {
        marketRecords: [{
          namespace: 'xd', organizationId: 'org-xd', packageSha256: SHA, scope: 'organization', installed: true,
        }],
        currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd' },
        packageSha256: SHA,
      } : { marketRecords: [], packageSha256: SHA },
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(byId('xd-feishu')).toMatchObject({ namespace: 'xd', namespaceState: 'confirmed', enabled: true });
    expect(manager.readDeliveryNamespace(keys['xd-feishu'])).toBe('xd');
    expectPrivileges('xd-feishu', 'xd', false, true, true);
    expectOwnedData(keys['xd-feishu'], 'kept:xd-feishu');
    expectOwnedData(keys['public-tool'], 'kept:public-tool');
  });

  it('does not leak plugin data or identity across data owners', async () => {
    let owner = 'a';
    const switched = new GhostManager({
      getRootDir: () => path.join(workDir, owner, 'ghosts'),
      getStateDir: () => path.join(workDir, owner, 'state'),
      getOwnerContextKey: () => owner,
      mutateSnapshot,
    });
    rootDir = path.join(workDir, 'a', 'ghosts');
    dataRoot = path.join(workDir, 'a', 'data');
    manager = switched;
    for (const id of CLASSES) await plant(id);
    manager.list();
    const keys = Object.fromEntries(CLASSES.map((id) => [id, installedGhostStoragePart(byId(id))])) as Record<PluginClass, string>;
    for (const id of CLASSES) writeOwnedData(keys[id], 'owner-a:' + id);
    await manager.reconcilePendingRootNamespaces(false);

    owner = 'b';
    rootDir = path.join(workDir, 'b', 'ghosts');
    dataRoot = path.join(workDir, 'b', 'data');
    expect(manager.list()).toEqual([]);
    expect(kv().read(keys['public-tool'])).toEqual({});
    await plant('public-tool');
    manager.list();
    writeOwnedData(installedGhostStoragePart(byId('public-tool')), 'owner-b:public-tool');

    owner = 'a';
    rootDir = path.join(workDir, 'a', 'ghosts');
    dataRoot = path.join(workDir, 'a', 'data');
    expect(manager.list().map((ghost) => ghost.manifest.id).sort()).toEqual([...CLASSES].sort());
    for (const id of CLASSES) {
      expect(installedGhostStoragePart(byId(id))).toBe(keys[id]);
      expectOwnedData(keys[id], 'owner-a:' + id);
    }
    expect(byId('public-tool').namespaceMigration).toBe('pending');
  });

  it('reconnects an enterprise plugin after an old client changes its package and rewrites the market row', async () => {
    await plant('xd-feishu');
    await manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization');
    const key = installedGhostStoragePart(byId('xd-feishu'));
    writeOwnedData(key, 'kept:xd-feishu');
    const newSha = 'cd'.repeat(32);
    const store = new GhostInstallReceiptStore(() => path.join(workDir, 'ghosts-install-state'), mutateSnapshot);
    const approval = store.read('xd-feishu');
    if (approval.state !== 'approved') throw new Error('expected approval');
    const { namespace: dropped, ...rewritten } = approval.receipt;
    expect(dropped).toBe('xd');
    await store.write({ ...rewritten, packageSha256: newSha }, {
      relId: 'xd-feishu', requireSkillSnapshot: false,
    });

    const staleRow = {
      organizationId: 'org-xd', packageSha256: newSha, scope: 'organization' as const, installed: true,
    };
    manager = createManager({
      readUnconfirmedConfirmationEvidence: () => ({
        marketRecords: [staleRow],
        currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd' },
        packageSha256: newSha,
      }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(byId('xd-feishu')).toMatchObject({ namespaceState: 'unconfirmed', dir: path.join(rootDir, 'xd-feishu') });
    expect(manager.readDeliveryNamespace(key)).toBeUndefined();
    expect(installedGhostStoragePart(byId('xd-feishu'))).toBe(key);
    expectOwnedData(key, 'kept:xd-feishu');
    expect(manager.approvedInstallEvidence('xd-feishu')?.packageSha256).toBe(newSha);
    const denied = resolveGhostFirstPartyPrivilege({
      ghostId: 'xd-feishu', namespace: null, builtin: false, installOrigin: 'manual',
      legacyPendingNamespace: false,
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' },
      approvedPackageSha256: newSha,
      marketRecord: {
        scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
        sha256: newSha, approvedPackageSha256: newSha,
      },
    });
    expect(denied.brokerEligible).toBe(false);

    manager = createManager({
      readUnconfirmedConfirmationEvidence: (record) => record.ghostId === 'xd-feishu' ? {
        marketRecords: [{
          namespace: 'xd', organizationId: 'org-xd', packageSha256: newSha,
          scope: 'organization', installed: true,
        }],
        currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd' },
        packageSha256: newSha,
      } : { marketRecords: [], packageSha256: newSha },
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(byId('xd-feishu')).toMatchObject({
      namespace: 'xd', namespaceState: 'confirmed', dir: path.join(rootDir, 'xd-feishu'),
    });
    expect(manager.readDeliveryNamespace(key)).toBe('xd');
    expect(installedGhostStoragePart(byId('xd-feishu'))).toBe(key);
    expectOwnedData(key, 'kept:xd-feishu');
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    expect(censusMismatches()).toEqual([]);
    const restored = resolveGhostFirstPartyPrivilege({
      ghostId: 'xd-feishu', namespace: 'xd', builtin: false, installOrigin: 'manual',
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' },
      approvedPackageSha256: newSha,
      marketRecord: {
        scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
        sha256: newSha, approvedPackageSha256: newSha,
      },
    });
    expect(restored).toMatchObject({ brokerEligible: true, hostPrimitiveEligible: true, basis: 'market-organization-current' });
    expect(authorizeGhostTokenBroker('xd-feishu', { kind: 'ready', facts: {
      ghostId: 'xd-feishu', namespace: 'xd', builtin: false, installOrigin: 'manual',
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' },
      approvedPackageSha256: newSha,
      marketRecord: {
        scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
        sha256: newSha, approvedPackageSha256: newSha,
      },
    } })).toBe(true);
  });

  it('keeps official cindy plugin broker eligibility after an old client strips namespace', async () => {
    manager = createManager({
      captureLegacyFirstPartyEligibility: (ghostId) => ghostId === 'cindy-helper',
    });
    await plant('cindy-helper');
    expect(manager.ensureNamespaceMigrationCensus()?.entries['cindy-helper']?.status).toBe('pending');
    expect(manager.readLegacyFirstPartyEligible('cindy-helper')).toBe(true);
    await manager.commitPendingNamespace('cindy-helper', null, 'builtin');
    const key = installedGhostStoragePart(byId('cindy-helper'));
    writeOwnedData(key, 'kept:cindy-helper');
    const store = new GhostInstallReceiptStore(() => path.join(workDir, 'ghosts-install-state'), mutateSnapshot);
    const approval = store.read('cindy-helper');
    if (approval.state !== 'approved') throw new Error('expected approval');
    const { namespace: dropped, ...downgraded } = approval.receipt;
    expect(dropped).toBeNull();
    expect(downgraded.legacyFirstPartyEligible).toBe(true);
    await store.write(downgraded, { relId: 'cindy-helper', requireSkillSnapshot: false });

    manager = createManager();
    manager.list();
    expect(byId('cindy-helper')).toMatchObject({ namespaceState: 'unconfirmed', dir: path.join(rootDir, 'cindy-helper') });
    expect(manager.readDeliveryNamespace(key)).toBeUndefined();
    expect(manager.readLegacyFirstPartyEligible('cindy-helper')).toBe(true);
    expect(installedGhostStoragePart(byId('cindy-helper'))).toBe(key);
    expectOwnedData(key, 'kept:cindy-helper');
    expect(censusMismatches()).toEqual([]);
    const facts = {
      ghostId: 'cindy-helper',
      namespace: null,
      builtin: false,
      installOrigin: 'manual' as const,
      legacyFirstPartyEligible: manager.readLegacyFirstPartyEligible('cindy-helper'),
      currentOrganization: null,
      approvedPackageSha256: SHA,
      marketRecord: null,
    };
    expect(resolveGhostFirstPartyPrivilege(facts)).toMatchObject({
      brokerEligible: true, hostPrimitiveEligible: true, basis: 'legacy-existing-install',
    });
    expect(authorizeGhostTokenBroker('cindy-helper', { kind: 'ready', facts })).toBe(true);
    expect(authorizeGhostHostPrimitive('cindy-helper', { kind: 'ready', facts })).toBe(true);
  });
});

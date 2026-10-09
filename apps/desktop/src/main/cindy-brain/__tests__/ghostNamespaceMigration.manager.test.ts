import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import { PluginMarketLedger } from '../../plugin-market/ledger.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
import { resolveGhostFirstPartyPrivilege } from '../ghostFirstPartyPrivilege.js';
import {
  classifyNamespaceMigration,
  readNamespaceMigrationInstallOrigin,
  readNamespaceMigrationMarketRecord,
} from '../ghostNamespaceMigration.js';
import {
  assertManagedPluginParentSync,
  GhostInstallReceiptStore,
  createGhostInstallReceipt,
  hashApprovedSkillContent,
} from '../ghostInstallReceipt.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';
import { installedGhostStoragePart, pluginStoragePart } from '../../../shared/pluginIdentity.js';
import { pluginInstanceRegistryPath } from '../pluginInstanceRegistry.js';

let workDir: string;
let rootDir: string;
let manager: GhostManager;
const demoSkillSource = '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n';

const mutateSnapshot: NonNullable<GhostManagerOptions['mutateSnapshot']> = async ({ parentDir, ...request }) => {
  await runGhostSnapshotWorkerRequest(request, parentDir);
};

function createManager(options: Omit<GhostManagerOptions, 'getRootDir'> = {}): GhostManager {
  return new GhostManager({ getRootDir: () => rootDir, ...options });
}

function receiptStore(mutation?: GhostManagerOptions['mutateSnapshot']): GhostInstallReceiptStore {
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  return new GhostInstallReceiptStore(() => stateRoot, mutation);
}

beforeEach(async () => {
  workDir = fs.realpathSync.native(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ns-mig-mgr-')),
  );
  rootDir = path.join(workDir, 'ghosts');
  manager = createManager({ mutateSnapshot });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function manifest(id = 'hello', withSkill = false): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: withSkill ? ['tool', 'skill'] : ['tool'],
    tools: [{ name: 'do_thing', description: 'do' }],
    ...(withSkill ? {
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    } : {}),
  };
}

it.each(['_ns', '_ns/_root'])('rejects linked %s parents for content recovery and state journals', async (reservedRoot) => {
  const outside = path.join(workDir, 'outside');
  const contentNs = path.join(rootDir, reservedRoot);
  const relId = reservedRoot === '_ns' ? '_ns/acme/hello' : '_ns/_root/hello';
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  await fs.promises.mkdir(outside, { recursive: true });
  await fs.promises.mkdir(path.dirname(contentNs), { recursive: true });
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, contentNs, 'dir');
  expect(() => assertManagedPluginParentSync(rootDir, relId)).toThrow();

  const store = new GhostInstallReceiptStore(() => stateRoot);
  await fs.promises.mkdir(path.dirname(path.join(stateRoot, reservedRoot)), { recursive: true });
  await fs.promises.symlink(outside, path.join(stateRoot, reservedRoot), 'dir');
  await expect(store.writePendingMutation(relId, {
    kind: 'install', packageSha256: 'a'.repeat(64),
  })).rejects.toThrow();
  expect(store.readPendingMutationSync(relId).state).toBe('unreadable');
  expect(store.listPendingMutationIdsSync().state).toBe('unreadable');
  expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
});

it('does not recover an interrupted namespaced uninstall through a linked content parent', async () => {
  const outside = path.join(workDir, 'outside');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  await fs.promises.mkdir(path.join(outside, 'acme', 'hello'), { recursive: true });
  await fs.promises.writeFile(path.join(outside, 'acme', 'hello', 'sentinel'), 'keep');
  await fs.promises.mkdir(rootDir, { recursive: true });
  await fs.promises.symlink(outside, path.join(rootDir, '_ns'), 'dir');
  const store = new GhostInstallReceiptStore(() => stateRoot);
  await store.writePendingMutation('_ns/acme/hello', { kind: 'uninstall' });
  manager = createManager({ getStateDir: () => stateRoot });
  expect(fs.readFileSync(path.join(outside, 'acme', 'hello', 'sentinel'), 'utf8')).toBe('keep');
  expect(store.readPendingMutationSync('_ns/acme/hello').state).toBe('valid');
});

it('refuses to publish a namespaced receipt through a linked approval parent', async () => {
  await plantLegacyInstall('hello');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  const outside = path.join(workDir, 'outside');
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, path.join(stateRoot, '_ns'), 'dir');
  const store = new GhostInstallReceiptStore(() => stateRoot);
  const approval = store.read('hello');
  expect(approval.state).toBe('approved');
  if (approval.state !== 'approved') return;
  await expect(store.write({ ...approval.receipt, namespace: 'acme' }, {
    relId: '_ns/acme/hello', requireSkillSnapshot: false,
  })).rejects.toThrow('parent is not a real directory');
  expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
});

async function plantLegacyInstall(
  id: string,
  withSkill = false,
  installOrigin?: 'agent-forge',
): Promise<void> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const declared = manifest(id, withSkill);
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(declared));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  if (withSkill) {
    await fs.promises.mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), demoSkillSource);
  }
  const store = receiptStore(mutateSnapshot);
  const approvedManifest = {
    ...declared,
  } as InstalledGhost['manifest'];
  await store.write(
    createGhostInstallReceipt({
      manifest: approvedManifest,
      localeResources: {},
      enabled: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      skillContentSha256: await hashApprovedSkillContent(approvedManifest, dir),
      installOrigin,
    }),
    { skillSourceDir: dir },
  );
}

async function makeCindy(id: string, withSkill = false): Promise<string> {
  return writeTestCindyPackage(path.join(workDir, `${id}.cindy`), manifest(id, withSkill), {
    'main.js': '// ok\n',
    ...(withSkill ? { 'skills/demo/SKILL.md': demoSkillSource } : {}),
  });
}

async function stampLegacyOrganizationInstall(id = 'hello', withSkill = false): Promise<void> {
  await plantLegacyInstall(id, withSkill);
  manager.list();
  await manager.commitPendingNamespace(id, 'acme', 'market-organization');
}

describe('GhostManager namespace migration census', () => {
  it('retries a failed first directory scan instead of persisting an empty census', async () => {
    await plantLegacyInstall('hello');
    const actualRead = fs.readdirSync;
    const read = vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
      if (String(directory) === rootDir) {
        read.mockRestore();
        throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
      }
      return actualRead(directory, ...(args as []));
    }) as typeof fs.readdirSync);
    try {
      expect(manager.ensureNamespaceMigrationCensus()).toBeNull();
    } finally {
      read.mockRestore();
    }
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
  });
  it('keeps an old unstamped install unresolved when its census is unavailable', async () => {
    await plantLegacyInstall('hello');
    fs.writeFileSync(path.join(workDir, 'ghosts-install-state', 'namespace-migration.v1.json'), '{');
    expect(manager.list()[0]).toMatchObject({ namespaceState: 'unconfirmed', namespace: null });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
  });

  it('rejects a namespace commit when the receipt changes after classification', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const classify = vi.fn(() => {
      const current = receiptStore().read('hello');
      if (current.state !== 'approved') throw new Error('expected approved receipt');
      fs.writeFileSync(
        path.join(workDir, 'ghosts-install-state', 'hello.json'),
        JSON.stringify({ ...current.receipt, packageSha256: 'c'.repeat(64) }),
      );
      return { kind: 'commit' as const, namespace: 'acme', basis: 'market-organization' as const };
    });
    const beforeCommit = vi.fn();
    manager = createManager({ classifyPendingNamespace: classify, beforeNamespaceCommit: beforeCommit });
    await manager.reconcilePendingRootNamespaces(true);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();
  });
  it('passes sync state to classification and commits only after facts become available', async () => {
    await plantLegacyInstall('hello');
    let factsAvailable = false;
    const committed = vi.fn();
    const classify = vi.fn<NonNullable<GhostManagerOptions['classifyPendingNamespace']>>(
      (_ghostId, synced) => factsAvailable && synced
        ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
        : { kind: 'pending', reason: 'awaiting-market-facts' },
    );
    manager = createManager({
      classifyPendingNamespace: classify,
      onNamespaceCommitted: committed,
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(classify).toHaveBeenLastCalledWith('hello', true);
    expect(manager.list()[0]?.namespace).toBeUndefined();
    expect(committed).not.toHaveBeenCalled();
    factsAvailable = true;
    await manager.reconcilePendingRootNamespaces(false);
    expect(classify).toHaveBeenLastCalledWith('hello', false);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(committed).toHaveBeenCalledOnce();
  });

  it('waits for the real legacy Forge receipt and organization prefix before committing namespace', async () => {
    await plantLegacyInstall('acme-tool', false, 'agent-forge');
    const receiptFile = path.join(workDir, 'ghosts-install-state', 'acme-tool.json');
    const receiptBytes = fs.readFileSync(receiptFile);
    let pluginPrefix: string | null = null;
    manager = createManager({
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => classifyNamespaceMigration({
        ghostId,
        builtin: false,
        installOrigin: readNamespaceMigrationInstallOrigin(() => manager.readApprovedInstallOriginStrict(ghostId)),
        marketSyncCompleted,
        marketRecord: null,
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix },
      }),
    });
    expect(manager.ensureNamespaceMigrationCensus()?.entries['acme-tool']?.status).toBe('pending');

    fs.writeFileSync(receiptFile, '{');
    expect(() => manager.readApprovedInstallOriginStrict('acme-tool')).toThrow();
    await manager.reconcilePendingRootNamespaces(true);
    // An invalid receipt is not adopted, so the registry does not project pending.
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.list()[0]?.namespace).toBeUndefined();

    fs.writeFileSync(receiptFile, receiptBytes);
    expect(manager.readApprovedInstallOriginStrict('acme-tool')).toBe('agent-forge');
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();

    pluginPrefix = 'acme';
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(receiptStore().read('acme-tool')).toMatchObject({
      state: 'approved', receipt: { installOrigin: 'agent-forge', namespace: 'acme' },
    });
  });

  it.each([false, true])('stops, stamps and restarts an offline resident with in-flight work %s', async (initiallyInFlight) => {
    await plantLegacyInstall('hello');
    vi.useFakeTimers();
    try {
      let inFlight = initiallyInFlight;
      let runtimeBusy = false;
      let retry: Promise<void> | undefined;
      const events: string[] = [];
      const stop = vi.fn(async () => {
        if (inFlight) return false;
        runtimeBusy = false;
        events.push('stopped');
        return true;
      });
      const deferred = vi.fn(() => {
        setTimeout(() => { retry = manager.reconcilePendingRootNamespaces(true); }, 1000);
      });
      manager = createManager({
        classifyPendingNamespace: (_ghostId, synced) => synced
          ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
          : { kind: 'pending', reason: 'awaiting-market-facts' },
        isNamespaceMigrationBusy: () => inFlight || runtimeBusy,
        canResumePendingResidentOffline: () => true,
        onResumePendingResidentOffline: (ghost) => {
          expect(ghost.approval.state).toBe('approved');
          runtimeBusy = true;
          events.push('started');
        },
        preparePendingResidentForMigration: stop,
        onPendingResidentMigrationDeferred: deferred,
        beforeNamespaceCommit: () => events.push('stamped'),
        onNamespaceCommitted: () => events.push('restarted'),
      });
      manager.resumePendingResidentsOffline();
      await manager.reconcilePendingRootNamespaces(false);
      expect(events).toEqual(['started']);
      expect(manager.list()[0]?.namespaceMigration).toBe('pending');
      await manager.reconcilePendingRootNamespaces(true);
      if (initiallyInFlight) {
        expect(stop).toHaveBeenCalledOnce();
        expect(deferred).toHaveBeenCalledWith('hello');
        expect(events).toEqual(['started']);
        expect(manager.list()[0]?.namespaceMigration).toBe('pending');
        expect(manager.list()[0]?.namespace).toBeUndefined();
        inFlight = false;
        await vi.advanceTimersByTimeAsync(1000);
        expect(retry).toBeDefined();
        await retry;
      } else {
        expect(deferred).not.toHaveBeenCalled();
      }
      expect(stop).toHaveBeenCalledTimes(initiallyInFlight ? 2 : 1);
      expect(events).toEqual(['started', 'stopped', 'stamped', 'restarted']);
      expect(manager.list()[0]?.namespace).toBe('acme');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a failed market namespace commit so the offline resident can retry', async () => {
    await plantLegacyInstall('hello');
    const deferred = vi.fn();
    let failStamp = true;
    manager = createManager({
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      preparePendingResidentForMigration: async () => true,
      onPendingResidentMigrationDeferred: deferred,
      beforeNamespaceCommit: () => {
        if (failStamp) throw new Error('market ledger unavailable');
      },
    });
    await expect(manager.reconcilePendingRootNamespaces(true)).resolves.toBeUndefined();
    expect(deferred).toHaveBeenCalledWith('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(receiptStore().read('hello')).toMatchObject({ state: 'approved' });
    const approval = receiptStore().read('hello');
    if (approval.state !== 'approved') throw new Error('expected approved receipt');
    expect(approval.receipt).not.toHaveProperty('namespace');
    failStamp = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
  });

  it('continues migrating other entries after one entry fails', async () => {
    await plantLegacyInstall('first');
    await plantLegacyInstall('second');
    manager.list();
    manager = createManager({
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      beforeNamespaceCommit: (ghostId) => {
        if (ghostId === 'first') throw new Error('first entry unavailable');
      },
    });
    await expect(manager.reconcilePendingRootNamespaces(true)).resolves.toBeUndefined();
    expect(manager.list().find((ghost) => ghost.manifest.id === 'first')).toMatchObject({
      namespaceMigration: 'pending',
    });
    expect(manager.list().find((ghost) => ghost.manifest.id === 'second')).toMatchObject({
      namespace: 'acme',
    });
  });

  it('abandons an offline migration if its owner changes during safe stop', async () => {
    await plantLegacyInstall('hello');
    let owner = 'original';
    let releaseStop: (() => void) | undefined;
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    const committed = vi.fn();
    manager = createManager({
      getOwnerContextKey: () => owner,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: vi.fn(),
      preparePendingResidentForMigration: async () => { await stopping; return true; },
      onNamespaceCommitted: committed,
    });
    manager.resumePendingResidentsOffline();
    const migration = manager.reconcilePendingRootNamespaces(true);
    owner = 'replacement';
    releaseStop?.();
    await migration;
    expect(committed).not.toHaveBeenCalled();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('does not publish a namespace commit when its owner changes while writing the receipt', async () => {
    await plantLegacyInstall('hello');
    let owner = 'original';
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const write = vi.spyOn(GhostInstallReceiptStore.prototype, 'write').mockImplementation(async () => {
      writeStarted?.();
      await blocked;
    });
    const committed = vi.fn();
    try {
      manager = createManager({
        getOwnerContextKey: () => owner,
        onNamespaceCommitted: committed,
      });
      manager.list();
      const migration = manager.commitPendingNamespace('hello', 'acme', 'market-organization');
      await writing;
      owner = 'replacement';
      releaseWrite?.();
      await expect(migration).rejects.toThrow('owner changed');
      expect(committed).not.toHaveBeenCalled();
      expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    } finally {
      write.mockRestore();
    }
  });

  it('stops offline residency when the market responds but the organization slug is not yet known', async () => {
    await plantLegacyInstall('hello');
    let slugKnown = false;
    let busy = false;
    const stopped = vi.fn(async () => { busy = false; return true; });
    manager = createManager({
      classifyPendingNamespace: () => slugKnown
        ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
        : { kind: 'pending', reason: 'awaiting-organization-namespace' },
      isNamespaceMigrationBusy: () => busy,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: () => { busy = true; },
      preparePendingResidentForMigration: stopped,
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    slugKnown = true;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
  });

  it('treats bare directories as pending only until the one-shot census is written', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    expect(manager.list()).toEqual([]);
    await plantLegacyInstall('recovered');
    await plantLegacyInstall('unverified');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBe('pending');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBe('pending');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'unverified')?.namespaceMigration).toBe('pending');
    const orgCindy = await makeCindy('recovered');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, 'recovered'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'unverified'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'recovered'))).toBe(false);
    expect(manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'recovered'))?.namespaceMigration).toBe('pending');
  });

  it('recovers an organization install whose approved namespace was erased by a downgraded client', async () => {
    await plantLegacyInstall('hello');
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const store = receiptStore();
    const approval = store.read('hello');
    expect(approval.state).toBe('approved');
    if (approval.state !== 'approved') return;
    const { namespace: oldNamespace, ...downgradedReceipt } = approval.receipt;
    expect(oldNamespace).toBe('acme');
    await store.write(downgradedReceipt, { relId: 'hello', requireSkillSnapshot: false });
    expect(manager.list()[0]).toMatchObject({ namespaceState: 'unconfirmed' });
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'already-installed' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);

    const sha = 'ab'.repeat(32);
    const stripped = receiptStore().read('hello');
    if (stripped.state !== 'approved') throw new Error('expected stripped receipt');
    await receiptStore().write({ ...stripped.receipt, packageSha256: sha }, { relId: 'hello', requireSkillSnapshot: false });
    manager = createManager({ mutateSnapshot });
    await manager.reconcilePendingRootNamespaces(true);
    const legacy = () => manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'hello'));
    expect(legacy()).toMatchObject({ namespace: 'acme', namespaceState: 'unconfirmed' });
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    manager = createManager({
      mutateSnapshot,
      readUnconfirmedConfirmationEvidence: () => ({
        marketRecords: [{
          namespace: 'acme', organizationId: 'org-acme', packageSha256: sha, scope: 'organization', installed: true,
        }],
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
        packageSha256: sha,
      }),
    });
    await manager.reconcilePendingRootNamespaces(false);
    expect(legacy()).toMatchObject({ namespace: 'acme', namespaceState: 'unconfirmed' });
    await manager.reconcilePendingRootNamespaces(true);
    expect(legacy()).toMatchObject({ namespace: 'acme', namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('hello')).toBe('acme');
  });

  it.each([false, true].flatMap((enabled) => [0, 1, 2].map((updates) => ({ enabled, updates }))))(
    'recaptures a migrated Forge namespace after $updates updates and old-client setEnabled($enabled)', async ({ enabled, updates }) => {
    await plantLegacyInstall('acme-tool', true, 'agent-forge');
    const options: Omit<GhostManagerOptions, 'getRootDir'> = {
      mutateSnapshot,
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => classifyNamespaceMigration({
        ghostId, builtin: false, marketSyncCompleted, marketRecord: null,
        installOrigin: readNamespaceMigrationInstallOrigin(() => manager.readApprovedInstallOriginStrict(ghostId)),
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      }),
      readUnconfirmedConfirmationEvidence: () => ({
        marketRecords: [],
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
        forgeSelfTest: true,
      }),
    };
    manager = createManager(options);
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme', enabled: true });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    for (let updateIndex = 0; updateIndex < updates; updateIndex += 1) {
      const previousRevision = manager.list()[0].approval;
      const updated = await manager.update(await makeCindy('acme-tool', true), {
        expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0].approval),
        namespace: 'acme', installOrigin: 'agent-forge',
      });
      expect(updated).toMatchObject({ ghost: { namespace: 'acme', approval: { state: 'approved' } } });
      if (!('ghost' in updated) || previousRevision.state !== 'approved' || updated.ghost.approval.state !== 'approved') {
        throw new Error('expected approved Forge update');
      }
      expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
      expect(JSON.stringify(manager.ensureNamespaceMigrationCensus())).not.toContain('forgeNamespaces');
    }
    const store = receiptStore(mutateSnapshot);
    const approval = store.read('acme-tool');
    if (approval.state !== 'approved') throw new Error('expected migrated Forge receipt');
    const { namespace: oldNamespace, ...downgradedReceipt } = approval.receipt;
    expect(oldNamespace).toBe('acme');
    await store.write({ ...downgradedReceipt, enabled }, {
      relId: 'acme-tool', skillSourceDir: path.join(rootDir, 'acme-tool'),
    });
    if (!enabled) fs.writeFileSync(path.join(rootDir, 'acme-tool', '.disabled'), '');
    manager = createManager(options);
    await manager.reconcilePendingRootNamespaces(false);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme', namespaceState: 'unconfirmed' });
    expect(manager.readDeliveryNamespace('acme-tool')).toBeUndefined();
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme', enabled, dir: path.join(rootDir, 'acme-tool') });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.readDeliveryNamespace('acme-tool')).toBe('acme');
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    expect(fs.existsSync(path.join(rootDir, '_ns'))).toBe(false);
    expect(await manager.verifyApprovedSkillSnapshot(manager.list()[0])).toBe(true);
    },
  );

  it('does not write a forge revision chain or replace an unknown migration schema during update', async () => {
    await plantLegacyInstall('acme-tool', false, 'agent-forge');
    manager = createManager({
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'forge-current-org' }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    const ledgerPath = path.join(manager.approvalStateRoot(), 'namespace-migration.v1.json');
    const future = '{"schemaVersion":2,"entries":{"keep":true}}\n';
    fs.writeFileSync(ledgerPath, future);
    expect(await manager.update(await makeCindy('acme-tool'), {
      namespace: 'acme', installOrigin: 'agent-forge',
      expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0].approval),
    })).toHaveProperty('ghost');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(future);
    manager = createManager({});
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(future);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme', enabled: true });
  });

  it.each(['post-census-forge', 'post-census-manual', 'reinstalled-forge', 'changed-origin', 'different-org', 'missing-prefix'] as const)(
    'does not recapture an unverified Forge namespace for %s', async (scenario) => {
      await fs.promises.mkdir(rootDir, { recursive: true });
      let orgSlug = 'acme';
      let pluginPrefix: string | null = 'acme';
      const options: Omit<GhostManagerOptions, 'getRootDir'> = {
          classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => classifyNamespaceMigration({
          ghostId, builtin: false, marketSyncCompleted, marketRecord: null,
          installOrigin: readNamespaceMigrationInstallOrigin(() => manager.readApprovedInstallOriginStrict(ghostId)),
          currentOrganization: { organizationId: 'org-acme', orgSlug, pluginPrefix },
        }),
      };
      manager = createManager(options);
      if (scenario.startsWith('post-census')) {
        manager.ensureNamespaceMigrationCensus();
      } else {
        await plantLegacyInstall('acme-tool', false, 'agent-forge');
        await manager.reconcilePendingRootNamespaces(true);
        expect(manager.list()[0]?.namespace).toBe('acme');
      }
      if (scenario.startsWith('post-census') || scenario === 'reinstalled-forge') {
        await plantLegacyInstall('acme-tool', false, scenario === 'post-census-manual' ? undefined : 'agent-forge');
      } else {
        const store = receiptStore();
        const approval = store.read('acme-tool');
        if (approval.state !== 'approved') throw new Error('expected migrated receipt');
        const { namespace: _namespace, ...unstamped } = approval.receipt;
        await store.write({
          ...unstamped, ...(scenario === 'changed-origin' ? { installOrigin: 'manual' } : {}),
        }, { relId: 'acme-tool', requireSkillSnapshot: false });
        if (scenario === 'different-org') orgSlug = 'other';
        if (scenario === 'missing-prefix') pluginPrefix = null;
      }
      manager = createManager(options);
      await manager.reconcilePendingRootNamespaces(true);
      if (scenario.startsWith('post-census')) {
        expect(manager.list()[0]).toMatchObject({ namespace: null, namespaceState: 'unconfirmed' });
        expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
      } else {
        expect(manager.list()[0]).toMatchObject({ namespace: 'acme', namespaceState: 'unconfirmed' });
        expect(manager.readDeliveryNamespace('acme-tool')).toBeUndefined();
      }
      expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    },
  );

  it('does not claim a post-census downgrade install without verified market evidence', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    manager.list();
    await plantLegacyInstall('hello');
    manager = createManager({
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: null, basis: 'manual-after-sync' }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: null, namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('hello')).toBeNull();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' }, namespace: 'acme' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
  });

  it('resumes a post-census unstamped resident offline without assigning it root identity', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    manager.list();
    await plantLegacyInstall('hello');
    const resumed = vi.fn((ghost: InstalledGhost) => ghost.namespaceMigration);
    manager = createManager({
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: resumed,
    });
    manager.resumePendingResidentsOffline();
    expect(resumed).toHaveBeenCalledOnce();
    expect(resumed.mock.results[0]?.value).toBe('pending');
  });

  it('does not assign an organization namespace to a plugin planted after the census', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    await plantLegacyInstall('hello');
    manager = createManager({
      mutateSnapshot,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      readUnconfirmedConfirmationEvidence: () => ({
        marketRecords: [{
          namespace: 'acme', organizationId: 'org-acme', packageSha256: 'ab'.repeat(32), scope: 'organization', installed: true,
        }],
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
        packageSha256: 'ab'.repeat(32),
      }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    // Planted after the empty census. Evidence for a different namespace must not adopt it.
    expect(manager.list()[0]).toMatchObject({ namespace: null, namespaceState: 'unconfirmed' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    expect(manager.list()[0]?.enabled).toBe(true);
  });

  it('keeps a receipt-stamped namespace pending until its market record is stamped', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    let shouldFail = true;
    manager = createManager({
      mutateSnapshot,
      onNamespaceCommitted: () => {
        if (shouldFail) throw new Error('market ledger unavailable');
      },
    });
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .rejects.toThrow('market ledger unavailable');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    shouldFail = false;
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.namespace).toBe('acme');
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

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
    expect(helperGhost).toHaveProperty('namespace', null);
    const helper = manager.list().find((ghost) => ghost.manifest.id === 'helper');
    expect(helper).toBeDefined();
    expect(helper).toHaveProperty('namespace', null);
    expect(helper?.namespaceMigration).toBeUndefined();
  });

  it('lets a root reinstall proceed after uninstalling a pending legacy install', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await expect(manager.uninstall('hello', { notify: false })).resolves.toEqual({ ok: true });
    const cindy = await makeCindy('hello');
    await expect(manager.install(cindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' } },
    });
  });

  it.each(['interrupted', 'ledger-write-failed'] as const)(
    'finishes pending legacy uninstall after %s before allowing a root reinstall', async (boundary) => {
      await plantLegacyInstall('hello');
      expect(manager.ensureNamespaceMigrationCensus()?.entries.hello).toBeDefined();
      const store = receiptStore(mutateSnapshot);
      if (boundary === 'interrupted') {
        await store.writePendingMutation('hello', { kind: 'uninstall' });
      } else {
        const registryPath = pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state'));
        const rename = fs.renameSync;
        const blocked = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
          if (String(target) === registryPath) throw new Error('EIO: registry publication failed');
          return rename(source, target);
        });
        try {
          await expect(manager.uninstall('hello')).resolves.toEqual({ ok: true });
          expect(store.readPendingMutationSync('hello').state).toBe('valid');
          expect(manager.ensureNamespaceMigrationCensus()?.entries.hello).toBeDefined();
        } finally { blocked.mockRestore(); }
      }
      manager = createManager({ mutateSnapshot });
      expect(manager.list()).toEqual([]);
      expect(store.readPendingMutationSync('hello').state).toBe('missing');
      expect(store.readForRecovery('hello').state).toBe('missing');
      expect(manager.ensureNamespaceMigrationCensus()?.entries.hello).toBeUndefined();
      manager = createManager({ mutateSnapshot });
      await expect(manager.install(await makeCindy('hello'))).resolves.toMatchObject({
        ghost: { manifest: { id: 'hello' }, namespace: null },
      });
    },
  );

  it('keeps a pending census while the root directory is in an update backup', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const live = path.join(rootDir, 'hello');
    const backup = path.join(rootDir, '.cindy-updating-hello-deadbeef');
    await fs.promises.rename(live, backup);
    manager.list();
    await fs.promises.rename(backup, live);
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('captures the original receipt when the first census sees an update backup', async () => {
    await plantLegacyInstall('hello');
    const receipts = receiptStore();
    const backupName = '.cindy-updating-hello-deadbeef';
    await receipts.writePendingMutation('hello', {
      kind: 'update',
      packageSha256: 'a'.repeat(64),
      backupDirName: backupName,
      phase: 'backed-up',
    });
    await fs.promises.rename(path.join(rootDir, 'hello'), path.join(rootDir, backupName));
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
    await fs.promises.rename(path.join(rootDir, backupName), path.join(rootDir, 'hello'));
    await receipts.clearPendingMutation('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('blocks a same-name organization install while the root instance is still pending', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('defers a classified busy root and commits its identity before installing a sibling', async () => {
    await plantLegacyInstall('hello');
    const marketLedger = new PluginMarketLedger(path.join(workDir, 'market', 'ledger.v1.json'));
    marketLedger.upsertInstallation({
      pluginId: 'root-resource', ghostId: 'hello', releaseId: 'root-release',
      version: '1.0.0', sha256: 'a'.repeat(64), scope: 'public', organizationId: null,
      source: 'market', installed: true, updatedAt: '2026-09-30T00:00:00.000Z',
    });
    let busy = true;
    manager = createManager({
      isNamespaceMigrationBusy: () => busy,
      classifyPendingNamespace: (ghostId) => classifyNamespaceMigration({
        ghostId, builtin: false, installOrigin: 'manual', marketSyncCompleted: true,
        marketRecord: readNamespaceMigrationMarketRecord(() => marketLedger.installationsForGhost(ghostId)),
        currentOrganization: null,
      }),
      beforeNamespaceCommit: (ghostId, namespace) => {
        if (!marketLedger.stampNamespaceIfAbsent(ghostId, namespace)) throw new Error('stamp failed');
      },
      mutateSnapshot,
    });
    manager.list();
    await manager.reconcilePendingRootNamespaces(true);
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
    expect(marketLedger.installationsForGhost('hello')).toHaveLength(1);
    expect(manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'hello'))?.namespaceMigration).toBe('pending');
    busy = false;
    await manager.reconcilePendingRootNamespaces(true);
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' }, namespace: 'acme' },
    });
    expect(marketLedger.installationForPlugin({ ghostId: 'hello', namespace: null })).toMatchObject({ namespace: null });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    expect(manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'hello'))).toMatchObject({
      namespace: null,
      namespaceState: 'confirmed',
    });
  });

  it('keeps an already ambiguous multi-record pending install blocked without stamping either row', async () => {
    await plantLegacyInstall('hello');
    const beforeCommit = vi.fn();
    manager = createManager({
      classifyPendingNamespace: (ghostId) => classifyNamespaceMigration({
        ghostId, builtin: false, installOrigin: 'manual', marketSyncCompleted: true,
        marketRecord: readNamespaceMigrationMarketRecord(() => [
          { scope: 'public', source: 'market', organizationId: null, installed: true },
          { scope: 'organization', source: 'market', organizationId: 'org-acme', namespace: 'acme', installed: true },
        ]),
        currentOrganization: null,
      }),
      beforeNamespaceCommit: beforeCommit,
    });
    manager.list();
    await manager.reconcilePendingRootNamespaces(true);
    await expect(manager.install(await makeCindy('hello'), { namespace: 'other' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'hello'))?.namespaceMigration).toBe('pending');
    expect(fs.existsSync(path.join(rootDir, '_ns', 'other', 'hello'))).toBe(false);
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

  it.each([null, 'xd'] as const)('commits namespace %s without moving the directory or storage key', async (namespace) => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    const committed = namespace === null
      ? manager.commitPendingRootNamespace('xd-feishu', 'builtin')
      : manager.commitPendingNamespace('xd-feishu', namespace, 'market-organization');
    await expect(committed).resolves.toEqual({ ok: true });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace,
      dir: path.join(rootDir, 'xd-feishu'),
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '_ns', '_root', 'xd-feishu'))).toBe(false);
    expect(installedGhostStoragePart(ghost!)).toBe('xd-feishu');
  });

  it('finishes a receipt-first commit by removing the pending entry after a restart', async () => {
    await plantLegacyInstall('hello');
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
    const stateRoot = path.join(workDir, 'ghosts-install-state');
    const receipts = receiptStore(mutateSnapshot);
    const approval = receipts.read('hello');
    if (approval.state !== 'approved') throw new Error('expected approved receipt');
    await receipts.write({ ...approval.receipt, namespace: 'xd' }, {
      relId: 'hello', skillSourceDir: path.join(rootDir, 'hello'), requireSkillSnapshot: false,
    });
    manager = createManager({ getStateDir: () => stateRoot });
    await expect(manager.commitPendingNamespace('hello', null, 'market-public')).resolves.toEqual({ ok: true });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    manager = createManager({ getStateDir: () => stateRoot });
    expect(manager.list()[0]).toMatchObject({ namespace: 'xd', dir: path.join(rootDir, 'hello') });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
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

  it.each([false, true])('installs a same-name root without moving or stopping a legacy organization with skill %s', async (withSkill) => {
    await stampLegacyOrganizationInstall('hello', withSkill);
    const before = receiptStore(mutateSnapshot).read('hello');
    const busy = vi.fn(() => true);
    manager = createManager({ mutateSnapshot, isNamespaceMigrationBusy: busy });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      ghost: { namespace: null, dir: path.join(rootDir, '_ns', '_root', 'hello') },
    });
    expect(busy).not.toHaveBeenCalled();
    expect(receiptStore(mutateSnapshot).read('hello')).toEqual(before);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
    expect(manager.list().map((ghost) => [ghost.namespace, ghost.dir])).toEqual(expect.arrayContaining([
      ['acme', path.join(rootDir, 'hello')], [null, path.join(rootDir, '_ns', '_root', 'hello')],
    ]));
    expect(manager.list().map(installedGhostStoragePart).sort()).toEqual(expect.arrayContaining(['hello']));
    expect(manager.list().map(installedGhostStoragePart)).toEqual(expect.arrayContaining(['hello', '_root__hello']));
    if (withSkill) {
      const org = manager.list().find((ghost) => ghost.namespace === 'acme');
      expect(org).toBeDefined();
      await expect(manager.verifyApprovedSkillSnapshot(org!)).resolves.toBe(true);
    }
    manager = createManager({ mutateSnapshot });
    expect(manager.list()).toHaveLength(2);
    await expect(manager.setEnabled('_ns/_root/hello', false)).resolves.toEqual({ ok: true });
    expect(manager.list().find((ghost) => ghost.namespace === 'acme')?.enabled).toBe(true);
    await expect(manager.uninstall('_ns/_root/hello')).resolves.toEqual({ ok: true });
    expect(manager.list()).toEqual([expect.objectContaining({ namespace: 'acme', dir: path.join(rootDir, 'hello') })]);
  });

  it.each([null, 'acme'] as const)('updates a legacy %s installation in place', async (namespace) => {
    await plantLegacyInstall('hello', true);
    manager.list();
    await manager.commitPendingNamespace('hello', namespace, namespace === null ? 'explicit-root' : 'market-organization');
    const ghost = manager.list()[0];
    const { ghostInstallApprovalToken } = await import('../../../shared/ghost.js');
    await expect(manager.update(await makeCindy('hello'), {
      namespace, expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
    })).resolves.toMatchObject({ ghost: { namespace, dir: path.join(rootDir, 'hello') } });
    expect(fs.existsSync(path.join(rootDir, '_ns', '_root', 'hello'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('does not let an absent new root instance mutate a same-name legacy root', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', null, 'explicit-root');
    const before = receiptStore().read('hello');
    expect(await manager.setEnabled('_ns/_root/hello', false)).toMatchObject({ rejection: { code: 'not-installed' } });
    expect(await manager.uninstall('_ns/_root/hello')).toMatchObject({ rejection: { code: 'not-installed' } });
    expect(await manager.removeInstallApproval('_ns/_root/hello')).toBe(true);
    expect(receiptStore().read('hello')).toEqual(before);
    expect(manager.list()).toEqual([expect.objectContaining({ enabled: true, dir: path.join(rootDir, 'hello') })]);
  });

  it.each(['_ns/_root', '_ns/acme', '_ns/acme/org-helper'])('keeps other installs visible when %s is temporarily unreadable', async (unreadable) => {
    await manager.install(await makeCindy('hello'));
    await manager.install(await makeCindy('org-helper'), { namespace: 'acme' });
    const target = path.join(rootDir, ...unreadable.split('/'));
    const realLstat = fs.lstatSync;
    const locked = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      if (String(filePath) === target) throw Object.assign(new Error('locked'), { code: 'EACCES' });
      return realLstat(filePath, options as never);
    });
    try {
      expect(manager.list().map((ghost) => ghost.manifest.id)).toEqual([unreadable === '_ns/_root' ? 'org-helper' : 'hello']);
    } finally {
      locked.mockRestore();
    }
  });

  it('keeps the legacy organization approved when a new root package cannot be installed', async () => {
    await stampLegacyOrganizationInstall('hello', true);
    const before = receiptStore(mutateSnapshot).read('hello');
    const file = await makeCindy('hello', true);
    manager = createManager({ mutateSnapshot: async () => { throw new Error('snapshot unavailable'); } });
    await expect(manager.install(file)).resolves.toMatchObject({ rejection: { code: 'io' } });
    expect(receiptStore(mutateSnapshot).read('hello')).toEqual(before);
    expect(manager.list()).toEqual([expect.objectContaining({ namespace: 'acme', approval: expect.objectContaining({ state: 'approved' }) })]);
  });

  it('installs and verifies a namespaced skill snapshot under its physical identity', async () => {
    const filePath = await makeCindy('helper', true);
    const result = await manager.install(filePath, { namespace: 'acme' });
    expect(result).toMatchObject({ ghost: { manifest: { id: 'helper' } } });
    if (!('ghost' in result)) return;
    expect(result.ghost.approvedSkillRoot).toContain(path.join('_ns', 'acme', 'helper'));
    await expect(manager.verifyApprovedSkillSnapshot(result.ghost)).resolves.toBe(true);
  });

  it('treats a later install of the same organization identity as already installed', async () => {
    await stampLegacyOrganizationInstall();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'already-installed' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('skips the first namespace stamp while the plugin is busy', async () => {
    await plantLegacyInstall('hello');
    const busyManager = createManager({
      isNamespaceMigrationBusy: () => true,
      mutateSnapshot,
    });
    busyManager.list();
    await expect(busyManager.commitPendingNamespace('hello', null, 'builtin')).resolves.toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(busyManager.list()[0]?.namespaceMigration).toBe('pending');
  });


});

describe('plugin instance registry boundaries', () => {
  it('uses the directory key for a new install and removes that key on uninstall', async () => {
    const installed = await manager.install(await makeCindy('hello'));
    expect(installed).toMatchObject({ ghost: { instanceKey: '_root__hello', namespace: null } });
    expect(installedGhostStoragePart(manager.list()[0]!)).toBe('_root__hello');
    await expect(manager.setEnabled('_ns/_root/hello', false)).resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.enabled).toBe(false);
    await expect(manager.uninstall('_ns/_root/hello', { notify: false })).resolves.toEqual({ ok: true });
    expect(manager.list()).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, '_ns', '_root', 'hello'))).toBe(false);
  });

  it('rebuilds the same directory key when the registry file is missing or corrupt', async () => {
    await expect(manager.install(await makeCindy('hello'), { namespace: 'xd' })).resolves.toMatchObject({
      ghost: { instanceKey: '_ns__xd__hello', namespace: 'xd' },
    });
    const registryPath = pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state'));
    await fs.promises.rm(registryPath);
    manager = createManager({ mutateSnapshot });
    expect(manager.list()[0]).toMatchObject({
      instanceKey: '_ns__xd__hello', namespace: 'xd', namespaceState: 'confirmed',
    });
    fs.writeFileSync(registryPath, '{');
    manager = createManager({ mutateSnapshot });
    expect(manager.list()[0]).toMatchObject({
      instanceKey: '_ns__xd__hello', namespace: 'xd', namespaceState: 'confirmed',
    });
    expect(fs.existsSync(registryPath)).toBe(true);
    expect(fs.readFileSync(registryPath, 'utf8')).not.toBe('{');
  });

  it('does not quarantine or rewrite a newer instance registry schema', async () => {
    await expect(manager.install(await makeCindy('hello'), { namespace: 'xd' })).resolves.toHaveProperty('ghost');
    const registryPath = pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state'));
    const future = '{"schemaVersion":3,"census":null,"instances":{"keep":true}}\n';
    fs.writeFileSync(registryPath, future);
    manager = createManager({ mutateSnapshot });
    expect(manager.list()[0]).toMatchObject({ manifest: { id: 'hello' }, enabled: true });
    expect(manager.readDeliveryNamespace('_ns__xd__hello')).toBeUndefined();
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(future);
    expect(fs.readdirSync(path.dirname(registryPath)).some((name) => name.includes('corrupt-'))).toBe(false);
  });

  it('does not grant legacy pending to a plugin planted after the census', async () => {
    expect(manager.list()).toEqual([]);
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    await plantLegacyInstall('later');
    manager = createManager({ mutateSnapshot });
    expect(manager.list()[0]).toMatchObject({ namespaceState: 'unconfirmed', namespace: null });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.isPendingLegacyNamespace('later')).toBe(false);
    expect(manager.readDeliveryNamespace('later')).toBeUndefined();
  });

  it('addresses an in-place organization by its directory key beside a root sibling', async () => {
    await plantLegacyInstall('hello');
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization')).resolves.toEqual({ ok: true });
    await expect(manager.install(await makeCindy('hello'))).resolves.toMatchObject({
      ghost: { instanceKey: '_root__hello', namespace: null },
    });
    expect(manager.readDeliveryNamespace('hello')).toBe('acme');
    expect(manager.readDeliveryNamespace('_root__hello')).toBeNull();
    expect(manager.list().map(installedGhostStoragePart).sort()).toEqual(['_root__hello', 'hello']);
  });

  it('reattaches an upgraded install when the market reinstalls it', async () => {
    await expect(manager.install(await makeCindy('hello'))).resolves.toMatchObject({
      ghost: { instanceKey: '_root__hello' },
    });
    await expect(manager.uninstall('_ns/_root/hello', { notify: false })).resolves.toEqual({ ok: true });
    await expect(manager.install(await makeCindy('hello'), {
      registrySource: 'market', pluginId: 'plugin-a',
    })).resolves.toMatchObject({ ghost: { instanceKey: '_root__hello' } });
    const registry = JSON.parse(fs.readFileSync(
      pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state')), 'utf8',
    )) as { instances: Record<string, { source: string; pluginId: string | null; contentRelId: string; active: boolean }> };
    expect(registry.instances['_root__hello']).toMatchObject({
      source: 'market', pluginId: 'plugin-a', contentRelId: '_ns/_root/hello', active: true,
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', '_root', 'hello'))).toBe(true);
  });

  it('records the market plugin id instead of treating the install as manual', async () => {
    await expect(manager.install(await makeCindy('hello'), {
      namespace: 'acme', registrySource: 'market', pluginId: 'plugin-a',
    })).resolves.toMatchObject({ ghost: { instanceKey: '_ns__acme__hello' } });
    const registry = JSON.parse(fs.readFileSync(
      pluginInstanceRegistryPath(path.join(workDir, 'ghosts-install-state')), 'utf8',
    )) as { instances: Record<string, { source: string; pluginId: string | null }> };
    expect(registry.instances['_ns__acme__hello']).toMatchObject({
      source: 'market', pluginId: 'plugin-a',
    });
  });

  it('clears the registry cache when the data owner changes', async () => {
    let owner = 'a';
    const switched = new GhostManager({
      getRootDir: () => path.join(workDir, owner, 'ghosts'),
      getStateDir: () => path.join(workDir, owner, 'state'),
      getOwnerContextKey: () => owner,
      mutateSnapshot,
    });
    await expect(switched.install(await makeCindy('hello'), { namespace: 'xd' })).resolves.toMatchObject({
      ghost: { namespace: 'xd' },
    });
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBe('xd');
    owner = 'b';
    await expect(switched.install(await makeCindy('hello'))).resolves.toMatchObject({
      ghost: { namespace: null, instanceKey: '_root__hello' },
    });
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBeUndefined();
    expect(switched.readDeliveryNamespace('_root__hello')).toBeNull();
    expect(switched.list()).toEqual([
      expect.objectContaining({ namespace: null, namespaceState: 'confirmed', instanceKey: '_root__hello' }),
    ]);
    owner = 'a';
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBe('xd');
    expect(switched.list()).toEqual([
      expect.objectContaining({ namespace: 'xd', namespaceState: 'confirmed', instanceKey: '_ns__xd__hello' }),
    ]);
  });
});

describe('downgrade then upgrade', () => {
  const sha = 'cd'.repeat(32);

  async function rewriteLikeOldClient(relId: string, enabled: boolean): Promise<void> {
    const store = receiptStore(mutateSnapshot);
    const approval = store.read(relId);
    if (approval.state !== 'approved') throw new Error('expected approved receipt');
    const { namespace: _namespace, ...downgraded } = approval.receipt;
    await store.write(
      { ...downgraded, enabled, packageSha256: sha },
      { relId, requireSkillSnapshot: false },
    );
    const marker = path.join(rootDir, relId, '.disabled');
    if (enabled) fs.rmSync(marker, { force: true });
    else fs.writeFileSync(marker, '');
  }

  it('keeps every pre-namespace class usable and restores privileges only from positive evidence', async () => {
    await plantLegacyInstall('public-tool');
    await plantLegacyInstall('manual-tool');
    await plantLegacyInstall('org-tool');
    await plantLegacyInstall('cindy-helper');
    await expect(manager.commitPendingNamespace('public-tool', null, 'market-public')).resolves.toEqual({ ok: true });
    await expect(manager.commitPendingNamespace('manual-tool', null, 'manual-after-sync')).resolves.toEqual({ ok: true });
    await expect(manager.commitPendingNamespace('org-tool', 'acme', 'market-organization')).resolves.toEqual({ ok: true });
    await expect(manager.commitPendingNamespace('cindy-helper', null, 'builtin')).resolves.toEqual({ ok: true });

    await rewriteLikeOldClient('public-tool', false);
    await rewriteLikeOldClient('manual-tool', true);
    await rewriteLikeOldClient('org-tool', true);
    await rewriteLikeOldClient('cindy-helper', true);

    manager = createManager({ mutateSnapshot });
    const byId = (id: string) => manager.list().find((ghost) => ghost.manifest.id === id);
    expect(manager.list().map((ghost) => ghost.manifest.id).sort()).toEqual([
      'cindy-helper', 'manual-tool', 'org-tool', 'public-tool',
    ]);
    expect(byId('public-tool')).toMatchObject({
      enabled: false, namespace: null, namespaceState: 'unconfirmed', dir: path.join(rootDir, 'public-tool'),
    });
    expect(byId('manual-tool')).toMatchObject({
      enabled: true, namespace: null, namespaceState: 'unconfirmed', dir: path.join(rootDir, 'manual-tool'),
    });
    expect(byId('org-tool')).toMatchObject({
      enabled: true, namespace: 'acme', namespaceState: 'unconfirmed', dir: path.join(rootDir, 'org-tool'),
    });
    expect(byId('cindy-helper')).toMatchObject({
      enabled: true, namespace: null, namespaceState: 'unconfirmed', dir: path.join(rootDir, 'cindy-helper'),
    });
    for (const id of ['public-tool', 'manual-tool', 'org-tool', 'cindy-helper']) {
      expect(manager.readDeliveryNamespace(id)).toBeUndefined();
      expect(byId(id)?.namespaceMigration).toBeUndefined();
    }

    manager = createManager({
      mutateSnapshot,
      readUnconfirmedConfirmationEvidence: (record) => {
        if (record.ghostId === 'manual-tool') return { marketRecords: [], packageSha256: sha };
        if (record.ghostId === 'org-tool') {
          return {
            marketRecords: [{
              namespace: 'acme', organizationId: 'org-acme', packageSha256: sha, scope: 'organization', installed: true,
            }],
            currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
            packageSha256: sha,
          };
        }
        return {
          marketRecords: [{
            namespace: null, organizationId: null, packageSha256: sha, scope: 'public', installed: true,
          }],
          packageSha256: sha,
        };
      },
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(byId('public-tool')).toMatchObject({ enabled: false, namespace: null, namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('public-tool')).toBeNull();
    expect(byId('cindy-helper')).toMatchObject({ enabled: true, namespace: null, namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('cindy-helper')).toBeNull();
    expect(byId('org-tool')).toMatchObject({ enabled: true, namespace: 'acme', namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('org-tool')).toBe('acme');
    expect(byId('manual-tool')).toMatchObject({ enabled: true, namespace: null, namespaceState: 'unconfirmed' });
    expect(manager.readDeliveryNamespace('manual-tool')).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '_ns'))).toBe(false);
  });

  it('does not show the previous owner registry after a downgrade', async () => {
    let owner = 'a';
    const switched = new GhostManager({
      getRootDir: () => path.join(workDir, owner, 'ghosts'),
      getStateDir: () => path.join(workDir, owner, 'state'),
      getOwnerContextKey: () => owner,
      mutateSnapshot,
    });
    await expect(switched.install(await makeCindy('hello'), { namespace: 'xd' })).resolves.toMatchObject({
      ghost: { namespace: 'xd', instanceKey: '_ns__xd__hello' },
    });
    const store = new GhostInstallReceiptStore(() => path.join(workDir, 'a', 'state'), mutateSnapshot);
    const approval = store.read('_ns/xd/hello');
    if (approval.state !== 'approved') throw new Error('expected owner approval');
    const { namespace: _namespace, ...downgraded } = approval.receipt;
    await store.write(downgraded, { relId: '_ns/xd/hello', requireSkillSnapshot: false });
    expect(switched.list()[0]).toMatchObject({ namespace: 'xd', namespaceState: 'unconfirmed' });
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBeUndefined();
    owner = 'b';
    expect(switched.list()).toEqual([]);
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBeUndefined();
    owner = 'a';
    expect(switched.readDeliveryNamespace('_ns__xd__hello')).toBeUndefined();
    expect(switched.list()).toEqual([
      expect.objectContaining({ namespace: 'xd', namespaceState: 'unconfirmed', instanceKey: '_ns__xd__hello' }),
    ]);
  });
});


describe('unconfirmed organization recovery', () => {
  const sha = 'ab'.repeat(32);
  const org = { organizationId: 'org-xd', orgSlug: 'xd' as string | null };

  async function stripNamespace(relId: string): Promise<void> {
    const store = receiptStore(mutateSnapshot);
    const approval = store.read(relId);
    if (approval.state !== 'approved') throw new Error('expected approval');
    const { namespace: _namespace, ...rest } = approval.receipt;
    await store.write({ ...rest, packageSha256: sha }, { relId, requireSkillSnapshot: false });
  }

  it('confirms again after market sync restores a namespace an old client removed', async () => {
    await plantLegacyInstall('xd-feishu');
    await expect(manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization')).resolves.toEqual({ ok: true });
    await stripNamespace('xd-feishu');
    const ledger = new PluginMarketLedger(path.join(workDir, 'market', 'ledger.v1.json'));
    const pluginId = 'c' + 'e'.repeat(24);
    ledger.upsertInstallation({
      pluginId, ghostId: 'xd-feishu', releaseId: 'release-1', version: '1.0.0',
      sha256: sha, scope: 'organization', organizationId: 'org-xd', source: 'market',
      installed: true, updatedAt: '2026-10-08T00:00:00.000Z',
    });
    const evidenceFor = () => {
      const row = ledger.installationForPlugin({ ghostId: 'xd-feishu', namespace: 'xd' })
        ?? ledger.installationForPlugin({ ghostId: 'xd-feishu' });
      return {
        marketRecords: row ? [{
          ...(Object.prototype.hasOwnProperty.call(row, 'namespace') ? { namespace: row.namespace ?? null } : {}),
          organizationId: row.organizationId,
          packageSha256: row.sha256,
          scope: row.scope,
          installed: row.installed,
        }] : [],
        currentOrganization: org,
        packageSha256: sha,
      };
    };
    manager = createManager({ mutateSnapshot, readUnconfirmedConfirmationEvidence: evidenceFor });
    expect(manager.list()[0]).toMatchObject({ namespace: 'xd', namespaceState: 'unconfirmed' });
    expect(ledger.backfillMissingNamespacesFromCatalog([{
      id: pluginId, ghostId: 'xd-feishu', scope: 'organization', organizationId: 'org-other', namespace: 'xd',
    }])).toBe(0);
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespaceState).toBe('unconfirmed');
    ledger.upsertInstallation({ ...ledger.installationForPlugin({ ghostId: 'xd-feishu' })!, sha256: 'cd'.repeat(32) });
    expect(ledger.backfillMissingNamespacesFromCatalog([{
      id: pluginId, ghostId: 'xd-feishu', scope: 'organization', organizationId: 'org-xd', namespace: 'xd',
    }])).toBe(1);
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.readDeliveryNamespace('xd-feishu')).toBeUndefined();
    ledger.upsertInstallation({ ...ledger.installationForPlugin({ ghostId: 'xd-feishu', namespace: 'xd' })!, sha256: sha });
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'xd', namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('xd-feishu')).toBe('xd');
    expect(resolveGhostFirstPartyPrivilege({
      ghostId: 'xd-feishu', namespace: 'xd', builtin: false, installOrigin: 'manual',
      currentOrganization: { organizationId: 'org-xd', orgSlug: null, pluginPrefix: 'xd' },
      marketRecord: {
        scope: 'organization', source: 'market', installed: true, organizationId: 'org-xd',
        sha256: sha, approvedPackageSha256: sha,
      },
      approvedPackageSha256: sha,
    }).brokerEligible).toBe(true);
  });

  it('does not stamp a namespace when the receipt changes while evidence is collected', async () => {
    await plantLegacyInstall('hello');
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization')).resolves.toEqual({ ok: true });
    await stripNamespace('hello');
    const receiptPath = path.join(workDir, 'ghosts-install-state', 'hello.json');
    manager = createManager({
      mutateSnapshot,
      readUnconfirmedConfirmationEvidence: () => {
        const raw = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { revision: string };
        raw.revision = '99999999-9999-4999-8999-999999999999';
        fs.writeFileSync(receiptPath, JSON.stringify(raw));
        return {
          marketRecords: [{
            namespace: 'acme', organizationId: 'org-acme', packageSha256: sha, scope: 'organization', installed: true,
          }],
          currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
          packageSha256: sha,
        };
      },
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceState: 'unconfirmed', namespace: 'acme' });
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    const after = receiptStore(mutateSnapshot).read('hello');
    expect(after.state === 'approved' && after.receipt.namespace).not.toBe('acme');
  });

  it('confirms a root and an organization instance from their own market rows', async () => {
    await plantLegacyInstall('helper');
    await expect(manager.commitPendingNamespace('helper', 'xd', 'market-organization')).resolves.toEqual({ ok: true });
    await expect(manager.install(await makeCindy('helper'))).resolves.toHaveProperty('ghost');
    await stripNamespace('helper');
    await stripNamespace('_ns/_root/helper');
    manager = createManager({
      mutateSnapshot,
      readUnconfirmedConfirmationEvidence: (record) => ({
        marketRecords: [record.namespace === 'xd'
          ? { namespace: 'xd', organizationId: 'org-xd', packageSha256: sha, scope: 'organization' as const, installed: true }
          : { namespace: null, organizationId: null, packageSha256: sha, scope: 'public' as const, installed: true }],
        currentOrganization: org,
        packageSha256: sha,
      }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    const listed = manager.list();
    expect(listed.find((ghost) => ghost.namespace === 'xd')).toMatchObject({ namespaceState: 'confirmed' });
    expect(listed.find((ghost) => ghost.namespace === null)).toMatchObject({ namespaceState: 'confirmed' });
    expect(manager.readDeliveryNamespace('helper')).toBe('xd');
    expect(manager.readDeliveryNamespace('_root__helper')).toBeNull();
  });

  it('upgrades a v1 registry by importing the legacy ledger once', async () => {
    await plantLegacyInstall('hello');
    await plantLegacyInstall('kept');
    const receipts = receiptStore(mutateSnapshot);
    const helloReceipt = receipts.read('hello');
    const keptReceipt = receipts.read('kept');
    if (helloReceipt.state !== 'approved' || keptReceipt.state !== 'approved') {
      throw new Error('expected approved receipts');
    }
    await receipts.write({ ...keptReceipt.receipt, namespace: 'acme' }, {
      relId: 'kept', skillSourceDir: path.join(rootDir, 'kept'), requireSkillSnapshot: false,
    });
    const stamped = receipts.read('kept');
    if (stamped.state !== 'approved') throw new Error('expected stamped receipt');
    const state = path.join(workDir, 'ghosts-install-state');
    const v1Path = path.join(state, 'plugin-instances.v1.json');
    const legacyPath = path.join(state, 'namespace-migration.v1.json');
    const v1 = {
      schemaVersion: 1,
      instances: {
        hello: {
          instanceKey: 'hello', contentRelId: 'hello', ghostId: 'hello', namespace: null,
          namespaceState: 'unconfirmed', pluginId: null, source: 'legacy',
          receiptRevision: helloReceipt.receipt.revision,
          packageSha256: helloReceipt.receipt.packageSha256 ?? null, active: true,
        },
        kept: {
          instanceKey: 'kept', contentRelId: 'kept', ghostId: 'kept', namespace: 'acme',
          namespaceState: 'confirmed', pluginId: 'plugin-kept', source: 'market',
          receiptRevision: stamped.receipt.revision,
          packageSha256: stamped.receipt.packageSha256 ?? null, active: true,
        },
      },
    };
    const legacy = {
      schemaVersion: 1,
      censusedAt: '2026-01-01T00:00:00.000Z',
      entries: {
        hello: {
          ghostId: 'hello', relId: 'hello', capturedAt: '2026-01-01T00:00:00.000Z', status: 'pending',
        },
      },
    };
    const v1Text = JSON.stringify(v1, null, 2) + String.fromCharCode(10);
    const legacyText = JSON.stringify(legacy, null, 2) + String.fromCharCode(10);
    fs.writeFileSync(v1Path, v1Text);
    fs.writeFileSync(legacyPath, legacyText);
    const census = manager.ensureNamespaceMigrationCensus();
    expect(census?.entries.hello?.status).toBe('pending');
    expect(census?.entries.kept).toBeUndefined();
    expect(census?.censusedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(fs.readFileSync(v1Path, 'utf8')).toBe(v1Text);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyText);
    const v2 = JSON.parse(fs.readFileSync(pluginInstanceRegistryPath(state), 'utf8'));
    expect(v2.schemaVersion).toBe(2);
    expect(v2.census.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(v2.instances.hello.namespaceState).toBe('pending');
    expect(v2.instances.kept).toMatchObject({
      namespaceState: 'confirmed', namespace: 'acme', pluginId: 'plugin-kept',
    });
    await plantLegacyInstall('later');
    manager = createManager({ mutateSnapshot });
    expect(manager.list().find((ghost) => ghost.manifest.id === 'later')?.namespaceMigration).toBeUndefined();
    expect(manager.list().find((ghost) => ghost.manifest.id === 'hello')?.namespaceMigration).toBe('pending');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyText);
  });

  it('does not rebuild or overwrite a legacy ledger with an unknown schema', async () => {
    await plantLegacyInstall('hello');
    const legacyPath = path.join(workDir, 'ghosts-install-state', 'namespace-migration.v1.json');
    const future = '{"schemaVersion":2,"entries":{"keep":true}}' + String.fromCharCode(10);
    fs.writeFileSync(legacyPath, future);
    expect(manager.list()[0]).toMatchObject({ namespaceState: 'unconfirmed', namespace: null });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.ensureNamespaceMigrationCensus()).toBeNull();
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(future);
    await plantLegacyInstall('later');
    manager = createManager({ mutateSnapshot });
    expect(manager.ensureNamespaceMigrationCensus()).toBeNull();
    expect(manager.list().find((ghost) => ghost.manifest.id === 'later')?.namespaceMigration).toBeUndefined();
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(future);
  });

  it('finishes a receipt-first namespace commit as one registry write and one active instance', async () => {
    await plantLegacyInstall('hello');
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
    const state = path.join(workDir, 'ghosts-install-state');
    const receipts = receiptStore(mutateSnapshot);
    const approval = receipts.read('hello');
    if (approval.state !== 'approved') throw new Error('expected approved receipt');
    await receipts.write({ ...approval.receipt, namespace: 'xd' }, {
      relId: 'hello', skillSourceDir: path.join(rootDir, 'hello'), requireSkillSnapshot: false,
    });
    const before = JSON.parse(fs.readFileSync(pluginInstanceRegistryPath(state), 'utf8'));
    expect(before.census.pendingRelIds).toEqual(['hello']);
    expect(before.instances.hello).toBeUndefined();
    manager = createManager({ mutateSnapshot, getStateDir: () => state });
    await expect(manager.commitPendingNamespace('hello', null, 'market-public')).resolves.toEqual({ ok: true });
    const after = JSON.parse(fs.readFileSync(pluginInstanceRegistryPath(state), 'utf8')) as {
      instances: Record<string, { active: boolean; instanceKey: string; namespace: string | null; namespaceState: string }>;
    };
    const active = Object.values(after.instances).filter((record) => record.active);
    expect(active).toEqual([
      expect.objectContaining({ instanceKey: 'hello', namespace: 'xd', namespaceState: 'confirmed' }),
    ]);
    expect(manager.list().filter((ghost) => ghost.manifest.id === 'hello')).toHaveLength(1);
    expect(fs.existsSync(path.join(state, 'namespace-migration.v1.json'))).toBe(false);
  });
});

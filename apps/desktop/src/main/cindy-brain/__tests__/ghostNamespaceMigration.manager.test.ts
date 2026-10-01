import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { createOrganizationPrefixStore } from '../../plugin-market/organizationPrefixStore.js';
import { PluginMarketLedger } from '../../plugin-market/ledger.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
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

let workDir: string;
let rootDir: string;
let manager: GhostManager;

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

it.each(['_ns', '_root'])('rejects linked %s parents for content recovery and state journals', async (reservedRoot) => {
  const outside = path.join(workDir, 'outside');
  const contentNs = path.join(rootDir, reservedRoot);
  const relId = reservedRoot === '_ns' ? '_ns/acme/hello' : '_root/hello';
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  await fs.promises.mkdir(outside, { recursive: true });
  await fs.promises.mkdir(rootDir, { recursive: true });
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, contentNs, 'dir');
  expect(() => assertManagedPluginParentSync(rootDir, relId)).toThrow();

  const store = new GhostInstallReceiptStore(() => stateRoot);
  await fs.promises.mkdir(stateRoot, { recursive: true });
  await fs.promises.symlink(outside, path.join(stateRoot, reservedRoot), 'dir');
  await expect(store.writePendingMutation(relId, {
    kind: 'install', packageSha256: 'a'.repeat(64),
  })).rejects.toThrow();
  expect(store.readPendingMutationSync(relId).state).toBe('unreadable');
  if (reservedRoot === '_root') expect(store.listPendingMutationIdsSync().state).toBe('unreadable');
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
  const declared = {
    ...manifest(id),
    ...(withSkill ? {
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    } : {}),
  };
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(declared));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  if (withSkill) {
    await fs.promises.mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n');
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
      ...(installOrigin ? { installOrigin } : {}),
    }),
    { skillSourceDir: dir },
  );
}

async function makeCindy(id: string): Promise<string> {
  return writeTestCindyPackage(path.join(workDir, `${id}.cindy`), manifest(id));
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
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();
  });
  it('waits for approved origin and organization prefix before committing a Forge install', async () => {
    await plantLegacyInstall('acme-tool', false, 'agent-forge');
    const prefixStore = createOrganizationPrefixStore(path.join(workDir, 'organization.v1.json'));
    let receiptUnreadable = true;
    manager = createManager({
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => {
        const prefix = prefixStore.lookup('org-acme');
        return classifyNamespaceMigration({
          ghostId,
          builtin: false,
          installOrigin: readNamespaceMigrationInstallOrigin(() => {
            if (receiptUnreadable) throw new Error('receipt temporarily unreadable');
            return manager.readApprovedInstallOriginStrict(ghostId);
          }),
          marketSyncCompleted,
          marketRecord: null,
          currentOrganization: {
            organizationId: 'org-acme',
            orgSlug: 'acme',
            pluginPrefix: prefix.kind === 'known' ? prefix.pluginPrefix : null,
          },
        });
      },
    });

    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();

    receiptUnreadable = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();

    prefixStore.remember('org-acme', 'acme');
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('does not stamp an approval receipt when the market namespace stamp fails', async () => {
    await plantLegacyInstall('hello');
    manager = createManager({
      beforeNamespaceCommit: () => { throw new Error('market namespace conflict'); },
    });
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .rejects.toThrow('market namespace conflict');
    const store = receiptStore();
    const approval = store.read('hello');
    expect(approval.state).toBe('approved');
    if (approval.state === 'approved') expect(approval.receipt.namespace).toBeUndefined();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('runs an approved legacy resident offline, then stops it before stamping and restarts after commit', async () => {
    await plantLegacyInstall('hello');
    const events: string[] = [];
    let runtimeBusy = false;
    manager = createManager({
      classifyPendingNamespace: (_id, synced) => synced
        ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
        : { kind: 'pending', reason: 'awaiting-market-facts' },
      isNamespaceMigrationBusy: () => runtimeBusy,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: (ghost) => {
        expect(ghost.approval.state).toBe('approved');
        runtimeBusy = true;
        events.push('started');
      },
      preparePendingResidentForMigration: async () => {
        events.push('stopped');
        runtimeBusy = false;
        return true;
      },
      beforeNamespaceCommit: () => events.push('stamped'),
      onNamespaceCommitted: () => events.push('restarted'),
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(false);
    expect(events).toEqual(['started']);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    await manager.reconcilePendingRootNamespaces(true);
    expect(events).toEqual(['started', 'stopped', 'stamped', 'restarted']);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
  });

  it('keeps a running offline resident pending when safe stop is deferred', async () => {
    await plantLegacyInstall('hello');
    const stopped = vi.fn(async () => false);
    const deferred = vi.fn();
    manager = createManager({
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      isNamespaceMigrationBusy: () => true,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: vi.fn(),
      preparePendingResidentForMigration: stopped,
      onPendingResidentMigrationDeferred: deferred,
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(deferred).toHaveBeenCalledWith('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();
  });

  it('retries after in-flight work finishes, then stops, stamps, and restarts the offline resident', async () => {
    await plantLegacyInstall('hello');
    vi.useFakeTimers();
    try {
      let inFlight = true;
      let runtimeBusy = false;
      let retry: Promise<void> | undefined;
      const events: string[] = [];
      const stop = vi.fn(async () => {
        if (inFlight) return false;
        runtimeBusy = false;
        events.push('stopped');
        return true;
      });
      manager = createManager({
        classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
        isNamespaceMigrationBusy: () => inFlight || runtimeBusy,
        canResumePendingResidentOffline: () => true,
        onResumePendingResidentOffline: () => { runtimeBusy = true; events.push('started'); },
        preparePendingResidentForMigration: stop,
        onPendingResidentMigrationDeferred: () => {
          setTimeout(() => { retry = manager.reconcilePendingRootNamespaces(true); }, 1000);
        },
        beforeNamespaceCommit: () => events.push('stamped'),
        onNamespaceCommitted: () => events.push('restarted'),
      });
      manager.resumePendingResidentsOffline();
      await manager.reconcilePendingRootNamespaces(true);
      expect(events).toEqual(['started']);
      expect(manager.list()[0]?.namespaceMigration).toBe('pending');
      inFlight = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(retry).toBeDefined();
      await retry;
      expect(stop).toHaveBeenCalledTimes(2);
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
    await expect(manager.reconcilePendingRootNamespaces(true)).rejects.toThrow('market ledger unavailable');
    expect(deferred).toHaveBeenCalledWith('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    failStamp = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
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

  it('waits for a failed market read before committing an old organization install', async () => {
    await plantLegacyInstall('hello');
    let readFails = true;
    let commits = 0;
    manager = createManager({
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => classifyNamespaceMigration({
        ghostId,
        builtin: false,
        installOrigin: 'manual',
        marketSyncCompleted,
        marketRecord: readNamespaceMigrationMarketRecord(() => {
          if (readFails) throw new Error('locked ledger');
          return [{ scope: 'organization', source: 'market', organizationId: 'org-acme' }];
        }),
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      }),
      onNamespaceCommitted: () => { commits += 1; },
    });

    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();
    expect(commits).toBe(0);

    readFails = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(commits).toBe(1);
  });

  it('captures only verified recovered legacy installs after the initial empty census', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    expect(manager.list()).toEqual([]);
    await plantLegacyInstall('recovered');
    await plantLegacyInstall('unverified');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBe('pending');
    manager.captureRecoveredLegacyNamespace(['recovered']);
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBe('pending');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'unverified')?.namespaceMigration).toBe('pending');
    const orgCindy = await makeCindy('recovered');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
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
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });

    manager = createManager({
      mutateSnapshot,
      recoverUnstampedOrganizationNamespace: () => 'acme',
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
    });
    await manager.reconcilePendingRootNamespaces(false);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(manager.readDeliveryNamespace('hello')).toBe('acme');
  });

  it('does not claim a post-census downgrade install without verified market evidence', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    manager.list();
    await plantLegacyInstall('hello');
    manager = createManager({
      recoverUnstampedOrganizationNamespace: () => null,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: null, basis: 'manual-after-sync' }),
    });
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.readDeliveryNamespace('hello')).toBeUndefined();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
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

  it('finishes the captured downgrade recovery when receipt writing preceded ledger commit', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    manager.list();
    await plantLegacyInstall('hello');
    let failOnce = true;
    manager = createManager({
      mutateSnapshot,
      recoverUnstampedOrganizationNamespace: () => 'acme',
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      onNamespaceCommitted: () => {
        if (failOnce) throw new Error('ledger unavailable');
      },
    });
    await expect(manager.reconcilePendingRootNamespaces(true)).rejects.toThrow('ledger unavailable');
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme', namespaceMigration: 'pending' });
    failOnce = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
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

  it('lets a root reinstall proceed after uninstalling a pending legacy install', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await expect(manager.uninstall('hello', { notify: false })).resolves.toEqual({ ok: true });
    const cindy = await makeCindy('hello');
    await expect(manager.install(cindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' } },
    });
  });

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
    expect(marketLedger.installationsForGhost('hello')).toHaveLength(1);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
    busy = false;
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      ghost: { namespace: 'acme' },
    });
    expect(marketLedger.installationForPlugin({ ghostId: 'hello', namespace: null })).toMatchObject({ namespace: null });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    expect(manager.list().find((ghost) => ghost.dir === path.join(rootDir, 'hello'))).toMatchObject({ namespace: null });
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
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
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
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
      dir: path.join(rootDir, 'xd-feishu'),
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    const { installedGhostStoragePart } = await import('../../../shared/pluginIdentity.js');
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

  it('installs a same-name root without moving or stopping an approved legacy organization', async () => {
    await stampLegacyOrganizationInstall();
    const before = receiptStore(mutateSnapshot).read('hello');
    const busy = vi.fn(() => true);
    manager = createManager({ mutateSnapshot, isNamespaceMigrationBusy: busy });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      ghost: { namespace: null, dir: path.join(rootDir, '_root', 'hello') },
    });
    expect(busy).not.toHaveBeenCalled();
    expect(receiptStore(mutateSnapshot).read('hello')).toEqual(before);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
    expect(manager.list().map((ghost) => [ghost.namespace, ghost.dir])).toEqual(expect.arrayContaining([
      ['acme', path.join(rootDir, 'hello')], [null, path.join(rootDir, '_root', 'hello')],
    ]));
    const { installedGhostStoragePart } = await import('../../../shared/pluginIdentity.js');
    expect(manager.list().map(installedGhostStoragePart).sort()).toEqual(['_root__hello', 'hello']);
    manager = createManager({ mutateSnapshot });
    expect(manager.list()).toHaveLength(2);
    await expect(manager.setEnabled('_root/hello', false)).resolves.toEqual({ ok: true });
    expect(manager.list().find((ghost) => ghost.namespace === 'acme')?.enabled).toBe(true);
    await expect(manager.uninstall('_root/hello')).resolves.toEqual({ ok: true });
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
    expect(fs.existsSync(path.join(rootDir, '_root', 'hello'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('does not let an absent new root instance mutate a same-name legacy root', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', null, 'explicit-root');
    const before = receiptStore().read('hello');
    expect(await manager.setEnabled('_root/hello', false)).toMatchObject({ rejection: { code: 'not-installed' } });
    expect(await manager.uninstall('_root/hello')).toMatchObject({ rejection: { code: 'not-installed' } });
    expect(await manager.removeInstallApproval('_root/hello')).toBe(true);
    expect(receiptStore().read('hello')).toEqual(before);
    expect(manager.list()).toEqual([expect.objectContaining({ enabled: true, dir: path.join(rootDir, 'hello') })]);
  });

  it.each(['_root', '_ns/acme', '_ns/acme/org-helper'])('keeps other installs visible when %s is temporarily unreadable', async (unreadable) => {
    await manager.install(await makeCindy('hello'));
    await manager.install(await makeCindy('org-helper'), { namespace: 'acme' });
    const target = path.join(rootDir, ...unreadable.split('/'));
    const realLstat = fs.lstatSync;
    const locked = vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      if (String(filePath) === target) throw Object.assign(new Error('locked'), { code: 'EACCES' });
      return realLstat(filePath, options as never);
    });
    try {
      expect(manager.list().map((ghost) => ghost.manifest.id)).toEqual([unreadable === '_root' ? 'org-helper' : 'hello']);
    } finally {
      locked.mockRestore();
    }
  });

  it('keeps the legacy organization approved when a new root package cannot be installed', async () => {
    await stampLegacyOrganizationInstall('hello', true);
    const before = receiptStore(mutateSnapshot).read('hello');
    const file = await writeTestCindyPackage(path.join(workDir, 'root-with-skill.cindy'), {
      ...manifest('hello'), slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }, { 'main.js': '// ok\n', 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n' });
    manager = createManager({ mutateSnapshot: async () => { throw new Error('snapshot unavailable'); } });
    await expect(manager.install(file)).resolves.toMatchObject({ rejection: { code: 'io' } });
    expect(receiptStore(mutateSnapshot).read('hello')).toEqual(before);
    expect(manager.list()).toEqual([expect.objectContaining({ namespace: 'acme', approval: expect.objectContaining({ state: 'approved' }) })]);
  });

  it('installs and verifies a namespaced skill snapshot under its physical identity', async () => {
    const filePath = await writeTestCindyPackage(path.join(workDir, 'helper-skill.cindy'), {
      ...manifest('helper'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }, {
      'main.js': '// ok\n',
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n',
    });
    const result = await manager.install(filePath, { namespace: 'acme' });
    expect(result).toMatchObject({ ghost: { manifest: { id: 'helper' } } });
    if (!('ghost' in result)) return;
    expect(result.ghost.approvedSkillRoot).toContain(path.join('_ns', 'acme', 'helper'));
    await expect(manager.verifyApprovedSkillSnapshot(result.ghost)).resolves.toBe(true);
  });

  it('keeps a stamped skill approved beside a same-name new root install', async () => {
    await stampLegacyOrganizationInstall('hello', true);
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({ ghost: { manifest: { id: 'hello' } } });
    const org = manager.list().find((ghost) => ghost.namespace === 'acme');
    expect(org).toBeDefined();
    await expect(manager.verifyApprovedSkillSnapshot(org!)).resolves.toBe(true);
  });

  it('treats a later install of the same organization identity as already installed', async () => {
    await stampLegacyOrganizationInstall();
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

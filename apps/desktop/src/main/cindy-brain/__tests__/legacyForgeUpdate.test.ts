import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhostManager } from '../GhostManager.js';
import { createGhostInstallReceipt, GhostInstallReceiptStore } from '../ghostInstallReceipt.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { classifyGhostLocalUpdateSource } from '../ghostLocalUpdateSource.js';
import {
  assertGhostInstallConsent,
  confirmedTaskCapability,
  obtainGhostInstallConsent,
} from '../ghostInstallConsent.js';
import { GhostMutationCoordinator } from '../ghostMutationCoordinator.js';
import { withGhostInstallLock } from '../ghostInstallLock.js';
import {
  ghostInstallApprovalToken,
  isValidNewGhostId,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import {
  deliveryNamespaceFields,
  findInstalledGhostByInstanceId,
  findInstalledGhostForDeliveryTarget,
  findInstalledGhostForLocalUpdate,
  hasDeliveryNamespace,
  installedGhostStoragePart,
} from '../../../shared/pluginIdentity.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});
const id = 'mail-fixture';
const makeCallbacks = createGhostProductionCallbacks<{
  installOrUpdateLocalGhostPackageFromForge: (
    file: string,
    expected: Record<string, unknown>,
  ) => Promise<{ ghost: InstalledGhost; action: string }>;
}>({
  functions: [
    'findForgeInstallTarget',
    'installOrUpdateLocalGhostPackageFromForge',
    'readLocalGhostUpdateSource',
    'updateLocalGhostPackageLocked',
    'beginGhostMutation',
  ],
});

async function fixture(expandedPermissions = false, membershipKind = 'personal') {
  const root = fs.realpathSync(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-legacy-forge-update-')),
  );
  roots.push(root);
  let owner = { mode: 'authenticated', dataOwnerId: 'owner-fixture', generation: 1 };
  const content = path.join(root, 'content');
  const state = path.join(root, 'state');
  const archive = vi.fn(async () => {
    throw new Error('must not archive original state');
  });
  const manager = new GhostManager({
    getRootDir: () => content,
    getStateDir: () => state,
    onArchiveSourceState: archive,
  });
  const manifest = {
    schemaVersion: 2,
    id,
    name: 'Mail fixture',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    settingsHtml: 'settings.html',
    slots: ['tool', 'network'],
    tools: [{ name: 'read', description: 'Read fixture' }],
    network: {
      hosts: ['api.example.test'],
      secrets: [
        {
          key: 'mail',
          label: 'Mail',
          source: 'oauth',
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['api.example.test'],
          },
          oauth: {
            authorizeUrl: 'https://api.example.test/authorize',
            tokenUrl: 'https://api.example.test/token',
            scopes: ['mail.read'],
          },
        },
      ],
    },
  };
  const oldFile = await writeTestCindyPackage(path.join(root, 'old.cindy'), manifest, {
    'main.js': '// ok\n',
    'settings.html': '<p>Fixture settings</p>',
  });
  const old = await manager.inspect(oldFile);
  if ('rejection' in old) throw new Error(old.rejection.reason);
  const dir = path.join(content, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  await fs.promises.writeFile(path.join(dir, 'settings.html'), '<p>Fixture settings</p>');
  const store = new GhostInstallReceiptStore(() => state);
  let receipt = createGhostInstallReceipt({
    manifest: old.canonicalManifest,
    localeResources: {},
    enabled: true,
    trust: old.trust,
    packageSha256: old.packageSha256,
    skillContentSha256: {},
    installOrigin: 'agent-forge',
  });
  await store.write(receipt, { relId: id, skillSourceDir: dir });
  expect(manager.list()[0]?.namespaceState).toBe('pending');
  const retained = path.join(root, 'retained-state.json');
  const retainedBytes = JSON.stringify({
    accounts: [{ id: 'account-fixture', token: 'invalid-test-token' }],
    config: { selected: 'account-fixture' },
    data: ['fixture'],
  });
  await fs.promises.writeFile(retained, retainedBytes);
  const nextManifest = {
    ...manifest,
    version: '2.0.0',
    slots: expandedPermissions ? [...manifest.slots, 'fs'] : manifest.slots,
  };
  const nextFile = await writeTestCindyPackage(path.join(root, 'new.cindy'), nextManifest, {
    'main.js': '// ok\n',
    'settings.html': '<p>Fixture settings</p>',
  });
  const inspected = await manager.inspect(nextFile);
  if ('rejection' in inspected) throw new Error(inspected.rejection.reason);
  const prompt = vi.fn(async () => true);
  const runtime = { stop: vi.fn(), resetFuse: vi.fn() };
  const prepareAccounts = vi.fn(() => undefined);
  const ledger = {
    bind: () => ledger,
    installationForPlugin: vi.fn((): unknown => null),
    markRemovedRecord: vi.fn(),
    restoreInstallation: vi.fn(),
  };
  const rejectedBroker = vi.fn();
  let onStop = async () => {};
  const callbacks = makeCallbacks({
    getGhostManager: () => manager,
    getAuthState: () => ({
      isAuthenticated: true,
      user: { membershipKind, orgSlug: 'team-fixture' },
    }),
    forgeInstallOriginForMembership: () => 'agent-forge',
    forgeOidcInstallConfirmFacts: () => null,
    findInstalledGhostForDeliveryTarget,
    findInstalledGhostForLocalUpdate,
    findInstalledGhostByInstanceId,
    installedGhostStoragePart,
    ghostInstallApprovalToken,
    deliveryNamespaceFields,
    hasDeliveryNamespace,
    isValidNewGhostId,
    isValidPluginNamespace: () => true,
    classifyGhostLocalUpdateSource,
    getPluginMarketLedger: () => ledger,
    ownerScopedUserDataPath: () => path.join(root, 'ledger.json'),
    obtainGhostInstallConsent,
    assertGhostInstallConsent,
    confirmedTaskCapability,
    rejectReservedGhostId: vi.fn(),
    rejectBrokerWithoutDeclaredRedirectPort: vi.fn(),
    rejectUnauthorizedTokenBroker: rejectedBroker,
    withGhostInstallLock,
    withActiveOwnerGhostOauthMutationLock: async (_: string, run: () => unknown) => run(),
    getActiveAppSession: () => owner,
    isAppSessionBoundaryPending: () => false,
    ghostMutationCoordinator: new GhostMutationCoordinator(),
    throwIpcError: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
    throwInstallError: (rejection: { reason: string }) => {
      throw new Error(rejection.reason);
    },
    installAndDockLocked: async (_manager: GhostManager, file: string) => {
      const result = await manager.install(file, {
        initiallyEnabled: true,
        namespace: null,
        installOrigin: 'agent-forge',
      });
      if ('rejection' in result) throw new Error(result.rejection.reason);
      return result.ghost;
    },
    markGhostRecommendationInstalled: vi.fn(),
    getGhostRuntime: () => runtime,
    assertGhostRelocationIdle: vi.fn(),
    getGhostNodeRuntimeBroker: () => ({
      stopAndWait: async () => {
        await onStop();
      },
    }),
    getGhostAgentSlot: () => ({ clearGhost: vi.fn() }),
    getGhostErrandSlot: () => ({ clearGhost: vi.fn() }),
    getGhostOauthAccountManager: () => ({ prepareAccountsForChangedClients: prepareAccounts }),
    ghostSourceStateArchiveId: () => 'arch_' + 'a'.repeat(32),
    getLayoutStore: () => ({ getLayout: () => ({}), setLayout: vi.fn() }),
    layoutWithGhostPanel: () => null,
    spawnIfResident: vi.fn(),
    log: { warn: vi.fn() },
  });
  const expected = {
    ghostId: id,
    packageSha256: inspected.packageSha256,
    consentPrompt: prompt,
    mutationOwner: { ...owner },
    isCurrent: () => true,
  };
  return {
    root,
    dir,
    manager,
    store,
    archive,
    runtime,
    prepareAccounts,
    prompt,
    ledger,
    rejectedBroker,
    inspected,
    expected,
    nextFile,
    nextManifest,
    run: () => callbacks.installOrUpdateLocalGhostPackageFromForge(nextFile, expected),
    beforeStopped: (hook: () => Promise<void>) => {
      onStop = hook;
    },
    switchOwner: () => {
      owner = { ...owner, dataOwnerId: 'different-owner', generation: 2 };
    },
    rewriteReceipt: async (patch: Partial<typeof receipt>) => {
      receipt = { ...receipt, ...patch };
      await store.write(receipt, { relId: id, skillSourceDir: dir });
    },
    assertRetained: () => {
      expect(archive).not.toHaveBeenCalled();
      expect(fs.readFileSync(retained, 'utf8')).toBe(retainedBytes);
    },
  };
}

describe('pending legacy Forge same-instance update', () => {
  it('reproduces the old namespace-routed install failure without market facts', async () => {
    const f = await fixture();
    expect(f.manager.list()[0]?.namespaceState).toBe('pending');
    expect(
      findInstalledGhostForDeliveryTarget(f.manager.list(), { ghostId: id, namespace: null }),
    ).toBeUndefined();
    await expect(f.manager.install(f.nextFile, { namespace: null })).resolves.toMatchObject({
      rejection: { reason: 'namespace migration is pending' },
    });
    f.assertRetained();
  });

  it.each(['personal', 'org'])(
    'updates the original physical instance for %s without assigning namespace or archiving state',
    async (membershipKind) => {
      const f = await fixture(false, membershipKind);
      const old = f.manager.list()[0]!;
      const result = await f.run();
      expect(result).toMatchObject({
        action: 'updated',
        ghost: {
          dir: old.dir,
          instanceKey: id,
          namespaceState: 'pending',
          enabled: true,
          manifest: { version: '2.0.0' },
        },
      });
      expect(hasDeliveryNamespace(result.ghost)).toBe(false);
      const receipt = f.manager.readApprovedInstallReceipt(id)!;
      expect(receipt.installOrigin).toBe('agent-forge');
      expect(hasDeliveryNamespace(receipt)).toBe(false);
      expect(receipt.trust).toEqual(old.trust);
      expect(receipt.packageSha256).toBe(f.inspected.packageSha256);
      expect(f.prepareAccounts).toHaveBeenCalledWith(
        expect.objectContaining({ network: receipt.manifest.network }),
        expect.objectContaining({ network: receipt.manifest.network }),
        id,
      );
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.rejectedBroker).toHaveBeenCalled();
      expect(f.ledger.markRemovedRecord).not.toHaveBeenCalled();
      f.assertRetained();
    },
  );

  it.each([
    'manual',
    'missing-hash',
    'invalid-receipt',
    'manifest-drift',
    'market',
    'removed-market',
    'publisher-downgrade',
  ])('rejects %s without replacing or archiving', async (kind) => {
    const f = await fixture();
    if (kind === 'manual') await f.rewriteReceipt({ installOrigin: 'manual' });
    if (kind === 'missing-hash') await f.rewriteReceipt({ packageSha256: undefined });
    if (kind === 'invalid-receipt')
      await fs.promises.writeFile(path.join(f.root, 'state', id + '.json'), '{}');
    if (kind === 'removed-market')
      f.ledger.installationForPlugin.mockReturnValue({ installed: false });
    if (kind === 'manifest-drift')
      await fs.promises.writeFile(path.join(f.dir, 'ghost.json'), '{}');
    if (kind === 'market') f.ledger.installationForPlugin.mockReturnValue({ installed: true });
    if (kind === 'publisher-downgrade')
      await f.rewriteReceipt({
        trust: {
          level: 'cindy-official',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: true,
        },
      });
    await expect(f.run()).rejects.toThrow();
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(f.manager.list()[0]?.manifest.version).toBe('1.0.0');
    f.assertRetained();
  });

  it.each(['owner', 'revision', 'hash', 'cancel', 'capability'])(
    'rejects %s changes while awaiting confirmation',
    async (change) => {
      const f = await fixture(true);
      f.prompt.mockImplementationOnce(async () => {
        if (change === 'owner') f.switchOwner();
        if (change === 'revision')
          await f.rewriteReceipt({ revision: '22222222-2222-4222-8222-222222222222' });
        if (change === 'hash') await f.rewriteReceipt({ packageSha256: 'b'.repeat(64) });
        if (change === 'capability') f.expected.isCurrent = () => false;
        return change !== 'cancel';
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.runtime.stop).not.toHaveBeenCalled();
      f.assertRetained();
    },
  );

  it('rejects a same-id namespace conflict', async () => {
    const f = await fixture();
    const other = path.join(f.root, 'content', '_ns', 'other', id);
    await fs.promises.mkdir(other, { recursive: true });
    await fs.promises.copyFile(path.join(f.dir, 'ghost.json'), path.join(other, 'ghost.json'));
    await expect(f.run()).rejects.toThrow();
    expect(f.runtime.stop).not.toHaveBeenCalled();
    f.assertRetained();
  });

  it('rejects a pending legacy instance alongside a confirmed matching root instance', async () => {
    const f = await fixture();
    const relId = `_ns/_root/${id}`;
    const other = path.join(f.root, 'content', relId);
    await fs.promises.cp(f.dir, other, { recursive: true });
    const receipt = f.manager.readApprovedInstallReceipt(id)!;
    await f.store.write(
      { ...receipt, namespace: null, revision: '33333333-3333-4333-8333-333333333333' },
      { relId, skillSourceDir: other },
    );
    expect(
      findInstalledGhostForDeliveryTarget(f.manager.list(), { ghostId: id, namespace: null }),
    ).toBeDefined();
    await expect(f.run()).rejects.toThrow('同 ID 实例冲突');
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(f.manager.list().map((ghost) => ghost.manifest.version)).toEqual(['1.0.0', '1.0.0']);
    f.assertRetained();
  });

  it('never selects a confirmed instance belonging to another namespace as the legacy receiver', async () => {
    const f = await fixture();
    await f.manager.commitPendingNamespace(id, 'other-team', 'market-organization');
    const result = await f.run();
    expect(result.action).toBe('installed');
    expect(result.ghost.dir).not.toBe(f.dir);
    expect(f.store.read(id)).toMatchObject({
      state: 'approved',
      receipt: { namespace: 'other-team', manifest: { version: '1.0.0' } },
    });
    f.assertRetained();
  });

  it('preserves disabled state without changing accounts or configuration', async () => {
    const f = await fixture();
    await f.rewriteReceipt({ enabled: false });
    await expect(f.run()).resolves.toMatchObject({ action: 'updated', ghost: { enabled: false } });
    f.assertRetained();
  });

  it('uses the existing permission prompt before committing an added capability', async () => {
    const f = await fixture(true);
    await expect(f.run()).resolves.toMatchObject({ action: 'updated' });
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(f.manager.readApprovedInstallReceipt(id)?.manifest.fs).toBe(true);
    f.assertRetained();
  });

  it('rejects an old archive hash changed during runtime shutdown inside the manager transaction', async () => {
    const f = await fixture();
    f.beforeStopped(async () => {
      await f.rewriteReceipt({ packageSha256: 'c'.repeat(64) });
    });
    await expect(f.run()).rejects.toThrow('旧 Forge 插件实例或来源已变化');
    expect(f.manager.list()[0]?.manifest.version).toBe('1.0.0');
    f.assertRetained();
  });

  it('does not grant an added capability when the user cancels the existing permission prompt', async () => {
    const f = await fixture(true);
    f.prompt.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow();
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(f.manager.readApprovedInstallReceipt(id)?.manifest.fs).toBeUndefined();
    expect(f.runtime.stop).not.toHaveBeenCalled();
    f.assertRetained();
  });

  it('rejects package bytes replaced after confirmation without committing the changed package', async () => {
    const f = await fixture(true);
    f.prompt.mockImplementationOnce(async () => {
      await writeTestCindyPackage(
        f.nextFile,
        { ...f.nextManifest, version: '3.0.0' },
        {
          'main.js': '// replaced after approval\n',
          'settings.html': '<p>Fixture settings</p>',
        },
      );
      return true;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.manager.list()[0]?.manifest.version).toBe('1.0.0');
    f.assertRetained();
  });

  it('serializes concurrent updates and rejects the stale approval instead of selecting a new receiver', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.run(), f.run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    f.assertRetained();
  });

  it('rolls back a failure before receipt commit and can retry through the normal transaction', async () => {
    const f = await fixture();
    f.prepareAccounts.mockImplementationOnce(() => {
      throw new Error('fixture commit interrupted');
    });
    await expect(f.run()).rejects.toThrow('fixture commit interrupted');
    expect(f.manager.list()[0]?.manifest.version).toBe('1.0.0');
    expect(f.store.readPendingMutationSync(id).state).toBe('missing');
    f.assertRetained();
    await expect(f.run()).resolves.toMatchObject({ action: 'updated' });
    f.assertRetained();
  });
});

import { pluginHasToolUi, pluginToolVisible } from '@cindy/plugin-protocol';
import { ghostPermissionItems, hasGhostUiPermission } from '../../../shared/ghost.js';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';
import { findInstalledGhostForDeliveryTarget, installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { assertGhostInstallConsent, confirmedControlPoints, confirmedUiCapability, confirmedTaskCapability, obtainGhostInstallConsent } from '../ghostInstallConsent.js';
import { ghostInstallApprovalToken } from '../../../shared/ghost.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
import { effectiveInstallOrigin } from '../ghostInstallReceipt.js';
import { classifyGhostLocalUpdateSource } from '../ghostLocalUpdateSource.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { RemotePluginManagement } from '../remotePluginManagement.js';
import { PluginTaskApprovalGate } from '../taskCapability.js';
import type { GhostInstallConsentPrompt } from '../ghostInstallConsent.js';
import type { PluginManagementReceipt } from '../../../shared/pluginManagement.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';

const createCallbacks = createGhostProductionCallbacks<{
  install: (event: unknown, file: string, options: unknown) => Promise<{ ghost: InstalledGhost }>;
}>({
  functions: ['installAndDock', 'installAndDockLocked'],
  callbacks: { install: ['ipcMain.handle', 'ghosts:install'] },
});

describe('local root installation consent identity', () => {
  it.each([true, false])('confirms an independent root beside an approved organization (allow=%s)', async (allow) => {
    const manifest: InstalledGhost['manifest'] = {
      schemaVersion: 3, minCindyVersion: '0.0.0', id: 'helper', name: 'Helper',
      version: '1.0.0', kind: 'chip', entry: 'main.js',
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio', lifecycle: 'resident' },
    };
    const organization: InstalledGhost = {
      manifest, namespace: 'acme', dir: '/plugins/_ns/acme/helper', enabled: true,
      approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' },
    };
    const root: InstalledGhost = { ...organization, namespace: null, dir: '/plugins/_ns/_root/helper' };
    const packageSha256 = 'a'.repeat(64);
    const prompt = vi.fn<(request: Omit<GhostInstallConsentRequest, 'requestId'>) => Promise<boolean>>(async () => allow);
    const release = vi.fn();
    const manager = {
      list: () => [organization],
      inspect: vi.fn(async () => ({ manifest, packageSha256, trust: { level: 'unverified' } })),
      install: vi.fn(async () => ({ ghost: root })),
    };
    const callbacks = createCallbacks({
      manager, assertTrustedAppRendererEvent: vi.fn(), captureGhostMutationOwner: () => 'owner',
      beginGhostMutation: () => release, rejectReservedGhostId: vi.fn(),
      rejectBrokerWithoutDeclaredRedirectPort: vi.fn(), rejectUnauthorizedTokenBroker: vi.fn(),
      throwIpcError: (code: string) => { throw new Error(code); },
      throwInstallError: () => { throw new Error('install rejected'); },
      obtainGhostInstallConsent, assertGhostInstallConsent, confirmedUiCapability, confirmedTaskCapability, confirmedControlPoints,
      createWindowGhostInstallConsentPrompt: () => prompt,
      findInstalledGhostForDeliveryTarget, installedGhostStoragePart,
      withGhostInstallLock: async (_id: string, operation: () => unknown) => operation(),
      getLayoutStore: () => ({ getLayout: () => ({}) }), layoutWithGhostPanel: () => null,
      spawnIfResident: vi.fn(), bindPluginUsage: vi.fn(async () => {}),
      markGhostRecommendationInstalled: vi.fn(), log: { warn: vi.fn() },
    });
    const installing = callbacks.install({ sender: {} }, '/tmp/helper.cindy', { enable: true, expectedPackageSha256: packageSha256 });
    if (allow) {
      await expect(installing).resolves.toMatchObject({ ghost: root });
      expect(manager.install).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } else {
      await expect(installing).rejects.toThrow();
      expect(manager.install).not.toHaveBeenCalled();
    }
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ facts: { kind: 'install' } });
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ target: { namespace: null, sourceChanged: false, otherCopies: 1 } });
  });
});

const forgeCallbacks = createGhostProductionCallbacks<{
  installOrUpdateLocalGhostPackageFromForge: (file: string, options: Record<string, unknown>) => Promise<{ action: string; ghost: InstalledGhost }>;
}>({ functions: ['installOrUpdateLocalGhostPackageFromForge'] });

// Production entry regression: current-org authoring must not silently create
// a duplicate, cross the selected namespace, or proceed after consent expires.
it.each(['choose', 'update', 'copy', 'cancel', 'changed'] as const)('Forge installation target: %s', async mode => {
  const manifest: InstalledGhost['manifest'] = { schemaVersion: 3, minCindyVersion: '0.0.0', id: 'helper', name: 'Helper', version: '1.0.0', kind: 'chip', entry: 'main.js' };
  const root: InstalledGhost = { manifest, namespace: null, instanceKey: '_root__helper', dir: '/plugins/_root/helper', enabled: true,
    approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' } };
  const digest = 'a'.repeat(64), install = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => ({ ...root, namespace: 'acme' })), update = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => root);
  const prompt = vi.fn<(request: Omit<GhostInstallConsentRequest, 'requestId'>) => Promise<boolean>>(async () => {
    if (mode === 'changed') root.approval = { state: 'approved', revision: '22222222-2222-4222-8222-222222222222' };
    return mode !== 'cancel';
  });
  const entry = forgeCallbacks({
    getGhostManager: () => ({ list: () => [root], inspect: async () => ({ manifest, canonicalManifest: manifest, packageSha256: digest, trust: { level: 'unverified' } }) }),
    rejectReservedGhostId() {}, rejectBrokerWithoutDeclaredRedirectPort() {}, rejectUnauthorizedTokenBroker() {},
    getAuthState: () => ({ isAuthenticated: true, user: { membershipKind: 'org', orgSlug: 'acme' } }),
    forgeInstallOriginForMembership: () => 'agent-forge', isValidPluginNamespace: () => true, isValidNewGhostId: () => true,
    readLocalGhostUpdateSource: () => ({ sourceChanged: true, authorizationOverrides: {} }),
    ghostInstallApprovalToken, obtainGhostInstallConsent, findInstalledGhostForDeliveryTarget,
    forgeOidcInstallConfirmFacts: () => null, beginGhostMutation: () => () => {},
    withGhostInstallLock: async (_id: string, fn: () => unknown) => fn(), installAndDockLocked: install,
    updateLocalGhostPackageLocked: update, markGhostRecommendationInstalled() {},
    throwIpcError: (code: string) => { throw new Error(code); }, log: { warn() {} },
  }).installOrUpdateLocalGhostPackageFromForge;
  const pending = entry('/tmp/helper.cindy', { ghostId: 'helper', packageSha256: digest, mutationOwner: {}, consentPrompt: prompt,
    ...(mode === 'copy' ? { installCopy: true, namespace: 'acme' } : mode === 'choose' ? {} : { targetInstanceId: root.instanceKey }) });
  if (['cancel', 'changed'].includes(mode)) {
    await expect(pending).rejects.toThrow();
    expect(install).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  } else if (mode === 'copy') {
    expect((await pending).action).toBe('installed');
    expect(install.mock.calls[0]?.[2]).toMatchObject({ namespace: 'acme', enable: true });
    expect(update).not.toHaveBeenCalled();
  } else {
    expect((await pending).action).toBe('updated');
    expect(update.mock.calls[0]?.[5]).toBe('_root__helper');
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ target: { namespace: null, sourceChanged: true } });
    expect(install).not.toHaveBeenCalled();
  }
});

// Test value: the shared-package entry must bind real bytes and reuse manual
// root install/update consent. Existing file/Forge entries do not accept a fixed
// shared version. Unit tier; production callback, no filesystem or network I/O.
const sharedPackageCallbacks = createGhostProductionCallbacks<{
  installLocalPluginSharePackage: (file: string, options: Record<string, unknown>) => Promise<InstalledGhost>;
}>({ functions: ['installLocalPluginSharePackage'] });

// Same-ID unsigned shares previously skipped consent when permissions were unchanged.
// Exercise the production entry and source classifier, including a declined replacement.
it.each(['new', 'update', 'cancel', 'cancel-update', 'different-bytes', 'owner-changed'] as const)('shared local package consent: %s', async mode => {
  const manifest: InstalledGhost['manifest'] = { schemaVersion: 3, minCindyVersion: '99.0.0', id: 'helper', name: 'Helper', version: '1.0.0', kind: 'chip', entry: 'main.js' };
  const root: InstalledGhost = { manifest, namespace: null, instanceKey: '_root__helper', dir: '/plugins/_root/helper', enabled: true,
    approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' } };
  const digest = 'a'.repeat(64);
  let current = true;
  const replacing = mode === 'update' || mode === 'cancel-update';
  const trust = { level: 'unverified' as const, publisherSigned: false, publisherVerified: false, reviewed: false };
  const prompt = vi.fn<(request: Omit<GhostInstallConsentRequest, 'requestId'>) => Promise<boolean>>(async () => !mode.startsWith('cancel'));
  const install = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => root),
    update = vi.fn<(...args: unknown[]) => Promise<InstalledGhost>>(async () => root), release = vi.fn();
  const entry = sharedPackageCallbacks({
    getGhostManager: () => ({ list: () => replacing ? [root] : [],
      inspect: async () => { if (mode === 'owner-changed') current = false;
        return { manifest, canonicalManifest: manifest, packageSha256: mode === 'different-bytes' ? 'b'.repeat(64) : digest }; } }),
    captureGhostMutationOwner: () => 'owner', beginGhostMutation: () => release,
    rejectReservedGhostId() {}, rejectBrokerWithoutDeclaredRedirectPort() {}, rejectUnauthorizedTokenBroker() {},
    throwInstallError: () => { throw new Error('invalid package'); },
    throwIpcError: (code: string) => { throw new Error(code); },
    findInstalledGhostForDeliveryTarget, ghostInstallApprovalToken, installedGhostStoragePart,
    readLocalGhostUpdateSource: () => ({ ...classifyGhostLocalUpdateSource({
      existingSourceChanged: false,
      previousApprovedReceipt: { id: manifest.id, namespace: null, packageSha256: 'b'.repeat(64), trust },
      inspectedPackage: { ghostId: manifest.id, namespace: null, packageSha256: digest, trust },
    }), authorizationOverrides: {} }),
    obtainGhostInstallConsent, withGhostInstallLock: async (_id: string, run: () => unknown) => run(),
    installAndDock: install, updateLocalGhostPackageLocked: update,
  }).installLocalPluginSharePackage;
  const result = entry('/tmp/shared.cindy', { ghostId: 'helper', version: '1.0.0', sha256: digest, prompt,
    assertCurrent() { if (!current) throw new Error('OWNER_CHANGED'); } });
  if (mode.startsWith('cancel') || mode === 'different-bytes' || mode === 'owner-changed') {
    await expect(result).rejects.toThrow();
    expect(install).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    if (mode === 'owner-changed') expect(prompt).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toBe(root);
    expect(release).toHaveBeenCalledOnce();
    if (mode === 'update') {
      expect(install).not.toHaveBeenCalled();
      expect(update.mock.calls[0]?.[5]).toBe('_root__helper');
      expect(update.mock.calls[0]?.[6]).toMatchObject({ mode: 'confirmed', forced: true });
      expect(update.mock.calls[0]?.[9]).toBe(false);
    } else {
      expect(install.mock.calls[0]?.[2]).toMatchObject({ namespace: null, enable: true, registrySource: 'manual', expectedPackageSha256: digest });
    }
  }
  if (replacing) {
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ purpose: 'share-replace',
      facts: { kind: 'update', added: [] }, target: { namespace: null, sourceChanged: false } });
  }
});

// Same production entry with real archive inspection, placement and receipt.
// This distinguishes a returned UI object from an actually committed manual install.
it.each([false, true])('commits a shared archive with its exact digest (missing historical page=%s)', async (missingPage) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-share-install-')));
  try {
    const file = await writeTestCindyPackage(path.join(directory, 'shared.cindy'), {
      schemaVersion: 3, minCindyVersion: '99.0.0', id: 'shared-example', name: 'Shared Example', version: '1.0.0', entry: 'main.js',
      tools: [{ name: 'run', description: 'Run' }],
      ...(missingPage ? { mcpApps: { ui: { resources: [{ uri: 'ui://page', file: 'missing.html' }], tools: { run: { resourceUri: 'ui://page' } } } } } : {}),
    });
    const sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const manager = new GhostManager({ getRootDir: () => path.join(directory, 'plugins'),
      mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir) });
    const factory = createGhostProductionCallbacks<{
      installLocalPluginSharePackage: (file: string, options: Record<string, unknown>) => Promise<InstalledGhost>;
    }>({ functions: ['installLocalPluginSharePackage', 'installAndDock', 'installAndDockLocked'] });
    const install = factory({ confirmedUiCapability, getGhostManager: () => manager, captureGhostMutationOwner: () => 'owner', beginGhostMutation: () => () => {},
      findInstalledGhostForDeliveryTarget, obtainGhostInstallConsent, assertGhostInstallConsent, confirmedTaskCapability, confirmedControlPoints,
      withGhostInstallLock: async (_id: string, run: () => unknown) => run(),
      rejectReservedGhostId() {}, rejectBrokerWithoutDeclaredRedirectPort() {}, rejectUnauthorizedTokenBroker() {},
      throwInstallError: (value: { reason: string }) => { throw new Error(value.reason); },
      throwIpcError: (code: string) => { throw new Error(code); },
      recordGhostAdded() {}, installedGhostStoragePart, spawnIfResident() {}, bindPluginUsage: async () => {}, log: { warn() {} },
    }).installLocalPluginSharePackage;
    const installed = await install(file, { ghostId: 'shared-example', version: '1.0.0', sha256, prompt: async () => true, assertCurrent() {} });
    expect(installed.approval.state).toBe('approved');
    expect(installed.enabled).toBe(true);
    const receipt = manager.readApprovedInstallReceipt(installedGhostStoragePart(installed));
    expect(receipt?.packageSha256).toBe(sha256);
    expect(effectiveInstallOrigin(receipt!)).toBe('manual');
    expect(pluginHasToolUi(installed.manifest)).toBe(false);
    expect(pluginToolVisible(installed.manifest, 'run', 'model')).toBe(true);
    expect(await fs.readFile(path.join(installed.dir, 'main.js'), 'utf8')).toBe('// ok\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Unit: real archive placement, approved receipt, and startup reread protect the
// compatibility redline. Existing local-install cases only cover valid declarations.
it.each([null, 'legacy', { ui: { resources: [{ uri: 'ui://run', file: '../page.html' }], tools: { run: {} } } }])(
  'keeps a historical market package usable after restart but rejects local installation: %j', async mcpApps => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-historical-ui-')));
    try {
      const raw = { schemaVersion: 3, minCindyVersion: '0.1.0', id: 'legacy-ui', name: 'Legacy', version: '1.0.0',
        entry: 'main.js', tools: [{ name: 'run', description: 'Original tool' }], mcpApps };
      const file = await writeTestCindyPackage(path.join(directory, 'legacy.cindy'), raw);
      const options: GhostManagerOptions = { getRootDir: () => path.join(directory, 'plugins'),
        mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir) };
      const manager = new GhostManager(options);
      const inspected = await manager.inspect(file, 'stored-release');
      expect(inspected).not.toHaveProperty('rejection');
      // Parsing caches must not carry historical tolerance into local new installs.
      expect(await manager.inspect(file)).toHaveProperty('rejection.code', 'file-invalid');
      expect(await manager.install(file)).toHaveProperty('rejection.code', 'file-invalid');
      const result = await manager.install(file, { manifestSource: 'stored-release', registrySource: 'market', namespace: null });
      if ('rejection' in result) throw new Error(result.rejection.reason);
      const reloaded = new GhostManager(options).list().find(g => g.manifest.id === raw.id)!;
      expect(reloaded).toMatchObject({ enabled: true, approval: { state: 'approved' }, manifest: { mcpApps, tools: raw.tools } });
      expect(manager.readApprovedInstallReceipt(installedGhostStoragePart(reloaded))?.manifest.mcpApps).toEqual(mcpApps);
      expect(pluginHasToolUi(reloaded.manifest)).toBe(false);
      expect(hasGhostUiPermission({ ...reloaded, uiCapabilityApproved: true })).toBe(false);
      expect(pluginToolVisible(reloaded.manifest, 'run', 'model')).toBe(true);
      expect(pluginToolVisible(reloaded.manifest, 'run', 'app')).toBe(false);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  },
);

const shareUiCallbacks = createGhostProductionCallbacks<{
  installLocalPluginSharePackage: (file: string, options: Record<string, unknown>) => Promise<InstalledGhost>;
  requestPluginUiApproval: (id: string, sender: undefined, explicit: boolean,
    remote: { prompt: GhostInstallConsentPrompt; assertCurrent(): void }) => Promise<{ granted: boolean }>;
}>({ functions: ['installLocalPluginSharePackage', 'installAndDock', 'installAndDockLocked', 'requestPluginUiApproval'] });

// F01, unit with isolated archive I/O: RemotePluginManagement -> share installer/consent -> real
// archive/receipt, then the separate UI approval entry. Existing share tests stubbed
// the installer or used a package without pages, hiding lost prompt metadata.
// Minimum: one page-capable package shared to an empty viewer; no uiConsentVersion.
it('keeps remote share installation separate from later page capability approval', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-share-ui-')));
  let active = true;
  let service: RemotePluginManagement | undefined;
  try {
    const file = await writeTestCindyPackage(path.join(directory, 'shared.cindy'), {
      schemaVersion: 3, minCindyVersion: '99.0.0', id: 'shared-example', name: 'Shared Example', version: '1.0.0', entry: 'main.js',
      tools: [{ name: 'run', description: 'Run' }],
      mcpApps: { ui: { resources: [{ uri: 'ui://page', file: 'page.html' }], tools: { run: { resourceUri: 'ui://page' } } } },
    }, { 'main.js': '// ok\n', 'page.html': '<!doctype html><p>Example</p>' });
    const sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const manager = new GhostManager({ getRootDir: () => path.join(directory, 'plugins'),
      mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir) });
    const callbacks = shareUiCallbacks({ confirmedUiCapability, getGhostManager: () => manager,
      captureGhostMutationOwner: () => 'owner', beginGhostMutation: () => () => {},
      findInstalledGhostForDeliveryTarget, obtainGhostInstallConsent, assertGhostInstallConsent, confirmedTaskCapability, confirmedControlPoints,
      withGhostInstallLock: async (_id: string, run: () => unknown) => run(),
      rejectReservedGhostId() {}, rejectBrokerWithoutDeclaredRedirectPort() {}, rejectUnauthorizedTokenBroker() {},
      throwInstallError: (value: { reason: string }) => { throw new Error(value.reason); },
      recordGhostAdded() {}, installedGhostStoragePart, spawnIfResident() {}, bindPluginUsage: async () => {}, log: { warn() {} },
      findGhostForInstanceId: (id: string) => manager.findInstalledInstance(id), pluginHasToolUi, ghostPermissionItems,
      getDeepLinkMainWindow: () => null, getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'viewer', ownerGeneration: 1 }),
      isGhostBoundaryPending: () => false, taskApprovalGate: new PluginTaskApprovalGate(), broadcastGhostsChanged() {},
    });
    service = new RemotePluginManagement({ list: () => manager.list(), capture: () => () => active, captureReceipt: () => () => active,
      market: { snapshot: async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }),
        detail: async () => { throw new Error('unused'); }, install: async () => { throw new Error('unused'); } },
      setEnabled: async () => { throw new Error('unused'); }, uninstall: async () => { throw new Error('unused'); },
      installShare: async (snapshot, prompt, assertCurrent) => {
        await callbacks.installLocalPluginSharePackage(file, { ...snapshot, prompt, assertCurrent });
      },
      ui: { suppressed: () => false, defer() {}, approve: async (id, prompt, assertCurrent) =>
        (await callbacks.requestPluginUiApproval(id, undefined, true, { prompt, assertCurrent })).granted },
    });
    const invoke = async (action: string, input: Record<string, unknown>, id?: string) => (await service!.invoke('source-desktop', {
      collectionId: 'plugins', actionId: 'management:' + action, input, client: { protocolVersion: 1, primitives: ['action'] },
      ...(id ? { resourceRef: { collectionId: 'plugins', kind: 'plugin', id } } : {}),
    })).result as PluginManagementReceipt;
    const answer = async (operationId: string, purpose?: string) => {
      let receipt: PluginManagementReceipt;
      await vi.waitFor(async () => { receipt = await invoke('operation', { operationId }); expect(receipt.phase).toBe('confirmation'); }, { interval: 10 });
      if (purpose) expect(receipt!.consent?.purpose).toBe(purpose);
      await invoke('answer', { operationId, requestId: receipt!.consent!.requestId, confirmed: true });
      await vi.waitFor(async () => expect((await invoke('operation', { operationId })).phase).toBe('succeeded'), { interval: 10 });
    };
    expect(manager.list()).toEqual([]);
    await invoke('begin', { operationId: 'share', kind: 'install-share', expectedSnapshot: {
      schemaVersion: 1, snapshotId: 'a'.repeat(32), ghostId: 'shared-example', name: 'Shared Example', version: '1.0.0',
      sha256, sizeBytes: (await fs.stat(file)).size, description: null, author: null, icon: null, createdAt: '2026-10-28T00:00:00.000Z',
    } });
    await answer('share');
    const installed = manager.list()[0], id = installedGhostStoragePart(installed);
    expect(installed.approval.state).toBe('approved');
    expect(installed.uiCapabilityApproved ?? false).toBe(false);
    expect(hasGhostUiPermission(installed)).toBe(false);
    expect(manager.readApprovedInstallReceipt(id)?.uiCapabilityApproved ?? false).toBe(false);
    await invoke('begin', { operationId: 'pages', kind: 'approve-ui', uiConsentVersion: 1,
      expectedInstalledApproval: ghostInstallApprovalToken(installed.approval) }, id);
    await answer('pages', 'ui-capability');
    expect(manager.readApprovedInstallReceipt(id)?.uiCapabilityApproved).toBe(true);
    expect(hasGhostUiPermission(manager.list()[0])).toBe(true);
  } finally {
    active = false; service?.invalidate();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// #7924 / 4420763926 compatibility: real stored-release install/update and startup
// scan must keep ordinary tools enabled when a syntactically valid UI loses HTML.
// Existing legacy tests cover malformed declarations only. Unit: absent package page.
it.each(['missing', 'directory', 'symlink', 'oversized'] as const)('installs and updates historical releases with %s pages without granting UI', async (kind) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-missing-ui-')));
  try {
    const raw = { schemaVersion: 3, minCindyVersion: '0.1.122-beta', id: 'historical-ui', name: 'Historical', version: '1.0.0',
      entry: 'main.js', tools: [{ name: 'run', description: 'Original tool' }],
      mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'missing.html' }], tools: { run: { resourceUri: 'ui://run' } } } } };
    const options: GhostManagerOptions = { getRootDir: () => path.join(directory, 'plugins'),
      mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir) };
    const manager = new GhostManager(options);
    const historicalPackage = async (filename: string, version: string) => {
      const file = await writeTestCindyPackage(path.join(directory, filename), { ...raw, version });
      if (kind !== 'missing') {
        const zip = await JSZip.loadAsync(await fs.readFile(file));
        if (kind === 'directory') zip.folder('missing.html');
        else if (kind === 'symlink') zip.file('missing.html', 'other.html', { unixPermissions: 0o120777 });
        else zip.file('missing.html', 'x'.repeat(4 * 1024 * 1024 + 1));
        await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
      }
      return file;
    };
    const file = await historicalPackage('historical.cindy', '1.0.0');
    const inspected = await manager.inspect(file, 'stored-release');
    expect(inspected).not.toHaveProperty('rejection');
    if ('rejection' in inspected) throw new Error(inspected.rejection.reason);
    expect(pluginHasToolUi(inspected.manifest)).toBe(false);
    expect(inspected.canonicalManifest.mcpApps).toEqual(raw.mcpApps);
    expect(await manager.inspect(file)).toHaveProperty('rejection.code', 'file-invalid');
    const result = await manager.install(file, { manifestSource: 'stored-release', registrySource: 'market', uiCapabilityApproved: true });
    if ('rejection' in result) throw new Error(result.rejection.reason);
    const token = ghostInstallApprovalToken(result.ghost.approval);
    const next = await historicalPackage('update.cindy', '2.0.0');
    expect(await manager.update(next, { expectedInstalledApproval: token, uiCapabilityApproved: true })).toHaveProperty('rejection.code', 'file-invalid');
    const updated = await manager.update(next, { manifestSource: 'stored-release', expectedInstalledApproval: token, uiCapabilityApproved: true });
    expect(updated).toHaveProperty('ghost');
    const restarted = new GhostManager(options);
    const ghost = restarted.list()[0]!;
    expect(ghost).toMatchObject({ enabled: true, approval: { state: 'approved' }, manifest: { version: '2.0.0', tools: raw.tools } });
    expect(pluginHasToolUi(ghost.manifest)).toBe(false);
    expect(hasGhostUiPermission(ghost)).toBe(false);
    expect(pluginToolVisible(ghost.manifest, 'run', 'model')).toBe(true);
    const id = installedGhostStoragePart(ghost);
    expect(restarted.readApprovedInstallReceipt(id)?.manifest.mcpApps).toEqual(raw.mcpApps);
    if (ghost.approval.state !== 'approved') throw new Error('expected approved install');
    expect(await restarted.approveUiCapability(id, ghost.approval.revision, () => true)).toBe(false);
    expect(await fs.readFile(path.join(ghost.dir, 'main.js'), 'utf8')).toBe('// ok\n');
    if (kind === 'missing') {
      const repaired = await writeTestCindyPackage(path.join(directory, 'fixed.cindy'), { ...raw, version: '3.0.0' },
        { 'main.js': '// ok\n', 'missing.html': '<p>Now available</p>' });
      const fixed = await restarted.update(repaired, { manifestSource: 'stored-release', expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval) });
      if ('rejection' in fixed) throw new Error(fixed.rejection.reason);
      expect(pluginHasToolUi(fixed.ghost.manifest)).toBe(true);
      expect(hasGhostUiPermission(fixed.ghost)).toBe(false);
      expect(restarted.readApprovedInstallReceipt(id)?.unavailableUiResources).toBeUndefined();
      if (fixed.ghost.approval.state !== 'approved') throw new Error('expected approved update');
      expect(await restarted.approveUiCapability(id, fixed.ghost.approval.revision, () => true)).toBe(true);
    }

  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Startup must also ignore a missing UI in an older receipt with no availability
// marker. Keep existing approval and ordinary tools; no forced migration/reinstall.
it('keeps an already installed plugin enabled when its page is absent at startup', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-old-ui-')));
  try {
    const raw = { schemaVersion: 3, minCindyVersion: '0.1.122-beta', id: 'old-ui', name: 'Old', version: '1.0.0', entry: 'main.js',
      tools: [{ name: 'run', description: 'Run' }],
      mcpApps: { ui: { resources: [{ uri: 'ui://run', file: 'page.html' }], tools: { run: { resourceUri: 'ui://run', visibility: ['app'] } } } } };
    const file = await writeTestCindyPackage(path.join(directory, 'old.cindy'), raw, { 'main.js': '// ok\n', 'page.html': '<p>Page</p>' });
    const options: GhostManagerOptions = { getRootDir: () => path.join(directory, 'plugins'),
      mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir) };
    const manager = new GhostManager(options);
    const installed = await manager.install(file, { uiCapabilityApproved: true });
    if ('rejection' in installed) throw new Error(installed.rejection.reason);
    expect(hasGhostUiPermission(installed.ghost)).toBe(true);
    await fs.unlink(path.join(installed.ghost.dir, 'page.html'));
    const reloaded = new GhostManager(options).list()[0]!;
    expect(reloaded).toMatchObject({ enabled: true, approval: installed.ghost.approval });
    expect(hasGhostUiPermission(reloaded)).toBe(false);
    expect(pluginHasToolUi(reloaded.manifest)).toBe(false);
    expect(pluginToolVisible(reloaded.manifest, 'run', 'model')).toBe(true);
    expect(await fs.readFile(path.join(reloaded.dir, 'main.js'), 'utf8')).toBe('// ok\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

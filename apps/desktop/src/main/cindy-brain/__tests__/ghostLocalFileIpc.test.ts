import { createHash } from 'node:crypto';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ghostInstallApprovalToken,
  isGhostInstallApprovalToken,
  type InstalledGhost,
  type GhostTrustInfo,
} from '../../../shared/ghost.js';
import type { PluginMarketInstallationRecord } from '../../plugin-market/ledger.js';
import {
  deliveryNamespaceFields,
  findInstalledGhostByInstanceId,
  findInstalledGhostForLocalUpdate,
  installedGhostStoragePart,
  isGhostInstanceId,
  resolveInstalledGhost,
} from '../../../shared/pluginIdentity.js';
import { loadGhostFirstPartyFactsLoader } from '../ghostFirstPartyFacts.js';
import { authorizeGhostTokenBroker } from '../ghostFirstPartyPrivilege.js';
import { createGhostInstallReceipt, type GhostInstallReceipt } from '../ghostInstallReceipt.js';
import { classifyGhostLocalUpdateSource } from '../ghostLocalUpdateSource.js';
import { isCindyOverrideModelAllowed } from '../cindyOverrideWhitelist.js';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const callbackChannels = {
  inspect: 'ghosts:inspect', update: 'ghosts:update', exportGhost: 'ghosts:export',
  cindyPrefs: 'ghosts:cindy-prefs:set', errandPrefs: 'ghosts:errand-prefs:set',
};
const createCallbacks = createGhostProductionCallbacks<Record<keyof typeof callbackChannels, Handler>>({
  functions: [
    'readLocalGhostUpdateSource', 'updateLocalGhostPackageLocked', 'rejectUnauthorizedTokenBroker',
    'assertGhostRelocationIdle', 'findGhostForInstanceId',
  ],
  callbacks: Object.fromEntries(Object.entries(callbackChannels).map(([name, channel]) =>
    [name, ['ipcMain.handle', channel] as const],
  )),
});

function productionCallbacks(deps: Record<string, unknown>): Record<string, Handler> {
  const callbacks = createCallbacks(deps);
  return Object.fromEntries(Object.entries(callbackChannels).map(([name, channel]) =>
    [channel, callbacks[name as keyof typeof callbacks]],
  ));
}

const packageSha256 = 'a'.repeat(64);
const originalRevision = '11111111-1111-4111-8111-111111111111';
const replacementRevision = '22222222-2222-4222-8222-222222222222';
const unsigned: GhostTrustInfo = {
  level: 'unverified',
  publisherSigned: false,
  publisherVerified: false,
  reviewed: false,
};
const signed: GhostTrustInfo = {
  level: 'verified-publisher',
  publisherSigned: true,
  publisherVerified: true,
  reviewed: false,
  publisherKeyId: 'original-publisher',
};

function harness(
  options: {
    broker?: boolean;
    namespace?: string | null;
    approval?: 'approved' | 'invalid' | 'legacy-unapproved';
    missingReceipt?: boolean;
    fsBusy?: boolean;
  } = {},
) {
  const manifest: InstalledGhost['manifest'] = {
    schemaVersion: 2,
    id: 'filo-local',
    name: 'Local',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    ...(options.broker
      ? {
          network: {
            hosts: ['api.example.com'],
            secrets: [
              {
                key: 'oauth',
                source: 'oauth',
                label: 'OAuth',
                inject: {
                  header: 'Authorization',
                  format: 'Bearer {value}',
                  hosts: ['api.example.com'],
                },
                oauth: {
                  authorizeUrl: 'https://api.example.com/auth',
                  tokenUrl: 'https://api.example.com/token',
                  scopes: [],
                  tokenBroker: 'feishu',
                  redirectPort: 8123,
                },
              },
            ],
          },
        }
      : {}),
  };
  const ghost: InstalledGhost = {
    manifest,
    namespace: options.namespace ?? null,
    dir: options.namespace
      ? '/plugins/_ns/' + options.namespace + '/filo-local'
      : '/plugins/filo-local',
    enabled: true,
    trust: unsigned,
    approval:
      options.approval && options.approval !== 'approved'
        ? { state: options.approval }
        : { state: 'approved', revision: originalRevision },
  };
  const installed = new Map([[installedGhostStoragePart(ghost), ghost]]);
  const receipts = new Map<string, GhostInstallReceipt>();
  const marketRecords = new Map<string, PluginMarketInstallationRecord>();
  if (options.namespace)
    marketRecords.set(installedGhostStoragePart(ghost), {
      pluginId: 'organization-resource',
      ghostId: manifest.id,
      namespace: options.namespace,
      releaseId: 'original-release',
      version: manifest.version,
      scope: 'organization',
      organizationId: 'org-xd',
      source: 'market',
      installed: true,
      sha256: packageSha256,
      updatedAt: '2026-09-30T00:00:00Z',
    });
  if (ghost.approval.state === 'approved' && !options.missingReceipt)
    receipts.set(
      installedGhostStoragePart(ghost),
      createGhostInstallReceipt({
        manifest,
        namespace: ghost.namespace,
        localeResources: {},
        enabled: true,
        trust: unsigned,
        revision: ghost.approval.revision,
        skillContentSha256: {},
        packageSha256,
        legacyFirstPartyEligible: options.broker === true && !options.namespace,
      }),
    );
  let inspected = {
    manifest,
    canonicalManifest: manifest,
    trust: unsigned,
    packageSha256,
    unsupportedLegacySlots: [],
  };
  const ledger = {
    bind: () => ledger,
    installationForPlugin: vi.fn(() => null),
    markRemovedRecord: vi.fn(),
    restoreInstallation: vi.fn(),
  };
  const manager = {
    list: () => [...installed.values()],
    inspect: vi.fn(async () => inspected),
    readApprovedInstallReceipt: vi.fn((id: string, revision: string) =>
      receipts.get(id)?.revision === revision ? receipts.get(id) : null,
    ),
    update: vi.fn(async (_path: string, updateOptions: { onPackagePlaced?: () => void }) => {
      updateOptions.onPackagePlaced?.();
      return { ghost: { ...ghost, approval: { state: 'approved', revision: 'new-receipt' } } };
    }),
  };
  const loader = loadGhostFirstPartyFactsLoader({
    readInstalledBuiltin: () => false,
    readMarketInstallation: (id) => marketRecords.get(id) ?? null,
    readApprovedPackageSha256: (id) => {
      const target = findInstalledGhostByInstanceId(manager.list(), id);
      return receipts.get(target ? installedGhostStoragePart(target) : id)?.packageSha256 ?? null;
    },
    readInstallNamespace: (id) => findInstalledGhostByInstanceId(manager.list(), id)?.namespace,
    readInstallOrigin: () => 'manual',
    readLegacyFirstPartyEligible: (id) => receipts.get(id)?.legacyFirstPartyEligible === true,
    lookupOrganizationPrefix: () => ({ kind: 'absent' }),
  });
  const runtime = { stop: vi.fn(), resetFuse: vi.fn() };
  const release = vi.fn();
  const session = { mode: 'local', dataOwnerId: 'owner', generation: 1 };
  let exportMutation: (() => void) | undefined;
  const exportBytes = Buffer.from('host-produced-export-snapshot');
  const exportDigest = createHash('sha256').update(exportBytes).digest('hex');
  const exportPackage = vi.fn(
    async (
      _id: string,
      deps: {
        listInstalled: () => InstalledGhost[];
        writeFile: (path: string, bytes: Buffer) => Promise<void>;
        inspectPackage: (path: string) => Promise<boolean>;
      },
    ) => {
      expect(deps.listInstalled().some((candidate) => candidate.dir === ghost.dir)).toBe(true);
      await deps.writeFile('/exports/snapshot.tmp', exportBytes);
      inspected = { ...inspected, packageSha256: exportDigest };
      exportMutation?.();
      return (await deps.inspectPackage('/exports/snapshot.tmp'))
        ? { status: 'saved', savedPath: '/exports/plugin.cindy' }
        : { status: 'error', code: 'verify_failed' };
    },
  );
  const callbacks = productionCallbacks({
    manager,
    assertTrustedAppRendererEvent: vi.fn(),
    captureGhostMutationOwner: () => ({ ...session }),
    beginGhostMutation: () => release,
    getActiveAppSession: () => session,
    isAppSessionBoundaryPending: () => false,
    isSameAppSession: (left: typeof session, right: typeof session) =>
      left.generation === right.generation && left.dataOwnerId === right.dataOwnerId,
    ghostOwnerScope: {
      isStable: (owner: typeof session) => owner.generation === session.generation,
    },
    throwIpcError: (code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    },
    throwInstallError: (rejection: unknown) => {
      throw new Error(JSON.stringify(rejection));
    },
    rejectReservedGhostId: vi.fn(),
    rejectBrokerWithoutDeclaredRedirectPort: vi.fn(),
    ghostTokenBrokerInstallError: () => ({ code: 'PERMISSION_DENIED', reason: 'Broker denied' }),
    isGhostTokenBrokerAuthorized: (
      id: string,
      purpose: 'runtime' | 'install',
      overrides: Parameters<typeof loader.load>[3],
    ) =>
      authorizeGhostTokenBroker(
        id,
        loader.load(
          id,
          purpose,
          options.namespace
            ? { membershipKind: 'org', orgId: 'org-xd', orgSlug: options.namespace }
            : { membershipKind: 'personal', orgId: null },
          overrides,
        ),
      ),
    findInstalledGhostForLocalUpdate,
    findInstalledGhostByInstanceId,
    installedGhostStoragePart,
    resolveInstalledGhost,
    availableGhosts: () => Array.from(installed.values()),
    CINDY_CAPABILITY_KEYS: ['image.generate'],
    isCindyOverrideModelAllowed,
    getGhostMediaPreferenceConfig: () => ({ models: [] }),
    getCatalogEmbedConfig: () => ({ models: [] }),
    buildTextOneshotPinOptions: () => [],
    getActiveCatalog: () => ({}),
    readModelDisableOverrides: () => ({}),
    writeGhostCindyOverride: vi.fn((id: string) => ({ id })),
    writeGhostErrandConfig: vi.fn((id: string) => ({ id })),
    getGhostSetupChangeBus: () => ({ emit: vi.fn() }),
    ghostInstallApprovalToken,
    isGhostInstanceId,
    isGhostInstallApprovalToken,
    deliveryNamespaceFields,
    classifyGhostLocalUpdateSource,
    getPluginMarketLedger: () => ledger,
    ownerScopedUserDataPath: () => '/owner/ledger.json',
    obtainGhostInstallConsent: vi.fn(async () => ({ action: 'install' })),
    createWindowGhostInstallConsentPrompt: vi.fn(),
    assertGhostInstallConsent: vi.fn(),
    withGhostInstallLock: async (_id: string, task: () => unknown) => task(),
    withActiveOwnerGhostOauthMutationLock: async (_id: string, task: () => unknown) => task(),
    getGhostRuntime: () => runtime,
    hasPendingGhostCalls: () => false,
    hasRunningGhostErrand: () => false,
    hasRunningGhostCindyWork: () => false,
    fsSlotSingleton: { hasInFlightRequests: () => options.fsBusy === true },
    getGhostNodeRuntimeBroker: () => ({ stopAndWait: vi.fn() }),
    getGhostAgentSlot: () => ({ clearGhost: vi.fn() }),
    getGhostErrandSlot: () => ({ clearGhost: vi.fn() }),
    getGhostOauthAccountManager: () => ({ prepareAccountsForChangedClients: vi.fn() }),
    withRuntimeFiloGoogleClient: (value: unknown) => value,
    ghostSourceStateArchiveId: () => '_ns__cindy-archive-test__filo-local',
    getLayoutStore: () => ({ getLayout: () => ({}), setLayout: vi.fn() }),
    layoutWithGhostPanel: () => null,
    spawnIfResident: vi.fn(),
    exportGhostPackage: exportPackage,
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showSaveDialog: vi.fn() },
    app: { getPath: () => '/exports' },
    t: (key: string) => key,
    fs: { promises: { writeFile: vi.fn() } },
    createHash,
    findConflictingGhostCommand: () => null,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  });
  const target = {
    expectedInstalledInstanceId: installedGhostStoragePart(ghost),
    expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
  };
  return {
    callbacks,
    ghost,
    manager,
    receipts,
    installed,
    target,
    runtime,
    release,
    session,
    replacePackage: (values: Partial<typeof inspected>) => {
      inspected = { ...inspected, ...values };
    },
    mutateExport: (mutation: () => void) => {
      exportMutation = mutation;
    },
  };
}

describe('local file recovery and source gates through production IPC callbacks', () => {
  it.each(['invalid', 'legacy-unapproved'] as const)(
    'repairs %s receipt without inheriting source state',
    async (approval) => {
      const target = harness({ approval });
      await expect(
        target.callbacks['ghosts:update']({}, '/local.cindy', {
          ...target.target,
          expectedPackageSha256: packageSha256,
        }),
      ).resolves.toMatchObject({ ghost: { approval: { state: 'approved' } } });
      expect(target.manager.update).toHaveBeenCalledWith(
        '/local.cindy',
        expect.objectContaining({ sourceStateArchiveId: '_ns__cindy-archive-test__filo-local' }),
      );
      expect(target.release).toHaveBeenCalledOnce();
    },
  );
  it('treats missing approved receipt as source replacement, not inherited approval', async () => {
    const target = harness({ missingReceipt: true });
    await expect(
      target.callbacks['ghosts:update']({}, '/local.cindy', {
        ...target.target,
        expectedPackageSha256: packageSha256,
      }),
    ).resolves.toBeTruthy();
    expect(target.manager.update).toHaveBeenCalledWith(
      '/local.cindy',
      expect.objectContaining({ sourceStateArchiveId: '_ns__cindy-archive-test__filo-local' }),
    );
  });
  it.each(['invalid', 'legacy-unapproved'] as const)(
    'cannot restore legacy Broker qualification from %s receipt',
    async (approval) => {
      const target = harness({ approval, broker: true });
      await expect(
        target.callbacks['ghosts:update']({}, '/local.cindy', {
          ...target.target,
          expectedPackageSha256: packageSha256,
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(target.manager.update).not.toHaveBeenCalled();
      expect(target.runtime.stop).not.toHaveBeenCalled();
    },
  );
  it('inspects an exact same-source legacy Broker package for the selected receiver', async () => {
    const target = harness({ broker: true });
    await expect(
      target.callbacks['ghosts:inspect']({}, '/local.cindy', target.target),
    ).resolves.toMatchObject({ packageSha256 });
  });
  it('inspects a verified update signed by the previously pinned publisher', async () => {
    const target = harness({ broker: true });
    target.receipts.get('filo-local')!.trust = signed;
    target.replacePackage({ trust: signed, packageSha256: 'b'.repeat(64) });
    await expect(
      target.callbacks['ghosts:inspect']({}, '/local.cindy', target.target),
    ).resolves.toMatchObject({ packageSha256: 'b'.repeat(64) });
  });
  it.each([undefined, 'target'])(
    'rejects a new unsigned same-name Broker package with context %s',
    async (context) => {
      const target = harness({ broker: true });
      target.replacePackage({ packageSha256: 'b'.repeat(64) });
      await expect(
        target.callbacks['ghosts:inspect']({}, '/local.cindy', context ? target.target : undefined),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    },
  );
  it('does not silently replace a mismatched inspect receiver', async () => {
    const target = harness();
    await expect(
      target.callbacks['ghosts:inspect']({}, '/local.cindy', {
        ...target.target,
        expectedInstalledApproval: 'approved:' + replacementRevision,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('keeps old one-argument inspect working for an ordinary package', async () => {
    await expect(harness().callbacks['ghosts:inspect']({}, '/local.cindy')).resolves.toMatchObject({
      packageSha256,
    });
  });
  it('exports the source-qualified legacy snapshot instead of treating it as a fresh install', async () => {
    const target = harness({ broker: true });
    await expect(target.callbacks['ghosts:export']({}, 'filo-local')).resolves.toMatchObject({
      status: 'saved',
    });
  });
  it('does not export a Broker merely because an ordinary root has the same name', async () => {
    const target = harness({ broker: true });
    target.receipts.get('filo-local')!.legacyFirstPartyEligible = false;
    await expect(target.callbacks['ghosts:export']({}, 'filo-local')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
  it('rejects export after the selected receipt changes', async () => {
    const target = harness();
    target.mutateExport(() =>
      target.installed.set('filo-local', {
        ...target.ghost,
        approval: { state: 'approved', revision: 'replacement' },
      }),
    );
    await expect(target.callbacks['ghosts:export']({}, 'filo-local')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
  it('rejects export bytes replaced after the Host wrote its snapshot', async () => {
    const target = harness();
    target.mutateExport(() => target.replacePackage({ packageSha256: 'b'.repeat(64) }));
    await expect(target.callbacks['ghosts:export']({}, 'filo-local')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('exports the qualified organization instance without borrowing a same-name root', async () => {
    const target = harness({ broker: true, namespace: 'xd' });
    target.installed.set('filo-local', {
      ...target.ghost,
      namespace: null,
      dir: '/plugins/filo-local',
    });
    await expect(
      target.callbacks['ghosts:export']({}, target.target.expectedInstalledInstanceId),
    ).resolves.toMatchObject({ status: 'saved' });
  });

  it('rejects source replacement before stopping the runtime while an FS request is in flight', async () => {
    const target = harness({ approval: 'invalid', fsBusy: true });
    await expect(target.callbacks['ghosts:update']({}, '/local.cindy', {
      ...target.target, expectedPackageSha256: packageSha256,
    })).rejects.toThrow('waiting for active work');
    expect(target.runtime.stop).not.toHaveBeenCalled();
    expect(target.manager.update).not.toHaveBeenCalled();
    expect(target.release).toHaveBeenCalledOnce();
  });

  it.each(['cindy', 'errand'])('binds %s preferences to the current physical instance and rejects missing targets', async (kind) => {
    const target = harness({ namespace: 'xd', approval: 'invalid' });
    const handler = target.callbacks['ghosts:' + kind + '-prefs:set'];
    const args = kind === 'cindy' ? ['image.generate', null] : [null];
    expect(await handler({}, 'filo-local', ...args)).toMatchObject(
      kind === 'cindy' ? { overrides: { id: '_ns__xd__filo-local' } } : { config: { id: '_ns__xd__filo-local' } },
    );
    target.installed.clear();
    await expect(Promise.resolve().then(() => handler({}, 'filo-local', ...args))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates the selected namespace instance rather than a same-name root', async () => {
    const target = harness({ namespace: 'xd', approval: 'invalid' });
    target.installed.set('filo-local', {
      ...target.ghost,
      namespace: null,
      dir: '/plugins/filo-local',
    });
    await target.callbacks['ghosts:update']({}, '/local.cindy', {
      ...target.target,
      expectedPackageSha256: packageSha256,
    });
    expect(target.manager.update).toHaveBeenCalledWith(
      '/local.cindy',
      expect.objectContaining({
        namespace: 'xd',
        sourceStateArchiveId: '_ns__cindy-archive-test__filo-local',
      }),
    );
  });

  it.each([
    null,
    {},
    { legacyFirstPartyEligible: true },
    { expectedInstalledInstanceId: 'filo-local' },
  ])('rejects unbound inspect options %j', async (options) => {
    await expect(
      harness({ broker: true }).callbacks['ghosts:inspect']({}, '/local.cindy', options),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('cancels targeted inspect when the owner changes while inspecting bytes', async () => {
    const target = harness({ broker: true });
    const original = target.manager.inspect.getMockImplementation()!;
    target.manager.inspect.mockImplementation(async () => {
      const result = await original();
      target.session.generation += 1;
      return result;
    });
    await expect(
      target.callbacks['ghosts:inspect']({}, '/local.cindy', target.target),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('cancels export when the owner changes after the snapshot is captured', async () => {
    const target = harness();
    target.mutateExport(() => {
      target.session.generation += 1;
    });
    await expect(target.callbacks['ghosts:export']({}, 'filo-local')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});

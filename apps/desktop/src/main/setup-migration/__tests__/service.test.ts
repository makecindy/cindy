import { describe, expect, it, vi } from 'vitest';

import type { SetupSnapshotRequest } from '@cindy/device-link';

import {
  createSetupMigrationService,
  type PersistedSetupMigrationState,
  type SetupDeviceFact,
  type SetupMigrationServiceDeps,
} from '../service.js';
import { snapshot } from './fixtures.js';
import type { SetupTransferApplyDeps } from '../transferApply.js';

const device = (overrides: Partial<SetupDeviceFact> = {}): SetupDeviceFact => ({
  deviceId: 'dev-old',
  name: 'Mac mini',
  platform: 'darwin',
  online: true,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
  lastSeenAt: '2026-10-19T00:00:00.000Z',
  ...overrides,
});

function harness(overrides: Partial<SetupMigrationServiceDeps> = {}) {
  let owner: string | null = 'owner-a';
  let state: PersistedSetupMigrationState = { lastRun: null, suggestionDismissed: false };
  const remote = vi.fn(async (_deviceId: string, request: SetupSnapshotRequest): Promise<unknown> =>
    request.action === 'caps'
      ? { setupSnapshot: 1 }
      : snapshot({ skills: [{ name: 'deploy', version: '1.0.0', catalogScope: 'market', origin: 'installed', enabled: true }] }),
  );
  const deps: SetupMigrationServiceDeps = {
    platform: 'darwin',
    now: () => 1000,
    ownerKey: () => owner,
    listDevices: async () => [
      device(),
      device({ deviceId: 'phone', platform: 'ios' }),
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'pc', name: 'Office PC', platform: 'win32', remoteControlEnabled: false }),
    ],
    invokeRemote: remote,
    targetGhosts: () => [],
    catalog: async () => new Map(),
    marketNames: async () => new Set(),
    localSkills: async () => new Map(),
    mcpIds: async () => new Set(),
    providerIds: async () => new Set(),
    builtinTools: async () => new Map(),
    access: () => ({ remoteControlEnabled: false, keepAwake: false }),
    builtinKeys: () => new Set(),
    sshHostIds: async () => new Set(),
    transfer: () => ({
      transfer: vi.fn(),
      createProvider: vi.fn(),
      createMcpServer: vi.fn<SetupTransferApplyDeps['createMcpServer']>(async () => ({
        configurationSaved: true, token: 'not-requested', refreshError: null,
      })),
      hasBuiltinKey: () => false,
      storeBuiltinKey: vi.fn(),
      pluginInstanceKey: () => null,
      storePluginSecrets: vi.fn(),
      generateSshKey: vi.fn(),
      addSshHost: vi.fn(),
    }),
    settingsGroups: [],
    apply: {
      marketNames: async () => new Set(),
      addMarketSource: vi.fn(),
      pluginDetail: vi.fn(),
      installPlugin: vi.fn(),
      findGhost: () => null,
      setPluginEnabled: vi.fn(),
      installSkill: vi.fn(async (name: string) => ({ absolutePath: `/s/${name}` })),
      setSkillEnabled: vi.fn(),
      findSkill: vi.fn(async () => null),
      pluginSetupMissing: () => null,
    },
    readState: () => state,
    writeState: async (next) => {
      state = next;
    },
    checklistItemDone: () => null,
    looksNew: async () => true,
    legacyMigrated: () => false,
    source: {
      platform: 'darwin',
      now: () => 5,
      settingsGroups: [],
      readRendererPrefs: async () => null,
      readPlugins: async () => ({ ghosts: [], market: [] }),
      pluginSetupReady: () => null,
      readMarketSources: async () => [],
      readSkills: async () => [],
      readMcpServers: async () => [],
      readProviders: async () => [],
      isUserProvider: () => true,
      readBuiltinToolOverrides: async () => [],
      readAccess: () => ({ remoteControlEnabled: true, remoteDesktopEnabled: false, keepAwake: false }),
      readHints: async () => ({ builtinKeys: [], imChannels: [], sshHostCount: 0 }),
      readSshHosts: async () => [],
    },
    ...overrides,
  };
  return {
    service: createSetupMigrationService(deps),
    remote,
    setOwner: (next: string | null) => {
      owner = next;
    },
    state: () => state,
  };
}

describe('setup migration service', () => {
  // Unit tier, real preview: a stale picker must not bypass the fresh directory's
  // availability facts, contact another source, or require a second directory read.
  it.each([
    ['missing', null, 'NOT_FOUND'],
    ['offline', { online: false }, 'SETUP_SOURCE_UNAVAILABLE'],
    ['remote control off', { remoteControlEnabled: false }, 'SETUP_SOURCE_UNAVAILABLE'],
    ['control disabled', { controlEnabled: false }, 'SETUP_SOURCE_UNAVAILABLE'],
    ['self', { isSelf: true }, 'NOT_FOUND'],
    ['mobile', { platform: 'ios' }, 'NOT_FOUND'],
  ] as const)('rejects a %s source before remote reads', async (_name, changes, code) => {
    const listDevices = vi.fn(async () => [
      ...(changes === null ? [] : [device(changes)]),
      device({ deviceId: 'another', name: 'Another Mac' }),
    ]);
    const { service, remote } = harness({ listDevices });
    await expect(service.preview('dev-old', 1)).rejects.toMatchObject({ code });
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
  });

  it('uses one directory read to validate and preview exactly the chosen source', async () => {
    const listDevices = vi.fn(async () => [device({ deviceId: 'another' }), device()]);
    const { service, remote } = harness({ listDevices });
    const plan = await service.preview('dev-old', 1);
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(plan.source.deviceId).toBe('dev-old');
    expect(remote.mock.calls).toEqual([
      ['dev-old', { action: 'caps' }],
      ['dev-old', { action: 'snapshot' }],
    ]);
  });

  it('lists other desktops of the account, readable ones first, with why the rest are not', async () => {
    const { service } = harness();
    expect(await service.sources()).toEqual([
      { deviceId: 'dev-old', name: 'Mac mini', platform: 'darwin', online: true, lastSeenAt: '2026-10-19T00:00:00.000Z' },
      {
        deviceId: 'pc',
        name: 'Office PC',
        platform: 'win32',
        online: true,
        lastSeenAt: '2026-10-19T00:00:00.000Z',
        unavailable: 'remote-control-off',
      },
    ]);
  });

  it('asks to update an older computer instead of treating it as unreachable', async () => {
    const { service } = harness({
      invokeRemote: async () => {
        throw Object.assign(new Error('not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });
      },
    });
    await expect(service.preview('dev-old', 1)).rejects.toMatchObject({ code: 'SETUP_SOURCE_OUTDATED' });
  });

  it('reports an unreadable reply as invalid, not as a working snapshot', async () => {
    const { service } = harness({
      invokeRemote: async (_id, request) => (request.action === 'caps' ? { setupSnapshot: 1 } : { version: 99 }),
    });
    await expect(service.preview('dev-old', 1)).rejects.toMatchObject({ code: 'SETUP_SNAPSHOT_INVALID' });
  });

  it('applies a plan only from the window and account that previewed it, once', async () => {
    const { service, setOwner, state } = harness();
    const plan = await service.preview('dev-old', 7);
    const request = { planId: plan.planId, keys: ['skill:deploy'], approvedPluginKeys: [] };
    const prompt = vi.fn(async () => true);
    await expect(service.apply(request, 8, prompt, () => {})).rejects.toMatchObject({ code: 'SETUP_PLAN_EXPIRED' });
    setOwner('owner-b');
    await expect(service.apply(request, 7, prompt, () => {})).rejects.toMatchObject({ code: 'SETUP_PLAN_EXPIRED' });
    setOwner('owner-a');
    const result = await service.apply(request, 7, prompt, () => {});
    expect(result.results).toEqual([{ key: 'skill:deploy', outcome: 'done' }]);
    expect(state().lastRun?.sourceName).toBe('Mac mini');
    await expect(service.apply(request, 7, prompt, () => {})).rejects.toMatchObject({ code: 'SETUP_PLAN_EXPIRED' });
  });

  it('ignores selection keys and permission approvals the plan never offered', async () => {
    const { service } = harness();
    const plan = await service.preview('dev-old', 7);
    const result = await service.apply(
      { planId: plan.planId, keys: ['skill:deploy', 'plugin:_root:evil'], approvedPluginKeys: ['plugin:_root:evil'] },
      7,
      vi.fn(),
      () => {},
    );
    expect(result.results.map((r) => r.key)).toEqual(['skill:deploy']);
  });

  it('answers another computer with caps without an account, and a snapshot only with one', async () => {
    const { service, setOwner } = harness();
    expect(await service.handleRemote({ action: 'caps' })).toEqual({ setupSnapshot: 1 });
    expect(await service.handleRemote({ action: 'snapshot' })).toMatchObject({ version: 1, createdAt: 5 });
    setOwner(null);
    await expect(service.handleRemote({ action: 'snapshot' })).rejects.toThrow();
    await expect(service.handleRemote({ action: 'write' })).rejects.toThrow('SETUP_SNAPSHOT_INVALID');
  });

  // Rule: first-run-guide.md §2 (when the guide is shown). Gap: the once-only decision and its
  // two paths had no caller-level coverage. Tier: unit, through the service entry.
  it('shows the guide once on a new computer and leads with migration when another computer has something to bring', async () => {
    const { service, state } = harness();
    expect(await service.firstRunGuide()).toEqual({ show: true, migration: true, legacyMigrated: false });
    expect(state().suggestionDismissed).toBe(true);
    expect(await service.firstRunGuide()).toEqual({ show: false, migration: false, legacyMigrated: false });
  });

  it('shows the guide without migration when no other computer has anything to bring', async () => {
    const { service } = harness({
      invokeRemote: async (_deviceId, request) =>
        request.action === 'caps' ? { setupSnapshot: 1 } : snapshot({ settings: [{ id: 'appearance', values: { theme: 'dark' } }] }),
    });
    expect(await service.firstRunGuide()).toEqual({ show: true, migration: false, legacyMigrated: false });
  });

  it('stays hidden on a computer that is already set up, unless earlier-version data was just brought over', async () => {
    const used = harness({ looksNew: async () => false });
    expect(await used.service.firstRunGuide()).toEqual({ show: false, migration: false, legacyMigrated: false });
    expect(used.remote).not.toHaveBeenCalled();
    expect(used.state().suggestionDismissed).toBe(false);

    const upgraded = harness({ looksNew: async () => false, legacyMigrated: () => true });
    expect(await upgraded.service.firstRunGuide()).toMatchObject({ show: true, legacyMigrated: true });
  });

  it('marks checklist items done from live state or by the user', async () => {
    const seeded = harness({ checklistItemDone: (item) => (item.kind === 'plugin-setup' ? true : null) });
    seeded.state().lastRun = {
      sourceName: 'Mac mini',
      finishedAt: 1,
      checklist: [
        { id: 'plugin-setup:x', kind: 'plugin-setup', label: 'X', ref: 'x' },
        { id: 'ssh', kind: 'ssh', label: '2' },
      ],
    };
    const live = await seeded.service.state();
    expect(live.lastRun?.checklist.map((item) => [item.id, item.done ?? false])).toEqual([
      ['plugin-setup:x', true],
      ['ssh', false],
    ]);
    const dismissed = await seeded.service.dismiss({ kind: 'checklist-item', id: 'ssh' });
    expect(dismissed.lastRun?.checklist.find((item) => item.id === 'ssh')?.done).toBe(true);
  });
});


describe('MCP copy evidence through the service state boundary', () => {
  // This is the real service/apply pipeline with JSON-only fake storage. It does not
  // substitute for register.ts's private normalizeState or production live predicate.
  it.each(['saved', 'failed'] as const)('persists receipt evidence for %s without treating a fixture as register verification', async (token) => {
    let stored: PersistedSetupMigrationState = { lastRun: null, suggestionDismissed: false };
    const live = vi.fn<SetupMigrationServiceDeps['checklistItemDone']>(() => false);
    const source = snapshot({ transfer: 1, mcpServers: [{ id: 'docs', name: 'Docs', transport: 'http', url: 'https://example.test/mcp', headers: {}, hasToken: true, credentialKinds: { bearer: true, headers: true, url: false } }] });
    const createMcpServer = vi.fn<SetupTransferApplyDeps['createMcpServer']>(async () => ({ configurationSaved: true, token, refreshError: null }));
    const overrides: Partial<SetupMigrationServiceDeps> = {
      invokeRemote: async (_device, request) => request.action === 'caps' ? { setupSnapshot: 1 } : source,
      readState: () => JSON.parse(JSON.stringify(stored)) as PersistedSetupMigrationState,
      writeState: async (next) => { stored = JSON.parse(JSON.stringify(next)) as PersistedSetupMigrationState; },
      checklistItemDone: live,
      transfer: () => ({
        transfer: async () => ({ secrets: { providers: [], builtinKeys: [], plugins: [], mcpServers: [{ id: 'docs', url: 'https://example.test/mcp', headers: { 'X-Key': 'fake' }, token: 'fake-token' }] }, ssh: null }),
        createProvider: vi.fn(), createMcpServer, hasBuiltinKey: () => false,
        storeBuiltinKey: vi.fn(), pluginInstanceKey: () => null, storePluginSecrets: vi.fn(),
        generateSshKey: vi.fn(), addSshHost: vi.fn(),
      }),
    };
    const first = harness(overrides).service;
    const plan = await first.preview('dev-old', 7);
    const result = await first.apply({ planId: plan.planId, keys: ['mcp:docs', 'secrets'], approvedPluginKeys: [] }, 7, async () => true, () => {});
    expect(result.handledKeys).toEqual(['mcp:docs']);
    expect(createMcpServer).toHaveBeenCalledTimes(1);
    expect(stored.lastRun?.checklist.find((item) => item.id === 'mcp-token:docs')?.mcpCredentialsCopied === true).toBe(token === 'saved');
    const reloaded = harness(overrides).service;
    expect((await reloaded.state()).lastRun?.checklist.find((item) => item.id === 'mcp-token:docs')?.mcpCredentialsCopied === true).toBe(token === 'saved');
    if (token === 'failed') {
      expect(result.results).toContainEqual({ key: 'secrets', outcome: 'failed', code: 'CREDENTIAL_STORAGE_FAILED' });
      expect((await reloaded.state()).lastRun?.checklist.find((item) => item.id === 'mcp-token:docs')?.done).not.toBe(true);
    }
    await reloaded.dismiss({ kind: 'checklist-item', id: 'mcp-token:docs' });
    live.mockClear();
    expect((await reloaded.state()).lastRun?.checklist.find((item) => item.id === 'mcp-token:docs')?.done).toBe(true);
    expect(live).not.toHaveBeenCalled();
  });

  it('keeps pre-existing done while unknown MCP items remain available for manual completion', async () => {
    const state: PersistedSetupMigrationState = { suggestionDismissed: false, lastRun: { sourceName: 'Old', finishedAt: 1, checklist: [
      { id: 'mcp-token:old', kind: 'mcp-token', label: 'Old', ref: 'old', done: true },
      { id: 'mcp-token:unknown', kind: 'mcp-token', label: 'Unknown', ref: 'unknown' },
    ] } };
    const live = vi.fn<SetupMigrationServiceDeps['checklistItemDone']>(() => false);
    const { service } = harness({ readState: () => state, checklistItemDone: live });
    expect((await service.state()).lastRun?.checklist.map((item) => !!item.done)).toEqual([true, false]);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0][0]).toMatchObject({ ref: 'unknown' });
  });
});

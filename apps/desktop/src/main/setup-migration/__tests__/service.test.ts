import { describe, expect, it, vi } from 'vitest';

import type { SetupSnapshotRequest } from '@cindy/device-link';

import {
  createSetupMigrationService,
  type PersistedSetupMigrationState,
  type SetupDeviceFact,
  type SetupMigrationServiceDeps,
} from '../service.js';
import { snapshot } from './fixtures.js';

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
      createMcpServer: vi.fn(),
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

  it('suggests setup once on a new computer and stops after the user dismisses it', async () => {
    const { service } = harness();
    expect((await service.state()).suggestion).toEqual({ deviceId: 'dev-old', name: 'Mac mini' });
    const after = await service.dismiss({ kind: 'suggestion' });
    expect(after.suggestion).toBeNull();
  });

  it('does not suggest setup on a computer the user already set up', async () => {
    const { service } = harness({ looksNew: async () => false });
    expect((await service.state()).suggestion).toBeNull();
  });

  it('marks checklist items done from live state or by the user', async () => {
    const seeded = harness({ checklistItemDone: (item) => (item.kind === 'plugin-setup' ? true : null) });
    await seeded.service.dismiss({ kind: 'suggestion' });
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

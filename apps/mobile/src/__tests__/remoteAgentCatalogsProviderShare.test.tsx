// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
} from '@cindy/device-link';

import { i18n } from '@/i18n';
import { clearAllDeviceProviders } from '@/device-link/deviceProvidersCache';
import { clearAllProviderShareCatalogs } from '@/device-link/providerShareCatalogCache';
import type { RemoteAgentCatalog } from '@/session/remoteAgentCatalogs';
import { useRemoteAgentCatalogs } from '@/session/useRemoteAgentCatalogs';

const provider = (id: string, name: string) => ({
  id,
  name,
  agents: ['claude-code'],
  connected: true,
  remoteInvocationEnabled: true,
  models: { 'claude-code': [{ id: `${id}-model`, name: `${name} Model`, contextWindow: 200_000, efforts: [] }] },
  routing: { 'claude-code': {} },
});

const link = vi.hoisted(() => ({
  invoke: vi.fn(),
  openLink: vi.fn(async () => undefined),
  readDeviceList: vi.fn(),
  connectionEpoch: 1,
  rosterVersion: 0,
  providerShareCatalogVersions: {} as Record<string, number>,
  status: 'online' as const,
  presenceVersion: 1,
  getPresenceAvailability: vi.fn((_deviceId: string): boolean | null => null),
}));

vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));

const device = (deviceId: string, name: string) => ({
  deviceId,
  name,
  platform: 'darwin',
  appVersion: '1.0.0',
  lastSeenAt: null,
  online: true,
  busy: false,
  remoteControlEnabled: true,
  isSelf: false,
});

const receivedShare = {
  agentDeviceId: 'share:share-1',
  shareId: 'share-1',
  providerId: 'anthropic',
  providerLabel: 'Anthropic',
  deviceName: "Magi's Mac Mini",
  owner: { displayName: 'Magi', avatarUrl: null },
  status: 'active',
  hostOnline: true,
  catalog: { providers: [provider('anthropic', 'Anthropic')] },
};

let root: Root;
let host: HTMLDivElement;
let latest: RemoteAgentCatalog[] = [];

function Probe(props: Parameters<typeof useRemoteAgentCatalogs>[0]) {
  latest = useRemoteAgentCatalogs(props);
  return null;
}

async function render(props: Parameters<typeof useRemoteAgentCatalogs>[0]) {
  await act(async () => {
    root.render(<Probe {...props} />);
  });
  // 让设备清单、目录与分享读取的 promise 链跑完。
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage('zh-CN');
  clearAllDeviceProviders();
  clearAllProviderShareCatalogs();
  latest = [];
  link.presenceVersion = 1;
  link.rosterVersion = 0;
  link.providerShareCatalogVersions = {};
  link.getPresenceAvailability.mockImplementation(() => null);
  link.readDeviceList.mockResolvedValue({ devices: [device('controlled', 'Home Mac'), device('studio', 'Studio Mac')] });
  link.invoke.mockImplementation(async (deviceId: string, channel: string) => {
    if (channel === 'maker:provider:list' && deviceId === 'studio') {
      return { providers: [provider('studio-provider', 'Studio Provider')] };
    }
    if (channel === PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL && deviceId === 'controlled') {
      return { shares: [receivedShare] };
    }
    throw new Error(`unexpected ${deviceId} ${channel}`);
  });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
});

describe('remote Agent catalogs with provider shares', () => {
  it('clears same-account device rows on a roster invalidation but keeps share catalogs', async () => {
    const props = { enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] };
    await render(props);
    expect(latest.map((catalog) => catalog.deviceId)).toContain('studio');
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');

    link.readDeviceList.mockResolvedValue({ devices: [device('controlled', 'Home Mac')] });
    link.rosterVersion = 1;
    await act(async () => { root.render(<Probe {...props} />); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });

    expect(latest.map((catalog) => catalog.deviceId)).not.toContain('studio');
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');
  });

  it('lists the controlled computer’s received shares after same-account computers', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(link.invoke).toHaveBeenCalledWith(
      'controlled',
      PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
      [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }],
    );
    expect(latest.map((catalog) => [catalog.deviceId, catalog.name, catalog.providers.map((p) => p.id)])).toEqual([
      ['studio', 'Studio Mac', ['studio-provider']],
      ['share:share-1', '来自 Magi 的分享', ['anthropic']],
    ]);
    // 模型列表分组标题 = 「{供应商} · 来自 {分享者} 的分享」,不写分享者的电脑名(产品规则 §5.1、§6)。
    expect(i18n.t('models.unified.remoteProvider', { provider: 'Anthropic', device: latest[1].name }))
      .toBe('Anthropic · 来自 Magi 的分享');
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：useRemoteAgentCatalogs 的 share catalog 缓存；受控 host 的 model-catalog push 后重新读取。
   * - Bug/规则依据：providerShareRuntime.changed → maker:model-catalog:changed 是真实 producer，Mobile 之前漏消费。
   * - 现有覆盖缺口：既有测试只覆盖显式 deny/expiry 与初始读取，不覆盖该 push 的版本失效。
   * - 最小失败输入：controlled version 0→1，远端分享状态变 paused；不刷新会继续显示旧 share 行。
   * - tier：unit（jsdom + mock DeviceLinkContext）。
   */
  it('refreshes only the controlled host share catalog on a model-catalog push', async () => {
    const props = { enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] };
    await render(props);
    const before = link.invoke.mock.calls.filter(([deviceId, channel]) =>
      deviceId === 'controlled' && channel === PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL).length;
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');

    link.invoke.mockImplementation(async (deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list' && deviceId === 'studio') {
        return { providers: [provider('studio-provider', 'Studio Provider')] };
      }
      if (channel === PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL && deviceId === 'controlled') {
        return { shares: [{ ...receivedShare, status: 'paused' }] };
      }
      throw new Error(`unexpected ${deviceId} ${channel}`);
    });
    link.providerShareCatalogVersions = { controlled: 1 };
    await render(props);

    expect(link.invoke.mock.calls.filter(([deviceId, channel]) =>
      deviceId === 'controlled' && channel === PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL).length)
      .toBeGreaterThan(before);
    expect(latest.map((catalog) => catalog.deviceId)).not.toContain('share:share-1');
    expect(latest.map((catalog) => catalog.deviceId)).toContain('studio');
  });

  it('numbers a second share of the same provider from the same owner instead of naming the computer', async () => {
    link.invoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [] };
      return {
        shares: [
          receivedShare,
          { ...receivedShare, agentDeviceId: 'share:share-2', shareId: 'share-2', deviceName: "Magi's Laptop" },
        ],
      };
    });
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    const shares = latest.filter((catalog) => catalog.deviceId.startsWith('share:'));
    expect(shares.map((catalog) => catalog.name)).toEqual(['来自 Magi 的分享', '来自 Magi 的分享 (2)']);
    expect(JSON.stringify(shares)).not.toMatch(/Mac Mini|Laptop/);
  });

  it('treats an older controlled Desktop as having no shares without hiding other computers', async () => {
    link.invoke.mockImplementation(async (deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [provider('studio-provider', 'Studio Provider')] };
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] blocked'), { code: 'CHANNEL_NOT_ALLOWED' });
    });
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(latest.map((catalog) => catalog.deviceId)).toEqual(['studio']);
  });

  it('reads shares for the model pill only when the task’s Agent is on a share', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: ['studio'], keepOnly: true });
    expect(link.invoke).not.toHaveBeenCalledWith('controlled', PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, expect.anything());
    expect(latest.map((catalog) => catalog.deviceId)).toEqual(['studio']);

    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: ['share:share-1'], keepOnly: true });
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');
  });

  it('marks a computer offline as soon as its live presence drops while the picker is open', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(latest.find((catalog) => catalog.deviceId === 'studio')?.offline).toBeUndefined();
    link.getPresenceAvailability.mockImplementation((deviceId) => (deviceId === 'studio' ? false : null));
    link.presenceVersion = 2;
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(latest.find((catalog) => catalog.deviceId === 'studio')?.offline).toBe(true);
  });

  it('shows the cached shares right away on the next open', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    await act(async () => root.unmount());
    root = createRoot(host);
    link.invoke.mockImplementation(() => new Promise(() => undefined));
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');
  });

  it('does not mark a kept missing share unavailable while the controlled list is partial', async () => {
    link.invoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [] };
      return { ready: false, shares: [] };
    });
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: ['share:missing'] });
    expect(latest.map((catalog) => catalog.deviceId)).not.toContain('share:missing');

    await act(async () => root.unmount());
    root = createRoot(host);
    link.invoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [] };
      return { ready: true, shares: [] };
    });
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: ['share:missing'] });
    expect(latest.find((catalog) => catalog.deviceId === 'share:missing')?.status).toBe('error');
  });
});

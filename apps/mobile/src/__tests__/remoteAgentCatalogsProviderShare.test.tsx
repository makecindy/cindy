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
  status: 'online' as const,
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
  it('lists the controlled computer’s received shares after same-account computers', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(link.invoke).toHaveBeenCalledWith(
      'controlled',
      PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
      [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }],
    );
    expect(latest.map((catalog) => [catalog.deviceId, catalog.name, catalog.providers.map((p) => p.id)])).toEqual([
      ['studio', 'Studio Mac', ['studio-provider']],
      ['share:share-1', "Magi's Mac Mini · 来自 Magi 的分享", ['anthropic']],
    ]);
    // 模型列表分组标题 = 「{供应商} · {电脑名}」,即产品规则 §5.1 的写法。
    expect(i18n.t('models.unified.remoteProvider', { provider: 'Anthropic', device: latest[1].name }))
      .toBe("Anthropic · Magi's Mac Mini · 来自 Magi 的分享");
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

  it('shows the cached shares right away on the next open', async () => {
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    await act(async () => root.unmount());
    root = createRoot(host);
    link.invoke.mockImplementation(() => new Promise(() => undefined));
    await render({ enabled: true, controlledDeviceId: 'controlled', keepDeviceIds: [] });
    expect(latest.map((catalog) => catalog.deviceId)).toContain('share:share-1');
  });
});

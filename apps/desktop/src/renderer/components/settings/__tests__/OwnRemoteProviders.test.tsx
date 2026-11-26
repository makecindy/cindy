// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OwnRemoteProviderDetail,
  OwnRemoteProviderRows,
  ownRemoteProviderKey,
  useOwnRemoteProviderList,
  useOwnRemoteProviders,
  type OwnRemoteProvider,
} from '../OwnRemoteProviders';
import {
  OwnRemotePluginEngineDetail,
  OwnRemotePluginEngineRows,
  useOwnRemotePluginEngines,
} from '../OwnRemotePluginEngines';
import { useOwnedProviderShares } from '@/features/provider-share/useOwnedProviderShares';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  DEVICE_PLUGIN_ENGINES_REREAD_MS,
  hasRemotePluginEngineSubscribers,
  prefetchRemotePluginEngines,
  resetPluginEnginesStoreForTests,
} from '@/hooks/usePluginEngines';
import { useControllableDevices } from '@/hooks/useControllableDevices';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
const devices = vi.hoisted(() => ({ value: [] as Array<{ deviceId: string; name: string; platform: string | null }> }));
vi.mock('@/hooks/useControllableDevices', () => ({ useControllableDevices: () => devices.value }));
const catalogs = vi.hoisted(() => ({ value: new Map<string, unknown>() }));
const requestedIds = vi.hoisted(() => [] as string[][]);
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (ids: readonly string[]) => {
    requestedIds.push([...ids]);
    return catalogs.value;
  },
}));

const usage = vi.hoisted(() => ({
  localClaude: vi.fn(),
  remoteClaude: vi.fn(),
}));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: usage.localClaude }));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({ useRemoteClaudeSubscriptionUsage: usage.remoteClaude }));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: () => ({ snapshot: null }) }));
vi.mock('@/hooks/useAccountUsage', () => ({ useAccountUsage: () => null }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: () => null,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteCodexRefreshState: () => ({ failed: false, refreshing: false }),
  requestRemoteCodexLiveRefresh: vi.fn(),
  useRemoteCodexRateLimits: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
  selectRemoteCodexAccountUsage: () => null,
}));
vi.mock('@/features/provider-group/RemoteProviderGroupMembers', () => ({
  RemoteProviderGroupMembers: () => <div>Group members</div>,
}));

function provider(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 'anthropic' ? 'Anthropic' : 'OpenAI',
    agents: ['claude-code'],
    connected: true,
    remoteInvocationEnabled: true,
    routing: {},
    auth: { method: 'api-key' },
    models: { 'claude-code': [{ id: 'opus', name: 'Opus 5.5' }, { id: 'hidden', name: 'Hidden' }] },
    ...overrides,
  };
}

beforeEach(() => {
  devices.value = [];
  catalogs.value = new Map();
  requestedIds.length = 0;
  usage.localClaude.mockReset().mockImplementation((enabled: boolean) => enabled ? {
    fiveHour: { utilization: 10, resetsAt: null },
    updatedAt: Date.now(),
  } : null);
  usage.remoteClaude.mockReset().mockImplementation((deviceId: string | null) => deviceId === 'mini-a' ? {
    fiveHour: { utilization: 37, resetsAt: null },
    updatedAt: Date.now(),
  } : null);
});

afterEach(() => cleanup());

// Test value: settings used to mix shared-out providers with ordinary groups. Exercise the real
// classification hook through local/manage-share summaries; existing row tests have no sharing state.
// Minimal input: two host summaries, a late old-account response, hidden events and an old host.
// Tier: unit; in-memory responses and fake timers, with no network or real waiting.
describe('useOwnedProviderShares', () => {
  let originalApi: Window['electronAPI'];
  let changed: () => void;
  const classified = (...providerIds: string[]) => ({ ready: true, providerIds });
  const local = vi.fn();
  const remote = vi.fn();

  beforeEach(() => {
    originalApi = window.electronAPI;
    setDataOwnerGeneration('owner-1', 1);
    local.mockReset().mockResolvedValue(classified('anthropic'));
    remote.mockReset().mockResolvedValue(classified('openai'));
    window.electronAPI = {
      ...originalApi,
      providerShare: { command: local, onOwnedChanged: (listener: () => void) => {
        changed = listener;
        return () => undefined;
      } },
      providerGroup: { command: remote },
    } as unknown as Window['electronAPI'];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.electronAPI = originalApi;
    setDataOwnerGeneration(null, 0);
  });

  it('keeps each computer’s classification separate and updates only the changed host', async () => {
    const { result } = renderHook(() => useOwnedProviderShares(['mini-a', 'mini-a']));
    await waitFor(() => expect(result.current.size).toBe(2));
    expect([...result.current.get(null)!]).toEqual(['anthropic']);
    expect([...result.current.get('mini-a')!]).toEqual(['openai']);
    expect(remote).toHaveBeenCalledExactlyOnceWith({
      action: 'remote-manage', deviceId: 'mini-a',
      request: { action: 'manage-share', command: { action: 'shared-provider-ids' } },
    });

    local.mockResolvedValue(classified());
    await act(async () => changed());
    expect([...result.current.get(null)!]).toEqual([]);
    expect([...result.current.get('mini-a')!]).toEqual(['openai']);
  });

  it('retains a known classification on read failure and rejects an old account’s late response', async () => {
    const { result, rerender } = renderHook(() => useOwnedProviderShares([]));
    await waitFor(() => expect(result.current.get(null)?.has('anthropic')).toBe(true));
    local.mockRejectedValueOnce(new Error('offline'));
    await act(async () => changed());
    expect(result.current.get(null)?.has('anthropic')).toBe(true);

    let finish!: (value: unknown) => void;
    local.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => changed());
    local.mockResolvedValue({ ready: true, providerIds: [] });
    setDataOwnerGeneration('owner-2', 2);
    rerender();
    expect(result.current.size).toBe(0);
    await act(async () => finish(classified('anthropic')));
    await waitFor(() => expect(result.current.has(null)).toBe(true));
    expect([...result.current.get(null)!]).toEqual([]);
  });

  // Greptile discussion_r4408622288: OWNED_CHANGED previously kept querying while hidden.
  it('pauses event and timer reads while hidden, then refreshes the visible classification', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { result } = renderHook(() => useOwnedProviderShares(['mini-a']));
    await act(async () => undefined);
    expect(result.current.get(null)?.has('anthropic')).toBe(true);
    local.mockClear().mockResolvedValue(classified());
    remote.mockClear();
    visibility.mockReturnValue('hidden');
    await act(async () => {
      changed();
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(local).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect([...result.current.get(null)!]).toEqual([]);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('classifies an old computer without renewing its 60-second fast-poll window every 30 seconds', async () => {
    vi.useFakeTimers();
    remote.mockRejectedValueOnce(new Error('[UNSUPPORTED_CAPABILITY] Update the computer'))
      .mockResolvedValue({ ready: true, shares: [{ providerId: 'openai', members: [{ status: 'paused' }] }] });
    const { result } = renderHook(() => useOwnedProviderShares(['mini-a']));
    await act(async () => undefined);
    expect(result.current.get('mini-a')?.has('openai')).toBe(true);
    expect(remote).toHaveBeenCalledTimes(2);
    remote.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(89_999));
    expect(remote).not.toHaveBeenCalled();
    remote.mockResolvedValue({ ready: true, shares: [] });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(remote).toHaveBeenCalledExactlyOnceWith({
      action: 'remote-manage', deviceId: 'mini-a',
      request: { action: 'manage-share', command: { action: 'owned', range: 'month' } },
    });
    expect([...result.current.get('mini-a')!]).toEqual([]);
  });
});

describe('useOwnRemoteProviders', () => {
  it.each([
    [true, false, 0],
    [true, true, 1],
    [false, true, 0],
  ])('xAI connected=%s remoteInvocationEnabled=%s yields %s rows', (connected, remoteInvocationEnabled, count) => {
    devices.value = [{ deviceId: 'mini-a', name: 'Mac', platform: 'darwin' }];
    catalogs.value = new Map([['mini-a', {
      providers: [provider('xai-account', { name: 'xAI', connected, remoteInvocationEnabled })],
      loading: false, error: null,
    }]]);
    const { result } = renderHook(() => useOwnRemoteProviders());
    expect(result.current).toHaveLength(count);
  });

  it('lists the connected providers my online computers open for remote use', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    catalogs.value = new Map([
      ['mini-a', {
        providers: [
          provider('anthropic'),
          provider('openai', { remoteInvocationEnabled: false }),
          provider('xai', { connected: false }),
          provider('xd', { suspended: true }),
        ],
        modelVisibilityOverrides: { 'claude-code:anthropic:hidden': false },
        loading: false,
        error: null,
      }],
      ['mini-b', { providers: [], loading: true, error: null }],
    ]);
    const { result } = renderHook(() => useOwnRemoteProviders());
    expect(requestedIds.at(-1)).toEqual(['mini-a', 'mini-b']);
    expect(result.current.map((entry) => [entry.deviceName, entry.provider.id])).toEqual([
      ["Magi's Mac Mini", 'anthropic'],
    ]);
    expect(result.current[0].key).toBe(ownRemoteProviderKey('mini-a', 'anthropic'));
  });

  it('shows only the group when another computer put providers and shares in a provider group', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    catalogs.value = new Map([
      ['mini-a', {
        providers: [provider('anthropic', {
          group: {
            strategy: 'least',
            members: [
              { kind: 'local' },
              { kind: 'device', agentDeviceId: 'mini-b', providerId: 'anthropic' },
              { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' },
            ],
          },
        })],
        loading: false,
        error: null,
      }],
      ['mini-b', { providers: [provider('anthropic'), provider('openai')], loading: false, error: null }],
    ]);
    const { result } = renderHook(() => useOwnRemoteProviderList());
    expect(result.current.entries.map((entry) => [entry.deviceId, entry.provider.id, entry.group?.members.length ?? 0])).toEqual([
      ['mini-a', 'anthropic', 3],
      ['mini-b', 'openai', 0],
    ]);
    expect([...result.current.hiddenShareIds]).toEqual(['s1']);
  });

  it('keeps the group listed when the group computer’s provider is logged out, paused, or closed to remote invocation', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    const group = {
      strategy: 'least',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini-b', providerId: 'anthropic' }],
    };
    for (const state of [{ connected: false }, { suspended: true }, { remoteInvocationEnabled: false }]) {
      catalogs.value = new Map([
        ['mini-a', { providers: [provider('anthropic', { ...state, group })], loading: false, error: null }],
        ['mini-b', { providers: [provider('anthropic')], loading: false, error: null }],
      ]);
      const { result, unmount } = renderHook(() => useOwnRemoteProviderList());
      expect(result.current.entries.map((entry) => [entry.deviceId, entry.provider.id, entry.group?.members.length ?? 0])).toEqual([
        ['mini-a', 'anthropic', 2],
      ]);
      unmount();
    }
  });

  // Settings list regression: existing group tests only cover explicit group members. A merged
  // Claude entry can still be in the host catalog alongside its Anthropic pool. Unit, in memory.
  it('hides merged entries unless the host still shares them or they represent a group', async () => {
    devices.value = [{ deviceId: 'mini-a', name: 'Mac Mini', platform: 'darwin' }];
    const group = { strategy: 'least', members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini-b', providerId: 'anthropic' }] };
    const alias = (id: string, overrides: Record<string, unknown> = {}) => provider(id, {
      name: 'Claude · account', subscriptionPoolAlias: true, subscriptionPoolTarget: 'anthropic', ...overrides,
    });
    catalogs.value = new Map([['mini-a', {
      providers: [provider('anthropic', { group }), alias('merged'), alias('shared'), alias('grouped', { group })],
      loading: false,
      error: null,
    }]]);
    const originalApi = window.electronAPI;
    window.electronAPI = {
      ...originalApi,
      providerShare: { command: vi.fn().mockResolvedValue({ ready: true, providerIds: ['merged'] }) },
      providerGroup: {
        command: vi.fn(async ({ action }: { action: string }) =>
          action === 'list' ? {} : { ready: true, providerIds: ['shared'] }),
      },
    } as unknown as Window['electronAPI'];
    try {
      const { result } = renderHook(() => useOwnRemoteProviderList());
      await act(async () => undefined);
      expect(result.current.entries.map((entry) => entry.provider.id)).toEqual(['anthropic', 'shared', 'grouped']);
    } finally {
      cleanup();
      window.electronAPI = originalApi;
    }
  });
});

describe('OwnRemoteProviderRows / OwnRemoteProviderDetail', () => {
  const entry: OwnRemoteProvider = {
    key: ownRemoteProviderKey('mini-a', 'anthropic'),
    deviceId: 'mini-a',
    deviceName: "Magi's Mac Mini",
    provider: provider('anthropic') as unknown as OwnRemoteProvider['provider'],
    modelVisibilityOverrides: { 'claude-code:anthropic:hidden': false },
  };

  it('renders nothing without remote providers', () => {
    const { container } = render(<OwnRemoteProviderRows entries={[]} selectedKey={null} onSelect={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('marks the row as remote, names the computer only in the tip and selects it', () => {
    const onSelect = vi.fn();
    render(<OwnRemoteProviderRows entries={[entry]} selectedKey={null} onSelect={onSelect} />);
    const row = screen.getByTestId('own-remote-provider-row');
    expect(row.textContent).toContain('Anthropic');
    expect(row.textContent).not.toContain("Magi's Mac Mini");
    expect(row.getAttribute('aria-label')).toContain("Magi's Mac Mini");
    expect(row.textContent).toContain('settings.providers.models.modelCount:{"count":1}');
    expect(row.querySelector('[data-remote-source-mark]')).not.toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(entry.key);
  });

  // PR #9941 review, unit: a same-account computer's enterprise provider arrives as an opaque
  // byok-<uuid> with display-only routing; the host-supplied logoKind must still win over a monogram.
  it('renders the host-supplied enterprise artwork for a remote organization provider', () => {
    const enterprise: OwnRemoteProvider = {
      ...entry,
      key: ownRemoteProviderKey('mini-a', 'byok-1b2c3d4e'),
      provider: provider('byok-1b2c3d4e', {
        name: 'openai-codex', source: 'organization', logoKind: 'openai-spectrum',
      }) as unknown as OwnRemoteProvider['provider'],
    };
    const rows = (entry: OwnRemoteProvider) => (
      <OwnRemoteProviderRows entries={[entry]} selectedKey={null} onSelect={() => undefined} />
    );
    const view = render(rows(enterprise));
    const mark = screen.getByTestId('own-remote-provider-row').querySelector('[data-remote-source-mark]')!;
    const gradient = mark.querySelector('linearGradient');
    expect(gradient).not.toBeNull();
    expect(mark.querySelector('path[fill^="url"]')?.getAttribute('fill')).toBe(`url(#${gradient!.id})`);
    view.rerender(rows({ ...enterprise, provider: { ...enterprise.provider, customIcon: '<svg/>' } }));
    const image = screen.getByTestId('own-remote-provider-row').querySelector('[data-remote-source-mark] img')!;
    expect(image.getAttribute('src')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
    fireEvent.error(image);
    expect(screen.getByTestId('own-remote-provider-row').querySelector('linearGradient')).toBeTruthy();
  });

  it('uses the existing disabled state and removes model and quota content until re-enabled', () => {
    const stopped = { ...entry, provider: { ...entry.provider, suspended: true } };
    render(<><OwnRemoteProviderRows entries={[stopped]} selectedKey={stopped.key} onSelect={() => undefined} /><OwnRemoteProviderDetail entry={stopped} /></>);
    expect(screen.getByTestId('own-remote-provider-row').textContent).toContain('settings.providers.pill.suspended');
    expect(screen.getByText('settings.providers.detail.suspendedBanner')).toBeTruthy();
    expect(screen.queryByTestId('own-remote-provider-models')).toBeNull();
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
  });

  it('shows the models that computer leaves visible, read-only', () => {
    render(<OwnRemoteProviderDetail entry={entry} />);
    const list = screen.getByTestId('own-remote-provider-models');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['Opus 5.5opus']);
    expect(within(list).queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.providers.detail.moreActionsAria' })).toBeTruthy();
  });

  // 测试价值：通过真实详情、订阅 hook 与额度卡验证 provider-sharing.md §5.2 的只读远程额度。
  // 现有测试只覆盖模型列表，hook 测试不能发现详情漏接额度；最小输入是一台电脑上的 OAuth 连接。
  // tier: unit，隔离底层用量读取，不依赖网络；切换到无快照的电脑还应移除上一台的额度。
  // 单独运行本文件：3.62s 墙钟（Vitest 2.43s，2026-10-22）。
  it('shows the selected computer’s subscription quota without management actions and clears it on switching', () => {
    const subscription = {
      ...entry,
      provider: { ...entry.provider, auth: { method: 'oauth' as const, native: 'claude' as const } },
    };
    const { rerender } = render(<OwnRemoteProviderDetail entry={subscription} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('quotaCard.remainingPercent:{"percent":63}');
    expect(usage.remoteClaude).toHaveBeenCalledWith('mini-a', 'anthropic', { live: false });
    expect(usage.localClaude.mock.calls.every(([enabled]) => !enabled)).toBe(true);
    expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: 'settings.providers.detail.moreActionsAria' })]);
    expect(screen.queryByRole('link')).toBeNull();

    rerender(<OwnRemoteProviderDetail entry={{ ...subscription, key: ownRemoteProviderKey('mini-b', 'anthropic'), deviceId: 'mini-b' }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
    expect(usage.remoteClaude).toHaveBeenLastCalledWith('mini-b', 'anthropic', { live: false });
  });

  it.each(['api-key', 'group'] as const)('does not read or show a top-level subscription quota for %s', (kind) => {
    render(<OwnRemoteProviderDetail entry={kind === 'api-key' ? entry : {
      ...entry,
      provider: { ...entry.provider, auth: { method: 'oauth', native: 'claude' } },
      group: {
        strategy: 'least', autoSwitch: true,
        members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
      },
    }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
    expect(usage.remoteClaude.mock.calls.every(([deviceId]) => deviceId === null)).toBe(true);
    if (kind === 'group') expect(screen.getByText('Group members')).toBeTruthy();
  });

  it('does not show an empty quota card when the remote account has no usage windows', () => {
    usage.remoteClaude.mockReturnValue({ subscriptionType: 'max', updatedAt: Date.now() });
    render(<OwnRemoteProviderDetail entry={{
      ...entry,
      provider: { ...entry.provider, auth: { method: 'oauth', native: 'claude' } },
    }} />);
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
    expect(screen.queryByText('quotaCard.noWindows')).toBeNull();
  });

  // Test value: OwnRemoteProviderDetail previously called only the default-account quota reader and
  // dropped additional accounts in a remote computer's subscription pool. Exercise the real detail,
  // useGroupMemberAccounts, and QuotaHoverCard together; existing tests only stub the legacy single card.
  // Minimal input: two accounts in one remote pool, a split pool push, an old-host rejection, and an all-paused pool.
  // Tier: unit; in-memory deviceLink mocks without network or real waiting.
  describe('remote subscription account pools', () => {
    let originalApi: Window['electronAPI'];
    const invoke = vi.fn();
    let pushListeners: Set<(push: { deviceId: string; channel: string; payload?: unknown }, stamp?: unknown) => void>;

    const poolAccount = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      paused: false,
      limit: 4,
      weight: 1,
      directory: `/remote/${id}`,
      status: 'ready' as const,
      running: 0,
      ...overrides,
    });

    const claudeUsage = (fiveHour: number, sevenDay: number, extra: Record<string, unknown> = {}) => ({
      claude: {
        source: 'oauth-endpoint' as const,
        updatedAt: Date.now(),
        fiveHour: { utilization: fiveHour, resetsAt: null },
        sevenDay: { utilization: sevenDay, resetsAt: null },
        ...extra,
      },
    });

    beforeEach(() => {
      originalApi = window.electronAPI;
      setDataOwnerGeneration('owner-1', 1);
      invoke.mockReset();
      pushListeners = new Set();
      window.electronAPI = {
        ...originalApi,
        deviceLink: {
          invoke,
          onRemotePush: (listener: (push: { deviceId: string; channel: string; payload?: unknown }, stamp?: unknown) => void) => {
            pushListeners.add(listener);
            return () => pushListeners.delete(listener);
          },
          onPresenceChanged: () => () => undefined,
          onStatusChanged: () => () => undefined,
        },
      } as unknown as Window['electronAPI'];
    });

    afterEach(() => {
      cleanup();
      window.electronAPI = originalApi;
      setDataOwnerGeneration(null, 0);
    });

    it('lists every active subscription account on the remote computer, read-only, and clears on switching', async () => {
      invoke.mockImplementation(async (deviceId: string) => deviceId === 'mini-a'
        ? {
            providerId: 'anthropic',
            configured: true,
            strategy: 'least',
            accounts: [
              poolAccount('default', {
                identity: 'first@example.com',
                plan: 'pro',
                usage: claudeUsage(0, 13),
              }),
              poolAccount('work', {
                identity: 'second@example.com',
                plan: 'max',
                planTier: 'max_5x',
                usage: claudeUsage(15, 2),
              }),
              poolAccount('paused-acc', {
                identity: 'paused@example.com',
                paused: true,
                usage: claudeUsage(50, 50),
              }),
            ],
          }
        : { providerId: 'anthropic', configured: true, strategy: 'least', accounts: [] });

      const subscription: OwnRemoteProvider = {
        ...entry,
        provider: { ...entry.provider, auth: { method: 'oauth' as const, native: 'claude' as const } },
      };
      const { rerender } = render(<OwnRemoteProviderDetail entry={subscription} />);

      await waitFor(() => expect(screen.getAllByTestId('own-remote-provider-account')).toHaveLength(2));
      expect(invoke).toHaveBeenCalledWith('mini-a', 'maker:subscription-accounts', [{ action: 'read', providerId: 'anthropic' }]);
      expect(usage.remoteClaude.mock.calls.every(([deviceId]) => deviceId === null)).toBe(true);
      const rows = screen.getAllByTestId('own-remote-provider-account');
      expect(rows[0].textContent).toContain('first@example.com');
      expect(within(rows[0]).getByTestId('quota-plan-badge').textContent).toBe('Pro');
      expect(rows[1].textContent).toContain('second@example.com');
      expect(within(rows[1]).getByTestId('quota-plan-badge').textContent).toBe('Max 5×');
      expect(screen.queryByText('paused@example.com')).toBeNull();
      expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: 'settings.providers.detail.moreActionsAria' })]);
      expect(screen.queryByRole('link')).toBeNull();

      // All-paused / empty pool on another computer clears accounts without falling back to the legacy card.
      rerender(<OwnRemoteProviderDetail entry={{ ...subscription, key: ownRemoteProviderKey('mini-b', 'anthropic'), deviceId: 'mini-b' }} />);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('mini-b', 'maker:subscription-accounts', [{ action: 'read', providerId: 'anthropic' }]));
      expect(screen.queryByTestId('provider-usage-module')).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('reads a split remote subscription pool and refreshes on its pool-kind change push', async () => {
      invoke.mockResolvedValueOnce({
        providerId: 'claude-work',
        kind: 'anthropic',
        configured: true,
        strategy: 'least',
        accounts: [
          poolAccount('acc-1', { identity: 'one@example.com', plan: 'pro', usage: claudeUsage(20, 40) }),
          poolAccount('acc-2', { identity: 'two@example.com', status: 'signed-out' }),
        ],
      }).mockResolvedValueOnce({
        providerId: 'claude-work',
        kind: 'anthropic',
        configured: true,
        strategy: 'least',
        accounts: [
          poolAccount('acc-1', { identity: 'one@example.com', plan: 'pro', usage: claudeUsage(20, 40) }),
          poolAccount('acc-2', { identity: 'two@example.com', plan: 'pro', usage: claudeUsage(10, 30) }),
        ],
      });

      const split: OwnRemoteProvider = {
        ...entry,
        key: ownRemoteProviderKey('mini-a', 'claude-work'),
        provider: provider('claude-work', {
          name: 'Claude Work',
          auth: { method: 'oauth', native: 'claude' },
          subscriptionAccountPool: 'anthropic',
        }) as unknown as OwnRemoteProvider['provider'],
      };
      render(<OwnRemoteProviderDetail entry={split} />);

      await waitFor(() => expect(screen.getAllByTestId('own-remote-provider-account')).toHaveLength(2));
      expect(invoke).toHaveBeenCalledWith('mini-a', 'maker:subscription-accounts', [{ action: 'read', providerId: 'claude-work' }]);
      expect(screen.getAllByTestId('own-remote-provider-account')[1].textContent).toContain('subscriptionAccounts.signedOut');

      await act(async () => {
        pushListeners.forEach((listener) =>
          listener({ deviceId: 'mini-a', channel: 'subscription-accounts:changed', payload: { providerId: 'anthropic' } }),
        );
      });
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      expect(screen.getAllByTestId('own-remote-provider-account')[1].textContent).not.toContain('subscriptionAccounts.signedOut');
      expect(within(screen.getAllByTestId('own-remote-provider-account')[1]).getAllByRole('progressbar').length).toBe(2);
    });

    it('falls back to the single-account card on older hosts and skips pool reads for api-key or group entries', async () => {
      invoke.mockRejectedValueOnce(new Error('CHANNEL_NOT_ALLOWED'));
      const subscription: OwnRemoteProvider = {
        ...entry,
        provider: { ...entry.provider, auth: { method: 'oauth' as const, native: 'claude' as const } },
      };
      const { rerender } = render(<OwnRemoteProviderDetail entry={subscription} />);

      await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('quotaCard.remainingPercent:{"percent":63}'));
      expect(invoke).toHaveBeenCalledTimes(1);

      invoke.mockClear();
      rerender(<OwnRemoteProviderDetail entry={entry} />);
      expect(invoke).not.toHaveBeenCalled();
      expect(screen.queryByTestId('provider-usage-module')).toBeNull();
    });
  });
});

// 测试价值：「设置 → 模型供应商」此前只列本机插件引擎和其他电脑的普通供应商，同账号另一台电脑开放的
// 插件引擎在新建任务的模型列表里能选，在设置页却看不到。
// 生产入口：真实 useOwnRemotePluginEngines + 按电脑的引擎目录缓存 + 行与详情，只替换在线电脑列表和
// Device Link invoke。最小失败输入：一台在线电脑回一个已开放的引擎和一个未开放的引擎。
// 第二条守住读取次数：在线电脑列表变化时只读新出现的电脑，不把已读过的电脑再读一遍。
// 用量(2026-11-23 用户反馈：详情看不到那台电脑的用量，而 provider-sharing.md 2026-10-22 裁决要求只读显示)：
// 最小失败输入是那台电脑回一个 reportsUsage 的引擎、用量读取回一个窗口；修复前详情没有用量块、也不读。
// 不上报用量的引擎不读，由第一条守住。
// tier: unit(jsdom，内存 invoke，不联网)。
describe('plugin engines my other computers open for remote use', () => {
  const invoke = vi.fn();
  let originalApi: Window['electronAPI'];
  const listCalls = () => invoke.mock.calls
    .filter(([, channel]) => channel === 'maker:list-plugin-engines')
    .map(([deviceId]) => deviceId as string);
  const usageCalls = () => invoke.mock.calls.filter(([, channel]) => channel === 'maker:get-plugin-engine-usage');

  function engine(harnessId: string, overrides: Record<string, unknown> = {}) {
    return {
      key: `agy:${harnessId}`,
      providerId: `acp-plugin:agy:${harnessId}`,
      ghostId: 'agy',
      harnessId,
      name: harnessId === 'antigravity' ? 'Antigravity' : 'Closed engine',
      availability: { state: 'available' },
      models: [{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' }],
      permissionModes: [],
      defaultPermissionMode: 'ask',
      remoteUse: { supported: true, enabled: true },
      ...overrides,
    };
  }

  function Page({ active = true }: { active?: boolean }) {
    // 与设置页相同：电脑列表来自 useOwnRemoteProviderList 用的那份(这里由文件顶部的 mock 提供)。
    const entries = useOwnRemotePluginEngines(useControllableDevices(), active);
    const [selected, setSelected] = useState<string | null>(null);
    const entry = entries.find((item) => item.key === selected);
    return (
      <>
        <OwnRemotePluginEngineRows entries={entries} selectedKey={selected} onSelect={setSelected} />
        {entry ? <OwnRemotePluginEngineDetail entry={entry} /> : null}
      </>
    );
  }

  beforeEach(() => {
    originalApi = window.electronAPI;
    setDataOwnerGeneration('owner-1', 1);
    resetPluginEnginesStoreForTests();
    invoke.mockReset();
    window.electronAPI = { ...originalApi, deviceLink: { invoke } } as unknown as Window['electronAPI'];
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.electronAPI = originalApi;
    resetPluginEnginesStoreForTests();
    setDataOwnerGeneration(null, 0);
  });

  it('lists the engine another computer opened and shows where it runs and its models', async () => {
    devices.value = [{ deviceId: 'studio-desktop', name: 'Studio Desktop', platform: 'darwin' }];
    invoke.mockImplementation(async (_deviceId: string, channel: string) => channel === 'maker:list-plugin-engines'
      ? [engine('antigravity'), engine('closed', { remoteUse: { supported: true, enabled: false } })]
      : undefined);
    render(<Page />);

    const row = await screen.findByTestId('own-remote-plugin-engine-row');
    expect(screen.getAllByTestId('own-remote-plugin-engine-row')).toHaveLength(1);
    expect(row.getAttribute('aria-label')).toBe(
      'settings.providers.remote.rowLabel:{"provider":"Antigravity","device":"Studio Desktop"}',
    );
    fireEvent.click(row);
    const detail = screen.getByTestId('own-remote-plugin-engine-detail');
    expect(within(detail).getByText('Studio Desktop')).toBeTruthy();
    expect(within(detail).getByText('Gemini 3 Pro')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'settings.providers.detail.moreActionsAria' })).toBeNull();
    expect(listCalls()).toEqual(['studio-desktop']);
    // This engine does not report usage: no read and no empty usage block.
    await act(async () => { await Promise.resolve(); });
    expect(usageCalls()).toEqual([]);
    expect(within(detail).queryByTestId('provider-usage-module')).toBeNull();
  });

  it('shows that computer’s account usage when its engine reports it', async () => {
    devices.value = [{ deviceId: 'studio-desktop', name: 'Studio Desktop', platform: 'darwin' }];
    const usage = { updatedAt: Date.now(), windows: [{ label: 'Weekly requests', remainingPercent: 64 }] };
    invoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:list-plugin-engines') return [engine('antigravity', { reportsUsage: true })];
      return channel === 'maker:get-plugin-engine-usage' ? usage : undefined;
    });
    render(<Page />);

    fireEvent.click(await screen.findByTestId('own-remote-plugin-engine-row'));
    const detail = screen.getByTestId('own-remote-plugin-engine-detail');
    expect(within(await within(detail).findByTestId('provider-usage-module')).getByText('Weekly requests')).toBeTruthy();
    expect(usageCalls()).toEqual([['studio-desktop', 'maker:get-plugin-engine-usage', ['agy:antigravity']]]);
  });

  it('reads only a computer that comes online while the page stays open', async () => {
    // 时钟照常走，只在电脑列表变化前跳过 15 秒的复读间隔，证明不是靠这个间隔才没有重读。
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped);
    invoke.mockResolvedValue([]);
    const first = { deviceId: 'mini', name: 'Mini', platform: 'darwin' };
    devices.value = [first];
    const view = render(<Page />);
    await waitFor(() => expect(listCalls()).toEqual(['mini']));

    skipped += DEVICE_PLUGIN_ENGINES_REREAD_MS + 1;
    devices.value = [first, { deviceId: 'studio-desktop', name: 'Studio Desktop', platform: 'darwin' }];
    view.rerender(<Page />);
    await waitFor(() => expect(listCalls()).toEqual(['mini', 'studio-desktop']));
  });

  it('recovers an unread catalogue on reconnect and releases the subscription when hidden', async () => {
    const deviceId = 'studio-desktop';
    devices.value = [{ deviceId, name: 'Studio Desktop', platform: 'darwin' }];
    invoke.mockRejectedValueOnce(new Error('connection interrupted')).mockResolvedValue([engine('antigravity')]);
    const view = render(<Page />);
    await waitFor(() => expect(listCalls()).toEqual([deviceId]));
    expect(screen.queryByTestId('own-remote-plugin-engine-row')).toBeNull();

    await act(async () => {
      // The remote bootstrap only prefetches for a live subscriber.
      if (hasRemotePluginEngineSubscribers(deviceId)) await prefetchRemotePluginEngines(deviceId);
    });
    expect(await screen.findByTestId('own-remote-plugin-engine-row')).toBeTruthy();

    view.rerender(<Page active={false} />);
    expect(hasRemotePluginEngineSubscribers(deviceId)).toBe(false);
    expect(screen.queryByTestId('own-remote-plugin-engine-row')).toBeNull();
  });
});

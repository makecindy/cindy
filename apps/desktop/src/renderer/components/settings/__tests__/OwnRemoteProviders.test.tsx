// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OwnRemoteProviderDetail,
  OwnRemoteProviderRows,
  ownRemoteProviderKey,
  useOwnRemoteProviderList,
  useOwnRemoteProviders,
  type OwnRemoteProvider,
} from '../OwnRemoteProviders';

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

  it('shows the models that computer leaves visible, read-only', () => {
    render(<OwnRemoteProviderDetail entry={entry} />);
    const list = screen.getByTestId('own-remote-provider-models');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['Opus 5.5']);
    expect(screen.queryByRole('switch')).toBeNull();
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
    expect(usage.remoteClaude).toHaveBeenCalledWith('mini-a', 'anthropic');
    expect(usage.localClaude.mock.calls.every(([enabled]) => !enabled)).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    rerender(<OwnRemoteProviderDetail entry={{ ...subscription, key: ownRemoteProviderKey('mini-b', 'anthropic'), deviceId: 'mini-b' }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
    expect(usage.remoteClaude).toHaveBeenLastCalledWith('mini-b', 'anthropic');
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
});

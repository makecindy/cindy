// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderShareInsights } from '../../shared/providerShareInsights';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ProviderShareQuotaViewingContext, useProviderShareQuotaViewing } from '@/features/provider-share/useProviderShareWeeklyQuota';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

// Account generations are driven explicitly below; no full auth host is needed.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));

const sharing = vi.hoisted(() => ({ received: [] as ProviderShareReceived[] }));
vi.mock('@/features/provider-share/providerShareStore', () => ({
  useProviderShareReceived: () => ({ received: sharing.received, loaded: true }),
}));

const reads = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  remoteCodex: vi.fn(),
  remoteClaude: vi.fn(),
  remoteXai: vi.fn(),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: reads.codex }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: reads.claude }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: reads.xai }));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: reads.remoteCodex,
  useRemoteXaiSubscriptionUsage: reads.remoteXai,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: reads.remoteClaude,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { percent?: number; duration?: string }) =>
      key === 'quotaCard.remainingPercent'
        ? `剩余 ${args?.percent}%`
        : key === 'quotaCard.resetIn'
          ? `${args?.duration} 后重置`
          : key === 'quotaCard.weeklyLabel'
            ? '每周'
            : key === 'todaySpend.unit.hour'
              ? '小时'
              : key,
    i18n: { language: 'en' },
  }),
}));
import { UnifiedModelRail } from '@/components/new-chat/UnifiedModelRail';
import {
  codexWeeklyQuota,
  localCodexQuotaView,
  remoteCodexQuotaView,
  weeklyQuota,
  providerWeeklyQuotaSource,
} from '@/components/new-chat/useProviderWeeklyQuota';

const provider = (id: string, extra: Partial<ProviderView> = {}): ProviderView => ({
  id,
  name: id,
  source: 'builtin',
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'test' },
  connected: true,
  agents: [],
  routing: {},
  models: {},
  ...extra,
});
const snapshot = (used: number): MobileCodexRateLimitsResult => ({
  account: { email: null, accountId: null, planType: null },
  rateLimits: {
    primary: { usedPercent: 10, windowMinutes: 300 },
    secondary: { usedPercent: used, windowMinutes: 10080 },
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  resetOffer: null,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('provider weekly quota identity and windows', () => {
  it('selects only the weekly generic bucket, not the latest promotion or short window', () => {
    const data = snapshot(79);
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())?.usedPercent).toBe(79);
    data.rateLimitsByLimitId = {
      promo: { limitId: 'promo', secondary: { usedPercent: 0, windowMinutes: 10080 } },
      codex: data.rateLimits,
    };
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())?.usedPercent).toBe(79);
    delete data.rateLimitsByLimitId.codex;
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())).toBeNull();
    data.rateLimitsByLimitId = {};
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())).toBeNull();
    data.rateLimitsByLimitId = null;
    data.rateLimits.secondary!.windowMinutes = 1440;
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())).toBeNull();
    data.rateLimits.primary = { usedPercent: 32, windowMinutes: 10080 };
    expect(codexWeeklyQuota(localCodexQuotaView(data), Date.now())?.usedPercent).toBe(32);
  });
  it('reads the same weekly generic bucket from a remote account payload', () => {
    const weekly = (used: number) => ({ usedPercent: used, windowMinutes: 10080 });
    expect(codexWeeklyQuota(remoteCodexQuotaView(null), Date.now())).toBeNull();
    expect(
      codexWeeklyQuota(
        remoteCodexQuotaView({
          limitId: 'promo',
          secondary: weekly(1),
          webSnapshot: { source: 'openai-web', secondary: weekly(2) },
          appServerBuckets: {
            promo: { limitId: 'promo', secondary: weekly(1) },
            codex: { limitId: 'codex', secondary: weekly(44) },
          },
        }),
        Date.now(),
      )?.usedPercent,
    ).toBe(44);
    // Older hosts only send the top-level compatibility snapshot.
    expect(
      codexWeeklyQuota(
        remoteCodexQuotaView({ limitId: 'codex', secondary: weekly(12), webSnapshot: null }),
        Date.now(),
      )?.usedPercent,
    ).toBe(12);
    expect(
      codexWeeklyQuota(
        remoteCodexQuotaView({ limitId: 'promo', secondary: weekly(12), webSnapshot: null }),
        Date.now(),
      ),
    ).toBeNull();
  });
  it('does not turn missing, invalid or expired values into full quota', () => {
    for (const used of [null, undefined, NaN, Infinity, '20'])
      expect(weeklyQuota(used, null, 10000)).toBeNull();
    expect(weeklyQuota(0, 10, 10000)).toBeNull();
    expect(weeklyQuota(150, 11, 10000)?.usedPercent).toBe(100);
    expect(weeklyQuota(-10, 11, 10000)?.usedPercent).toBe(0);
  });
  it('scopes native account usage to eligible connections, never same-brand API duplicates', () => {
    expect(providerWeeklyQuotaSource(provider('openai'))).toBe('codex');
    expect(
      providerWeeklyQuotaSource(
        provider('account-b', { source: 'user', auth: { method: 'oauth', native: 'codex' } }),
      ),
    ).toBe('codex');
    expect(providerWeeklyQuotaSource(provider('anthropic'))).toBe('claude');
    expect(providerWeeklyQuotaSource(provider('xai'))).toBe('xai');
    for (const p of [
      provider('openai', { connected: false }),
      provider('openai', { suspended: true }),
      provider('openai', { auth: { method: 'apiKey' } }),
      provider('openai', { openAiAccount: { source: 'local', reconnectRequired: true } }),
      provider('custom-xai'),
      provider('custom-anthropic'),
    ])
      expect(providerWeeklyQuotaSource(p)).toBeNull();
  });
});

describe('provider rail weekly remaining bars', () => {
  it.each(['openai', 'anthropic', 'xai', 'independent'])(
    'shows %s account identity without quota and updates it with the directory',
    async (id) => {
      const account = { source: 'local' as const, identity: 'first@example.test' };
      const providers = [
        provider(
          id,
          id === 'openai' ? { openAiAccount: account } : { subscriptionAccount: account },
        ),
      ];
      const props = {
        items: [{ kind: 'provider' as const, providerId: id }],
        active: { kind: 'all' as const },
        providers,
        providerLabel: () => 'My provider',
        onSelect: () => {},
        providerUsage: null,
      };
      const { rerender } = render(<UnifiedModelRail {...props} />);
      const button = screen.getByRole('button', { name: 'My provider · first@example.test' });
      fireEvent.focus(button);
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        'My provider · first@example.test',
      );
      account.identity = 'second@example.test';
      rerender(<UnifiedModelRail {...props} />);
      expect(screen.queryByRole('button', { name: /first@example/ })).toBeNull();
      expect(
        screen.getByRole('button', { name: 'My provider · second@example.test' }),
      ).toBeTruthy();
      expect(reads.codex).not.toHaveBeenCalled();
      expect(reads.claude).not.toHaveBeenCalled();
      expect(reads.xai).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['OpenAI · user@example.test', 'user@example.test'],
    ['OpenAI · user@example.test (2)', 'user@example.test'],
    ['Anthropic · user@example.test', 'user@example.test'],
    ['xAI · user@example.test', 'user@example.test'],
    ['user@example.test', 'user@example.test'],
    [
      'OpenAI · very-long-account-name-for-display@example.test'.slice(0, 50),
      'very-long-account-name-for-display@example.test',
    ],
    [
      'OpenAI · very-long-account-name-for-display@example.test'.slice(0, 50) + ' (2)',
      'very-long-account-name-for-display@example.test',
    ],
  ])(
    'preserves existing account connection name %s without repeating identity',
    async (name, identity) => {
      render(
        <UnifiedModelRail
          items={[{ kind: 'provider', providerId: 'independent' }]}
          active={{ kind: 'all' }}
          providers={[
            provider('independent', { name, openAiAccount: { source: 'oauth', identity } }),
          ]}
          providerLabel={() => name}
          onSelect={() => {}}
        />,
      );
      fireEvent.focus(screen.getByRole('button', { name }));
      expect((await screen.findByRole('tooltip')).textContent).toBe(name);
    },
  );
  it('keeps two OpenAI accounts separate, preserves selection and updates remaining including zero', () => {
    let usedB = 79;
    reads.codex.mockImplementation((enabled, id) => ({
      snapshot: enabled ? snapshot(id === 'openai' ? 32 : usedB) : null,
    }));
    reads.claude.mockReturnValue(null);
    reads.xai.mockReturnValue(null);
    const providers = [
      provider('openai'),
      provider('second', { source: 'user', auth: { method: 'oauth', native: 'codex' } }),
    ];
    const onSelect = vi.fn();
    const props = {
      items: providers.map((p) => ({ kind: 'provider' as const, providerId: p.id })),
      active: { kind: 'all' as const },
      providers,
      providerLabel: (id: string) => `OpenAI ${id}`,
      onSelect,
      providerUsage: { deviceId: null },
    };
    const { container, rerender } = render(<UnifiedModelRail {...props} />);
    expect(
      [...container.querySelectorAll('[data-weekly-remaining]')].map((el) =>
        el.getAttribute('data-weekly-remaining'),
      ),
    ).toEqual(['68', '21']);
    const second = screen.getByRole('button', { name: 'OpenAI second' });
    expect(second.getAttribute('aria-description')).toContain('剩余 21%');
    fireEvent.click(second);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'provider', providerId: 'second' });
    usedB = 100;
    rerender(<UnifiedModelRail {...props} />);
    expect(second.querySelector('[data-weekly-remaining="0"] span')?.getAttribute('style')).toBe(
      'width: 0%;',
    );
    expect(reads.codex).toHaveBeenCalledWith(true, 'second');
  });
  it('uses Claude account weekly quota and hides expired xAI quota', () => {
    reads.codex.mockReturnValue({ snapshot: null });
    reads.claude.mockImplementation((enabled) =>
      enabled ? { fiveHour: { utilization: 95 }, sevenDay: { utilization: 40 } } : null,
    );
    let expired = false;
    reads.xai.mockImplementation((enabled) =>
      enabled
        ? {
            creditUsagePercent: 96,
            updatedAt: Date.now(),
            resetsAt: Date.now() / 1000 + (expired ? -1 : 100),
          }
        : null,
    );
    const providers = [provider('anthropic'), provider('xai')];
    const props = {
      items: providers.map((p) => ({ kind: 'provider' as const, providerId: p.id })),
      active: { kind: 'all' as const },
      providers,
      providerLabel: (id: string) => id,
      onSelect: () => {},
      providerUsage: { deviceId: null },
    };
    const { container, rerender } = render(<UnifiedModelRail {...props} />);
    expect(
      [...container.querySelectorAll('[data-weekly-remaining]')].map((el) =>
        el.getAttribute('data-weekly-remaining'),
      ),
    ).toEqual(['60', '4']);
    expired = true;
    rerender(<UnifiedModelRail {...props} />);
    expect(container.querySelectorAll('[data-weekly-remaining]')).toHaveLength(1);
  });
  it('reads remote directories from the device mirrors, never local quotas', () => {
    reads.codex.mockReturnValue({ snapshot: null });
    reads.remoteCodex.mockImplementation((deviceId, id) =>
      deviceId === 'device-1' && id === 'openai'
        ? {
            webSnapshot: null,
            appServerBuckets: {
              codex: { limitId: 'codex', secondary: { usedPercent: 25, windowMinutes: 10080 } },
            },
          }
        : null,
    );
    reads.remoteClaude.mockImplementation((deviceId) =>
      deviceId ? { sevenDay: { utilization: 70 } } : null,
    );
    reads.remoteXai.mockReturnValue(null);
    const providers = [provider('openai'), provider('anthropic'), provider('xai')];
    const { container } = render(
      <UnifiedModelRail
        items={providers.map((p) => ({ kind: 'provider' as const, providerId: p.id }))}
        active={{ kind: 'all' }}
        providers={providers}
        providerLabel={(id) => id}
        onSelect={() => {}}
        providerUsage={{ deviceId: 'device-1' }}
      />,
    );
    expect(
      [...container.querySelectorAll('[data-weekly-remaining]')].map((el) =>
        el.getAttribute('data-weekly-remaining'),
      ),
    ).toEqual(['75', '30']);
    expect(reads.remoteCodex).toHaveBeenCalledWith('device-1', 'openai');
    expect(reads.remoteClaude).toHaveBeenCalledWith('device-1', 'anthropic');
    expect(reads.remoteXai).toHaveBeenCalledWith('device-1', 'xai');
    for (const read of [reads.codex, reads.claude, reads.xai])
      expect(read.mock.calls.some(([enabled]) => enabled)).toBe(false);
  });
  it('shows no quota when the directory may not show account usage', () => {
    render(
      <UnifiedModelRail
        items={[{ kind: 'provider', providerId: 'openai' }]}
        active={{ kind: 'all' }}
        providers={[provider('openai')]}
        providerLabel={(id) => id}
        onSelect={() => {}}
        providerUsage={null}
      />,
    );
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.remoteCodex).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic', 'xai', 'account-b'])(
    'keeps %s quotas with the task host while browsing another device and switching hosts',
    (id) => {
      const usedOn = (deviceId: string | null) =>
        deviceId === 'host' ? 25 : deviceId === 'other' ? 80 : 10;
      const claude = (used: number) => ({ sevenDay: { utilization: used } });
      const xai = (used: number) => ({
        creditUsagePercent: used,
        updatedAt: Date.now(),
        resetsAt: Date.now() / 1000 + 3600,
      });
      reads.codex.mockImplementation((enabled) => ({ snapshot: enabled ? snapshot(10) : null }));
      reads.claude.mockImplementation((enabled) => (enabled ? claude(10) : null));
      reads.xai.mockImplementation((enabled) => (enabled ? xai(10) : null));
      reads.remoteCodex.mockImplementation((deviceId) =>
        deviceId ? { secondary: { usedPercent: usedOn(deviceId), windowMinutes: 10080 } } : null,
      );
      reads.remoteClaude.mockImplementation((deviceId) =>
        deviceId ? claude(usedOn(deviceId)) : null,
      );
      reads.remoteXai.mockImplementation((deviceId) => (deviceId ? xai(usedOn(deviceId)) : null));
      const providers = [
        provider(
          id,
          id === 'account-b' ? { source: 'user', auth: { method: 'oauth', native: 'codex' } } : {},
        ),
      ];
      const props = {
        items: [
          { kind: 'provider' as const, providerId: id },
          { kind: 'remote-provider' as const, deviceId: 'other', providerId: id },
        ],
        active: { kind: 'remote-provider' as const, deviceId: 'other', providerId: id },
        providers,
        providerLabel: () => 'Browsing other',
        providerUsage: { deviceId: 'other' },
        onSelect: vi.fn(),
        remoteSources: {
          localProviders: providers,
          localUsageDeviceId: 'host' as string | null,
          localProviderLabel: () => 'Task host',
          providersOf: () => providers,
          labelOf: () => 'Other device',
        },
      };
      const { rerender } = render(<UnifiedModelRail {...props} />);
      const remaining = (name: string) =>
        screen
          .getByRole('button', { name })
          .querySelector('[data-weekly-remaining]')
          ?.getAttribute('data-weekly-remaining');
      expect(remaining('Task host')).toBe('75');
      expect(remaining('Other device')).toBe('20');
      for (const read of [reads.codex, reads.claude, reads.xai])
        expect(read.mock.calls.some(([enabled]) => enabled)).toBe(false);

      rerender(
        <UnifiedModelRail
          {...props}
          remoteSources={{ ...props.remoteSources, localUsageDeviceId: null }}
        />,
      );
      expect(remaining('Task host')).toBe('90');
      expect(remaining('Other device')).toBe('20');
    },
  );
});

// 测试价值：通过真实 UnifiedModelRail 检查 §7.5（2026-10-22）的单账号条、只读请求与生命周期。
// 原覆盖只有本机/同账号镜像；最小输入为 share:shared 的格位 + 一个授权周窗口。
// unit：IPC 使用内存 fake，轮询用假时钟；不需要真实设备或历史账本。
describe('shared provider rail weekly quota', () => {
  const command = vi.fn();
  const listeners = new Set<(shares: ProviderShareReceived[]) => void>();
  const share: ProviderShareReceived = {
    shareId: 'shared',
    memberId: 'member',
    providerId: 'openai',
    providerLabel: 'OpenAI',
    hostDeviceId: 'host',
    deviceName: 'Private host',
    owner: { displayName: 'Alice', avatarUrl: null, region: 'global' },
    status: 'active',
    hostOnline: true,
    hostCapable: true,
  };
  const insight = (): ProviderShareInsights => ({
    version: 1,
    capabilities: { quota: true, usage: true },
    status: { quota: 'ready', usage: 'not-requested' },
    usage: null,
    quota: {
      group: false,
      partial: false,
      accounts: [
        {
          state: 'ready',
          updatedAt: Date.now(),
          balance: null,
          windows: [
            {
              kind: 'week',
              label: null,
              remainingPercent: 21,
              resetsAt: Date.now() + 3_600_000,
              windowMinutes: null,
            },
          ],
        },
      ],
    },
  });
  function Rail({ open = true }: { open?: boolean }) {
    return (
      <ProviderShareQuotaViewingContext.Provider value={open}>
        <UnifiedModelRail
          items={[
            { kind: 'all' },
            { kind: 'remote-provider', deviceId: 'share:shared', providerId: 'openai' },
          ]}
          active={{ kind: 'all' }}
          providers={[]}
          providerLabel={(id) => id}
          providerUsage={{ deviceId: null }}
          onSelect={() => {}}
          remoteSources={{
            localProviders: [],
            localProviderLabel: (id) => id,
            providersOf: () => [provider('openai')],
            labelOf: () => 'OpenAI · 来自 Alice 的分享',
          }}
        />
      </ProviderShareQuotaViewingContext.Provider>
    );
  }
  const bar = () => document.querySelector('[data-weekly-remaining]');
  const tick = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    setDataOwnerGeneration('owner-a');
    sharing.received = [share];
    listeners.clear();
    command.mockReset().mockResolvedValue(insight());
    Object.assign(window, {
      electronAPI: {
        providerShare: {
          command,
          onReceivedChanged: (listener: (shares: ProviderShareReceived[]) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  afterEach(() => {
    vi.useRealTimers();
    setDataOwnerGeneration(null);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('shows remaining and reset tooltip, using only quota insights instead of device mirrors', async () => {
    await act(async () => {
      render(<Rail />);
    });
    expect(bar()?.getAttribute('data-weekly-remaining')).toBe('21');
    expect(bar()?.firstElementChild?.getAttribute('style')).toBe('width: 21%;');
    const button = screen.getByRole('button', { name: 'OpenAI · 来自 Alice 的分享' });
    expect(button.getAttribute('aria-description')).toBe('每周 · 剩余 21%');
    fireEvent.focus(button);
    expect(screen.getByRole('tooltip').textContent).toContain('1小时 后重置');
    expect(command).toHaveBeenCalledExactlyOnceWith({
      action: 'insights',
      shareId: 'shared',
      includeUsage: false,
    });
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();

    const next = insight();
    next.quota!.accounts[0].windows.unshift({
      kind: 'scoped',
      label: 'Fable',
      remainingPercent: 0,
      resetsAt: null,
      windowMinutes: 10_080,
    });
    command.mockResolvedValue(next);
    await tick();
    expect(bar()?.getAttribute('data-weekly-remaining')).toBe('21');
    next.quota!.accounts[0].windows[1].remainingPercent = 0;
    await tick();
    expect(bar()?.getAttribute('data-weekly-remaining')).toBe('0');
    expect(bar()?.firstElementChild?.getAttribute('style')).toBe('width: 0%;');
    next.quota!.accounts[0].windows.pop();
    await tick();
    expect(bar()).toBeNull();
  });

  it('hides revoked, grouped, multiple, unavailable, balance-only and non-weekly quotas', async () => {
    await act(async () => {
      render(<Rail />);
    });
    expect(bar()).not.toBeNull();
    const cases: Array<(view: ProviderShareInsights) => void> = [
      (view) => {
        view.capabilities.quota = false;
      },
      (view) => {
        view.quota!.group = true;
      },
      (view) => {
        view.quota!.accounts.push(view.quota!.accounts[0]);
      },
      (view) => {
        view.status.quota = 'unavailable';
      },
      (view) => {
        view.quota!.accounts[0].state = 'unsupported';
      },
      (view) => {
        view.quota!.accounts[0].windows = [];
        view.quota!.accounts[0].balance = {
          remaining: 10,
          total: 20,
          currency: 'USD',
          resetsAt: null,
          pools: [],
        };
      },
      (view) => {
        view.quota!.accounts[0].windows[0].kind = 'session';
      },
      (view) => {
        view.quota!.accounts[0].windows[0].resetsAt = Date.now() - 1;
      },
    ];
    for (const change of cases) {
      const view = insight();
      change(view);
      command.mockResolvedValue(view);
      await tick();
      expect(bar()).toBeNull();
    }
    expect(command.mock.calls.every(([cmd]) => cmd.includeUsage === false)).toBe(true);
  });

  // E2E: changing directory remounted the rail 1.2s after its last read.
  it('reuses quota across directory remounts and shares in-flight reads', async () => {
    let finishFirst!: (value: ProviderShareInsights) => void;
    command.mockImplementationOnce(() => new Promise<ProviderShareInsights>((done) => { finishFirst = done; }));
    const first = render(<Rail />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      finishFirst(insight());
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    first.unmount();
    const second = render(<Rail />);
    expect(bar()?.getAttribute('data-weekly-remaining')).toBe('21');
    await act(async () => {});
    expect(command).toHaveBeenCalledTimes(1);
    let resolve!: (value: ProviderShareInsights) => void;
    command.mockImplementation(() => new Promise<ProviderShareInsights>((done) => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(command).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2800); });
    expect(command).toHaveBeenCalledTimes(2);
    second.unmount();
    render(<><Rail /><Rail /></>);
    await act(async () => {});
    expect(command).toHaveBeenCalledTimes(2);
    await act(async () => { resolve(insight()); });
    expect(document.querySelectorAll('[data-weekly-remaining="21"]')).toHaveLength(2);
  });

  it('clears the shared result when the picker closes without retaining its rail', async () => {
    function Picker({ open }: { open: boolean }) {
      useProviderShareQuotaViewing(open);
      return open ? <Rail /> : null;
    }
    const view = render(<Picker open />);
    await act(async () => {});
    expect(bar()).not.toBeNull();
    view.rerender(<Picker open={false} />);
    await act(async () => {});
    view.rerender(<Picker open />);
    expect(bar()).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
    await tick();
    expect(bar()?.getAttribute('data-weekly-remaining')).toBe('21');
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('does not query closed lists and discards late reads after closing or hiding', async () => {
    const view = render(<Rail open={false} />);
    await tick();
    expect(command).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(<Rail />);
    });
    expect(bar()).not.toBeNull();
    let resolve!: (value: ProviderShareInsights) => void;
    command.mockImplementation(
      () =>
        new Promise<ProviderShareInsights>((done) => {
          resolve = done;
        }),
    );
    await tick();
    view.rerender(<Rail open={false} />);
    expect(bar()).toBeNull();
    await act(async () => {
      resolve(insight());
    });
    await tick();
    expect(bar()).toBeNull();
    expect(command).toHaveBeenCalledTimes(2);

    await act(async () => {
      view.rerender(<Rail />);
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      resolve(insight());
    });
    await tick();
    expect(command).toHaveBeenCalledTimes(3);
    expect(bar()).toBeNull();
    command.mockResolvedValue(insight());
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(bar()).not.toBeNull();
    view.unmount();
    await tick();
    expect(command).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
  });

  it('clears on membership and owner changes, rejecting stale replies and inactive shares', async () => {
    const view = render(<Rail />);
    await act(async () => {});
    expect(bar()).not.toBeNull();
    for (const patch of [
      { status: 'paused' as const },
      { hostOnline: false },
      { hostCapable: false },
    ]) {
      const calls = command.mock.calls.length;
      sharing.received = [{ ...share, ...patch }];
      act(() => {
        for (const listener of listeners) listener(sharing.received);
      });
      view.rerender(<Rail />);
      await tick();
      expect(bar()).toBeNull();
      expect(command).toHaveBeenCalledTimes(calls);
    }
    sharing.received = [share];
    await act(async () => {
      view.rerender(<Rail />);
    });
    expect(bar()).not.toBeNull();
    let resolve!: (value: ProviderShareInsights) => void;
    command.mockImplementation(
      () =>
        new Promise<ProviderShareInsights>((done) => {
          resolve = done;
        }),
    );
    await tick();
    act(() => {
      for (const listener of listeners) listener([{ ...share, memberId: 'replacement' }]);
    });
    expect(bar()).toBeNull();
    await act(async () => {
      resolve(insight());
    });
    expect(bar()).toBeNull();
    await tick();
    act(() => {
      for (const listener of listeners) listener([share]);
    });
    const resolvePreviousOwner = resolve;
    const calls = command.mock.calls.length;
    setDataOwnerGeneration('owner-b');
    sharing.received = [];
    view.rerender(<Rail />);
    await act(async () => {
      resolvePreviousOwner(insight());
    });
    await tick();
    expect(bar()).toBeNull();
    expect(command).toHaveBeenCalledTimes(calls);
  });
});

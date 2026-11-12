// @vitest-environment jsdom
import React from 'react';
import { render, renderHook, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelAccountQuotaStatus, modelQuotaWarning } from '@/components/new-chat/modelAccountQuotaStatus';
import { ModelPickerAccountProvider, useModelPickerAccount } from '@/components/new-chat/ModelPickerAccount';
import { ModelPoolQuotaSummary } from '@/components/new-chat/ModelPoolQuota';
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderShareInsights } from '../../shared/providerShareInsights';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ProviderShareQuotaViewingContext, useProviderShareQuotaViewing } from '@/features/provider-share/useProviderShareWeeklyQuota';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

// Account generations are driven explicitly below; no full auth host is needed.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalAuthDeviceId: () => 'self-a', useOptionalDataOwnerGeneration: () => 0 }));

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
import { ModelSourceDetails, ModelSourceUsageProvider } from '@/components/new-chat/ModelSourceDetails';
import {
  codexWeeklyQuota,
  localCodexQuotaView,
  remoteCodexQuotaView,
  weeklyQuota,
  providerWeeklyQuotaSource,
  useProviderWeeklyQuota,
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
  // User report: an unallocated pool still has known per-account quota. Busy
  // accounts remain visible; no pooled percentage or paused default is invented.
  it.each(['anthropic', 'openai'] as const)('shows each %s account quota before allocation in both rail and model row', async providerId => {
    reads.codex.mockReturnValue({ snapshot: null });
    reads.claude.mockReturnValue(null);
    const account = (id: string, used: number, paused = false) => ({
      id, identity: `${id}@example.test`, paused, status: 'ready', running: id === 'a' ? 4 : 0, limit: 4,
      usage: { claude: { sevenDay: { utilization: used } }, codex: { buckets: { codex: { secondary: { windowMinutes: 10080, usedPercent: used } } } } },
    });
    const pool = { providerId, configured: true,
      accounts: [account('a', 66), account('b', 20), account('paused', 1, true)] };
    const command = vi.fn().mockResolvedValue(pool);
    let changed!: (event: { providerId: string }) => void;
    Object.assign(window, { electronAPI: { subscriptionAccounts: { command,
      onChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
    } } });
    const providers = [provider(providerId, { auth: { method: 'oauth', native: providerId === 'anthropic' ? 'claude' : 'codex' } })];
    const view = render(<ModelSourceUsageProvider providers={providers} scope={{ deviceId: null }}>
      <UnifiedModelRail items={[{ kind: 'provider', providerId }]} active={{ kind: 'all' }}
        providers={providers} providerLabel={() => 'Provider'} onSelect={() => {}} providerUsage={{ deviceId: null }} />
      <ModelPoolQuotaSummary providerId={providerId}/>
      <ModelSourceDetails providerId={providerId} label="Provider" modelId={providerId === 'anthropic' ? 'claude-sonnet' : 'chatgpt/gpt-5.6'} />
    </ModelSourceUsageProvider>);
    await act(async () => {});
    const button = screen.getByRole('button', {name:'Provider · providerGroup.member.accountCount'});
    expect(screen.getByRole('button',{name:'subscriptionAccounts.quotaAverage'})).toBeTruthy();
    expect(button.getAttribute('aria-description')).toContain('a@example.test · 每周 · 剩余 34%');
    expect(button.getAttribute('aria-description')).toContain('b@example.test · 每周 · 剩余 80%');
    expect(button.getAttribute('aria-description')).not.toContain('paused@example.test');
    expect(button.querySelector('[data-weekly-remaining="57"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('34% / 80%');
    expect(view.container.querySelector('[data-model-source-details]')?.getAttribute('title')).toContain('a@example.test');
    expect(view.container.querySelector('[data-model-source-details]')?.getAttribute('title')).toContain('b@example.test');
    // Native pool bridges use the same account buckets as runtime admission.
    expect(view.container.querySelector('[data-model-source-details]')?.getAttribute('title')).toContain('34%');

    // User-reported flicker / unit: existing tests only observed completed reads.
    // Hold the next pool read open: the actual summary and rail must retain the
    // previous snapshot, then replace it together, including during event bursts.
    let resolve!: (value: typeof pool) => void;
    command.mockImplementation(({ action }) => action === 'preview' ? Promise.resolve(pool)
      : new Promise<typeof pool>(done => { resolve = done; }));
    act(() => changed({ providerId }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'subscriptionAccounts.quotaAverage' }).textContent).toBe('57%');
    expect(button.querySelector('[data-weekly-remaining="57"]')).not.toBeNull();
    const calls = command.mock.calls.length;
    act(() => { changed({ providerId }); changed({ providerId }); });
    expect(command).toHaveBeenCalledTimes(calls);
    await act(async () => resolve({ ...pool, accounts: [account('a', 100), account('b', 100)] }));
    // The superseded reply must not flash 0% before the queued read completes.
    expect(screen.getByRole('button', { name: 'subscriptionAccounts.quotaAverage' }).textContent).toBe('57%');
    await act(async () => resolve({ ...pool, accounts: [account('a', 70), account('b', 30)] }));
    expect(screen.getByRole('button', { name: 'subscriptionAccounts.quotaAverage' }).textContent).toBe('50%');
    expect(button.querySelector('[data-weekly-remaining="50"]')).not.toBeNull();
  });
  // Retaining a snapshot is allowed only within its scope. Existing rail tests
  // do not hold a pool read across a device/task/owner change (unit regression).
  it.each(['device', 'task', 'owner'] as const)('hides retained quota after a %s change and rejects the old reply', async change => {
    const pool = { providerId: 'anthropic', configured: true, accounts: [
      { id: 'a', identity: 'a@example.test', paused: false, status: 'ready', running: 0, limit: 4,
        usage: { claude: { sevenDay: { utilization: 22 } } } },
    ] };
    const command = vi.fn().mockResolvedValue(pool);
    let resolveRemote: ((value: typeof pool) => void) | undefined;
    Object.assign(window, { electronAPI: {
      subscriptionAccounts: { command, onChanged: () => () => {} },
      deviceLink: { invoke: vi.fn(() => new Promise<typeof pool>(done => { resolveRemote = done; })), onRemotePush: () => () => {} },
    } });
    function Account() {
      const account = useModelPickerAccount('anthropic');
      return <span>{account?.identity ?? 'unknown'}</span>;
    }
    const tree = (deviceId: string | null = null, taskId?: string) =>
      <ModelPickerAccountProvider enabled providerIds={['anthropic']} deviceId={deviceId} taskId={taskId}>
        <Account />
      </ModelPickerAccountProvider>;
    const view = render(tree());
    await act(async () => {});
    expect(view.container.textContent).toBe('a@example.test');
    let resolve!: (value: typeof pool) => void;
    command.mockImplementation(() => new Promise<typeof pool>(done => { resolve = done; }));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(view.container.textContent).toBe('a@example.test');
    const oldReply = resolve;
    if (change === 'owner') setDataOwnerGeneration('quota-new-owner');
    view.rerender(tree(change === 'device' ? 'other-device' : null, change === 'task' ? 'other-task' : undefined));
    expect(view.container.textContent).toBe('unknown');
    command.mockResolvedValue(pool);
    await act(async () => oldReply(pool));
    expect(view.container.textContent).toBe('unknown');
    view.unmount();
    await act(async () => { resolve(pool); resolveRemote?.({ ...pool, configured: false }); });
  });

  // Approved picker contract / unit: single accounts warn at 10%, pools only
  // when all accounts are exhausted. Verify actual summary and rail together.
  it.each([
    { name: 'single low', used: [92], warning: 'quotaFiveHourRemaining' },
    { name: 'legacy single low', used: [92], warning: 'quotaFiveHourRemaining', legacy: true },
    { name: 'single exhausted', used: [100], warning: 'quotaRecoverIn' },
    { name: 'partial pool', used: [100, 20], warning: null },
    { name: 'all exhausted', used: [100, 100], warning: 'quotaRecoverIn' },
    { name: 'unknown member', used: [100, NaN], warning: null },
    { name: 'expired limit', used: [100], warning: 'resetPending', expired: true },
    { name: 'unknown reset', used: [100], warning: 'quotaExhausted', unknown: true },
  ])('$name', async ({ used, warning, expired, unknown, legacy }) => {
    const providerId = 'anthropic';
    const accounts = used.map((utilization, index) => ({
      id: String(index), identity: `account-${index}`, paused: false, status: 'ready', running: 0, limit: 4,
      usage: { claude: {
        fiveHour: { utilization, resetsAt: unknown ? null : Date.now() / 1000 + (expired ? -1 : 1920) },
        sevenDay: { utilization: 22, resetsAt: Date.now() / 1000 + 86400 * 6 },
      } },
    }));
    if (legacy) reads.claude.mockReturnValue(accounts[0].usage.claude);
    const command = vi.fn().mockResolvedValue({ providerId, configured: !legacy, accounts });
    Object.assign(window, { electronAPI: { subscriptionAccounts: { command, onChanged: () => () => {} } } });
    const providers = [provider(providerId, { auth: { method: 'oauth', native: 'claude' } })];
    const view = render(<ModelSourceUsageProvider providers={providers} scope={{ deviceId: null }}>
      <UnifiedModelRail items={[{ kind: 'provider', providerId }]} active={{ kind: 'all' }}
        providers={providers} providerLabel={() => 'Provider'} onSelect={() => {}} providerUsage={{ deviceId: null }} />
      <ModelPoolQuotaSummary providerId={providerId} />
    </ModelSourceUsageProvider>);
    await act(async () => {});
    const summary = view.container.querySelector('[data-pool-quota-summary]')!;
    expect(summary.textContent).toContain('78%');
    const indicator = summary.querySelector('[data-quota-warning]');
    if (warning) {
      expect(indicator?.textContent).toContain(warning);
      expect(view.container.querySelector('[data-rail-item] [data-quota-warning]')).not.toBeNull();
    } else {
      expect(indicator).toBeNull();
      expect(view.container.querySelector('[data-rail-item] [data-quota-warning]')).toBeNull();
    }
  });

  it('waits for every exhausted window on an account, then chooses the earliest recoverable account', () => {
    const now = 1_800_000_000_000;
    const status = (short: number, weekly: number) => modelAccountQuotaStatus('anthropic', { claude: {
      fiveHour: { utilization: 100, resetsAt: now / 1000 + short },
      sevenDay: { utilization: 100, resetsAt: now / 1000 + weekly },
    } }, now);
    expect(modelQuotaWarning([status(60, 3600), status(120, 1800)])).toMatchObject({ reset: now / 1000 + 1800 });
    const codex = modelAccountQuotaStatus('openai', { codex: { credits: null, buckets: { codex: {
      limitId: 'codex', limitName: null, updatedAt: now,
      primary: { usedPercent: 92, windowMinutes: 300, resetsAt: now / 1000 + 60 }, secondary: null,
    } } } }, now);
    expect(modelQuotaWarning([codex])).toEqual({ kind: 'low', remaining: 8 });
  });

  // #9711 / unit: rail and row must consume the same pool snapshot, not an
  // identity from B beside a weekly bar borrowed from paused default account A.
  it.each(['anthropic', 'openai'] as const)('shares %s candidate identity and quota across rail and rows without a per-entry opt-in', async (providerId) => {
    reads.codex.mockReturnValue({ snapshot: null });
    reads.claude.mockImplementation(enabled => enabled ? { sevenDay: { utilization: 93 }, subscriptionType: 'pro' } : null);
    const command = vi.fn().mockResolvedValue({ providerId, configured: true, accounts: [
      { id: 'default', identity: 'a@example.test', paused: true, status: 'ready', running: 0, limit: 4 },
      { id: 'b', identity: 'b@example.test', plan: providerId === 'anthropic' ? 'max' : 'pro', paused: false, status: 'ready', running: 0, limit: 4,
        usage: { claude: { sevenDay: { utilization: 0 } }, codex: { buckets: { codex: { secondary: { windowMinutes: 10080, usedPercent: 0 } } } } } },
    ] });
    Object.assign(window, { electronAPI: { subscriptionAccounts: { command, onChanged: () => () => {} } } });
    const providers = [provider(providerId, { auth: { method: 'oauth', native: providerId === 'anthropic' ? 'claude' : 'codex' }, subscriptionAccount: { source: 'oauth', identity: 'a@example.test' } })];
    const scope = { deviceId: null };
    const view = render(
      <ModelSourceUsageProvider providers={providers} scope={scope}>
        <UnifiedModelRail items={[{ kind: 'provider', providerId }]} active={{ kind: 'all' }}
          providers={providers} providerLabel={() => 'Claude'} onSelect={() => {}} providerUsage={scope} />
        <ModelSourceUsageProvider providers={providers} scope={scope}>
          <ModelSourceDetails providerId={providerId} label="Claude" accountIdentity="a@example.test" modelId={providerId === 'anthropic' ? 'claude-sonnet' : 'gpt-5.6'} />
        </ModelSourceUsageProvider>
      </ModelSourceUsageProvider>,
    );
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Claude · b@example.test' });
    expect(button.querySelector('[data-weekly-remaining="100"]')).not.toBeNull();
    expect(view.container.textContent).toContain(providerId === 'anthropic' ? 'b@example.test · Max' : 'b@example.test · Pro');
    expect(view.container.textContent).not.toContain('a@example.test');
    expect(command.mock.calls).toEqual([
      [{ action: 'preview', providerId }],
      [{ action: 'read', providerId }],
    ]);
  });

  // #8010 merge regression / unit: main added Kimi after self-source normalization.
  // Run the real quota + account hooks; existing tests only covered other vendors.
  // Minimum input: A's explicit device ID and a Kimi provider read from B's catalog.
  it('reads controller-owned Kimi quota locally and keeps other computers remote', async () => {
    reads.codex.mockReturnValue({ snapshot: null });
    const value = (usedPercent: number) => ({ status: 'ready', stale: false,
      snapshot: { kind: 'kimi-coding-quota', fetchedAt: Date.now(),
        windows: [{ id: 'limit_7d', usedPercent, resetsAt: null }] } });
    const local = vi.fn().mockResolvedValue(value(30));
    const remote = vi.fn().mockResolvedValue(value(60));
    vi.stubGlobal('electronAPI', { maker: { fetchProviderAccountUsage: local }, deviceLink: { invoke: remote } });
    const kimi = provider('kimi-self', { auth: { method: 'apiKey' },
      routing: { pi: { upstream: 'https://api.kimi.com/coding/v1', authStrategy: 'api-key-header' } } });
    const hook = renderHook(({ deviceId }) => useProviderWeeklyQuota(kimi, { deviceId }),
      { initialProps: { deviceId: 'self-a' } });
    try {
      await act(async () => {});
      expect(hook.result.current?.usedPercent).toBe(30);
      expect(local).toHaveBeenCalledExactlyOnceWith({ providerId: 'kimi-self', forceRefresh: false });
      expect(remote).not.toHaveBeenCalled();
      hook.rerender({ deviceId: 'other-b' });
      await act(async () => {});
      expect(hook.result.current?.usedPercent).toBe(60);
      expect(remote).toHaveBeenCalledExactlyOnceWith('other-b', 'maker:usage:kimi-coding', [{ providerId: 'kimi-self', forceRefresh: false }]);
      expect(local).toHaveBeenCalledTimes(1);
    } finally { hook.unmount(); vi.unstubAllGlobals(); }
  });
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
    expect(providerWeeklyQuotaSource(provider('opencode-go', {
      source: 'user',
      auth: { method: 'apiKey' },
      access: { kind: 'api' },
      routing: { pi: { upstream: 'https://opencode.ai/zen/go/v1', authStrategy: 'api-key-header' } },
    }))).toBe('opencode-go');
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
    expect(reads.remoteCodex).toHaveBeenCalledWith('device-1', 'openai', { live: true, web: false });
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
  it('keeps live permission/quota checks on a signaling-offline share and clears the result when that actual read fails', async () => {
    sharing.received = [{ ...share, hostOnline: false }];
    render(<Rail />);
    await act(async () => {});
    expect(command).toHaveBeenCalledTimes(1);
    expect(bar()).not.toBeNull();
    command.mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] no data path'));
    await tick();
    expect(command).toHaveBeenCalledTimes(2);
    expect(bar()).toBeNull();
  });
});

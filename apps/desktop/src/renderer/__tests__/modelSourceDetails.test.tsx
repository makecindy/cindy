// @vitest-environment jsdom
import React from 'react';
import en from '../i18n/locales/en/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';
import type { SubscriptionPoolView } from '../../shared/subscriptionAccounts';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

// #8010: quota reads also consult the controller identity. These component
// fixtures have no auth host; keep its app bootstrap outside the mocked i18n.
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthUser: () => null,
  useOptionalAuthDeviceId: () => null,
  useOptionalDataOwnerGeneration: () => reads.ownerGeneration,
}));

const reads = vi.hoisted(() => ({
  ownerGeneration: 0,
  pendingLabel: '',
  realRemoteClaude: false,
  codex: vi.fn(),
  web: vi.fn(),
  claude: vi.fn(),
  xai: vi.fn(),
  accounts: {} as Record<string, MobileCodexRateLimitsResult>,
  webSnapshot: null as RateLimitSnapshot | null,
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  xaiSnapshot: null as XaiSubscriptionUsageSnapshot | null,
  remoteCodex: vi.fn(),
  remoteClaude: vi.fn(),
  remoteXai: vi.fn(),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: reads.codex }));
vi.mock('@/hooks/useAccountUsage', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useAccountUsage')>()),
  useAccountUsage: reads.web,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: reads.remoteCodex,
  useRemoteXaiSubscriptionUsage: reads.remoteXai,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useRemoteClaudeSubscriptionUsage')>();
  return {
    useRemoteClaudeSubscriptionUsage: (...args: Parameters<typeof actual.useRemoteClaudeSubscriptionUsage>) =>
      reads.realRemoteClaude ? actual.useRemoteClaudeSubscriptionUsage(...args) : reads.remoteClaude(...args),
  };
});
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: reads.claude }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: reads.xai }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { percent?: number }) =>
      ({
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.unit.minute': '分钟',
        'todaySpend.unit.second': '秒',
        'quotaCard.resetPending': reads.pendingLabel,
        'quotaCard.remainingPercent': `剩余 ${args?.percent}%`,
      })[key] ?? key,
  }),
}));
import {
  ModelSourceDetails,
  ModelSourceUsageProvider,
} from '@/components/new-chat/ModelSourceDetails';

const quotaText = (text: string) => (_: string, node: Element | null) =>
  node?.textContent === text &&
  !Array.from(node.children).some((child) => child.textContent === text);

const now = Date.UTC(2026, 8, 12);
const local = { deviceId: null };
const provider = (id: string, native: 'codex' | 'claude' | 'xai' = 'codex'): ProviderView => ({
  id,
  name: id,
  source: 'user',
  auth: { method: 'oauth', native },
  connected: true,
  agents: [],
  routing: {},
  models: {},
  access: { kind: 'subscription', product: 'test' },
});
function snapshot(used: number): MobileCodexRateLimitsResult {
  return {
    account: { email: null, accountId: null, planType: 'pro' },
    rateLimits: {
      primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
      secondary: { usedPercent: 58, windowMinutes: 10080, resetsAt: now / 1000 + 5 * 86400 },
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    resetOffer: null,
  };
}
function details(id = 'account-a', modelId = 'gpt-5.6') {
  return <ModelSourceDetails providerId={id} label={id} modelId={modelId} />;
}
beforeEach(() => {
  reads.ownerGeneration = 0;
  setDataOwnerGeneration(null, 0);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  reads.realRemoteClaude = false;
  reads.pendingLabel = zhCN.quotaCard.resetPending;
  reads.accounts = { 'account-a': snapshot(22), 'account-b': snapshot(88) };
  reads.webSnapshot = null;
  reads.claudeSnapshot = null;
  reads.xaiSnapshot = null;
  reads.codex.mockImplementation((enabled: boolean, id: string) => ({
    snapshot: enabled ? (reads.accounts[id] ?? null) : null,
  }));
  reads.web.mockImplementation((_session, vendor) =>
    vendor === 'codex' ? reads.webSnapshot : null,
  );
  reads.claude.mockImplementation((enabled: boolean) => (enabled ? reads.claudeSnapshot : null));
  reads.xai.mockImplementation((enabled: boolean) => (enabled ? reads.xaiSnapshot : null));
  reads.remoteCodex.mockReturnValue(null);
  reads.remoteClaude.mockReturnValue(null);
  reads.remoteXai.mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('model source second line', () => {
  // #9711 (unit): the production menu reader used the paused native Pro account
  // even when the only assignable pool account was Max. Existing tests only
  // exercised the default-account usage API, not a configured pool or its changes.
  it('uses one assignable draft account and invalidates it when the pool changes', async () => {
    const usage = (used: number) => ({ sevenDay: { utilization: used, resetsAt: now / 1000 + 86400 } });
    reads.claudeSnapshot = { ...usage(93), subscriptionType: 'pro' };
    let pool: SubscriptionPoolView = {
      providerId: 'anthropic', configured: true, strategy: 'round',
      accounts: [
        { id: 'default', identity: 'a@example.test', plan: 'pro', paused: true, status: 'ready', running: 0, limit: 4, weight: 1, directory: '', usage: { claude: usage(93) } },
        { id: 'b', identity: 'b@example.test', plan: 'max', paused: false, status: 'ready', running: 0, limit: 4, weight: 1, directory: '', usage: { claude: usage(0) } },
      ],
    };
    let changed: ((event: { providerId: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const command = vi.fn(async () => pool);
    Object.assign(window, { electronAPI: { subscriptionAccounts: {
      command, onChanged: (callback: typeof changed) => { changed = callback; return unsubscribe; },
    } } });
    const view = render(
      <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId: null, previewSubscriptionPool: true }}>
        <ModelSourceDetails providerId="anthropic" label="Claude" accountIdentity="a@example.test" modelId="claude-sonnet" />
      </ModelSourceUsageProvider>,
    );
    expect(view.container.textContent).not.toContain('Pro');
    await act(async () => {});
    expect(view.container.textContent).toContain('b@example.test · Max');
    expect(view.container.textContent).toContain('100%');
    expect(view.container.textContent).not.toContain('a@example.test');
    expect(command).toHaveBeenCalledTimes(2);
    // Pausing B removes its identity, plan and quota together, before the read returns.
    pool = { ...pool, accounts: pool.accounts.map(account => ({ ...account, paused: true })) };
    act(() => changed?.({ providerId: 'anthropic' }));
    expect(view.container.textContent).not.toContain('b@example.test');
    await act(async () => {});
    expect(view.container.textContent).toContain('subscriptionAccounts.unassigned');
    expect(view.container.textContent).not.toMatch(/Pro|Max|%|@/);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['multiple', 'signed-out', 'unavailable', 'limited', 'busy', 'unknown-identity'] as const)(
    'keeps an unassigned draft pool honest when %s', async (state) => {
      reads.claudeSnapshot = { subscriptionType: 'pro', sevenDay: { utilization: 93 } };
      const account = { id: 'b', identity: state === 'unknown-identity' ? '' : 'b@example.test', plan: 'max', paused: false,
        status: state === 'signed-out' || state === 'unavailable' || state === 'limited' ? state : 'ready',
        running: state === 'busy' ? 4 : 0, limit: 4, weight: 1, directory: '',
        usage: { claude: { sevenDay: { utilization: 0 } } } };
      const command = vi.fn().mockResolvedValue({ providerId: 'anthropic', configured: true,
        accounts: state === 'multiple' ? [account, { ...account, id: 'c', identity: 'c@example.test' }] : [account] });
      Object.assign(window, { electronAPI: { subscriptionAccounts: { command, onChanged: () => () => {} } } });
      const view = render(
        <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId: null, previewSubscriptionPool: true }}>
          <ModelSourceDetails providerId="anthropic" label="Claude" accountIdentity="a@example.test" modelId="claude-sonnet" />
        </ModelSourceUsageProvider>,
      );
      await act(async () => {});
      expect(view.container.textContent).toBe('Claude · subscriptionAccounts.unassigned');
      expect(reads.claude).not.toHaveBeenCalledWith(true, 'anthropic');
    },
  );

  it('ignores superseded pool reads and never restores the native account on read failure', async () => {
    let finish!: (pool: SubscriptionPoolView) => void;
    const command = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValue(new Error('unavailable'));
    let changed!: (event: { providerId: string }) => void;
    Object.assign(window, { electronAPI: { subscriptionAccounts: {
      command, onChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
    } } });
    const view = render(
      <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId: null, previewSubscriptionPool: true }}>
        <ModelSourceDetails providerId="anthropic" label="Claude" accountIdentity="a@example.test" modelId="claude-sonnet" />
      </ModelSourceUsageProvider>,
    );
    await act(async () => { changed({ providerId: 'anthropic' }); });
    await act(async () => { finish({ providerId: 'anthropic', configured: false, strategy: 'round', accounts: [] }); });
    expect(view.container.textContent).toBe('Claude · subscriptionAccounts.unassigned');
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('preserves existing task and remote readers and falls back only for an unconfigured local pool', async () => {
    reads.claudeSnapshot = { subscriptionType: 'pro', sevenDay: { utilization: 93 } };
    reads.remoteClaude.mockReturnValue({ subscriptionType: 'max', sevenDay: { utilization: 40 } });
    // #9739 review: a full read can wait on CLI quota before reporting that no
    // pool exists. The production menu must render legacy cached details without
    // waiting for it; preview is the existing auth-only default-account probe.
    const command = vi.fn(({ action }: { action: string }) => action === 'preview'
      ? Promise.resolve({ providerId: 'anthropic', configured: false, accounts: [] })
      : new Promise(() => {}));
    Object.assign(window, { electronAPI: { subscriptionAccounts: { command, onChanged: () => () => {} } } });
    const menu = (deviceId: string | null, previewSubscriptionPool: boolean) => (
      <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId, previewSubscriptionPool }}>
        <ModelSourceDetails providerId="anthropic" label="Claude" accountIdentity="a@example.test" modelId="claude-sonnet" />
      </ModelSourceUsageProvider>
    );
    const view = render(menu(null, false));
    expect(view.container.textContent).toContain('a@example.test · Pro');
    expect(view.container.textContent).toContain('7%');
    expect(command).not.toHaveBeenCalled();
    view.rerender(menu('other-device', true));
    expect(view.container.textContent).toContain('Max');
    expect(view.container.textContent).toContain('60%');
    expect(command).not.toHaveBeenCalled();
    view.rerender(menu(null, true));
    expect(view.container.textContent).not.toContain('a@example.test');
    await act(async () => {});
    expect(view.container.textContent).toContain('a@example.test · Pro');
    expect(view.container.textContent).toContain('7%');
    expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'preview', providerId: 'anthropic' });
  });

  // #9739 review (unit): same-owner repairs advance the generation without
  // changing user.id. Existing pool-change tests never exercised that boundary.
  it('reloads a draft account after a same-owner repair without a focus or pool event', async () => {
    const pool = (identity: string): SubscriptionPoolView => ({
      providerId: 'anthropic', configured: true, strategy: 'round', accounts: [{
        id: 'b', identity, plan: 'max', paused: false, status: 'ready',
        running: 0, limit: 4, weight: 1, directory: '',
        usage: { claude: { sevenDay: { utilization: 0 } } },
      }],
    });
    let finish!: (value: SubscriptionPoolView) => void;
    const command = vi.fn().mockResolvedValue(pool('before@example.test'));
    Object.assign(window, { electronAPI: { subscriptionAccounts: { command, onChanged: () => () => {} } } });
    const menu = () => (
      <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId: null, previewSubscriptionPool: true }}>
        <ModelSourceDetails providerId="anthropic" label="Claude" accountIdentity="default@example.test" modelId="claude-sonnet" />
      </ModelSourceUsageProvider>
    );
    const view = render(menu());
    await act(async () => {});
    expect(view.container.textContent).toContain('before@example.test · Max');
    command.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    reads.ownerGeneration = 1;
    setDataOwnerGeneration(null, 1);
    view.rerender(menu());
    expect(view.container.textContent).toBe('Claude · subscriptionAccounts.unassigned');
    command.mockResolvedValue(pool('after@example.test'));
    await act(async () => { finish?.(pool('after@example.test')); });
    expect(view.container.textContent).toContain('after@example.test · Max');
    expect(view.container.textContent).toContain('100%');
    expect(view.container.textContent).not.toMatch(/before@|default@/);
  });

  // §7.5: model rows do not read shared subscription quota. E2E found this
  // forbidden IPC after selecting a share; exercise the real Claude mirror (unit).
  it('does not invoke device usage when browsing a shared directory', async () => {
    reads.realRemoteClaude = true;
    const invoke = vi.fn().mockResolvedValue(null);
    Object.assign(window, { electronAPI: { deviceLink: { invoke, onRemotePush: () => () => {} } } });
    const view = render(
      <ModelSourceUsageProvider providers={[provider('anthropic', 'claude')]} scope={{ deviceId: 'share:shared-directory' }}>
        {details('anthropic', 'claude-sonnet')}
      </ModelSourceUsageProvider>,
    );
    await act(async () => {});
    expect(view.container.textContent).toContain('anthropic');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shares one reader per account across duplicate model and favorite rows', () => {
    const { container } = render(
      <ModelSourceUsageProvider
        providers={[provider('account-a'), provider('account-b')]}
        scope={local}
      >
        {details()}
        {details()}
        {details('account-b')}
      </ModelSourceUsageProvider>,
    );
    // Only the tightest window is shown: account-a's weekly, account-b's five-hour.
    expect(screen.getAllByText(quotaText('5天 42%'))).toHaveLength(2);
    expect(screen.getByText(quotaText('2小时 12%'))).toBeTruthy();
    expect(screen.queryByText(/2小时 78%/)).toBeNull();
    expect(container.textContent).not.toContain('/');
    expect(container.querySelector('[data-model-source-details]')?.getAttribute('title')).toBe(
      'account-a · Pro · 2小时 · 剩余 78% · 5天 · 剩余 42%',
    );
    expect(
      reads.codex.mock.calls.filter(([enabled, id]) => enabled && id === 'account-a'),
    ).toHaveLength(1);
    expect(container.querySelector('svg, [role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toMatch(/5 小时|本周|剩余/);
    for (const line of container.querySelectorAll('[data-model-source-details]')) {
      expect(line.className).toContain('whitespace-nowrap');
      expect(line.querySelector('span')?.className).toContain('truncate');
    }
  });
  it.each([70, 71, 89, 90, 98])('warns only on the percentage at %s percent used', (used) => {
    reads.accounts['account-a'] = snapshot(used);
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    const percentage = screen.getByText(`${100 - used}%`);
    expect(percentage.className).toBe(
      used >= 90 ? 'text-[var(--quota-bar-crit)]' : used >= 70 ? 'text-[var(--quota-bar-warn)]' : '',
    );
    expect(percentage.parentElement?.className).toBe('');
    expect(percentage.parentElement?.textContent).toBe(`2小时 ${100 - used}%`);
  });
  it('shows only the source when the directory may not show account usage', () => {
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={null}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('account-a')).toBeTruthy();
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.web).not.toHaveBeenCalled();
    expect(reads.remoteCodex).not.toHaveBeenCalled();
  });
  it('reads a remote directory from the device mirror, never this desktop', () => {
    const bucket = (limitId: string, used: number, limitName?: string) => ({
      limitId,
      limitName,
      planType: 'plus',
      primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
    });
    reads.remoteCodex.mockImplementation((deviceId: string | null, id: string) =>
      deviceId === 'device-1' && id === 'account-a'
        ? {
            ...bucket('codex_other', 5),
            webSnapshot: {
              source: 'openai-web',
              primary: { usedPercent: 61, resetsAt: now / 1000 + 3600 },
            },
            appServerBuckets: {
              codex: bucket('codex', 40),
              spark: bucket('spark', 90, 'GPT-5.3-Codex-Spark'),
            },
          }
        : null,
    );
    reads.remoteClaude.mockImplementation((deviceId: string | null) =>
      deviceId ? { subscriptionType: 'pro', fiveHour: { utilization: 25 } } : null,
    );
    render(
      <ModelSourceUsageProvider
        providers={[provider('account-a'), provider('claude', 'claude')]}
        scope={{ deviceId: 'device-1' }}
      >
        {details()}
        {details('account-a', 'gpt-5.3-codex-spark')}
        {details('account-a', 'chatgpt/gpt-5.6')}
        {details('claude', 'claude-opus-5')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('2小时 60%'))).toBeTruthy();
    expect(screen.getByText(quotaText('2小时 10%'))).toBeTruthy();
    expect(screen.getByText(quotaText('1小时 39%'))).toBeTruthy();
    expect(screen.getByText('claude · Pro')).toBeTruthy();
    expect(screen.getAllByText('account-a · Plus')).toHaveLength(2);
    expect(reads.remoteCodex).toHaveBeenCalledWith('device-1', 'account-a', { live: true, web: true });
    expect(reads.codex.mock.calls.some(([enabled]) => enabled)).toBe(false);
    expect(reads.web.mock.calls.some(([, vendor]) => vendor === 'codex')).toBe(false);
    expect(reads.claude.mock.calls.some(([enabled]) => enabled)).toBe(false);
    expect(reads.xai.mock.calls.some(([enabled]) => enabled)).toBe(false);
  });
  it('does not borrow a native subscription for API or reconnect-required connections', () => {
    const api = { ...provider('account-a'), auth: { method: 'apiKey' as const } };
    const reconnect = {
      ...provider('account-b', 'claude'),
      subscriptionAccount: { source: 'oauth' as const, reconnectRequired: true },
    };
    render(
      <ModelSourceUsageProvider providers={[api, reconnect]} scope={local}>
        {details()}
        {details('account-b')}
      </ModelSourceUsageProvider>,
    );
    expect(reads.codex).not.toHaveBeenCalled();
    expect(reads.claude).not.toHaveBeenCalled();
  });
  it('uses the generic Codex bucket for the matching model, not the latest promotional bucket', () => {
    const data = reads.accounts['account-a']!;
    data.rateLimitsByLimitId = {
      codex: data.rateLimits,
      promo: {
        limitId: 'promo',
        primary: { usedPercent: 99, windowMinutes: 300, resetsAt: now / 1000 + 7200 },
      },
    };
    data.rateLimits = data.rateLimitsByLimitId.promo!;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('5天 42%'))).toBeTruthy();
    expect(screen.queryByText(/1%/)).toBeNull();
  });
  it('never falls back to Codex CLI quota for a ChatGPT bridge model', () => {
    const { rerender } = render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.queryByText(quotaText('2小时 78%'))).toBeNull();
    expect(screen.getByText('account-a')).toBeTruthy();
    expect(screen.queryByText('account-a · Pro')).toBeNull();
    reads.webSnapshot = { primary: { usedPercent: 61, resetsAt: now / 1000 + 3600 } };
    rerender(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details('account-a', 'chatgpt/gpt-5.6')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('1小时 39%'))).toBeTruthy();
    expect(screen.queryByText('account-a · Pro')).toBeNull();
  });
  it('uses Claude model-scoped weekly quota and keeps unknown reset times honest', () => {
    reads.claudeSnapshot = {
      subscriptionType: 'max',
      fiveHour: { utilization: 95 },
      sevenDay: { utilization: 50, resetsAt: now / 1000 + 86400 },
      scoped: [
        {
          modelDisplayName: 'Opus',
          modelId: 'claude-opus-5',
          utilization: 80,
          resetsAt: now / 1000 + 2 * 86400,
        },
      ],
    };
    const { container } = render(
      <ModelSourceUsageProvider providers={[provider('claude', 'claude')]} scope={local}>
        {details('claude', 'claude-opus-5')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText('claude · Max')).toBeTruthy();
    expect(screen.getByText(quotaText('— 5%'))).toBeTruthy();
    expect(screen.queryByText(/20%/)).toBeNull();
    expect(container.querySelector('[data-model-source-details]')?.getAttribute('title')).toBe(
      'claude · Max · 剩余 5% · 2天 · 剩余 20%',
    );
  });
  it('caps countdowns at the window length right after a reset, except xAI', () => {
    // resetsAt 比 now + 窗口长度晚 30 秒(服务端取整 / 时钟偏差),不得向上取整成多一天/一小时
    reads.accounts['account-a'] = {
      ...snapshot(0),
      rateLimits: {
        // 5h 窗口更紧张,来源行显示它
        primary: { usedPercent: 50, windowMinutes: 300, resetsAt: now / 1000 + 5 * 3600 + 30 },
        secondary: { usedPercent: 0, windowMinutes: 10080, resetsAt: now / 1000 + 7 * 86400 + 30 },
      },
    };
    reads.claudeSnapshot = {
      subscriptionType: 'max',
      fiveHour: { utilization: 0, resetsAt: now / 1000 + 5 * 3600 + 30 },
      sevenDay: { utilization: 0, resetsAt: now / 1000 + 7 * 86400 + 30 },
    };
    // xAI resetsAt 可能来自非周窗口 / 月度账期,原样显示
    reads.xaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 0,
      resetsAt: now / 1000 + 25 * 86400,
      updatedAt: now,
    };
    render(
      <ModelSourceUsageProvider
        providers={[provider('account-a'), provider('claude', 'claude'), provider('xai', 'xai')]}
        scope={local}
      >
        {details()}
        {details('claude', 'claude-opus-5')}
        {details('xai', 'grok-4')}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('5小时 50%'))).toBeTruthy();
    // Claude 两窗口同为 0% 已用,后一个(周限)胜出
    expect(screen.getByText(quotaText('7天 100%'))).toBeTruthy();
    expect(screen.getByText(quotaText('25天 100%'))).toBeTruthy();
    expect(screen.queryByText(/8天|6小时/)).toBeNull();
  });
  it('shows current xAI weekly quota and hides stale values', () => {
    reads.xaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 36,
      resetsAt: now / 1000 + 86400,
      updatedAt: now,
    };
    const view = () => (
      <ModelSourceUsageProvider providers={[provider('xai', 'xai')]} scope={local}>
        {details('xai', 'grok-4')}
      </ModelSourceUsageProvider>
    );
    const { rerender } = render(view());
    expect(screen.getByText('xai · SuperGrok')).toBeTruthy();
    expect(screen.getByText(quotaText('1天 64%'))).toBeTruthy();
    reads.xaiSnapshot = { ...reads.xaiSnapshot, updatedAt: now - 10 * 86400000 };
    rerender(view());
    expect(screen.queryByText(quotaText('1天 64%'))).toBeNull();
  });

  it.each([en, zhCN, zhTW, ja, ko])(
    'constrains two localized pending windows and retains the full title',
    (locale) => {
      reads.pendingLabel = locale.quotaCard.resetPending;
      reads.accounts['account-a']!.rateLimits.primary!.resetsAt = now / 1000;
      reads.accounts['account-a']!.rateLimits.secondary!.resetsAt = now / 1000;
      const { container } = render(
        <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
          {details()}
        </ModelSourceUsageProvider>,
      );
      const line = container.querySelector('[data-model-source-details]')!;
      expect(screen.getAllByText(reads.pendingLabel)).toHaveLength(1);
      expect(line.getAttribute('title')).toBe(
        `account-a · Pro · ${reads.pendingLabel} · ${reads.pendingLabel}`,
      );
      const quota = line.lastElementChild!;
      expect(quota.className).toContain('max-w-[70%]');
      expect(quota.className).toContain('min-w-0');
      expect(quota.className).toContain('truncate');
      expect(quota.className).not.toContain('shrink-0');
    },
  );

  it('replaces an expired period with reset pending, never inferred full quota', () => {
    reads.accounts['account-a']!.rateLimits.primary!.resetsAt = now / 1000 + 1;
    reads.accounts['account-a']!.rateLimits.secondary = null;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('1秒 78%'))).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(reads.pendingLabel)).toBeTruthy();
    expect(screen.queryByText(/100%/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(screen.queryByText(reads.pendingLabel)).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('78%')).toBeNull();
  });

  it('keeps a live window at 0% used over a later window awaiting reset', () => {
    reads.accounts['account-a'] = snapshot(0);
    reads.accounts['account-a'].rateLimits.secondary!.resetsAt = now / 1000;
    render(
      <ModelSourceUsageProvider providers={[provider('account-a')]} scope={local}>
        {details()}
      </ModelSourceUsageProvider>,
    );
    expect(screen.getByText(quotaText('2小时 100%'))).toBeTruthy();
    expect(screen.queryByText(reads.pendingLabel)).toBeNull();
  });
});

// Unit/jsdom: real Kimi hook -> model row, with official API-key identity rather
// than the chosen execution engine. The other subscription mocks cannot cover it.
it('shows Kimi remaining quota on its own model source without borrowing Codex usage', async () => {
  const kimi = { ...provider('kimi-custom'), auth: { method: 'apiKey' }, routing: { pi: { upstream: 'https://api.kimi.com/coding/v1' } } } as ProviderView;
  const fetchUsage = vi.fn().mockResolvedValue({ status: 'ready', stale: false, snapshot: { kind: 'kimi-coding-quota', fetchedAt: now, windows: [{ id: 'limit_5h', usedPercent: 23, resetsAt: now + 7200000 }] } });
  Object.assign(window, { electronAPI: { maker: { fetchProviderAccountUsage: fetchUsage, onProvidersChanged: () => () => {} } } });
  const view = render(<ModelSourceUsageProvider providers={[kimi]} scope={local}>{details('kimi-custom', 'kimi-code')}</ModelSourceUsageProvider>);
  await act(async () => {});
  expect(screen.getByText(quotaText('2小时 77%'))).toBeTruthy();
  expect(view.container.textContent).not.toContain('Pro');
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  expect(reads.codex.mock.calls.some(([enabled]) => enabled)).toBe(false);
});

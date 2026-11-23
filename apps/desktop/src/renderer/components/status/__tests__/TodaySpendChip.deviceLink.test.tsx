// @vitest-environment jsdom

/**
 * TodaySpendChip 的 device-link 远程会话形态:
 *   - 显式 anthropic 的远程订阅会话:用被控端镜像快照按本机订阅形态渲染窗口段,
 *     悬停出同款额度卡(chip 不可点 —— 看板属被控端账号,不跳本机浏览器);
 *   - 被控端镜像不可用(老被控端 / 断链):降级回「仅会话金额 / ¥ 占位」;
 *   - 默认路由(providerId=null)的远程会话:不做本机启发式猜测,维持占位显示。
 */

import { act, cleanup, fireEvent, render as renderUI, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

function render(ui: ReactElement) {
  return renderUI(ui, { wrapper: ConfirmDialogProvider });
}

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';
import type { SessionUsageMoney } from '@/hooks/useSessionUsageMoney';
import type { ProviderView } from '@cindy/model-providers';

type TestProvider = Pick<ProviderView, 'id' | 'openAiAccount' | 'subscriptionAccount'> & {
  name?: string;
} & Partial<Pick<ProviderView, 'agents' | 'models' | 'routing' | 'connected' | 'suspended' | 'source'>> & {
  auth?: { native: string };
};

const mocks = vi.hoisted(() => ({
  codexAuthInjection: null as string | null,
  localProviders: [] as TestProvider[],
  deviceProviders: [] as TestProvider[],
  localProvidersLoading: false,
  deviceProvidersLoading: false,
  deviceProvidersError: null as string | null,
  remoteProviderIds: [] as Array<string | undefined>,
  localClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  localClaudeReadEnabled: [] as boolean[],
  localCodexReadKinds: [] as Array<string | undefined>,
  localCodexLimitsEnabled: [] as boolean[],
  remoteClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  remoteHookDeviceIds: [] as Array<string | null>,
  requestRemoteRefresh: vi.fn(),
  remoteRoute: null as 'gateway' | 'subscription' | null,
  remoteRouteDeviceIds: [] as Array<string | null>,
  remoteCodexPayload: null as Record<string, unknown> | null,
  remoteCodexDeviceIds: [] as Array<string | null>,
  remoteCodexLive: [] as boolean[],
  remoteCodexPoll: [] as (boolean | undefined)[],
  remoteCodexRefresh: vi.fn(),
  remoteClaudeQuota: null as Record<string, unknown> | null,
  remoteXaiSnapshot: null as Record<string, unknown> | null,
  openCodeUsageProviderIds: [] as Array<string | undefined>,
  openCodeUsageDeviceIds: [] as Array<string | null>,
  openCodeUsage: null as Record<string, unknown> | null,
  sessionUsage: {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  } as SessionUsageMoney,
  sessionTokens: null as number | null,
  displaySnapshot: {
    messages: [] as Array<Record<string, unknown>>,
  },
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      const templates: Record<string, string> = {
        'todaySpend.claude.weeklyLabel': '周限',
        'todaySpend.claude.modelWeeklyLabel': '{{model}} 周限',
        'todaySpend.claude.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.codex.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.codex.weekWindow': '周限',
        'todaySpend.codex.limitWindow': '限额',
        'todaySpend.codex.daysWindow': '{{days}}天',
        'todaySpend.xai.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.xai.weekWindow': '周限',
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.sessionCostLabel': '本任务 {{cost}}',
        'todaySpend.codex.sessionValueLabel': '本任务价值 {{cost}}',
        'todaySpend.codex.sessionTokensLine': '本任务已用 {{tokens}} token',
        'todaySpend.codex.noUsageLabel': '暂无用量',
        'todaySpend.codex.noUsageDetail': '本任务尚未产生用量。',
        'todaySpend.codex.unavailableLabel': '用量暂不可用',
        'todaySpend.codex.unavailableDetail': '用量数据暂时不可用。',
        'todaySpend.dailyLimitLabel': '今日 {{spend}}/{{limit}}',
        'todaySpend.monthlyLimitLabel': '本月 {{spend}}/{{limit}}',
        'todaySpend.creditLabel': '额度 {{used}}/{{total}}',
        'quotaCard.fiveHourLabel': '5 小时',
        'quotaCard.weeklyLabel': '周限',
        'quotaCard.modelWeeklyLabel': '{{model}} 周限',
        'quotaCard.usedPercent': '已用 {{percent}}%',
        'quotaCard.waiting': '等待额度数据',
      };
      return (templates[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
        String(options[name] ?? ''),
      );
    },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({
  providers: mocks.localProviders.map(provider => ({ agents: [], routing: {}, models: {}, connected: false, ...provider })),
  loading: mocks.localProvidersLoading, error: null,
}) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({
  providers: mocks.deviceProviders.map(provider => ({ agents: [], routing: {}, models: {}, connected: false, ...provider })),
  loading: mocks.deviceProvidersLoading, error: mocks.deviceProvidersError,
}) }));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: false, isReconciling: false }),
}));
vi.mock('@/hooks/useClaudeOAuthConnected', () => ({
  useClaudeOAuthConnected: () => null,
}));
vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: () => null,
}));
vi.mock('@/hooks/useSessionUsageMoney', () => ({
  useSessionUsageMoney: () => mocks.sessionUsage,
}));
vi.mock('@/hooks/useSessionTokens', () => ({ useSessionTokens: () => mocks.sessionTokens }));
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAccountUsage')>();
  return {
    // 选槽 / 选桶纯函数用真实实现(selectRemoteCodexAccountUsage 依赖同一口径)。
    ...actual,
    requestCodexAccountRefresh: vi.fn(),
    useAccountUsage: (_sessionId?: string, kind?: string) => {
      mocks.localCodexReadKinds.push(kind);
      return null;
    },
  };
});
vi.mock('@/hooks/useProviderAccountUsage', () => ({
  useProviderAccountUsage: (
    provider: { id: string } | undefined,
    _agent?: string,
    deviceId: string | null = null,
  ) => {
    mocks.openCodeUsageProviderIds.push(provider?.id);
    mocks.openCodeUsageDeviceIds.push(deviceId);
    return provider && mocks.openCodeUsage
      ? { supported: true, result: mocks.openCodeUsage, busy: false, refresh: vi.fn() }
      : { supported: false, result: null, busy: false, refresh: vi.fn() };
  },
}));
vi.mock('@/hooks/useClaudeAccountUsage', () => ({ useClaudeAccountUsage: () => null }));
vi.mock('@/hooks/useModelAccessCreditUsage', () => ({ useModelAccessCreditUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: (enabled: boolean) => {
    mocks.localClaudeReadEnabled.push(enabled);
    return enabled ? mocks.localClaudeSnapshot : null;
  },
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  requestRemoteClaudeSubscriptionRefresh: mocks.requestRemoteRefresh,
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
    mocks.remoteProviderIds.push(providerId);
    mocks.remoteHookDeviceIds.push(deviceId);
    return deviceId ? mocks.remoteClaudeSnapshot : null;
  },
}));
vi.mock('@/hooks/useRemoteClaudeSessionRoute', () => ({
  useRemoteClaudeSessionRoute: (deviceId: string | null) => {
    mocks.remoteRouteDeviceIds.push(deviceId);
    return deviceId ? mocks.remoteRoute : null;
  },
}));
vi.mock('@/hooks/useRemoteDeviceUsage', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRemoteDeviceUsage')>(
    '@/hooks/useRemoteDeviceUsage',
  );
  return {
    // selectRemoteCodexAccountUsage 用真实实现(纯函数,选槽口径与本机一致)。
    selectRemoteCodexAccountUsage: actual.selectRemoteCodexAccountUsage,
    requestRemoteCodexAccountRefresh: vi.fn(),
    requestRemoteXaiSubscriptionRefresh: vi.fn(),
    requestRemoteCodexLiveRefresh: mocks.remoteCodexRefresh,
    useRemoteCodexRefreshState: () => ({ failed: false, refreshing: false }),
    useRemoteCodexAccountUsage: (deviceId: string | null, _provider?: string, options?: { live?: boolean; poll?: boolean }) => {
      mocks.remoteCodexLive.push(options?.live === true);
      mocks.remoteCodexPoll.push(options?.poll);
      mocks.remoteCodexDeviceIds.push(deviceId);
      return deviceId ? mocks.remoteCodexPayload : null;
    },
    useRemoteClaudeAccountUsage: (deviceId: string | null) =>
      deviceId ? mocks.remoteClaudeQuota : null,
    useRemoteXaiSubscriptionUsage: (deviceId: string | null) =>
      deviceId ? mocks.remoteXaiSnapshot : null,
    useRemoteXaiRateLimit: () => null,
  };
});
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: mocks.codexAuthInjection }),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({
  useCodexRateLimits: (enabled: boolean) => {
    mocks.localCodexLimitsEnabled.push(enabled);
    return { snapshot: null, refresh: vi.fn() };
  },
}));
vi.mock('@/hooks/useXaiRateLimit', () => ({ useXaiRateLimit: () => null }));
vi.mock('@/components/chat/ChatDisplaySnapshotContext', () => ({
  useChatDisplaySnapshot: () => mocks.displaySnapshot,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: () => mocks.displaySnapshot,
    subscribe: () => () => undefined,
  },
}));

import { TodaySpendChip } from '../TodaySpendChip';
import { sessionSubscriptionPoolProvider, SessionSubscriptionAccountProvider } from '@/components/new-chat/SessionSubscriptionAccount';

function renderRemoteChip(providerId: string | null) {
  return render(
    <TodaySpendChip
      vendorKey="cc"
      providerId={providerId}
      modelId="claude-fable-5[1m]"
      sessionId="session-remote-1"
      deviceLinkDeviceId="device-abc"
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.codexAuthInjection = null;
  mocks.localProviders = [];
  mocks.deviceProviders = [];
  mocks.localProvidersLoading = false;
  mocks.deviceProvidersLoading = false;
  mocks.deviceProvidersError = null;
  mocks.remoteProviderIds = [];
  mocks.localClaudeSnapshot = null;
  mocks.localClaudeReadEnabled = [];
  mocks.localCodexReadKinds = [];
  mocks.localCodexLimitsEnabled = [];
  mocks.remoteClaudeSnapshot = null;
  mocks.remoteHookDeviceIds = [];
  mocks.remoteRoute = null;
  mocks.remoteRouteDeviceIds = [];
  mocks.remoteCodexPayload = null;
  mocks.remoteCodexDeviceIds = [];
  mocks.remoteCodexLive = [];
  mocks.remoteCodexPoll = [];
  mocks.remoteCodexRefresh.mockClear();
  mocks.remoteClaudeQuota = null;
  mocks.remoteXaiSnapshot = null;
  mocks.openCodeUsageProviderIds = [];
  mocks.openCodeUsageDeviceIds = [];
  mocks.openCodeUsage = null;
  mocks.sessionUsage = {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  };
  mocks.sessionTokens = null;
  mocks.displaySnapshot.messages = [];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal: mocks.openExternal },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TodaySpendChip device-link remote sessions', () => {
  it('显式 anthropic 远程会话用被控端镜像快照渲染订阅窗口段(与本机形态一致)', () => {
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 25 },
      scoped: [{ modelDisplayName: 'Fable', utilization: 34 }],
    };

    const { container } = renderRemoteChip('anthropic');

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(container.textContent).toContain('Fable 周限 剩余 66%');
    // 远程订阅会话读的是被控端镜像 hook(deviceId 透传),不读本机快照。
    expect(mocks.remoteHookDeviceIds).toContain('device-abc');
    // Account-ownership regression (unit): replaces the old source-string
    // gate assertion with an actual remote render and its local reader input.
    expect(mocks.localClaudeReadEnabled.length).toBeGreaterThan(0);
    expect(mocks.localClaudeReadEnabled.every(enabled => !enabled)).toBe(true);
  });

  it('renders remote OpenCode Go rolling, weekly, and monthly meters independently', () => {
    mocks.deviceProviders = [{
      id: 'opencode-go',
      connected: true,
      suspended: false,
      auth: { method: 'apiKey' },
      routing: {},
      opencodeGoUsageAgents: ['codex'],
    } as unknown as TestProvider];
    mocks.openCodeUsage = {
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'opencode-go-quota',
        fetchedAt: Date.now(),
        windows: [
          { id: 'rolling', usedPercent: 10, limited: false, resetsAt: null },
          { id: 'weekly', usedPercent: 45, limited: false, resetsAt: null },
          { id: 'monthly', usedPercent: 65, limited: false, resetsAt: null },
        ],
      },
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="codex"
        providerId="opencode-go"
        modelId="opencode-go/kimi-k2"
        sessionId="session-remote-opencode-go"
        deviceLinkDeviceId="device-opencode-go"
      />,
    );

    expect(mocks.openCodeUsageProviderIds).toContain('opencode-go');
    expect(mocks.openCodeUsageDeviceIds).toContain('device-opencode-go');
    expect(container.textContent).toContain('90%');
    expect(container.textContent).toContain('55%');
    expect(container.textContent).toContain('35%');
  });

  it('远程订阅会话悬停出额度卡,chip 不可点(看板属被控端账号)', () => {
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };

    renderRemoteChip('anthropic');

    // #3972 起 trigger 统一为按钮(打开额度卡);「不可点」= 无看板链接:aria-label 回落
    // 通用标题、点击不打开外链、卡片里没有看板按钮(看板属被控端账号,不跳本机浏览器)。
    const trigger = screen.getByRole('button', { name: 'quotaCard.usageTitle' });
    expect(trigger.textContent).toContain('5h 剩余 88%');
    fireEvent.click(trigger);
    expect(mocks.openExternal).not.toHaveBeenCalled();

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(300));
    const card = screen.getByTestId('quota-hover-card');
    expect(within(card).queryByRole('button')).toBeNull();
    // 额度卡用被控端镜像快照渲染同一套窗口进度条。
    expect(within(card).queryAllByRole('progressbar').length).toBeGreaterThan(0);
  });

  it('被控端镜像不可用(老被控端 / 断链)时降级回 ¥ 占位', () => {
    mocks.remoteClaudeSnapshot = null;

    const { container } = renderRemoteChip('anthropic');

    expect(container.textContent).not.toContain('剩余');
    // 占位货币符号分区域('¥' / '$'),断言形态不锁定具体符号。
    expect(container.textContent).toMatch(/[¥$]/);
  });

  it('默认路由(providerId=null)且被控端无路由观察值时维持占位,不做本机启发式猜测', () => {
    // 即使本机自己连了订阅、有本机快照,也不得替被控端会话渲染本机余量。
    mocks.localClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 34 },
    };
    mocks.remoteRoute = null;

    const { container } = renderRemoteChip(null);

    expect(container.textContent).not.toContain('剩余');
    // 无路由观察值 → 订阅镜像 hook 不启用(deviceId 恒为 null),但路由镜像已在探测。
    expect(mocks.remoteHookDeviceIds.filter(Boolean)).toHaveLength(0);
    expect(mocks.remoteRouteDeviceIds).toContain('device-abc');
  });

  it('默认路由远程会话按被控端路由观察值解析形态(subscription → 订阅窗口段)', () => {
    mocks.remoteRoute = 'subscription';
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };

    const { container } = renderRemoteChip(null);

    expect(container.textContent).toContain('5h 剩余 88%');
  });

  it('默认路由远程会话路由观察值为 gateway 时按网关形态渲染被控端配额镜像', () => {
    mocks.remoteRoute = 'gateway';
    mocks.localProviders = [{ id: 'xd', name: 'Cindy AI · 个人' }];
    mocks.deviceProviders = [{ id: 'xd', name: 'Cindy AI · 心动' }];
    mocks.remoteClaudeQuota = {
      spend: 120,
      maxBudget: 3000,
      currency: 'CNY',
      todaySpend: 12,
    };

    const { container } = renderRemoteChip(null);

    // 网关形态主 chip 显示今日额度(月度进 tooltip),数据来自被控端 LiteLLM 镜像。
    expect(container.textContent).toContain('今日');
    expect(container.textContent).not.toContain('剩余 ');
    fireEvent.click(screen.getByRole('button', { name: 'quotaCard.usageTitle' }));
    expect(screen.getByText('Cindy AI · 心动')).toBeTruthy();
    expect(screen.queryByText('Cindy AI · 个人')).toBeNull();
  });

  it('远程 codex 会话按订阅形态渲染被控端账号窗口(组合 payload 选桶)', () => {
    mocks.localProviders = [
      {
        id: 'openai',
        auth: { native: 'codex' },
        openAiAccount: { source: 'oauth', identity: 'local@example.com' },
      },
    ];
    mocks.deviceProviders = [
      {
        id: 'openai',
        auth: { native: 'codex' },
        openAiAccount: { source: 'oauth', identity: 'remote@example.com' },
      },
    ];
    mocks.remoteCodexPayload = {
      source: 'codex-app-server',
      limitId: 'codex',
      primary: { usedPercent: 12, windowMinutes: 300 },
      secondary: { usedPercent: 34, windowMinutes: 10_080 },
      appServerBuckets: {
        codex: {
          source: 'codex-app-server',
          limitId: 'codex',
          primary: { usedPercent: 12, windowMinutes: 300 },
          secondary: { usedPercent: 34, windowMinutes: 10_080 },
        },
      },
      webSnapshot: null,
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="codex"
        providerId="openai"
        modelId="gpt-5.6-sol"
        sessionId="session-remote-codex"
        deviceLinkDeviceId="device-abc"
      />,
    );

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(container.textContent).toContain('7天 剩余 66%');
    expect(mocks.remoteCodexDeviceIds).toContain('device-abc');
    // Neither native quota path may read the controller's own Codex account.
    expect(mocks.localCodexReadKinds.length).toBeGreaterThan(0);
    expect(mocks.localCodexReadKinds).not.toContain('codex');
    expect(mocks.localCodexLimitsEnabled.length).toBeGreaterThan(0);
    expect(mocks.localCodexLimitsEnabled.every(enabled => !enabled)).toBe(true);
    fireEvent.mouseEnter(screen.getByRole('button'));
    act(() => vi.advanceTimersByTime(300));
    expect(mocks.remoteCodexLive).toContain(true);
    expect(mocks.remoteCodexPoll.every(value => value === false)).toBe(true);
    expect(mocks.remoteCodexRefresh).toHaveBeenCalledWith('device-abc', 'openai');
    expect(screen.getByText('remote@example.com')).toBeTruthy();
    expect(screen.queryByText('local@example.com')).toBeNull();
  });

  it('窗口刚重置时倒计时以窗口长度封顶,不显示「8天」', () => {
    // resetsAt 比 now + 窗口长度晚 30 秒(服务端取整 / 时钟偏差)
    const nowSec = Date.now() / 1000;
    const bucket = {
      source: 'codex-app-server',
      limitId: 'codex',
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: nowSec + 5 * 3600 + 30 },
      secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: nowSec + 7 * 86400 + 30 },
    };
    mocks.remoteCodexPayload = { ...bucket, appServerBuckets: { codex: bucket }, webSnapshot: null };

    const { container } = render(
      <TodaySpendChip
        vendorKey="codex"
        providerId="openai"
        modelId="gpt-5.6-sol"
        sessionId="session-remote-codex-reset"
        deviceLinkDeviceId="device-abc"
      />,
    );

    expect(container.textContent).toContain('5小时 剩余 90%');
    expect(container.textContent).toContain('7天 剩余 80%');
    expect(container.textContent).not.toContain('8天');
  });

  it('xai 重置时间可能是非周账期,倒计时不按 7 天封顶', () => {
    mocks.remoteXaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 25,
      resetsAt: Date.now() / 1000 + 25 * 86400,
      updatedAt: Date.now(),
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="xai"
        modelId="grok-4.6"
        sessionId="session-remote-xai-period"
        deviceLinkDeviceId="device-abc"
      />,
    );

    expect(container.textContent).toContain('25天 剩余 75%');
  });

  it('远程 codex 折扣模型(codex/)按网关形态渲染,不显示订阅窗口', () => {
    mocks.remoteCodexPayload = {
      source: 'codex-app-server',
      primary: { usedPercent: 12, windowMinutes: 300 },
    };
    mocks.remoteClaudeQuota = {
      spend: 8,
      maxBudget: 10_000,
      currency: 'CNY',
      todaySpend: 0.5,
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="codex"
        providerId={null}
        modelId="codex/gpt-5.5"
        sessionId="session-remote-codex-budget"
        deviceLinkDeviceId="device-abc"
      />,
    );

    expect(container.textContent).toContain('今日');
    expect(container.textContent).not.toContain('剩余 88%');
  });

  it('远程 xai 会话按周用量形态渲染被控端镜像', () => {
    mocks.remoteXaiSnapshot = {
      planLabel: 'SuperGrok',
      creditUsagePercent: 25,
      resetsAt: null,
      updatedAt: Date.now(),
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="xai"
        modelId="grok-4.6"
        sessionId="session-remote-xai"
        deviceLinkDeviceId="device-abc"
      />,
    );

    expect(container.textContent).toContain('剩余 75%');
  });
});


// 远程 Agent:Agent 在另一台电脑上用那台的登录运行,余量读那台(2026-10-09 用户反馈:远程供应商
// 的任务一直「等待配额数据更新」—— chip 拿任务所在电脑的同名账号去读)。
describe('TodaySpendChip remote Agent account', () => {
  const agentSnapshot: ClaudeSubscriptionUsageSnapshot = {
    source: 'oauth-endpoint',
    fiveHour: { utilization: 12 },
    sevenDay: { utilization: 25 },
  };

  it('本机任务的 Agent 在另一台电脑:读那台的镜像,不读本机同名账号', () => {
    mocks.localClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 90 } };
    mocks.remoteClaudeSnapshot = agentSnapshot;

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="anthropic"
        modelId="claude-fable-5[1m]"
        sessionId="session-local-remote-agent"
        usageAccount={{ kind: 'device', deviceId: 'device-agent' }}
      />,
    );

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(container.textContent).not.toContain('剩余 10%');
    expect(mocks.remoteHookDeviceIds).toContain('device-agent');
  });

  it('远程控制的任务把 Agent 放在第三台电脑:读第三台,不读被控电脑', () => {
    mocks.remoteClaudeSnapshot = agentSnapshot;

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="anthropic"
        modelId="claude-fable-5[1m]"
        sessionId="session-controlled-remote-agent"
        deviceLinkDeviceId="device-abc"
        usageAccount={{ kind: 'device', deviceId: 'device-agent' }}
      />,
    );

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(mocks.remoteHookDeviceIds.filter(Boolean)).toEqual(
      expect.arrayContaining(['device-agent']),
    );
    expect(mocks.remoteHookDeviceIds).not.toContain('device-abc');
  });

  it('远程 Agent 的 codex 账号同样读那台', () => {
    mocks.remoteCodexPayload = {
      source: 'codex-app-server',
      limitId: 'codex',
      primary: { usedPercent: 12, windowMinutes: 300 },
      appServerBuckets: {
        codex: {
          source: 'codex-app-server',
          limitId: 'codex',
          primary: { usedPercent: 12, windowMinutes: 300 },
        },
      },
      webSnapshot: null,
    };

    const { container } = render(
      <TodaySpendChip
        vendorKey="codex"
        providerId="openai"
        modelId="gpt-5.6-sol"
        sessionId="session-remote-agent-codex"
        usageAccount={{ kind: 'device', deviceId: 'device-agent' }}
      />,
    );

    expect(container.textContent).toContain('剩余 88%');
    expect(mocks.remoteCodexDeviceIds).toContain('device-agent');
  });

  it('远程控制的任务把 Agent 放在本机:读本机账号', () => {
    mocks.localProviders = [{ id: 'anthropic', auth: { native: 'claude' } }];
    mocks.localClaudeSnapshot = agentSnapshot;
    mocks.remoteClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 90 } };

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="anthropic"
        modelId="claude-fable-5[1m]"
        sessionId="session-controlled-agent-here"
        deviceLinkDeviceId="device-abc"
        usageAccount={{ kind: 'local' }}
      />,
    );

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(mocks.remoteHookDeviceIds.filter(Boolean)).toHaveLength(0);
  });

  it('读不到那份账号(分享来的供应商等):只显示任务价值,不等数据、不拿别的账号凑数', () => {
    mocks.localClaudeSnapshot = agentSnapshot;
    mocks.remoteClaudeSnapshot = agentSnapshot;

    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="anthropic"
        modelId="claude-fable-5[1m]"
        sessionId="session-shared-provider"
        usageAccount={{ kind: 'unreadable' }}
      />,
    );

    expect(container.textContent).not.toContain('剩余');
    expect(mocks.remoteHookDeviceIds.filter(Boolean)).toHaveLength(0);
    const trigger = screen.getByRole('button', { name: 'quotaCard.usageTitle' });
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(300));
    const card = screen.getByTestId('quota-hover-card');
    expect(card.textContent).not.toContain('等待额度数据');
    expect(within(card).queryAllByRole('progressbar')).toHaveLength(0);
  });
});

describe('existing UI with remote account data', () => {
  it('renders the same subscription label and classes for identical local and remote data', () => {
    const snapshot: ClaudeSubscriptionUsageSnapshot = {
      source: 'oauth-endpoint', fiveHour: { utilization: 12 }, sevenDay: { utilization: 25 },
    };
    mocks.localClaudeSnapshot = snapshot;
    mocks.remoteClaudeSnapshot = snapshot;
    const local = render(<TodaySpendChip vendorKey="cc" providerId="anthropic" modelId="claude-fable-5[1m]" />);
    const label = local.container.textContent;
    const className = local.container.querySelector('button')?.className;
    local.unmount();
    const remote = renderRemoteChip('anthropic');
    expect(remote.container.textContent).toBe(label);
    expect(remote.container.querySelector('button')?.className).toBe(className);
  });

  it.each(['cc', 'pi', 'codex'] as const)('reads the selected remote Claude account for %s', vendorKey => {
    mocks.deviceProviders = [{ id: 'second-account', auth: { native: 'claude' } }];
    // Same id on the controller belongs to a different vendor and must be ignored.
    mocks.localProviders = [{ id: 'second-account', auth: { native: 'xai' } }];
    mocks.remoteClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 12 } };
    const { container } = render(<TodaySpendChip vendorKey={vendorKey} providerId="second-account"
      modelId="claude-fable-5[1m]" deviceLinkDeviceId="device-abc" />);
    expect(container.textContent).toContain('5h 剩余 88%');
    expect(mocks.remoteProviderIds).toContain('second-account');
  });
});

// 2026-11-11 user report (unit/jsdom): with several subscription accounts, the usage under the
// composer showed the CLI default account (this computer) or the next pool pick (a provider-group
// computer), not the account the task is pinned to. Existing chip cases have one account per
// provider. Minimal input: the default/next pick at 90% 5h used, the task's account at 30%.
describe('TodaySpendChip on a subscription account pool', () => {
  // #10111 (unit): old null-route tasks already have a real second-account binding.
  // Existing cases always name the provider, bypassing both null-route gates.
  it.each(['oauth-bearer', null, 'env-key', 'provider-oauth'])(
    'shows the bound second account independently of the default host (%s)', async injection => {
    mocks.codexAuthInjection = injection;
    const sessionAccount = vi.fn().mockResolvedValue({
      providerId: 'openai', state: 'bound', account: {
        isDefault: false, number: 2, identity: 'second@example.test', paused: false, status: 'ready',
        usage: { codex: { credits: null, buckets: { codex: {
          updatedAt: Date.now(), primary: { usedPercent: 30, windowMinutes: 300, resetsAt: null },
          secondary: null,
        } } } },
      },
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      openExternal: mocks.openExternal,
      subscriptionAccounts: { sessionAccount, onChanged: () => () => {} },
    } });
    const { container } = render(
      <SessionSubscriptionAccountProvider
        providerId={sessionSubscriptionPoolProvider('codex', null, null, undefined, true, { modelId: 'gpt-6.1-sol', providers: [], catalogReady: true })}
        routeProviderId={null} deviceId={null} sessionId="legacy-null-10111" nativeSessionId="native-10111">
        <TodaySpendChip vendorKey="codex" providerId={null} modelId="gpt-6.1-sol" sessionId="legacy-null-10111" />
      </SessionSubscriptionAccountProvider>,
    );
    await act(async () => {});
    expect(container.textContent).toContain('5h 剩余 70%');
    expect(sessionAccount).toHaveBeenCalledExactlyOnceWith({
      action: 'session', providerId: 'openai', sessionId: 'legacy-null-10111', nativeSessionId: 'native-10111',
    });
    fireEvent.mouseEnter(screen.getAllByRole('button')[0]);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId('quota-hover-card').textContent).toContain('second@example.test');
  });

  it.each([
    { name: 'explicit gateway', providerId: 'xd', injection: 'env-key', model: 'gpt-6.1-sol', remoteHostId: undefined },
    { name: 'provider OAuth source', providerId: 'custom-oauth', injection: 'provider-oauth', model: 'gpt-6.1-sol', remoteHostId: undefined },
    { name: 'gateway model', providerId: null, injection: 'oauth-bearer', model: 'codex/gpt-5.5', remoteHostId: undefined },
    { name: 'custom', providerId: 'custom', injection: 'oauth-bearer', model: 'gpt-6.1-sol', remoteHostId: undefined },
    { name: 'SSH', providerId: null, injection: 'oauth-bearer', model: 'gpt-6.1-sol', remoteHostId: 'ssh' },
  ])('does not expose the probed account to $name', async ({ providerId, injection, model, remoteHostId }) => {
    mocks.codexAuthInjection = injection;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      openExternal: mocks.openExternal,
      subscriptionAccounts: { sessionAccount: async () => ({
        providerId: 'openai', state: 'bound', account: {
          isDefault: false, number: 2, identity: 'private@example.test', paused: false, status: 'ready',
          usage: { codex: { credits: null, buckets: { codex: {
            primary: { usedPercent: 30, windowMinutes: 300, resetsAt: null }, secondary: null,
          } } } },
        },
      }), onChanged: () => () => {} },
    } });
    const { container } = render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
      deviceId={null} sessionId={'negative-' + injection + model} nativeSessionId="native-negative">
      <TodaySpendChip vendorKey="codex" providerId={providerId} modelId={model} remoteHostId={remoteHostId} />
    </SessionSubscriptionAccountProvider>);
    await act(async () => {});
    expect(container.textContent).not.toContain('70%');
    expect(container.textContent).not.toContain('private@example.test');
  });

  it.each(['legacy', 'unassigned', 'unavailable'] as const)(
    'does not classify an unknown null-route binding as OAuth (%s)', async state => {
      mocks.codexAuthInjection = 'env-key';
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
        openExternal: mocks.openExternal,
        subscriptionAccounts: { sessionAccount: async () => ({ providerId: 'openai', state }),
          onChanged: () => () => {} },
      } });
      const { container } = render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
        deviceId={null} sessionId={'unknown-' + state} nativeSessionId="native-unknown">
        <TodaySpendChip vendorKey="codex" providerId={null} modelId="gpt-6.1-sol" />
      </SessionSubscriptionAccountProvider>);
      await act(async () => {});
      expect(container.textContent).not.toContain('5h');
      expect(mocks.localCodexReadKinds.some(kind => kind === 'codex')).toBe(false);
    });

  // #11192 review (unit): a stale OpenAI binding cannot override the same
  // connected effective-source choice used by the executor. The controller's
  // catalog must not decide a task running on another computer.
  it.each([
    { name: 'local custom', source: 'custom', deviceId: null, loading: false, error: null, shows: false },
    { name: 'local gateway', source: 'xd', deviceId: null, loading: false, error: null, shows: false },
    { name: 'remote custom', source: 'custom', deviceId: 'peer', loading: false, error: null, shows: false },
    { name: 'remote OpenAI', source: 'openai', deviceId: 'peer', loading: false, error: null, shows: true },
    { name: 'loading local catalog', source: 'openai', deviceId: null, loading: true, error: null, shows: false },
    { name: 'loading remote catalog', source: 'openai', deviceId: 'peer', loading: true, error: null, shows: false },
    { name: 'failed remote catalog', source: 'openai', deviceId: 'peer', loading: false, error: 'offline', shows: false },
  ])('review10111: preserves the effective source for $name', async ({ source, deviceId, loading, error, shows }) => {
    const provider = (id: string): TestProvider => ({ id, source: id === 'openai' || id === 'xd' ? 'builtin' : 'user',
      connected: true, agents: ['codex'], routing: { codex: { upstream: 'https://example.test', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'custom-model', name: 'model', contextWindow: 200000, efforts: [], defaultEffort: null }] },
    });
    mocks.localProviders = [provider(deviceId ? (source === 'openai' ? 'custom' : 'openai') : source)];
    mocks.deviceProviders = [provider(source)];
    mocks.localProvidersLoading = !deviceId && loading;
    mocks.deviceProvidersLoading = !!deviceId && loading;
    mocks.deviceProvidersError = error;
    const reply = { providerId: 'openai', state: 'bound', account: {
      isDefault: false, number: 2, identity: 'bound@example.test', paused: false, status: 'ready',
      usage: { codex: { credits: null, buckets: { codex: {
        primary: { usedPercent: 30, windowMinutes: 300, resetsAt: null }, secondary: null,
      } } } },
    } };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      openExternal: mocks.openExternal, deviceLink: { invoke: async () => reply, onPresenceChanged: () => () => {}, onStatusChanged: () => () => {} },
      subscriptionAccounts: { sessionAccount: async () => reply, onChanged: () => () => {} },
    } });
    const { container } = render(<SessionSubscriptionAccountProvider providerId="openai" routeProviderId={null}
      deviceId={deviceId} sessionId={'source-' + source + deviceId + loading + error} nativeSessionId="source-native">
      <TodaySpendChip vendorKey="codex" providerId={null} modelId="custom-model[1m]"
        usageAccount={deviceId ? { kind: 'device', deviceId } : { kind: 'task' }} />
    </SessionSubscriptionAccountProvider>);
    await act(async () => {});
    expect(container.textContent?.includes('5h 剩余 70%')).toBe(shows);
    if (shows) {
      fireEvent.mouseEnter(screen.getAllByRole('button')[0]);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByTestId('quota-hover-card').textContent).toContain('bound@example.test');
    } else {
      expect(container.textContent).not.toContain('bound@example.test');
    }
  });

  // PR #9918 review (unit): a ChatGPT bridge consumes the pinned account's
  // model bucket. A depleted generic bucket must not replace that model's 70%.
  it.each([true, false])('uses the bridge model native bucket (generic bucket present: %s)', async (generic) => {
    mocks.localProviders = [{ id: 'openai', auth: { native: 'codex' } }];
    const bucket = (usedPercent: number, limitId: string, limitName: string | null) => ({
      limitId, limitName, updatedAt: Date.now(),
      primary: { usedPercent, windowMinutes: 300, resetsAt: null }, secondary: null,
    });
    const reply = {
      providerId: 'openai', state: 'bound', account: {
        isDefault: false, number: 2, paused: false, status: 'ready',
        usage: { codex: { credits: null, buckets: {
          ...(generic ? { codex: bucket(100, 'codex', null) } : {}),
          spark: bucket(30, 'spark', 'GPT-5.3-Codex-Spark'),
        } } },
      },
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      openExternal: mocks.openExternal,
      subscriptionAccounts: { sessionAccount: async () => reply, onChanged: () => () => {} },
    } });
    const { container } = render(
      <SessionSubscriptionAccountProvider providerId="openai" deviceId={null} sessionId={`pool-bridge-${generic}`} nativeSessionId={`sdk-bridge-${generic}`}>
        <TodaySpendChip vendorKey="cc" providerId="openai" modelId="chatgpt/gpt-5.3-codex-spark" sessionId={`pool-bridge-${generic}`} />
      </SessionSubscriptionAccountProvider>,
    );
    await act(async () => {});
    expect(container.textContent).toContain('5h 剩余 70%');
    expect(container.textContent).not.toContain('剩余 0%');
  });

  it.each([
    { where: 'this computer', deviceId: null },
    { where: 'a provider-group computer', deviceId: 'device-abc' },
  ])('shows the task account and its quota on $where', async ({ deviceId }) => {
    const reply = {
      providerId: 'anthropic',
      state: 'bound',
      account: {
        isDefault: false, number: 2, identity: 'b@example.test', paused: false, status: 'ready',
        usage: { claude: { source: 'oauth-endpoint', fiveHour: { utilization: 30 } } },
      },
    };
    const defaultAccount = { id: 'anthropic', subscriptionAccount: { source: 'local' as const, identity: 'a@example.test' } };
    mocks.localProviders = [defaultAccount];
    mocks.deviceProviders = [defaultAccount];
    mocks.localClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 90 } };
    mocks.remoteClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 90 } };
    const sessionAccount = vi.fn().mockResolvedValue(reply);
    const invoke = vi.fn().mockResolvedValue(reply);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal: mocks.openExternal,
        subscriptionAccounts: { sessionAccount, onChanged: () => () => {} },
        deviceLink: { invoke, onPresenceChanged: () => () => {}, onStatusChanged: () => () => {} },
      },
    });
    const { container } = render(
      <SessionSubscriptionAccountProvider providerId="anthropic" deviceId={deviceId} sessionId="session-pool" nativeSessionId={`sdk-${deviceId}`}>
        <TodaySpendChip vendorKey="cc" providerId="anthropic" modelId="claude-fable-5[1m]" sessionId="session-pool"
          {...(deviceId ? { deviceLinkDeviceId: deviceId } : {})} />
      </SessionSubscriptionAccountProvider>,
    );
    // While the executing computer is asked, the other account's quota is not shown.
    expect(container.textContent).not.toContain('10%');
    await act(async () => {});
    expect(container.textContent).toContain('5h 剩余 70%');
    expect(container.textContent).not.toContain('10%');
    fireEvent.mouseEnter(screen.getAllByRole('button')[0]);
    act(() => vi.advanceTimersByTime(300));
    const card = screen.getByTestId('quota-hover-card');
    expect(card.textContent).toContain('b@example.test');
    expect(card.textContent).not.toContain('a@example.test');
    expect(deviceId ? invoke : sessionAccount).toHaveBeenCalled();
  });

  // 2026-11-11 user report on a real group: the executing Mac ran an older build without the
  // task-account action, so the chip fell back to the default-account read (its first account,
  // weekly 0% left) while the task was pinned elsewhere. Older hosts (2026-11-07+) still answer
  // the reset lookup's native-session scope; it must be used instead of the default read.
  it.each(['anthropic', 'openai'] as const)('reads the %s task account through the native-session scope on an older executing computer', async (providerId) => {
    const claude = providerId === 'anthropic';
    const channel = claude ? 'maker:usage:claude-subscription' : 'maker:usage:account';
    mocks.deviceProviders = [{ id: providerId, subscriptionAccount: { source: 'local', identity: 'a@example.test' } }];
    mocks.remoteClaudeSnapshot = { source: 'oauth-endpoint', fiveHour: { utilization: 90 } };
    mocks.remoteCodexPayload = { primary: { usedPercent: 90, windowMinutes: 300 } };
    const invoke = vi.fn(async (_device: string, requestedChannel: string, args: unknown[]) => {
      if (requestedChannel === 'maker:subscription-accounts') throw new Error('[INVALID_PARAMS] Invalid account command');
      if (requestedChannel === channel && (args[2] as { subscriptionSessionId?: string })?.subscriptionSessionId === 'sdk-on-mac')
        return claude
          ? { providerId, fiveHour: { utilization: 30 } }
          : { providerId, primary: { usedPercent: 30, windowMinutes: 300, resetsAt: null } };
      return null;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal: mocks.openExternal,
        subscriptionAccounts: { onChanged: () => () => {} },
        deviceLink: { invoke, onPresenceChanged: () => () => {}, onStatusChanged: () => () => {} },
      },
    });
    const { container } = render(
      <SessionSubscriptionAccountProvider providerId={providerId} deviceId="mac-mini" sessionId="task-1" nativeSessionId="sdk-on-mac">
        <TodaySpendChip vendorKey={claude ? 'cc' : 'codex'} providerId={providerId} modelId={claude ? 'claude-opus-5-5' : 'gpt-5.5'} sessionId="task-1"
          usageAccount={{ kind: 'device', deviceId: 'mac-mini' }} />
      </SessionSubscriptionAccountProvider>,
    );
    await act(async () => {});
    expect(container.textContent).toContain('5h 剩余 70%');
    expect(container.textContent).not.toContain('10%');
    expect(invoke).toHaveBeenCalledWith('mac-mini', channel,
      [claude ? providerId : 'codex', claude ? false : providerId, { subscriptionSessionId: 'sdk-on-mac' }]);
    // 2026-11 field logs: the refused task-account query was re-sent every refresh (~1500 times in
    // two days). Once refused as unknown, later refreshes go straight to the native-session read.
    const accountQueries = () => invoke.mock.calls.filter(([, requested]) => requested === 'maker:subscription-accounts').length;
    const legacyReads = () => invoke.mock.calls.filter(([, requested]) => requested === channel).length;
    const queriesBefore = accountQueries(), readsBefore = legacyReads();
    expect(queriesBefore).toBeLessThanOrEqual(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(accountQueries()).toBe(queriesBefore);
    expect(legacyReads()).toBeGreaterThan(readsBefore);
    // The default account's name is not shown for an account it could not name.
    fireEvent.mouseEnter(screen.getAllByRole('button')[0]);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId('quota-hover-card').textContent).not.toContain('a@example.test');
  });
});

/**
 * SSH 远程 Codex 形态的用量回退（#12149）：
 *   - 远程 Codex 没有账号快照镜像（`remoteHostId` 抑制本机额度读取）、反向隧道计费金额为 0，
 *     订阅展示分支的额度段与金额段都为空 —— 此时回退显示会话已记录的 token，
 *     不再渲染孤立的货币符号；
 *   - 连 token 都没有时，区分「尚无用量」与「数据暂不可用」（与 codex-api 分支同一把尺子）。
 * 并入本套件而非新开文件：全套件独立耗时由组件图 transform（~5.5s）主导，新开文件必然
 * 超 §3.2 单文件 5 秒预算，且这些用例与远程会话渲染同属一个被测模块。
 */
describe('TodaySpendChip SSH remote Codex usage chip (#12149)', () => {
  function renderSshCodexChip(props: { providerId?: string | null; modelId?: string } = {}) {
    return render(
      <TodaySpendChip
        vendorKey="codex"
        providerId={props.providerId ?? null}
        modelId={props.modelId ?? 'gpt-6.1-sol'}
        sessionId="session-ssh-codex-1"
        remoteHostId="ssh-host-1"
      />,
    );
  }

  it('无额度窗口且金额为 0 时回退显示会话 token，不渲染孤立货币符号', () => {
    mocks.sessionTokens = 500;

    const { container } = renderSshCodexChip();

    expect(container.textContent).toContain('本任务已用 500 token');
    // 修复前该分支只输出一个货币符号（孤零零的 ¥/$）。
    expect(container.textContent?.trim()).not.toMatch(/^[¥$]$/);
    // SSH 远程不读本机 Codex 账号快照（额度事实在远端）。
    expect(mocks.localCodexReadKinds.length).toBeGreaterThan(0);
    expect(mocks.localCodexReadKinds.every((kind) => kind !== 'codex')).toBe(true);
  });

  it('既无会话 token 也无已完成轮次时显示「暂无用量」', () => {
    mocks.sessionTokens = null;

    const { container } = renderSshCodexChip();

    expect(container.textContent).toContain('暂无用量');
    expect(container.textContent?.trim()).not.toMatch(/^[¥$]$/);
  });

  it('有已完成轮次但 token 尚未恢复时显示「用量暂不可用」', () => {
    mocks.sessionTokens = null;
    mocks.displaySnapshot.messages = [
      {
        role: 'assistant',
        clientId: 'msg-1',
        turnUsageDetails: {
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 1540,
          cacheHitRate: null,
        },
      },
    ];

    const { container } = renderSshCodexChip();

    expect(container.textContent).toContain('用量暂不可用');
    expect(container.textContent?.trim()).not.toMatch(/^[¥$]$/);
  });

  it('有会话金额时保持原展示，不用 token 顶替', () => {
    mocks.sessionTokens = 500;
    mocks.sessionUsage = {
      actualMoney: null,
      estimatedValueMoney: null,
      totalMoney: { amount: 1.25, currency: 'USD', kind: 'value-estimate', approximate: false },
    } as SessionUsageMoney;

    const { container } = renderSshCodexChip();

    expect(container.textContent).toContain('本任务');
    expect(container.textContent).not.toContain('本任务已用 500 token');
  });

  // codex 复评 P1：xai 账号 / xai/ 模型的 SSH 远程 Codex 归 usesXaiQuotaForm，远程下
  // 本机额度读取同样被抑制、反向隧道计费为 0，两手空空——不得只按 usesCodexQuotaForm
  // 回退而把这类会话漏成孤立货币符号。
  it('xai 账号或 xai/ 模型的 SSH 远程 Codex 也回退会话 token', () => {
    mocks.sessionTokens = 500;

    const xaiProvider = renderSshCodexChip({ providerId: 'xai' });
    expect(xaiProvider.container.textContent).toContain('本任务已用 500 token');
    expect(xaiProvider.container.textContent?.trim()).not.toMatch(/^[¥$]$/);
    cleanup();

    const xaiModel = renderSshCodexChip({ modelId: 'xai/grok-4' });
    expect(xaiModel.container.textContent).toContain('本任务已用 500 token');
    expect(xaiModel.container.textContent?.trim()).not.toMatch(/^[¥$]$/);
  });

  it('xai 账号的 SSH 远程 Codex 无 token 时显示「暂无用量」', () => {
    mocks.sessionTokens = null;

    const { container } = renderSshCodexChip({ providerId: 'xai' });

    expect(container.textContent).toContain('暂无用量');
    expect(container.textContent?.trim()).not.toMatch(/^[¥$]$/);
  });
});

// @vitest-environment jsdom

/**
 * TodaySpendChip 的 device-link 远程会话形态:
 *   - 显式 anthropic 的远程订阅会话:用被控端镜像快照按本机订阅形态渲染窗口段,
 *     悬停出同款额度卡(chip 不可点 —— 看板属被控端账号,不跳本机浏览器);
 *   - 被控端镜像不可用(老被控端 / 断链):降级回「仅会话金额 / ¥ 占位」;
 *   - 默认路由(providerId=null)的远程会话:不做本机启发式猜测,维持占位显示。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';
import type { SessionUsageMoney } from '@/hooks/useSessionUsageMoney';

const mocks = vi.hoisted(() => ({
  localClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  remoteClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  remoteHookDeviceIds: [] as Array<string | null>,
  requestRemoteRefresh: vi.fn(),
  remoteRoute: null as 'gateway' | 'subscription' | null,
  remoteRouteDeviceIds: [] as Array<string | null>,
  remoteCodexPayload: null as Record<string, unknown> | null,
  remoteCodexDeviceIds: [] as Array<string | null>,
  remoteClaudeQuota: null as Record<string, unknown> | null,
  remoteXaiSnapshot: null as Record<string, unknown> | null,
  sessionUsage: {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  } as SessionUsageMoney,
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
        'todaySpend.sessionCostLabel': '本任务 {{cost}}',
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
vi.mock('@/hooks/useSessionTokens', () => ({ useSessionTokens: () => null }));
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAccountUsage')>();
  return {
    // 选槽 / 选桶纯函数用真实实现(selectRemoteCodexAccountUsage 依赖同一口径)。
    ...actual,
    requestCodexAccountRefresh: vi.fn(),
    useAccountUsage: () => null,
  };
});
vi.mock('@/hooks/useClaudeAccountUsage', () => ({ useClaudeAccountUsage: () => null }));
vi.mock('@/hooks/useModelAccessCreditUsage', () => ({ useModelAccessCreditUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: () => mocks.localClaudeSnapshot,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  requestRemoteClaudeSubscriptionRefresh: mocks.requestRemoteRefresh,
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null) => {
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
    useRemoteCodexAccountUsage: (deviceId: string | null) => {
      mocks.remoteCodexDeviceIds.push(deviceId);
      return deviceId ? mocks.remoteCodexPayload : null;
    },
    useRemoteClaudeAccountUsage: (deviceId: string | null) =>
      (deviceId ? mocks.remoteClaudeQuota : null),
    useRemoteXaiSubscriptionUsage: (deviceId: string | null) =>
      (deviceId ? mocks.remoteXaiSnapshot : null),
    useRemoteXaiRateLimit: () => null,
  };
});
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: null }),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({
  useCodexRateLimits: () => ({ snapshot: null, refresh: vi.fn() }),
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
  mocks.localClaudeSnapshot = null;
  mocks.remoteClaudeSnapshot = null;
  mocks.remoteHookDeviceIds = [];
  mocks.remoteRoute = null;
  mocks.remoteRouteDeviceIds = [];
  mocks.remoteCodexPayload = null;
  mocks.remoteCodexDeviceIds = [];
  mocks.remoteClaudeQuota = null;
  mocks.remoteXaiSnapshot = null;
  mocks.sessionUsage = {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  };
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
  });

  it('远程订阅会话悬停出额度卡,chip 不可点(看板属被控端账号)', () => {
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };

    const { container } = renderRemoteChip('anthropic');

    // 无看板链接 → trigger 是 span 而非 button。
    expect(screen.queryByRole('button')).toBeNull();
    const trigger = container.querySelector('span[tabindex="-1"]');
    expect(trigger?.textContent).toContain('5h 剩余 88%');

    fireEvent.mouseEnter(trigger!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();
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
  });

  it('远程 codex 会话按订阅形态渲染被控端账号窗口(组合 payload 选桶)', () => {
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

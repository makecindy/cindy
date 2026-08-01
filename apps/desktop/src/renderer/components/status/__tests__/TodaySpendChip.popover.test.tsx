// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';

const mocks = vi.hoisted(() => ({
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  displaySnapshot: {
    messages: [
      {
        role: 'assistant',
        turnMoney: { amount: 0.46, currency: 'USD' },
        turnUsageDetails: {
          inputTokens: 2,
          outputTokens: 16,
          cacheReadTokens: 0,
          cacheCreateTokens: 74_000,
          totalTokens: 74_018,
          cacheHitRate: 0,
          model: 'claude-opus-5[1m]',
        },
      },
    ],
  },
  openExternal: vi.fn(() => Promise.resolve()),
  refreshCodexRateLimits: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      const templates: Record<string, string> = {
        'todaySpend.openClaudeUsage': '打开 Claude 用量页面',
        'todaySpend.claude.weeklyLabel': '周限',
        'todaySpend.claude.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.sessionCostLabel': '本任务 {{cost}}',
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.unit.minute': '分钟',
        'todaySpend.unit.second': '秒',
        'quotaCard.fiveHourLabel': '5 小时',
        'quotaCard.weeklyLabel': '周限',
        'quotaCard.modelWeeklyLabel': '{{model}} 周限',
        'quotaCard.usedPercent': '已用 {{percent}}%',
        'quotaCard.resetAt': '{{at}} 重置',
        'quotaCard.turnCost': '本轮消耗',
        'quotaCard.tokenLabel': 'Token',
        'quotaCard.tokenBreakdown': '（输入 {{input}} · 输出 {{output}}）',
        'quotaCard.cacheLabel': '缓存',
        'quotaCard.modelLabel': '模型',
        'quotaCard.waiting': '等待额度数据',
        'usageDetails.cacheLine': '缓存拆分：读取 {{read}} · 写入 {{create}} · 命中率 {{rate}}',
        'usageDetails.cacheLineNoRate': '缓存拆分：读取 {{read}} · 写入 {{create}}',
        'usageDetails.multipleModels': '{{count}} 个模型',
        'usageDetails.suggestion.lowCache': '缓存命中率偏低，本轮较多上下文重新计费',
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
  useClaudeOAuthConnected: () => true,
}));
vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: () => null,
}));
vi.mock('@/hooks/useSessionUsageMoney', () => ({
  useSessionUsageMoney: () => ({
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  }),
}));
vi.mock('@/hooks/useSessionTokens', () => ({ useSessionTokens: () => null }));
vi.mock('@/hooks/useAccountUsage', () => ({
  requestCodexAccountRefresh: vi.fn(),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useClaudeAccountUsage', () => ({ useClaudeAccountUsage: () => null }));
vi.mock('@/hooks/useModelAccessCreditUsage', () => ({ useModelAccessCreditUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: () => mocks.claudeSnapshot,
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: null }),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({
  useCodexRateLimits: () => ({
    snapshot: null,
    refresh: mocks.refreshCodexRateLimits,
  }),
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

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

function renderClaudeSubscriptionChip() {
  return render(
    <TodaySpendChip
      vendorKey="cc"
      providerId="anthropic"
      modelId="claude-opus-5[1m]"
      sessionId="session-1"
    />,
  );
}

function openCardFromHover() {
  const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });
  fireEvent.mouseEnter(trigger);
  act(() => vi.advanceTimersByTime(300));
  return { trigger, card: screen.getByTestId('quota-hover-card') };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.claudeSnapshot = {
    source: 'oauth-endpoint',
    subscriptionType: 'max',
    sevenDay: { utilization: 34, resetsAt: Date.now() / 1000 + 86_400 },
  };
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

describe('TodaySpendChip Claude subscription popover', () => {
  it('悬停约 300ms 后显示额度卡片', () => {
    renderClaudeSubscriptionChip();
    const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText('$0.46')).toBeTruthy();
    expect(screen.getByText(/^74\.0k/)).toBeTruthy();
    expect(screen.getByText('（输入 2 · 输出 16）')).toBeTruthy();
    expect(screen.getByText('读 0 · 写 74.0k · 命中 0%')).toBeTruthy();
    expect(screen.getByText('claude-opus-5[1m]')).toBeTruthy();
    expect(screen.getByText('缓存命中率偏低，本轮较多上下文重新计费')).toBeTruthy();
  });

  it('指针可在宽限期内移入卡片并点击看板动作', () => {
    renderClaudeSubscriptionChip();
    const { trigger, card } = openCardFromHover();

    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(150));

    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '打开 Claude 用量页面' }));
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledWith(CLAUDE_USAGE_URL);
  });

  it('离开 trigger 和卡片后在宽限期结束时卸载内容', () => {
    renderClaudeSubscriptionChip();
    const { trigger, card } = openCardFromHover();

    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
  });

  it('打开延迟触发前卸载会清理定时器且不更新已卸载组件', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { unmount } = renderClaudeSubscriptionChip();
      const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

      fireEvent.mouseEnter(trigger);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(300));

      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('点击 chip 仍只打开一次 Claude 看板', () => {
    renderClaudeSubscriptionChip();

    fireEvent.click(screen.getByRole('button', { name: '打开 Claude 用量页面' }));
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledWith(CLAUDE_USAGE_URL);
  });

  it('非 Claude 订阅形态继续使用旧 Tip，不挂载额度卡片', () => {
    render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="xd"
        sessionId="session-1"
      />,
    );

    const legacyChip = document.querySelector('.inline-flex.h-5.shrink-0.items-center');
    expect(legacyChip).toBeTruthy();
    fireEvent.mouseEnter(legacyChip as HTMLElement);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
  });
});

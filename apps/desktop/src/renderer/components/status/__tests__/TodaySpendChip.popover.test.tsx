// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';
import type { RegionalMoney } from '../../../../shared/regionalMoney';
import type { SessionUsageMoney } from '@/hooks/useSessionUsageMoney';

const mocks = vi.hoisted(() => ({
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  displaySnapshot: {
    messages: [] as Array<Record<string, unknown>>,
  },
  sessionUsage: {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  } as SessionUsageMoney,
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
        'todaySpend.tooltip.sessionUsed': '本任务已用 {{cost}}',
        'todaySpend.codex.sessionValueLabel': '本任务价值 {{cost}}',
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.unit.minute': '分钟',
        'todaySpend.unit.second': '秒',
        'quotaCard.fiveHourLabel': '5 小时',
        'quotaCard.weeklyLabel': '周限',
        'quotaCard.modelWeeklyLabel': '{{model}} 周限',
        'quotaCard.usedPercent': '已用 {{percent}}%',
        'quotaCard.resetAt': '{{at}} 重置',
        'quotaCard.turnCostUnavailable': '本轮费用暂无法估算',
        'quotaCard.tokenLabel': 'Token',
        'quotaCard.tokenBreakdown': '（输入 {{input}} · 输出 {{output}}）',
        'quotaCard.cacheLabel': '缓存',
        'quotaCard.timeLabel': '耗时',
        'quotaCard.timeAndRateValue': '{{duration}} 速度：{{rate}} token/秒',
        'quotaCard.modelLabel': '模型',
        'quotaCard.waiting': '等待额度数据',
        'quotaCard.latestMessageTitle': '最近一轮用户请求累计',
        'chat.messageActionBar.userTurnCostDetailsTitle': '本轮明细',
        'quotaCard.costLine': '本轮消耗：{{cost}}',
        'quotaCard.valueLine': '本轮 token 价值：{{cost}}',
        'quotaCard.noBilledCost': '本轮费用暂不可用，仅显示用量',
        'usageDetails.costBreakdownHeader': '按模型拆分：',
        'usageDetails.durationSeconds': '{{value}}秒',
        'usageDetails.durationMinutesSeconds': '{{minutes}}分 {{seconds}}秒',
        'usageDetails.modelCostLine': '· {{model}} {{cost}}',
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
  useSessionUsageMoney: () => mocks.sessionUsage,
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
const TURN_USAGE_DETAILS = {
  inputTokens: 2,
  outputTokens: 16,
  cacheReadTokens: 0,
  cacheCreateTokens: 74_000,
  totalTokens: 74_018,
  cacheHitRate: 0,
  durationMs: 400,
  turnDurationMs: 12_345,
  model: 'claude-opus-5[1m]',
};

function usdMoney(
  amount: number,
  kind: 'actual-cost' | 'value-estimate' = 'actual-cost',
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: kind === 'value-estimate',
    kind,
  };
}

function setLatestUsageMessage(overrides: Record<string, unknown> = {}) {
  mocks.displaySnapshot.messages = [
    {
      clientId: 'assistant-1',
      role: 'assistant',
      turnMoney: usdMoney(0.46),
      turnUsageDetails: TURN_USAGE_DETAILS,
      ...overrides,
    },
  ];
}

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
  setLatestUsageMessage();
  mocks.sessionUsage = {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  };
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
    expect(screen.getByText('本轮消耗：$0.46')).toBeTruthy();
    expect(screen.getByText(/^74\.0k/)).toBeTruthy();
    expect(screen.getByText('（输入 2 · 输出 16）')).toBeTruthy();
    expect(screen.getByText('读 0 · 写 74.0k · 命中 0%')).toBeTruthy();
    const performance = screen.getByTestId('quota-performance');
    expect(within(performance).getByText('耗时')).toBeTruthy();
    expect(within(performance).getByText('12.3秒 速度：40 token/秒')).toBeTruthy();
    expect(screen.getByText('claude-opus-5[1m]')).toBeTruthy();
    expect(screen.getByText('缓存命中率偏低，本轮较多上下文重新计费')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('把输入与输出 Token 分别压缩后再传入卡片', () => {
    setLatestUsageMessage({
      turnUsageDetails: {
        ...TURN_USAGE_DETAILS,
        inputTokens: 74_000,
        outputTokens: 16,
        cacheCreateTokens: 0,
        totalTokens: 74_016,
      },
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();

    expect(screen.getByText(/^74\.0k/)).toBeTruthy();
    expect(screen.getByText('（输入 74.0k · 输出 16）')).toBeTruthy();
    expect(screen.queryByText('（输入 74000 · 输出 16）')).toBeNull();
  });

  it('没有可靠耗时时不显示 TPS，现有用量明细保持不变', () => {
    setLatestUsageMessage({
      turnUsageDetails: {
        ...TURN_USAGE_DETAILS,
        durationMs: undefined,
        turnDurationMs: undefined,
      },
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();
    expect(screen.queryByText('速度')).toBeNull();
    expect(screen.getByText('（输入 2 · 输出 16）')).toBeTruthy();
  });

  it('只有整轮耗时时直接显示耗时，不显示缺失速度占位', () => {
    setLatestUsageMessage({
      turnUsageDetails: { ...TURN_USAGE_DETAILS, durationMs: undefined },
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();
    const performance = screen.getByTestId('quota-performance');
    expect(within(performance).getByText('耗时')).toBeTruthy();
    expect(within(performance).getByText('12.3秒')).toBeTruthy();
  });

  it('键盘聚焦打开时把焦点移入卡片，关闭后归还 trigger', () => {
    renderClaudeSubscriptionChip();
    const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

    act(() => trigger.focus());
    const card = screen.getByTestId('quota-hover-card');
    const dashboardButton = within(card).getByRole('button', { name: '打开 Claude 用量页面' });
    expect(document.activeElement).toBe(dashboardButton);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('悬停打开后鼠标点击卡片按钮，Escape 关闭时归还 trigger', () => {
    renderClaudeSubscriptionChip();
    const { trigger, card } = openCardFromHover();
    const dashboardButton = within(card).getByRole('button', { name: '打开 Claude 用量页面' });

    fireEvent.mouseDown(dashboardButton);
    // JSDOM 不执行鼠标按下后的浏览器默认聚焦动作，这里显式补齐真实点击序列。
    act(() => dashboardButton.focus());
    fireEvent.mouseUp(dashboardButton);
    fireEvent.click(dashboardButton);
    expect(document.activeElement).toBe(dashboardButton);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('卡片内保持键盘焦点时，鼠标移入再移出不会关闭', () => {
    renderClaudeSubscriptionChip();
    const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

    act(() => trigger.focus());
    const card = screen.getByTestId('quota-hover-card');
    const dashboardButton = within(card).getByRole('button', { name: '打开 Claude 用量页面' });
    expect(document.activeElement).toBe(dashboardButton);

    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(200));

    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();
    expect(document.activeElement).toBe(dashboardButton);
  });

  it('切出 Claude 订阅形态时关闭卡片、清理定时器并归还焦点', () => {
    const { rerender } = renderClaudeSubscriptionChip();
    const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

    act(() => trigger.focus());
    const dashboardButton = within(screen.getByTestId('quota-hover-card')).getByRole('button', {
      name: '打开 Claude 用量页面',
    });
    expect(document.activeElement).toBe(dashboardButton);

    // 卡片已开时再挂一个待执行的 hover-open timer，形态切换必须一并清掉。
    fireEvent.mouseEnter(trigger);
    rerender(
      <TodaySpendChip
        vendorKey="cc"
        providerId="xd"
        modelId="claude-opus-5[1m]"
        sessionId="session-1"
      />,
    );

    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
    const gatewayChip = document.querySelector<HTMLElement>('[tabindex="-1"]');
    expect(gatewayChip).toBeTruthy();
    expect(document.activeElement).toBe(gatewayChip);

    act(() => vi.advanceTimersByTime(300));
    rerender(
      <TodaySpendChip
        vendorKey="cc"
        providerId="anthropic"
        modelId="claude-opus-5[1m]"
        sessionId="session-1"
      />,
    );
    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
  });

  it('Tab 离开卡片后自然保留下一控件的焦点', () => {
    render(
      <>
        <TodaySpendChip
          vendorKey="cc"
          providerId="anthropic"
          modelId="claude-opus-5[1m]"
          sessionId="session-1"
        />
        <button type="button">下一控件</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: '打开 Claude 用量页面' });

    act(() => trigger.focus());
    const dashboardButton = within(screen.getByTestId('quota-hover-card')).getByRole('button', {
      name: '打开 Claude 用量页面',
    });
    const nextButton = screen.getByRole('button', { name: '下一控件' });
    expect(document.activeElement).toBe(dashboardButton);

    act(() => nextButton.focus());
    act(() => vi.advanceTimersByTime(200));

    expect(screen.queryByTestId('quota-hover-card')).toBeNull();
    expect(document.activeElement).toBe(nextButton);
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

  it('把精确费用与估算 token 价值映射成不同文案', () => {
    setLatestUsageMessage({
      turnMoney: usdMoney(0.46),
      turnCostIsEstimate: false,
    });
    const exact = renderClaudeSubscriptionChip();
    openCardFromHover();
    expect(screen.getByText('本轮消耗：$0.46')).toBeTruthy();
    expect(screen.queryByText('本轮 token 价值：$0.46')).toBeNull();

    exact.unmount();
    vi.clearAllTimers();
    setLatestUsageMessage({
      turnMoney: usdMoney(0.46, 'value-estimate'),
      turnCostIsEstimate: true,
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();
    expect(screen.getByText('本轮 token 价值：$0.46')).toBeTruthy();
    expect(screen.queryByText('本轮消耗：$0.46')).toBeNull();
  });

  it('把混合会话合计及实际费用和价值估算拆分传入卡片', () => {
    mocks.sessionUsage = {
      actualMoney: usdMoney(0.25),
      estimatedValueMoney: usdMoney(0.50, 'value-estimate'),
      totalMoney: {
        ...usdMoney(0.75),
        approximate: true,
        estimateReasons: ['subscription-value'],
      },
    };

    renderClaudeSubscriptionChip();
    const { card } = openCardFromHover();
    const sessionSection = within(card).getByTestId('quota-session-usage');

    expect(within(sessionSection).getByText('本任务 $0.75')).toBeTruthy();
    expect(within(sessionSection).getByText('本任务已用 $0.25')).toBeTruthy();
    expect(within(sessionSection).getByText('本任务价值 $0.50')).toBeTruthy();
    expect(screen.getByText('本轮消耗：$0.46')).toBeTruthy();
  });

  it('第三方参考价的近似实际费用仍标为本任务已用', () => {
    const approximateActualMoney: RegionalMoney = {
      ...usdMoney(0.25),
      approximate: true,
      estimateReasons: ['reference-price'],
    };
    mocks.sessionUsage = {
      actualMoney: approximateActualMoney,
      estimatedValueMoney: null,
      totalMoney: approximateActualMoney,
    };

    renderClaudeSubscriptionChip();
    const { card } = openCardFromHover();
    const sessionSection = within(card).getByTestId('quota-session-usage');

    expect(within(sessionSection).getByText('本任务已用 $0.25')).toBeTruthy();
    expect(within(sessionSection).queryByText('本任务价值 $0.25')).toBeNull();
  });

  it('纯订阅价值估算仍标为本任务价值', () => {
    const estimatedValueMoney = usdMoney(0.50, 'value-estimate');
    mocks.sessionUsage = {
      actualMoney: null,
      estimatedValueMoney,
      totalMoney: estimatedValueMoney,
    };

    renderClaudeSubscriptionChip();
    const { card } = openCardFromHover();
    const sessionSection = within(card).getByTestId('quota-session-usage');

    expect(within(sessionSection).getByText('本任务价值 $0.50')).toBeTruthy();
    expect(within(sessionSection).queryByText('本任务已用 $0.50')).toBeNull();
  });

  it('等额累计投影仍只展示一份用户轮明细', () => {
    setLatestUsageMessage({
      turnMoney: usdMoney(0.46, 'value-estimate'),
      userTurnMoney: usdMoney(0.46, 'value-estimate'),
      turnCostIsEstimate: true,
      userTurnCostIsEstimate: true,
    });
    const equalAmount = renderClaudeSubscriptionChip();
    openCardFromHover();
    expect(screen.getByText('最近一轮用户请求累计')).toBeTruthy();
    expect(screen.queryByText('最后一个 SDK 分段')).toBeNull();
    expect(screen.getAllByText('本轮 token 价值：$0.46')).toHaveLength(1);

    equalAmount.unmount();
    vi.clearAllTimers();
    setLatestUsageMessage({
      turnMoney: usdMoney(0.20),
      userTurnMoney: usdMoney(0.70),
      turnCostIsEstimate: false,
      userTurnCostIsEstimate: false,
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();
    expect(screen.getByText('最近一轮用户请求累计')).toBeTruthy();
    expect(screen.getByText('本轮消耗：$0.70')).toBeTruthy();
    expect(screen.queryByText('最后一个 SDK 分段')).toBeNull();
    expect(screen.getByText(/^74\.0k/)).toBeTruthy();
  });

  it('聚合自动续跑前后的 Token 与逐模型费用', () => {
    mocks.displaySnapshot.messages = [
      {
        clientId: 'user-1',
        role: 'user',
        delivery: 'turn',
        content: '开始任务',
      },
      {
        clientId: 'assistant-fable',
        role: 'assistant',
        content: '第一段',
        turnMoney: usdMoney(0.2),
        turnUsageDetails: {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheCreateTokens: 5,
          totalTokens: 135,
          cacheHitRate: 60 / 115,
          model: 'claude-fable-5',
          perModelCost: [{ model: 'claude-fable-5', money: usdMoney(0.2) }],
        },
      },
      {
        clientId: 'auto-resume-1',
        role: 'user',
        delivery: 'turn',
        systemCardType: 'auto-resume',
        content: '',
      },
      {
        clientId: 'assistant-opus',
        role: 'assistant',
        content: '第二段',
        turnMoney: usdMoney(0.5),
        userTurnMoney: usdMoney(0.7),
        turnUsageDetails: {
          inputTokens: 30,
          outputTokens: 12,
          cacheReadTokens: 15,
          cacheCreateTokens: 5,
          totalTokens: 62,
          cacheHitRate: 0.3,
          model: 'claude-opus-5',
          perModelCost: [{ model: 'claude-opus-5', money: usdMoney(0.5) }],
        },
      },
    ];

    renderClaudeSubscriptionChip();
    openCardFromHover();

    expect(screen.getByText('最近一轮用户请求累计')).toBeTruthy();
    expect(screen.getByText('本轮消耗：$0.70')).toBeTruthy();
    expect(screen.getByText(/^197/)).toBeTruthy();
    expect(screen.getByText('按模型拆分：')).toBeTruthy();
    expect(screen.getByText('· claude-fable-5 $0.20')).toBeTruthy();
    expect(screen.getByText('· claude-opus-5 $0.50')).toBeTruthy();
    expect(screen.queryByText('最后一个 SDK 分段')).toBeNull();
  });

  it('无报价时说明费用不可用并保留 Token、缓存和模型明细', () => {
    setLatestUsageMessage({ turnMoney: undefined });
    renderClaudeSubscriptionChip();
    openCardFromHover();

    expect(screen.getByText('本轮费用暂无法估算')).toBeTruthy();
    expect(screen.getByText(/^74\.0k/)).toBeTruthy();
    expect(screen.getByText('读 0 · 写 74.0k · 命中 0%')).toBeTruthy();
    expect(screen.getByText('claude-opus-5[1m]')).toBeTruthy();
  });

  it('保留用户轮的逐模型费用拆分', () => {
    setLatestUsageMessage({
      turnUsageDetails: {
        ...TURN_USAGE_DETAILS,
        models: ['claude-opus-4-8[1m]', 'claude-haiku-4-5-20251001'],
        perModelCost: [
          { model: 'claude-opus-4-8[1m]', money: usdMoney(0.35) },
          { model: 'claude-haiku-4-5-20251001', money: usdMoney(0.11) },
        ],
      },
    });
    renderClaudeSubscriptionChip();
    openCardFromHover();

    expect(screen.getByText('按模型拆分：')).toBeTruthy();
    expect(screen.getByText('· Opus 4.8 $0.35')).toBeTruthy();
    expect(screen.getByText('· Haiku 4.5 $0.11')).toBeTruthy();
    expect(screen.queryByText('claude-opus-5[1m]')).toBeNull();
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

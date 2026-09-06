// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      if (key === 'quotaCard.fiveHourLabel') return '5 小时';
      if (key === 'quotaCard.weeklyLabel') return '周限';
      if (key === 'quotaCard.modelWeeklyLabel') return `${options.model} 周限`;
      if (key === 'quotaCard.windowsRegionLabel') return '配额窗口列表';
      if (key === 'quotaCard.usedPercent') return `已用 ${options.percent}%`;
      if (key === 'quotaCard.usageCritical') return '用量较高';
      if (key === 'quotaCard.usageWarning') return '用量偏高';
      if (key === 'quotaCard.limitRejected') return '已触发套餐限额，请求可能被拒绝';
      if (key === 'quotaCard.limitWarning') return '接近套餐限额';
      if (key === 'quotaCard.resetAt') return `${options.at} 重置`;
      if (key === 'quotaCard.paceTrendFast') return '按当前平均速度偏快（粗略趋势）';
      if (key === 'quotaCard.paceTrendNormal') return '按当前平均速度正常（粗略趋势）';
      if (key === 'quotaCard.paceTrendSlow') return '按当前平均速度偏慢（粗略趋势）';
      if (key === 'quotaCard.tokenBreakdown') {
        return `（输入 ${options.input} · 输出 ${options.output}）`;
      }
      if (key === 'quotaCard.speedLabel') return '速度';
      if (key === 'quotaCard.rateValue') return `${options.rate} tokens/秒`;
      if (key === 'quotaCard.timeLabel') return '耗时';
      if (key === 'quotaCard.timeAndRateValue')
        return `${options.duration} 速度：${options.rate} token/秒`;
      if (key === 'todaySpend.sessionCostLabel') return `本任务 ${options.cost}`;
      if (key === 'todaySpend.tooltip.sessionUsed') return `本任务已用 ${options.cost}`;
      if (key === 'todaySpend.codex.sessionValueLabel') return `本任务价值 ${options.cost}`;
      if (key === 'quotaCard.costLine') return `本轮消耗：${options.cost}`;
      if (key === 'quotaCard.valueLine') return `本轮 token 价值：${options.cost}`;
      if (key === 'quotaCard.noBilledCost') return '本轮费用暂不可用，仅显示用量';
      if (key === 'usageDetails.costBreakdownHeader') return '按模型拆分：';
      if (key === 'usageDetails.modelCostLine') return `· ${options.model} ${options.cost}`;
      if (key === 'quotaCard.turnCostUnavailable') return '本轮费用暂无法估算';
      if (key === 'quotaCard.latestMessageTitle') return '最近一轮';
      if (key === 'chat.messageActionBar.userTurnCostDetailsTitle') return '本轮明细';
      if (key === 'quotaCard.staleData') return `quotaCard.staleData:${options.minutes}`;
      return key;
    },
  }),
}));

import { useTranslation } from 'react-i18next';
import { QuotaHoverCard as UsageCard, type QuotaHoverCardProps } from '../QuotaHoverCard';
import { buildClaudeUsageCard } from '../usageCardModel';

// Exercise the Claude adapter and the shared card together, retaining all existing edge cases.
function QuotaHoverCard({
  snapshot,
  ...props
}: Omit<QuotaHoverCardProps, 'account'> & { snapshot: ClaudeSubscriptionUsageSnapshot | null }) {
  const { t } = useTranslation();
  return <UsageCard {...props} account={buildClaudeUsageCard(snapshot, t)} />;
}

const NOW_MS = new Date(2026, 7, 1, 10, 0, 0).getTime();
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

function epochSeconds(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month, day, hour, minute, 0).getTime() / 1000;
}

function makeSnapshot(
  overrides: Partial<ClaudeSubscriptionUsageSnapshot> = {},
): ClaudeSubscriptionUsageSnapshot {
  return {
    source: 'oauth-endpoint',
    ...overrides,
  };
}

/** 按周窗口进度构造稳定输入，便于精确覆盖趋势百分点边界。 */
function weeklyAtProgress(utilization: number, progress: number) {
  return {
    utilization,
    resetsAt: (NOW_MS + WEEKLY_WINDOW_MS * (1 - progress)) / 1000,
  };
}

describe('QuotaHoverCard', () => {
  it('keeps the provider header while waiting for quota data', () => {
    render(<QuotaHoverCard snapshot={null} nowMs={NOW_MS} />);

    const card = screen.getByTestId('quota-hover-card');
    expect(card.classList.contains('rounded-xl')).toBe(true);
    expect(card.classList.contains('rounded-2xl')).toBe(false);
    expect(card.classList.contains('border-[var(--border-default)]')).toBe(true);
    expect(card.classList.contains('bg-[var(--surface-elevated)]')).toBe(true);
    expect(card.classList.contains('text-[var(--text-primary)]')).toBe(true);
    expect(card.style.boxShadow).toBe('var(--shadow-menu)');
    expect(screen.getByText('quotaCard.waiting')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

  it('renders five-hour, weekly, and every scoped window with percentages and reset labels', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          fiveHour: {
            utilization: 1.2,
            resetsAt: epochSeconds(2026, 7, 1, 17, 5),
          },
          sevenDay: {
            utilization: 4.4,
            resetsAt: epochSeconds(2026, 7, 7, 0, 0),
          },
          scoped: [
            {
              modelDisplayName: 'Fable',
              utilization: 0,
              resetsAt: epochSeconds(2026, 7, 6, 23, 59),
            },
            {
              modelDisplayName: 'Opus',
              utilization: 75.6,
              resetsAt: epochSeconds(2026, 7, 1, 18, 30),
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
    expect(screen.getByRole('progressbar', { name: '5 小时' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '周限' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Fable 周限' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Opus 周限.*用量偏高/ })).toBeTruthy();
    expect(screen.getByText('5 小时')).toBeTruthy();
    expect(screen.getByText('周限')).toBeTruthy();
    expect(screen.getByText('Fable 周限')).toBeTruthy();
    expect(screen.getByText('Opus 周限')).toBeTruthy();
    expect(screen.getByText('已用 1%')).toBeTruthy();
    expect(screen.getByText('已用 4%')).toBeTruthy();
    expect(screen.getByText('已用 0%')).toBeTruthy();
    expect(screen.getByText('已用 76%')).toBeTruthy();
    expect(screen.getByText('17:05 重置')).toBeTruthy();
    expect(screen.getByText('8月7日 00:00 重置')).toBeTruthy();
    expect(screen.getByText('8月6日 23:59 重置')).toBeTruthy();
    expect(screen.getByText('18:30 重置')).toBeTruthy();
  });

  it('accepts the unified-headers shape without scoped windows or severity', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          source: 'unified-headers',
          fiveHour: { utilization: 12 },
          sevenDay: { utilization: 34 },
        })}
      />,
    );

    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('5 小时')).toBeTruthy();
    expect(screen.getByText('周限')).toBeTruthy();
  });

  it('skips a null five-hour window while keeping the weekly window', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          fiveHour: null,
          sevenDay: { utilization: 20 },
        })}
      />,
    );

    expect(screen.queryByText('5 小时')).toBeNull();
    expect(screen.getByText('周限')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('drops windows with string, null, or non-finite utilization while keeping valid siblings', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          fiveHour: { utilization: '67' as unknown as number },
          sevenDay: { utilization: 24 },
          scoped: [
            {
              modelDisplayName: 'Null model',
              utilization: null as unknown as number,
            },
            {
              modelDisplayName: 'Infinite model',
              utilization: Number.POSITIVE_INFINITY,
            },
            {
              modelDisplayName: 'Valid model',
              utilization: 45,
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText('5 小时')).toBeNull();
    expect(screen.queryByText('Null model 周限')).toBeNull();
    expect(screen.queryByText('Infinite model 周限')).toBeNull();
    expect(screen.getByRole('progressbar', { name: '周限' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Valid model 周限' })).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('renders the no-windows line when every window is absent', () => {
    render(<QuotaHoverCard snapshot={makeSnapshot()} nowMs={NOW_MS} />);

    expect(screen.getByText('quotaCard.noWindows')).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

  it('omits a reset label when resetsAt is null', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({ sevenDay: { utilization: 30, resetsAt: null } })}
      />,
    );

    expect(screen.getByText('已用 30%')).toBeTruthy();
    expect(screen.queryByText(/重置$/)).toBeNull();
  });

  it('clamps dirty utilization for both the bar and used-percent text', () => {
    render(
      <QuotaHoverCard nowMs={NOW_MS} snapshot={makeSnapshot({ fiveHour: { utilization: 250 } })} />,
    );

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect((bar.firstElementChild as HTMLElement | null)?.style.width).toBe('100%');
    expect(screen.getByText('已用 100%')).toBeTruthy();
  });

  it('omits a null subscription badge and maps max to Max', () => {
    const { rerender } = render(
      <QuotaHoverCard snapshot={makeSnapshot({ subscriptionType: null })} nowMs={NOW_MS} />,
    );

    expect(screen.queryByTestId('quota-plan-badge')).toBeNull();

    rerender(
      <QuotaHoverCard snapshot={makeSnapshot({ subscriptionType: 'max' })} nowMs={NOW_MS} />,
    );
    expect(screen.getByTestId('quota-plan-badge').textContent).toBe('Max');
  });

  it('renders rejected and warning statuses while omitting allowed', () => {
    const { rerender } = render(
      <QuotaHoverCard snapshot={makeSnapshot({ rateLimitStatus: 'rejected' })} nowMs={NOW_MS} />,
    );

    expect(screen.getByText('已触发套餐限额，请求可能被拒绝')).toBeTruthy();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ rateLimitStatus: 'allowed_warning' })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText('接近套餐限额')).toBeTruthy();
    expect(screen.queryByText('已触发套餐限额，请求可能被拒绝')).toBeNull();

    rerender(
      <QuotaHoverCard snapshot={makeSnapshot({ rateLimitStatus: 'allowed' })} nowMs={NOW_MS} />,
    );
    expect(screen.queryByTestId('quota-status')).toBeNull();
  });

  it('shows only the enabled extra-usage line and never renders undocumented numbers', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          extraUsage: {
            isEnabled: true,
            usedCredits: 1234,
            monthlyLimit: 0,
          },
        })}
      />,
    );

    expect(screen.getByText('quotaCard.extraUsageEnabled')).toBeTruthy();
    expect(screen.queryByText('1234', { exact: false })).toBeNull();
  });

  it('hides present-but-disabled extra usage and its undocumented numbers', () => {
    render(
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({
          extraUsage: {
            isEnabled: false,
            usedCredits: 1234,
          },
        })}
      />,
    );

    expect(screen.queryByText('quotaCard.extraUsageEnabled')).toBeNull();
    expect(screen.queryByText('1234', { exact: false })).toBeNull();
  });

  it('renders full turn usage, omits a null section, and hides a null suggestion', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: '$0.46',
          totalTokensText: '74.1K',
          inputTokensText: '2',
          outputTokensText: '16',
          cacheLineText: '读 0 · 写 74.0K · 命中 0%',
          model: 'claude-opus-5 [1m]',
          suggestionText: '缓存命中率偏低，本轮较多上下文重新计费',
        }}
      />,
    );

    expect(screen.getByText('本轮消耗：$0.46')).toBeTruthy();
    expect(screen.getByText('74.1K', { exact: false })).toBeTruthy();
    expect(screen.getByText('（输入 2 · 输出 16）')).toBeTruthy();
    expect(screen.getByText('读 0 · 写 74.0K · 命中 0%')).toBeTruthy();
    expect(screen.getByText('claude-opus-5 [1m]')).toBeTruthy();
    expect(screen.getByTestId('quota-suggestion')).toBeTruthy();

    rerender(<QuotaHoverCard snapshot={null} nowMs={NOW_MS} turnUsage={null} />);
    expect(screen.queryByTestId('quota-turn-usage')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{ costText: '$0.46', suggestionText: null }}
      />,
    );
    expect(screen.getByTestId('quota-turn-usage')).toBeTruthy();
    expect(screen.queryByTestId('quota-suggestion')).toBeNull();
  });

  it('保留混合会话金额的合计、实际费用与价值估算拆分', () => {
    render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        sessionUsage={{
          costText: '$0.75',
          costIsEstimate: true,
          actualCostText: '$0.25',
          estimatedValueText: '$0.50',
        }}
      />,
    );

    expect(screen.getByText('本任务 $0.75')).toBeTruthy();
    expect(screen.getByText('本任务已用 $0.25')).toBeTruthy();
    expect(screen.getByText('本任务价值 $0.50')).toBeTruthy();
  });

  it('耗时与速度使用独立明细行，缺失时分别隐藏', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot()}
        nowMs={NOW_MS}
        turnUsage={{ outputRateText: '40', turnDurationText: '12.3s' }}
      />,
    );

    const performance = screen.getByTestId('quota-performance');
    expect(within(performance).getByText('耗时')).toBeTruthy();
    expect(within(performance).getByText('12.3s')).toBeTruthy();
    expect(within(performance).getByText('速度')).toBeTruthy();
    expect(within(performance).getByText('40 tokens/秒')).toBeTruthy();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot()}
        nowMs={NOW_MS}
        turnUsage={{ outputRateText: null, turnDurationText: '12.3s' }}
      />,
    );
    const timeOnlyPerformance = screen.getByTestId('quota-performance');
    expect(within(timeOnlyPerformance).getByText('耗时')).toBeTruthy();
    expect(within(timeOnlyPerformance).getByText('12.3s')).toBeTruthy();
    expect(within(timeOnlyPerformance).queryByText('速度')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot()}
        nowMs={NOW_MS}
        turnUsage={{ outputRateText: '40', turnDurationText: null }}
      />,
    );
    expect(within(screen.getByTestId('quota-performance')).getByText('40 tokens/秒')).toBeTruthy();
    expect(within(screen.getByTestId('quota-performance')).queryByText('耗时')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot()}
        nowMs={NOW_MS}
        turnUsage={{ outputRateText: null, turnDurationText: null }}
      />,
    );
    expect(screen.queryByTestId('quota-performance')).toBeNull();
  });

  it('marks estimated value and labels user-turn totals without exposing SDK segments', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: '$0.46',
          costIsEstimate: true,
          totalTokensText: '74.1K',
        }}
      />,
    );

    expect(screen.getByText('本轮 token 价值：$0.46')).toBeTruthy();
    expect(screen.queryByText('本轮明细')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: '$0.70',
          isUserTurnTotal: true,
          totalTokensText: '74.1K',
        }}
      />,
    );

    expect(screen.getByText('最近一轮')).toBeTruthy();
    expect(screen.getByText('本轮消耗：$0.70')).toBeTruthy();
    expect(screen.queryByText('本轮明细')).toBeNull();
  });

  it('多模型分段逐模型展示费用，不再重复笼统模型行', () => {
    render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: '$0.46',
          model: '2 个模型',
          perModelCost: [
            { model: 'Opus 4.8', costText: '$0.35' },
            { model: 'Haiku 4.5', costText: '$0.11' },
          ],
        }}
      />,
    );

    expect(screen.getByText('按模型拆分：')).toBeTruthy();
    expect(screen.getByText('· Opus 4.8 $0.35')).toBeTruthy();
    expect(screen.getByText('· Haiku 4.5 $0.11')).toBeTruthy();
    expect(screen.queryByText('2 个模型')).toBeNull();
  });

  it('states that cost is unavailable while retaining token, cache, and model rows', () => {
    render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: null,
          totalTokensText: '74.1K',
          inputTokensText: '2',
          outputTokensText: '16',
          cacheLineText: '读 0 · 写 74.0K · 命中 0%',
          model: 'claude-unknown',
        }}
      />,
    );

    expect(screen.getByText('本轮费用暂无法估算')).toBeTruthy();
    expect(screen.getByText('74.1K', { exact: false })).toBeTruthy();
    expect(screen.getByText('读 0 · 写 74.0K · 命中 0%')).toBeTruthy();
    expect(screen.getByText('claude-unknown')).toBeTruthy();
  });

  it('fires the dashboard callback from a real button and hides it for a null label', () => {
    const onOpenDashboard = vi.fn();
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        dashboardLabel="打开 Claude 用量页面"
        onOpenDashboard={onOpenDashboard}
      />,
    );

    const button = screen.getByRole('button', { name: '打开 Claude 用量页面' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.classList.contains('hover:bg-[var(--surface-hover)]')).toBe(true);
    expect(button.classList.contains('focus-visible:ring-[var(--focus-ring)]')).toBe(true);
    expect(button.classList.contains('focus-visible:ring-offset-[var(--surface-elevated)]')).toBe(
      true,
    );
    fireEvent.click(button);
    expect(onOpenDashboard).toHaveBeenCalledTimes(1);

    rerender(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        dashboardLabel={null}
        onOpenDashboard={onOpenDashboard}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('多窗口时限制卡片高度并只滚动内容区，动作行保持在滚动区外', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          fiveHour: { utilization: 10 },
          sevenDay: { utilization: 20 },
          scoped: Array.from({ length: 6 }, (_, index) => ({
            modelDisplayName: `模型 ${index + 1}`,
            utilization: 30 + index,
          })),
        })}
        nowMs={NOW_MS}
        dashboardLabel="打开 Claude 用量页面"
      />,
    );

    const card = screen.getByTestId('quota-hover-card');
    const scrollContent = screen.getByTestId('quota-hover-card-scroll-content');
    const dashboardButton = screen.getByRole('button', { name: '打开 Claude 用量页面' });
    expect(
      card.classList.contains(
        'max-h-[min(calc(100vh-16px),var(--radix-popover-content-available-height,100vh))]',
      ),
    ).toBe(true);
    expect(scrollContent.classList.contains('min-h-0')).toBe(true);
    expect(scrollContent.classList.contains('overflow-y-auto')).toBe(true);
    expect(scrollContent.contains(dashboardButton)).toBe(false);
  });

  it('让滚动内容区进入 Tab 顺序并提供可访问名称', () => {
    render(<QuotaHoverCard snapshot={makeSnapshot()} nowMs={NOW_MS} />);

    const scrollContent = screen.getByRole('region', { name: '配额窗口列表' });
    expect(scrollContent.tabIndex).toBe(0);
  });

  it('shows a ten-minute stale footnote but omits a one-minute age', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ updatedAt: NOW_MS - 10 * 60_000 })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText('quotaCard.staleData:10')).toBeTruthy();

    rerender(
      <QuotaHoverCard snapshot={makeSnapshot({ updatedAt: NOW_MS - 60_000 })} nowMs={NOW_MS} />,
    );
    expect(screen.queryByText('quotaCard.staleData:10')).toBeNull();
  });

  it('shows the stale footnote only after the strict five-minute boundary', () => {
    const { rerender } = render(
      <QuotaHoverCard snapshot={makeSnapshot({ updatedAt: NOW_MS - 5 * 60_000 })} nowMs={NOW_MS} />,
    );

    expect(screen.queryByText('quotaCard.staleData:5')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ updatedAt: NOW_MS - 5 * 60_000 - 1 })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText('quotaCard.staleData:5')).toBeTruthy();
  });

  // 共享告警谓词把任何非 normal severity 视为告警，卡片的防御性映射不得降级。
  it.each([
    { severity: 'warning', utilization: 50, expected: 'warn' },
    { severity: undefined, utilization: 50, expected: 'normal' },
    { severity: '', utilization: 50, expected: 'normal' },
    { severity: 'unknown-upstream-value', utilization: 50, expected: 'warn' },
    { severity: 'hard_limit', utilization: 50, expected: 'warn' },
    { severity: 'quota_exceeded', utilization: 50, expected: 'crit' },
    { severity: 'critical', utilization: 50, expected: 'crit' },
    { severity: 'normal', utilization: 93, expected: 'crit' },
  ] as const)(
    'combines server severity $severity and $utilization% utilization as $expected',
    ({ severity, utilization, expected }) => {
      render(
        <QuotaHoverCard
          snapshot={makeSnapshot({ fiveHour: { utilization, severity } })}
          nowMs={NOW_MS}
        />,
      );

      expect(screen.getByText('5 小时').getAttribute('data-severity')).toBe(expected);
      expect(screen.getByRole('progressbar').getAttribute('data-severity')).toBe(expected);
    },
  );

  it('将脏快照中的非字符串 severity 当作缺失值，不让分模型窗口崩溃或升级', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          scoped: [
            {
              modelDisplayName: 'Opus',
              utilization: 50,
              severity: 123 as unknown as string,
            },
          ],
        })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText('Opus 周限').getAttribute('data-severity')).toBe('normal');
    expect(
      screen.getByRole('progressbar', { name: 'Opus 周限' }).getAttribute('data-severity'),
    ).toBe('normal');
  });

  it('将脏快照中的非数组 scoped 与非字符串套餐/限额字段当作缺失值，卡片不崩溃', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          fiveHour: { utilization: 50 },
          scoped: { corrupted: true } as unknown as ClaudeSubscriptionUsageSnapshot['scoped'],
          subscriptionType: 123 as unknown as string,
          rateLimitStatus: 456 as unknown as string,
        })}
        nowMs={NOW_MS}
      />,
    );

    // 有效窗口照常渲染；脏容器与脏字符串字段不产生分模型窗口、套餐徽章或限额行。
    expect(screen.getByText('5 小时')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.queryByTestId('quota-plan-badge')).toBeNull();
    expect(screen.queryByTestId('quota-status')).toBeNull();
  });

  it('按告警级别播报对应措辞，并让进度条使用同一可访问名称', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ fiveHour: { utilization: 50, severity: 'critical' } })}
        nowMs={NOW_MS}
      />,
    );

    const criticalHint = screen.getByText(/用量较高/);
    expect(criticalHint.classList.contains('sr-only')).toBe(true);
    expect(
      screen.getByRole('progressbar', {
        name: /5 小时.*用量较高/,
      }),
    ).toBeTruthy();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ fiveHour: { utilization: 50, severity: 'warning' } })}
        nowMs={NOW_MS}
      />,
    );

    const warningHint = screen.getByText(/用量偏高/);
    expect(warningHint.classList.contains('sr-only')).toBe(true);
    expect(screen.getByRole('progressbar', { name: /5 小时.*用量偏高/ })).toBeTruthy();
  });

  it('marks a critical window title with the critical styling hook', () => {
    render(
      <QuotaHoverCard snapshot={makeSnapshot({ sevenDay: { utilization: 93 } })} nowMs={NOW_MS} />,
    );

    const title = screen.getByText('周限');
    expect(title.getAttribute('data-severity')).toBe('crit');
    expect(title.classList.contains('text-[var(--quota-bar-crit)]')).toBe(true);
    expect(screen.getByRole('progressbar').getAttribute('data-severity')).toBe('crit');
  });

  it('keeps an over-limit off-current-model scoped weekly window visible and critical', () => {
    // 非当前模型的分模型周限爆量时,卡片必须可见地告警(不依赖 rateLimitStatus)——补 issue 1300 review advisory。
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          fiveHour: { utilization: 10 },
          sevenDay: { utilization: 20 },
          scoped: [
            {
              modelDisplayName: 'Opus',
              utilization: 93,
              resetsAt: epochSeconds(2026, 7, 8, 10, 0),
            },
          ],
        })}
        nowMs={NOW_MS}
      />,
    );

    const opusTitle = screen.getByText('Opus 周限');
    expect(opusTitle.getAttribute('data-severity')).toBe('crit');
    expect(opusTitle.classList.contains('text-[var(--quota-bar-crit)]')).toBe(true);
    expect(screen.getByText('5 小时').getAttribute('data-severity')).toBe('normal');
    expect(screen.getByText('周限').getAttribute('data-severity')).toBe('normal');
  });

  it.each([
    { label: '偏快', utilization: 31, expected: '按当前平均速度偏快（粗略趋势）' },
    { label: '+5 边界', utilization: 30, expected: '按当前平均速度正常（粗略趋势）' },
    { label: '正常', utilization: 25, expected: '按当前平均速度正常（粗略趋势）' },
    { label: '-5 边界', utilization: 20, expected: '按当前平均速度正常（粗略趋势）' },
    { label: '偏慢', utilization: 19, expected: '按当前平均速度偏慢（粗略趋势）' },
  ])('renders the $label weekly pace trend', ({ utilization, expected }) => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          updatedAt: NOW_MS,
          sevenDay: weeklyAtProgress(utilization, 0.25),
        })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByTestId('quota-pace').textContent).toBe(expected);
  });

  it('keeps the pace line muted at a 68-point critical delta', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ updatedAt: NOW_MS, sevenDay: weeklyAtProgress(93, 0.25) })}
        nowMs={NOW_MS}
      />,
    );

    const pace = screen.getByTestId('quota-pace');
    expect(pace.textContent).toBe('按当前平均速度偏快（粗略趋势）');
    expect(pace.getAttribute('data-severity')).toBeNull();
    expect(pace.classList.contains('text-[var(--text-secondary)]')).toBe(true);
    expect(pace.className).not.toContain('quota-bar-crit');
  });

  it('hides the pace line when the snapshot has no valid updatedAt observation time', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ sevenDay: weeklyAtProgress(31, 0.25) })}
        nowMs={NOW_MS}
      />,
    );

    // 没有观测时刻就无法把利用率钉在时间轴上;不算节奏,避免趋势随重渲染自跳档。
    expect(screen.queryByTestId('quota-pace')).toBeNull();
  });

  it('keeps the pace trend stable when the same snapshot renders 30 minutes later', () => {
    const snapshot = makeSnapshot({
      updatedAt: NOW_MS,
      sevenDay: weeklyAtProgress(30.1, 0.25),
    });
    const { rerender } = render(<QuotaHoverCard snapshot={snapshot} nowMs={NOW_MS} />);
    const originalText = screen.getByTestId('quota-pace').textContent;

    rerender(<QuotaHoverCard snapshot={snapshot} nowMs={NOW_MS + 30 * 60_000} />);

    expect(originalText).toBe('按当前平均速度偏快（粗略趋势）');
    expect(screen.getByTestId('quota-pace').textContent).toBe(originalText);
  });

  it('hides weekly pace after reset until a fresh snapshot arrives', () => {
    const resetsAtMs = NOW_MS - 60 * 60_000;
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          updatedAt: resetsAtMs - 24 * 60 * 60_000,
          sevenDay: {
            utilization: 30,
            resetsAt: resetsAtMs / 1000,
          },
        })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.queryByTestId('quota-pace')).toBeNull();
  });

  it('renders no pace for a scoped-only weekly snapshot', () => {
    // 分模型周限有意不做节奏预测（计划范围决定）。
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          scoped: [
            {
              modelDisplayName: 'Opus',
              ...weeklyAtProgress(93, 0.25),
            },
          ],
        })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText('Opus 周限')).toBeTruthy();
    expect(screen.queryByTestId('quota-pace')).toBeNull();
  });

  it('hides weekly pace when the window is missing, lacks a reset, or is under 3% elapsed', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          fiveHour: {
            utilization: 50,
            resetsAt: epochSeconds(2026, 7, 1, 12, 0),
          },
        })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.queryByTestId('quota-pace')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ sevenDay: { utilization: 30, resetsAt: null } })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.queryByTestId('quota-pace')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({
          sevenDay: {
            utilization: 30,
            resetsAt: epochSeconds(2026, 7, 8, 8, 0),
          },
        })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.queryByTestId('quota-pace')).toBeNull();
  });
});

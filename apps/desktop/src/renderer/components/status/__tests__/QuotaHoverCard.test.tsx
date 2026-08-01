// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      if (key === 'quotaCard.fiveHourLabel') return '5 小时';
      if (key === 'quotaCard.weeklyLabel') return '周限';
      if (key === 'quotaCard.modelWeeklyLabel') return `${options.model} 周限`;
      if (key === 'quotaCard.usedPercent') return `已用 ${options.percent}%`;
      if (key === 'quotaCard.resetAt') return `${options.at} 重置`;
      if (key === 'quotaCard.tokenBreakdown') {
        return `（输入 ${options.input} · 输出 ${options.output}）`;
      }
      if (key === 'quotaCard.staleData') return `quotaCard.staleData:${options.minutes}`;
      return key;
    },
  }),
}));

import { QuotaHoverCard } from '../QuotaHoverCard';

const NOW_MS = new Date(2026, 7, 1, 10, 0, 0).getTime();

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

describe('QuotaHoverCard', () => {
  it('renders only the waiting branch when snapshot is null', () => {
    render(<QuotaHoverCard snapshot={null} nowMs={NOW_MS} />);

    expect(screen.getByText('quotaCard.waiting')).toBeTruthy();
    expect(screen.queryByText('Claude')).toBeNull();
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
      <QuotaHoverCard
        nowMs={NOW_MS}
        snapshot={makeSnapshot({ fiveHour: { utilization: 250 } })}
      />,
    );

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect((bar.firstElementChild as HTMLElement | null)?.style.width).toBe('100%');
    expect(screen.getByText('已用 100%')).toBeTruthy();
  });

  it('omits a null subscription badge and maps max to Max', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ subscriptionType: null })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.queryByTestId('quota-plan-badge')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ subscriptionType: 'max' })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByTestId('quota-plan-badge').textContent).toBe('Max');
  });

  it('renders rejected and warning statuses while omitting allowed', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ rateLimitStatus: 'rejected' })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText('quotaCard.limitRejected')).toBeTruthy();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ rateLimitStatus: 'allowed_warning' })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.getByText('quotaCard.limitWarning')).toBeTruthy();
    expect(screen.queryByText('quotaCard.limitRejected')).toBeNull();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ rateLimitStatus: 'allowed' })}
        nowMs={NOW_MS}
      />,
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

  it('renders full turn usage, omits a null section, and hides a null suggestion', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={null}
        nowMs={NOW_MS}
        turnUsage={{
          costText: '$0.46',
          totalTokensText: '74.1K',
          inputTokens: 2,
          outputTokens: 16,
          cacheLineText: '读 0 · 写 74.0K · 命中 0%',
          model: 'claude-opus-5 [1m]',
          suggestionText: '缓存命中率偏低，本轮较多上下文重新计费',
        }}
      />,
    );

    expect(screen.getByText('quotaCard.turnCost')).toBeTruthy();
    expect(screen.getByText('$0.46')).toBeTruthy();
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

  it('shows a ten-minute stale footnote but omits a one-minute age', () => {
    const { rerender } = render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ updatedAt: NOW_MS - 10 * 60_000 })}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText('quotaCard.staleData:10')).toBeTruthy();

    rerender(
      <QuotaHoverCard
        snapshot={makeSnapshot({ updatedAt: NOW_MS - 60_000 })}
        nowMs={NOW_MS}
      />,
    );
    expect(screen.queryByText('quotaCard.staleData:10')).toBeNull();
  });

  it('marks a critical window title with the critical styling hook', () => {
    render(
      <QuotaHoverCard
        snapshot={makeSnapshot({ sevenDay: { utilization: 93 } })}
        nowMs={NOW_MS}
      />,
    );

    const title = screen.getByText('周限');
    expect(title.getAttribute('data-severity')).toBe('crit');
    expect(title.classList.contains('text-[var(--quota-bar-crit,#E5484D)]')).toBe(true);
    expect(screen.getByRole('progressbar').getAttribute('data-severity')).toBe('crit');
  });
});

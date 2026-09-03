// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { heatmapWeeksForWindow, resolveHeatmapWeeks, UsageHeatmap } from '../UsageHeatmap';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key === 'usageDashboard.tokensOnly' ? `${String(vars?.tokens)} tokens` : key,
    i18n: { language: 'en' },
  }),
}));

const money = (amount: number) => ({
  amount,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
});

/** 金额与 token 故意反向: 金额最大的那天 token 最少, 两种 metric 必须给出不同的深浅。 */
const days = [
  { day: '2026-08-20', money: money(100), tokens: 1_000 },
  { day: '2026-08-21', money: money(10), tokens: 100_000 },
  { day: '2026-08-22', money: money(1), tokens: 900_000 },
];

function cellStyles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('div.rounded-\\[3px\\]')].map(
    (cell) => cell.style.backgroundColor,
  );
}

function cellTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('div.rounded-\\[3px\\]')]
    .map((cell) => cell.title)
    .filter(Boolean);
}

describe('UsageHeatmap metric', () => {
  it('至少显示 20 周，且宽容器会展示数据覆盖的更多周数', () => {
    expect(
      resolveHeatmapWeeks({
        days: [{ day: '2026-08-22' }],
        todayKey: '2026-08-22',
        availableWidth: 100,
      }),
    ).toBe(20);

    expect(
      resolveHeatmapWeeks({
        days: [{ day: '2026-01-01' }],
        todayKey: '2026-08-22',
        availableWidth: 500,
      }),
    ).toBe(33);

    expect(
      resolveHeatmapWeeks({
        days: [{ day: '2025-01-01' }],
        todayKey: '2026-08-22',
        availableWidth: 500,
      }),
    ).toBe(33);

    expect(
      resolveHeatmapWeeks({
        days: [{ day: '2025-01-01' }],
        todayKey: '2026-08-22',
        availableWidth: 900,
      }),
    ).toBe(60);
  });

  it('按当前 metric 过滤历史起点，不让零值日期扩展热力图', () => {
    const history = [
      { day: '2025-01-01', money: money(100), tokens: 0 },
      { day: '2026-08-20', money: money(0), tokens: 1_000 },
    ];

    expect(
      resolveHeatmapWeeks({
        days: history,
        todayKey: '2026-08-22',
        availableWidth: 900,
        metric: 'money',
      }),
    ).toBe(60);
    expect(
      resolveHeatmapWeeks({
        days: history,
        todayKey: '2026-08-22',
        availableWidth: 900,
        metric: 'tokens',
      }),
    ).toBe(20);
  });

  it('周日锚点也覆盖完整的 windowDays 历史，不把未来占位挤掉最早日期', () => {
    expect(heatmapWeeksForWindow('2026-08-22', 140)).toBe(20);
    expect(heatmapWeeksForWindow('2026-08-23', 140)).toBe(21);
    expect(
      resolveHeatmapWeeks({
        days: [{ day: '2026-08-23' }],
        todayKey: '2026-08-23',
        availableWidth: 100,
        windowDays: 140,
      }),
    ).toBe(21);
  });

  it('月份标签保持单行，避免最右侧月份换行', () => {
    const { container } = render(<UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} />);
    const monthLabel = [...container.querySelectorAll('span')].find((node) =>
      node.className.includes('whitespace-nowrap'),
    );
    expect(monthLabel).toBeTruthy();
  });

  it('分桶取值随 metric 切换 (金额口径与 token 口径给出不同深浅)', () => {
    const asMoney = render(<UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} />);
    const moneyStyles = cellStyles(asMoney.container);
    asMoney.unmount();

    const asTokens = render(
      <UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} metric="tokens" />,
    );
    const tokenStyles = cellStyles(asTokens.container);

    expect(moneyStyles.length).toBe(tokenStyles.length);
    expect(moneyStyles).not.toEqual(tokenStyles);
  });

  it('只用当前可见日期计算分桶阈值', () => {
    const visibleDays = [
      { day: '2026-08-20', money: money(10), tokens: 10 },
      { day: '2026-08-21', money: money(20), tokens: 20 },
      { day: '2026-08-22', money: money(30), tokens: 30 },
    ];
    const withOlderOutlier = [
      { day: '2025-01-01', money: money(1_000_000), tokens: 1_000_000 },
      ...visibleDays,
    ];

    const baseline = render(
      <UsageHeatmap days={visibleDays} todayKey="2026-08-22" windowDays={7} />,
    );
    const baselineCell = baseline.container.querySelector<HTMLDivElement>(
      'div[title^="2026-08-21"]',
    );
    const baselineColor = (baselineCell as HTMLElement).style.backgroundColor;
    baseline.unmount();

    const withOutlier = render(
      <UsageHeatmap days={withOlderOutlier} todayKey="2026-08-22" windowDays={7} />,
    );
    const outlierCell = withOutlier.container.querySelector<HTMLDivElement>(
      'div[title^="2026-08-21"]',
    );
    expect((outlierCell as HTMLElement).style.backgroundColor).toBe(baselineColor);
  });

  it('token 口径的 tooltip 不出现金额', () => {
    const { container } = render(
      <UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} metric="tokens" />,
    );
    const titles = cellTitles(container);
    expect(titles.some((title) => title.includes('tokens'))).toBe(true);
    expect(titles.some((title) => title.includes('$'))).toBe(false);
  });

  it('默认仍是金额口径 (首页仪表盘行为不变)', () => {
    const { container } = render(<UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} />);
    expect(cellTitles(container).some((title) => title.includes('$'))).toBe(true);
  });

  it('日期格可点击并上报所选日期', () => {
    const onDayClick = vi.fn();
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        onDayClick={onDayClick}
      />,
    );

    fireEvent.click(getByRole('button', { name: /Aug 21, 2026/ }));
    expect(onDayClick).toHaveBeenCalledWith('2026-08-21');
  });

  it('可点击日期格保留小视觉标记但提供 24px 命中区域', () => {
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        onDayClick={vi.fn()}
      />,
    );

    const button = getByRole('button', { name: /Aug 21, 2026/ });
    const visual = button.firstElementChild as HTMLElement;
    expect(button.style.width).toBe('24px');
    expect(button.style.height).toBe('24px');
    expect(visual.style.width).toBe('12px');
    expect(visual.style.height).toBe('12px');
  });

  it('今天的日期格不是未来占位，并且可以点击', () => {
    const onDayClick = vi.fn();
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        onDayClick={onDayClick}
      />,
    );

    fireEvent.click(getByRole('button', { name: /Aug 22, 2026/ }));
    expect(onDayClick).toHaveBeenCalledWith('2026-08-22');
  });

  it('首页非交互日期格不渲染为禁用按钮', () => {
    const { container, queryByRole } = render(
      <UsageHeatmap days={days} todayKey="2026-08-22" windowDays={7} metric="tokens" />,
    );

    expect(queryByRole('button', { name: /Aug 21, 2026/ })).toBeNull();
    expect(container.querySelector('div[title^="2026-08-21"]')).toBeTruthy();
  });

  it('可点击日期格的可见彩色表面使用 pill 圆角', () => {
    const onDayClick = vi.fn();
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        onDayClick={onDayClick}
      />,
    );

    expect(getByRole('button', { name: /Aug 21, 2026/ }).firstElementChild?.className).toContain(
      'rounded-full',
    );
  });

  it('可访问名称包含本地化日期和用量摘要', () => {
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        onDayClick={vi.fn()}
      />,
    );

    expect(getByRole('button', { name: /Aug 21, 2026.*tokens/ })).toBeTruthy();
  });

  it('选中日期使用 outline 而不是页面内阴影', () => {
    const { getByRole } = render(
      <UsageHeatmap
        days={days}
        todayKey="2026-08-22"
        windowDays={7}
        metric="tokens"
        selectedDay="2026-08-21"
        onDayClick={vi.fn()}
      />,
    );

    const selectedCell = getByRole('button', { name: /Aug 21, 2026/ })
      .firstElementChild as HTMLElement;
    expect(selectedCell.style.outline).toBe('2px solid var(--focus-ring-soft)');
    expect(selectedCell.style.boxShadow).toBe('');
  });
});

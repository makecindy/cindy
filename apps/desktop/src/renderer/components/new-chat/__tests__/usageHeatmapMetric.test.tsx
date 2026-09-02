// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { resolveHeatmapWeeks, UsageHeatmap } from '../UsageHeatmap';

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

    fireEvent.click(getByRole('button', { name: '2026-08-21' }));
    expect(onDayClick).toHaveBeenCalledWith('2026-08-21');
  });
});

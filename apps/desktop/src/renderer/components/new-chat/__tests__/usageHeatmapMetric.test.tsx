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
  return [...container.querySelectorAll<HTMLElement>('[data-usage-mark="usage-heatmap-day"]')].map(
    (cell) => cell.style.backgroundColor,
  );
}

function cellTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-usage-mark="usage-heatmap-day"]')]
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

  // User-selected annual view: older history must not extend the window on wide screens.
  // Unit: the real component must expose a full year, without exposing older dates.
  it('全年视图在宽屏也固定为一年，不随更早记录扩展日期', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1600);
    const { getByRole, queryByRole } = render(
      <UsageHeatmap
        days={[{ day: '2024-01-01', money: money(1), tokens: 10 }, ...days]}
        todayKey="2026-08-22"
        windowDays={365}
        fillWidth
        metric="tokens"
        onDayClick={vi.fn()}
      />,
    );
    width.mockRestore();
    expect(queryByRole('button', { name: /Aug 23, 2024/ })).toBeNull();
    expect(getByRole('button', { name: /Aug 23, 2025/ })).toBeTruthy();
    expect(getByRole('button', { name: /Aug 22, 2026/ })).toBeTruthy();
    expect(queryByRole('button', { name: /Jan 1, 2024/ })).toBeNull();
    expect(queryByRole('button', { name: /Aug 23, 2026/ })).toBeNull();
  });

  it.each([
    { name: '无记录', records: [], annual: false },
    { name: '未满半年', records: [{ day: '2026-03-01', money: money(0), tokens: 1 }], annual: false },
    { name: '月末恰好满半年', records: [{ day: '2026-02-28', money: money(0), tokens: 1 }], annual: true },
    { name: '旧零用量不算开始使用', records: [{ day: '2024-01-01', money: money(10), tokens: 0 }], annual: false },
    { name: '超过一年仍限定一年', records: [{ day: '2024-01-01', money: money(0), tokens: 1 }], annual: true },
  ])('自动窗口：$name', ({ records, annual }) => {
    const { container } = render(
      <UsageHeatmap days={records} todayKey="2026-08-31" windowDays="auto" fillWidth metric="tokens" />,
    );
    const titles = cellTitles(container);
    expect(titles.some((title) => title.startsWith('2026-02-28'))).toBe(true);
    expect(titles.some((title) => title.startsWith('2025-09-01'))).toBe(annual);
    expect(titles.some((title) => title.startsWith('2024-01-01'))).toBe(false);
    expect(titles.some((title) => title.startsWith('2026-09-01'))).toBe(false);
  });

  it('短期布局补满四行连续日期，标题和点击对应实际窗口', () => {
    const onDayClick = vi.fn();
    const onVisibleWeeksChange = vi.fn();
    const { container, getByRole } = render(
      <UsageHeatmap
        days={[{ day: '2026-06-01', money: money(0), tokens: 1 }]}
        todayKey="2026-11-12"
        windowDays="auto"
        fillWidth
        metric="tokens"
        onDayClick={onDayClick}
        onVisibleWeeksChange={onVisibleWeeksChange}
      />,
    );
    const dates = cellTitles(container).map((title) => title.split(' · ')[0]);
    expect(dates).toHaveLength(212);
    expect(new Set(dates).size).toBe(212);
    expect(dates[0]).toBe('2026-04-15');
    expect(dates.at(-1)).toBe('2026-11-12');
    expect(onVisibleWeeksChange).toHaveBeenLastCalledWith(31);
    fireEvent.click(getByRole('button', { name: /Apr 15, 2026/ }));
    expect(onDayClick).toHaveBeenCalledWith('2026-04-15');
  });

  it('历史数据或日期锚点变化时自动重新选择半年或全年', () => {
    const records = [{ day: '2026-03-01', money: money(0), tokens: 1 }];
    const view = (history: typeof records, todayKey: string) => (
      <UsageHeatmap days={history} todayKey={todayKey} windowDays="auto" fillWidth metric="tokens" />
    );
    const { container, rerender } = render(view(records, '2026-08-31'));
    expect(cellTitles(container).some((title) => title.startsWith('2025-09-02'))).toBe(false);
    rerender(view(records, '2026-09-01'));
    expect(cellTitles(container).some((title) => title.startsWith('2025-09-02'))).toBe(true);
    rerender(view([], '2026-09-01'));
    expect(cellTitles(container).some((title) => title.startsWith('2025-09-02'))).toBe(false);
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

  it('可点击日期格保持 12px 密度，等价日期入口由用量历史提供', () => {
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
    expect(button.title).toContain('2026-08-21');
    expect(button.style.width).toBe('12px');
    expect(button.style.height).toBe('12px');
    expect(visual.style.width).toBe('calc(12px + var(--usage-mark-grow, 0px))');
    expect(visual.style.height).toBe('calc(12px + var(--usage-mark-grow, 0px))');
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

  it('点击与非点击日期格共享登记形状，不把可见表面改为 pill', () => {
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
      'rounded-[2px]',
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

    const button = getByRole('button', { name: /Aug 21, 2026/ });
    const selectedCell = button.firstElementChild as HTMLElement;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(selectedCell.style.outline).toBe('');
    expect(selectedCell.style.boxShadow).toBe('');
    expect(button.lastElementChild?.className).toContain('usage-chart-indicator');
    expect(button.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

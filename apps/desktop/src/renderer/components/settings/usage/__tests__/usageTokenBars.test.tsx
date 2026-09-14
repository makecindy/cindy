// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTokenBars } from '../UsageTokenBars';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);
const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};
const modelDaily = [
  {
    day: '2026-09-07',
    agentKind: 'claude-code' as const,
    model: 'fixture-model',
    tokens: 300,
    money,
    apiMoney: money,
    subscriptionEstimateMoney: money,
  },
];

describe('UsageTokenBars registered geometry and interaction', () => {
  it('highlights seven calendar dates without selecting them and clears emphasis for an older day', () => {
    const props = {
      modelDaily: [],
      colorOrder: [],
      todayKey: '2026-09-03',
      onDayClick: vi.fn(),
    };
    const view = render(<UsageTokenBars {...props} />);
    const highlightedDays = () =>
      [...view.container.querySelectorAll<HTMLButtonElement>('[data-highlighted="true"]')].map(
        (button) => button.title.slice(0, 10),
      );
    expect(highlightedDays()).toEqual([]);
    view.rerender(<UsageTokenBars {...props} highlightRecentWeek />);
    expect(highlightedDays()).toEqual([
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    // An exact date takes priority, including one outside the fixed chart window.
    view.rerender(<UsageTokenBars {...props} highlightRecentWeek selectedDay="2026-07-18" />);
    expect(highlightedDays()).toEqual([]);
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    view.rerender(<UsageTokenBars {...props} highlightRecentWeek selectedDay="2026-09-01" />);
    expect(highlightedDays()).toEqual(['2026-09-01']);
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-usage-mark="usage-token-bar"]')).toHaveLength(30);
  });

  it('preserves data encoding when clicking is enabled or disabled', () => {
    const view = render(
      <UsageTokenBars modelDaily={modelDaily} colorOrder={[]} todayKey="2026-09-08" />,
    );
    const marks = () => [
      ...view.container.querySelectorAll<HTMLElement>('[data-usage-mark="usage-token-bar"]'),
    ];
    expect(marks()).toHaveLength(30);
    const passive = marks().map((mark) => mark.outerHTML);
    const onDayClick = vi.fn();
    view.rerender(
      <UsageTokenBars
        modelDaily={modelDaily}
        colorOrder={[]}
        todayKey="2026-09-08"
        onDayClick={onDayClick}
      />,
    );
    expect(marks().map((mark) => mark.outerHTML)).toEqual(passive);
    const usedDay = view.getByRole('button', { name: /Sep 7, 2026/ });
    fireEvent.click(usedDay);
    expect(onDayClick).toHaveBeenCalledWith('2026-09-07');
    expect((usedDay.firstElementChild as HTMLElement).style.height).toBe('96px');
    expect(usedDay.firstElementChild?.className).toContain('rounded-[2px]');
  });

  it('keeps empty days selectable without inflating their encoded height or column width', () => {
    const onDayClick = vi.fn();
    const view = render(
      <UsageTokenBars
        modelDaily={modelDaily}
        colorOrder={[]}
        todayKey="2026-09-08"
        selectedDay="2026-09-08"
        onDayClick={onDayClick}
      />,
    );
    const emptyDay = view.getByRole('button', { name: /Sep 8, 2026/ });
    expect(emptyDay.getAttribute('aria-pressed')).toBe('true');
    expect(emptyDay.style.height).toBe('24px');
    expect(emptyDay.style.minWidth).toBe('');
    const mark = emptyDay.firstElementChild as HTMLElement;
    expect(mark.style.height).toBe('2px');
    expect(mark.style.outline).toBe('');
    expect(emptyDay.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(emptyDay);
    expect(onDayClick).toHaveBeenCalledWith('2026-09-08');
  });
});

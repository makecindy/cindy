// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsageHeatmap } from '../../../new-chat/UsageHeatmap';
import { UsageTokenBars } from '../UsageTokenBars';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);

describe('Usage data marks retain geometry when clickable', () => {
  it('keeps heatmap dates compact and square while allowing click and keyboard activation', () => {
    const onDayClick = vi.fn();
    const { container } = render(
      <UsageHeatmap
        days={[]}
        todayKey="2026-09-07"
        windowDays={140}
        metric="tokens"
        selectedDay="2026-09-07"
        onDayClick={onDayClick}
      />,
    );
    const today = screen.getByRole('button', { pressed: true });
    expect(today.style.width).toBe('12px');
    expect(today.style.height).toBe('12px');
    expect(today.classList.contains('rounded-full')).toBe(false);
    // Merged implementation (PR #4076): the visual mark keeps the registered 2px
    // shape under the usage-chart-mark member class, and focus/selection indication
    // lives on the separate usage-chart-indicator layer (usageCharts.css), not an
    // inline outline on the data mark.
    expect(today.firstElementChild?.className).toContain('rounded-[2px]');
    expect(today.firstElementChild?.getAttribute('data-usage-mark')).toBe('usage-heatmap-day');
    expect(today.querySelector('.usage-chart-indicator')).toBeTruthy();
    fireEvent.click(today);
    expect(onDayClick).toHaveBeenCalledWith('2026-09-07');
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(140);
    expect(container.textContent).not.toContain('USD');
  });

  it('keeps all 30 days fluid and preserves zero-day filter targets', () => {
    const onDayClick = vi.fn();
    const { container } = render(
      <UsageTokenBars
        modelDaily={[]}
        colorOrder={[]}
        todayKey="2026-09-07"
        selectedDay="2026-09-07"
        onDayClick={onDayClick}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(30);
    expect(buttons.every((button) => button.style.minWidth === '')).toBe(true);
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
    const today = screen.getByRole('button', { pressed: true });
    expect(today).toBe(buttons[29]);
    expect(today.style.height).toBe('24px');
    expect((today.firstElementChild as HTMLElement).style.height).toBe('2px');
    expect(today.firstElementChild?.classList.contains('rounded-full')).toBe(false);
    fireEvent.click(today);
    expect(onDayClick).toHaveBeenCalledWith('2026-09-07');
  });
});

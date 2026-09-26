// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTokenBars } from '../UsageTokenBars';
import { tooltipRows } from '../UsageBarsTooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
    i18n: { language: 'en' },
  }),
}));
afterEach(cleanup);

const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};
const row = (model: string, tokens: number) => ({
  day: '2026-09-26',
  agentKind: 'codex' as const,
  model,
  tokens,
  money,
  apiMoney: money,
  subscriptionEstimateMoney: money,
});

describe('usage bars tooltip', () => {
  it('orders rows by tokens and folds the tail beyond six models', () => {
    const segments = [1, 9, 3, 7, 5, 2, 8, 4].map((tokens) => ({
      key: tokens,
      label: `m${tokens}`,
      tokens,
      color: 'red',
    }));
    const { rows, hiddenCount, hiddenTokens } = tooltipRows(segments);
    expect(rows.map((r) => r.tokens)).toEqual([9, 8, 7, 5, 4, 3]);
    expect(hiddenCount).toBe(2);
    expect(hiddenTokens).toBe(3);
  });

  it('replaces the native title with one shared tooltip on hover and focus', () => {
    const view = render(
      <UsageTokenBars
        modelDaily={[row('small', 100), row('big', 900)]}
        colorOrder={['codex big', 'codex small']}
        todayKey="2026-09-26"
        onDayClick={vi.fn()}
      />,
    );
    const bar = view.container.querySelector<HTMLButtonElement>('button[data-day="2026-09-26"]')!;
    expect(bar.hasAttribute('title')).toBe(false);
    expect(screen.queryByTestId('usage-bars-tooltip')).toBeNull();

    fireEvent.pointerOver(bar);
    const tooltip = screen.getByTestId('usage-bars-tooltip');
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    const text = tooltip.textContent ?? '';
    expect(text.indexOf('big')).toBeLessThan(text.indexOf('small'));
    expect(text).toContain('90%');
    expect(text).toContain('10%');

    fireEvent.pointerOut(bar.parentElement!, { relatedTarget: document.body });
    expect(screen.queryByTestId('usage-bars-tooltip')).toBeNull();

    fireEvent.focus(bar);
    expect(screen.getByTestId('usage-bars-tooltip')).toBeTruthy();
    fireEvent.blur(bar);
    expect(screen.queryByTestId('usage-bars-tooltip')).toBeNull();
  });

  it('shows the empty-day message for a day without usage', () => {
    const view = render(
      <UsageTokenBars modelDaily={[]} colorOrder={[]} todayKey="2026-09-26" onDayClick={vi.fn()} />,
    );
    fireEvent.pointerOver(view.container.querySelector('button[data-day="2026-09-20"]')!);
    expect(screen.getByTestId('usage-bars-tooltip').textContent).toContain(
      'usageHistory.heatmap.emptyCell',
    );
  });
});

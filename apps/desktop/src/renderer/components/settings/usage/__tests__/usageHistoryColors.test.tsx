// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usageHistoryAgentColor, usageHistoryModelColor } from '../usageHistoryColors';
import { UsageAgentTable, UsageModelTable } from '../UsageBreakdownTables';
import { UsageTokenBars } from '../UsageTokenBars';
import type { ModelTokenRow } from '../usageHistoryStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);

describe('Usage History model colors', () => {
  it('colors arbitrarily long model lists while retaining the first five theme colors', () => {
    const colors = Array.from({ length: 1000 }, (_, i) => usageHistoryModelColor(i, 1000));
    expect(new Set(colors).size).toBe(1000);
    expect(colors.every((color) => color.includes('var(--usage-model-'))).toBe(true);
    expect(colors.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map((i) => `var(--usage-model-${i})`));
    expect(usageHistoryModelColor(34, 35)).toBe(usageHistoryModelColor(34, 1000));
    // Only an actually missing identity gets the neutral fallback, not rank >= 5.
    expect(usageHistoryModelColor(2, 2)).toBe('var(--text-tertiary)');
    expect(usageHistoryModelColor(0, 0)).toBe('var(--text-tertiary)');
    expect(usageHistoryModelColor(5, 5)).toBe('var(--text-tertiary)');
  });

  it('matches all three Agent marks and keeps identity colors when rankings reverse', () => {
    expect(
      ['claude-code', 'codex', 'pi'].map((kind) =>
        usageHistoryAgentColor(kind as 'claude-code' | 'codex' | 'pi'),
      ),
    ).toEqual(['var(--engine-badge-cc)', 'var(--engine-badge-codex)', 'var(--usage-model-1)']);
    const rows = (['claude-code', 'codex', 'pi'] as const).map((agentKind, i) => ({
      agentKind,
      tokens: (3 - i) * 100,
      todayTokens: 0,
      share: (3 - i) / 6,
      cacheHitRate: 0.8,
      modelCount: 12,
    }));
    const view = render(<UsageAgentTable rows={rows} rangeLabel="all" />);
    const checkColors = (order: typeof rows) => {
      const segments = view.container.querySelectorAll<HTMLElement>('div[title]');
      order.forEach((row, i) => {
        const color = usageHistoryAgentColor(row.agentKind);
        const swatch = view.getByText(row.agentKind).previousElementSibling as HTMLElement;
        const share = swatch.closest('tr')!.querySelector<HTMLElement>('.inline-block')!;
        expect(swatch.style.backgroundColor).toBe(color);
        expect(share.style.backgroundColor).toBe(color);
        expect(segments[i].style.backgroundColor).toBe(color);
      });
    };
    checkColors(rows);
    view.rerender(<UsageAgentTable rows={[...rows].reverse()} rangeLabel="day" />);
    checkColors([...rows].reverse());
  });

  it('keeps 35 model segments separate and matched to filtered table rows', () => {
    const rows: ModelTokenRow[] = Array.from({ length: 35 }, (_, i) => ({
      key: `claude-code model-${i}`,
      agentKind: 'claude-code',
      model: `model-${i}`,
      tokens: i + 1,
      inputTokens: i + 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      share: (i + 1) / 630,
      cacheHitRate: 0,
    }));
    const colorOrder = rows.map((row) => row.key);
    const money = {
      amount: 0,
      currency: 'USD' as const,
      approximate: false,
      kind: 'actual-cost' as const,
    };
    const props = {
      todayKey: '2026-09-09',
      colorOrder,
      modelDaily: rows.map((row) => ({
        ...row,
        day: '2026-09-09',
        money,
        apiMoney: money,
        subscriptionEstimateMoney: money,
      })),
    };
    const view = render(
      <>
        <UsageTokenBars {...props} />
        <UsageModelTable rows={rows} colorOrder={colorOrder} rangeLabel="all" />
      </>,
    );
    const mark = view.container.querySelector<HTMLElement>(
      'button[title^="2026-09-09"] [data-usage-mark]',
    )!;
    expect(mark.children).toHaveLength(35);
    expect(mark.style.height).toBe('96px');
    const segments = [...mark.children].reverse() as HTMLElement[];
    rows.forEach((row, i) => {
      const swatch = view.getByText(row.model).previousElementSibling as HTMLElement;
      expect(swatch.style.backgroundColor).not.toBe('');
      expect(swatch.style.backgroundColor).not.toBe('var(--text-tertiary)');
      expect(swatch.style.backgroundColor).toBe(segments[i].style.backgroundColor);
      expect(parseFloat(segments[i].style.height)).toBeCloseTo((row.tokens / 630) * 100);
    });
    const lastColor = segments[34].style.backgroundColor;
    view.rerender(
      <>
        <UsageTokenBars {...props} />
        <UsageModelTable rows={[rows[34]]} colorOrder={colorOrder} rangeLabel="day" />
      </>,
    );
    expect(
      (view.getByText('model-34').previousElementSibling as HTMLElement).style.backgroundColor,
    ).toBe(lastColor);
  });

  it('keeps a model swatch matched to its bar segment after filtering and reordering rows', () => {
    const colorOrder = ['claude-code first', 'claude-code second'];
    const money = {
      amount: 0,
      currency: 'USD' as const,
      approximate: false,
      kind: 'actual-cost' as const,
    };
    const row: ModelTokenRow = {
      key: colorOrder[1],
      agentKind: 'claude-code',
      model: 'second',
      tokens: 100,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      share: 1,
      cacheHitRate: 0,
    };
    const view = render(
      <>
        <UsageTokenBars
          todayKey="2026-09-08"
          colorOrder={colorOrder}
          modelDaily={[
            {
              day: '2026-09-08',
              agentKind: 'claude-code',
              model: 'second',
              tokens: 100,
              money,
              apiMoney: money,
              subscriptionEstimateMoney: money,
            },
          ]}
        />
        <UsageModelTable rows={[row]} colorOrder={colorOrder} rangeLabel="day" />
      </>,
    );
    const mark = view.container.querySelector('button[title^="2026-09-08"] [data-usage-mark]')!;
    const segment = mark.firstElementChild as HTMLElement;
    const swatch = view.getByText('second').previousElementSibling as HTMLElement;
    expect(segment.style.backgroundColor).toBe('var(--usage-model-2)');
    expect(swatch.style.backgroundColor).toBe(segment.style.backgroundColor);
  });
});

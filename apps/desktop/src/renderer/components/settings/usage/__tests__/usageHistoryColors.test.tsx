// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usageHistoryModelColor } from '../usageHistoryColors';
import { UsageModelTable } from '../UsageBreakdownTables';
import { UsageTokenBars } from '../UsageTokenBars';
import type { ModelTokenRow } from '../usageHistoryStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);

describe('Usage History model colors', () => {
  it('reserves five distinct colors and keeps unlisted models neutral even in short lists', () => {
    expect(new Set(Array.from({ length: 5 }, (_, i) => usageHistoryModelColor(i, 5))).size).toBe(5);
    expect(usageHistoryModelColor(2, 2)).toBe('var(--text-tertiary)');
    expect(usageHistoryModelColor(0, 0)).toBe('var(--text-tertiary)');
    expect(usageHistoryModelColor(5, 5)).toBe('var(--text-tertiary)');
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

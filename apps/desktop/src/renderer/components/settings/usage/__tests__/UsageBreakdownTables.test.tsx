// @vitest-environment jsdom

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UsageAgentTable, UsageModelTable } from '../UsageBreakdownTables';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('UsageBreakdownTables responsive layout', () => {
  it('keeps the agent table wide enough for numeric columns to scroll instead of overlap', () => {
    const { container } = render(
      <UsageAgentTable
        rows={[
          {
            agentKind: 'claude-code',
            tokens: 1_000,
            share: 1,
            todayTokens: 100,
            cacheHitRate: 0.5,
            modelCount: 1,
          },
        ]}
      />,
    );

    const table = container.querySelector('table');
    expect(table?.className).toContain('min-w-[520px]');
    expect(table?.querySelector('tbody td')?.className).toContain('overflow-hidden');
  });

  it('keeps the wider model table scrollable and clips first-column decorations at its boundary', () => {
    const { container } = render(
      <UsageModelTable
        rows={[
          {
            key: 'codex:very-long-model-name',
            agentKind: 'codex',
            model: 'very-long-model-name-that-must-not-overlap-token-columns',
            tokens: 1_000,
            share: 1,
            inputTokens: 400,
            outputTokens: 300,
            cacheReadTokens: 200,
            cacheCreateTokens: 100,
            cacheHitRate: 0.5,
          },
        ]}
      />,
    );

    const table = container.querySelector('table');
    expect(table?.className).toContain('min-w-[720px]');
    expect(table?.querySelector('tbody td')?.className).toContain('overflow-hidden');
  });
});

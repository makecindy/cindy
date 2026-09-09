// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageHistoryPayload } from '@/hooks/useUsageHistory';
import { UsageHistorySection } from '../UsageHistorySection';

const state = vi.hoisted(() => ({ history: null as UsageHistoryPayload | null, taskRange: '' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useUsageHistory', () => ({
  useUsageHistory: () => ({ history: state.history, refreshing: false }),
}));
vi.mock('../UsageTaskTable', () => ({
  useTopTokenSessions: (range: string) => {
    state.taskRange = range;
    return [];
  },
  UsageTaskTable: () => null,
}));
vi.mock('../UsageStatRow', () => ({
  UsageStatRow: (props: unknown) => <output data-testid="summary">{JSON.stringify(props)}</output>,
}));
vi.mock('../UsageBreakdownTables', () => ({
  UsageAgentTable: (props: unknown) => (
    <output data-testid="agents">{JSON.stringify(props)}</output>
  ),
  UsageModelTable: (props: unknown) => (
    <output data-testid="models">{JSON.stringify(props)}</output>
  ),
}));
afterEach(cleanup);
const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};
function history(): UsageHistoryPayload {
  return {
    generatedAt: 0,
    todayKey: '2026-08-22',
    days: [
      { day: '2026-08-20', money, tokens: 100 },
      { day: '2026-08-21', money, tokens: 200 },
    ],
    modelDaily: ['2026-08-20', '2026-08-21'].map((day, i) => ({
      day,
      agentKind: 'claude-code',
      model: 'fixture-model',
      money,
      apiMoney: money,
      subscriptionEstimateMoney: money,
      tokens: 100 * (i + 1),
      inputTokens: 100 * (i + 1),
    })),
    models: [
      {
        agentKind: 'claude-code',
        model: 'fixture-model',
        money,
        estimatedMoney: null,
        inputTokens: 300,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    ],
    totals: {
      today: money,
      last30Days: money,
      last30DaysWithEstimatedValue: money,
      last30DaysEstimatedValue: money,
      todayTokens: 0,
      last30DaysTokens: 300,
    },
    streak: { current: 0, longest: 2 },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };
}

describe('Usage history selection behavior', () => {
  it('keeps both chart filters equivalent and preserves default, repeated and outside clicks', () => {
    state.history = history();
    const view = render(<UsageHistorySection />);
    const marks = () =>
      [...view.container.querySelectorAll('[data-usage-mark]')].map((e) => e.outerHTML);
    const initialMarks = marks();
    const snapshot = () =>
      ['summary', 'agents', 'models'].map((id) => view.getByTestId(id).textContent);
    expect(state.taskRange).toBe('30d');
    expect(view.container.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(view.container.querySelector('input[type="date"]')).toBeNull();
    const dayTargets = () => view.getAllByRole('button', { name: /Aug 21, 2026/ });
    expect(dayTargets()).toHaveLength(2);
    fireEvent.click(dayTargets()[0]);
    expect(state.taskRange).toBe('day:2026-08-21');
    const heatmapResult = snapshot();
    fireEvent.click(view.getAllByRole('button', { name: /Aug 20, 2026/ })[0]);
    fireEvent.click(dayTargets()[1]);
    expect(snapshot()).toEqual(heatmapResult);
    fireEvent.click(dayTargets()[1]);
    fireEvent.click(view.getByRole('heading'));
    expect(state.taskRange).toBe('day:2026-08-21');
    expect(snapshot()).toEqual(heatmapResult);
    expect(marks()).toEqual(initialMarks);
    // Zero-usage and padded history dates retain the same exact-day route.
    const oldestTarget = view.container.querySelector<HTMLButtonElement>('[aria-pressed]')!;
    fireEvent.click(oldestTarget);
    expect(state.taskRange).toMatch(/^day:/);
    expect(oldestTarget.getAttribute('aria-pressed')).toBe('true');
    expect(marks()).toEqual(initialMarks);
  });
});

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageHourlyTokens } from '../UsageHourlyTokens';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`,
    i18n: { language: 'en' },
  }),
}));
afterEach(cleanup);

describe('hourly token distribution', () => {
  it('shows tied peaks and all 24 hours, and follows the selected date', () => {
    const rows = [
      { day: '2026-10-16', hour: 8, tokens: 100 },
      { day: '2026-10-16', hour: 9, tokens: 100 },
      { day: '2026-10-15', hour: 20, tokens: 300 },
    ];
    const view = render(<UsageHourlyTokens rows={rows} day="2026-10-16" />);
    expect(view.getByText(/usageHistory.hourly.peak/).textContent).toContain(
      '08:00–09:00, 09:00–10:00',
    );
    expect(view.getByText(/usageHistory.hourly.peak/).textContent).toContain('50%');
    fireEvent.click(view.getByText('usageHistory.hourly.details'));
    expect(view.getAllByRole('row')).toHaveLength(25);
    expect(view.getByRole('rowheader', { name: '23:00–24:00' })).toBeTruthy();
    view.rerender(<UsageHourlyTokens rows={rows} day="2026-10-15" />);
    expect(view.getByText(/usageHistory.hourly.peak/).textContent).toContain('20:00');
    expect(view.getByText(/usageHistory.hourly.peak/).textContent).toContain('100%');
  });

  it('does not interpret missing historical data as measured zero consumption', () => {
    const view = render(<UsageHourlyTokens rows={[]} day="2026-10-01" />);
    expect(view.getByText('usageHistory.hourly.empty')).toBeTruthy();
    expect(view.queryByRole('img')).toBeNull();
    expect(view.queryByRole('status')).toBeNull();
    view.rerender(<UsageHourlyTokens day="2026-10-01" />);
    expect(view.getByRole('status').textContent).toBe('usageHistory.hourly.partial');
    view.rerender(<UsageHourlyTokens rows={[]} day="2026-10-01" incomplete />);
    expect(view.getByRole('status')).toBeTruthy();
  });
});

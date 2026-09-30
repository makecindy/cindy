// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { ScheduleChip } from '../ScheduleChips';

afterEach(cleanup);

function renderChip(cronExpr: string, intervalMs?: number) {
  const onChange = vi.fn();
  function Harness() {
    const [schedule, setSchedule] = useState({ cronExpr, intervalMs });
    return <ScheduleChip {...schedule} onChangeSchedule={(next) => {
      onChange(next);
      setSchedule({ cronExpr: next.cronExpr, intervalMs: next.intervalMs });
    }} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button'));
  return onChange;
}

it.each([5, 28])('labels the %i-minute interval dropdown as an interval, not a clock minute', (minutes) => {
  renderChip(`*/${minutes} * * * *`);
  expect(screen.getByRole('combobox', {
    name: 'scheduler.chips.scheduleField.intervalMinutesAria',
  })).toBeTruthy();
  expect(screen.queryByLabelText('scheduler.chips.scheduleField.scheduleMinuteAria')).toBeNull();
});

it('keeps the clock-minute label for a daily schedule', () => {
  renderChip('30 9 * * *');
  expect(screen.getByRole('textbox', {
    name: 'scheduler.chips.scheduleField.scheduleMinuteAria',
  })).toBeTruthy();
  expect(screen.queryByLabelText('scheduler.chips.scheduleField.intervalMinutesAria')).toBeNull();
});

it.each([7, 28, 59])('keeps legacy */%i when the selected minute menu is clicked again', (minutes) => {
  const onChange = renderChip(`*/${minutes} * * * *`);
  const menu = screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.intervalMinutes' });
  fireEvent.click(menu);
  fireEvent.click(menu);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox').textContent).toContain(`${minutes}*`);
});

it.each([28, 59])('still lets an exact %i-minute interval explicitly enter the supported minute preset', (minutes) => {
  const onChange = renderChip(`*/${minutes} * * * *`, minutes * 60_000);
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.intervalMinutes' }));
  expect(onChange).toHaveBeenCalledWith({ cronExpr: '*/5 * * * *', intervalMs: 300_000 });
  onChange.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.intervalMinutes' }));
  expect(onChange).not.toHaveBeenCalled();
});

const staleCronValues = ['*/20 * * * *', '0 */8 * * *', '*/28 * * * *', '30 9 * * *'];

it.each(staleCronValues)('starts the minute preset at its default, ignoring exact-interval metadata %s', (cronExpr) => {
  const onChange = renderChip(cronExpr, 28 * 60_000);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.timingMode.currentExact' }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.intervalMinutes' }));
  expect(onChange).toHaveBeenCalledWith({ cronExpr: '*/5 * * * *', intervalMs: 300_000 });
});

it.each(staleCronValues)('starts the hour preset at its default, ignoring exact-interval metadata %s', (cronExpr) => {
  const onChange = renderChip(cronExpr, 28 * 60_000);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.interval' }));
  expect(onChange).toHaveBeenCalledWith({ cronExpr: '0 */1 * * *', intervalMs: 3_600_000 });
});

it.each([7, 28, 59])('switches a stale Cron from the current %i-minute interval and keeps the legacy value on menu re-selection', (minutes) => {
  const onChange = renderChip('*/5 * * * *', minutes * 60_000);
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.timingMode.cron' }));
  expect(onChange).toHaveBeenCalledWith({ cronExpr: `*/${minutes} * * * *`, intervalMs: undefined });
  expect(screen.getByRole('combobox').textContent).toContain(`${minutes}*`);
  onChange.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.chips.scheduleMenu.intervalMinutes' }));
  expect(onChange).not.toHaveBeenCalled();
});

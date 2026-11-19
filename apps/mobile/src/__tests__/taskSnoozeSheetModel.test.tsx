// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTaskSnoozeSheet } from '@/session/taskSnoozeSheetModel';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let model: ReturnType<typeof useTaskSnoozeSheet>;
const confirm = vi.fn();
function Probe({ visible }: { visible: boolean }) {
  model = useTaskSnoozeSheet({ visible, onConfirm: confirm, onClose() {}, onClosed() {} });
  return null;
}
function render(visible: boolean) {
  // Keep the hook owner stable across opening/closing, as the real sheets do.
  act(() => root.render(createElement(Probe, { visible })));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T10:00:00'));
  confirm.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('saves exactly the time previewed when the menu opened, even after time passes', () => {
  render(true);
  const option = model.options.find(option => option.id === 'oneHour')!;
  vi.setSystemTime(new Date('2026-11-13T10:05:00'));
  act(() => model.choose(option.until));
  expect(confirm).toHaveBeenCalledWith(new Date('2026-11-13T11:00:00').toISOString());
});
it('confirms indefinite deferral without selecting a date', () => {
  render(true);
  act(() => model.chooseIndefinite());
  expect(confirm).toHaveBeenCalledWith('9999-12-31T23:59:59.999Z');
});
it('rejects stale presets and invalid or over-one-year custom values without writing', () => {
  render(true);
  const option = model.options[0];
  vi.setSystemTime(new Date('2026-11-13T12:00:00'));
  for (const value of [option.until, null, new Date(NaN), new Date(Date.now() + 367 * 86_400_000)]) {
    act(() => model.choose(value));
    expect(model.invalid).toBe(true);
  }
  expect(confirm).not.toHaveBeenCalled();
  act(() => model.choose(new Date('2026-11-14T09:00:00')));
  expect(confirm).toHaveBeenCalledWith(new Date('2026-11-14T09:00:00').toISOString());
});
it('omits an evening that has already passed', () => {
  vi.setSystemTime(new Date('2026-11-13T18:00:00'));
  render(true);
  expect(model.options.map(option => option.id)).toEqual(['oneHour', 'threeHours', 'tomorrow', 'nextWeek']);
});

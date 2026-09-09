// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteDesktopSetting } from '../RemoteDesktopSetting';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../RemoteDesktopPermissions', () => ({ RemoteDesktopPermissions: () => null }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('probes service status only while settings are mounted and after setup', async () => {
  vi.useFakeTimers();
  let support = 'missing';
  const state = vi.fn(async (probe?: boolean) => ({
    enabled: true,
    active: null,
    ...(probe ? { windowsSupport: support } : {}),
  }));
  const windowsSupport = vi.fn(async () => {
    support = 'ready';
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  const view = render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(state).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(state.mock.calls.slice(1)).toEqual([[true], [true], [true]]);
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
  expect(state).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
  view.unmount();
  const calls = state.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(state).toHaveBeenCalledTimes(calls);
});

it('recovers a slow initial probe discarded by an intervening enable action', async () => {
  vi.useFakeTimers();
  let complete!: (value: { enabled: boolean; active: null; windowsSupport: string }) => void;
  const state = vi
    .fn(async () => ({ enabled: true, active: null, windowsSupport: 'missing' }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const enable = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { remoteDesktop: { state, enable } } });
  render(<RemoteDesktopSetting />);
  fireEvent.click(screen.getByRole('switch'));
  await act(async () => {});
  await act(async () => {
    complete({ enabled: false, active: null, windowsSupport: 'missing' });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(state).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
});

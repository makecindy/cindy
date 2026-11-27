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

// Unit: enabling on Windows must show fresh service status before the next poll,
// even if an older settings read is still outstanding.
it('shows the Windows service on enable and discards the older settings read', async () => {
  vi.useFakeTimers();
  let complete!: (value: { enabled: boolean; active: null }) => void;
  const state = vi
    .fn<() => Promise<{ enabled: boolean; active: null; windowsSupport?: string }>>()
    .mockResolvedValue({ enabled: true, active: null, windowsSupport: 'missing' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const enable = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { platform: 'win32', remoteDesktop: { state, enable } } });
  render(<RemoteDesktopSetting />);
  fireEvent.click(screen.getByRole('switch'));
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
  await act(async () => {
    complete({ enabled: false, active: null });
  });
  expect(state).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
});

// Unit: a user can switch off before the enable-time probe finishes. Its old
// result must not switch remote desktop back on or expose the service action.
it('keeps the switch off when the preceding enable-time probe finishes late', async () => {
  vi.useFakeTimers();
  const probe = Promise.withResolvers<{ enabled: boolean; windowsSupport: string }>();
  const state = vi.fn().mockResolvedValueOnce({ enabled: false }).mockReturnValueOnce(probe.promise);
  const enable = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { platform: 'win32', remoteDesktop: { state, enable } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  const toggle = screen.getByRole('switch');
  fireEvent.click(toggle);
  await act(async () => {});
  fireEvent.click(toggle);
  await act(async () => probe.resolve({ enabled: true, windowsSupport: 'ready' }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeNull();
});

// Unit: closing settings during service setup used to start another native
// probe when the administrator action finished, even though the row was gone.
it('skips the service refresh if setup finishes after unmount', async () => {
  vi.useFakeTimers();
  const setup = Promise.withResolvers<void>();
  const state = vi.fn(async () => ({ enabled: true, windowsSupport: 'missing' }));
  const windowsSupport = vi.fn(() => setup.promise);
  Object.assign(window, { electronAPI: { platform: 'win32', remoteDesktop: { state, windowsSupport } } });
  const view = render(<RemoteDesktopSetting />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  view.unmount();
  await act(async () => setup.resolve());
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
  expect(state).toHaveBeenCalledExactlyOnceWith(true);
});

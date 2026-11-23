// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteDesktopPermissions } from '../RemoteDesktopPermissions';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('shows independent permission rows, opens only the selected permission, and refreshes automatically', async () => {
  vi.useFakeTimers();
  const permissions = vi.fn(async () => ({ screenRecording: 'missing', accessibility: 'granted' }));
  const openPermission = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { remoteDesktop: { permissions, openPermission } } });
  render(<RemoteDesktopPermissions />);
  await act(async () => {});
  expect(openPermission).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', {
      name: /remoteDesktop.screenRecording\s*remoteDesktop.openPermissionSettings/,
    }),
  );
  await act(async () => {});
  expect(openPermission).toHaveBeenCalledExactlyOnceWith('screenRecording');
  permissions.mockResolvedValue({ screenRecording: 'granted', accessibility: 'granted' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.getByRole('status').textContent).toBe('remoteDesktop.permissionsReady');
  cleanup();
  const count = permissions.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(permissions).toHaveBeenCalledTimes(count);
});
it('offers a separate system window only for the pane the host could not finish', async () => {
  const openPermission = vi.fn();
  const permissions = vi.fn(async () => ({
    screenRecording: 'missing', accessibility: 'missing', separateWindowRetries: ['accessibility'],
  }));
  Object.assign(window, { electronAPI: { remoteDesktop: { permissions, openPermission } } });
  render(<RemoteDesktopPermissions />);
  fireEvent.click(await screen.findByRole('button', { name: /remoteDesktop.accessibility\s*remoteDesktop.openPermissionInNewWindow/ }));
  await act(async () => {});
  expect(openPermission).toHaveBeenCalledExactlyOnceWith('accessibility');
});

// Local settings must identify the running bundle when two installed apps share
// a display name. Opening the guide alone must never open Finder or a TCC prompt.
it('reveals the exact local installation only when requested', async () => {
  const appBundlePath = '/Users/test/Applications/Cindy Personal.app';
  const showItemInFolder = vi.fn().mockResolvedValue({ success: true });
  Object.assign(window, { electronAPI: { showItemInFolder, remoteDesktop: {
    permissions: vi.fn().mockResolvedValue({ screenRecording: 'missing', accessibility: 'missing', appBundlePath }),
  } } });
  render(<RemoteDesktopPermissions />);
  const reveal = await screen.findByRole('button', { name: /remoteDesktop.revealCurrentApp/ });
  expect(showItemInFolder).not.toHaveBeenCalled();
  fireEvent.click(reveal);
  expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith({ filePath: appBundlePath });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { ACCESSIBILITY_SUPPORT_CHANGED, ACCESSIBILITY_SUPPORT_GET } from '../../shared/accessibilitySupport';

const mocks = vi.hoisted(() => ({
  app: { on: vi.fn(), accessibilitySupportEnabled: false },
  on: vi.fn(), windows: vi.fn(), trustedEvent: vi.fn(), trustedWindow: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app, ipcMain: { on: mocks.on }, BrowserWindow: { getAllWindows: mocks.windows } }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererEvent: mocks.trustedEvent, isTrustedAppRendererWindow: mocks.trustedWindow,
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it('registers once and returns local state only to a trusted app renderer', async () => {
  const { registerAccessibilitySupportIpc } = await import('../accessibility-support-ipc');
  registerAccessibilitySupportIpc(); registerAccessibilitySupportIpc();
  expect(mocks.on).toHaveBeenCalledTimes(1);
  expect(mocks.on.mock.calls[0][0]).toBe(ACCESSIBILITY_SUPPORT_GET);
  const read = mocks.on.mock.calls[0][1];
  const event = { returnValue: undefined };
  mocks.trustedEvent.mockReturnValue(true);
  for (const enabled of [true, false]) {
    mocks.app.accessibilitySupportEnabled = enabled;
    read(event); expect(event.returnValue).toBe(enabled);
  }
  mocks.trustedEvent.mockReturnValue(false);
  read(event); expect(event.returnValue).toBeNull();
});

it('broadcasts live changes only to trusted living application windows', async () => {
  const { registerAccessibilitySupportIpc } = await import('../accessibility-support-ipc');
  registerAccessibilitySupportIpc();
  const appWindow = { webContents: { send: vi.fn() } };
  const otherWindow = { webContents: { send: vi.fn() } };
  mocks.windows.mockReturnValue([appWindow, otherWindow]);
  mocks.trustedWindow.mockImplementation(win => win === appWindow);
  expect(mocks.app.on.mock.calls[0][0]).toBe('accessibility-support-changed');
  for (const enabled of [true, false]) {
    mocks.app.on.mock.calls[0][1]({}, enabled);
    expect(appWindow.webContents.send).toHaveBeenLastCalledWith(ACCESSIBILITY_SUPPORT_CHANGED, enabled);
  }
  expect(otherWindow.webContents.send).not.toHaveBeenCalled();
});

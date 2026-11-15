import { expect, it, vi } from 'vitest';
import { registerSettingsNavigationIpc } from '../settingsNavigationIpc';
const state = vi.hoisted(() => ({ handler: null as null | ((event: unknown, target: unknown) => unknown), remote: true, open: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (_channel: string, fn: typeof state.handler) => { state.handler = fn; } } }));
vi.mock('../authManager', () => ({ getDeviceId: () => 'computer-a' }));
vi.mock('../deepLink', () => ({ openMainWindowSettingsNavigation: state.open }));
vi.mock('../device-link/invoke-context', () => ({ getDeviceLinkInvokeContext: () => state.remote ? { channel: 'maker:settings:navigate' } : null }));
vi.mock('../utils/ipcValidate', () => ({ throwIpcError: (code: string) => { throw new Error(code); } }));
// Unit: navigation is device-link-only and cannot target a different computer or run a command.
it('accepts only a validated navigation intent for this computer', () => {
  registerSettingsNavigationIpc();
  const target = { tab: 'general', deviceId: 'computer-a' };
  expect(state.handler!(null, target)).toEqual({ ok: true, deviceId: 'computer-a' });
  expect(state.open).toHaveBeenCalledWith(target);
  expect(() => state.handler!(null, { ...target, deviceId: 'computer-b' })).toThrow('INVALID_PARAMS');
  expect(() => state.handler!(null, { ...target, command: 'run' })).toThrow('INVALID_PARAMS');
  state.remote = false;
  expect(() => state.handler!(null, target)).toThrow('PERMISSION_DENIED');
  expect(state.open).toHaveBeenCalledTimes(1);
});

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createXboxGamepadDefaultSettings,
  GAMEPAD_FAMILIES,
  XBOX_GAMEPAD_GET_STATE_CHANNEL,
  XBOX_GAMEPAD_SET_SETTINGS_CHANNEL,
  XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL,
  type GamepadFamily,
  type XboxGamepadSettings,
} from '../../../shared/xboxGamepad.js';
import type { InputDeviceHost } from '../../input-devices/registry.js';
import type { XboxGamepadHostMessage } from '../protocol.js';

const mocks = vi.hoisted(() => ({
  host: { start: vi.fn(), stop: vi.fn(), probe: vi.fn(), setSwitch2UsbWanted: vi.fn() },
  handlers: new Map<string, (...args: any[]) => any>(),
  devices: [] as InputDeviceHost[],
  settings: {} as Record<GamepadFamily, XboxGamepadSettings>,
  onMessage: null as ((message: XboxGamepadHostMessage) => void) | null,
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler),
  },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../deepLink.js', () => ({ getDeepLinkMainWindow: () => null }));
vi.mock('../../secondary-windows.js', () => ({ isSecondaryAppWindow: () => false }));
vi.mock('../../windowFocusClassifier.js', () => ({ isAppContentWindow: () => false }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../input-devices/registry.js', () => ({
  registerInputDevice: (device: InputDeviceHost) => mocks.devices.push(device),
}));
vi.mock('../host.js', () => ({
  createXboxGamepadHost: (callback: (message: XboxGamepadHostMessage) => void) => {
    mocks.onMessage = callback;
    return mocks.host;
  },
}));
vi.mock('../settingsStore.js', () => ({
  readXboxGamepadSettings: (family: GamepadFamily) => mocks.settings[family],
  writeXboxGamepadSettingsPatch: (family: GamepadFamily, patch: Partial<XboxGamepadSettings>) =>
    (mocks.settings[family] = { ...mocks.settings[family], ...patch }),
  resetXboxGamepadSettings: (family: GamepadFamily) => mocks.settings[family],
}));

function invoke(channel: string, ...args: unknown[]) {
  return mocks.handlers.get(channel)!({}, ...args);
}
async function register() {
  const api = await import('../index.js');
  api.registerXboxGamepadInputDevice();
  api.registerXboxGamepadSettingsIpc();
}

describe('gamepad helper demand', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    mocks.handlers.clear();
    mocks.devices.length = 0;
    for (const family of GAMEPAD_FAMILIES)
      mocks.settings[family] = createXboxGamepadDefaultSettings();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not start a helper when all accessories are disabled', async () => {
    await register();
    expect(mocks.host.start).not.toHaveBeenCalled();
  });

  it.each(GAMEPAD_FAMILIES)('starts for saved %s enablement', async (family) => {
    mocks.settings[family].deviceEnabled = true;
    await register();
    expect(mocks.host.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared helper until the last enabled family is disabled', async () => {
    await register();
    invoke(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, 'xbox', { deviceEnabled: true });
    invoke(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, 'playstation', { deviceEnabled: true });
    invoke(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, 'xbox', { deviceEnabled: false });
    expect(mocks.host.start).toHaveBeenCalledTimes(1);
    expect(mocks.host.stop).not.toHaveBeenCalled();
    mocks.onMessage?.({
      kind: 'presence',
      family: 'playstation',
      present: true,
      name: 'DualSense',
    });
    invoke(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, 'playstation', { deviceEnabled: false });
    expect(mocks.host.stop).toHaveBeenCalledTimes(1);
    expect(invoke(XBOX_GAMEPAD_GET_STATE_CHANNEL).playstation).toMatchObject({
      devicePresent: null,
      deviceName: null,
      connectionStatus: 'disabled',
    });
  });

  it.each(['close', 'destroyed', 'render-process-gone'])(
    'releases disabled preview on %s',
    async (ending) => {
      await register();
      const sender = Object.assign(new EventEmitter(), { id: 1 });
      const preview = mocks.handlers.get(XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL)!;
      preview({ sender }, { active: true, family: 'nintendo' });
      expect(mocks.host.start).toHaveBeenCalledTimes(1);
      expect(mocks.host.setSwitch2UsbWanted).toHaveBeenLastCalledWith(true);
      if (ending === 'close') preview({ sender }, false);
      else sender.emit(ending);
      expect(mocks.host.stop).toHaveBeenCalledTimes(1);
      expect(mocks.host.setSwitch2UsbWanted).toHaveBeenLastCalledWith(false);
    },
  );

  it('keeps an enabled helper after preview closes', async () => {
    mocks.settings.generic.deviceEnabled = true;
    await register();
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const preview = mocks.handlers.get(XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL)!;
    preview({ sender }, { active: true, family: 'generic' });
    preview({ sender }, false);
    expect(mocks.host.start).toHaveBeenCalledTimes(1);
    expect(mocks.host.stop).not.toHaveBeenCalled();
  });

  it('stops and resumes with task slots without changing saved settings', async () => {
    mocks.settings.nintendo.deviceEnabled = true;
    await register();
    for (const device of mocks.devices) device.suspendTaskSlots();
    expect(mocks.host.stop).toHaveBeenCalledTimes(1);
    expect(mocks.settings.nintendo.deviceEnabled).toBe(true);
    for (const device of mocks.devices) await device.resumeTaskSlots();
    expect(mocks.host.start).toHaveBeenCalledTimes(2);
  });

  it('does not restart during shutdown when the preview owner is destroyed', async () => {
    mocks.settings.xbox.deviceEnabled = true;
    await register();
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    mocks.handlers.get(XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL)!({ sender }, true);
    for (const device of mocks.devices) await device.dispose();
    sender.emit('destroyed');
    expect(mocks.host.start).toHaveBeenCalledTimes(1);
  });
});

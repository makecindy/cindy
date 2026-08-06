import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppShortcutCombo } from '../../../shared/appShortcuts.js';

const mocks = vi.hoisted(() => ({
  combos: [] as AppShortcutCombo[],
  recording: false,
  getEffectiveCombos: vi.fn(() => mocks.combos),
}));

vi.mock('../index.js', () => ({
  getAppShortcutStore: () => ({ getEffectiveCombos: mocks.getEffectiveCombos }),
  isAppShortcutRecordingActive: () => mocks.recording,
}));

import { installNewMakerWindowShortcut } from '../new-maker-window-shortcut.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

type BeforeInputHandler = (
  event: { preventDefault: ReturnType<typeof vi.fn> },
  input: Electron.Input,
) => void;

function combo(code: string, modifiers: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    ...modifiers,
  };
}

function input(
  code: string,
  modifiers: Partial<
    Pick<Electron.Input, 'meta' | 'control' | 'alt' | 'shift' | 'isAutoRepeat' | 'isComposing'>
  > = {},
): Electron.Input {
  return {
    type: 'keyDown',
    key: code,
    code,
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...modifiers,
  };
}

function fakeWindow() {
  const handlers: BeforeInputHandler[] = [];
  const send = vi.fn();
  const webContents = {
    on: vi.fn((channel: string, handler: BeforeInputHandler) => {
      if (channel === 'before-input-event') handlers.push(handler);
    }),
    send,
  };

  return {
    handlers,
    send,
    window: { webContents } as unknown as Parameters<typeof installNewMakerWindowShortcut>[0],
  };
}

function press(target: ReturnType<typeof fakeWindow>, keyInput: Electron.Input) {
  const preventDefault = vi.fn();
  target.handlers.forEach((handler) => handler({ preventDefault }, keyInput));
  return preventDefault;
}

describe('installNewMakerWindowShortcut', () => {
  beforeEach(() => {
    mocks.combos = [combo('KeyN', { ctrl: true })];
    mocks.recording = false;
    mocks.getEffectiveCombos.mockClear();
  });

  it('dispatches once in both the main window and a secondary session window', () => {
    const main = fakeWindow();
    const secondary = fakeWindow();

    installNewMakerWindowShortcut(main.window, 'win32');
    installNewMakerWindowShortcut(main.window, 'win32');
    installNewMakerWindowShortcut(secondary.window, 'linux');

    expect(main.handlers).toHaveLength(1);
    expect(secondary.handlers).toHaveLength(1);

    expect(press(main, input('KeyN', { control: true }))).toHaveBeenCalledOnce();
    expect(press(secondary, input('KeyN', { control: true }))).toHaveBeenCalledOnce();
    expect(main.send).toHaveBeenCalledOnce();
    expect(secondary.send).toHaveBeenCalledOnce();
    expect(main.send).toHaveBeenCalledWith(IPC_CHANNELS.APP_MENU.COMMAND, 'new-maker-shortcut');
    expect(secondary.send).toHaveBeenCalledWith(IPC_CHANNELS.APP_MENU.COMMAND, 'new-maker-shortcut');
  });

  it('reads custom bindings immediately and yields while shortcut recording is active', () => {
    const target = fakeWindow();
    installNewMakerWindowShortcut(target.window, 'win32');

    mocks.combos = [combo('KeyJ', { ctrl: true, shift: true })];
    press(target, input('KeyN', { control: true }));
    expect(target.send).not.toHaveBeenCalled();

    mocks.recording = true;
    press(target, input('KeyJ', { control: true, shift: true }));
    expect(target.send).not.toHaveBeenCalled();

    mocks.recording = false;
    press(target, input('KeyJ', { control: true, shift: true }));
    expect(target.send).toHaveBeenCalledOnce();
  });

  it('ignores auto-repeat keydown events while a matching combo is held', () => {
    const target = fakeWindow();
    installNewMakerWindowShortcut(target.window, 'win32');

    const repeated = press(target, input('KeyN', { control: true, isAutoRepeat: true }));
    expect(repeated).not.toHaveBeenCalled();
    expect(target.send).not.toHaveBeenCalled();

    press(target, input('KeyN', { control: true }));
    expect(target.send).toHaveBeenCalledOnce();
  });

  it('does not install a competing handler on macOS', () => {
    const target = fakeWindow();
    installNewMakerWindowShortcut(target.window, 'darwin');
    expect(target.handlers).toHaveLength(0);
  });
});

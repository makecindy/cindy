import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloneXboxGamepadLayout,
  createXboxGamepadDefaultSettings,
} from '../../../shared/xboxGamepad.js';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(electronMock.userDataDir, 'owners', 'owner-a', ...parts),
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  readXboxGamepadSettings,
  writeXboxGamepadSettingsPatch,
} from '../settingsStore.js';

function settingsFile(): string {
  return path.join(electronMock.userDataDir, 'owners', 'owner-a', 'xbox-gamepad-settings.json');
}

describe('Xbox gamepad settings store', () => {
  afterEach(() => {
    if (electronMock.userDataDir) {
      fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
      electronMock.userDataDir = '';
    }
  });

  it('persists a layout patch as an override file', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-gamepad-settings-'));

    const layout = cloneXboxGamepadLayout(createXboxGamepadDefaultSettings().layout);
    layout.buttons.a = { type: 'voice' };
    const next = writeXboxGamepadSettingsPatch('xbox', { layout });

    expect(next.layout.buttons.a).toEqual({ type: 'voice' });
    expect(readXboxGamepadSettings('xbox')).toEqual(next);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toMatchObject({
      layout: { buttons: { a: { type: 'voice' } } },
    });
  });

  it('keeps externally edited settings when a UI patch is written afterwards', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-gamepad-settings-'));

    // T0:UI 写入布局补丁,store 装载缓存。
    const layout = cloneXboxGamepadLayout(createXboxGamepadDefaultSettings().layout);
    layout.buttons.a = { type: 'voice' };
    writeXboxGamepadSettingsPatch('xbox', { layout });

    // T1:外部(用户/agent 手改)直接重写文件开启设备;mtime 强制前移防同毫秒误判。
    const file = settingsFile();
    fs.writeFileSync(file, JSON.stringify({ deviceEnabled: true }, null, 2), 'utf-8');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(file, future, future);

    // T2:UI 再写一次布局补丁(不动 deviceEnabled)。
    const next = writeXboxGamepadSettingsPatch('xbox', { layout });

    // 外部编辑存活:设备仍开启,布局补丁照常应用。
    expect(next.deviceEnabled).toBe(true);
    expect(next.layout.buttons.a).toEqual({ type: 'voice' });
    expect(readXboxGamepadSettings('xbox').deviceEnabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({
      deviceEnabled: true,
    });
  });
});

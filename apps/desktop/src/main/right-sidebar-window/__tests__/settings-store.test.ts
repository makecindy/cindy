// right-sidebar-window settings-store:
//  - normalize 兜底(坏类型 / 缺字段 / 非对象一律回默认)
//  - read / writePatch round-trip(override 文件落在 os.tmpdir 下的假 userData)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 凭证不入仓红线(规则 23):userData 一律指到 os.tmpdir 下的临时目录。
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-rsb-window-settings-'));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return tmpUserData;
    },
  },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  normalizeRsbWindowSettings,
  readRsbWindowSettings,
  resetRsbWindowSettingsForStartup,
  writeRsbWindowSettingsPatch,
} from '../settings-store.js';

const settingsFile = path.join(tmpUserData, 'right-sidebar-window-settings.json');

beforeEach(() => {
  if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
  resetRsbWindowSettingsForStartup();
});

afterEach(() => {
  if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
});

describe('normalizeRsbWindowSettings', () => {
  it('非对象 / null → 全默认', () => {
    expect(normalizeRsbWindowSettings(null)).toEqual({ detached: false, lastOpen: false });
    expect(normalizeRsbWindowSettings('junk')).toEqual({ detached: false, lastOpen: false });
    expect(normalizeRsbWindowSettings(42)).toEqual({ detached: false, lastOpen: false });
  });

  it('坏类型字段逐个回默认,好字段保留', () => {
    expect(normalizeRsbWindowSettings({ detached: 'yes', lastOpen: true })).toEqual({
      detached: false,
      lastOpen: true,
    });
    expect(normalizeRsbWindowSettings({ detached: true })).toEqual({
      detached: true,
      lastOpen: false,
    });
  });
});

describe('runtime state', () => {
  it('writePatch 仅更新当前进程内状态', () => {
    writeRsbWindowSettingsPatch({ detached: true });
    expect(readRsbWindowSettings()).toEqual({ detached: true, lastOpen: false });

    writeRsbWindowSettingsPatch({ lastOpen: true });
    expect(readRsbWindowSettings()).toEqual({ detached: true, lastOpen: true });

    expect(fs.existsSync(settingsFile)).toBe(false);

    writeRsbWindowSettingsPatch({ detached: false, lastOpen: false });
    expect(readRsbWindowSettings()).toEqual({ detached: false, lastOpen: false });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('startup 重置运行态并删除旧版本的持久化分离偏好', () => {
    writeRsbWindowSettingsPatch({ detached: true, lastOpen: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ detached: true, lastOpen: true }));

    resetRsbWindowSettingsForStartup();

    expect(readRsbWindowSettings()).toEqual({ detached: false, lastOpen: false });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

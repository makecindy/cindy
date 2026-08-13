// normalizeGhostPanelWindowsSettings:坏数据 fail-closed 清洗。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ghost-panel-window-settings-'));

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
  normalizeGhostPanelWindowsSettings,
  patchGhostPanelWindowEntry,
  readGhostPanelWindowsSettings,
  resetGhostPanelWindowSettingsForStartup,
} from '../settings-store.js';

const settingsFile = path.join(tmpUserData, 'ghost-panel-windows-settings.json');

beforeEach(() => {
  if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
  resetGhostPanelWindowSettingsForStartup();
});

afterEach(() => {
  if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
});

describe('normalizeGhostPanelWindowsSettings', () => {
  it('合法条目原样保留', () => {
    expect(
      normalizeGhostPanelWindowsSettings({
        windows: { 'stock-2400-tracker': { detached: true, lastOpen: false } },
      }),
    ).toEqual({ windows: { 'stock-2400-tracker': { detached: true, lastOpen: false } } });
  });

  it('非对象 / 缺 windows / windows 非对象 → 空表', () => {
    expect(normalizeGhostPanelWindowsSettings(null)).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings('x')).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings({})).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings({ windows: 42 })).toEqual({ windows: {} });
  });

  it('非法 ghostId / 非布尔字段 / 非对象条目:整条丢弃,不影响同表其它条目', () => {
    expect(
      normalizeGhostPanelWindowsSettings({
        windows: {
          'BAD ID': { detached: true, lastOpen: true },
          'cindy-art': { detached: 'yes', lastOpen: true },
          'no-fields': null,
          good: { detached: false, lastOpen: true },
        },
      }),
    ).toEqual({ windows: { good: { detached: false, lastOpen: true } } });
  });
});

describe('runtime state', () => {
  it('每个插件的分离状态仅保存在当前进程内', () => {
    patchGhostPanelWindowEntry('cindy-art', { detached: true, lastOpen: true });

    expect(readGhostPanelWindowsSettings()).toEqual({
      windows: { 'cindy-art': { detached: true, lastOpen: true } },
    });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('startup 清空所有插件分离态并删除旧版本偏好文件', () => {
    patchGhostPanelWindowEntry('cindy-art', { detached: true, lastOpen: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ windows: { 'cindy-art': { detached: true, lastOpen: true } } }),
    );

    resetGhostPanelWindowSettingsForStartup();

    expect(readGhostPanelWindowsSettings()).toEqual({ windows: {} });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

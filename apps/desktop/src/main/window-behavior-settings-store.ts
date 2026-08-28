/**
 * window-behavior-settings-store —— main 进程对窗口交互行为开关的持久化。
 *
 * File: <userData>/window-behavior-settings.json
 *
 * Defaults:
 *  - swallowActivationClick: false (首次点击直接透传,双屏用户默认更顺手;
 *    这是相对 PR #446 / macOS 原生 acceptFirstMouse:false 的行为变更,想要
 *    防误触的用户需在设置里显式打开)
 *  - windowsCloseBehavior: null (Windows 首次关闭时弹窗询问,选择后持久化)
 *  - startInTrayOnLogin: false (开机自启时也照常显示窗口;想要静默启动的用户
 *    在设置里显式打开)
 *
 * swallowActivationClick 仍由 renderer localStorage 承担运行时事实标准,main
 * 侧文件只供下次创建 BrowserWindow 时读取。windowsCloseBehavior 则完全由
 * main 侧持久化与执行,renderer 通过 IPC 读写同一份状态。
 *
 * 注意 startInTrayOnLogin 只记「用户想要什么」,不记「系统登录项是否已启用」——
 * 后者的事实源是操作系统(用户可能在任务管理器或系统设置里改掉),每次都向
 * Electron 查询,不在这里持久化,避免两份状态漂移。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { isWindowsCloseBehavior, type WindowsCloseBehavior } from '../shared/windowBehavior.js';

const log = desktopMakerLogger.child('window-behavior-settings-store');

export interface WindowBehaviorSettings {
  swallowActivationClick: boolean;
  windowsCloseBehavior: WindowsCloseBehavior | null;
  startInTrayOnLogin: boolean;
}

const DEFAULTS: WindowBehaviorSettings = {
  swallowActivationClick: false,
  windowsCloseBehavior: null,
  startInTrayOnLogin: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'window-behavior-settings.json');
}

function normalize(raw: unknown): WindowBehaviorSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    swallowActivationClick:
      typeof r.swallowActivationClick === 'boolean'
        ? r.swallowActivationClick
        : DEFAULTS.swallowActivationClick,
    windowsCloseBehavior: isWindowsCloseBehavior(r.windowsCloseBehavior)
      ? r.windowsCloseBehavior
      : DEFAULTS.windowsCloseBehavior,
    startInTrayOnLogin:
      typeof r.startInTrayOnLogin === 'boolean'
        ? r.startInTrayOnLogin
        : DEFAULTS.startInTrayOnLogin,
  };
}

const store = createOverrideSettingsFile<WindowBehaviorSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'window-behavior',
});

export function readWindowBehaviorSettings(): WindowBehaviorSettings {
  return store.read();
}

export function writeSwallowActivationClick(swallowActivationClick: boolean): void {
  store.writePatch({ swallowActivationClick });
  log.info('window-behavior setting written', { swallowActivationClick });
}

export function writeWindowsCloseBehavior(windowsCloseBehavior: WindowsCloseBehavior): void {
  store.writePatch({ windowsCloseBehavior });
  log.info('Windows close behavior written', { windowsCloseBehavior });
}

export function writeStartInTrayOnLogin(startInTrayOnLogin: boolean): void {
  store.writePatch({ startInTrayOnLogin });
  log.info('start in tray on login written', { startInTrayOnLogin });
}

export const __testing = { normalize };

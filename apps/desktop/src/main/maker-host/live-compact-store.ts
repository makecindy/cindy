/**
 * live-compact-store —— 「边做边压 Live Compact」实验开关的 main 端持久化真源。
 *
 * 开关只决定**新会话**是否加载内置的 pi 扩展(maker-core 把扩展写进会话的
 * internal-extensions 并显式 --extension)。已开的会话不动态变化 —— 扩展只在
 * pi 进程启动时加载一次,与 LSP Beta 开关同一口径。
 *
 * 文件: <userData>/live-compact-settings.json
 *   { "enabled": false }
 *
 * 默认 false —— 实验性功能,全新装包用户不打开,行为与没有该扩展时一致。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('live-compact-store');

export interface LiveCompactSettings {
  enabled: boolean;
}

const DEFAULTS: LiveCompactSettings = {
  enabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'live-compact-settings.json');
}

function normalize(raw: unknown): LiveCompactSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

let cached: LiveCompactSettings | null = null;

export function readLiveCompactSettings(): LiveCompactSettings {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(text);
      cached = normalize(parsed);
      log.info('live compact settings loaded', { ...cached, path: file });
      return cached;
    }
  } catch (err) {
    log.warn('live-compact-settings.json read failed → falling back to defaults', {
      error: err instanceof Error ? err.message : String(err),
      path: file,
    });
    // 损坏文件留在原处待查,不静默删除:盘上那份是用户唯一的现场。
  }
  cached = { ...DEFAULTS };
  return cached;
}

export function writeLiveCompactEnabled(enabled: boolean): void {
  const next: LiveCompactSettings = { ...readLiveCompactSettings(), enabled };
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = next;
  log.info('live compact setting written', { enabled });
}

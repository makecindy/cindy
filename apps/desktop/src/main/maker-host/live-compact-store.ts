/**
 * live-compact-store —— 「边做边压 Live Compact」实验开关的 main 端持久化真源。
 *
 * 开关只决定**新会话**是否加载内置的 pi 扩展(maker-core 把扩展写进会话的
 * internal-extensions 并显式 --extension)。已开的会话不动态变化 —— 扩展只在
 * pi 进程启动时加载一次,与 LSP Beta 开关同一口径。
 *
 * 文件: <userData>/live-compact-settings.json
 *   { "enabled": true }
 * 关闭时该键等于默认值,会被省略 —— 文件可能不存在,读出来仍是 false(等价于默认)。
 *
 * 默认 false —— 实验性功能,全新装包用户不打开,行为与没有该扩展时一致。
 *
 * 走仓内通用的 createOverrideSettingsFile:与 compaction-settings-store 同一口径的
 * 损坏文件保留、大小上限与 mtime 失效重读(手改文件下次读取生效)。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

const log = desktopMakerLogger.child('live-compact-store');

export interface LiveCompactSettings {
  enabled: boolean;
}

const DEFAULTS: LiveCompactSettings = {
  enabled: false,
};

function normalize(raw: unknown): LiveCompactSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<LiveCompactSettings>({
  filePath: () => path.join(app.getPath('userData'), 'live-compact-settings.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'live-compact',
  // 与 model-context-limit-store / compaction-settings-store 同一契约:
  // 无界 JSON 不直接读入 main;损坏文件保留待查,不静默删除。
  maxBytes: 1_048_576,
  preserveUnreadableFile: true,
});

export function readLiveCompactSettings(): LiveCompactSettings {
  // 手改文件也要生效:读前比对 mtime。
  store.invalidateIfChanged();
  return store.read();
}

export function writeLiveCompactEnabled(enabled: boolean): void {
  store.invalidateIfChanged();
  try {
    store.writePatch({ enabled });
  } catch (error) {
    // 共享 helper 的 preserveUnreadableFile 契约会拒写坏文件,结果开关永远打不开也关不上。
    // 把坏文件改名留档再写一次:开关恢复可用,原始内容仍旧在磁盘上可查。
    if (!/unreadable/i.test(String((error as Error)?.message ?? ''))) throw error;
    const file = path.join(app.getPath('userData'), 'live-compact-settings.json');
    const parked = `${file}.unreadable-${Date.now()}`;
    fs.renameSync(file, parked);
    log.warn('live compact setting file was unreadable; parked and rewritten', { parked });
    store.invalidateIfChanged();
    store.writePatch({ enabled });
  }
  log.info('live compact setting written', { enabled });
}

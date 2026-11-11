/**
 * tool-fold-store —— 「工具载荷折叠」实验开关的 main 端持久化真源。
 *
 * 开关决定**之后启动的 Pi 任务**是否加载内置的 cindy-tool-fold 扩展：
 *   - 关闭(默认): 不写扩展、不 --extension，行为与没有该扩展时完全一致。
 *   - 开启: maker-core 把扩展写进会话 internal-extensions 并显式 --extension 加载，
 *     把较老的「工具调用 + 结果」折成一行，超大结果入库前截断，两者都能用
 *     toolfold_read 取回原文。
 *
 * 文件: <userData>/tool-fold-settings.json
 *   { "enabled": true }
 * 关闭时该键等于默认值，会被省略 —— 文件可能不存在，读出来仍是 false(等价于默认)。
 *
 * 默认 false —— 实验性功能：折叠会改写送给模型的上下文，模型行为是否稳定还没在
 * 真实长会话上验证过，所以必须由用户在设置里显式 opt-in 才生效。
 *
 * 与 LSP Beta / 边做边压同一口径：扩展在 pi 进程启动时一次性加载，开关只对之后
 * 启动的任务生效，已在运行的任务不变。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

const log = desktopMakerLogger.child('tool-fold-store');

export interface ToolFoldSettings {
  enabled: boolean;
}

const DEFAULTS: ToolFoldSettings = {
  enabled: false,
};

function normalize(raw: unknown): ToolFoldSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<ToolFoldSettings>({
  filePath: () => path.join(app.getPath('userData'), 'tool-fold-settings.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'tool-fold',
  // 与其它设置文件同一契约：无界 JSON 不直接读入 main；损坏文件保留待查，
  // 不静默删除（用户的开关状态不能因为文件损坏就悄悄丢掉）。
  maxBytes: 1_048_576,
  preserveUnreadableFile: true,
});

export function readToolFoldSettings(): ToolFoldSettings {
  // 手改文件也要生效：读前比对 mtime。
  store.invalidateIfChanged();
  return store.read();
}

export function writeToolFoldEnabled(enabled: boolean): void {
  store.invalidateIfChanged();
  try {
    store.writePatch({ enabled });
  } catch (error) {
    // preserveUnreadableFile 契约会拒写坏文件，结果开关永远打不开也关不上。
    // 把坏文件改名留档再写一次：开关恢复可用，原始内容仍旧在磁盘上可查。
    if (!/unreadable/i.test(String((error as Error)?.message ?? ''))) throw error;
    const file = path.join(app.getPath('userData'), 'tool-fold-settings.json');
    const parked = `${file}.unreadable-${Date.now()}`;
    fs.renameSync(file, parked);
    log.warn('tool fold setting file was unreadable; parked and rewritten', { parked });
    store.invalidateIfChanged();
    store.writePatch({ enabled });
  }
  log.info('tool fold setting written', { enabled });
}

/**
 * lsp-mode-store —— LSP Beta 开关的 main 端持久化 source of truth。
 *
 * LSP (Language Server Protocol) MCP 工具集 (lsp_find_references / lsp_outline /
 * lsp_hover 等) 控制:
 *   - 关闭(默认):  agent 工具列表里看不到 lsp_*, 跟 LSP 模块不存在时一致。
 *   - 启用 + TS 项目:  agent 工具列表注入 6 个 lsp_* 工具, 跨包符号查询精度提升。
 *   - 启用 + 非 TS 项目: detect 返 false 直接 short-circuit, 仍然不出现工具。
 *
 * 文件: <userData>/lsp-mode-settings.json
 *   { "enabled": false }
 *
 * 默认 false —— Phase 1 Beta, 全新装包用户不打开, 跟没有 LSP 模块的旧行为一致;
 * 用户在 Settings → 实验功能 主动 opt-in 后, 新建 session 立即生效(已开 session
 * 不变, session 启动时 mcp providers 已 evaluate, 工具列表已固化)。
 *
 * 同步 R/W —— 文件极小, 不卡 UI。完全照搬 compat-mode-store 的形态。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { inspectSettingsFile, isSettingBoolean, validateOptionalSettingsFields } from './settings-inspection.js';

const log = desktopMakerLogger.child('lsp-mode-store');

export interface LspModeSettings {
  enabled: boolean;
}

const DEFAULTS: LspModeSettings = {
  enabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'lsp-mode-settings.json');
}

function normalize(raw: unknown): LspModeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

let cached: LspModeSettings | null = null;

export function readLspModeSettings(): LspModeSettings {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(text);
      cached = normalize(parsed);
      log.info('lsp mode settings loaded', { ...cached, path: file });
      return cached;
    }
  } catch (err) {
    log.warn('lsp-mode-settings.json read failed → falling back to defaults', {
      error: err instanceof Error ? err.message : String(err),
      path: file,
    });
    try { fs.unlinkSync(file); } catch { /* no-op */ }
  }
  cached = { ...DEFAULTS };
  return cached;
}

export function writeLspModeEnabled(enabled: boolean): void {
  const next: LspModeSettings = { ...readLspModeSettings(), enabled };
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = next;
  log.info('lsp mode setting written', { enabled });
}

// ── Cloud settings (cloud instances only) ──────────────────────────────────
/** 旧文件会物化完整值，文件中有字段并不能证明用户显式自定义。 */
export function inspectLspModeSettings() {
  return inspectSettingsFile({ filePath: settingsFilePath, defaults: DEFAULTS, normalize, savedSource: 'unknown',
    validate: (raw) => validateOptionalSettingsFields(raw, { enabled: isSettingBoolean }),
  });
}
/** Revision-checked cloud commits on the same file; the native cache follows them. */
const cloudStore = createOverrideSettingsFile<LspModeSettings>({
  filePath: settingsFilePath, defaults: DEFAULTS, normalize, log, label: 'lsp-mode',
  preserveUnreadableFile: true,
  validateOverrides: raw => validateOptionalSettingsFields(raw, { enabled: isSettingBoolean }),
});
cloudStore.onChanged(() => { cached = null; });
export function getLspSettingsStore() { return cloudStore; }

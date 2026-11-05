/**
 * Main-side source of truth for silent invalid_encrypted_content recovery.
 *
 * File: <userData>/silent-encrypted-retry-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启:跨供应商切回时静默剥离加密推理内容并重发,避免会话卡死。代价是被丢弃的轮次
 * 模型会重新推理、略多花 token(有损恢复)。用户可在 设置 → 个性化 → 小技巧 关掉。
 */
import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('silent-encrypted-retry-store');

export interface SilentEncryptedRetrySettings {
  enabled: boolean;
}

const DEFAULTS: SilentEncryptedRetrySettings = {
  enabled: true,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'silent-encrypted-retry-settings.json');
}

function normalize(raw: unknown): SilentEncryptedRetrySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<SilentEncryptedRetrySettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'silent encrypted retry',
});

export function readSilentEncryptedRetrySettings(): SilentEncryptedRetrySettings {
  return store.read();
}

export function readSilentEncryptedRetrySettingsState(): OverrideSettingsState<SilentEncryptedRetrySettings> {
  return store.readState();
}

export function writeSilentEncryptedRetryEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
  log.info('silent encrypted retry setting written', { enabled });
}

export function resetSilentEncryptedRetrySettings(): SilentEncryptedRetrySettings {
  return store.reset();
}

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const silentEncryptedRetryPortableSettings = portableOverrideSettings(store);

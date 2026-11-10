/** Platform assembly for the shared service. */
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
import { createSilentEncryptedRetryStore } from './silentEncryptedRetryCore.js';
export type { SilentEncryptedRetrySettings } from './silentEncryptedRetryCore.js';
export const { readSilentEncryptedRetrySettings, readSilentEncryptedRetrySettingsState, writeSilentEncryptedRetryEnabled, resetSilentEncryptedRetrySettings, silentEncryptedRetryPortableSettings } = createSilentEncryptedRetryStore({ getUserDataDir: () => app.getPath('userData') });

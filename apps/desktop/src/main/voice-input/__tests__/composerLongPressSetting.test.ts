/**
 * 长按输入框语音输入开关的落盘契约:持久化只记录用户 override,不把默认值固化进
 * 用户配置(docs/dev-rules/configuration-and-overrides.md §2)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => tempDir },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner-1' }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempDir, 'owners', 'owner-1', ...parts),
}));
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string, message: string) => {
    throw new Error(`[${code}] ${message}`);
  },
}));

const { voiceDictionarySyncStore } = await import('../VoiceDictionarySyncStore.js');
const { voiceInputDataStore } = await import('../VoiceInputDataStore.js');

const DATA_FILE = 'voice-input-data.v1.json';

function dataFilePath(): string {
  return path.join(tempDir, 'owners', 'owner-1', DATA_FILE);
}

function writeSettingsFile(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(dataFilePath()), { recursive: true });
  fs.writeFileSync(dataFilePath(), JSON.stringify({ version: 1, settings, history: [] }), 'utf-8');
}

function readPersistedSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(dataFilePath(), 'utf-8')).settings;
}

/** 两个 store 都按 ownerId 缓存内存状态,每个用例都要从磁盘重新读。 */
function resetStoreCaches(): void {
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).data = null;
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).dataOwnerId = null;
  (voiceDictionarySyncStore as unknown as { pendingRecovery: unknown }).pendingRecovery = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).state = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).stateOwnerId = null;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-composer-long-press-'));
  resetStoreCaches();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('长按输入框语音输入开关 —— 只持久化用户 override', () => {
  it('默认关闭;无关设置保存不会把默认值记成用户选择', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    expect(voiceInputDataStore.getSettings().composerLongPressEnabled).toBe(false);

    voiceInputDataStore.updateSettings({ language: 'zh-CN' });
    expect(readPersistedSettings().composerLongPressEnabledOverride).toBeUndefined();
  });

  it('用户打开后记录 override,重载后保持', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    const next = voiceInputDataStore.updateSettings({ composerLongPressEnabled: true });
    expect(next.composerLongPressEnabled).toBe(true);
    expect(readPersistedSettings().composerLongPressEnabledOverride).toBe(true);

    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().composerLongPressEnabled).toBe(true);
  });

  it('再次关闭也记为显式选择,而不是删掉 override', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ composerLongPressEnabled: true });
    voiceInputDataStore.updateSettings({ composerLongPressEnabled: false });
    expect(readPersistedSettings().composerLongPressEnabledOverride).toBe(false);
  });

  it('传 null 恢复默认:删除 override,重新跟随版本默认值', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ composerLongPressEnabled: true });
    const next = voiceInputDataStore.updateSettings({ composerLongPressEnabled: null });
    expect(next.composerLongPressEnabled).toBe(false);
    expect(readPersistedSettings().composerLongPressEnabledOverride).toBeUndefined();
  });

  it('配置里残留的有效值不会被当成用户选择', () => {
    // 有效值只是写盘时的投影;没有 override 就一律跟随默认值。
    writeSettingsFile({ dictionaryEntries: [], composerLongPressEnabled: true });
    expect(voiceInputDataStore.getSettings().composerLongPressEnabled).toBe(false);
  });
});

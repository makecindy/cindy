/**
 * 词典同步开关的落盘契约:持久化只记录用户 override,不把派生的有效值固化进用户
 * 配置(docs/dev-rules/configuration-and-overrides.md §2)。派生值一旦落盘,「恢复
 * 默认」清除 override 后它仍残留在文件里 —— 将来版本修改默认值时,
 * `legacyDictionarySyncOverride()` 会把这个旧值重新解释成显式 override,已恢复
 * 默认的用户就再也跟不上新默认。
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
const { getDefaultVoiceInputSettings } = await import('../../../shared/voiceInputData.js');

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dictionary-sync-override-'));
  resetStoreCaches();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('词典同步开关 —— 落盘只持久化用户 override', () => {
  it('拨动记成 override,落盘不写派生的有效值', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    const next = voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });
    expect(next.dictionarySyncEnabled).toBe(false);
    expect(readPersistedSettings().dictionarySyncEnabledOverride).toBe(false);
    expect(readPersistedSettings().dictionarySyncEnabled).toBeUndefined();

    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabledOverride).toBe(false);
  });

  it('恢复默认后磁盘不残留有效值,重新跟随版本默认值', () => {
    const defaults = getDefaultVoiceInputSettings(process.platform);
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });
    const next = voiceInputDataStore.updateSettings({ dictionarySyncEnabled: null });
    expect(next.dictionarySyncEnabled).toBe(defaults.dictionarySyncEnabled);
    expect(readPersistedSettings().dictionarySyncEnabledOverride).toBeUndefined();
    expect(readPersistedSettings().dictionarySyncEnabled).toBeUndefined();

    resetStoreCaches();
    const reloaded = voiceInputDataStore.getSettings();
    expect(reloaded.dictionarySyncEnabled).toBe(defaults.dictionarySyncEnabled);
    expect(reloaded.dictionarySyncEnabledOverride).toBeUndefined();
  });

  it('恢复默认后无关保存不把有效值写回,后续默认变更可跟随', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: null });
    voiceInputDataStore.updateSettings({ language: 'zh-CN' });

    // 文件里没有这个键,将来改默认值的版本加载同一文件只会看到「无 override」,
    // legacyDictionarySyncOverride() 没有旧值可误读,必然跟随新默认。
    const persisted = readPersistedSettings();
    expect(persisted.dictionarySyncEnabled).toBeUndefined();
    expect(persisted.dictionarySyncEnabledOverride).toBeUndefined();
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabledOverride).toBeUndefined();
  });

  it('历史版本落盘的有效值仍按一次性迁移认作显式选择', () => {
    // 兼容路径不能被本契约改动破坏:老文件没有 override 字段,只有当时的有效值。
    writeSettingsFile({ dictionaryEntries: [], dictionarySyncEnabled: false });
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabledOverride).toBe(false);
  });
});

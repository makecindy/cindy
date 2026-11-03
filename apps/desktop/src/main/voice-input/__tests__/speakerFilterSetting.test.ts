/**
 * 「识别我的声音」设置的落盘契约:开关是普通布尔值;灵敏度只记录用户 override,
 * 不把默认档位固化进用户配置(docs/dev-rules/configuration-and-overrides.md §2)。
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-filter-setting-'));
  resetStoreCaches();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('识别我的声音 —— 开关与灵敏度', () => {
  it('默认关闭、标准档;无关设置保存不会写入灵敏度', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    const settings = voiceInputDataStore.getSettings();
    expect(settings.speakerFilterEnabled).toBe(false);
    expect(settings.speakerFilterStrictness).toBe('standard');

    voiceInputDataStore.updateSettings({ language: 'zh-CN' });
    expect(readPersistedSettings().speakerFilterStrictnessOverride).toBeUndefined();
    expect(readPersistedSettings().speakerFilterStrictness).toBeUndefined();
  });

  it('打开开关后重载保持', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ speakerFilterEnabled: true });
    expect(readPersistedSettings().speakerFilterEnabled).toBe(true);
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().speakerFilterEnabled).toBe(true);
  });

  it('选择灵敏度只记 override,重载后保持', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    const next = voiceInputDataStore.updateSettings({ speakerFilterStrictness: 'strict' });
    expect(next.speakerFilterStrictness).toBe('strict');
    expect(readPersistedSettings().speakerFilterStrictnessOverride).toBe('strict');
    expect(readPersistedSettings().speakerFilterStrictness).toBeUndefined();

    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().speakerFilterStrictness).toBe('strict');
  });

  it('传 null 恢复默认:删除 override,重新跟随版本默认档位', () => {
    writeSettingsFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ speakerFilterStrictness: 'relaxed' });
    const next = voiceInputDataStore.updateSettings({ speakerFilterStrictness: null });
    expect(next.speakerFilterStrictness).toBe('standard');
    expect(readPersistedSettings().speakerFilterStrictnessOverride).toBeUndefined();
  });

  it('非法档位被忽略,残留的有效值不会被当成用户选择', () => {
    writeSettingsFile({ dictionaryEntries: [], speakerFilterStrictness: 'strict' });
    expect(voiceInputDataStore.getSettings().speakerFilterStrictness).toBe('standard');

    voiceInputDataStore.updateSettings({ speakerFilterStrictness: 'extreme' } as never);
    expect(voiceInputDataStore.getSettings().speakerFilterStrictness).toBe('standard');
    expect(readPersistedSettings().speakerFilterStrictnessOverride).toBeUndefined();
  });
});

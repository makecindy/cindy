import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => {
  const onHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  return {
    dataDir: '',
    window,
    onHandlers,
    appGetPath: vi.fn(() => mocks.dataDir),
  };
});

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPath },
  BrowserWindow: { getAllWindows: vi.fn(() => [mocks.window]) },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.onHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  registerVoiceInputDataStoreIpc,
  voiceInputDataStore,
  VoiceInputDataStore,
} from '../VoiceInputDataStore.js';
import { createVoiceInputHistoryEntry } from '../../../shared/voiceInputData.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

describe('VoiceInputDataStore persistence', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-input-data-store-'));
    mocks.dataDir = dataDir;
    mocks.window.webContents.send.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the candidate before committing state and broadcasting it', () => {
    const store = new VoiceInputDataStore();

    const next = store.updateSettings({ language: 'en' });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'voice-input-data.v1.json'), 'utf8'),
    ) as { settings: { language: string } };

    expect(next.language).toBe('en');
    expect(persisted.settings.language).toBe('en');
    expect(store.getSettings().language).toBe('en');
    expect(mocks.window.webContents.send).toHaveBeenCalledTimes(1);
    expect(mocks.window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_INPUT.DATA_CHANGED,
      expect.objectContaining({ settings: expect.objectContaining({ language: 'en' }) }),
    );
  });

  it.each([
    ['writeFileSync', 'disk full'],
    ['renameSync', 'rename denied'],
  ])('keeps the previous state and does not broadcast when %s fails', (_operation, message) => {
    const store = new VoiceInputDataStore();
    store.updateSettings({ language: 'en' });
    mocks.window.webContents.send.mockClear();
    const before = store.getSnapshot();
    const failure = new Error(message);

    const method = _operation === 'writeFileSync' ? 'writeFileSync' : 'renameSync';
    vi.spyOn(fs, method).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => store.updateSettings({ language: 'ja' })).toThrow(
      `voice input data write failed: ${message}`,
    );
    expect(store.getSnapshot()).toEqual(before);
    expect(mocks.window.webContents.send).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'voice-input-data.v1.json'), 'utf8'),
    ) as { settings: { language: string } };
    expect(persisted.settings.language).toBe('en');
  });

  it('always completes sync history update and delete IPC calls', () => {
    registerVoiceInputDataStoreIpc();

    const recordEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_RECORD)?.(recordEvent, '原始语音文本');
    expect(recordEvent.returnValue).toEqual(expect.any(String));

    const updateEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_UPDATE)?.(updateEvent, {
      id: recordEvent.returnValue,
      text: '润色后文本',
    });
    expect(updateEvent.returnValue).toBe(true);
    expect(voiceInputDataStore.getHistory()).toEqual([
      expect.objectContaining({ id: recordEvent.returnValue, text: '润色后文本' }),
    ]);

    const deleteEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_DELETE)?.(deleteEvent, recordEvent.returnValue);
    expect(deleteEvent.returnValue).toBe(true);
    expect(voiceInputDataStore.getHistory()).toEqual([]);

    const invalidUpdateEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_UPDATE)?.(invalidUpdateEvent, {});
    expect(invalidUpdateEvent.returnValue).toBe(true);

    const invalidDeleteEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_DELETE)?.(invalidDeleteEvent, undefined);
    expect(invalidDeleteEvent.returnValue).toBe(true);
  });

  it('returns a decodable INTERNAL result from sync history IPC on write failure', () => {
    registerVoiceInputDataStoreIpc();
    voiceInputDataStore.getSnapshot();
    const longText = '历史记录'.repeat(80);
    const internal = voiceInputDataStore as unknown as {
      state: { history: Array<NonNullable<ReturnType<typeof createVoiceInputHistoryEntry>>> };
    };
    internal.state.history = Array.from({ length: 276 }, (_, index) =>
      createVoiceInputHistoryEntry(`${index} ${longText}`),
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    const event: { returnValue?: unknown } = {};
    mocks.onHandlers.get(IPC_CHANNELS.VOICE_INPUT.HISTORY_GET_FOR_REFINEMENT)?.(event);

    expect(event.returnValue).toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'voice input data write failed: rename denied',
    });
  });
});

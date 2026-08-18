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
      'voice-input:data-changed',
      expect.objectContaining({ settings: expect.objectContaining({ language: 'en' }) }),
    );
  });

  it('recovers from transient Windows EPERM while replacing the projection file', () => {
    const store = new VoiceInputDataStore();
    store.updateSettings({ language: 'en' });
    const target = path.join(dataDir, 'voice-input-data.v1.json');
    const realRename = fs.renameSync;
    let failFirstReplacement = true;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      if (failFirstReplacement && String(from).endsWith('.tmp') && String(to) === target) {
        failFirstReplacement = false;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return realRename(from as never, to as never);
    }) as typeof fs.renameSync);

    try {
      expect(store.updateSettings({ language: 'ja' }).language).toBe('ja');
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).settings.language).toBe('ja');
  });

  it('does not cache defaults when the .bak backup cannot be restored yet, and retries on the next read', () => {
    // 回归 Codex P2:main 文件缺失、.bak 还在、但恢复(rename .bak → main)这次
    // 失败(典型场景:Windows 文件锁/杀毒瞬时占用)时，属于
    // AtomicBackupUnrecoverableError——这不是"投影丢了"，.bak 里还有救得回来
    // 的真实数据。旧实现会把这次读取当成普通"文件不存在"缓存进 this.state，
    // 随后任何一次词典/设置写入触发的 save() 都会用这份错误的空状态覆盖磁盘，
    // 且回收逻辑还会据此给 CRDT 正本里的词条打墓碑，把瞬时故障升级成永久数据
    // 损毁。
    const target = path.join(dataDir, 'voice-input-data.v1.json');
    const seed = new VoiceInputDataStore();
    seed.updateSettings({ language: 'en' });
    // 模拟"main 文件缺失、.bak 还在":把已经落盘的正本改名成 .bak。
    fs.renameSync(target, `${target}.bak`);

    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      if (String(from) === `${target}.bak` && String(to) === target) {
        throw Object.assign(new Error('backup restore blocked'), { code: 'EPERM' });
      }
      return realRename(from as never, to as never);
    }) as typeof fs.renameSync);

    const store = new VoiceInputDataStore();
    try {
      // 第一次读取:恢复失败，这次调用只应该拿到默认值，不能崩溃、不能缓存。
      expect(store.getSettings().language).not.toBe('en');
    } finally {
      spy.mockRestore();
    }

    // 没有缓存空状态：下一次读取(瞬时故障已经"清除")重新尝试读盘，正确恢复
    // 出 .bak 里原本保存的设置。
    expect(store.getSettings().language).toBe('en');
  });

  it('refuses to write while the .bak backup is still unrecovered, instead of overwriting it with defaults-derived state', () => {
    // 回归 Codex P1:只是不缓存默认值还不够——updateSettings 这类调用是"先
    // load 当前值再基于它 replaceState"，如果拿到的是上一条用例里那份临时
    // 默认快照，合并出的"新状态"其实只包含这一次编辑，会在写盘前锁恰好释放
    // 时，让 atomicWriteFileSync 先把 .bak 恢复回主文件、再用这份派生自默认
    // 值的内容覆盖它——把瞬时故障变成永久丢失语音历史/设置，还可能连带给
    // 词典 CRDT 正本打墓碑。
    //
    // mock 只拦截"恢复"这一次调用(mockImplementationOnce)，模拟"load() 时
    // 锁还在、紧接着的 save() 时锁已经清除"——atomicWriteFileSync 自己内部
    // 的恢复重试这次会成功，所以能不能拦住这次写完全取决于 backupUnrecoverable
    // 这个标记，不是靠 atomicWriteFileSync 自己重复失败侥幸兜底。
    const target = path.join(dataDir, 'voice-input-data.v1.json');
    const seed = new VoiceInputDataStore();
    seed.updateSettings({ language: 'en' });
    fs.renameSync(target, `${target}.bak`);

    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(((from: string, to: string) => {
      if (String(from) === `${target}.bak` && String(to) === target) {
        throw Object.assign(new Error('backup restore blocked'), { code: 'EPERM' });
      }
      return realRename(from as never, to as never);
    }) as typeof fs.renameSync);

    const store = new VoiceInputDataStore();
    try {
      // updateSettings 内部自己会先 load()——这次调用本身就撞上 mock 的那一次
      // 恢复失败，置位 backupUnrecoverable，紧接着(同一次调用里，中间没有再
      // 插入一次成功的 load())就该在 replaceState→save() 被拒绝，而不是用
      // 这份派生自默认值的"新状态"覆盖磁盘——此时锁已经"清除"(mock 只拦了
      // 一次)，如果不是 backupUnrecoverable 拦下，atomicWriteFileSync 自己
      // 会顺利完成恢复 + 覆盖写入。
      expect(() => store.updateSettings({ language: 'ja' })).toThrow();
    } finally {
      spy.mockRestore();
    }

    // .bak 里原本保存的设置必须原封不动——没有被上面那次被拒绝的写入破坏。
    expect(JSON.parse(fs.readFileSync(`${target}.bak`, 'utf8')).settings.language).toBe('en');
    // 备份已经恢复(mock 已移除，重新读盘会成功)：这次真实读到的设置必须是
    // .bak 里原本的内容，不能是刚才被拒绝的那次写入留下的任何痕迹。
    expect(store.getSettings().language).toBe('en');
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
    mocks.onHandlers.get('voice-input:history:record')?.(recordEvent, '原始语音文本');
    expect(recordEvent.returnValue).toEqual(expect.any(String));

    const updateEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get('voice-input:history:update')?.(updateEvent, {
      id: recordEvent.returnValue,
      text: '润色后文本',
    });
    expect(updateEvent.returnValue).toBe(true);
    expect(voiceInputDataStore.getHistory()).toEqual([
      expect.objectContaining({ id: recordEvent.returnValue, text: '润色后文本' }),
    ]);

    const deleteEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get('voice-input:history:delete')?.(deleteEvent, recordEvent.returnValue);
    expect(deleteEvent.returnValue).toBe(true);
    expect(voiceInputDataStore.getHistory()).toEqual([]);

    const invalidUpdateEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get('voice-input:history:update')?.(invalidUpdateEvent, {});
    expect(invalidUpdateEvent.returnValue).toBe(true);

    const invalidDeleteEvent: { returnValue?: unknown } = {};
    mocks.onHandlers.get('voice-input:history:delete')?.(invalidDeleteEvent, undefined);
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
    mocks.onHandlers.get('voice-input:history:get-for-refinement')?.(event);

    expect(event.returnValue).toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'voice input data write failed: rename denied',
    });
  });
});

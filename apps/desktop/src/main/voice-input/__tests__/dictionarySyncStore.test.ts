/**
 * 词典同步落盘层与词典写入路径的接线。
 *
 * 重点盯三件事:
 *  1. 存量用户升级后词典不丢(首次迁移借回收路径完成,不需要单独的迁移代码);
 *  2. 旧版本客户端直接改过词典文件时,改动能被认领回来;
 *  3. **运行期的物化回写绝不能被反向读成本地增量** —— 那会让合并进来的远端计数
 *     被重复记账,词典频次随同步次数膨胀。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceDictionarySyncState } from '@cindy/voice-input-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

const activeOwnerId = vi.hoisted(() => ({ value: 'owner-1' }));

function setActiveOwner(ownerId: string): void {
  activeOwnerId.value = ownerId;
}

vi.mock('electron', () => ({
  app: { getPath: () => tempDir },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: activeOwnerId.value }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempDir, 'owners', 'owner-1', ...parts),
}));
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string, message: string) => {
    throw new Error(`[${code}] ${message}`);
  },
}));

const { voiceDictionarySyncStore } = await import('../VoiceDictionarySyncStore.js');
const { sanitizeDictionaryLearningActions, voiceInputDataStore } = await import(
  '../VoiceInputDataStore.js'
);
const { addManualEntry, createEmptySyncState, createHlcClock, deleteTerms, recordLearningEvent } = await import(
  '@cindy/voice-input-core'
);

const DATA_FILE = 'voice-input-data.v1.json';
const SYNC_FILE = 'voice-dictionary-sync.v1.json';

function ownerPath(fileName: string): string {
  return path.join(tempDir, 'owners', 'owner-1', fileName);
}

function writeDictionaryFile(settings: Record<string, unknown>): void {
  const filePath = ownerPath(DATA_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, settings, history: [] }),
    'utf-8',
  );
}

function readDictionaryFile(): { dictionaryEntries: Array<{ text: string; source: string; frequency: number }> } {
  return JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
}

/** 每个用例都要拿到全新的 store 内存状态:两个 store 都按 ownerId 缓存。 */
function resetStoreCaches(): void {
  activeOwnerId.value = 'owner-1';
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).data = null;
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).dataOwnerId = null;
  (voiceDictionarySyncStore as unknown as { pendingRecovery: unknown }).pendingRecovery = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).state = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).stateOwnerId = null;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dict-sync-'));
  resetStoreCaches();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('词典同步落盘 —— 首次迁移', () => {
  it('存量词典在首次加载时被整份认领进同步状态,内容不丢', () => {
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'legacy-1', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] },
        { id: 'legacy-2', text: 'LiteLLM', source: 'automatic', frequency: 5, aliases: [] },
      ],
      dictionaryCandidates: [
        { text: 'Orca', evidenceCount: 2, aliases: [], createdAt: 1, updatedAt: 1 },
      ],
      suppressedAutomaticDictionaryTexts: ['Cindy'],
    });

    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'LiteLLM',
      'Vibe Coding',
    ]);
    expect(settings.dictionaryEntries.find((entry) => entry.text === 'Vibe Coding')?.source).toBe('manual');
    expect(settings.dictionaryCandidates.map((item) => item.text)).toEqual(['Orca']);
    expect(settings.suppressedAutomaticDictionaryTexts).toEqual(['Cindy']);
    // 同步状态已建立,sidecar 落盘。
    expect(fs.existsSync(ownerPath(SYNC_FILE))).toBe(true);
  });

  it('空词典的新用户不会凭空产生词条', () => {
    writeDictionaryFile({ dictionaryEntries: [], dictionaryCandidates: [] });
    expect(voiceInputDataStore.getSettings().dictionaryEntries).toEqual([]);
  });
});

describe('词典同步落盘 —— 写入路径', () => {
  it('手动添加、改写、删除都落到同步状态并回投影到词典文件', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.getSettings();

    voiceInputDataStore.addManualDictionaryEntry('litellm');
    expect(readDictionaryFile().dictionaryEntries.map((entry) => entry.text)).toEqual(['litellm']);

    const entryId = voiceInputDataStore.getSettings().dictionaryEntries[0].id;
    voiceInputDataStore.renameDictionaryEntry(entryId, 'LiteLLM');
    expect(readDictionaryFile().dictionaryEntries.map((entry) => entry.text)).toEqual(['LiteLLM']);

    voiceInputDataStore.deleteDictionaryEntries([entryId]);
    expect(readDictionaryFile().dictionaryEntries).toEqual([]);
  });

  it('通用 settings 更新不能整份覆盖词典(会绕过同步状态)', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.addManualDictionaryEntry('Cindy');

    voiceInputDataStore.updateSettings({
      language: 'zh-CN',
      dictionaryEntries: [
        { id: 'x', text: '注入词条', source: 'manual', frequency: 1, aliases: [], createdAt: 1, updatedAt: 1 },
      ],
      suppressedAutomaticDictionaryTexts: ['Cindy'],
    });

    const settings = voiceInputDataStore.getSettings();
    expect(settings.language).toBe('zh-CN');
    expect(settings.dictionaryEntries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(settings.suppressedAutomaticDictionaryTexts).toEqual([]);
  });

  it('自动学习按 action 记录证据,低置信度与无别名的建议被丢弃', () => {
    writeDictionaryFile({ dictionaryEntries: [], refinementEnabled: true, autoDictionaryEnabled: true });
    voiceInputDataStore.getSettings();

    const result = voiceInputDataStore.recordDictionaryLearningActions([
      { action: 'add_entry', term: 'Vibe Coding', aliases: ['web coding'], type: 'phrase', confidence: 'high' },
      { action: 'add_entry', term: '低置信', aliases: ['低置心'], type: 'other', confidence: 'low' },
      { action: 'add_entry', term: '无证据', aliases: [], type: 'other', confidence: 'high' },
    ]);

    expect(result.settings.dictionaryEntries.map((entry) => entry.text)).toEqual(['Vibe Coding']);
    expect(result.newAutomaticEntries.map((entry) => entry.text)).toEqual(['Vibe Coding']);
  });
});

describe('词典同步落盘 —— 合并与回收', () => {
  it('合并远端状态后物化落盘,且不会把远端计数重复记成本地增量', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.getSettings();

    // 构造一份「远端设备学过 3 次」的状态。
    let remote = createEmptySyncState();
    let clock = createHlcClock('remote-node', 1_000);
    for (let index = 0; index < 3; index += 1) {
      const result = recordLearningEvent(remote, clock, {
        text: 'Vibe Coding',
        aliases: ['web coding'],
        stage: 'entry',
        nowMs: 1_000 + index,
      });
      remote = result.state;
      clock = result.clock;
    }

    expect(voiceInputDataStore.mergeRemoteDictionaryState(remote)).toBe(true);
    expect(readDictionaryFile().dictionaryEntries[0].frequency).toBe(3);

    // 同一份状态再合并任意多次都不该改变频次(幂等)。
    for (let round = 0; round < 5; round += 1) {
      voiceInputDataStore.mergeRemoteDictionaryState(remote);
    }
    expect(readDictionaryFile().dictionaryEntries[0].frequency).toBe(3);

    // 关键:重新加载(触发回收路径)之后,合并进来的 3 次不能被当成本地新增再记一遍。
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionaryEntries[0].frequency).toBe(3);
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionaryEntries[0].frequency).toBe(3);
  });

  it('旧版本客户端在词典文件里的增删能被认领回同步状态', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.addManualDictionaryEntry('Cindy');
    voiceInputDataStore.addManualDictionaryEntry('Orca');

    // 模拟降级:旧版本直接重写词典文件(删掉 Orca、加了 device-link)。
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] },
        { id: 'b', text: 'device-link', source: 'manual', frequency: 1, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    resetStoreCaches();

    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'device-link',
    ]);
  });

  it('更新版本的 sidecar 原样保留,词典也不被清空', () => {
    // 降级场景:用户装过更新的客户端,sidecar 里是 v2 状态。旧客户端读不懂,
    // 但绝不能把它当空状态物化出空词典再覆盖写回 —— 那会同时销毁用户的词典和
    // 所有设备的合并历史。
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] },
        { id: 'b', text: 'LiteLLM', source: 'automatic', frequency: 2, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    const syncPath = ownerPath(SYNC_FILE);
    const futureSidecar = JSON.stringify({
      version: 1,
      nodeId: 'future-node',
      clock: { wallMs: 9_000, counter: 3 },
      state: { version: 2, records: { future: { magic: true } }, suppressed: {} },
      lastMaterializedKeys: ['vibe coding', 'litellm'],
    });
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(syncPath, futureSidecar, 'utf-8');
    resetStoreCaches();

    // 词典照常可用(来自词典文件,不是空的)。
    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'LiteLLM',
      'Vibe Coding',
    ]);
    // sidecar 逐字节未动。
    expect(fs.readFileSync(syncPath, 'utf-8')).toBe(futureSidecar);

    // 词典写入必须明确失败(而不是静默无效或覆盖成空),sidecar 一个字节都不动。
    expect(() => voiceInputDataStore.addManualDictionaryEntry('Orca')).toThrow();
    expect(fs.readFileSync(syncPath, 'utf-8')).toBe(futureSidecar);
  });

  it('同步状态文件损坏时回退到词典文件,不让词典功能整体失效', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
    });
    const syncPath = ownerPath(SYNC_FILE);
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(syncPath, '{ this is not json', 'utf-8');
    resetStoreCaches();

    expect(voiceInputDataStore.getSettings().dictionaryEntries.map((entry) => entry.text)).toEqual([
      'Cindy',
    ]);
  });
});

describe('词典同步开关 —— 只持久化用户 override', () => {
  it('未自定义时配置里不留该字段,用户随版本跟随默认值', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    // 任何一次无关设置保存都不该把当前默认值固化进用户配置。
    voiceInputDataStore.updateSettings({ language: 'zh-CN' });

    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBeUndefined();
    // 有效值仍然是默认值。
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(true);
  });

  it('用户显式关闭后记录 override,并在重载后保持', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });

    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBe(false);

    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);
  });

  it('存量配置里的有效值:与默认不同才认作用户选择', () => {
    // 本 PR 早期版本把有效值直接写进了配置。false 只可能来自用户主动关闭。
    writeDictionaryFile({ dictionaryEntries: [], dictionarySyncEnabled: false });
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);

    // 而 true 与当时默认相同,无法区分「用户选的」和「默认」,按规则不猜意图。
    resetStoreCaches();
    writeDictionaryFile({ dictionaryEntries: [], dictionarySyncEnabled: true });
    voiceInputDataStore.updateSettings({ language: 'en' });
    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBeUndefined();
  });
});

describe('词典同步落盘 —— 数据丢失防线', () => {
  it('词典文件损坏时只读投影,绝不把整份词典墓碑掉', () => {
    // 先正常建立同步状态。
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] },
        { id: 'b', text: 'LiteLLM', source: 'automatic', frequency: 2, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    const sidecarBefore = fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8');

    // 投影文件损坏(不是缺失)。此时 settings 退化成默认空值,如果照常跑回收,
    // lastMaterializedKeys 里的每一条都会被判成用户删除 —— 一次读失败就此升级成
    // CRDT 正本的永久损毁。
    fs.writeFileSync(ownerPath(DATA_FILE), '{ not json', 'utf-8');
    resetStoreCaches();

    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'LiteLLM',
      'Vibe Coding',
    ]);
    // sidecar 未被改写,更没有墓碑。
    expect(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')).toBe(sidecarBefore);
    const sync = JSON.parse(sidecarBefore);
    for (const record of Object.values(sync.state.records) as Array<{ tombstones: object }>) {
      expect(Object.keys(record.tombstones)).toEqual([]);
    }
  });

  it('sidecar 来自更新客户端时拒绝词典写入,而不是覆盖成空', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] }],
    });
    const syncPath = ownerPath(SYNC_FILE);
    const futureSidecar = JSON.stringify({
      version: 1,
      nodeId: 'future-node',
      clock: { wallMs: 9_000, counter: 3 },
      state: { version: 99, records: {}, suppressed: {} },
      lastMaterializedKeys: ['vibe coding'],
    });
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(syncPath, futureSidecar, 'utf-8');
    resetStoreCaches();

    // 词典可读。
    expect(voiceInputDataStore.getSettings().dictionaryEntries.map((e) => e.text)).toEqual([
      'Vibe Coding',
    ]);
    // 写入必须明确失败 —— 早先会基于空状态物化,把现有词典覆盖成空。
    expect(() => voiceInputDataStore.addManualDictionaryEntry('Orca')).toThrow();
    expect(readDictionaryFile().dictionaryEntries.map((e) => e.text)).toEqual(['Vibe Coding']);
    expect(fs.readFileSync(syncPath, 'utf-8')).toBe(futureSidecar);
  });
});

describe('词典同步落盘 —— 第六轮收口', () => {
  it('投影文件被删除时同样只读物化,不把整份词典墓碑掉', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    const sidecarBefore = fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8');

    // 删除(不是损坏)投影文件 —— 与损坏一样,不能被当成「用户删光了词典」。
    fs.rmSync(ownerPath(DATA_FILE));
    resetStoreCaches();

    expect(voiceInputDataStore.getSettings().dictionaryEntries.map((e) => e.text)).toEqual([
      'Vibe Coding',
    ]);
    expect(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')).toBe(sidecarBefore);
  });

  it('sidecar 丢失后重建不把已同步的频次当作本机新证据', () => {
    // 投影里的频次含有别的设备合并进来的部分;当成本机计数重新播种的话,
    // 与那台设备再同步时同一份事件会在两个节点桶里各记一遍,频次凭空翻倍。
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'automatic', frequency: 9, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();

    // 认领先被挂起(等对端墓碑),此时 UI 照常显示投影文件里的内容。
    const during = voiceInputDataStore.getSettings();
    expect(during.dictionaryEntries.map((e) => e.text)).toEqual(['Cindy']);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 认领落地之后:存在性保留,计数不重新播种。
    voiceDictionarySyncStore.flushPendingRecovery('local-edit');
    const materialized = voiceDictionarySyncStore.materialize();
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(materialized.entries[0].frequency).toBe(1);
  });

  it('导入把已有词条数算进上限,不能对着满词典无限追加', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.getSettings();

    voiceInputDataStore.importManualDictionaryEntries(
      Array.from({ length: 1_200 }, (_, index) => `term-${index}`),
    );
    const first = voiceInputDataStore.getSettings().dictionaryEntries.length;
    expect(first).toBe(1_000);

    // 再导入一批:已经满了,不应该继续增长。
    voiceInputDataStore.importManualDictionaryEntries(
      Array.from({ length: 500 }, (_, index) => `extra-${index}`),
    );
    expect(voiceInputDataStore.getSettings().dictionaryEntries.length).toBe(1_000);
  });

  it('同步开关可以恢复默认(删除 override 而不是写静态快照)', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });
    expect(JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings.dictionarySyncEnabledOverride)
      .toBe(false);

    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: null });
    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBeUndefined();
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(true);
  });
});

describe('词典同步落盘 —— 第七轮收口', () => {
  it('sidecar 丢失时挂起认领,等合并过对端再落地,不复活对端删掉的词', () => {
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Cindy', source: 'manual', frequency: 3, aliases: [] },
        { id: 'b', text: 'Orca', source: 'manual', frequency: 2, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();

    // 对端删掉了 Cindy。先把对端状态留下来,再模拟本机 sidecar 丢失。
    const peer = JSON.parse(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')) as {
      state: VoiceDictionarySyncState;
      nodeId: string;
      clock: { wallMs: number; counter: number };
    };
    const peerAfterDelete = deleteTerms(
      peer.state,
      { ...peer.clock, nodeId: peer.nodeId },
      { termKeys: ['cindy'], nowMs: Date.now() + 1_000 },
    );

    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();

    // 认领被挂起:UI 仍然看得到投影文件里的词典,一个都没少。
    const duringRecovery = voiceInputDataStore.getSettings();
    expect(duringRecovery.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'Orca',
    ]);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 与对端合并 —— 墓碑到齐,挂起的认领这时落地。
    voiceInputDataStore.mergeRemoteDictionaryState(peerAfterDelete.state);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(false);

    const after = voiceInputDataStore.getSettings();
    // 对端删掉的词不复活,没删的正常认领回来。
    expect(after.dictionaryEntries.map((entry) => entry.text)).toEqual(['Orca']);
  });

  it('挂起期间用户编辑词典,认领就地落地,不会被空状态覆盖成空', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 3, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    const settings = voiceInputDataStore.addManualDictionaryEntry('Orca');
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual(['Cindy', 'Orca']);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(false);
  });

  it('sidecar 只写稳定字段,本次加载的判断结果不落盘', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    voiceInputDataStore.addManualDictionaryEntry('Orca');

    const raw = JSON.parse(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      'clock',
      'lastMaterializedKeys',
      'nodeId',
      'state',
      'version',
    ]);
  });

  it('物化登记失败时投影与 key 基线一起回滚', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    const baseline = (
      JSON.parse(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')) as { lastMaterializedKeys: string[] }
    ).lastMaterializedKeys;

    // 让第二段写入失败。
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    expect(() => voiceInputDataStore.addManualDictionaryEntry('Orca')).toThrow();
    spy.mockRestore();

    const after = JSON.parse(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')) as {
      lastMaterializedKeys: string[];
    };
    // key 基线必须退回去:留着新基线,下次回收会拿它对照回滚后的状态,把这次变更反向执行。
    expect(after.lastMaterializedKeys).toEqual(baseline);
  });
});

describe('首次迁移与 sidecar 丢失必须分得开', () => {
  it('首次迁移整份接管频次;之后 sidecar 丢了才按恢复处理', () => {
    // 1. 存量用户升级:投影里有词典、没有同步印记 → 整份认领,频次原样保留。
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Claude code', source: 'manual', frequency: 4, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    const migrated = voiceInputDataStore.getSettings();
    expect(migrated.dictionaryEntries[0].frequency).toBe(4);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(false);
    // 印记必须落盘,否则下次 sidecar 丢失会被再次误判成首次迁移。
    expect(
      (JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')) as { dictionarySyncInitialized?: boolean })
        .dictionarySyncInitialized,
    ).toBe(true);

    // 2. 同一台机器随后丢了 sidecar:这次是恢复,认领要挂起等对端。
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);
  });
});

describe('词典同步落盘 —— 第八轮收口', () => {
  it('收到内容相同的对端状态也会落地挂起的恢复', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 2, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 对端是台新机器,词典为空 —— 合并引入不了任何新信息,但它是一份合法状态。
    // 不在这里落地的话,本机会一直只显示投影、对外发空状态,直到用户手动改词典。
    voiceInputDataStore.mergeRemoteDictionaryState(createEmptySyncState());
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(false);
    expect(voiceDictionarySyncStore.materialize().entries.map((entry) => entry.text)).toEqual([
      'Cindy',
    ]);
  });

  it('切换账号会丢掉上一个账号挂起的恢复', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: '账号A的词', source: 'manual', frequency: 1, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 切到账号 B。挂起的快照属于 A,留着的话 B 的第一次编辑就会把 A 的词写进 B 的词典。
    setActiveOwner('owner-2');
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(false);

    const settings = voiceInputDataStore.addManualDictionaryEntry('账号B的词');
    expect(settings.dictionaryEntries.map((entry) => entry.text)).toEqual(['账号B的词']);
  });
});

describe('词典同步落盘 —— 第九轮收口', () => {
  it('从盘上读回的状态是无原型字典 —— 原型名词条不会取到继承来的值', () => {
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'constructor', source: 'manual', frequency: 1, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    // 重新从盘上加载:JSON.parse 出来的对象带 Object.prototype。
    resetStoreCaches();

    const state = voiceDictionarySyncStore.getState();
    expect(Object.getPrototypeOf(state.records)).toBeNull();
    expect(Object.getPrototypeOf(state.suppressed)).toBeNull();
    // 不存在的原型名键必须是 undefined,而不是继承来的函数。
    expect(state.records['toString']).toBeUndefined();

    // 而且此时还能正常给这类词做变更,不会拿函数当记录用。
    const settings = voiceInputDataStore.addManualDictionaryEntry('toString');
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'constructor',
      'toString',
    ]);
  });

  it('坏帧不算「收到对端状态」,不会提前落地挂起的恢复', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 结构坏的帧、版本更高的帧都会被归一化成空状态 —— 但它们不是「对端词典是空的」,
    // 拿它们当信号会在真正的墓碑到齐之前播种新化身。
    voiceInputDataStore.mergeRemoteDictionaryState({ version: 1, records: 'nope' });
    voiceInputDataStore.mergeRemoteDictionaryState({ version: 99, records: {}, suppressed: {} });
    voiceInputDataStore.mergeRemoteDictionaryState(null);
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);
  });

  it('恢复落地失败时挂起项要留着 —— 否则重试会把整份词典覆盖掉', () => {
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] },
        { id: 'b', text: 'Orca', source: 'manual', frequency: 1, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    expect(() => voiceInputDataStore.addManualDictionaryEntry('新词')).toThrow();
    spy.mockRestore();
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);

    // 重试:恢复的词典和新编辑都在。
    const settings = voiceInputDataStore.addManualDictionaryEntry('新词');
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'Orca',
      '新词',
    ]);
  });

  it('只有候选词的用户丢了 sidecar 也按恢复处理', () => {
    writeDictionaryFile({
      dictionaryEntries: [],
      dictionaryCandidates: [{ text: 'Cindy', evidenceCount: 3, aliases: [] }],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();
    fs.rmSync(ownerPath(SYNC_FILE));
    resetStoreCaches();
    voiceInputDataStore.getSettings();

    // 漏算候选的话这里会被当成首次迁移,把证据数按本机新证据重新播种。
    expect(voiceDictionarySyncStore.hasPendingRecovery()).toBe(true);
  });

  it('学习动作在进 store 之前就被裁剪:动作条数、别名条数与单条长度都有上限', () => {
    // 防线必须在 IPC 入口,而不是等 store 内部截断 —— 遍历十万个别名这件事本身
    // 就会卡住 main 线程,即使最终只留下 8 个。
    const sanitized = sanitizeDictionaryLearningActions([
      ...Array.from({ length: 100 }, (_, index) => ({
        action: 'add_entry',
        term: `term-${index}`,
        aliases: [
          ...Array.from({ length: 5_000 }, (_, aliasIndex) => `alias-${aliasIndex}`),
          'x'.repeat(5_000),
          123,
          '   ',
        ],
      })),
      { action: 'add_entry' }, // 缺 term
      { term: 'no-action' }, // 缺 action
      null,
      'not-an-object',
      { action: 'add_entry', term: 'y'.repeat(5_000) }, // term 超长
    ]);

    expect(sanitized.length).toBe(32);
    for (const action of sanitized) {
      expect(action.aliases?.length).toBeLessThanOrEqual(8);
      expect(action.aliases?.every((alias) => alias.length <= 120)).toBe(true);
      expect(action.term.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('词典同步落盘 —— 第十轮收口', () => {
  it('另一个进程写过盘之后再落盘,不会覆盖掉对方的词条', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    voiceInputDataStore.getSettings();

    // 模拟共享 userData 的另一个进程:它读到同一份 sidecar,加了一个词并写回。
    const raw = JSON.parse(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')) as {
      state: VoiceDictionarySyncState;
      nodeId: string;
      clock: { wallMs: number; counter: number };
      lastMaterializedKeys: string[];
      version: number;
    };
    const other = addManualEntry(
      raw.state,
      { wallMs: raw.clock.wallMs + 1_000, counter: 0, nodeId: 'other-process' },
      { text: '另一个进程加的词', nowMs: Date.now() },
    );
    fs.writeFileSync(
      ownerPath(SYNC_FILE),
      JSON.stringify({ ...raw, state: other.state }),
      'utf-8',
    );

    // 本进程手上还是旧快照,现在做一次自己的变更。
    const settings = voiceInputDataStore.addManualDictionaryEntry('本进程加的词');

    // 两边的词都要在 —— 直接覆盖写的话,另一个进程那条就没了。
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'istanbul'.replace('istanbul', '另一个进程加的词'),
      '本进程加的词',
    ].sort());
  });

  it('wrapper 版本更高的 sidecar 一个字节都不碰', () => {
    fs.mkdirSync(path.dirname(ownerPath(SYNC_FILE)), { recursive: true });
    const future = JSON.stringify({
      version: 99,
      nodeId: 'future-node',
      clock: { wallMs: 1, counter: 0 },
      state: { version: 1, records: {}, suppressed: {} },
      lastMaterializedKeys: [],
      futureOnlyField: 'must survive',
    });
    fs.writeFileSync(ownerPath(SYNC_FILE), future, 'utf-8');
    writeDictionaryFile({ dictionaryEntries: [] });
    resetStoreCaches();

    voiceInputDataStore.getSettings();
    expect(() => voiceInputDataStore.addManualDictionaryEntry('Cindy')).toThrow();
    expect(fs.readFileSync(ownerPath(SYNC_FILE), 'utf-8')).toBe(future);
  });

  it('删除词条的 IPC 与新增走同一套守卫', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'VoiceInputDataStore.ts'),
      'utf-8',
    );
    const handler = source.slice(source.indexOf("'voice-input:dictionary:delete-entries'"));
    const body = handler.slice(0, handler.indexOf('});'));
    expect(body).toContain('assertTrustedAppRendererEvent');
    expect(body).toContain('sanitizeDictionaryEntryIds');
  });

  it('用户显式打开同步会被记成 override,即使它和当前默认值相同', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: true });

    // 曾经关掉、后来特意打开的用户是明确表过态的:以后默认改成 false 不该把他关掉。
    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBe(true);

    // 只有显式的「恢复默认」才清掉 override。
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: null });
    expect(
      JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings.dictionarySyncEnabledOverride,
    ).toBeUndefined();
  });
});

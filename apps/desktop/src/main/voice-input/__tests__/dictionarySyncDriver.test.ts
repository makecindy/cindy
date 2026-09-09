/**
 * 词典对等同步驱动的传输策略。
 *
 * 这一层不碰合并语义(那在 voice-input-core 里),只回答三个问题:什么时候发、
 * 发给谁、收到什么才处理。盯住的边界:
 *  - 关掉同步开关后,桌面 CRDT 通道彻底静默(既不发也不合并);
 *  - 手机只读投影不受「允许被控」限制;开关关闭时只在手机上线或开关切换时
 *    推一次空投影清缓存,本地学习/编辑不再持续推空表;
 *  - 认不出的帧结构直接忽略,坏帧不能污染本机词典。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  versionVectorDominates,
} from '@cindy/voice-input-core';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const syncEnabled = { value: true };
const mergeRemoteDictionaryState = vi.fn<(remote: unknown) => boolean>(() => true);
vi.mock('../VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    getSettings: () => ({ dictionarySyncEnabled: syncEnabled.value }),
    mergeRemoteDictionaryState: (remote: unknown) => mergeRemoteDictionaryState(remote),
  },
}));

const syncState = { version: 1 as const, records: {}, suppressed: {} };
/** 让个别用例把状态换成超大对象,验证帧上限把关。 */
const stateOverride: { value: unknown } = { value: null };
const defaultMaterializedEntry = {
  id: 'dict-sync-cindy',
  text: 'Cindy',
  source: 'manual' as const,
  frequency: 2,
  aliases: [{ text: 'sindy', count: 1, lastSeenAt: 5 }],
  createdAt: 1,
  updatedAt: 2,
};
const materialized = {
  entries: [defaultMaterializedEntry],
};
vi.mock('../VoiceDictionarySyncStore.js', () => ({
  voiceDictionarySyncStore: {
    getState: () => stateOverride.value ?? syncState,
    materialize: () => ({
      entries: materialized.entries,
      candidates: [],
      suppressedTexts: [],
    }),
  },
}));

const {
  broadcastDictionaryNow,
  handleDesktopPeerOnline,
  handleIncomingDictionaryState,
  handleMobilePeerOnline,
  initVoiceDictionarySync,
  isDesktopPlatform,
  notifyLocalDictionaryChanged,
  buildMobileDictionarySnapshot,
  readDictionaryProjectionForMobile,
  shouldExchangeDictionaryWith,
  stopVoiceDictionarySync,
} = await import('../dictionarySyncDriver.js');

const sendState = vi.fn();
const sendMobileSnapshot = vi.fn();
const onlineDesktops: string[] = [];
const onlineMobiles: string[] = [];

beforeEach(() => {
  syncEnabled.value = true;
  sendState.mockClear();
  sendMobileSnapshot.mockClear();
  mergeRemoteDictionaryState.mockClear();
  mergeRemoteDictionaryState.mockReturnValue(true);
  onlineDesktops.length = 0;
  onlineMobiles.length = 0;
  stateOverride.value = null;
  materialized.entries = [defaultMaterializedEntry];
  initVoiceDictionarySync({
    sendState: (deviceId, payload) => sendState(deviceId, payload),
    listOnlineDesktopDevices: () => [...onlineDesktops],
    sendMobileSnapshot: (deviceId, payload) => sendMobileSnapshot(deviceId, payload),
    listOnlineMobileDevices: () => [...onlineMobiles],
  });
});

afterEach(() => {
  stopVoiceDictionarySync();
});

describe('设备平台判定', () => {
  it('只把桌面平台当作同步对端', () => {
    expect(isDesktopPlatform('darwin')).toBe(true);
    expect(isDesktopPlatform('win32')).toBe(true);
    expect(isDesktopPlatform('linux')).toBe(true);
    // 手机在后台不维持 WebSocket,收不到 push —— 它走主动拉取。
    expect(isDesktopPlatform('ios')).toBe(false);
    expect(isDesktopPlatform('android')).toBe(false);
    expect(isDesktopPlatform(undefined)).toBe(false);
  });
});

describe('对端准入判定', () => {
  const desktop = { online: true, platform: 'darwin', revoked: false };

  it('在线的未撤销电脑才交换词典', () => {
    expect(shouldExchangeDictionaryWith(desktop)).toBe(true);
  });

  it('撤销过的设备一律排除 —— 撤销的意图是不再交换数据,不只是不许操作', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, revoked: true })).toBe(false);
  });

  it('离线设备不发:relay 不暂存离线消息', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, online: false })).toBe(false);
    // 离线 + 已撤销也要挡住,不能靠某一个条件兜底。
    expect(shouldExchangeDictionaryWith({ online: false, platform: 'darwin', revoked: true })).toBe(false);
  });

  it('手机不走这条通道', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, platform: 'ios' })).toBe(false);
    expect(shouldExchangeDictionaryWith({ ...desktop, platform: null })).toBe(false);
  });
});

describe('出站', () => {
  it('对端桌面上线时立即单发一次当前状态,并索取回发', () => {
    handleDesktopPeerOnline('peer-1');
    expect(sendState).toHaveBeenCalledTimes(1);
    // requestReply:对端离线期间本机可能已落后于它,而它合并后若发现自己是超集
    // 就不会主动回发 —— 必须显式索取,否则要等到它下次编辑或半小时兜底。
    expect(sendState).toHaveBeenCalledWith('peer-1', {
      frameVersion: 1,
      state: syncState,
      requestReply: true,
    });
  });

  it('开关关闭后既不主动发送也不处理入站', () => {
    syncEnabled.value = false;
    handleDesktopPeerOnline('peer-1');
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(sendState).not.toHaveBeenCalled();
    expect(mergeRemoteDictionaryState).not.toHaveBeenCalled();
  });

  it('单个对端发送失败不影响其它对端', () => {
    onlineDesktops.push('peer-1', 'peer-2');
    sendState.mockImplementationOnce(() => {
      throw new Error('relay offline');
    });
    // 合并引入新信息 → 回发;这里借回发路径触发一次广播语义的失败隔离。
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(() => handleDesktopPeerOnline('peer-2')).not.toThrow();
  });

  it('手机上线时主动推只读快照,不依赖远程控制开关', () => {
    handleMobilePeerOnline('phone-1');
    expect(sendMobileSnapshot).toHaveBeenCalledWith('phone-1', expect.objectContaining({
      ok: true,
      entries: [
        { text: 'Cindy', frequency: 2, aliases: [{ text: 'sindy', count: 1 }] },
      ],
    }));
    expect(sendMobileSnapshot.mock.calls[0][1].emittedAt).toEqual(expect.any(Number));
  });

  it('同步关闭时仍推空投影给手机,让旧缓存及时清空', () => {
    syncEnabled.value = false;
    handleMobilePeerOnline('phone-1');
    expect(sendMobileSnapshot).toHaveBeenCalledWith(
      'phone-1',
      expect.objectContaining({ ok: true, entries: [] }),
    );
  });

  it('立即广播会同时刷新所有在线手机', () => {
    onlineMobiles.push('phone-1', 'phone-2');
    broadcastDictionaryNow();
    expect(sendMobileSnapshot).toHaveBeenCalledTimes(2);
  });

  it('同步关闭后本地变更不再向手机推空投影', () => {
    syncEnabled.value = false;
    onlineMobiles.push('phone-1');
    notifyLocalDictionaryChanged();
    expect(sendMobileSnapshot).not.toHaveBeenCalled();
    expect(sendState).not.toHaveBeenCalled();
  });

  it('手机快照超过单帧上限时不发送', () => {
    materialized.entries = Array.from({ length: 1_000 }, (_, index) => ({
      id: `term-${index}`,
      text: '词'.repeat(80),
      source: 'manual' as const,
      frequency: 1,
      aliases: Array.from({ length: 8 }, () => ({
        text: '别'.repeat(120),
        count: 1,
        lastSeenAt: 1,
      })),
      createdAt: 1,
      updatedAt: 1,
    }));
    handleMobilePeerOnline('phone-1');
    expect(sendMobileSnapshot).not.toHaveBeenCalled();
  });
});

describe('入站', () => {
  it('合并引入新信息时回发本机状态,完成双向收敛', () => {
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(mergeRemoteDictionaryState).toHaveBeenCalledWith(syncState);
    expect(sendState).toHaveBeenCalledWith('peer-1', { frameVersion: 1, state: syncState });
  });

  it('合并没有引入新信息时不回发,避免两台设备互相弹球', () => {
    mergeRemoteDictionaryState.mockReturnValue(false);
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(sendState).not.toHaveBeenCalled();
  });

  it('帧结构认不出时直接忽略', () => {
    handleIncomingDictionaryState('peer-1', undefined);
    handleIncomingDictionaryState('peer-1', { frameVersion: 2, state: syncState });
    handleIncomingDictionaryState('peer-1', { frameVersion: 1 });
    handleIncomingDictionaryState('peer-1', 'not-an-object');
    expect(mergeRemoteDictionaryState).not.toHaveBeenCalled();
  });

  it('合并抛错时吞掉,不让坏帧打断本机词典功能', () => {
    mergeRemoteDictionaryState.mockImplementation(() => {
      throw new Error('corrupt state');
    });
    expect(() => handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState })).not.toThrow();
    expect(sendState).not.toHaveBeenCalled();
  });
});

describe('回发协商', () => {
  it('对端索取回发时,即使本次合并没有引入新信息也要回', () => {
    // 场景:A 关掉同步期间 B 学了新词,A 重新打开并广播自己的陈旧状态。B 合并后
    // 发现自己已是超集(changed=false),若不看 requestReply 就不会回发,A 永远
    // 追不上 —— 直到 B 下次编辑或半小时兜底。
    mergeRemoteDictionaryState.mockReturnValue(false);
    handleIncomingDictionaryState('peer-1', {
      frameVersion: 1,
      state: syncState,
      requestReply: true,
    });
    expect(sendState).toHaveBeenCalledTimes(1);
  });

  it('回发本身不再索取回发,避免两端来回弹球', () => {
    mergeRemoteDictionaryState.mockReturnValue(false);
    handleIncomingDictionaryState('peer-1', {
      frameVersion: 1,
      state: syncState,
      requestReply: true,
    });
    expect(sendState).toHaveBeenCalledWith('peer-1', { frameVersion: 1, state: syncState });
  });
});

describe('帧大小上限', () => {
  it('状态超过 relay 单帧上限时不发送,并留下明确日志', () => {
    // relay 拒收超限帧且 sendEnvelope 会抛;不自己把关的话,词典一旦长到越线,
    // 此后每次广播都抛异常,同步会永久静默停摆。
    const huge: Record<string, unknown> = {};
    const filler = 'x'.repeat(2_000);
    for (let index = 0; index < 2_000; index += 1) huge[`term-${index}`] = filler;
    stateOverride.value = { version: 1, records: huge, suppressed: {} };

    onlineDesktops.push('peer-1');
    handleDesktopPeerOnline('peer-1');
    expect(sendState).not.toHaveBeenCalled();
  });

  it('正常大小的状态照常发送', () => {
    handleDesktopPeerOnline('peer-1');
    expect(sendState).toHaveBeenCalledTimes(1);
  });
});

describe('手机只读投影', () => {
  it('只投影润色用得上的字段,不含同步元数据', () => {
    const projection = readDictionaryProjectionForMobile();
    expect(projection.entries).toEqual([
      { text: 'Cindy', frequency: 2, aliases: [{ text: 'sindy', count: 1 }] },
    ]);
    // 除了词条、发出时间和版本向量,不该漏出节点 id、化身、墓碑等同步内部结构。
    expect(Object.keys(projection).sort()).toEqual(['entries']);
  });

  it('带上版本向量,让手机按包含关系而不是响应到达顺序挑快照', () => {
    const first = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    });
    stateOverride.value = first.state;
    const before = readDictionaryProjectionForMobile().stateVector;
    expect(before && Object.keys(before)).toEqual(['node-a']);

    const second = addManualEntry(first.state, first.clock, { text: 'Orca', nowMs: 9_000 });
    stateOverride.value = second.state;
    const after = readDictionaryProjectionForMobile().stateVector!;
    // 向量对合并单调:后一份必须包含前一份,否则手机会一直停在旧快照上。
    expect(versionVectorDominates(after, before!)).toBe(true);
    expect(versionVectorDominates(before!, after)).toBe(false);
  });

  it('同步关闭的空投影仍带上当前版本向量,避免晚到的空表清掉更新快照', () => {
    const first = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    });
    stateOverride.value = first.state;
    syncEnabled.value = false;
    const projection = readDictionaryProjectionForMobile();
    expect(projection.entries).toEqual([]);
    expect(projection.stateVector && Object.keys(projection.stateVector)).toEqual(['node-a']);
  });

  it('主动 GET 与 push 共用带 emittedAt 的投影', () => {
    const snapshot = buildMobileDictionarySnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.emittedAt).toEqual(expect.any(Number));
  });

  it('时钟回拨后同主机发出序号仍单调', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(5_000);
    const first = buildMobileDictionarySnapshot();
    now.mockReturnValue(1_000);
    const second = buildMobileDictionarySnapshot();
    now.mockRestore();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.emittedAt).toBeGreaterThan(first.emittedAt ?? 0);
    }
  });
});

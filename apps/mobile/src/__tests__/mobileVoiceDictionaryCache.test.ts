/**
 * 手机端词典缓存的降级行为。
 *
 * 手机拿的是被控桌面的只读快照,拉不到的情形很常见(桌面离线、老版本被控端不认识
 * 这个 channel、隧道抖动)。这一层的硬要求是:**任何失败都只降级到上次缓存,绝不
 * 抛错打断语音输入**,也绝不为了拉词典让开麦等待。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileVoiceDictionarySnapshotResult } from '@cindy/maker-shared/device-link-contract';

const storage = new Map<string, string>();
const persistGate = {
  delaySnapshotWrites: false,
  waiters: [] as Array<() => void>,
};

function releaseSnapshotWrites(): void {
  const waiters = persistGate.waiters.splice(0);
  for (const release of waiters) release();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (
        persistGate.delaySnapshotWrites
        && key.includes('mobileVoiceDictionary.v2.')
        && !key.endsWith('.hosts')
      ) {
        await new Promise<void>((resolve) => {
          persistGate.waiters.push(resolve);
        });
      }
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

vi.mock('@/session/mobileVoiceHistoryStore', () => ({
  listMobileVoiceHistoryHosts: async () => [] as string[],
}));

const {
  __resetMobileVoiceDictionaryCacheForTests,
  applyMobileVoiceDictionarySnapshot,
  setMobileVoiceDictionaryAccountScope,
  clearAllMobileVoiceDictionaryCaches,
  hydrateMobileVoiceDictionary,
  readCachedMobileVoiceDictionary,
  readCachedMobileVoiceDictionarySnapshot,
  refreshMobileVoiceDictionary,
  subscribeMobileVoiceDictionaryCache,
} = await import('@/session/mobileVoiceDictionaryCache');

const HOST = 'desktop-1';

beforeEach(() => {
  storage.clear();
  persistGate.delaySnapshotWrites = false;
  releaseSnapshotWrites();
  __resetMobileVoiceDictionaryCacheForTests();
  setMobileVoiceDictionaryAccountScope('');
});

describe('mobileVoiceDictionaryCache', () => {
  it('接收桌面主动推送的快照后立即可读并落盘', async () => {
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '推送词', frequency: 4 }],
    });

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([
      { text: '推送词', frequency: 4, aliases: [] },
    ]);
    __resetMobileVoiceDictionaryCacheForTests();
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('推送词');
  });

  it('拉取成功后缓存并落盘,重启后能恢复', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Vibe Coding', frequency: 3, aliases: [{ text: 'web coding', count: 2 }] }],
    }));

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([
      { text: 'Vibe Coding', frequency: 3, aliases: [{ text: 'web coding', count: 2 }] },
    ]);

    // 模拟 App 重启:内存清空,只剩盘上数据。
    __resetMobileVoiceDictionaryCacheForTests();
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Vibe Coding');
  });

  it('拉取失败沿用上次缓存,不抛错', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Cindy', frequency: 1 }],
    }));

    // 桌面离线 / 隧道抛错。
    await expect(
      refreshMobileVoiceDictionary(HOST, async () => {
        throw new Error('DEVICE_OFFLINE');
      }, { force: true }),
    ).resolves.toBeUndefined();
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');

    // 老版本被控端不认识该 channel。
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: false,
      error: 'CHANNEL_NOT_ALLOWED',
    }), { force: true });
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');
  });

  it('从没拉到过时返回空词典,润色照常进行', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({ ok: false, error: 'offline' }));
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });

  it('短时间内不重复拉取,force 可以强制刷新', async () => {
    const fetchSnapshot = vi.fn(async () => ({ ok: true as const, entries: [{ text: 'Cindy' }] }));
    await refreshMobileVoiceDictionary(HOST, fetchSnapshot);
    await refreshMobileVoiceDictionary(HOST, fetchSnapshot);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    await refreshMobileVoiceDictionary(HOST, fetchSnapshot, { force: true });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('不同被控桌面的词典互不串味', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({ ok: true, entries: [{ text: 'Cindy' }] }));
    await refreshMobileVoiceDictionary('desktop-2', async () => ({
      ok: true,
      entries: [{ text: 'Orca' }],
    }));

    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');
    expect(readCachedMobileVoiceDictionary('desktop-2')[0].text).toBe('Orca');
  });

  it('账号边界清理:抹掉内存与盘上缓存,下一个账号读不到上一个账号的词条', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '内部项目代号' }],
    }));
    await refreshMobileVoiceDictionary('desktop-2', async () => ({
      ok: true,
      entries: [{ text: 'Cindy' }],
    }));
    expect(readCachedMobileVoiceDictionary(HOST)).toHaveLength(1);

    await clearAllMobileVoiceDictionaryCaches();

    // 内存清空。
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(readCachedMobileVoiceDictionary('desktop-2')).toEqual([]);
    // 盘上也清空 —— 否则下个账号一 hydrate 就把上个账号的词典读回来。
    await hydrateMobileVoiceDictionary(HOST);
    await hydrateMobileVoiceDictionary('desktop-2');
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(readCachedMobileVoiceDictionary('desktop-2')).toEqual([]);
    expect([...storage.keys()].filter((key) => key.includes('mobileVoiceDictionary'))).toEqual([]);
  });

  it('清理会丢弃在途请求的结果,不让登出瞬间返回的响应写回缓存', async () => {
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const inFlight = refreshMobileVoiceDictionary(HOST, () => pending);

    await clearAllMobileVoiceDictionaryCaches();
    release({ ok: true, entries: [{ text: '上个账号的词' }] });
    await inFlight;

    // 在途响应即使晚到,也不该让上个账号的词典复活到内存里被润色读走。
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });

  it('并发刷新多台电脑时 host 索引不丢条目 —— 丢了登出就清理不到', async () => {
    const hosts = ['d1', 'd2', 'd3', 'd4', 'd5'];
    await Promise.all(hosts.map((host) => refreshMobileVoiceDictionary(
      host,
      async () => ({ ok: true, entries: [{ text: `term-${host}` }] }),
    )));

    const index = JSON.parse(storage.get('xdt.mobileVoiceDictionary.v2.hosts') ?? '[]') as string[];
    expect([...index].sort()).toEqual(hosts);

    // 索引完整 → 登出能把每一份快照都删掉。
    await clearAllMobileVoiceDictionaryCaches();
    expect([...storage.keys()].filter((key) => key.includes('mobileVoiceDictionary'))).toEqual([]);
  });

  it('清理期间落盘的写入会自我回收,不在盘上留下上个账号的快照', async () => {
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const inFlight = refreshMobileVoiceDictionary(HOST, () => pending);

    await clearAllMobileVoiceDictionaryCaches();
    release({ ok: true, entries: [{ text: '上个账号的词' }] });
    await inFlight;

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    // 关键:落盘发生在清理之后也要被回收,否则下个账号 hydrate 就读回来了。
    expect([...storage.keys()].filter((key) => key.includes('mobileVoiceDictionary'))).toEqual([]);
  });

  it('异常回包被归一化,不会把坏数据塞进润色上下文', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [
        { text: '  ' },
        { text: 'Cindy', frequency: -5, aliases: [{ text: '' }, { text: 'sindy', count: 0 }] },
        null,
        'not-an-object',
      ] as never,
    }));

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([
      { text: 'Cindy', frequency: 1, aliases: [{ text: 'sindy', count: 1 }] },
    ]);
  });
});

describe('账号分区', () => {
  it('不把 v1 未分区缓存导入当前账号,只删除遗留键', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    storage.set(
      'xdt.mobileVoiceDictionary.v1.desktop-1',
      JSON.stringify({
        entries: [{ text: '旧版离线词', frequency: 2 }],
        fetchedAt: 123,
      }),
    );

    await hydrateMobileVoiceDictionary(HOST);

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(storage.has('xdt.mobileVoiceDictionary.v2.user-a.desktop-1')).toBe(false);
    expect(storage.has('xdt.mobileVoiceDictionary.v1.desktop-1')).toBe(false);
  });

  it('匿名分区也不接管 v1 未分区缓存,并清掉遗留键', async () => {
    storage.set(
      'xdt.mobileVoiceDictionary.v1.desktop-1',
      JSON.stringify({ entries: [{ text: '不能泄漏' }], fetchedAt: 123 }),
    );

    await hydrateMobileVoiceDictionary(HOST);

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(storage.has('xdt.mobileVoiceDictionary.v1.desktop-1')).toBe(false);
  });

  it('切换账号后读不到上一个账号的快照 —— 即使清理没删干净', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '内部项目代号' }],
    }));
    expect(readCachedMobileVoiceDictionary(HOST)).toHaveLength(1);

    // 故意不调用清理:模拟索引读失败等「没删干净」的现实情况。
    setMobileVoiceDictionaryAccountScope('user-b');
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);

    // 切回去仍然读得到自己的那份(分区而不是丢弃)。
    setMobileVoiceDictionaryAccountScope('user-a');
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('内部项目代号');
  });

  it('索引读不出来时不删索引 —— 否则剩下的快照永远清不掉', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    await refreshMobileVoiceDictionary(HOST, async () => ({ ok: true, entries: [{ text: 'Cindy' }] }));
    // 索引损坏。
    storage.set('xdt.mobileVoiceDictionary.v2.hosts', '{not json');

    await clearAllMobileVoiceDictionaryCaches();
    expect(storage.get('xdt.mobileVoiceDictionary.v2.hosts')).toBe('{not json');
  });
});

describe('登出清理与分区切换的时序', () => {
  it('分区已被切回匿名之后再清理,仍能删掉登出账号的快照', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '内部项目代号' }],
    }));
    expect([...storage.keys()].some((key) => key.includes('user-a'))).toBe(true);

    // AuthContext 的实际顺序:先切分区(applyUser(null)),清理才异步跑起来。
    setMobileVoiceDictionaryAccountScope('');
    await clearAllMobileVoiceDictionaryCaches();

    expect([...storage.keys()].filter((key) => key.includes('mobileVoiceDictionary'))).toEqual([]);
  });
});

describe('账号切走之后落地的旧请求', () => {
  it('写进自己那个分区,不落到新账号的键上', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const inFlight = refreshMobileVoiceDictionary(HOST, () => pending);

    // 请求还在飞,用户切到了另一个账号。
    setMobileVoiceDictionaryAccountScope('user-b');
    release({ ok: true, entries: [{ text: '账号A的词' }] });
    await inFlight;

    // 不该出现在 user-b 的分区里。
    expect([...storage.keys()].some((key) => key.includes('user-b'))).toBe(false);
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });

  it('过期任务的补偿删除不会删掉新账号已经提交的快照', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const stale = refreshMobileVoiceDictionary(HOST, () => pending);

    // 切到 user-b 并且它已经为同一台电脑写好了快照。
    setMobileVoiceDictionaryAccountScope('user-b');
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '账号B的词' }],
    }));
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');

    // user-a 的请求现在才落地,它的自我回收只能删自己那份。
    release({ ok: true, entries: [{ text: '账号A的词' }] });
    await stale;

    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');
    // 盘上也还在 —— 否则重启或内存失效后 user-b 的词典就空了。
    __resetMobileVoiceDictionaryCacheForTests();
    setMobileVoiceDictionaryAccountScope('user-b');
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');
  });

  it('旧账号落盘补偿不删新账号已接收的同 host 快照', async () => {
    persistGate.delaySnapshotWrites = true;
    setMobileVoiceDictionaryAccountScope('user-a');
    const older = applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '账号A的词' }],
      emittedAt: 1_000,
    });
    await Promise.resolve();
    setMobileVoiceDictionaryAccountScope('user-b');
    persistGate.delaySnapshotWrites = false;
    const newer = applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '账号B的词' }],
      emittedAt: 2_000,
    });
    releaseSnapshotWrites();
    await Promise.all([older, newer]);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');
    __resetMobileVoiceDictionaryCacheForTests();
    setMobileVoiceDictionaryAccountScope('user-b');
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');
  });
});

describe('在途请求的去重范围', () => {
  it('新账号的刷新不会等在上一个账号那个必被丢弃的请求上', async () => {
    setMobileVoiceDictionaryAccountScope('user-a');
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const stale = refreshMobileVoiceDictionary(HOST, () => pending);
    // 让 user-a 的任务真正登记进在途表(它挂在 fetchSnapshot 上)。
    await Promise.resolve();

    setMobileVoiceDictionaryAccountScope('user-b');
    // 这一步以前会死等 user-a 的请求 —— 而那份响应按代际检查注定被丢弃。
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '账号B的词' }],
    }));
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');

    release({ ok: true, entries: [{ text: '账号A的词' }] });
    await stale;
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('账号B的词');
  });
});

describe('版本向量的入站校验', () => {
  const STAMP_A = '0000000rs4.0000.node-a';

  it('非规范 HLC 的时间戳被丢掉,不会在字典序比较里永远胜出', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Cindy' }],
      stateVector: { 'node-a': '~~~~', 'node-b': 42, 'node-c': '' },
    } as never));

    // 整份向量都不可用 → 当作「没有向量」,退回按拉取时间比较。
    expect(readCachedMobileVoiceDictionarySnapshot(HOST).stateVector).toBeUndefined();
  });

  it('时间戳自带的 nodeId 与键对不上时丢弃该项', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Cindy' }],
      stateVector: { 'node-a': STAMP_A, 'node-b': STAMP_A },
    }));

    const vector = readCachedMobileVoiceDictionarySnapshot(HOST).stateVector;
    expect(vector && Object.keys(vector)).toEqual(['node-a']);
  });

  it('合法向量原样保留并能落盘恢复', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Cindy' }],
      stateVector: { 'node-a': STAMP_A },
    }));
    __resetMobileVoiceDictionaryCacheForTests();
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionarySnapshot(HOST).stateVector).toEqual({ 'node-a': STAMP_A });
  });

  it('后到的旧快照不能覆盖已有的更新状态', async () => {
    const newer = '0000000rt0.0000.node-a';
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '新词' }],
      stateVector: { 'node-a': newer },
    });
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '旧词' }],
      stateVector: { 'node-a': STAMP_A },
    });
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('新词');
  });

  it('不带 emittedAt 的同代拉取不能盖掉已有 push', async () => {
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '推送词' }],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 1_000,
    });
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '拉取词' }],
      stateVector: { 'node-a': STAMP_A },
    });
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('推送词');
  });

  it('后到的无向量空投影不能清掉已有的更新快照', async () => {
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '新词' }],
      stateVector: { 'node-a': STAMP_A },
    });
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [],
    });
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('新词');
  });

  it('带同一代版本向量且更晚发出的空投影可以清空缓存', async () => {
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '旧词' }],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 1_000,
    });
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 2_000,
    });
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });

  it('并发落盘时较旧写入不能覆盖磁盘上的新快照', async () => {
    persistGate.delaySnapshotWrites = true;
    const older = applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '旧词' }],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 1_000,
    });
    await Promise.resolve();
    const newer = applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '新词' }],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 2_000,
    });
    await Promise.resolve();
    persistGate.delaySnapshotWrites = false;
    releaseSnapshotWrites();
    await Promise.all([older, newer]);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('新词');
    __resetMobileVoiceDictionaryCacheForTests();
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('新词');
  });

  it('更早发出的词表不能盖掉已清空的同一代投影', async () => {
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 2_000,
    });
    await applyMobileVoiceDictionarySnapshot(HOST, {
      ok: true,
      entries: [{ text: '旧词' }],
      stateVector: { 'node-a': STAMP_A },
      emittedAt: 1_000,
    });
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });
});

describe('缓存订阅隔离', () => {
  it('订阅者抛错不打断落盘', async () => {
    const unsubscribe = subscribeMobileVoiceDictionaryCache(() => {
      throw new Error('subscriber failed');
    });
    try {
      await expect(applyMobileVoiceDictionarySnapshot(HOST, {
        ok: true,
        entries: [{ text: '推送词', frequency: 1 }],
      })).resolves.toBeUndefined();
      expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('推送词');
      __resetMobileVoiceDictionaryCacheForTests();
      await hydrateMobileVoiceDictionary(HOST);
      expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('推送词');
    } finally {
      unsubscribe();
    }
  });
});

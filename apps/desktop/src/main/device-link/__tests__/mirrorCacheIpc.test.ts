/**
 * mirrorCacheIpc.test.ts —— 镜像冷缓存 IPC handler 的入参校验与裁剪。
 *
 * IPC payload 一律不可信:缺 id / 非数组要确定性拒掉(而不是把垃圾写进缓存目录);
 * 数组长度、单条字节、总字节、结构深度与节点数都要在 main 侧就地卡住(只限长度挡不住
 * 「一条里塞任意大字符串」)。`clear` 只接受非空 deviceId、绝不触发整体清,也在这里钉住。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/cindy-mirror-cache-test/app',
    getPath: () => '/tmp/cindy-mirror-cache-test',
    getVersion: () => '0.0.0-test',
  },
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../mirrorCachePurgeQueue', () => ({
  enqueuePurge: vi.fn(async () => undefined),
  hasPendingPurgeRecords: async (): Promise<boolean> => {
    purgeChecks += 1;
    onPurgeCheck?.(purgeChecks);
    return pendingPurges > 0;
  },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: (): string => `cloud:${ownerKey}:${ownerGeneration}`,
  ownerScopedUserDataPath: (...parts: string[]): string =>
    ['/data/owners', ownerKey, ...parts].join('/'),
}));

import {
  handleMirrorCacheClear,
  handleMirrorCacheGetMessages,
  handleMirrorCacheGetSessionList,
  handleMirrorCachePutMessages,
  handleMirrorCachePutSessionList,
} from '../ipc';
import { MirrorCachePurgeError, type MirrorCache } from '../mirrorCacheStore';

function fakeCache() {
  return {
    readMessages: vi.fn(async () => [{ id: 'm1' }]),
    readMessagesWithInvalidation: vi.fn(async () => ({
      messages: [{ id: 'm1' }],
      invalidation: 3,
      ownerRoot: '/data/owners/owner-a/device-link-mirror-cache',
      accountCounter: 0,
    })),
    writeMessages: vi.fn(async () => ({ invalidation: 3 })),
    readSessionList: vi.fn(async () => [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }]),
    readSessionListWithInvalidation: vi.fn(async () => ({
      devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
      ownerRoot: '/data/owners/owner-a/device-link-mirror-cache',
      accountCounter: 0,
    })),
    writeSessionList: vi.fn(async () => undefined),
    clearDevice: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
  } satisfies Record<keyof MirrorCache, unknown> as unknown as MirrorCache & {
    readMessages: ReturnType<typeof vi.fn>;
    readMessagesWithInvalidation: ReturnType<typeof vi.fn>;
    writeMessages: ReturnType<typeof vi.fn>;
    readSessionList: ReturnType<typeof vi.fn>;
    readSessionListWithInvalidation: ReturnType<typeof vi.fn>;
    writeSessionList: ReturnType<typeof vi.fn>;
    clearDevice: ReturnType<typeof vi.fn>;
    clearAll: ReturnType<typeof vi.fn>;
  };
}

let cache: ReturnType<typeof fakeCache>;
/** 由 mock 的 pendingPurgeCount 读取:>0 表示队列里还有删不掉的东西。 */
let pendingPurges = 0;
let purgeChecks = 0;
let onPurgeCheck: ((call: number) => void) | null = null;
/** 由 mock 的 appSessionState 读取:模拟账号边界推进(owner / generation 变化)。 */
let ownerKey = 'owner-a';
let ownerGeneration = 1;

beforeEach(() => {
  cache = fakeCache();
  pendingPurges = 0;
  purgeChecks = 0;
  onPurgeCheck = null;
  ownerKey = 'owner-a';
  ownerGeneration = 1;
});

describe('messages get / put', () => {
  it('读:只向 renderer 返回 opaque owner token,不暴露 store 绝对路径', async () => {
    const result = await handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1');
    expect(result).toEqual({
      messages: [{ id: 'm1' }],
      invalidation: 3,
      ownerToken: expect.any(String),
      accountCounter: 0,
    });
    expect(result.ownerToken).not.toContain('/');
    expect(result.ownerToken).not.toBe('/data/owners/owner-a/device-link-mirror-cache');
    expect(cache.readMessagesWithInvalidation).toHaveBeenCalledWith('dev-1', 'sess-1');
  });

  it('缺 deviceId / sessionId → INVALID_PARAMS,不碰 store', async () => {
    await expect(handleMirrorCacheGetMessages(cache, '', 'sess-1')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(handleMirrorCachePutMessages(cache, 'dev-1', undefined, [])).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    expect(cache.readMessagesWithInvalidation).not.toHaveBeenCalled();
    expect(cache.writeMessages).not.toHaveBeenCalled();
  });

  it('messages 非数组 → INVALID_PARAMS', async () => {
    await expect(
      handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', { nope: true }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(cache.writeMessages).not.toHaveBeenCalled();
  });

  it('超量数组在 main 侧截断到上限,且保留最新的那批(页是 newest-first → 取前 N)', async () => {
    const rows = Array.from({ length: 900 }, (_, i) => ({ id: `m${i}` }));
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', rows);
    const passed = cache.writeMessages.mock.calls[0]?.[2] as Array<{ id: string }>;
    expect(passed.length).toBe(500);
    expect(passed[0]?.id).toBe('m0');
    expect(passed.at(-1)?.id).toBe('m499');
  });

  it('空数组照常透传(空 = 清掉该条缓存,是有意义的写)', async () => {
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', []);
    expect(cache.writeMessages).toHaveBeenCalledWith(
      'dev-1',
      'sess-1',
      [],
      undefined,
      undefined,
      undefined,
    );
  });

  it('作废计数 / 账号代际只接受非负整数,opaque token 验证后才还原内部 root', async () => {
    const { ownerToken } = await handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1');
    const owner = '/data/owners/owner-a/device-link-mirror-cache';
    for (const [invalidation, account] of [
      [-1, -1],
      [1.5, 2.5],
      [Number.NaN, Number.POSITIVE_INFINITY],
    ]) {
      cache.writeMessages.mockClear();
      await handleMirrorCachePutMessages(
        cache,
        'dev-1',
        'sess-1',
        [{ id: 'm1' }],
        undefined,
        invalidation,
        ownerToken,
        account,
      );
      expect(cache.writeMessages).toHaveBeenCalledWith(
        'dev-1',
        'sess-1',
        [{ id: 'm1' }],
        undefined,
        owner,
        undefined,
      );
    }

    cache.writeMessages.mockClear();
    await handleMirrorCachePutMessages(
      cache,
      'dev-1',
      'sess-1',
      [{ id: 'm1' }],
      undefined,
      7,
      ownerToken,
      3,
    );
    expect(cache.writeMessages).toHaveBeenCalledWith(
      'dev-1',
      'sess-1',
      [{ id: 'm1' }],
      7,
      owner,
      3,
    );

    // 绝对路径不是合法 token:即使 renderer 猜到路径也只能落到 fail-closed。
    cache.writeMessages.mockClear();
    await handleMirrorCachePutMessages(
      cache,
      'dev-1',
      'sess-1',
      [{ id: 'm1' }],
      undefined,
      7,
      owner,
      3,
    );
    expect(cache.writeMessages.mock.calls[0]?.[4]).toBeUndefined();
  });
});

describe('payload 有界校验', () => {
  // review(codex P1):只限数组长度挡不住「一条消息里塞任意大字符串 / 深嵌套」——
  // main 会先遍历 + 反复 stringify 才撞上 512KB 输出上限,那时内存已经吃进去了。
  it('单条超字节上限 → 丢弃那一条,其余照常写入', async () => {
    const fat = { id: 'fat', clientId: 'c-fat', content: 'x'.repeat(600 * 1024) };
    const slim = { id: 'slim', clientId: 'c-slim', content: 'ok' };
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [fat, slim]);
    const passed = cache.writeMessages.mock.calls[0]?.[2] as Array<{ id: string }>;
    expect(passed.map((m) => m.id)).toEqual(['slim']);
  });

  it('整批超总字节预算 → 到顶即停,不继续吃后面的条目', async () => {
    // 每条 ~400KB,总预算 4MB → 大约 10 条封顶
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      clientId: `c-${i}`,
      content: 'y'.repeat(400 * 1024),
    }));
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', items);
    const passed = cache.writeMessages.mock.calls[0]?.[2] as unknown[];
    expect(passed.length).toBeGreaterThan(0);
    expect(passed.length).toBeLessThan(items.length);
  });

  it('病态深嵌套 → 在序列化之前就被丢掉', async () => {
    let deep: Record<string, unknown> = { id: 'deep', clientId: 'c-deep' };
    for (let i = 0; i < 200; i += 1) deep = { id: 'deep', clientId: 'c-deep', nested: deep };
    const slim = { id: 'slim', clientId: 'c-slim', content: 'ok' };
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [deep, slim]);
    const passed = cache.writeMessages.mock.calls[0]?.[2] as Array<{ id: string }>;
    expect(passed.map((m) => m.id)).toEqual(['slim']);
  });

  it('超宽对象(节点数爆炸)同样被丢掉', async () => {
    const wide: Record<string, unknown> = { id: 'wide', clientId: 'c-wide' };
    for (let i = 0; i < 30_000; i += 1) wide[`k${i}`] = i;
    await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [wide]);
    expect(cache.writeMessages.mock.calls[0]?.[2]).toEqual([]);
  });

  it('循环引用不会让 handler 抛错(丢弃那条即可)', async () => {
    const cyclic: Record<string, unknown> = { id: 'cyc', clientId: 'c-cyc' };
    cyclic.self = cyclic;
    await expect(handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [cyclic])).resolves.toEqual(
      { ok: true, invalidation: 3 },
    );
    expect(cache.writeMessages.mock.calls[0]?.[2]).toEqual([]);
  });

  // review(codex P1):`devices.map(...)` 必须在外层截断**之后**跑 —— 否则一次超长数组会让
  // main 同步遍历全量并再分配一份等长新数组,64 台的上限要等 boundedItems 才生效。
  // 用「上限之外的元素一旦被读 sessions 就抛」把顺序钉死。
  it('外层设备数组先截断再 map:上限之外的元素完全不被触碰', async () => {
    const devices: unknown[] = Array.from({ length: 64 }, (_, i) => ({
      deviceId: `dev-${i}`,
      deviceName: `d${i}`,
      sessions: [],
    }));
    for (let i = 0; i < 500; i += 1) {
      devices.push({
        deviceId: `overflow-${i}`,
        get sessions(): unknown[] {
          throw new Error('must not touch devices beyond the cap');
        },
      });
    }
    await expect(handleMirrorCachePutSessionList(cache, devices)).resolves.toEqual({ ok: true });
    expect((cache.writeSessionList.mock.calls[0]?.[0] as unknown[]).length).toBe(64);
  });

  it('每台设备的 sessions 数组也被截断(设备数不多但某台带几十万会话)', async () => {
    const devices = [
      {
        deviceId: 'dev-1',
        deviceName: 'Mac',
        sessions: Array.from({ length: 5_000 }, (_, i) => ({ id: `s${i}`, status: 'active' })),
      },
    ];
    await handleMirrorCachePutSessionList(cache, devices);
    const passed = cache.writeSessionList.mock.calls[0]?.[0] as Array<{ sessions: unknown[] }>;
    expect(passed[0].sessions.length).toBe(500);
  });
});

describe('待清未清时读路径不命中', () => {
  // review(codex P1):drain 是 best-effort,可能返回 pending > 0(某个文件删不掉)。那份内容
  // 还在盘上,照读就把本该消失的正文交回 renderer —— 而 renderer 画上去就收不回了。
  it('purge 队列仍有待清条目 → 读消息 / 读列表都返回空,不碰 store', async () => {
    pendingPurges = 1;
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({ devices: [] });
    expect(cache.readMessagesWithInvalidation).not.toHaveBeenCalled();
    expect(cache.readSessionList).not.toHaveBeenCalled();
  });

  it('队列干净 → 照常命中', async () => {
    pendingPurges = 0;
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [{ id: 'm1' }],
      invalidation: 3,
      ownerToken: expect.any(String),
      accountCounter: 0,
    });
  });
});

describe('标量体积在序列化之前就被卡住', () => {
  // review(codex P1):结构预检把一个超大字符串只算作**一个节点**,于是 JSON.stringify 要先
  // 把整份分配 + 走完才撞上 512KB 上限 —— 那时内存已经吃进去了。
  it('单条里的超大字符串被丢弃(不进序列化)', async () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      const fat = { id: 'fat', clientId: 'c-fat', content: 'x'.repeat(2 * 1024 * 1024) };
      const slim = { id: 'slim', clientId: 'c-slim', content: 'ok' };
      await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [fat, slim]);
      const passed = cache.writeMessages.mock.calls[0]?.[2] as Array<{ id: string }>;
      expect(passed.map((m) => m.id)).toEqual(['slim']);
      // 那条超大项从未被 stringify 过(只有 slim 会)。
      const stringified = stringifySpy.mock.calls.map(([arg]) => arg);
      expect(stringified).not.toContain(fat);
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('超长键名同样计入预算,且同样不进序列化', async () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      const wideKey: Record<string, unknown> = { id: 'k', clientId: 'c-k' };
      wideKey['k'.repeat(2 * 1024 * 1024)] = 1;
      await handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [wideKey]);
      expect(cache.writeMessages.mock.calls[0]?.[2]).toEqual([]);
      expect(stringifySpy.mock.calls.map(([arg]) => arg)).not.toContain(wideKey);
    } finally {
      stringifySpy.mockRestore();
    }
  });
});

describe('读完成之后又有待清记录', () => {
  // review(codex P1):预检之后、读完成之前另一个实例可能刚登记待清 —— 那份正文已经被标记
  // 为"必须删掉",不能再交出去。
  it('读期间被登记待清 → 丢弃结果', async () => {
    cache.readMessagesWithInvalidation.mockImplementationOnce(async () => {
      pendingPurges = 1; // 读的过程中有人登记了待清
      return { messages: [{ id: 'm1' }], invalidation: 3 };
    });
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });
  });

  it('读列表期间被登记待清 → 丢弃结果', async () => {
    cache.readSessionListWithInvalidation.mockImplementationOnce(async () => {
      pendingPurges = 1;
      return {
        devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
        ownerRoot: '/data/owners/owner-a/device-link-mirror-cache',
        accountCounter: 0,
      };
    });
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({ devices: [] });
  });
});

describe('读期间账号边界推进', () => {
  // review(codex P1):闸门等待 / 文件读期间账号边界可能已经走完 —— 那时返回的既可能是上一个
  // 账号的明文,也可能是新账号的快照被交给旧账号发起的那次请求。
  it('读消息期间 owner 变了 → 丢弃结果,返回空', async () => {
    cache.readMessagesWithInvalidation.mockImplementationOnce(async () => {
      ownerKey = 'owner-b'; // 读的过程中账号边界推进
      return { messages: [{ id: 'm1' }], invalidation: 3 };
    });
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });
  });

  it('读列表期间 owner 变了 → 丢弃结果,返回空', async () => {
    cache.readSessionListWithInvalidation.mockImplementationOnce(async () => {
      ownerKey = 'owner-b';
      return {
        devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
        ownerRoot: '/data/owners/owner-b/device-link-mirror-cache',
        accountCounter: 0,
      };
    });
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({ devices: [] });
  });

  it('最终 purge 检查的 await 期间 A→B → 返回前最后安全门丢弃消息与列表', async () => {
    onPurgeCheck = (call) => {
      if (call === 2) {
        ownerKey = 'owner-b';
        ownerGeneration = 2;
      }
    };
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });

    ownerKey = 'owner-a';
    ownerGeneration = 1;
    purgeChecks = 0;
    onPurgeCheck = (call) => {
      if (call === 2) {
        ownerKey = 'owner-b';
        ownerGeneration = 2;
      }
    };
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({ devices: [] });
  });

  it('最终 purge 检查期间 A→B→A:root 相同但 generation 已变 → 仍丢弃', async () => {
    onPurgeCheck = (call) => {
      if (call === 2) {
        ownerKey = 'owner-b';
        ownerGeneration = 2;
        ownerKey = 'owner-a';
        ownerGeneration = 3;
      }
    };
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });
  });

  it('A→B→A ABA:首尾 root 相同但 store 读自 B root → 消息与列表都丢弃', async () => {
    cache.readMessagesWithInvalidation.mockImplementationOnce(async () => {
      ownerKey = 'owner-b';
      const result = {
        messages: [{ id: 'secret-b' }],
        invalidation: 3,
        ownerRoot: '/data/owners/owner-b/device-link-mirror-cache',
        accountCounter: 0,
      };
      ownerKey = 'owner-a';
      return result;
    });
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [],
    });

    cache.readSessionListWithInvalidation.mockImplementationOnce(async () => {
      ownerKey = 'owner-b';
      const result = {
        devices: [{ deviceId: 'dev-b', deviceName: 'Bob Mac', sessions: [] }],
        ownerRoot: '/data/owners/owner-b/device-link-mirror-cache',
        accountCounter: 0,
      };
      ownerKey = 'owner-a';
      return result;
    });
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({ devices: [] });
  });

  it('owner 没变 → 照常返回(并带回 opaque token / 账号代际供回写比对)', async () => {
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({
      devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
      ownerToken: expect.any(String),
      accountCounter: 0,
    });
  });
});

describe('标量 id 长度上界', () => {
  // review(codex P1):数组与单条字节预算管不到标量字段,而 store 会对**完整字符串**做
  // trim + 正则改写 + sha256(同步)—— 一次调用就能拖住 main。
  it('超长 deviceId / sessionId → INVALID_PARAMS,不碰 store', async () => {
    const long = 'x'.repeat(300);
    await expect(handleMirrorCacheGetMessages(cache, long, 'sess-1')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(handleMirrorCachePutMessages(cache, 'dev-1', long, [])).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(handleMirrorCacheClear(cache, long)).rejects.toThrow(/INVALID_PARAMS/);
    expect(cache.readMessagesWithInvalidation).not.toHaveBeenCalled();
    expect(cache.writeMessages).not.toHaveBeenCalled();
    expect(cache.clearDevice).not.toHaveBeenCalled();
  });

  it('正常长度的 id 照常放行', async () => {
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toBeTruthy();
  });
});

describe('清理失败登记重试', () => {
  it('空写删除失败 → 登记进 purge 队列,IPC 仍返回 ok', async () => {
    const stuck = ['/data/owners/x/device-link-mirror-cache/messages/a.json'];
    cache.writeMessages.mockRejectedValueOnce(
      new MirrorCachePurgeError('/data/owners/x/device-link-mirror-cache', stuck, null),
    );
    const enqueue = vi.fn(async () => undefined);

    await expect(
      handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [], enqueue),
    ).resolves.toEqual({ ok: true });

    // 第三、四个参数是待补自增的作废屏障 key 与待退役的墓碑 scope(见 MirrorCachePurgeError);
    // 这些用例造的错误两者都没带,于是传空数组。
    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck, [], []);
  });

  it('列表快照的删除类失败 → 登记进 purge 队列,IPC 仍返回 ok', async () => {
    const stuck = ['/data/owners/x/device-link-mirror-cache/session-list.json'];
    cache.writeSessionList.mockRejectedValueOnce(
      new MirrorCachePurgeError('/data/owners/x/device-link-mirror-cache', stuck, null),
    );
    const enqueue = vi.fn(async () => undefined);

    await expect(handleMirrorCachePutSessionList(cache, [], enqueue)).resolves.toEqual({
      ok: true,
    });

    // 第三、四个参数是待补自增的作废屏障 key 与待退役的墓碑 scope(见 MirrorCachePurgeError);
    // 这些用例造的错误两者都没带,于是传空数组。
    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck, [], []);
  });

  it('写入的非 purge 类错误照常抛出', async () => {
    cache.writeMessages.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(
      handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [], async () => undefined),
    ).rejects.toThrow(/disk on fire/);
  });
});

describe('session list get / put', () => {
  it('读:包成 { devices } 并只带 opaque owner token / 账号代际', async () => {
    const result = await handleMirrorCacheGetSessionList(cache);
    expect(result).toEqual({
      devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
      ownerToken: expect.any(String),
      accountCounter: 0,
    });
    expect(result.ownerToken).not.toContain('/');
  });

  it('devices 非数组 → INVALID_PARAMS', async () => {
    await expect(handleMirrorCachePutSessionList(cache, 'nope')).rejects.toThrow(/INVALID_PARAMS/);
    expect(cache.writeSessionList).not.toHaveBeenCalled();
  });

  it('超量设备数组截断到上限', async () => {
    const devices = Array.from({ length: 100 }, (_, i) => ({
      deviceId: `dev-${i}`,
      deviceName: `d${i}`,
      sessions: [],
    }));
    await handleMirrorCachePutSessionList(cache, devices);
    expect((cache.writeSessionList.mock.calls[0]?.[0] as unknown[]).length).toBe(64);
  });

  it('列表账号代际只接受非负整数,opaque token 验证后才还原内部 root', async () => {
    const devices = [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }];
    const { ownerToken } = await handleMirrorCacheGetSessionList(cache);
    const owner = '/data/owners/owner-a/device-link-mirror-cache';
    for (const account of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      cache.writeSessionList.mockClear();
      await handleMirrorCachePutSessionList(cache, devices, undefined, ownerToken, account);
      expect(cache.writeSessionList).toHaveBeenCalledWith(devices, owner, undefined);
    }

    cache.writeSessionList.mockClear();
    await handleMirrorCachePutSessionList(cache, devices, undefined, ownerToken, 3);
    expect(cache.writeSessionList).toHaveBeenCalledWith(devices, owner, 3);
  });
});

describe('clear', () => {
  it('带 deviceId → 只清那台设备', async () => {
    await handleMirrorCacheClear(cache, 'dev-1');
    expect(cache.clearDevice).toHaveBeenCalledWith('dev-1');
    expect(cache.clearAll).not.toHaveBeenCalled();
  });

  // review(codex P1):缺 deviceId 曾被当成「清整个 owner 缓存」的授权。renderer 没有任何
  // 合法的无参调用方(登出是 main 内部直接调 clearAll),这个入口不该带那种破坏力。
  it('缺 deviceId / 空白 / 非字符串 → INVALID_PARAMS,且绝不触发整体清', async () => {
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      await expect(handleMirrorCacheClear(cache, bad)).rejects.toThrow(/INVALID_PARAMS/);
    }
    expect(cache.clearAll).not.toHaveBeenCalled();
    expect(cache.clearDevice).not.toHaveBeenCalled();
  });

  // review(codex P1):renderer 侧的清理是 fire-and-forget,没人重试 —— 文件删不掉时
  // 必须由 main 登记到 purge 队列,否则被撤销对端的正文留到本账号生命周期结束。
  it('文件删不掉时把失败路径登记进重试队列,并照常返回 ok', async () => {
    const stuck = ['/data/owners/x/device-link-mirror-cache/messages/a.json'];
    cache.clearDevice.mockRejectedValueOnce(
      new MirrorCachePurgeError('/data/owners/x/device-link-mirror-cache', stuck, null),
    );
    const enqueue = vi.fn(async () => undefined);

    await expect(handleMirrorCacheClear(cache, 'dev-1', enqueue)).resolves.toEqual({ ok: true });

    // 第三、四个参数是待补自增的作废屏障 key 与待退役的墓碑 scope(见 MirrorCachePurgeError);
    // 这些用例造的错误两者都没带,于是传空数组。
    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck, [], []);
  });

  it('登记重试本身失败也不让 IPC 失败(已记 error,清理是 best-effort)', async () => {
    cache.clearDevice.mockRejectedValueOnce(
      new MirrorCachePurgeError('/data/owners/x', ['/a'], null),
    );
    const enqueue = vi.fn(async () => {
      throw new Error('userData read-only');
    });
    await expect(handleMirrorCacheClear(cache, 'dev-1', enqueue)).resolves.toEqual({ ok: true });
  });

  it('非 purge 类错误照常抛出(不被误当成"已登记重试")', async () => {
    cache.clearDevice.mockRejectedValueOnce(new Error('boom'));
    await expect(handleMirrorCacheClear(cache, 'dev-1', async () => undefined)).rejects.toThrow(
      /boom/,
    );
  });
});

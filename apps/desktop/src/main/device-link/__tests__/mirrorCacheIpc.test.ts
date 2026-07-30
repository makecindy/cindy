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
    writeMessages: vi.fn(async () => undefined),
    readSessionList: vi.fn(async () => [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }]),
    writeSessionList: vi.fn(async () => undefined),
    clearDevice: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
  } satisfies Record<keyof MirrorCache, unknown> as unknown as MirrorCache & {
    readMessages: ReturnType<typeof vi.fn>;
    writeMessages: ReturnType<typeof vi.fn>;
    readSessionList: ReturnType<typeof vi.fn>;
    writeSessionList: ReturnType<typeof vi.fn>;
    clearDevice: ReturnType<typeof vi.fn>;
    clearAll: ReturnType<typeof vi.fn>;
  };
}

let cache: ReturnType<typeof fakeCache>;

beforeEach(() => {
  cache = fakeCache();
});

describe('messages get / put', () => {
  it('读:转发给 store 并包成 { messages }', async () => {
    await expect(handleMirrorCacheGetMessages(cache, 'dev-1', 'sess-1')).resolves.toEqual({
      messages: [{ id: 'm1' }],
    });
    expect(cache.readMessages).toHaveBeenCalledWith('dev-1', 'sess-1');
  });

  it('缺 deviceId / sessionId → INVALID_PARAMS,不碰 store', async () => {
    await expect(handleMirrorCacheGetMessages(cache, '', 'sess-1')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    await expect(handleMirrorCachePutMessages(cache, 'dev-1', undefined, [])).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    expect(cache.readMessages).not.toHaveBeenCalled();
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
    expect(cache.writeMessages).toHaveBeenCalledWith('dev-1', 'sess-1', []);
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
    await expect(
      handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [cyclic]),
    ).resolves.toEqual({ ok: true });
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
    expect(cache.readMessages).not.toHaveBeenCalled();
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

    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck);
  });

  it('列表快照的删除类失败 → 登记进 purge 队列,IPC 仍返回 ok', async () => {
    const stuck = ['/data/owners/x/device-link-mirror-cache/session-list.json'];
    cache.writeSessionList.mockRejectedValueOnce(
      new MirrorCachePurgeError('/data/owners/x/device-link-mirror-cache', stuck, null),
    );
    const enqueue = vi.fn(async () => undefined);

    await expect(handleMirrorCachePutSessionList(cache, [], enqueue)).resolves.toEqual({ ok: true });

    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck);
  });

  it('写入的非 purge 类错误照常抛出', async () => {
    cache.writeMessages.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(
      handleMirrorCachePutMessages(cache, 'dev-1', 'sess-1', [], async () => undefined),
    ).rejects.toThrow(/disk on fire/);
  });
});

describe('session list get / put', () => {
  it('读:包成 { devices }', async () => {
    await expect(handleMirrorCacheGetSessionList(cache)).resolves.toEqual({
      devices: [{ deviceId: 'dev-1', deviceName: 'Mac', sessions: [] }],
    });
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

    expect(enqueue).toHaveBeenCalledWith('/data/owners/x/device-link-mirror-cache', stuck);
  });

  it('登记重试本身失败也不让 IPC 失败(已记 error,清理是 best-effort)', async () => {
    cache.clearDevice.mockRejectedValueOnce(new MirrorCachePurgeError('/data/owners/x', ['/a'], null));
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

/**
 * mirrorCacheIpc.test.ts —— 镜像冷缓存 IPC handler 的入参校验与裁剪。
 *
 * IPC payload 一律不可信:缺 id / 非数组要确定性拒掉(而不是把垃圾写进缓存目录),
 * 超量数组要在 main 侧就地截断。clear 的语义分叉(带 deviceId = 单设备,不带 = 整体)
 * 也在这里钉住 —— 登出清理依赖后者。
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
import type { MirrorCache } from '../mirrorCacheStore';

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
});

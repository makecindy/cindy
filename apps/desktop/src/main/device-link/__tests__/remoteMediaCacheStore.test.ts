/**
 * remoteMediaCacheStore.test.ts — 控制端入方向媒体内存缓存:命中/未命中、LRU 逐出、stream TTL 清理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const removeRemote = vi.hoisted(() => vi.fn(async () => {}));
const owner = vi.hoisted(() => ({ key: 'owner:1' }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => owner.key }));
vi.mock('../mediaTransfer', () => ({ removeRemote }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  lookup,
  recordLocal,
  recordStream,
  retainStream,
  releaseStream,
  sweepIdleStreams,
  __resetForTests,
  __testing,
} from '../remoteMediaCacheStore';

const D = 'dev-1';

beforeEach(() => {
  owner.key = 'owner:1';
  __resetForTests();
  removeRemote.mockClear();
});

describe('lookup / record', () => {
  it('does not reuse warm bytes across account generations', () => {
    recordLocal(D, 'xdt-image://s/a.png', Buffer.from('private'), 'image/png');
    owner.key = 'other:2';
    expect(lookup(D, 'xdt-image://s/a.png')).toBeUndefined();
    owner.key = 'owner:3';
    expect(lookup(D, 'xdt-image://s/a.png')).toBeUndefined();
  });
  it('recordLocal 后 lookup 命中(同 key),不同 origUrl 不串', () => {
    recordLocal(D, 'xdt-image://s/a.png', Buffer.from([1, 2, 3]), 'image/png');
    const e = lookup(D, 'xdt-image://s/a.png');
    expect(e).toMatchObject({ kind: 'local', mimeType: 'image/png', size: 3 });
    expect(lookup(D, 'xdt-image://s/b.png')).toBeUndefined();
    expect(lookup('dev-2', 'xdt-image://s/a.png')).toBeUndefined();
  });

  it('recordStream 后 lookup 命中,只记 ossKey 不持字节', () => {
    recordStream(D, 'xdt-video://s/v.mp4', 'oss/k.mp4', 'video/mp4', 9999);
    expect(lookup(D, 'xdt-video://s/v.mp4')).toMatchObject({
      kind: 'stream',
      ossKey: 'oss/k.mp4',
      mimeType: 'video/mp4',
      size: 9999,
    });
  });

  it('lookup 刷新 lastAccess', () => {
    const e = recordStream(D, 'u', 'k', 'video/mp4', 1);
    e.lastAccess = 1;
    lookup(D, 'u');
    expect(e.lastAccess).toBeGreaterThan(1);
  });
});

describe('LRU 逐出(按 lastAccess 从旧到新)', () => {
  it('总字节超 cap → 逐出最旧的 local', () => {
    __testing.setLocalCap(10);
    const a = recordLocal(D, 'u1', Buffer.alloc(5), 'image/png');
    const b = recordLocal(D, 'u2', Buffer.alloc(5), 'image/png'); // 总 10,未超
    a.lastAccess = 100; // u1 最旧
    b.lastAccess = 200;
    recordLocal(D, 'u3', Buffer.alloc(5), 'image/png'); // 总 15 → 逐出 u1
    expect(lookup(D, 'u1')).toBeUndefined();
    expect(lookup(D, 'u2')).toBeDefined();
    expect(lookup(D, 'u3')).toBeDefined();
  });
});

describe('stream 数量上限 LRU', () => {
  it('超过 maxStreamEntries → 逐出最旧的 stream + 删其 OSS', () => {
    __testing.setMaxStreamEntries(2);
    const a = recordStream(D, 'u1', 'oss/1', 'video/mp4', 1);
    const b = recordStream(D, 'u2', 'oss/2', 'video/mp4', 1);
    a.lastAccess = 100; // u1 最旧
    b.lastAccess = 200;
    recordStream(D, 'u3', 'oss/3', 'video/mp4', 1); // 总 3 > 2 → 逐出 u1
    expect(lookup(D, 'u1')).toBeUndefined();
    expect(removeRemote).toHaveBeenCalledWith('oss/1');
    expect(lookup(D, 'u2')).toBeDefined();
    expect(lookup(D, 'u3')).toBeDefined();
  });

  it('local 条目不计入 stream 上限', () => {
    __testing.setMaxStreamEntries(1);
    recordLocal(D, 'img1', Buffer.from([1]), 'image/png');
    recordLocal(D, 'img2', Buffer.from([2]), 'image/png');
    recordStream(D, 'v1', 'oss/v1', 'video/mp4', 1);
    expect(lookup(D, 'img1')).toBeDefined();
    expect(lookup(D, 'img2')).toBeDefined();
    expect(lookup(D, 'v1')).toBeDefined();
    expect(removeRemote).not.toHaveBeenCalled();
  });
});

describe('sweepIdleStreams', () => {
  it('空闲超 TTL 的 stream → 删条目 + 删 OSS;未超的保留', async () => {
    const stale = recordStream(D, 'old', 'oss/old', 'video/mp4', 1);
    const fresh = recordStream(D, 'new', 'oss/new', 'video/mp4', 1);
    const now = 10_000_000;
    stale.lastAccess = now - __testing.STREAM_TTL_MS - 1; // 过期
    fresh.lastAccess = now; // 新鲜
    await sweepIdleStreams(now);
    expect(lookup(D, 'old')).toBeUndefined();
    expect(removeRemote).toHaveBeenCalledWith('oss/old');
    expect(lookup(D, 'new')).toBeDefined();
    expect(removeRemote).toHaveBeenCalledTimes(1);
  });

  it('local 条目不被 stream 清理影响', async () => {
    recordLocal(D, 'img', Buffer.from([1]), 'image/png');
    await sweepIdleStreams(Date.now() + 10 ** 12);
    expect(lookup(D, 'img')).toBeDefined();
    expect(removeRemote).not.toHaveBeenCalled();
  });
});

describe('[New-H] in-flight 流不被清理(长播放超 TTL 也不删正在播放的 OSS 对象)', () => {
  it('sweepIdleStreams:inFlight>0 的过期流不删;release 后再 sweep 才删', async () => {
    const e = recordStream(D, 'v', 'oss/v', 'video/mp4', 1);
    const now = 10_000_000;
    e.lastAccess = now - __testing.STREAM_TTL_MS - 1; // 已超 TTL
    retainStream(e); // 正在播放(in-flight)
    await sweepIdleStreams(now);
    expect(lookup(D, 'v')).toBeDefined(); // 不删:仍在播放
    expect(removeRemote).not.toHaveBeenCalled();

    // 播放结束 → release 刷新 lastAccess 到 now;此刻按 now 不再算过期,仍不删。
    releaseStream(e);
    await sweepIdleStreams(e.lastAccess);
    expect(lookup(D, 'v')).toBeDefined();

    // 再过 TTL(已无 in-flight)→ 正常清理。
    await sweepIdleStreams(e.lastAccess + __testing.STREAM_TTL_MS + 1);
    expect(lookup(D, 'v')).toBeUndefined();
    expect(removeRemote).toHaveBeenCalledWith('oss/v');
  });

  it('数量逐出:inFlight>0 的流不参与逐出,即使它最旧', () => {
    __testing.setMaxStreamEntries(2);
    const a = recordStream(D, 'u1', 'oss/1', 'video/mp4', 1);
    a.lastAccess = 100; // 最旧
    retainStream(a); // 但正在播放
    const b = recordStream(D, 'u2', 'oss/2', 'video/mp4', 1);
    b.lastAccess = 200;
    recordStream(D, 'u3', 'oss/3', 'video/mp4', 1); // 3 条 > 2 → 需逐出 1 条
    // a 在播放被跳过 → 逐出次旧的 u2,而非最旧但在播的 u1。
    expect(lookup(D, 'u1')).toBeDefined();
    expect(removeRemote).not.toHaveBeenCalledWith('oss/1');
    expect(lookup(D, 'u2')).toBeUndefined();
    expect(removeRemote).toHaveBeenCalledWith('oss/2');
  });

  it('releaseStream:计数减一并刷新 lastAccess;多并发各自配对', () => {
    const e = recordStream(D, 'v', 'oss/v', 'video/mp4', 1);
    e.lastAccess = 1;
    retainStream(e);
    retainStream(e); // 两个并发 range
    expect(e.inFlight).toBe(2);
    releaseStream(e);
    expect(e.inFlight).toBe(1);
    expect(e.lastAccess).toBeGreaterThan(1);
  });
});

describe('evictEntry', () => {
  it('逐出空闲 stream 条目并删其 OSS 对象;条目不存在视为已逐出', async () => {
    const { evictEntry } = await import('../remoteMediaCacheStore');
    recordStream(D, 'xdt-image://s/big.png', 'oss/big.png', 'image/png', 999);
    expect(evictEntry(D, 'xdt-image://s/big.png')).toBe(true);
    expect(lookup(D, 'xdt-image://s/big.png')).toBeUndefined();
    expect(removeRemote).toHaveBeenCalledWith('oss/big.png');
    expect(evictEntry(D, 'xdt-image://s/big.png')).toBe(true); // 已不存在 → 幂等 true
  });

  it('拒绝逐出仍有 in-flight 响应的 stream 条目(不删正在被观看的对象)', async () => {
    const { evictEntry } = await import('../remoteMediaCacheStore');
    const entry = recordStream(D, 'xdt-image://s/big.png', 'oss/big.png', 'image/png', 999);
    retainStream(entry);
    expect(evictEntry(D, 'xdt-image://s/big.png')).toBe(false);
    expect(lookup(D, 'xdt-image://s/big.png')).toBeDefined();
    expect(removeRemote).not.toHaveBeenCalled();
    releaseStream(entry);
    expect(evictEntry(D, 'xdt-image://s/big.png')).toBe(true); // 消费者走光后可逐出
  });
});

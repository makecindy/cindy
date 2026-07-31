import { describe, expect, it, vi } from 'vitest';
import {
  cacheKeyOf,
  createRemoteMediaDiskCache,
  imageMimeFromUrl,
  type RemoteMediaDiskCacheIO,
} from '@/session/remoteMediaDiskCache';

/** 内存版 IO:files 存字节数,index 存文本;download 大小可编程。 */
function memoryIO(overrides: Partial<RemoteMediaDiskCacheIO> = {}) {
  const files = new Map<string, number>();
  let indexText: string | null = null;
  const io: RemoteMediaDiskCacheIO = {
    ensureDir: vi.fn(),
    readIndexText: vi.fn(async () => indexText),
    writeIndexText: vi.fn((text: string) => {
      indexText = text;
    }),
    fileExists: (name) => files.has(name),
    fileUri: (name) => `file:///cache/remote-media/${name}`,
    deleteFile: vi.fn((name: string) => {
      files.delete(name);
    }),
    download: vi.fn(async (_url: string, name: string) => {
      files.set(name, 1000);
      return 1000;
    }),
    listFiles: () => [...files.keys()],
    ...overrides,
  };
  return { io, files, getIndexText: () => indexText, setIndexText: (t: string | null) => { indexText = t; } };
}

const URL_A = 'xdt-image://cache/a.png';
const URL_B = 'xdt-image://cache/b.png';
const URL_C = 'xdt-image://cache/c.png';

describe('remoteMediaDiskCache', () => {
  it('misses before store, hits with file uri after store, and persists the index', async () => {
    const { io, getIndexText } = memoryIO();
    const cache = createRemoteMediaDiskCache(io);

    expect(await cache.lookup(URL_A)).toBeNull();
    await cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png');
    const hit = await cache.lookup(URL_A);
    expect(hit).toEqual({
      uri: `file:///cache/remote-media/${cacheKeyOf(URL_A)}.png`,
      mimeType: 'image/png',
      size: 1000,
    });
    expect(io.download).toHaveBeenCalledTimes(1);
    expect(getIndexText()).toContain(cacheKeyOf(URL_A));
  });

  it('storeBytes writes inline bytes without network and lookup hits afterwards', async () => {
    const files = new Map<string, number>();
    const writeFileBase64 = vi.fn((name: string, base64: string) => {
      const size = Math.floor((base64.length * 3) / 4);
      files.set(name, size);
      return size;
    });
    const { io } = memoryIO({ writeFileBase64, fileExists: (name) => files.has(name) });
    const cache = createRemoteMediaDiskCache(io);

    await cache.storeBytes(URL_A, 'aGVsbG8sIHdvcmxk', 'image/webp');
    const hit = await cache.lookup(URL_A);
    expect(hit).toMatchObject({
      uri: `file:///cache/remote-media/${cacheKeyOf(URL_A)}.webp`,
      mimeType: 'image/webp',
    });
    expect(io.download).not.toHaveBeenCalled();
    expect(writeFileBase64).toHaveBeenCalledTimes(1);
  });

  it('storeBytes is a silent no-op when IO lacks writeFileBase64 or the write fails', async () => {
    // IO 不支持(memoryIO 默认不带 writeFileBase64):静默跳过。
    const base = memoryIO();
    const cacheNoIo = createRemoteMediaDiskCache(base.io);
    // 返回 false = 本次没写入新字节(见 store 返回值契约)。
    await expect(cacheNoIo.storeBytes(URL_A, 'aGVsbG8=', 'image/webp')).resolves.toBe(false);
    expect(await cacheNoIo.lookup(URL_A)).toBeNull();

    // 写失败(返回 null,契约保证不动现有文件):不登记条目。
    const failing = memoryIO({ writeFileBase64: vi.fn(() => null) });
    const cacheFail = createRemoteMediaDiskCache(failing.io);
    await expect(cacheFail.storeBytes(URL_B, 'aGVsbG8=', 'image/webp')).resolves.toBe(false);
    expect(await cacheFail.lookup(URL_B)).toBeNull();
  });

  it('dedupes concurrent stores only for the identical download url', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const files = new Map<string, number>();
    const { io } = memoryIO({
      download: vi.fn(async (_url: string, name: string) => {
        await gate;
        files.set(name, 500);
        return 500;
      }),
      fileExists: (name) => files.has(name),
    });
    const cache = createRemoteMediaDiskCache(io);

    const p1 = cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png');
    const p2 = cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png');
    release();
    await Promise.all([p1, p2]);
    expect(io.download).toHaveBeenCalledTimes(1);
  });

  it('queues a refreshed download url after a failing stale pending instead of coalescing', async () => {
    let failStale: (e: Error) => void = () => {};
    const staleGate = new Promise<number | null>((_res, rej) => { failStale = rej; });
    const files = new Map<string, number>();
    const download = vi.fn(async (url: string, name: string): Promise<number | null> => {
      if (url.includes('stale')) return staleGate.catch(() => null);
      files.set(name, 700);
      return 700;
    });
    const { io } = memoryIO({ download, fileExists: (name) => files.has(name) });
    const cache = createRemoteMediaDiskCache(io);

    // stale presign 的落盘仍在飞,forceRefresh 自愈带新地址进来:不并入旧任务
    const stale = cache.store(URL_A, 'https://oss.example/a?stale=1', 'image/png');
    const fresh = cache.store(URL_A, 'https://oss.example/a?fresh=1', 'image/png');
    failStale(new Error('403 expired'));
    await Promise.all([stale, fresh]);
    // 新地址在旧任务落定后真实下载,fresh 图最终落盘可命中
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[1]?.[0]).toBe('https://oss.example/a?fresh=1');
    expect(await cache.lookup(URL_A)).toMatchObject({ size: 700 });
  });

  it('evicts least-recently-used entries beyond maxBytes', async () => {
    let clock = 1;
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io, { maxBytes: 2500, now: () => clock++ });

    await cache.store(URL_A, 'https://oss.example/a', 'image/png'); // 1000
    await cache.store(URL_B, 'https://oss.example/b', 'image/png'); // 1000
    await cache.lookup(URL_A); // 触摸 A,让 B 成为最旧
    await cache.store(URL_C, 'https://oss.example/c', 'image/png'); // 1000 → 超 2500,淘汰 B

    expect(await cache.lookup(URL_B)).toBeNull();
    expect(await cache.lookup(URL_A)).not.toBeNull();
    expect(await cache.lookup(URL_C)).not.toBeNull();
    expect(files.has(`${cacheKeyOf(URL_B)}.png`)).toBe(false);
  });

  it('self-heals when the cached file disappears (OS purge)', async () => {
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io);

    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    files.delete(`${cacheKeyOf(URL_A)}.png`);
    expect(await cache.lookup(URL_A)).toBeNull();
    // 再 store 可恢复
    await cache.store(URL_A, 'https://oss.example/a?sig=2', 'image/png');
    expect(await cache.lookup(URL_A)).not.toBeNull();
  });

  it('treats a corrupt index as an empty cache', async () => {
    const { io, setIndexText } = memoryIO();
    setIndexText('{not json');
    const cache = createRemoteMediaDiskCache(io);
    expect(await cache.lookup(URL_A)).toBeNull();
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    expect(await cache.lookup(URL_A)).not.toBeNull();
  });

  it('records nothing when the download fails', async () => {
    const { io, getIndexText } = memoryIO({ download: vi.fn(async () => null) });
    const cache = createRemoteMediaDiskCache(io);
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    expect(await cache.lookup(URL_A)).toBeNull();
    expect(getIndexText()).toBeNull();
  });

  it('reconciles orphan files against the index on init (corrupt index case)', async () => {
    const { io, files, setIndexText } = memoryIO();
    files.set('orphan-a.png', 500);
    files.set('orphan-b.jpg', 600);
    setIndexText('{corrupted');
    const cache = createRemoteMediaDiskCache(io);
    await cache.lookup(URL_A); // 触发 init 对账
    expect(files.size).toBe(0); // index 之外的孤儿全部清掉,预算不再被幽灵占用
  });

  it('keeps indexed files during init reconciliation', async () => {
    const { io, files, getIndexText, setIndexText } = memoryIO();
    const seed = createRemoteMediaDiskCache(io);
    await seed.store(URL_A, 'https://oss.example/a', 'image/png');
    const indexText = getIndexText();
    files.set('orphan.png', 500);
    // 新实例(同一份 index + 文件):只清孤儿,不动 index 内的条目
    setIndexText(indexText);
    const cache = createRemoteMediaDiskCache(io);
    expect(await cache.lookup(URL_A)).not.toBeNull();
    expect(files.has('orphan.png')).toBe(false);
    expect(files.has(`${cacheKeyOf(URL_A)}.png`)).toBe(true);
  });

  it('deletes the half-written file when a download lands empty', async () => {
    const { io, files } = memoryIO();
    io.download = vi.fn(async (_url: string, name: string) => {
      files.set(name, 0); // 文件已落盘但 size 为 0(下载被杀等)
      return 0;
    });
    const cache = createRemoteMediaDiskCache(io);
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    expect(files.size).toBe(0); // 半成品不留盘
    expect(await cache.lookup(URL_A)).toBeNull();
  });

  it('deletes the old file when the same url re-stores with a different mime extension', async () => {
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io);
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    expect(files.has(`${cacheKeyOf(URL_A)}.png`)).toBe(true);
    await cache.store(URL_A, 'https://oss.example/a?v=2', 'image/webp');
    expect(files.has(`${cacheKeyOf(URL_A)}.png`)).toBe(false);
    expect(files.has(`${cacheKeyOf(URL_A)}.webp`)).toBe(true);
    expect((await cache.lookup(URL_A))?.mimeType).toBe('image/webp');
  });

  it('skips storing objects larger than the cache budget instead of downloading them', async () => {
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io, { maxBytes: 2500 });
    await cache.store(URL_A, 'https://oss.example/huge', 'image/png', 3000);
    expect(io.download).not.toHaveBeenCalled(); // 白下载都省掉
    expect(files.size).toBe(0);
    // 预算内的照常落盘
    await cache.store(URL_B, 'https://oss.example/ok', 'image/png', 1000);
    expect(io.download).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing good file and entry when a same-name refresh download fails', async () => {
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io);
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    const name = `${cacheKeyOf(URL_A)}.png`;
    expect(files.has(name)).toBe(true);

    // 同名刷新失败(download 原子落位,失败不动现有文件)→ 好文件与条目都保留
    io.download = vi.fn(async () => null);
    await cache.store(URL_A, 'https://oss.example/a?refresh=1', 'image/png');
    expect(files.has(name)).toBe(true);
    expect(await cache.lookup(URL_A)).not.toBeNull();
  });

  it('drops both file and entry when a refresh lands a zero-byte file over the good one', async () => {
    const { io, files } = memoryIO();
    const cache = createRemoteMediaDiskCache(io);
    await cache.store(URL_A, 'https://oss.example/a', 'image/png');
    const name = `${cacheKeyOf(URL_A)}.png`;

    // 0 字节文件已顶替落位 → 文件删除、条目作废,下次 lookup 未命中重取
    io.download = vi.fn(async (_url: string, n: string) => {
      files.set(n, 0);
      return 0;
    });
    await cache.store(URL_A, 'https://oss.example/a?refresh=1', 'image/png');
    expect(files.has(name)).toBe(false);
    expect(await cache.lookup(URL_A)).toBeNull();
  });

  it('infers image mime from url extension for direct shares', () => {
    expect(imageMimeFromUrl('https://oss.example/a.png?sig=1')).toBe('image/png');
    expect(imageMimeFromUrl('https://oss.example/b.JPEG')).toBe('image/jpeg');
    expect(imageMimeFromUrl('https://oss.example/c.webp#frag')).toBe('image/webp');
    expect(imageMimeFromUrl('https://oss.example/no-extension')).toBeNull();
    expect(imageMimeFromUrl('https://oss.example/d.tiff')).toBeNull(); // 未知扩展交调用方兜底
  });

  it('derives stable distinct cache keys per url', () => {
    expect(cacheKeyOf(URL_A)).toBe(cacheKeyOf(URL_A));
    expect(cacheKeyOf(URL_A)).not.toBe(cacheKeyOf(URL_B));
    expect(cacheKeyOf(URL_A)).toMatch(/^[0-9a-f]{18}$/);
  });

  // store 的返回值是「本次是否真的写入了新字节」。调用方靠它决定能否改用本地文件;
  // 只看 promise resolve 会把**已被证伪的旧文件**当成本次结果(PR #1125 review)。
  describe('store reports whether new bytes actually landed', () => {
    it('reports true only when the write is registered', async () => {
      const { io } = memoryIO();
      const cache = createRemoteMediaDiskCache(io);
      await expect(cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png')).resolves.toBe(true);
      await expect(cache.storeBytes(URL_B, 'YWJj', 'image/webp')).resolves.toBe(false); // 无 writeFileBase64
    });

    it('reports false when the object alone exceeds the budget (nothing downloaded)', async () => {
      const { io } = memoryIO();
      const cache = createRemoteMediaDiskCache(io, { maxBytes: 100 });
      await expect(cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png', 1_000)).resolves.toBe(false);
      expect(io.download).not.toHaveBeenCalled();
    });

    it('reports false when the download fails and the existing good file is kept', async () => {
      // 这是 review 指出的坏路径:强制重取下载失败时旧文件被刻意保留,若报 true
      // 调用方就会把刚刚加载失败的同一个文件当本次结果、还标成永不过期。
      let failNext = false;
      const { io, files } = memoryIO({
        download: vi.fn(async (_url: string, name: string) => {
          // 契约:失败时原子落位失败,不得破坏已存在的同名好文件。
          if (failNext) return null;
          files.set(name, 1000);
          return 1000;
        }),
      });
      const cache = createRemoteMediaDiskCache(io);
      await expect(cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png')).resolves.toBe(true);

      failNext = true;
      await expect(cache.store(URL_A, 'https://oss.example/a?sig=2', 'image/png')).resolves.toBe(false);
      // 旧条目仍可命中(不误删),但调用方已被告知本次没写成功
      expect(await cache.lookup(URL_A)).not.toBeNull();
    });

    it('reports false when the write lands as a zero-byte file', async () => {
      const { io } = memoryIO({
        download: vi.fn(async (_url: string, name: string) => 0),
      });
      const cache = createRemoteMediaDiskCache(io);
      await expect(cache.store(URL_A, 'https://oss.example/a?sig=1', 'image/png')).resolves.toBe(false);
      expect(await cache.lookup(URL_A)).toBeNull();
    });

    it('reports false when quota reclaim evicts the very entry just written', async () => {
      // 单对象接近 maxBytes 时可能刚登记就被自己触发的 LRU 逐出,盘上已无本次字节。
      const { io } = memoryIO({
        download: vi.fn(async (_url: string, _name: string) => 1000),
      });
      const cache = createRemoteMediaDiskCache(io, { maxBytes: 500 });
      await expect(cache.store(URL_C, 'https://oss.example/c?sig=1', 'image/png')).resolves.toBe(false);
      expect(await cache.lookup(URL_C)).toBeNull();
    });
  });
});

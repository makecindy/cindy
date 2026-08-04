import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  createRemoteMediaResolveQueue,
  type RemoteMediaRequest,
  type RemoteMediaResolveHooks,
} from '@/session/remoteMediaResolveQueue';
import type { MobileResolvedRemoteMedia } from '@/session/remoteMedia';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function resolvedMedia(url: string, overrides: Partial<MobileResolvedRemoteMedia> = {}): MobileResolvedRemoteMedia {
  return {
    url: `https://oss.example/${url}?sig=1`,
    ossKey: `key/${url}`,
    mimeType: 'image/png',
    size: 1024,
    expiresAt: '2999-01-01T00:00:00.000Z',
    previewable: true,
    ...overrides,
  };
}

function imageRequest(name: string): RemoteMediaRequest {
  return { kind: 'image', url: `xdt-image://cache/${name}` };
}

/** 手动挡 resolve:返回可逐个放行的 deferred 列表。 */
function manualResolver() {
  const pending: Array<{
    media: RemoteMediaRequest;
    resolve: (m: MobileResolvedRemoteMedia) => void;
    reject: (e: unknown) => void;
    /** 队列绑定到本次请求缓存键的落盘回写钩子(见 RemoteMediaResolveHooks)。 */
    hooks?: RemoteMediaResolveHooks;
  }> = [];
  const resolve = vi.fn((
    media: RemoteMediaRequest,
    _opts?: { skipCache?: boolean },
    hooks?: RemoteMediaResolveHooks,
  ) => new Promise<MobileResolvedRemoteMedia>((res, rej) => {
    pending.push({ media, resolve: res, reject: rej, hooks });
  }));
  return { pending, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((res) => { setTimeout(res, 0); });
}

describe('remoteMediaResolveQueue', () => {
  it('keys thumbnail and full-image requests for the same url separately', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve });

    const thumb = queue.request({ ...imageRequest('a.png'), thumbnail: true });
    const full = queue.request(imageRequest('a.png'));
    await flush();
    // 同 url 的缩略图与原图是不同产物,各自触发一次取件,不互相合并。
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(pending[0]?.media.thumbnail).toBe(true);
    expect(pending[1]?.media.thumbnail).toBeUndefined();

    pending[0]?.resolve(resolvedMedia('a-thumb.webp', { ossKey: '', mimeType: 'image/webp' }));
    pending[1]?.resolve(resolvedMedia('a.png'));
    const [thumbResolved, fullResolved] = await Promise.all([thumb, full]);
    expect(thumbResolved.mimeType).toBe('image/webp');
    expect(fullResolved.mimeType).toBe('image/png');

    // 缓存同样分键:重复请求各自命中自己的缓存,不再触发新取件。
    await expect(queue.request({ ...imageRequest('a.png'), thumbnail: true })).resolves.toBe(thumbResolved);
    await expect(queue.request(imageRequest('a.png'))).resolves.toBe(fullResolved);
    expect(resolve).toHaveBeenCalledTimes(2);
    // peekFresh 的 url 参数按原图键解释。
    expect(queue.peekFresh(imageRequest('a.png').url)).toBe(fullResolved);
  });

  it('cachedOnly only consumes fresh cache: hit returns, miss rejects without enqueue or negative cache', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve });

    // 未命中:立即拒绝,不触发取件,也不写负缓存。
    await expect(queue.request(imageRequest('a.png'), { cachedOnly: true })).rejects.toThrow('cachedOnly');
    expect(resolve).not.toHaveBeenCalled();

    // 负缓存未被污染:随后的正常请求照常起飞。
    const p1 = queue.request(imageRequest('a.png'));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    pending[0]?.resolve(resolvedMedia('a.png'));
    const full = await p1;

    // 命中:直接返回缓存,不再触发取件。
    await expect(queue.request(imageRequest('a.png'), { cachedOnly: true })).resolves.toBe(full);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent requests for the same url into one resolve call', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve });

    const p1 = queue.request(imageRequest('a.png'));
    const p2 = queue.request(imageRequest('a.png'));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);

    pending[0]?.resolve(resolvedMedia('a.png'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });

  it('caps in-flight resolves at maxConcurrent and drains the queue afterwards', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve }, { maxConcurrent: 2 });

    const p1 = queue.request(imageRequest('a.png'));
    const p2 = queue.request(imageRequest('b.png'));
    const p3 = queue.request(imageRequest('c.png'));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(queue.stats()).toEqual({ inFlight: 2, queued: 1 });

    pending[0]?.resolve(resolvedMedia('a.png'));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(3);

    pending[1]?.resolve(resolvedMedia('b.png'));
    pending[2]?.resolve(resolvedMedia('c.png'));
    await Promise.all([p1, p2, p3]);
    await flush();
    expect(queue.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('front requests jump ahead of queued thumbnails', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve }, { maxConcurrent: 1 });

    void queue.request(imageRequest('a.png')).catch(() => undefined);
    void queue.request(imageRequest('b.png')).catch(() => undefined);
    const viewer = queue.request(imageRequest('viewer.png'), { front: true });
    await flush();

    pending[0]?.resolve(resolvedMedia('a.png'));
    await flush();
    // viewer 插队,先于 b 起飞
    expect(resolve.mock.calls[1]?.[0]?.url).toBe('xdt-image://cache/viewer.png');
    pending[1]?.resolve(resolvedMedia('viewer.png'));
    await viewer;
  });

  it('promotes an already queued url to the front on a front request', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve }, { maxConcurrent: 1 });

    void queue.request(imageRequest('a.png')).catch(() => undefined);
    void queue.request(imageRequest('b.png')).catch(() => undefined);
    const promoted = queue.request(imageRequest('c.png'));
    const viewer = queue.request(imageRequest('c.png'), { front: true });
    await flush();

    pending[0]?.resolve(resolvedMedia('a.png'));
    await flush();
    expect(resolve.mock.calls[1]?.[0]?.url).toBe('xdt-image://cache/c.png');
    pending[1]?.resolve(resolvedMedia('c.png'));
    await Promise.all([promoted, viewer]);
  });

  it('serves fresh cache hits without re-resolving, and re-resolves stale entries', async () => {
    const resolve = vi.fn(async (media: RemoteMediaRequest) => resolvedMedia(media.url));
    let fresh = true;
    const queue = createRemoteMediaResolveQueue({ resolve, isFresh: () => fresh });

    await queue.request(imageRequest('a.png'));
    await queue.request(imageRequest('a.png'));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(queue.peekFresh('xdt-image://cache/a.png')).not.toBeNull();

    fresh = false;
    expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
    await queue.request(imageRequest('a.png'));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('rejects all waiters on failure and negative-caches within errorTtlMs', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const resolve = vi.fn(async (media: RemoteMediaRequest) => {
        if (fail) throw new Error('desktop offline');
        return resolvedMedia(media.url);
      });
      const queue = createRemoteMediaResolveQueue({ resolve }, { errorTtlMs: 20_000 });

      const p1 = queue.request(imageRequest('a.png'));
      const p2 = queue.request(imageRequest('a.png'));
      await expect(p1).rejects.toThrow('desktop offline');
      await expect(p2).rejects.toThrow('desktop offline');
      expect(resolve).toHaveBeenCalledTimes(1);

      // TTL 内直接拒,不再打桌面端
      await expect(queue.request(imageRequest('a.png'))).rejects.toThrow('desktop offline');
      expect(resolve).toHaveBeenCalledTimes(1);

      // TTL 过后可重试
      vi.advanceTimersByTime(20_001);
      fail = false;
      await expect(queue.request(imageRequest('a.png'))).resolves.toMatchObject({ previewable: true });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort removes a queued url with no other waiters but leaves in-flight resolves running', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve }, { maxConcurrent: 1 });

    const inflightCtl = new AbortController();
    const queuedCtl = new AbortController();
    const inflight = queue.request(imageRequest('a.png'), { signal: inflightCtl.signal });
    const queued = queue.request(imageRequest('b.png'), { signal: queuedCtl.signal });
    await flush();
    expect(queue.stats()).toEqual({ inFlight: 1, queued: 1 });

    // 排队中的 abort → 移出队列并 reject
    queuedCtl.abort();
    await expect(queued).rejects.toThrow('取消');
    expect(queue.stats()).toEqual({ inFlight: 1, queued: 0 });

    // in-flight 的 abort → 任其完成并写缓存
    inflightCtl.abort();
    pending[0]?.resolve(resolvedMedia('a.png'));
    await expect(inflight).resolves.toMatchObject({ ossKey: 'key/a.png' });
    expect(queue.peekFresh('xdt-image://cache/a.png')).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps a queued url alive when only one of multiple waiters aborts', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve }, { maxConcurrent: 1 });

    void queue.request(imageRequest('a.png')).catch(() => undefined);
    const ctl = new AbortController();
    const aborting = queue.request(imageRequest('b.png'), { signal: ctl.signal });
    const surviving = queue.request(imageRequest('b.png'));
    await flush();

    ctl.abort();
    await expect(aborting).rejects.toThrow('取消');

    pending[0]?.resolve(resolvedMedia('a.png'));
    await flush();
    pending[1]?.resolve(resolvedMedia('b.png'));
    await expect(surviving).resolves.toMatchObject({ ossKey: 'key/b.png' });
  });

  it('forceRefresh bypasses a fresh cache entry, overwrites it, and passes skipCache downstream', async () => {
    let seq = 0;
    const resolve = vi.fn(async (media: RemoteMediaRequest) => {
      seq += 1;
      return resolvedMedia(media.url, { url: `https://oss.example/v${seq}` });
    });
    const queue = createRemoteMediaResolveQueue({ resolve });

    const first = await queue.request(imageRequest('a.png'));
    expect(first.url).toBe('https://oss.example/v1');
    // 第三参是队列绑定的落盘回写钩子,每次 resolve 都带(见 RemoteMediaResolveHooks)。
    const localCopyHooks = expect.objectContaining({ onLocalCopy: expect.any(Function) });
    expect(resolve).toHaveBeenNthCalledWith(1, expect.objectContaining({ url: 'xdt-image://cache/a.png' }), undefined, localCopyHooks);
    const refreshed = await queue.request(imageRequest('a.png'), { forceRefresh: true });
    expect(refreshed.url).toBe('https://oss.example/v2');
    expect(resolve).toHaveBeenNthCalledWith(2, expect.objectContaining({ url: 'xdt-image://cache/a.png' }), { skipCache: true }, localCopyHooks);
    expect(queue.peekFresh('xdt-image://cache/a.png')?.url).toBe('https://oss.example/v2');
  });

  it('evict drops a cached entry so the next request re-resolves', async () => {
    const resolve = vi.fn(async (media: RemoteMediaRequest) => resolvedMedia(media.url));
    const queue = createRemoteMediaResolveQueue({ resolve });

    await queue.request(imageRequest('a.png'));
    const evicted = queue.evict('xdt-image://cache/a.png');
    expect(evicted?.ossKey).toBe('key/xdt-image://cache/a.png');
    expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();

    await queue.request(imageRequest('a.png'));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('releaseAll empties the cache and returns every resolved entry', async () => {
    const resolve = vi.fn(async (media: RemoteMediaRequest) => resolvedMedia(media.url));
    const queue = createRemoteMediaResolveQueue({ resolve });

    await queue.request(imageRequest('a.png'));
    await queue.request(imageRequest('b.png'));
    const released = queue.releaseAll();
    expect(released.map((m) => m.ossKey).sort()).toEqual([
      'key/xdt-image://cache/a.png',
      'key/xdt-image://cache/b.png',
    ]);
    expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
    expect(queue.releaseAll()).toEqual([]);
  });

  it('lets forceRefresh punch through and clear the negative cache (explicit user retry)', async () => {
    const { pending, resolve } = manualResolver();
    let clock = 1_000;
    const queue = createRemoteMediaResolveQueue({ resolve, now: () => clock }, { errorTtlMs: 20_000 });

    const p1 = queue.request(imageRequest('a.png'));
    await flush();
    pending[0]?.reject(new Error('desktop offline'));
    await expect(p1).rejects.toThrow('desktop offline');

    // 负缓存窗口内:被动请求仍被拒绝
    clock += 1_000;
    await expect(queue.request(imageRequest('a.png'))).rejects.toThrow('desktop offline');

    // forceRefresh(显式重试)穿透负缓存,真正发起取件
    const p2 = queue.request(imageRequest('a.png'), { forceRefresh: true });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    pending[1]?.resolve(resolvedMedia('a.png'));
    await expect(p2).resolves.toMatchObject({ ossKey: 'key/a.png' });

    // 负缓存已被清除:后续普通请求不再被旧错误挡住
    const p3 = queue.request(imageRequest('a.png'));
    await expect(p3).resolves.toMatchObject({ ossKey: 'key/a.png' });
  });

  it('rejects queued (not in-flight) requests on releaseAll instead of uploading them post-exit', async () => {
    const { pending, resolve } = manualResolver();
    const onOrphanResolved = vi.fn();
    const queue = createRemoteMediaResolveQueue({ resolve, onOrphanResolved }, { maxConcurrent: 1 });

    const p1 = queue.request(imageRequest('a.png')); // in-flight
    const p2 = queue.request(imageRequest('b.png')); // 排队(无 signal,模拟 lightbox 预取)
    await flush();
    expect(queue.stats()).toEqual({ inFlight: 1, queued: 1 });

    queue.releaseAll();
    // 排队项直接拒绝,resolve 不会为它被调用
    await expect(p2).rejects.toThrow('远程媒体取件已取消');
    pending[0]?.resolve(resolvedMedia('a.png'));
    await expect(p1).resolves.toMatchObject({ ossKey: 'key/a.png' });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1); // b.png 从未起飞
    expect(onOrphanResolved).toHaveBeenCalledTimes(1); // 只有 in-flight 的 a.png 走 orphan
  });

  it('hands the replaced entry to onOrphanResolved when a refresh overwrites the cache', async () => {
    const { pending, resolve } = manualResolver();
    const onOrphanResolved = vi.fn();
    const queue = createRemoteMediaResolveQueue({ resolve, onOrphanResolved });

    const p1 = queue.request(imageRequest('a.png'));
    await flush();
    pending[0]?.resolve(resolvedMedia('a.png', { ossKey: 'key/old' }));
    await p1;

    // forceRefresh 重取,拿到不同 ossKey → 旧对象交还宿主补删
    const p2 = queue.request(imageRequest('a.png'), { forceRefresh: true });
    await flush();
    pending[1]?.resolve(resolvedMedia('a.png', { ossKey: 'key/new' }));
    await p2;
    expect(onOrphanResolved).toHaveBeenCalledTimes(1);
    expect(onOrphanResolved).toHaveBeenCalledWith(expect.objectContaining({ ossKey: 'key/old' }));

    // 同 ossKey 覆盖(被控端去重返回同一对象)→ 不误删仍在用的对象
    const p3 = queue.request(imageRequest('a.png'), { forceRefresh: true });
    await flush();
    pending[2]?.resolve(resolvedMedia('a.png', { ossKey: 'key/new' }));
    await p3;
    expect(onOrphanResolved).toHaveBeenCalledTimes(1);

    // releaseAll 只返回当前条目(新 key)
    expect(queue.releaseAll().map((m) => m.ossKey)).toEqual(['key/new']);
  });

  it('re-flies forceRefresh with skipCache instead of joining an in-flight plain resolve', async () => {
    const { pending, resolve } = manualResolver();
    const queue = createRemoteMediaResolveQueue({ resolve });

    const plain = queue.request(imageRequest('a.png'));
    await flush();
    // 普通取件已起飞后,onError 自愈发起强制重取:不能并入本轮
    const forced = queue.request(imageRequest('a.png'), { forceRefresh: true, front: true });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBeUndefined(); // 本轮不带 skipCache

    pending[0]?.resolve(resolvedMedia('a.png', { ossKey: 'key/stale' }));
    await expect(plain).resolves.toMatchObject({ ossKey: 'key/stale' });

    // 本轮完成后 follow-up 立刻以 skipCache 重飞,强制等待者拿到新结果
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[1]).toEqual({ skipCache: true });
    pending[1]?.resolve(resolvedMedia('a.png', { ossKey: 'key/fresh' }));
    await expect(forced).resolves.toMatchObject({ ossKey: 'key/fresh' });
    expect(queue.peekFresh('xdt-image://cache/a.png')?.ossKey).toBe('key/fresh');
  });

  it('evicts the proven-bad cache entry when a forced refresh fails', async () => {
    const { pending, resolve } = manualResolver();
    const onOrphanResolved = vi.fn();
    let clock = 1_000;
    const queue = createRemoteMediaResolveQueue({ resolve, now: () => clock, onOrphanResolved });

    const p1 = queue.request(imageRequest('a.png'));
    await flush();
    pending[0]?.resolve(resolvedMedia('a.png', { ossKey: 'key/bad' }));
    await p1;

    // Image onError 后的强制重取失败(桌面离线):坏条目必须逐出并交还补删,
    // 否则后续被动请求会继续命中已证伪的对象。
    const p2 = queue.request(imageRequest('a.png'), { forceRefresh: true });
    await flush();
    pending[1]?.reject(new Error('desktop offline'));
    await expect(p2).rejects.toThrow('desktop offline');
    expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
    expect(onOrphanResolved).toHaveBeenCalledWith(expect.objectContaining({ ossKey: 'key/bad' }));

    // 负缓存过期后,新的被动请求走全新取件而不是旧缓存
    clock += 30_000;
    const p3 = queue.request(imageRequest('a.png'));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(3);
    pending[2]?.resolve(resolvedMedia('a.png', { ossKey: 'key/new' }));
    await expect(p3).resolves.toMatchObject({ ossKey: 'key/new' });
  });

  it('routes in-flight resolves that complete after releaseAll to onOrphanResolved', async () => {
    const { pending, resolve } = manualResolver();
    const onOrphanResolved = vi.fn();
    const queue = createRemoteMediaResolveQueue({ resolve, onOrphanResolved });

    const p1 = queue.request(imageRequest('a.png'));
    await flush();
    expect(queue.stats().inFlight).toBe(1);

    // 退屏:缓存里还没有任何条目,releaseAll 拿不到 in-flight 的结果
    const released = queue.releaseAll();
    expect(released).toEqual([]);

    // in-flight 完成 → 结果不进缓存,交给 orphan 回调补 DELETE
    pending[0]?.resolve(resolvedMedia('a.png'));
    await expect(p1).resolves.toMatchObject({ ossKey: 'key/a.png' });
    expect(onOrphanResolved).toHaveBeenCalledTimes(1);
    expect(onOrphanResolved).toHaveBeenCalledWith(expect.objectContaining({ ossKey: 'key/a.png' }));
    expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
  });

  // 落盘完成后的缓存升级(PR #1125 review):presign 会被当 fresh 缓存反复命中,
  // 同键请求再也不会重进磁盘 lookup,盘上的本地副本永远轮不到用。
  describe('local-copy upgrade', () => {
    const localCopy = (ossKey: string): MobileResolvedRemoteMedia => ({
      url: 'file:///cache/a.png',
      ossKey,
      mimeType: 'image/png',
      size: 1024,
      expiresAt: '9999-12-31T00:00:00.000Z',
      previewable: true,
    });

    it('serves the local file to later requests without re-resolving', async () => {
      const { pending, resolve } = manualResolver();
      const queue = createRemoteMediaResolveQueue({ resolve });

      const p1 = queue.request(imageRequest('a.png'));
      await flush();
      pending[0]?.resolve(resolvedMedia('a.png'));
      await expect(p1).resolves.toMatchObject({ url: 'https://oss.example/a.png?sig=1' });

      // 后台落盘完成 → 队列条目升级成本地文件
      pending[0]?.hooks?.onLocalCopy(localCopy('key/a.png'));

      await expect(queue.request(imageRequest('a.png'))).resolves.toMatchObject({
        url: 'file:///cache/a.png',
      });
      // 关键:没有再次进入取件(否则就等于每次点开都重下一整张原图)
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(queue.peekFresh('xdt-image://cache/a.png')?.url).toBe('file:///cache/a.png');
    });

    it('keeps the oss key so leaving the screen still deletes the object', async () => {
      const { pending, resolve } = manualResolver();
      const queue = createRemoteMediaResolveQueue({ resolve });

      const p1 = queue.request(imageRequest('a.png'));
      await flush();
      pending[0]?.resolve(resolvedMedia('a.png'));
      await p1;
      pending[0]?.hooks?.onLocalCopy(localCopy('key/a.png'));

      // 升级后对象仍在世,必须照常出现在退屏清理里
      expect(queue.releaseAll()).toEqual([
        expect.objectContaining({ url: 'file:///cache/a.png', ossKey: 'key/a.png' }),
      ]);
    });

    it('drops an upgrade whose object was already replaced by a forced refresh', async () => {
      const { pending, resolve } = manualResolver();
      const queue = createRemoteMediaResolveQueue({ resolve });

      const p1 = queue.request(imageRequest('a.png'));
      await flush();
      pending[0]?.resolve(resolvedMedia('a.png', { ossKey: 'key/old' }));
      await p1;

      // 强制重取换到新对象
      const p2 = queue.request(imageRequest('a.png'), { forceRefresh: true });
      await flush();
      pending[1]?.resolve(resolvedMedia('a.png', { ossKey: 'key/new' }));
      await p2;

      // 旧对象的落盘迟到:ossKey 不匹配,必须丢弃,不能把新条目覆盖成旧字节
      pending[0]?.hooks?.onLocalCopy(localCopy('key/old'));
      expect(queue.peekFresh('xdt-image://cache/a.png')).toMatchObject({
        ossKey: 'key/new',
        url: 'https://oss.example/a.png?sig=1',
      });
    });

    it('drops an upgrade that lands after releaseAll instead of reviving the entry', async () => {
      const { pending, resolve } = manualResolver();
      const queue = createRemoteMediaResolveQueue({ resolve });

      const p1 = queue.request(imageRequest('a.png'));
      await flush();
      pending[0]?.resolve(resolvedMedia('a.png'));
      await p1;
      queue.releaseAll();

      pending[0]?.hooks?.onLocalCopy(localCopy('key/a.png'));
      // 退屏后缓存归统一清理接管,升级不得凭空复活条目
      expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
    });

    it('does not create a cache entry when the key was never cached', async () => {
      const { pending, resolve } = manualResolver();
      const queue = createRemoteMediaResolveQueue({ resolve });

      const p1 = queue.request(imageRequest('a.png'));
      await flush();
      pending[0]?.reject(new Error('boom'));
      await expect(p1).rejects.toThrow('boom');

      // 取件失败没有缓存条目;迟到的落盘升级不得凭空建一条
      pending[0]?.hooks?.onLocalCopy(localCopy('key/a.png'));
      expect(queue.peekFresh('xdt-image://cache/a.png')).toBeNull();
    });
  });
});

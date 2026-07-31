/**
 * remoteMediaProtocol.test.ts — 控制端 cindy-remote-media:// handler 编排:
 *   - 畸形 URL → 400
 *   - cindy-media:// 且本机字节仓命中 → 本地直接服务,不触发远程取件
 *   - 缓存命中 local → 内存切片 200 / range 206
 *   - 未命中 + 图片 → media:fetch → 整下 → 删 OSS(用后删)→ recordLocal → 200
 *   - 未命中 + 视频 → media:fetch → recordStream → OSS range 206 透传(不整下、不删 OSS)
 *   - media:fetch 失败 → 502
 *   - 同 key 并发首取去重 → media:fetch 只一次
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  app: { getPath: () => '/tmp' },
}));
vi.mock('@cindy/device-link', () => ({ DL_MEDIA_FETCH_CHANNEL: 'device-link:media:fetch' }));

const remoteInvoke = vi.hoisted(() => vi.fn());
vi.mock('../index', () => ({ remoteInvoke }));

const downloadToBuffer = vi.hoisted(() => vi.fn());
const openMediaStream = vi.hoisted(() => vi.fn());
const removeRemote = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../mediaTransfer', () => ({ downloadToBuffer, openMediaStream, removeRemote }));

const lookup = vi.hoisted(() => vi.fn());
const recordLocal = vi.hoisted(() => vi.fn());
const recordStream = vi.hoisted(() => vi.fn());
const retainStream = vi.hoisted(() => vi.fn());
const releaseStream = vi.hoisted(() => vi.fn());
const evictEntry = vi.hoisted(() => vi.fn());
vi.mock('../remoteMediaCacheStore', () => ({
  lookup,
  recordLocal,
  recordStream,
  retainStream,
  releaseStream,
  evictEntry,
  sweepIdleStreams: vi.fn(),
  __testing: { STREAM_TTL_MS: 1000 },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const serveSshRemoteMedia = vi.hoisted(() => vi.fn());
vi.mock('../../file-browser/ssh-media', () => ({ serveSshRemoteMedia }));

// cindy-media 本地优先短路的依赖:blobStore 解析、ledger LRU 刷新、fs 读盘。
// 默认(beforeEach)设为「本机无此 blob」,既有远程管线用例语义不变。
const blobResolveSafe = vi.hoisted(() => vi.fn());
vi.mock('../../cindy-media/blobStore', () => ({ resolveSafe: blobResolveSafe }));
const touchBlob = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../cindy-media/ledger', () => ({ touchBlob }));
const fsReadFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({
  default: { readFile: fsReadFile },
  readFile: fsReadFile,
}));

// fetchRemoteMediaImageBytes 的限流读取:保留真实 collectStreamWithLimit,
// 只把上限缩小到 16 字节,避免测试造 100MB 数据。
vi.mock('../../lightboxMediaActions', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lightboxMediaActions')>();
  return { ...orig, REMOTE_IMAGE_MAX_BYTES: 16 };
});

import { __testing, fetchRemoteMediaImageBytes } from '../remoteMediaProtocol';
import { buildRemoteMediaUrl } from '../../../shared/remoteMediaUrl';

const { handleRemoteMedia } = __testing;
const URL_IMG = buildRemoteMediaUrl({ kind: 'device', deviceId: 'dev-1' }, 'xdt-image://s/a.png');
const URL_VID = buildRemoteMediaUrl({ kind: 'device', deviceId: 'dev-1' }, 'xdt-video://s/v.mp4');

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockReturnValue(undefined);
  evictEntry.mockReturnValue(true); // 默认无 in-flight 消费者,可逐出
  // 默认:本机字节仓不命中(readFile ENOENT)→ cindy-media 用例照走远程管线
  blobResolveSafe.mockImplementation((url: string) => ({
    absPath: `/tmp/blobs/${url.slice(-8)}`,
    mimeType: 'image/png',
    hash: 'h'.repeat(64),
  }));
  fsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
});

describe('handleRemoteMedia', () => {
  it('畸形 URL → 400', async () => {
    const r = await handleRemoteMedia('not-a-remote-media-url', null);
    expect(r.status).toBe(400);
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('ssh token → 分流到 ssh-media,不触 device OSS 管线', async () => {
    serveSshRemoteMedia.mockResolvedValue(new Response(null, { status: 200 }));
    const sshOrigin = { kind: 'ssh', remoteHostId: 'h1', workdir: '/wd' } as const;
    const url = buildRemoteMediaUrl(sshOrigin, 'xdt-file://local/?path=%2Fwd%2Fa.png');
    const r = await handleRemoteMedia(url, 'bytes=0-1');
    expect(serveSshRemoteMedia).toHaveBeenCalledWith(
      sshOrigin,
      'xdt-file://local/?path=%2Fwd%2Fa.png',
      'bytes=0-1',
    );
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
  });

  describe('cindy-media 本地优先', () => {
    const BLOB_URL = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const URL_BLOB = buildRemoteMediaUrl({ kind: 'device', deviceId: 'dev-1' }, BLOB_URL);

    it('本机字节仓命中 → 直接本地服务 200 + immutable,不触发远程取件', async () => {
      fsReadFile.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
      const r = await handleRemoteMedia(URL_BLOB, null);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('cache-control')).toContain('immutable');
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4]);
      expect(blobResolveSafe).toHaveBeenCalledWith(BLOB_URL);
      expect(touchBlob).toHaveBeenCalledWith('h'.repeat(64)); // 刷 LRU,防回收器误清
      expect(remoteInvoke).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('本机命中 + range → 206 切片(照抄 cindyMediaProtocol 行为)', async () => {
      fsReadFile.mockResolvedValue(Buffer.from([10, 20, 30, 40]));
      const r = await handleRemoteMedia(URL_BLOB, 'bytes=1-2');
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe('bytes 1-2/4');
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([20, 30]);
      expect(remoteInvoke).not.toHaveBeenCalled();
    });

    it('本机无此 blob(ENOENT)→ 照常远程取件(发送端竞态之外的正常远端图)', async () => {
      remoteInvoke.mockResolvedValue({
        ok: true,
        result: { ossKey: 'oss/b.png', mimeType: 'image/png', size: 3 },
      });
      downloadToBuffer.mockResolvedValue({
        bytes: Buffer.from([7, 8, 9]),
        contentType: 'image/png',
      });
      recordLocal.mockReturnValue({
        kind: 'local',
        bytes: Buffer.from([7, 8, 9]),
        mimeType: 'image/png',
      });
      const r = await handleRemoteMedia(URL_BLOB, null);
      expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'device-link:media:fetch', [
        { url: BLOB_URL },
      ]);
      expect(r.status).toBe(200);
    });

    it('xdt-image:// 不做本地短路(session 级缓存地址两端不可互认)', async () => {
      remoteInvoke.mockResolvedValue({
        ok: true,
        result: { ossKey: 'oss/k.png', mimeType: 'image/png', size: 3 },
      });
      downloadToBuffer.mockResolvedValue({
        bytes: Buffer.from([7, 8, 9]),
        contentType: 'image/png',
      });
      recordLocal.mockReturnValue({
        kind: 'local',
        bytes: Buffer.from([7, 8, 9]),
        mimeType: 'image/png',
      });
      await handleRemoteMedia(URL_IMG, null);
      expect(blobResolveSafe).not.toHaveBeenCalled();
      expect(fsReadFile).not.toHaveBeenCalled();
      expect(remoteInvoke).toHaveBeenCalled();
    });
  });

  it('缓存命中 local(无 range)→ 200 整文件,不触发取件', async () => {
    lookup.mockReturnValue({
      kind: 'local',
      bytes: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/png',
    });
    const r = await handleRemoteMedia(URL_IMG, null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('缓存命中 local + range → 206 + Content-Range', async () => {
    lookup.mockReturnValue({
      kind: 'local',
      bytes: Buffer.from([10, 20, 30, 40]),
      mimeType: 'image/png',
    });
    const r = await handleRemoteMedia(URL_IMG, 'bytes=1-2');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 1-2/4');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([20, 30]);
  });

  it('未命中 + 图片 → media:fetch → 整下 → 删 OSS → recordLocal → 200', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/k.png', mimeType: 'image/png', size: 3 },
    });
    downloadToBuffer.mockResolvedValue({ bytes: Buffer.from([7, 8, 9]), contentType: 'image/png' });
    recordLocal.mockReturnValue({
      kind: 'local',
      bytes: Buffer.from([7, 8, 9]),
      mimeType: 'image/png',
    });

    const r = await handleRemoteMedia(URL_IMG, null);
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'device-link:media:fetch', [
      { url: 'xdt-image://s/a.png' },
    ]);
    expect(downloadToBuffer).toHaveBeenCalledWith('oss/k.png');
    expect(removeRemote).toHaveBeenCalledWith('oss/k.png'); // 用后删
    expect(recordLocal).toHaveBeenCalledWith(
      'dev-1',
      'xdt-image://s/a.png',
      expect.any(Buffer),
      'image/png',
    );
    expect(r.status).toBe(200);
  });

  it('未命中 + 视频 → recordStream → OSS range 206 透传,不整下、不删 OSS', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/v.mp4', mimeType: 'video/mp4', size: 1000 },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/v.mp4',
      mimeType: 'video/mp4',
      size: 1000,
    });
    openMediaStream.mockResolvedValue(
      new Response(new Uint8Array([1, 2]).buffer, {
        status: 206,
        headers: { 'content-range': 'bytes 0-1/1000', 'content-length': '2' },
      }),
    );

    const r = await handleRemoteMedia(URL_VID, 'bytes=0-1');
    expect(recordStream).toHaveBeenCalledWith(
      'dev-1',
      'xdt-video://s/v.mp4',
      'oss/v.mp4',
      'video/mp4',
      1000,
    );
    expect(openMediaStream).toHaveBeenCalledWith('oss/v.mp4', 'bytes=0-1', undefined);
    expect(downloadToBuffer).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled(); // 流式保活
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-1/1000');
    expect(r.headers.get('content-type')).toBe('video/mp4');
  });

  it('大文件(非视频/音频,> 64MiB)→ 不整下进内存,走 OSS 流式', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/big.pdf', mimeType: 'application/pdf', size: 100 * 1024 * 1024 },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/big.pdf',
      mimeType: 'application/pdf',
      size: 100 * 1024 * 1024,
    });
    openMediaStream.mockResolvedValue(
      new Response(new Uint8Array([1]).buffer, { status: 200, headers: {} }),
    );
    await handleRemoteMedia(
      buildRemoteMediaUrl(
        { kind: 'device', deviceId: 'dev-1' },
        'xdt-file://local/?path=%2Fbig.pdf',
      ),
      null,
    );
    expect(recordStream).toHaveBeenCalled();
    expect(downloadToBuffer).not.toHaveBeenCalled(); // 不整下进内存
    expect(removeRemote).not.toHaveBeenCalled(); // OSS 保活
  });

  it('media:fetch 失败 → 502', async () => {
    remoteInvoke.mockResolvedValue({
      ok: false,
      error: { code: 'MEDIA_FETCH_FAILED', message: 'boom' },
    });
    const r = await handleRemoteMedia(URL_IMG, null);
    expect(r.status).toBe(502);
  });

  it('下载失败(被控端去重缓存悬空 key)→ 带 skipCache 重取一次并成功', async () => {
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/stale.png', mimeType: 'image/png', size: 3 },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/fresh.png', mimeType: 'image/png', size: 3 },
      });
    downloadToBuffer
      .mockRejectedValueOnce(new Error('OSS GET 失败 (404)'))
      .mockResolvedValueOnce({ bytes: Buffer.from([7, 8, 9]), contentType: 'image/png' });
    recordLocal.mockReturnValue({
      kind: 'local',
      bytes: Buffer.from([7, 8, 9]),
      mimeType: 'image/png',
    });

    const r = await handleRemoteMedia(URL_IMG, null);
    expect(remoteInvoke).toHaveBeenNthCalledWith(1, 'dev-1', 'device-link:media:fetch', [
      { url: 'xdt-image://s/a.png' },
    ]);
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', 'device-link:media:fetch', [
      { url: 'xdt-image://s/a.png', skipCache: true },
    ]);
    expect(downloadToBuffer).toHaveBeenNthCalledWith(2, 'oss/fresh.png');
    // 两把 key 都被清理(悬空 key 删除幂等,新 key 用后删)
    expect(removeRemote).toHaveBeenCalledWith('oss/stale.png');
    expect(removeRemote).toHaveBeenCalledWith('oss/fresh.png');
    expect(r.status).toBe(200);
  });

  it('skipCache 重取后仍失败 → 502(不无限重试)', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/k.png', mimeType: 'image/png', size: 3 },
    });
    downloadToBuffer.mockRejectedValue(new Error('OSS GET 失败 (404)'));
    const r = await handleRemoteMedia(URL_IMG, null);
    expect(remoteInvoke).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(502);
  });

  it('客户端取消大图首开(AbortError)→ 不逐出、不重传,按原语义 502', async () => {
    const BIG = 100 * 1024 * 1024;
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/big.png', mimeType: 'image/png', size: BIG },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/big.png',
      mimeType: 'image/png',
      size: BIG,
    });
    openMediaStream.mockRejectedValue(new Error('AbortError: The operation was aborted'));
    const ctl = new AbortController();
    ctl.abort();

    const r = await handleRemoteMedia(URL_IMG, null, ctl.signal);
    expect(r.status).toBe(502);
    expect(evictEntry).not.toHaveBeenCalled(); // 健康对象不被误删
    expect(remoteInvoke).toHaveBeenCalledTimes(1); // 不触发 skipCache 白重传
  });

  it('大图流式条目首开失败(悬空 key)→ 逐出坏条目 + skipCache 重取并成功', async () => {
    const BIG = 100 * 1024 * 1024;
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/stale.png', mimeType: 'image/png', size: BIG },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/fresh.png', mimeType: 'image/png', size: BIG },
      });
    recordStream
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/stale.png',
        mimeType: 'image/png',
        size: BIG,
      })
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/fresh.png',
        mimeType: 'image/png',
        size: BIG,
      });
    openMediaStream
      .mockRejectedValueOnce(new Error('OSS GET 失败 (404)'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]).buffer, { status: 200, headers: {} }),
      );

    const r = await handleRemoteMedia(URL_IMG, null);
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', 'device-link:media:fetch', [
      { url: 'xdt-image://s/a.png', skipCache: true },
    ]);
    expect(evictEntry).toHaveBeenCalledWith('dev-1', 'xdt-image://s/a.png', 'oss/stale.png'); // 只逐出失败的那把 key
    expect(openMediaStream).toHaveBeenNthCalledWith(2, 'oss/fresh.png', undefined, undefined);
    expect(r.status).toBe(200);
  });

  it('cindy-media 大图流式条目首开失败(悬空 key)→ 同 xdt-image 自愈(也进被控端去重缓存)', async () => {
    const BIG = 100 * 1024 * 1024;
    const URL_CINDY = buildRemoteMediaUrl(
      { kind: 'device', deviceId: 'dev-1' },
      'cindy-media://blobs/abcdef1234567890.png',
    );
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/stale.png', mimeType: 'image/png', size: BIG },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/fresh.png', mimeType: 'image/png', size: BIG },
      });
    recordStream
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/stale.png',
        mimeType: 'image/png',
        size: BIG,
      })
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/fresh.png',
        mimeType: 'image/png',
        size: BIG,
      });
    openMediaStream
      .mockRejectedValueOnce(new Error('OSS GET 失败 (404)'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]).buffer, { status: 200, headers: {} }),
      );

    const r = await handleRemoteMedia(URL_CINDY, null);
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', 'device-link:media:fetch', [
      { url: 'cindy-media://blobs/abcdef1234567890.png', skipCache: true },
    ]);
    expect(evictEntry).toHaveBeenCalledWith(
      'dev-1',
      'cindy-media://blobs/abcdef1234567890.png',
      'oss/stale.png',
    );
    expect(r.status).toBe(200);
  });

  it('大图流式条目仍有 in-flight 消费者时首开失败 → 拒绝逐出,502 不重取', async () => {
    const BIG = 100 * 1024 * 1024;
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/live.png', mimeType: 'image/png', size: BIG },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/live.png',
      mimeType: 'image/png',
      size: BIG,
    });
    openMediaStream.mockRejectedValue(new Error('aborted'));
    evictEntry.mockReturnValue(false); // 别的响应正在从该 key 出流

    const r = await handleRemoteMedia(URL_IMG, null);
    expect(r.status).toBe(502);
    expect(remoteInvoke).toHaveBeenCalledTimes(1); // 不做 skipCache 重取
  });

  it('并发失败请求:条目已被并发自愈换成新对象 → 改服新条目,不误删不重传', async () => {
    const BIG = 100 * 1024 * 1024;
    remoteInvoke.mockResolvedValueOnce({
      ok: true,
      result: { ossKey: 'oss/stale.png', mimeType: 'image/png', size: BIG },
    });
    recordStream.mockReturnValueOnce({
      kind: 'stream',
      ossKey: 'oss/stale.png',
      mimeType: 'image/png',
      size: BIG,
    });
    openMediaStream
      .mockRejectedValueOnce(new Error('OSS GET 失败 (404)'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([2]).buffer, { status: 200, headers: {} }),
      );
    // 后到的失败请求执行 evict 时,条目已被先到者换成 fresh:evictEntry 拒绝
    evictEntry.mockReturnValueOnce(false);
    lookup
      .mockReturnValueOnce(undefined) // ensureEntry 首查未命中 → 走取件
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/fresh.png',
        mimeType: 'image/png',
        size: BIG,
        inFlight: 0,
      });

    const r = await handleRemoteMedia(URL_IMG, null);
    expect(evictEntry).toHaveBeenCalledWith('dev-1', 'xdt-image://s/a.png', 'oss/stale.png');
    expect(remoteInvoke).toHaveBeenCalledTimes(1); // 不再触发第二次上传
    expect(openMediaStream).toHaveBeenNthCalledWith(2, 'oss/fresh.png', undefined, undefined);
    expect(r.status).toBe(200);
  });

  it('自愈重取挂在 inflight 上:窗口期并发请求并入,不再发起普通取件', async () => {
    const BIG = 100 * 1024 * 1024;
    let releaseSkipFetch: (v: unknown) => void = () => {};
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { ossKey: 'oss/stale.png', mimeType: 'image/png', size: BIG },
      })
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            releaseSkipFetch = res;
          }),
      );
    recordStream
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/stale.png',
        mimeType: 'image/png',
        size: BIG,
      })
      .mockReturnValueOnce({
        kind: 'stream',
        ossKey: 'oss/fresh.png',
        mimeType: 'image/png',
        size: BIG,
      });
    openMediaStream
      .mockRejectedValueOnce(new Error('OSS GET 失败 (404)'))
      // 每次调用返回新 Response:body 流只能被消费一次,复用同一对象会让第二个
      // 请求拿到已锁定的流、误入二次自愈
      .mockImplementation(
        async () => new Response(new Uint8Array([1]).buffer, { status: 200, headers: {} }),
      );

    const p1 = handleRemoteMedia(URL_IMG, null);
    await new Promise((r) => {
      setTimeout(r, 0);
    }); // p1 走到 skipCache 重取挂起
    const p2 = handleRemoteMedia(URL_IMG, null); // 窗口期并发请求:必须并入 inflight
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    releaseSkipFetch({
      ok: true,
      result: { ossKey: 'oss/fresh.png', mimeType: 'image/png', size: BIG },
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(remoteInvoke).toHaveBeenCalledTimes(2); // 初始 + skipCache,没有第三次普通取件
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', 'device-link:media:fetch', [
      { url: 'xdt-image://s/a.png', skipCache: true },
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('视频流式首开失败 → 保持 502,不做 skipCache 重取(整段重传代价不值)', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/v.mp4', mimeType: 'video/mp4', size: 1000 },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/v.mp4',
      mimeType: 'video/mp4',
      size: 1000,
    });
    openMediaStream.mockRejectedValue(new Error('OSS GET 失败 (404)'));

    const r = await handleRemoteMedia(URL_VID, 'bytes=0-1');
    expect(r.status).toBe(502);
    expect(remoteInvoke).toHaveBeenCalledTimes(1);
    expect(evictEntry).not.toHaveBeenCalled();
  });

  it('开流前先 retain,开流失败成对 release(开流窗口不可被并发自愈逐出)', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/v.mp4', mimeType: 'video/mp4', size: 1000 },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/v.mp4',
      mimeType: 'video/mp4',
      size: 1000,
    });
    openMediaStream.mockRejectedValue(new Error('OSS GET 失败 (503)'));

    const r = await handleRemoteMedia(URL_VID, 'bytes=0-1');
    expect(r.status).toBe(502);
    // retain 发生在 openMediaStream 之前(开流窗口内 inFlight > 0,自愈 evict 会被拒)
    expect(retainStream).toHaveBeenCalledTimes(1);
    expect(retainStream.mock.invocationCallOrder[0]).toBeLessThan(
      openMediaStream.mock.invocationCallOrder[0],
    );
    // 失败后成对 release,不泄漏 in-flight 计数
    expect(releaseStream).toHaveBeenCalledTimes(1);
  });

  it('超大 xdt-file:// 流式首开失败 → 保持 502,不自愈(skipCache 对非图片无效,重传昂贵)', async () => {
    remoteInvoke.mockResolvedValue({
      ok: true,
      result: { ossKey: 'oss/big.pdf', mimeType: 'application/pdf', size: 100 * 1024 * 1024 },
    });
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/big.pdf',
      mimeType: 'application/pdf',
      size: 100 * 1024 * 1024,
    });
    openMediaStream.mockRejectedValue(new Error('OSS GET 失败 (503)'));

    const r = await handleRemoteMedia(
      buildRemoteMediaUrl(
        { kind: 'device', deviceId: 'dev-1' },
        'xdt-file://local/?path=%2Fbig.pdf',
      ),
      null,
    );
    expect(r.status).toBe(502);
    expect(remoteInvoke).toHaveBeenCalledTimes(1); // 不触发 skipCache 重传
    expect(evictEntry).not.toHaveBeenCalled();
  });

  it('同 key 并发首取 → media:fetch 只触发一次(inflight 去重)', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    remoteInvoke.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );
    recordStream.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/v.mp4',
      mimeType: 'video/mp4',
      size: 1,
    });
    openMediaStream.mockResolvedValue(
      new Response(new Uint8Array([1]).buffer, { status: 206, headers: {} }),
    );

    const p1 = handleRemoteMedia(URL_VID, 'bytes=0-0');
    const p2 = handleRemoteMedia(URL_VID, 'bytes=0-0');
    resolveFetch({ ok: true, result: { ossKey: 'oss/v.mp4', mimeType: 'video/mp4', size: 1 } });
    await Promise.all([p1, p2]);
    expect(remoteInvoke).toHaveBeenCalledTimes(1);
  });
});

describe('fetchRemoteMediaImageBytes', () => {
  it('local 缓存命中 → 返回完整 buffer + mimeType', async () => {
    lookup.mockReturnValue({ kind: 'local', bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png' });
    const { buffer, mimeType } = await fetchRemoteMediaImageBytes(URL_IMG);
    expect([...buffer]).toEqual([1, 2, 3]);
    expect(mimeType).toBe('image/png');
  });

  it('取件失败(非 2xx)→ 抛错', async () => {
    remoteInvoke.mockResolvedValue({
      ok: false,
      error: { code: 'MEDIA_FETCH_FAILED', message: 'boom' },
    });
    await expect(fetchRemoteMediaImageBytes(URL_IMG)).rejects.toThrow('HTTP 502');
  });

  it('stream 型条目超过字节上限 → 限流抛错,不整读进内存', async () => {
    const BIG = 100 * 1024 * 1024;
    lookup.mockReturnValue({
      kind: 'stream',
      ossKey: 'oss/big.png',
      mimeType: 'image/png',
      size: BIG,
    });
    // body 32 字节 > mock 的 16 字节上限:collectStreamWithLimit 必须中途抛,
    // 而不是 arrayBuffer() 整读成功。
    openMediaStream.mockResolvedValue(
      new Response(new Uint8Array(32).buffer, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(fetchRemoteMediaImageBytes(URL_IMG)).rejects.toThrow('图片过大');
  });
});

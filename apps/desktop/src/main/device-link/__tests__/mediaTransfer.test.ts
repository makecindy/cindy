/**
 * mediaTransfer.test.ts — device-link OSS 中转 client 的传输编排契约。
 * ---------------------------------------------------------------------------
 * mock electron net.fetch + globalThis.fetch + serverApiClient.serverApiFetch + fs,只验编排:
 *   - 上传:小文件整体 PUT(ArrayBuffer body,带 Content-Length)/ 大文件流式 PUT(ReadableStream + duplex half)
 *   - presign 走 serverApiFetch、OSS PUT 走 undici(globalThis.fetch)、OSS GET 走 net.fetch(绝对 URL)
 *   - OSS PUT 的传输栈回退:undici 网络层失败 → Electron net.fetch 重试一次
 *   - 下载整文件 / range 流式(206 不当错误,透传原始 Response)
 *   - delete 失败被吞(best-effort 清理,不阻断主流程)
 *   - ext / mime 推断
 *
 * 两个 fetch 分开 mock:PUT 与 GET 走的是不同网络栈(undici 不吃系统代理,
 * Electron net 吃),把它们混成一个 mock 就测不出回退是否真的换了栈。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

/** Electron net.fetch(Chromium 网络栈):OSS GET / range,以及 PUT 的回退跳。 */
const netFetchMock = vi.hoisted(() => vi.fn());
/** globalThis.fetch(Node undici):OSS PUT 主路径。 */
const undiciFetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }));
vi.stubGlobal('fetch', undiciFetchMock);

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: apiFetch,
  ServerApiError: class extends Error {},
}));

vi.mock('../../appCapabilities.js', () => ({
  requireAppCapability: vi.fn(),
}));

vi.mock('../index.js', () => ({
  deviceLinkApiBase: () => 'http://relay.test:3335',
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const statMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());
const createWriteStreamMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({
  stat: statMock,
  readFile: readFileMock,
  rename: renameMock,
  rm: rmMock,
}));
vi.mock('node:fs', () => ({
  createReadStream: createReadStreamMock,
  createWriteStream: createWriteStreamMock,
}));

import {
  uploadLocalFile,
  uploadBuffer,
  downloadToFile,
  downloadToBuffer,
  openMediaStream,
  removeRemote,
  __testing,
} from '../mediaTransfer.js';

const PUT_PATH = '/api/device-link/media/presign-put';
const GET_PATH = '/api/device-link/media/presign-get';
const DEL_PATH = '/api/device-link/media';
const KEY = 'cindy/device-link/user-aaa/uuid.png';

/** 默认 presign 路由:put→putUrl/key、get→getUrl、delete→deleted。 */
function wirePresign() {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === PUT_PATH) return { putUrl: 'https://oss.example/put', key: KEY, expiresAt: 'x' };
    if (path === GET_PATH) return { getUrl: 'https://oss.example/get', expiresAt: 'x' };
    if (path === DEL_PATH) return { deleted: true };
    throw new Error(`unexpected path ${path}`);
  });
}

function okPut() {
  undiciFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 传输栈记忆跨用例泄漏会让"先走哪条栈"的断言互相污染。
  __testing.electronNetPreferredHosts.clear();
  wirePresign();
  renameMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  createWriteStreamMock.mockImplementation(() => new PassThrough());
});

describe('uploadLocalFile — 小文件整体 PUT', () => {
  beforeEach(() => {
    statMock.mockResolvedValue({ isFile: () => true, size: 100 });
    readFileMock.mockResolvedValue(Buffer.alloc(100, 7));
    okPut();
  });

  it('presign-put 带 size/ext/contentType + relay baseUrl,PUT body 为 ArrayBuffer + Content-Length + acl:private', async () => {
    const r = await uploadLocalFile('/tmp/a.png');
    // presign 走 relay base URL
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({
        method: 'POST',
        body: { size: 100, ext: 'png', contentType: 'image/png' },
        baseUrl: expect.any(Function),
      }),
    );
    const relayBaseUrl = apiFetch.mock.calls[0]?.[1]?.baseUrl;
    expect(typeof relayBaseUrl === 'function' ? relayBaseUrl() : relayBaseUrl).toBe(
      'http://relay.test:3335',
    );
    const [url, init] = undiciFetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/put');
    expect(init.method).toBe('PUT');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(init.duplex).toBeUndefined();
    // Content-Length 不手动设(undici 自动计算;手动设无意义且历史上撞过 Chromium net.fetch 限制)
    expect(init.headers['Content-Length']).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('image/png');
    // 隐私关键:device-link 媒体对象一律 private(canonical header,与 server signPutUrl 签名一致)
    expect(init.headers['x-oss-object-acl']).toBe('private');
    expect(r).toEqual({
      key: KEY,
      size: 100,
      contentType: 'image/png',
      sha256: createHash('sha256').update(Buffer.alloc(100, 7)).digest('hex'),
    });
  });

  it('PUT 成功后取消响应体,及时归还底层连接', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    undiciFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
      text: async () => '',
    });

    await uploadLocalFile('/tmp/a.png');

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('contentType 可显式覆盖', async () => {
    await uploadLocalFile('/tmp/a.bin', { contentType: 'application/x-custom' });
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({
        body: expect.objectContaining({ contentType: 'application/x-custom' }),
      }),
    );
  });

  it('OSS PUT 非 2xx → 抛错,且不换传输栈重试(应用层拒绝,换栈没用)', async () => {
    undiciFetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '<Error/>' });
    await expect(uploadLocalFile('/tmp/a.png')).rejects.toThrow(/OSS PUT 失败 \(403\)/);
    expect(netFetchMock).not.toHaveBeenCalled();
  });

  it('路径不是文件 → 抛错', async () => {
    statMock.mockResolvedValue({ isFile: () => false, size: 0 });
    await expect(uploadLocalFile('/tmp/dir')).rejects.toThrow();
  });

  it('超过 2GB 上限 → 抛错,不 presign 不 PUT(客户端真实大小自校)', async () => {
    statMock.mockResolvedValue({ isFile: () => true, size: __testing.MAX_MEDIA_BYTES + 1 });
    await expect(uploadLocalFile('/tmp/huge.mp4')).rejects.toThrow(/超过上限/);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(netFetchMock).not.toHaveBeenCalled();
  });
});

describe('uploadLocalFile — 大文件流式 PUT', () => {
  it('超阈值 → body 为 ReadableStream + duplex half,不读进内存', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    // 用复用的 1 MiB chunk 产出阈值+1 字节，避免测试自身分配 64 MiB 连续 Buffer。
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    createReadStreamMock.mockImplementation(() =>
      Readable.from(
        (function* chunks() {
          for (let offset = 0; offset < __testing.STREAM_THRESHOLD; offset += chunk.length)
            yield chunk;
          yield Buffer.from([0x21]);
        })(),
      ),
    );
    undiciFetchMock.mockImplementation(drainingPut);
    const result = await uploadLocalFile('/tmp/big.mp4');
    expect(readFileMock).not.toHaveBeenCalled(); // 流式不读全文件
    const [, init] = undiciFetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe('half');
    expect(init.headers['Content-Type']).toBe('video/mp4');
    expect(result.size).toBe(size);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * 回归:被控端在代理 / 分流网络里,undici 直连 OSS 全挂而 Electron net 能通,
 * 导致手机端所有 OSS 中转预览(PDF / 图片原图 / 视频 / 导出分享)只回一句裸
 * 'TypeError: fetch failed'。PUT 因此必须能换栈重试,并把 cause 展开出来。
 */
describe('putBytesToOss — 传输栈回退', () => {
  /** 带签名 query 的 presign URL:用于确认错误串不外泄可复用的上传凭证。 */
  const SIGNED_PUT_URL =
    'https://oss-cn-hangzhou.example/bucket/obj.png?OSSAccessKeyId=AK-TEST&Signature=SECRET-SIG';

  function wireSignedPresign() {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === PUT_PATH) return { putUrl: SIGNED_PUT_URL, key: KEY, expiresAt: 'x' };
      if (path === DEL_PATH) return { deleted: true };
      throw new Error(`unexpected path ${path}`);
    });
  }

  beforeEach(() => {
    statMock.mockResolvedValue({ isFile: () => true, size: 100 });
    readFileMock.mockResolvedValue(Buffer.alloc(100, 7));
  });

  it('undici 网络层失败 → 改走 Electron net 重试成功,PUT 契约不变', async () => {
    undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    netFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    const r = await uploadLocalFile('/tmp/a.png');

    expect(r.key).toBe(KEY);
    expect(netFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = netFetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/put');
    expect(init.method).toBe('PUT');
    // ACL header 与签名绑定:回退跳必须照带,否则 OSS 只会 403,不会静默降级成公开对象。
    expect(init.headers['x-oss-object-acl']).toBe('private');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    // 上传最终成功,不该顺手把对象删掉。
    expect(apiFetch).not.toHaveBeenCalledWith(DEL_PATH, expect.anything());
  });

  it('两跳都失败 → 用户可见串只留可判因的 errno,host / 完整链路 / presign 签名都不外泄', async () => {
    wireSignedPresign();
    const undiciErr = new TypeError('fetch failed');
    undiciErr.cause = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), {
      code: 'ETIMEDOUT',
    });
    undiciFetchMock.mockRejectedValue(undiciErr);
    netFetchMock.mockRejectedValue(new TypeError('net::ERR_PROXY_CONNECTION_FAILED'));

    const message = await uploadLocalFile('/tmp/a.png').catch((err: Error) => err.message);

    expect(message).toContain('ETIMEDOUT');
    expect(message).toContain('net::ERR_PROXY_CONNECTION_FAILED');
    // 这条会原样显示在手机预览页:host、地址族与完整 cause 链只进主进程日志。
    expect(message).not.toContain('oss-cn-hangzhou.example');
    expect(message).not.toContain('10.0.0.1');
    expect(message).not.toContain('SECRET-SIG');
    expect(message).not.toContain('AK-TEST');
  });

  it('happy-eyeballs 的 AggregateError → 可见串仍给出地址族的真实 errno', async () => {
    // undici 开着 autoSelectFamily 时,每个地址族的 errno 只存在于聚合分支里,
    // 只沿 cause 链找会退化成一句没信息量的 NETWORK_ERROR。
    const undiciErr = new TypeError('fetch failed');
    undiciErr.cause = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ETIMEDOUT [::1]:443'), { code: 'ETIMEDOUT' }),
    ]);
    undiciFetchMock.mockRejectedValue(undiciErr);
    netFetchMock.mockRejectedValue(new TypeError('net::ERR_PROXY_CONNECTION_FAILED'));

    const message = await uploadLocalFile('/tmp/a.png').catch((err: Error) => err.message);

    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toContain('NETWORK_ERROR');
    expect(message).not.toContain('10.0.0.1');
  });

  it('换栈成功后按 host 记住,下一次直接走 Electron net,不再白等 undici 超时', async () => {
    undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    netFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    await uploadLocalFile('/tmp/a.png');
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);

    await uploadLocalFile('/tmp/b.png');
    expect(undiciFetchMock).toHaveBeenCalledTimes(1); // 第二次没再碰 undici
    expect(netFetchMock).toHaveBeenCalledTimes(2);
  });

  it('命中记忆的成功不续期,TTL 到点仍会重新探测 undici', async () => {
    undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    netFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await uploadLocalFile('/tmp/a.png');
    const firstStamp = __testing.electronNetPreferredHosts.get('oss.example');
    expect(firstStamp).toBeTypeOf('number');

    // 记忆有效期内再传若干次,时间戳必须保持首次回退那一刻。
    await uploadLocalFile('/tmp/b.png');
    await uploadLocalFile('/tmp/c.png');

    expect(__testing.electronNetPreferredHosts.get('oss.example')).toBe(firstStamp);
  });

  it('记忆命中的 Electron 跳被 HTTP 拒绝 → 仍回落 undici,并清掉这条记忆', async () => {
    // 记忆只是顺序优化,不该让结果比默认顺序更糟:Electron 是"对自定义 header
    // 不可靠"的那条,它的 403 不能当最终结论,否则环境一变就卡到 TTL 到期。
    __testing.electronNetPreferredHosts.set('oss.example', Date.now());
    netFetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '<Error/>' });
    undiciFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    const r = await uploadLocalFile('/tmp/a.png');

    expect(r.key).toBe(KEY);
    expect(netFetchMock).toHaveBeenCalledTimes(1);
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    expect(__testing.electronNetPreferredHosts.has('oss.example')).toBe(false);
  });

  it('记忆命中跳被拒 + 默认栈网络失败 → 可见串只留 errno,不混入中间态的 HTTP 码', async () => {
    // 那一跳的 403 是"已判定不可信、已换栈"的中间态;混进可见串会把人往权限
    // 方向带,而真正卡住的是后面这跳的网络故障。
    __testing.electronNetPreferredHosts.set('oss.example', Date.now());
    netFetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    const undiciErr = new TypeError('fetch failed');
    undiciErr.cause = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), {
      code: 'ETIMEDOUT',
    });
    undiciFetchMock.mockRejectedValue(undiciErr);

    const message = await uploadLocalFile('/tmp/a.png').catch((err: Error) => err.message);

    expect(message).toContain('ETIMEDOUT');
    expect(message).not.toContain('403');
    expect(message).not.toContain('HTTP_');
  });

  it('两跳都被 HTTP 拒绝 → 抛默认栈的状态码结论', async () => {
    __testing.electronNetPreferredHosts.set('oss.example', Date.now());
    netFetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    undiciFetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '' });

    await expect(uploadLocalFile('/tmp/a.png')).rejects.toThrow(/OSS PUT 失败 \(403\)/);
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('写入记忆时顺手清掉过期条目,长跑进程不会攒下一堆一次性 host', async () => {
    // 清理原本只在"再次命中同一 host"时发生,多 region / 多 bucket 场景下这张
    // 表会在 main 进程整个生命周期里只增不减。
    __testing.electronNetPreferredHosts.set(
      'stale-1.example',
      Date.now() - __testing.TRANSPORT_PREFERENCE_TTL_MS - 1,
    );
    __testing.electronNetPreferredHosts.set('fresh.example', Date.now());
    undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    netFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    await uploadLocalFile('/tmp/a.png');

    expect(__testing.electronNetPreferredHosts.has('stale-1.example')).toBe(false);
    expect(__testing.electronNetPreferredHosts.has('fresh.example')).toBe(true);
    expect(__testing.electronNetPreferredHosts.has('oss.example')).toBe(true);
  });

  it('记忆过期后回到 undici 主路径', async () => {
    undiciFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    __testing.electronNetPreferredHosts.set(
      'oss.example',
      Date.now() - __testing.TRANSPORT_PREFERENCE_TTL_MS - 1,
    );

    await uploadLocalFile('/tmp/a.png');

    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    expect(netFetchMock).not.toHaveBeenCalled();
    expect(__testing.electronNetPreferredHosts.has('oss.example')).toBe(false);
  });

  it('undici 恢复可用后清掉记忆', async () => {
    __testing.electronNetPreferredHosts.set('oss.example', Date.now());
    netFetchMock.mockRejectedValue(new TypeError('net::ERR_FAILED'));
    undiciFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    await uploadLocalFile('/tmp/a.png');

    expect(netFetchMock).toHaveBeenCalledTimes(1); // 记忆让它先试 Electron net
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    expect(__testing.electronNetPreferredHosts.has('oss.example')).toBe(false);
  });

  it('流式 body 换栈时重新开流并关掉被放弃的那条,摘要按重传的字节算', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    const opened: Readable[] = [];
    createReadStreamMock.mockImplementation(() => {
      const source = Readable.from(
        (function* chunks() {
          for (let offset = 0; offset < __testing.STREAM_THRESHOLD; offset += chunk.length) {
            yield chunk;
          }
          yield Buffer.from([0x21]);
        })(),
      );
      opened.push(source);
      return source;
    });
    undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    netFetchMock.mockImplementation(drainingPut);

    const r = await uploadLocalFile('/tmp/big.mp4');

    // 两跳各开一次流:流只能消费一次,回退不重开就会传 0 字节还算出错误摘要。
    expect(createReadStreamMock).toHaveBeenCalledTimes(2);
    // 被放弃的那条必须关掉,否则每次换栈上传都漏一个 fd。
    expect(opened[0].destroyed).toBe(true);
    expect(r.size).toBe(size);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('源流异步读盘失败 → 不换栈重试,原样抛源错误(不埋进两栈汇总里)', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    // 真实的 createReadStream 失败是异步 'error' 事件,不在调用点 throw。
    createReadStreamMock.mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(Object.assign(new Error('EIO: read failed'), { code: 'EIO' }));
          },
        }),
    );
    undiciFetchMock.mockImplementation(drainingPut);

    await expect(uploadLocalFile('/tmp/broken.mp4')).rejects.toThrow('EIO: read failed');

    expect(netFetchMock).not.toHaveBeenCalled();
    expect(createReadStreamMock).toHaveBeenCalledTimes(1);
    // 本地故障也要清掉已 presign 的对象。
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });
});

describe('uploadBuffer — 内存字节(base64 附件)', () => {
  it('presign-put 带 size/ext/contentType,整体 PUT,返回 key', async () => {
    okPut();
    const r = await uploadBuffer(Buffer.from([1, 2, 3, 4, 5]), {
      ext: 'png',
      contentType: 'image/png',
    });
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({ body: { size: 5, ext: 'png', contentType: 'image/png' } }),
    );
    const [url, init] = undiciFetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/put');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(init.headers['Content-Length']).toBeUndefined();
    expect(r).toEqual({
      key: KEY,
      size: 5,
      contentType: 'image/png',
      sha256: createHash('sha256')
        .update(Buffer.from([1, 2, 3, 4, 5]))
        .digest('hex'),
    });
  });

  it('空字节 → 抛错,不上传', async () => {
    await expect(uploadBuffer(Buffer.alloc(0), { ext: 'png' })).rejects.toThrow(/空字节/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('downloadToFile — 原子完整性校验', () => {
  it('大小和 SHA-256 都匹配后才发布目标文件', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    netFetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });
    const expected = {
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };

    await expect(downloadToFile(KEY, '/tmp/final.bin', expected)).resolves.toBeUndefined();

    expect(createWriteStreamMock.mock.calls[0]?.[0]).toMatch(/\.part$/);
    expect(renameMock).toHaveBeenCalledWith(expect.stringMatching(/\.part$/), '/tmp/final.bin');
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('截断时删除 part 文件且不发布', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    netFetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });

    await expect(
      downloadToFile(KEY, '/tmp/final.bin', {
        size: 4,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ).rejects.toThrow(/下载不完整/);

    expect(renameMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/\.part$/), { force: true });
  });

  it('同长度内容损坏时由 SHA-256 发现并清理', async () => {
    const expectedBytes = Uint8Array.from([1, 2, 3]);
    const actualBytes = Uint8Array.from([1, 2, 4]);
    netFetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(actualBytes) });

    await expect(
      downloadToFile(KEY, '/tmp/final.bin', {
        size: expectedBytes.byteLength,
        sha256: createHash('sha256').update(expectedBytes).digest('hex'),
      }),
    ).rejects.toThrow(/完整性校验失败/);

    expect(renameMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalled();
  });
});

describe('downloadToBuffer', () => {
  it('presign-get + GET 整文件 → Buffer + contentType', async () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    netFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => ab,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
    });
    const r = await downloadToBuffer(KEY);
    expect(apiFetch).toHaveBeenCalledWith(
      GET_PATH,
      expect.objectContaining({ body: { key: KEY } }),
    );
    expect(netFetchMock.mock.calls[0][0]).toBe('https://oss.example/get');
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(r.contentType).toBe('image/png');
  });

  it('GET 失败 → 抛错', async () => {
    netFetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    await expect(downloadToBuffer(KEY)).rejects.toThrow(/OSS GET/);
  });
});

describe('openMediaStream — range 流式', () => {
  it('带 Range → 转发 Range 头,返回原始 206 Response(不 buffer)', async () => {
    const resp = { ok: true, status: 206, headers: { get: () => null } };
    netFetchMock.mockResolvedValue(resp);
    const out = await openMediaStream(KEY, 'bytes=0-1023');
    const [url, init] = netFetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/get');
    expect(init.headers['Range']).toBe('bytes=0-1023');
    expect(out).toBe(resp); // 原样透传
  });

  it('无 Range → 整文件 GET,不带 Range 头', async () => {
    netFetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
    await openMediaStream(KEY);
    const [, init] = netFetchMock.mock.calls[0];
    expect(init.headers['Range']).toBeUndefined();
  });

  it('非 2xx/206 → 抛错', async () => {
    netFetchMock.mockResolvedValue({ ok: false, status: 500, headers: { get: () => null } });
    await expect(openMediaStream(KEY, 'bytes=0-1')).rejects.toThrow(/OSS GET/);
  });
});

describe('removeRemote — best-effort', () => {
  it('成功 → DELETE 带 key', async () => {
    await removeRemote(KEY);
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('server 报错 → 吞掉不抛(清理失败不阻断主流程)', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    await expect(removeRemote(KEY)).resolves.toBeUndefined();
  });
});

describe('__testing.extOf / mimeOf', () => {
  it('extOf:取小写裸扩展名,无扩展名 → bin', () => {
    expect(__testing.extOf('/tmp/A.PNG')).toBe('png');
    expect(__testing.extOf('/tmp/clip.MP4')).toBe('mp4');
    expect(__testing.extOf('/tmp/noext')).toBe('bin');
  });
  it('mimeOf:已知映射 / 未知回落 octet-stream', () => {
    expect(__testing.mimeOf('mp4')).toBe('video/mp4');
    expect(__testing.mimeOf('png')).toBe('image/png');
    expect(__testing.mimeOf('xyz')).toBe('application/octet-stream');
  });
});

describe('integrity regression coverage', () => {
  it('deletes the OSS object when streamed bytes no longer match the presigned size', async () => {
    const actualSize = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size: actualSize + 1 });
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    createReadStreamMock.mockImplementation(() =>
      Readable.from(
        (function* chunks() {
          for (let offset = 0; offset < __testing.STREAM_THRESHOLD; offset += chunk.length) {
            yield chunk;
          }
          yield Buffer.from([0x21]);
        })(),
      ),
    );
    undiciFetchMock.mockImplementation(drainingPut);

    await expect(uploadLocalFile('/tmp/changed.mp4')).rejects.toThrow();
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('deletes the OSS object when a streamed PUT fails on both transports', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    createReadStreamMock.mockImplementation(() => Readable.from([Buffer.alloc(1024, 0x62)]));
    undiciFetchMock.mockRejectedValue(
      Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    );
    netFetchMock.mockRejectedValue(new TypeError('net::ERR_CONNECTION_RESET'));

    await expect(uploadLocalFile('/tmp/interrupted.mp4')).rejects.toThrow(
      /ECONNRESET.*net::ERR_CONNECTION_RESET/,
    );
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('deletes the OSS object when the source stream errors while being read', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    createReadStreamMock.mockImplementation(() => {
      throw new Error('source read failed');
    });

    await expect(uploadLocalFile('/tmp/source-error.mp4')).rejects.toThrow('source read failed');
    // 源流打不开是本机故障,换传输栈重试没有意义。
    expect(netFetchMock).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('reports progress while bytes are written to the random part file', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    netFetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });
    const onProgress = vi.fn();

    await downloadToFile(KEY, '/tmp/final.bin', undefined, onProgress);

    expect(onProgress).toHaveBeenCalledWith(bytes.byteLength);
  });
});

/** 像 undici / Chromium 那样把流式 body 抽干后回 200(不抽干 counter 不会 flush)。 */
async function drainingPut(_url: string, init: RequestInit) {
  if (init.body instanceof ReadableStream) {
    const reader = init.body.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
  }
  return { ok: true, status: 200, text: async () => '' };
}

function webBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

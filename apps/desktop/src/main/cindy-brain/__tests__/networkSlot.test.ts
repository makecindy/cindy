/**
 * networkSlot.test.ts — network 槽代理 fetch 单测(纯 DI,无 Electron)。
 * 覆盖:载荷校验、卡槽+详单双闸、URL 硬校验、域名白名单(精确/通配)、
 * 危险 header 剥离、凭证注入(值不回流沙箱/未配置快速失败/按域名限流向)、
 * 重定向逐跳守门、响应文本化与截断、错误折叠、在途并发闸、callId 归因。
 */

import { describe, it, expect, vi } from 'vitest';

import { GhostNetworkSlot, type NetworkSlotDeps } from '../networkSlot';
import {
  GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE,
  GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES,
  GHOST_FETCH_INFLIGHT_LIMIT,
  GHOST_FETCH_MEDIA_MAX_BYTES,
  GHOST_FETCH_RESPONSE_MAX_BYTES,
  GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE,
  type GhostNetworkNeeds,
  type InstalledGhost,
} from '../../../shared/ghost';

function fakeGhost(
  overrides: {
    enabled?: boolean;
    slots?: string[];
    /** null = 有槽无详单(老包语义);undefined = 默认 brave+tavily 双域名。 */
    network?: GhostNetworkNeeds | null;
  } = {},
): InstalledGhost {
  const defaultNetwork: GhostNetworkNeeds = {
    hosts: ['api.search.brave.com', '*.tavily.com'],
    secrets: [
      {
        key: 'brave_api_key',
        label: 'Brave Key',
        inject: { header: 'X-Subscription-Token', format: '{value}', hosts: ['api.search.brave.com'] },
      },
      {
        key: 'tavily_api_key',
        label: 'Tavily Key',
        inject: { header: 'X-Api-Key', format: 'Bearer {value}', hosts: ['*.tavily.com'] },
      },
    ],
  };
  return {
    manifest: {
      schemaVersion: 2,
      id: 'web-search',
      name: '搜索',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: overrides.slots ?? ['tool', 'network'],
      tools: [{ name: 'search_web', description: '搜索' }],
      ...(overrides.network === null ? {} : { network: overrides.network ?? defaultNetwork }),
    },
    dir: '/fake/brain/web-search',
    enabled: overrides.enabled ?? true,
  } as InstalledGhost;
}

/** 构造一个可控的 Response 假体(headers 用真 Headers)。 */
function fakeResponse(params: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
} = {}): Response {
  const { status = 200, headers = { 'content-type': 'application/json' }, body = '{"ok":1}' } = params;
  const buf = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
  return {
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

function mp3WithId3(tagSize = 0): Uint8Array {
  return new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
    (tagSize >>> 21) & 0x7f,
    (tagSize >>> 14) & 0x7f,
    (tagSize >>> 7) & 0x7f,
    tagSize & 0x7f,
    ...new Uint8Array(tagSize),
    0xff, 0xfb, 0x90, 0x64,
  ]);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function makeSlot(overrides: Partial<NetworkSlotDeps> = {}): {
  slot: GhostNetworkSlot;
  fetchImpl: ReturnType<typeof vi.fn>;
  readSecret: ReturnType<typeof vi.fn>;
  saveGhostMedia: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn(async () => fakeResponse());
  const readSecret = vi.fn((_ghostId: string, key: string) =>
    key === 'brave_api_key' ? 'BSA-secret' : key === 'tavily_api_key' ? 'tvly-secret' : null,
  );
  const saveGhostMedia = vi.fn(async () => ({
    url: 'cindy-media://blobs/abc.png',
    hash: 'a'.repeat(64),
    ext: '.png',
  }));
  // 与生产 blobStore 白名单同精神的最小集(测试只需要区分"受支持/不受支持")。
  const isSupportedMediaMime = (mime: string) =>
    ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg'].includes(mime);
  const deps: NetworkSlotDeps = {
    getGhost: () => fakeGhost(),
    readSecret,
    getLoginEmail: () => 'dev@example.com',
    fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
    saveGhostMedia: saveGhostMedia as unknown as NetworkSlotDeps['saveGhostMedia'],
    isSupportedMediaMime,
    // 缺省"查无此媒体":上传套件按需覆盖。
    readGhostMedia: async () => null,
    // 缺省"查无此票":目录上传套件按需覆盖。
    takeDirDeposit: () => null,
    // 缺省"票据无效":下行落盘套件按需覆盖。
    writeSaveDeposit: async () => null,
    ...overrides,
  };
  return { slot: new GhostNetworkSlot(deps), fetchImpl, readSecret, saveGhostMedia };
}

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search?q=hi';

describe('networkSlot · 载荷与 URL 校验', () => {
  it('url 缺失/非 https/带端口/内嵌凭证/不是绝对地址一律拒', async () => {
    const { slot } = makeSlot();
    for (const url of [
      undefined,
      '',
      'http://api.search.brave.com/x',
      'https://api.search.brave.com:8443/x',
      'https://user:pw@api.search.brave.com/x',
      '/relative/path',
      'ftp://api.search.brave.com/x',
    ]) {
      const r = await slot.handleFetchRequest('web-search', { type: 'fetch-request', url });
      expect(r.ok, String(url)).toBe(false);
    }
  });

  it('method 认 GET/POST/PUT/PATCH/DELETE;body 仅 POST/PUT/PATCH/DELETE 可带;callId 乱填拒', async () => {
    const { slot } = makeSlot();
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'HEAD' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'OPTIONS' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'PUT', body: 'x' })).ok).toBe(true);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'PATCH', body: 'x' })).ok).toBe(true);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'DELETE' })).ok).toBe(true);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, body: 'x' })).ok).toBe(false); // GET 带 body
    // DELETE 带 body:少数 REST API 的既定形态(GitHub 移除 assignee/reviewer),2026-07-14 放行。
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, method: 'DELETE', body: 'x' })).ok).toBe(true);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, callId: '' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, callId: 'x'.repeat(129) })).ok).toBe(false);
  });

  it('域名白名单:精确命中放行;子域伪装/白名单外拒;通配只命中子域', async () => {
    const { slot, fetchImpl } = makeSlot();
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL })).ok).toBe(true);
    expect((await slot.handleFetchRequest('web-search', { url: 'https://api.tavily.com/search' })).ok).toBe(true);
    for (const url of [
      'https://evil.com/x',
      'https://evil-api.search.brave.com/x', // 前缀伪装
      'https://api.search.brave.com.evil.com/x', // 后缀伪装
      'https://tavily.com/x', // 通配不命中裸域
    ]) {
      const r = await slot.handleFetchRequest('web-search', { url });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.message).toContain('白名单');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('networkSlot · 资格审(槽 + 详单双闸)', () => {
  it('意识不存在/停用/未声明 network 槽/有槽无详单一律拒', async () => {
    const gone = makeSlot({ getGhost: () => null });
    expect((await gone.slot.handleFetchRequest('web-search', { url: BRAVE_URL })).ok).toBe(false);

    const disabled = makeSlot({ getGhost: () => fakeGhost({ enabled: false }) });
    expect((await disabled.slot.handleFetchRequest('web-search', { url: BRAVE_URL })).ok).toBe(false);

    const noSlot = makeSlot({ getGhost: () => fakeGhost({ slots: ['tool'], network: null }) });
    const r1 = await noSlot.slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('network 卡槽');

    const noNeeds = makeSlot({ getGhost: () => fakeGhost({ network: null }) });
    const r2 = await noNeeds.slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('network.hosts');
  });
});

describe('networkSlot · headers 消毒与凭证注入', () => {
  it('协议关键头/凭证类头/sec- 前缀静默剥除,普通头透传', async () => {
    const { slot, fetchImpl } = makeSlot();
    const r = await slot.handleFetchRequest('web-search', {
      url: BRAVE_URL,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ghost-forged',
        Cookie: 'sid=steal',
        Host: 'evil.com',
        'Sec-Fetch-Mode': 'cors',
      },
    });
    expect(r.ok).toBe(true);
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(sent.Accept).toBe('application/json');
    expect(sent.Authorization).toBeUndefined();
    expect(sent.Cookie).toBeUndefined();
    expect(sent.Host).toBeUndefined();
    expect(sent['Sec-Fetch-Mode']).toBeUndefined();
  });

  it('凭证按 inject 声明注入且只流向声明域名;值不出现在返回值里', async () => {
    const { slot, fetchImpl } = makeSlot();
    const r1 = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r1.ok).toBe(true);
    const braveHeaders = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(braveHeaders['X-Subscription-Token']).toBe('BSA-secret');
    expect(braveHeaders['X-Api-Key']).toBeUndefined(); // tavily 的 key 不进 brave 请求

    const r2 = await slot.handleFetchRequest('web-search', { url: 'https://api.tavily.com/search' });
    expect(r2.ok).toBe(true);
    const tavilyHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(tavilyHeaders['X-Api-Key']).toBe('Bearer tvly-secret'); // format 模板生效
    expect(tavilyHeaders['X-Subscription-Token']).toBeUndefined();

    // 凭证值不回流:返回体是响应内容,不含注入值。
    expect(JSON.stringify(r1)).not.toContain('BSA-secret');
    expect(JSON.stringify(r2)).not.toContain('tvly-secret');
  });

  it('命中域名的凭证未配置 → 快速失败并指引设置页,不发请求', async () => {
    const { slot, fetchImpl } = makeSlot({ readSecret: () => null });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('尚未配置');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('意识伪造凭证头会先被剥除、再由保险库注入(伪造值不可能出网)', async () => {
    const { slot, fetchImpl } = makeSlot();
    await slot.handleFetchRequest('web-search', {
      url: BRAVE_URL,
      headers: { 'X-Subscription-Token': 'forged-value' },
    });
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    // 注入头由主机独占:最终值必须是保险库的,不是沙箱报的。
    expect(sent['X-Subscription-Token']).toBe('BSA-secret');
  });

  it('凭证头的大小写变体同样被剥除(Headers 合并大小写不敏感,变体残留会拼接污染)', async () => {
    const { slot, fetchImpl } = makeSlot();
    await slot.handleFetchRequest('web-search', {
      url: BRAVE_URL,
      headers: { 'x-subscription-token': 'forged-lowercase', 'X-API-KEY': 'forged-other' },
    });
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    // 该凭证头在最终对象里恰好一个键(规范大小写),值是保险库的。
    const variants = Object.keys(sent).filter((k) => k.toLowerCase() === 'x-subscription-token');
    expect(variants).toEqual(['X-Subscription-Token']);
    expect(sent['X-Subscription-Token']).toBe('BSA-secret');
    // 另一条声明凭证(tavily 的 X-Api-Key)不在 brave 请求的注入范围内:
    // 意识的伪造变体也要删干净,且不注入。
    expect(Object.keys(sent).some((k) => k.toLowerCase() === 'x-api-key')).toBe(false);
  });

  it('跨域重定向时凭证头的大小写变体也不跟走', async () => {
    const { slot, fetchImpl } = makeSlot();
    fetchImpl
      .mockResolvedValueOnce(fakeResponse({ status: 302, headers: { location: 'https://api.tavily.com/next' } }))
      .mockResolvedValueOnce(fakeResponse());
    await slot.handleFetchRequest('web-search', {
      url: BRAVE_URL,
      headers: { 'x-subscription-token': 'forged-lowercase' },
    });
    const hop2 = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(Object.keys(hop2).some((k) => k.toLowerCase() === 'x-subscription-token')).toBe(false);
    expect(hop2['X-Api-Key']).toBe('Bearer tvly-secret');
  });
});

describe('networkSlot · 重定向逐跳守门', () => {
  const redirectTo = (location: string, status = 302) =>
    fakeResponse({ status, headers: { location } });

  it('白名单内重定向跟进;白名单外/非 https 阻断', async () => {
    const { slot, fetchImpl } = makeSlot();
    fetchImpl
      .mockResolvedValueOnce(redirectTo('https://api.tavily.com/next'))
      .mockResolvedValueOnce(fakeResponse({ body: '{"hop":2}' }));
    const ok = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(ok.ok && 'body' in ok).toBe(true);
    if (ok.ok && 'body' in ok) expect(ok.body).toBe('{"hop":2}');

    fetchImpl.mockReset();
    fetchImpl.mockResolvedValueOnce(redirectTo('https://evil.com/steal'));
    const blocked = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toContain('重定向');

    fetchImpl.mockReset();
    fetchImpl.mockResolvedValueOnce(redirectTo('http://api.tavily.com/x'));
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL })).ok).toBe(false);
  });

  it('跨域跳转时上一跳的凭证头被重算(brave 的 key 不跟去 tavily)', async () => {
    const { slot, fetchImpl } = makeSlot();
    fetchImpl
      .mockResolvedValueOnce(redirectTo('https://api.tavily.com/next'))
      .mockResolvedValueOnce(fakeResponse());
    await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    const hop2 = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(hop2['X-Subscription-Token']).toBeUndefined();
    expect(hop2['X-Api-Key']).toBe('Bearer tvly-secret');
  });

  it('重定向次数超上限阻断', async () => {
    const { slot, fetchImpl } = makeSlot();
    fetchImpl.mockResolvedValue(redirectTo('https://api.tavily.com/loop'));
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('次数过多');
  });
});

describe('networkSlot · 响应收敛', () => {
  it('4xx/5xx 也是 ok:true(代发成功,对方说不行);响应头只回白名单字段', async () => {
    const { slot } = makeSlot({
      fetchImpl: async () =>
        fakeResponse({
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '5', 'set-cookie': 'sid=x' },
          body: '{"error":"rate limited"}',
        }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('5');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  it('文本模式下二进制 content-type 拒(并提示 as:media);超大响应截断并标 truncated', async () => {
    const bin = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' } }),
    });
    const r1 = await bin.slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('文本');

    const huge = makeSlot({
      fetchImpl: async () =>
        fakeResponse({
          body: new TextEncoder().encode('a'.repeat(GHOST_FETCH_RESPONSE_MAX_BYTES + 100)).buffer,
        }),
    });
    const r2 = await huge.slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r2.ok && 'body' in r2).toBe(true);
    if (r2.ok && 'body' in r2) {
      expect(r2.truncated).toBe(true);
      expect(r2.body.length).toBe(GHOST_FETCH_RESPONSE_MAX_BYTES);
    }
  });

  it('流式响应按硬顶截断并取消流,不整体缓冲(防恶意白名单服务器 OOM 主进程)', async () => {
    // 模拟一个"吐不完"的流:每 chunk 64KB,远超响应上限;记录 cancel 是否被调。
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(97); // 'a'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { slot } = makeSlot({
      fetchImpl: async () =>
        ({
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: stream,
          arrayBuffer: async () => {
            throw new Error('不应整体缓冲');
          },
        }) as unknown as Response,
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok && 'body' in r).toBe(true);
    if (r.ok && 'body' in r) {
      expect(r.truncated).toBe(true);
      expect(r.body.length).toBe(GHOST_FETCH_RESPONSE_MAX_BYTES);
    }
    expect(cancelled).toBe(true);
  });

  it('大文本闸:>1MB 文本读体需占全局闸,闸被占时结构化拒绝并断流;小文本不受影响;释放后可再读', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // >1MB 的文本流(2MB 单 chunk),每次调用新建流;小请求返回缺省小 JSON。
    // 断流(reader.cancel)语义由上面的无限流测试覆盖,这里只验闸行为。
    const bigTextResponse = () => {
      let sent = false;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(new Uint8Array(2 * 1024 * 1024).fill(97));
          },
        }),
      } as unknown as Response;
    };
    const { slot } = makeSlot({
      fetchImpl: (async (url: string) => {
        if (String(url).includes('/big')) return bigTextResponse();
        if (String(url).includes('brave')) {
          return fakeResponse({ headers: { 'content-type': 'image/png' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer });
        }
        return fakeResponse();
      }) as unknown as NetworkSlotDeps['fetchImpl'],
      saveGhostMedia: (async () => {
        await gate;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    // 媒体单占住全局闸(卡在落仓)。
    const media = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((r) => setTimeout(r, 0));
    // 大文本:过门槛要闸,闸被占 → 结构化拒绝。
    const bigBusy = await slot.handleFetchRequest('web-search', { url: 'https://api.tavily.com/big' });
    expect(bigBusy.ok).toBe(false);
    if (!bigBusy.ok) expect(bigBusy.message).toContain('正忙');
    // 小文本(≤1MB)不碰闸:闸被占也照常成功。
    const small = await slot.handleFetchRequest('web-search', { url: 'https://api.tavily.com/small' });
    expect(small.ok && 'body' in small).toBe(true);
    // 闸释放后大文本可读,读完闸随请求结束释放,可连续再读。
    release();
    expect((await media).ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      const bigOk = await slot.handleFetchRequest('web-search', { url: 'https://api.tavily.com/big' });
      expect(bigOk.ok && 'body' in bigOk).toBe(true);
      if (bigOk.ok && 'body' in bigOk) expect(bigOk.body.length).toBe(2 * 1024 * 1024);
    }
  });

  it('fetch 抛错折叠为结构化失败,不异常穿透', async () => {
    const { slot } = makeSlot({
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('ECONNRESET');
  });
});

describe('networkSlot · 媒体模式(as:media,字节不进沙箱)', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const pngResponse = (headers: Record<string, string> = {}) =>
    fakeResponse({ headers: { 'content-type': 'image/png', ...headers }, body: pngBytes.buffer.slice(0) });

  it('2xx + 受支持媒体:落仓记账,返回取件单,body 不回沙箱', async () => {
    const { slot, saveGhostMedia } = makeSlot({ fetchImpl: async () => pngResponse() });
    const r = await slot.handleFetchRequest('web-search', {
      url: BRAVE_URL, as: 'media', label: '一张搜索结果图',
    });
    expect(r.ok && 'media' in r).toBe(true);
    if (r.ok && 'media' in r) {
      expect(r.media.url).toBe('cindy-media://blobs/abc.png');
      expect(r.media.ext).toBe('.png');
      expect(r.media.bytes).toBe(pngBytes.byteLength);
      expect('body' in r).toBe(false);
    }
    expect(saveGhostMedia).toHaveBeenCalledWith(
      expect.objectContaining({ ghostId: 'web-search', mimeType: 'image/png', label: '一张搜索结果图' }),
    );
    const buf = (saveGhostMedia.mock.calls[0][0] as { buffer: Uint8Array }).buffer;
    expect(Array.from(buf.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('text/plain 误报的 MP3 按 ID3 / MPEG frame 魔数恢复为 audio/mpeg', async () => {
    for (const bytes of [
      mp3WithId3(),
      new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
    ]) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body: toArrayBuffer(bytes) }),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'media' in r).toBe(true);
      expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('audio/mpeg');
    }
  });

  it('text/plain 流式 MP3 在探针边界后仍按魔数恢复', async () => {
    for (const chunks of [
      [mp3WithId3(8192)],
      [mp3WithId3(8192).subarray(0, 4096), mp3WithId3(8192).subarray(4096)],
    ]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => ({
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: stream,
        }) as unknown as Response,
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'media' in r).toBe(true);
      expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('audio/mpeg');
      const savedBytes = (saveGhostMedia.mock.calls[0][0] as { buffer: Uint8Array }).buffer;
      expect(savedBytes.byteLength).toBe(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    }
  });

  it('泛化 MIME 的媒体按魔数落仓；真实 text/plain / 缺头文本仍回落 body', async () => {
    for (const contentType of ['application/octet-stream', '']) {
      const bytes = mp3WithId3();
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers: contentType ? { 'content-type': contentType } : {}, body: toArrayBuffer(bytes) }),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'media' in r, contentType || '(empty)').toBe(true);
      expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('audio/mpeg');
    }

    for (const contentType of ['text/plain', '']) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers: contentType ? { 'content-type': contentType } : {}, body: '{"status":"processing"}' }),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'body' in r, contentType || '(empty)').toBe(true);
      if (r.ok && 'body' in r) expect(r.body).toBe('{"status":"processing"}');
      expect(saveGhostMedia).not.toHaveBeenCalled();
    }
  });

  it('UTF-8 文本跨 4 KiB 探针边界时仍可回落', async () => {
    const prefix = new Uint8Array(4095).fill(97);
    const suffix = new TextEncoder().encode('中文');
    const bytes = new Uint8Array(prefix.byteLength + suffix.byteLength);
    bytes.set(prefix);
    bytes.set(suffix, prefix.byteLength);
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes.buffer,
      }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'body' in r).toBe(true);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('application/octet-stream 的未知二进制识别失败后拒绝且不回流 body', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'application/octet-stream' }, body: zip.buffer.slice(0) }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不受总仓支持');
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('application/octet-stream 的 JSON 回落文本；未知二进制、NUL 与非法 UTF-8 拒绝', async () => {
    const json = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'application/octet-stream' }, body: '{"status":"processing"}' }),
    });
    const text = await json.slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(text.ok && 'body' in text).toBe(true);

    for (const bytes of [
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array([0x7b, 0x00, 0x7d]),
      new Uint8Array([0xc3, 0x28]),
      new Uint8Array([0xc3]),
    ]) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'application/octet-stream' }, body: bytes.buffer.slice(0) }),
      });
      expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(false);
      expect(saveGhostMedia).not.toHaveBeenCalled();
    }
  });

  it('流式短响应以截断 UTF-8 结尾时拒绝回落', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61, 0xc3]));
        controller.close();
      },
    });
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: stream,
      }) as unknown as Response,
    });
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(false);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('流式文本探针后的 NUL / 非法 UTF-8 尾部拒绝回落', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096).fill(0x61));
        controller.enqueue(new Uint8Array([0x00]));
        controller.close();
      },
    });
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: stream,
      }) as unknown as Response,
    });
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(false);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('媒体模式下空文本响应回落为空 body', async () => {
    const cases: Array<Record<string, string>> = [
      { 'content-type': 'text/plain' },
      {},
    ];
    for (const headers of cases) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers, body: new ArrayBuffer(0) }),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'body' in r).toBe(true);
      if (r.ok && 'body' in r) expect(r.body).toBe('');
      expect(saveGhostMedia).not.toHaveBeenCalled();
    }
  });

  it('流式 sniff 文本在首次小 chunk 后跨过大文本门槛时先申请全局闸', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cancelled = false;
    const { slot } = makeSlot({
      fetchImpl: async (url: string) => {
        if (url.includes('/large-text')) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status":"processing"}'));
                controller.enqueue(new Uint8Array(2 * 1024 * 1024).fill(0x61));
              },
              cancel() {
                cancelled = true;
              },
            }),
          } as unknown as Response;
        }
        return pngResponse();
      },
      saveGhostMedia: (async () => {
        await gate;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    const media = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = await slot.handleFetchRequest('web-search', {
      url: 'https://api.tavily.com/large-text',
      as: 'media',
    });
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.message).toContain('正忙');
    expect(cancelled).toBe(true);
    release();
    expect((await media).ok).toBe(true);
  });

  it('声明 video/quicktime 时接受无 ftyp 的合法首 atom', async () => {
    const mov = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76]);
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({
        headers: { 'content-type': 'video/quicktime' },
        body: toArrayBuffer(mov),
      }),
      isSupportedMediaMime: (mime) => mime === 'video/quicktime',
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'media' in r).toBe(true);
    expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('video/quicktime');
  });

  it('流式 sniff 文本在保留大 chunk 前先申请全局闸', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cancelled = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/large-text')) {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":"processing"}'));
              controller.enqueue(new Uint8Array(2 * 1024 * 1024).fill(0x61));
            },
            cancel() {
              cancelled = true;
            },
          }),
        } as unknown as Response;
      }
      return pngResponse();
    });
    const { slot } = makeSlot({
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      saveGhostMedia: (async () => {
        await gate;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    const media = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = await slot.handleFetchRequest('web-search', {
      url: 'https://api.tavily.com/large-text',
      as: 'media',
    });
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.message).toContain('正忙');
    expect(cancelled).toBe(true);
    release();
    expect((await media).ok).toBe(true);
  });
  it('声明媒体但字节不是媒体时拒绝；声明 MIME 错误时按字节类型入仓', async () => {
    const html = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' }, body: '<html>bad</html>' }),
    });
    expect((await html.slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(false);
    expect(html.saveGhostMedia).not.toHaveBeenCalled();

    const mismatch = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer }),
    });
    expect((await mismatch.slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(true);
    expect((mismatch.saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('image/jpeg');
  });

  it('正确声明的 audio/mpeg 继续走原媒体路径', async () => {
    const bytes = mp3WithId3();
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'audio/mpeg' }, body: toArrayBuffer(bytes) }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'media' in r).toBe(true);
    expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('audio/mpeg');
  });

  it('text/plain 与缺头的未知二进制不回落 body', async () => {
    for (const contentType of ['text/plain', '']) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({
          headers: contentType ? { 'content-type': contentType } : {},
          body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
        }),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok, contentType || '(empty)').toBe(false);
      expect(saveGhostMedia).not.toHaveBeenCalled();
    }
  });

  it('流式声明媒体会占用全局媒体读闸', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const streamResponse = () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          controller.close();
        },
      }),
    }) as unknown as Response;
    const { slot } = makeSlot({
      fetchImpl: async () => streamResponse(),
      saveGhostMedia: async () => {
        await blocked;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      },
    });
    const first = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain('正忙');
    release();
    expect((await first).ok).toBe(true);
  });

  it('非流式泛化媒体在 arrayBuffer 前获取读闸', async () => {
    let arrayBufferRead = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const response = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
      arrayBuffer: async () => {
        arrayBufferRead = true;
        await blocked;
        return mp3WithId3().buffer;
      },
    } as unknown as Response;
    const { slot } = makeSlot({ fetchImpl: async () => response });
    const first = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(arrayBufferRead).toBe(true);
    const second = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(second.ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
  });

  it('text/plain 小轮询响应不占媒体闸，媒体闸忙时仍正常回落文本', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/poll')) {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":"processing"}'));
              controller.close();
            },
          }),
        } as unknown as Response;
      }
      return pngResponse();
    });
    const { slot } = makeSlot({
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      saveGhostMedia: (async () => {
        await gate;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    const media = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const text = await slot.handleFetchRequest('web-search', {
      url: 'https://api.tavily.com/poll',
      as: 'media',
    });
    expect(text.ok && 'body' in text).toBe(true);
    if (text.ok && 'body' in text) expect(text.body).toBe('{"status":"processing"}');

    release();
    expect((await media).ok).toBe(true);
  });

  it('text/plain 大文本 sniff miss 仍按 50MB 文本上限截断并标记 truncated', async () => {
    const chunk = new Uint8Array(GHOST_FETCH_RESPONSE_MAX_BYTES + 17).fill(97);
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body: chunk.buffer }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'body' in r).toBe(true);
    if (r.ok && 'body' in r) {
      expect(r.body.length).toBe(GHOST_FETCH_RESPONSE_MAX_BYTES);
      expect(r.truncated).toBe(true);
    }
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('泛化 MIME 非流式媒体超 256MB 时拒绝，不保存截断文件', async () => {
    const size = GHOST_FETCH_MEDIA_MAX_BYTES + 1;
    const raw = new Uint8Array(size);
    raw.set(mp3WithId3(), 0);
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body: raw.buffer }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('媒体过大');
    expect(saveGhostMedia).not.toHaveBeenCalled();
  }, 30_000);

  it('content-length 预检对泛化 MIME 的超大响应也在读体前拒绝', async () => {
    let bodyRead = false;
    const response = {
      status: 200,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': String(GHOST_FETCH_MEDIA_MAX_BYTES + 1),
      }),
      arrayBuffer: async () => {
        bodyRead = true;
        return new ArrayBuffer(0);
      },
    };
    Object.defineProperty(response, 'body', {
      get() {
        bodyRead = true;
        return null;
      },
    });
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => response as unknown as Response,
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    expect(bodyRead).toBe(false);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('content-type 带参数/别名归一化后再判(image/jpg; charset=binary → image/jpeg)', async () => {
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/jpg; charset=binary' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'media' in r).toBe(true);
    expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe('image/jpeg');
  });

  it('媒体模式下 2xx 文本响应回落文本形态(轮询"生成中"JSON 意识看得到)', async () => {
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ body: '{"status":"processing"}' }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'body' in r).toBe(true);
    if (r.ok && 'body' in r) expect(r.body).toBe('{"status":"processing"}');
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('媒体模式下非 2xx 回落文本形态(错误 JSON 可诊断),不落仓', async () => {
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ status: 404, body: '{"error":"not found"}' }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok && 'body' in r).toBe(true);
    if (r.ok && 'body' in r) expect(r.status).toBe(404);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('2xx 的不受支持二进制(zip)整单拒:不进仓也不进沙箱', async () => {
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'application/zip' }, body: pngBytes.buffer.slice(0) }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不受总仓支持');
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('媒体超硬顶整单拒(不截断——截断的媒体是坏文件),不落仓', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(1);
    chunk.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () =>
        ({
          status: 200,
          headers: new Headers({ 'content-type': 'video/mp4' }),
          body: stream,
          arrayBuffer: async () => {
            throw new Error('不应整体缓冲');
          },
        }) as unknown as Response,
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('媒体过大');
    expect(saveGhostMedia).not.toHaveBeenCalled();
  }, 30_000);

  it('音频/模型的常见非标 mime 归一化(audio/mp3 → audio/mpeg 等)', async () => {
    for (const [wire, canonical, body] of [
      ['audio/mp3', 'audio/mpeg', new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
      ['audio/x-wav', 'audio/wav', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x64, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0])],
      ['audio/wave', 'audio/wav', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x64, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0])],
      ['audio/x-m4a', 'audio/mp4', new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0])],
    ] as const) {
      const { slot, saveGhostMedia } = makeSlot({
        fetchImpl: async () => fakeResponse({ headers: { 'content-type': wire }, body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }),
        isSupportedMediaMime: (m) => ['audio/mpeg', 'audio/wav', 'audio/mp4'].includes(m),
      });
      const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
      expect(r.ok && 'media' in r, wire).toBe(true);
      expect((saveGhostMedia.mock.calls[0][0] as { mimeType: string }).mimeType).toBe(canonical);
    }
  });

  it('content-length 预检:声明超上限直接拒,不读体不落仓', async () => {
    // 探针:precheck 拒绝路径连 response.body 属性都不该碰(ReadableStream 的
    // pull 会被预填充机制眼下就调一次,不能当探针)。
    let bodyRead = false;
    const resp = {
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4', 'content-length': String(300 * 1024 * 1024) }),
      arrayBuffer: async () => {
        bodyRead = true;
        return new ArrayBuffer(0);
      },
    };
    Object.defineProperty(resp, 'body', {
      get() {
        bodyRead = true;
        return null;
      },
    });
    const { slot, saveGhostMedia } = makeSlot({
      fetchImpl: async () => resp as unknown as Response,
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('媒体过大');
    expect(bodyRead).toBe(false);
    expect(saveGhostMedia).not.toHaveBeenCalled();
  });

  it('全局媒体读闸:同时只取一单,第二单结构化拒绝,释放后可再取', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { slot } = makeSlot({
      fetchImpl: async () => pngResponse(),
      saveGhostMedia: (async () => {
        await gate;
        return { url: 'cindy-media://blobs/abc.png', hash: 'a'.repeat(64), ext: '.png' };
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    const first = slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    await new Promise((r) => setTimeout(r, 0)); // 让第一单进入读体/落仓段
    const second = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain('正忙');
    release();
    expect((await first).ok).toBe(true);
    const third = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(third.ok).toBe(true);
  });

  it('saveGhostMedia 抛错折叠为结构化失败,在途名额释放', async () => {
    const { slot } = makeSlot({
      fetchImpl: async () => pngResponse(),
      saveGhostMedia: (async () => {
        throw new Error('磁盘写入失败');
      }) as unknown as NetworkSlotDeps['saveGhostMedia'],
    });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('磁盘写入失败');
    // 闸已释放:下一单正常。
    const { slot: ok } = makeSlot({ fetchImpl: async () => pngResponse() });
    expect((await ok.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media' })).ok).toBe(true);
  });

  it('as / label 载荷校验:未知模式拒、label 超长拒', async () => {
    const { slot } = makeSlot();
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'binary' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media', label: '' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL, as: 'media', label: 'x'.repeat(201) })).ok).toBe(false);
  });
});

describe('networkSlot · 在途并发闸', () => {
  it(`同意识在途请求达 ${GHOST_FETCH_INFLIGHT_LIMIT} 单即拒,返回后名额释放`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { slot } = makeSlot({
      fetchImpl: async () => {
        await gate;
        return fakeResponse();
      },
    });
    const pending = Array.from({ length: GHOST_FETCH_INFLIGHT_LIMIT }, () =>
      slot.handleFetchRequest('web-search', { url: BRAVE_URL }),
    );
    // 名额占满:第 N+1 单立即被拒。
    const overflow = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.message).toContain('上限');

    release();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok)).toBe(true);
    // 名额释放后可再发。
    expect((await slot.handleFetchRequest('web-search', { url: BRAVE_URL })).ok).toBe(true);
  });
});

describe('networkSlot · 登录邮箱派生凭证(source:login-email)', () => {
  const PAGES_URL = 'https://api.pages.example.com/list';

  /** xd-pages 形态的详单:X-Pages-Token = pages_<登录邮箱>(inject.format 派生)。 */
  const pagesNetwork: GhostNetworkNeeds = {
    hosts: ['api.pages.example.com'],
    secrets: [
      {
        key: 'pages_token',
        label: 'Pages 身份',
        source: 'login-email',
        inject: { header: 'X-Pages-Token', format: 'pages_{value}' },
      },
    ],
  };

  function makePagesSlot(overrides: Partial<NetworkSlotDeps> = {}) {
    return makeSlot({ getGhost: () => fakeGhost({ network: pagesNetwork }), ...overrides });
  }

  it('值取自登录邮箱并按 format 派生;不查保险库;值不回流沙箱', async () => {
    const { slot, fetchImpl, readSecret } = makePagesSlot();
    const r = await slot.handleFetchRequest('web-search', { url: PAGES_URL });
    expect(r.ok).toBe(true);
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(sent['X-Pages-Token']).toBe('pages_dev@example.com');
    expect(readSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('dev@example.com');
  });

  it('未登录 / 登录态无邮箱:fail-closed 带重登指引,不发请求', async () => {
    for (const email of [null, '', '   ']) {
      const { slot, fetchImpl } = makePagesSlot({ getLoginEmail: () => email });
      const r = await slot.handleFetchRequest('web-search', { url: PAGES_URL });
      expect(r.ok, String(email)).toBe(false);
      if (!r.ok) expect(r.message).toContain('重新登录');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('登录态邮箱形态不合法:fail-closed,不注入坏值出网;错误消息不泄邮箱原文', async () => {
    const { slot, fetchImpl } = makePagesSlot({ getLoginEmail: () => 'not-an-email' });
    const r = await slot.handleFetchRequest('web-search', { url: PAGES_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('不合法');
      // 失败路径同样守"邮箱不进沙箱"不变量:message 直达第三方意识代码。
      expect(r.message).not.toContain('not-an-email');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('邮箱首尾空白被裁剪后注入;切号后下一单即用新邮箱(现读不缓存)', async () => {
    let email = '  a@b.co  ';
    const { slot, fetchImpl } = makePagesSlot({ getLoginEmail: () => email });
    await slot.handleFetchRequest('web-search', { url: PAGES_URL });
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>)['X-Pages-Token']).toBe('pages_a@b.co');

    email = 'new@example.com';
    await slot.handleFetchRequest('web-search', { url: PAGES_URL });
    expect((fetchImpl.mock.calls[1][1].headers as Record<string, string>)['X-Pages-Token']).toBe('pages_new@example.com');
  });

  it('意识伪造 X-Pages-Token 头被剥除,最终值由主机按登录态注入', async () => {
    const { slot, fetchImpl } = makePagesSlot();
    await slot.handleFetchRequest('web-search', {
      url: PAGES_URL,
      headers: { 'x-pages-token': 'pages_forged@evil.com' },
    });
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    const variants = Object.keys(sent).filter((k) => k.toLowerCase() === 'x-pages-token');
    expect(variants).toEqual(['X-Pages-Token']);
    expect(sent['X-Pages-Token']).toBe('pages_dev@example.com');
  });
});

describe('networkSlot · 目录上传(uploadDir,过户票据)', () => {
  const DEPLOY_URL = 'https://api.search.brave.com/deploy';
  const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

  /** 两个文件的假过户货物(read 闭包回固定字节)。 */
  function fakeDeposit() {
    const enc = (s: string) => new TextEncoder().encode(s);
    return {
      totalBytes: 8,
      files: [
        { relPath: 'index.html', size: 6, read: async () => enc('<html>') },
        { relPath: 'a/b.js', size: 2, read: async () => enc('js') },
      ],
    };
  }

  it('happy path:凭票组 multipart——fields 在前、file-N filename=相对路径、octet-stream;票据单次消费', async () => {
    const takeDirDeposit = vi.fn((_g: string, token: string) => (token === VALID_TOKEN ? fakeDeposit() : null));
    const { slot, fetchImpl } = makeSlot({ takeDirDeposit });
    const r = await slot.handleFetchRequest('web-search', {
      url: DEPLOY_URL,
      method: 'POST',
      uploadDir: { token: VALID_TOKEN, fields: { name: 'my-site', preset: 'static', ip_restrict: 'true' } },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(takeDirDeposit).toHaveBeenCalledWith('web-search', VALID_TOKEN);

    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string>; body: Uint8Array };
    expect(init.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = new TextDecoder().decode(init.body);
    expect(text).toContain('name="name"\r\n\r\nmy-site');
    expect(text).toContain('name="preset"\r\n\r\nstatic');
    expect(text).toContain('name="file-0"; filename="index.html"');
    expect(text).toContain('name="file-1"; filename="a/b.js"');
    expect(text).toContain('Content-Type: application/octet-stream');
    expect(text).toContain('<html>');
    expect(text).toContain('js');
  });

  it('票据无效(伪造/已用/过期统一话术):结构化失败,不发请求', async () => {
    const { slot, fetchImpl } = makeSlot(); // 缺省 takeDirDeposit → null
    const r = await slot.handleFetchRequest('web-search', {
      url: DEPLOY_URL,
      method: 'POST',
      uploadDir: { token: VALID_TOKEN },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('票据无效');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('载荷校验:坏 token 形状 / 非 POST / 与 body/upload/as:media 互斥 / fields 超限或坏值一律拒', async () => {
    const takeDirDeposit = vi.fn(() => fakeDeposit());
    const { slot, fetchImpl } = makeSlot({ takeDirDeposit });
    const cases: Array<Record<string, unknown>> = [
      { url: DEPLOY_URL, method: 'POST', uploadDir: { token: 'not-a-uuid' } },
      { url: DEPLOY_URL, uploadDir: { token: VALID_TOKEN } }, // GET
      { url: DEPLOY_URL, method: 'POST', body: 'x', uploadDir: { token: VALID_TOKEN } },
      {
        url: DEPLOY_URL, method: 'POST',
        upload: { hashes: ['a'.repeat(64)] },
        uploadDir: { token: VALID_TOKEN },
      },
      { url: DEPLOY_URL, method: 'POST', as: 'media', uploadDir: { token: VALID_TOKEN } },
      {
        url: DEPLOY_URL, method: 'POST',
        uploadDir: { token: VALID_TOKEN, fields: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'v'])) },
      },
      { url: DEPLOY_URL, method: 'POST', uploadDir: { token: VALID_TOKEN, fields: { 'bad name': 'v' } } },
      { url: DEPLOY_URL, method: 'POST', uploadDir: { token: VALID_TOKEN, fields: { f: 'a\r\nb' } } },
      { url: DEPLOY_URL, method: 'POST', uploadDir: { token: VALID_TOKEN, fileFieldPrefix: 'bad prefix' } },
    ];
    for (const payload of cases) {
      const r = await slot.handleFetchRequest('web-search', payload);
      expect(r.ok, JSON.stringify(payload)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('读盘期间总量超限整单拒(过户后文件被撑大也兜得住)', async () => {
    // 单块恰好取目录通道的单文件上限(不触发单文件拒),块数按总量上限动态算,
    // 恰好超过总限一块——只有总量分支能拦住。原用例误用媒体上传的 64MB 常量,
    // 每块先撞单文件检查,总量分支永远走不到。
    const big = new Uint8Array(GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE);
    const count =
      Math.floor(GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES / big.byteLength) + 1;
    const takeDirDeposit = vi.fn(() => ({
      totalBytes: big.byteLength * count,
      files: Array.from({ length: count }, (_, i) => ({
        relPath: `f${i}.bin`,
        size: big.byteLength,
        read: async () => big,
      })),
    }));
    const { slot, fetchImpl } = makeSlot({ takeDirDeposit });
    const r = await slot.handleFetchRequest('web-search', {
      url: DEPLOY_URL,
      method: 'POST',
      uploadDir: { token: VALID_TOKEN },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('总体积超过限额');
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 30_000);

  it('文件名含引号/换行被消毒,不破坏 multipart 结构', async () => {
    const takeDirDeposit = vi.fn(() => ({
      totalBytes: 1,
      files: [{ relPath: 'we"ird\r\n.txt', size: 1, read: async () => new TextEncoder().encode('x') }],
    }));
    const { slot, fetchImpl } = makeSlot({ takeDirDeposit });
    const r = await slot.handleFetchRequest('web-search', {
      url: DEPLOY_URL,
      method: 'POST',
      uploadDir: { token: VALID_TOKEN },
    });
    expect(r.ok).toBe(true);
    const text = new TextDecoder().decode((fetchImpl.mock.calls[0][1] as { body: Uint8Array }).body);
    expect(text).toContain('filename="we%22ird.txt"');
  });
});

describe('networkSlot · 凭证交换(key 换令牌二段式)', () => {
  const EXCHANGE_URL = 'https://aigc.example.com/api/v1/state/token';
  const API_URL = 'https://aigc.example.com/api/v1/message';

  /** mivo 形态的交换型凭证详单(JSON body 模板 + tokenPath)。 */
  function exchangeNetwork(exchangeOverrides: Record<string, unknown> = {}): GhostNetworkNeeds {
    return {
      hosts: ['aigc.example.com'],
      secrets: [
        {
          key: 'mivo_api_key',
          label: 'Mivo Key',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          exchange: {
            url: EXCHANGE_URL,
            bodyFormat: '{"id":"","sub":"{value}","name":""}',
            tokenPath: 'session',
            ...exchangeOverrides,
          },
        },
      ],
    } as GhostNetworkNeeds;
  }

  function makeExchangeSlot(params: {
    exchangeOverrides?: Record<string, unknown>;
    rawKey?: string;
    /** 交换端点的响应序列(逐次消费,耗尽后复用最后一个)。 */
    tokenResponses?: Array<() => Response | Promise<Response>>;
    /** 业务端点的响应序列(同上)。 */
    apiResponses?: Array<() => Response | Promise<Response>>;
  } = {}) {
    const tokenResponses = params.tokenResponses ?? [
      () => fakeResponse({ body: '{"session_id":"s1","session":"tok-1"}' }),
    ];
    const apiResponses = params.apiResponses ?? [() => fakeResponse()];
    let tokenCalls = 0;
    let apiCallCount = 0;
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      void init;
      if (url === EXCHANGE_URL) {
        const make = tokenResponses[Math.min(tokenCalls, tokenResponses.length - 1)];
        tokenCalls += 1;
        return make();
      }
      const make = apiResponses[Math.min(apiCallCount, apiResponses.length - 1)];
      apiCallCount += 1;
      return make();
    });
    const readSecret = vi.fn((_ghostId: string, key: string) =>
      key === 'mivo_api_key' ? (params.rawKey ?? 'mivo-raw-key') : null,
    );
    const { slot } = makeSlot({
      getGhost: () => fakeGhost({ network: exchangeNetwork(params.exchangeOverrides) }),
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      readSecret,
    });
    return { slot, fetchImpl, readSecret };
  }

  /** fetchImpl 里发往交换端点 / 业务端点的调用清单。 */
  function exchangeCalls(fetchImpl: ReturnType<typeof vi.fn>) {
    return fetchImpl.mock.calls.filter((c) => c[0] === EXCHANGE_URL);
  }
  function apiCalls(fetchImpl: ReturnType<typeof vi.fn>) {
    return fetchImpl.mock.calls.filter((c) => c[0] !== EXCHANGE_URL);
  }

  it('首单先照单换令牌再发业务请求:注入的是令牌而非原始 key;交换体按 JSON 转义', async () => {
    const { slot, fetchImpl } = makeExchangeSlot();
    const r = await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r.ok).toBe(true);

    const ex = exchangeCalls(fetchImpl);
    expect(ex).toHaveLength(1);
    expect(ex[0][1].method).toBe('POST');
    expect(ex[0][1].headers['Content-Type']).toBe('application/json');
    expect(ex[0][1].redirect).toBe('manual');
    // 模板占位被原始 key 填充,且是合法 JSON。
    const exchangeBody = JSON.parse(ex[0][1].body as string);
    expect(exchangeBody).toEqual({ id: '', sub: 'mivo-raw-key', name: '' });

    const api = apiCalls(fetchImpl);
    expect(api).toHaveLength(1);
    expect(api[0][1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('令牌缓存:第二单不再打交换端点;用户改 key 立即重换', async () => {
    let raw = 'key-A';
    const readSecret = vi.fn((_g: string, key: string) => (key === 'mivo_api_key' ? raw : null));
    const fetchImpl = vi.fn(async (url: string) =>
      url === EXCHANGE_URL
        ? fakeResponse({ body: `{"session":"tok-of-${raw}"}` })
        : fakeResponse(),
    );
    const { slot } = makeSlot({
      getGhost: () => fakeGhost({ network: exchangeNetwork() }),
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      readSecret,
    });

    await slot.handleFetchRequest('web-search', { url: API_URL });
    await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(exchangeCalls(fetchImpl)).toHaveLength(1);

    raw = 'key-B'; // 用户在设置页换了 key → sourceValue 失配,下一单重换
    await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(exchangeCalls(fetchImpl)).toHaveLength(2);
    const lastApi = apiCalls(fetchImpl).at(-1)!;
    expect(lastApi[1].headers.Authorization).toBe('Bearer tok-of-key-B');
  });

  it('ttl 过期后重换(声明 ttlSeconds 生效)', async () => {
    vi.useFakeTimers();
    try {
      const { slot, fetchImpl } = makeExchangeSlot({ exchangeOverrides: { ttlSeconds: 60 } });
      await slot.handleFetchRequest('web-search', { url: API_URL });
      expect(exchangeCalls(fetchImpl)).toHaveLength(1);

      vi.setSystemTime(Date.now() + 30_000); // 未过期:仍走缓存
      await slot.handleFetchRequest('web-search', { url: API_URL });
      expect(exchangeCalls(fetchImpl)).toHaveLength(1);

      vi.setSystemTime(Date.now() + 31_000); // 过期:重换
      await slot.handleFetchRequest('web-search', { url: API_URL });
      expect(exchangeCalls(fetchImpl)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上游 401:作废缓存重换令牌,整链重试一次成功', async () => {
    const { slot, fetchImpl } = makeExchangeSlot({
      tokenResponses: [
        () => fakeResponse({ body: '{"session":"tok-stale"}' }),
        () => fakeResponse({ body: '{"session":"tok-fresh"}' }),
      ],
      apiResponses: [
        () => fakeResponse({ status: 401, body: '{"error":"expired"}' }),
        () => fakeResponse({ body: '{"ok":1}' }),
      ],
    });
    const r = await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r.ok).toBe(true);
    if (r.ok && 'body' in r) expect(r.status).toBe(200);
    expect(exchangeCalls(fetchImpl)).toHaveLength(2);
    const api = apiCalls(fetchImpl);
    expect(api).toHaveLength(2);
    expect(api[0][1].headers.Authorization).toBe('Bearer tok-stale');
    expect(api[1][1].headers.Authorization).toBe('Bearer tok-fresh');
  });

  it('重换后仍 401:不再重试,401 响应原样回给意识(意识据此提示用户 key 无效)', async () => {
    const { slot, fetchImpl } = makeExchangeSlot({
      apiResponses: [() => fakeResponse({ status: 401, body: '{"error":"bad key"}' })],
    });
    const r = await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r.ok).toBe(true);
    if (r.ok && 'body' in r) {
      expect(r.status).toBe(401);
      expect(r.body).toContain('bad key');
    }
    expect(apiCalls(fetchImpl)).toHaveLength(2); // 恰好重试一次,不无限循环
    expect(exchangeCalls(fetchImpl)).toHaveLength(2);
  });

  it('非交换型凭证遇 401 不触发重试(老行为不变)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 401, body: '{"e":1}' }));
    const { slot } = makeSlot({ fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'] });
    const r = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(r.ok).toBe(true);
    if (r.ok && 'body' in r) expect(r.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('交换端点非 2xx:整单结构化失败,错误带状态码与摘录、不发业务请求、不泄 key', async () => {
    const { slot, fetchImpl } = makeExchangeSlot({
      tokenResponses: [() => fakeResponse({ status: 403, body: 'invalid subscriber' })],
    });
    const r = await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('403');
      expect(r.message).toContain('invalid subscriber');
      expect(r.message).not.toContain('mivo-raw-key');
    }
    expect(apiCalls(fetchImpl)).toHaveLength(0);
  });

  it('交换响应缺 tokenPath 字段 / 不是 JSON:结构化失败', async () => {
    const missing = makeExchangeSlot({
      tokenResponses: [() => fakeResponse({ body: '{"nope":1}' })],
    });
    const r1 = await missing.slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('tokenPath');

    const notJson = makeExchangeSlot({
      tokenResponses: [() => fakeResponse({ body: '<html>oops</html>' })],
    });
    const r2 = await notJson.slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('JSON');
  });

  it('交换端点返回重定向:阻断(令牌端点没有跳转的正当理由)', async () => {
    const { slot, fetchImpl } = makeExchangeSlot({
      tokenResponses: [
        () => fakeResponse({ status: 302, headers: { location: 'https://evil.com/steal' }, body: '' }),
      ],
    });
    const r = await slot.handleFetchRequest('web-search', { url: API_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('重定向');
    expect(apiCalls(fetchImpl)).toHaveLength(0);
  });

  it('JSON 转义:key 含引号/反斜杠不破坏模板结构;form 模式走 percent 编码', async () => {
    const trickyKey = 'we"ird\\key';
    const json = makeExchangeSlot({ rawKey: trickyKey });
    await json.slot.handleFetchRequest('web-search', { url: API_URL });
    const jsonBody = JSON.parse(exchangeCalls(json.fetchImpl)[0][1].body as string);
    expect(jsonBody.sub).toBe(trickyKey);

    // $ 序列回归:字符串形态 replace 会解释 $& / $` / $',key 含 $ 必须原样进 body。
    for (const dollarKey of ['ab$&cd', 'p$`q', "$'z", 'a$1b']) {
      const d = makeExchangeSlot({ rawKey: dollarKey });
      await d.slot.handleFetchRequest('web-search', { url: API_URL });
      const body = JSON.parse(exchangeCalls(d.fetchImpl)[0][1].body as string);
      expect(body.sub, dollarKey).toBe(dollarKey);
      // 注入头里的令牌同样不受 $ 解释影响(inject.format 函数式替换)。
      const api = apiCalls(d.fetchImpl)[0];
      expect(api[1].headers.Authorization).toBe('Bearer tok-1');
    }

    const form = makeExchangeSlot({
      rawKey: 'a&b=c',
      exchangeOverrides: {
        bodyFormat: 'grant_type=key&key={value}',
        contentType: 'application/x-www-form-urlencoded',
        tokenPath: 'session',
      },
    });
    await form.slot.handleFetchRequest('web-search', { url: API_URL });
    const formCall = exchangeCalls(form.fetchImpl)[0][1];
    expect(formCall.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(formCall.body).toBe('grant_type=key&key=a%26b%3Dc');
  });

  it('单飞:并发两单只发一次交换,共用同一张令牌', async () => {
    let resolveToken!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => (resolveToken = resolve));
    const { slot, fetchImpl } = makeExchangeSlot({
      tokenResponses: [() => gate, () => gate],
    });
    const p1 = slot.handleFetchRequest('web-search', { url: API_URL });
    const p2 = slot.handleFetchRequest('web-search', { url: API_URL });
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 让两单都走到交换等待点
    resolveToken(fakeResponse({ body: '{"session":"tok-shared"}' }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(exchangeCalls(fetchImpl)).toHaveLength(1);
    for (const call of apiCalls(fetchImpl)) {
      expect(call[1].headers.Authorization).toBe('Bearer tok-shared');
    }
  });
});

describe('networkSlot · 上传通道(upload,字节不进沙箱)', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const UPLOAD_URL = 'https://api.search.brave.com/api/v1/file/';

  /** 两条已知媒体的假总仓:HASH_A=png 3 字节,HASH_B=mp4 5 字节;其余 null。 */
  function fakeMediaStore(): NetworkSlotDeps['readGhostMedia'] {
    return async (_ghostId: string, hash: string) => {
      if (hash === HASH_A) {
        return { buffer: new Uint8Array([1, 2, 3]), mimeType: 'image/png', ext: '.png' };
      }
      if (hash === HASH_B) {
        return { buffer: new Uint8Array([9, 9, 9, 9, 9]), mimeType: 'video/mp4', ext: '.mp4' };
      }
      return null;
    };
  }

  function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): { text: string; init: { headers: Record<string, string>; method: string; body: Uint8Array } } {
    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string>; method: string; body: Uint8Array };
    return { text: new TextDecoder().decode(init.body), init };
  }

  it('主路径:验归属读字节,代组 multipart(字段名/文件名/分界符齐全),Content-Type 主机独占', async () => {
    const readGhostMedia = vi.fn(fakeMediaStore());
    const { slot, fetchImpl } = makeSlot({ readGhostMedia });
    const r = await slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // 意识乱塞的 content-type 必须被覆盖
      upload: { hashes: [HASH_A, HASH_B] },
    });
    expect(r.ok).toBe(true);
    expect(readGhostMedia).toHaveBeenCalledWith('web-search', HASH_A);
    expect(readGhostMedia).toHaveBeenCalledWith('web-search', HASH_B);

    const { text, init } = bodyOf(fetchImpl);
    expect(init.method).toBe('POST');
    const boundaryMatch = /^multipart\/form-data; boundary=(----cindy-ghost-[0-9a-f-]+)$/.exec(init.headers['Content-Type']);
    expect(boundaryMatch, init.headers['Content-Type']).toBeTruthy();
    const boundary = boundaryMatch![1];
    // 两个 part + 收尾分界符;字段名缺省 file;文件名 = 指纹前 16 位 + 总仓后缀。
    expect(text).toContain(`Content-Disposition: form-data; name="file"; filename="${HASH_A.slice(0, 16)}.png"`);
    expect(text).toContain(`Content-Disposition: form-data; name="file"; filename="${HASH_B.slice(0, 16)}.mp4"`);
    expect(text).toContain('Content-Type: image/png');
    expect(text).toContain('Content-Type: video/mp4');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // 文件字节原样在体内(3 字节 png 的 \x01\x02\x03)。
    expect(Array.from(init.body).join(',')).toContain('1,2,3');
  });

  it('field 自定义生效;凭证注入照旧走同一条请求', async () => {
    const { slot, fetchImpl } = makeSlot({ readGhostMedia: fakeMediaStore() });
    const r = await slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL,
      method: 'POST',
      upload: { hashes: [HASH_A], field: 'attachment' },
    });
    expect(r.ok).toBe(true);
    const { text, init } = bodyOf(fetchImpl);
    expect(text).toContain('name="attachment"');
    // brave 声明凭证命中本域名:X-Subscription-Token 照常注入。
    expect(init.headers['X-Subscription-Token']).toBe('BSA-secret');
  });

  it('越权/不存在的指纹:统一话术整单拒,不发请求', async () => {
    const { slot, fetchImpl } = makeSlot({ readGhostMedia: fakeMediaStore() });
    const r = await slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL,
      method: 'POST',
      upload: { hashes: ['c'.repeat(64)] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不存在或不属于本意识');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('载荷校验:非 POST/与 body 互斥/与 as:media 互斥/坏指纹/重复指纹/超条数/坏 field 一律拒', async () => {
    const { slot, fetchImpl } = makeSlot({ readGhostMedia: fakeMediaStore() });
    const bads: Array<Record<string, unknown>> = [
      { url: UPLOAD_URL, upload: { hashes: [HASH_A] } }, // 缺省 GET
      { url: UPLOAD_URL, method: 'DELETE', upload: { hashes: [HASH_A] } },
      { url: UPLOAD_URL, method: 'POST', body: '{}', upload: { hashes: [HASH_A] } },
      { url: UPLOAD_URL, method: 'POST', as: 'media', upload: { hashes: [HASH_A] } },
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: [] } },
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: ['not-a-hash'] } },
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A.toUpperCase()] } }, // 大写拒
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A, HASH_A] } }, // 重复
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: Array.from({ length: 5 }, (_, i) => String(i).repeat(64).slice(0, 64)) } },
      { url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A], field: 'bad field!' } },
      { url: UPLOAD_URL, method: 'POST', upload: 'yes' },
    ];
    for (const payload of bads) {
      const r = await slot.handleFetchRequest('web-search', payload);
      expect(r.ok, JSON.stringify(payload)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('体积护栏:单文件超限拒;总量超限拒', async () => {
    const big = new Uint8Array(GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE + 1);
    const single = makeSlot({
      readGhostMedia: async () => ({ buffer: big, mimeType: 'image/png', ext: '.png' }),
    });
    const r1 = await single.slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A] },
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('单文件上限');

    // 每个 60MB × 3 = 180MB > 128MB 总量顶。
    const chunk = new Uint8Array(60 * 1024 * 1024);
    const total = makeSlot({
      readGhostMedia: async () => ({ buffer: chunk, mimeType: 'image/png', ext: '.png' }),
    });
    const r2 = await total.slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL, method: 'POST',
      upload: { hashes: [HASH_A, HASH_B, 'c'.repeat(64)] },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('总量超上限');
  });

  it('全局媒体闸:上传在途时第二单上传被拒;结束后释放', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { slot } = makeSlot({
      readGhostMedia: fakeMediaStore(),
      fetchImpl: (async () => {
        await gate;
        return fakeResponse();
      }) as unknown as NetworkSlotDeps['fetchImpl'],
    });
    const p1 = slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A] },
    });
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 让 p1 拿到闸
    const r2 = await slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_B] },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('正忙');

    release();
    expect((await p1).ok).toBe(true);
    // 闸已释放:再来一单成功。
    const r3 = await slot.handleFetchRequest('web-search', {
      url: UPLOAD_URL, method: 'POST', upload: { hashes: [HASH_A] },
    });
    expect(r3.ok).toBe(true);
  });
});

describe('networkSlot · 多连接(connections,动态白名单 + 按 host 注入)', () => {
  /** 连接声明 + 静态白名单并存的详单(gitlab 声明由用户在设置页添加地址)。 */
  const CONN_NETWORK: GhostNetworkNeeds = {
    hosts: ['api.search.brave.com'],
    secrets: [
      {
        key: 'brave_api_key',
        label: 'Brave Key',
        inject: { header: 'X-Subscription-Token', format: '{value}', hosts: ['api.search.brave.com'] },
      },
    ],
    connections: [
      { key: 'gitlab', label: 'GitLab 实例', inject: { header: 'Private-Token', format: '{value}' } },
    ],
  };
  /** 纯连接详单(hosts 为空——connections 在场时校验允许):动态地址是唯一放行域。 */
  const CONN_ONLY_NETWORK: GhostNetworkNeeds = {
    hosts: [],
    connections: [
      { key: 'gitlab', label: 'GitLab 实例', inject: { header: 'Private-Token', format: 'Bearer {value}' } },
    ],
  };
  /** connections deps 假体:host → token 的固定映射(null = 未添加/token 缺失)。 */
  const connDeps = (
    tokens: Record<string, string | null>,
    inject: { header: string; format: string } = { header: 'Private-Token', format: '{value}' },
  ): NonNullable<NetworkSlotDeps['connections']> => ({
    hostsFor: () => Object.keys(tokens),
    tokenFor: (_ghostId, hostname) => {
      const value = tokens[hostname];
      return value === null || value === undefined ? null : { value, ...inject };
    },
  });

  it('用户添加的连接地址放行并注入该地址自己的 token;意识伪造的同名头被覆盖', async () => {
    const { slot, fetchImpl } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_NETWORK }),
      connections: connDeps({ 'gitlab.example.com': 'glpat-real' }),
    });
    const r = await slot.handleFetchRequest('web-search', {
      url: 'https://gitlab.example.com/api/v4/projects',
      headers: { 'private-token': 'forged' },
    });
    expect(r.ok).toBe(true);
    const sent = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(sent['Private-Token']).toBe('glpat-real');
    // 伪造值的大小写变体已被删干净(凭证头主机独占)。
    expect(sent['private-token']).toBeUndefined();
    // 静态白名单域名照旧走 secrets 注入,不吃连接 token。
    const brave = await slot.handleFetchRequest('web-search', { url: BRAVE_URL });
    expect(brave.ok).toBe(true);
    const sentBrave = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(sentBrave['X-Subscription-Token']).toBe('BSA-secret');
    expect(sentBrave['Private-Token']).toBeUndefined();
  });

  it('连接地址精确匹配:未添加的地址/子域/近似域一律拒(静态白名单外)', async () => {
    const { slot, fetchImpl } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_ONLY_NETWORK }),
      connections: connDeps({ 'gitlab.example.com': 'glpat-real' }),
    });
    for (const url of [
      'https://other.example.com/x',
      'https://sub.gitlab.example.com/x', // 连接地址不吃通配,子域不放行
      'https://evil-gitlab.example.com/x',
    ]) {
      const r = await slot.handleFetchRequest('web-search', { url });
      expect(r.ok, url).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain('白名单');
        // 带"去设置页添加连接"指引(声明了 connections 的意识专属话术)。
        expect(r.message).toContain('添加');
      }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('连接 token 读不到(半身位)快速失败,不发请求', async () => {
    const { slot, fetchImpl } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_ONLY_NETWORK }),
      connections: connDeps({ 'gitlab.example.com': null }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: 'https://gitlab.example.com/api/v4/user' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('重新添加');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deps.connections 未注入时连接声明 fail-closed:动态地址不放行', async () => {
    const { slot, fetchImpl } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_ONLY_NETWORK }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: 'https://gitlab.example.com/api/v4/user' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('白名单');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('跨连接地址重定向:逐跳重验放行域,并换注目标地址自己的 token', async () => {
    // 与 makeSlot 内部同款宽类型(mock.calls 才能按 [url, init] 下标取参)。
    const fetchImpl: ReturnType<typeof vi.fn> = vi.fn(
      async () => fakeResponse({ status: 302, headers: { location: 'https://b.example.com/next' } }),
    );
    fetchImpl.mockImplementationOnce(
      async () => fakeResponse({ status: 302, headers: { location: 'https://b.example.com/next' } }),
    );
    fetchImpl.mockImplementationOnce(async () => fakeResponse());
    const { slot } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_ONLY_NETWORK }),
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      connections: connDeps({ 'a.example.com': 'token-a', 'b.example.com': 'token-b' }, { header: 'Private-Token', format: '{value}' }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: 'https://a.example.com/start' });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    const secondHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(firstHeaders['Private-Token']).toBe('token-a');
    // 第二跳注入的是 b.example.com 自己的 token,a 的绝不跟着走。
    expect(secondHeaders['Private-Token']).toBe('token-b');
  });

  it('重定向到未添加的地址被阻断(连接地址并入逐跳白名单重验)', async () => {
    const fetchImpl = vi.fn(
      async () => fakeResponse({ status: 302, headers: { location: 'https://evil.example.com/next' } }),
    );
    const { slot } = makeSlot({
      getGhost: () => fakeGhost({ network: CONN_ONLY_NETWORK }),
      fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
      connections: connDeps({ 'a.example.com': 'token-a' }),
    });
    const r = await slot.handleFetchRequest('web-search', { url: 'https://a.example.com/start' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('重定向');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

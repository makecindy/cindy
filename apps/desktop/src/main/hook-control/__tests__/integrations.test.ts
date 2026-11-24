/**
 * 测试价值
 * - 生产入口与可观察结果: createIntegrationsDirectory().start() 读取 GET /integrations 后,
 *   isOffered() 决定官方 Telegram / Discord 入口是否可见, onChange 触发设置页快照重发;
 *   fetchOfficialGroupImage() 把群历史图片请求发到 integrationsBaseUrl 下的 /telegram/group-image。
 * - 规则依据: 端点清单只留 integrationsBaseUrl 一个地址, 入口显示改由服务端开关决定;
 *   server-channel-review.md(启动读一次、有界重试、不轮询)。
 * - 现有覆盖缺口: 新模块; 群图片请求原先没有任何测试, 入参从 WebSocket 地址改成 https 根地址。
 * - 最小失败输入: 服务端还是旧版本(404)时 Telegram 入口消失; 503 后无限重试; 列表里有本版本
 *   不认识的应用时整份作废。群图片一条是对外协议: 路径或请求体一变, 服务端的
 *   POST /telegram/group-image 就收不到请求。
 * - tier: unit(注入 fetch 与假定时器, 不连真实服务)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOfficialGroupImage } from '../groupImageBridge';
import { createIntegrationsDirectory, type OfficialIntegration } from '../integrationsDirectory';

const BASE = 'https://integrations.example.test';
const RETRY_DELAYS_MS = [1_000, 2_000];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(responses: Array<Response | Error>, base = BASE) {
  const fetchImpl = vi.fn(async (_input: string | URL | Request) => {
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const onChange = vi.fn();
  const directory = createIntegrationsDirectory({
    getBaseUrl: () => base,
    onChange,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retryDelaysMs: RETRY_DELAYS_MS,
    log: { warn: () => {} },
  });
  const offered = () =>
    (['telegram', 'discord'] as const).filter((id: OfficialIntegration) => directory.isOffered(id));
  return { directory, fetchImpl, onChange, offered };
}

describe('integrations directory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads GET /integrations once per process and ignores apps this build does not know', async () => {
    const { directory, fetchImpl, onChange, offered } = setup([json({ integrations: ['discord', 'github'] })]);
    directory.start();
    directory.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE}/integrations`);
    expect(offered()).toEqual(['discord']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Response, OfficialIntegration[]]>([
    ['the server lists both', json({ integrations: ['telegram', 'discord'] }), ['telegram', 'discord']],
    ['the server predates the endpoint (404)', json({ error: { code: 'NOT_FOUND' } }, 404), ['telegram']],
    ['the server lists nothing', json({ integrations: [] }), []],
  ])('shows official entries when %s', async (_label, response, expected) => {
    const { directory, offered } = setup([response]);
    directory.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(offered()).toEqual(expected);
  });

  it('retries network errors, 5xx and malformed bodies on the fixed schedule until one succeeds', async () => {
    const { directory, fetchImpl, offered } = setup([
      new TypeError('fetch failed'),
      json({ error: { code: 'NOT_READY' } }, 503),
      json({ integrations: ['telegram'] }),
    ]);
    directory.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(offered()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]!);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(offered()).toEqual(['telegram']);
  });

  it('stops after the last retry instead of polling', async () => {
    const { directory, fetchImpl, offered } = setup([
      new TypeError('fetch failed'),
      new Response('<html>gateway</html>', { status: 200 }),
      json({ error: { code: 'INTERNAL' } }, 500),
    ]);
    directory.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
    expect(offered()).toEqual([]);
  });

  it('sends nothing when the manifest has no integrations address, and dispose cancels a pending retry', async () => {
    const unconfigured = setup([], '');
    unconfigured.directory.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unconfigured.fetchImpl).not.toHaveBeenCalled();

    const failing = setup([new TypeError('fetch failed')]);
    failing.directory.start();
    await vi.advanceTimersByTimeAsync(0);
    failing.directory.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('official group image address', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 协议: 服务端只在 POST /telegram/group-image 接收 { token }; 改路径或请求体会让群历史图片全部读不到。
  it('posts to /telegram/group-image under the integrations base address', async () => {
    const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = await fetchOfficialGroupImage(BASE, 'jwt', 'proof');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/telegram/group-image`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'proof' }) });
    expect(bytes).toEqual(Buffer.from([1, 2, 3]));
  });
});

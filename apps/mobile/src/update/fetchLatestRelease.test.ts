import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease, probeBetaChannel } from './fetchLatestRelease';

const BASE = 'https://ota.example.com';
const resp = (status: number, json?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => json ?? {},
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 断言请求 URL = 期望前缀 + `&t=<时间戳>`。
 * 刻意不用 `new RegExp` 拼含 host 的字符串:URL 里的 `.` 在正则里是通配,
 * 会匹配到别的主机(CodeQL js/incomplete-hostname-regexp)。
 */
function expectCacheBustedUrl(url: unknown, prefix: string): void {
  expect(typeof url).toBe('string');
  const bustPrefix = `${prefix}&t=`;
  expect(String(url).startsWith(bustPrefix)).toBe(true);
  expect(String(url).slice(bustPrefix.length)).toMatch(/^\d+$/);
}

describe('fetchLatestRelease —— 区分"无更新"与"连不上"', () => {
  it('非自建变体(baseUrl 为空)→ null,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLatestRelease('ios', 8000, '')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 → 返回 JSON 记录', async () => {
    const fetchMock = vi.fn(async () => resp(200, { runtimeVersion: 'rtv1', version: '1.2.0' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLatestRelease('ios', 8000, BASE)).resolves.toEqual({ runtimeVersion: 'rtv1', version: '1.2.0' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expectCacheBustedUrl(url, `${BASE}/latest?platform=ios`);
  });

  it('canary/beta 显式追加 channel，release URL 保持旧契约', async () => {
    const fetchMock = vi.fn(async () => resp(200, { runtimeVersion: 'rtv1' }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchLatestRelease('android', 8000, BASE, 'canary');
    let [url] = fetchMock.mock.calls[0] as unknown as [string];
    expectCacheBustedUrl(url, `${BASE}/latest?platform=android&channel=canary`);
    await fetchLatestRelease('android', 8000, BASE, 'beta');
    [url] = fetchMock.mock.calls[1] as unknown as [string];
    expectCacheBustedUrl(url, `${BASE}/latest?platform=android&channel=beta`);
  });

  it('一律绕缓存:每次请求都带 cache-buster + no-cache 头', async () => {
    // 可变指针 + 原地改 minVersion:边缘旧副本两个方向都会错判(误挡 / 误放行),
    // 所以四条调用路径统一不吃缓存。
    const fetchMock = vi.fn(async () => resp(200, { runtimeVersion: 'rtv1' }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchLatestRelease('ios', 8000, BASE);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expectCacheBustedUrl(url, `${BASE}/latest?platform=ios`);
    expect(init.headers).toEqual({ accept: 'application/json', 'cache-control': 'no-cache' });
  });

  it('404(服务端确认暂无记录)→ null(= 无更新)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(404)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).resolves.toBeNull();
  });

  it('500 / 502(服务异常)→ 抛错,不当成"无更新"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(500)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/HTTP 500/);
    vi.stubGlobal('fetch', vi.fn(async () => resp(502)));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/HTTP 502/);
  });

  it('网络错误 → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));
    await expect(fetchLatestRelease('ios', 8000, BASE)).rejects.toThrow(/Network request failed/);
  });
});

describe('probeBetaChannel —— 打开 beta 前的可用性探测', () => {
  it('404(无 beta 记录)视为不可达——「未部署」与「未发版本」不可区分,都不该开', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(404)));
    await expect(probeBetaChannel('ios', 8000, BASE)).resolves.toBe(false);
  });

  it('200 返回记录视为可达', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { runtimeVersion: 'rtv1' })));
    await expect(probeBetaChannel('android', 8000, BASE)).resolves.toBe(true);
  });

  it('5xx / 网络失败视为不可达', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(500)));
    await expect(probeBetaChannel('ios', 8000, BASE)).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));
    await expect(probeBetaChannel('ios', 8000, BASE)).resolves.toBe(false);
  });

  it('非自建变体(baseUrl 为空)不可达', async () => {
    await expect(probeBetaChannel('ios', 8000, '')).resolves.toBe(false);
  });
});

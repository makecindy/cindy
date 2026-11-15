/**
 * 测试价值
 * - 生产入口：AcmeClient.obtainCertificate；观察申请证书时网络抖动后的结果与错误分类。
 * - Bug/规则依据：2026-10-29 实机，国内服务器连 Let's Encrypt 偶发失败，一次 `fetch failed` 就让整轮申请失败，
 *   部署方随即回滚；错误也无法和「CA 拒绝验证」区分。
 * - 现有覆盖缺口：certificates.test.ts 把 AcmeClient 整个替换掉，没有任何用例经过 ACME 请求本身。
 * - 最小失败输入：目录请求与一次签名 POST 各断一次网；或 CA 一直连不上。
 * - tier：unit；CA 为进程内 fetch 桩，重试等待注入为立即返回，无网络、无真实等待。
 * - 单文件实测：0.50 秒（2 例，测试体 9ms，Windows）。
 */
import { expect, it, vi } from 'vitest';
import { AcmeClient, AcmeError, AcmeNetworkError, createAccountKey } from '../acme';

const CA = 'https://ca.invalid';
const directory = { newNonce: `${CA}/nonce`, newAccount: `${CA}/account`, newOrder: `${CA}/order` };

function networkError(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

function client(fetchImpl: typeof fetch, sleep = vi.fn(async () => {})) {
  return { sleep, acme: new AcmeClient({ directoryUrl: `${CA}/directory`, accountKey: createAccountKey(), fetchImpl, sleep }) };
}

it('retries network blips and surfaces the certificate authority’s own answer', async () => {
  const failOnce = new Set([`GET ${CA}/directory`, `POST ${CA}/account`]);
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    if (failOnce.delete(key)) throw networkError('ECONNRESET');
    const nonce = { 'Replay-Nonce': 'nonce' };
    if (key === `GET ${CA}/directory`) return new Response(JSON.stringify(directory));
    if (key === `HEAD ${CA}/nonce`) return new Response(null, { headers: nonce });
    if (key === `POST ${CA}/account`) return new Response('{}', { status: 201, headers: { ...nonce, Location: `${CA}/acct/1` } });
    return new Response(JSON.stringify({ type: 'urn:ietf:params:acme:error:rejectedIdentifier', detail: 'not allowed' }), {
      status: 400,
      headers: nonce,
    });
  }) as unknown as typeof fetch;
  const { acme, sleep } = client(fetchImpl);
  const error = await acme.obtainCertificate({ type: 'ip', value: '203.0.113.10' }, new Map()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AcmeError);
  expect(error).not.toBeInstanceOf(AcmeNetworkError);
  expect((error as Error).message).toContain('rejectedIdentifier');
  expect(sleep).toHaveBeenCalledTimes(2);
});

it('reports an unreachable certificate authority as a transient error with the network cause', async () => {
  const fetchImpl = vi.fn(async () => {
    throw networkError('ETIMEDOUT');
  }) as unknown as typeof fetch;
  const { acme } = client(fetchImpl);
  const error = await acme.obtainCertificate({ type: 'ip', value: '203.0.113.10' }, new Map()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AcmeNetworkError);
  expect(error).toMatchObject({ transient: true, message: expect.stringContaining('ETIMEDOUT') });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

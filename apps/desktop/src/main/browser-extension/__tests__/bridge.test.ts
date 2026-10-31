/**
 * bridge.test — 浏览器扩展桥接的线协议回归(从插件时期的协议测试迁入宿主)。
 *
 * 测试价值
 * - 生产入口与可观察结果:BrowserExtensionBridge 的真实 HTTP 监听 + act/setTrustedClients/relay*
 *   方法;扩展看到的 /health、/poll、/ack、/authorize、/result、/learning/* 状态码与载荷。
 * - Bug/规则依据:插件 my-browser 0.4.x 的桥接合同(一次送达、unknown 不重投、结果脱敏、
 *   官方身份须 native 绑定);桥接迁入宿主后这些合同必须逐条保持。站点名单 2026-10-30 取消。
 * - 现有覆盖缺口:宿主此前没有这条链路。
 * - 最小失败输入:见各用例(重复 ack、旧插件推送的名单、带凭证的 tabs URL 等)。
 * - tier:unit(真实回环 socket,端口 0,无外部进程);实测耗时约 1 秒。
 */

import crypto, { webcrypto } from 'node:crypto';
import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserExtensionBridge, type BrowserExtensionRelayNotice } from '../bridge';
import {
  checkBrowserExtensionTarget,
  normalizeBrowserExtensionHost,
  redactBrowserUrl,
  validateBrowserExtensionJob,
} from '../policy';

const EXT_ID = 'a'.repeat(32);
const STORE_ID = 'b'.repeat(32);
const WIRE = '0.4.13';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bridges: BrowserExtensionBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
});

async function credential() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: false };
  const publicKey = Buffer.from(JSON.stringify(publicJwk)).toString('base64url');
  const sign = async (challenge: string) =>
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(challenge),
      ),
    ).toString('base64url');
  return { publicKey, publicJwk, sign };
}

interface ClientOptions {
  browser?: 'chrome' | 'edge' | 'safari';
  extensionId?: string;
  origin?: string;
  paired?: boolean;
  native?: boolean;
}

async function fixture(
  options: ConstructorParameters<typeof BrowserExtensionBridge>[0] extends infer O
    ? Partial<O>
    : never = {},
) {
  const relays: BrowserExtensionRelayNotice[] = [];
  const nativeToken = 'd'.repeat(64);
  const bridge = new BrowserExtensionBridge({
    ghostId: 'my-browser',
    installedVersion: '0.5.0',
    extensionIds: [EXT_ID, STORE_ID],
    nativeToken,
    ports: [0],
    pollTimeout: 20,
    connectWait: 0,
    jobTimeout: 200,
    onRelay: (n) => relays.push(n),
    ...options,
  });
  bridges.push(bridge);
  const status = await bridge.status();
  if (!status.ok) throw new Error('bridge did not start');
  const url = 'http://127.0.0.1:' + status.port;
  const pinned: Array<{ id: string; origin: string; extensionId: string; publicKey: string }> = [];
  async function client(opts: ClientOptions = {}) {
    const browser = opts.browser ?? 'chrome';
    const extensionId = opts.extensionId ?? EXT_ID;
    const origin = opts.origin ?? 'chrome-extension://' + extensionId;
    const id = crypto.randomUUID();
    const key = await credential();
    let session: string | undefined;
    const headers = (extra: Record<string, string> = {}) => ({
      'X-My-Browser-Extension': extensionId,
      'X-My-Browser-Origin': origin,
      'X-My-Browser-Client': id,
      'X-My-Browser-Version': WIRE,
      'X-My-Browser-Family': browser,
      'X-My-Browser-Key': key.publicKey,
      ...(session ? { 'X-My-Browser-Session': session } : {}),
      ...extra,
    });
    const request = async (route: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await fetch(url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: headers(extra),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // 线协议回复是松散 JSON,测试按字段断言;用 any 保留与扩展侧同样的读取方式。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, ...(await r.json()) } as { status: number; [key: string]: any };
    };
    const record = { id, origin, extensionId, publicKey: JSON.stringify(key.publicJwk) };
    const pair = async () => {
      pinned.push(record);
      bridge.setTrustedClients([...pinned]);
    };
    if (opts.paired) await pair();
    const health = async () => {
      let r = await request('/health');
      if (r.challenge)
        r = await request('/health', undefined, {
          'X-My-Browser-Proof': await key.sign(r.challenge),
        });
      if (opts.native !== false && r.native_binding_required) {
        await fetch(url + '/native/bind', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + nativeToken },
          body: JSON.stringify({ clientId: id, origin, publicKey: key.publicKey }),
        });
        r = await request('/health');
        if (r.challenge)
          r = await request('/health', undefined, {
            'X-My-Browser-Proof': await key.sign(r.challenge),
          });
      }
      session = r.session;
      return r;
    };
    const signed = async (route: string, body?: unknown, extra: Record<string, string> = {}) => {
      const challenge = await request('/learning/challenge');
      const method = body === undefined ? 'GET' : 'POST';
      const serialized = body === undefined ? '' : JSON.stringify(body);
      const digest = Buffer.from(
        await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)),
      ).toString('base64url');
      const proof = await key.sign(
        challenge.challenge + '\\n' + method + '\\n' + route + '\\n' + digest,
      );
      return request(route, body, {
        ...extra,
        'X-My-Browser-Learning-Challenge': challenge.challenge,
        'X-My-Browser-Proof': proof,
      });
    };
    const useSession = (value: string | undefined) => {
      session = value;
    };
    return { id, origin, extensionId, request, health, pair, signed, useSession, key };
  }
  /** 配对好的默认客户端:已 health、已 poll 一次(建立长轮询等待)。 */
  async function ready() {
    const c = await client({ paired: true });
    await c.health();
    await c.request('/poll');
    return c;
  }
  return { bridge, url, client, ready, relays, nativeToken };
}

describe('policy · 地址校验与 URL 脱敏', () => {
  it('任何网页地址都放行(含本机与私网);带凭证地址与非网页协议拒绝;主机名规范化', () => {
    for (const url of ['https://example.test', 'http://127.0.0.2', 'http://[::1]', 'http://10.2.3.4', 'http://jira'])
      for (const action of ['text', 'click'])
        expect(checkBrowserExtensionTarget(action, url).ok, `${action} ${url}`).toBe(true);
    for (const url of ['file:///etc/passwd', 'https://a:b@example.test', 'chrome://settings'])
      expect(checkBrowserExtensionTarget('text', url).ok, url).toBe(false);
    expect(checkBrowserExtensionTarget('nope', 'https://example.test')).toMatchObject({ error: 'INVALID_ACTION' });
    // The tabs host filter still takes a plain domain.
    expect(normalizeBrowserExtensionHost(' WWW.Example.test ')).toBe('www.example.test');
    for (const bad of ['https://example.test', 'example.test/path', 'example.test:443', '*'])
      expect(() => normalizeBrowserExtensionHost(bad)).toThrow();
    // Site recipes may send any DevTools method; there is no per-recipe allowlist (2026-10-30).
    expect(() =>
      validateBrowserExtensionJob('cdp', { url: 'https://example.test', tabId: 1, op: 'command', method: 'Storage.getCookies' }),
    ).not.toThrow();
  });

  // 2026-10-30: any attribute can be extracted, as in Cindy's own browser; only the name is checked.
  it('提取任意属性名;载荷校验保留空文本与空选项', () => {
    for (const attr of ['href', 'role', 'data-csrf-token', 'value', 'xlink:href']) {
      expect(() =>
        validateBrowserExtensionJob('extract', {
          url: 'https://example.test',
          fields: { value: { selector: 'p', attr } },
        }),
      ).not.toThrow();
    }
    for (const attr of ['', 'a b', '1x', '<x>']) {
      expect(() =>
        validateBrowserExtensionJob('extract', {
          url: 'https://example.test',
          fields: { value: { selector: 'p', attr } },
        }),
      ).toThrow();
    }
    expect(() =>
      validateBrowserExtensionJob('type', {
        url: 'https://example.test',
        selector: 'input',
        text: '',
      }),
    ).not.toThrow();
    expect(() =>
      validateBrowserExtensionJob('select', {
        url: 'https://example.test',
        selector: 'select',
        values: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateBrowserExtensionJob('extract', { url: 'https://example.test', fields: {} }),
    ).toThrow();
  });

  it('URL 脱敏抹掉 OAuth code、重置令牌、fragment 令牌与 Basic Auth,保留普通深路径', () => {
    const code = '11111111-1111-4111-8111-111111111111';
    const token = '33333333-3333-4333-8333-333333333333';
    expect(redactBrowserUrl(`https://example.test/callback?q=cats&code=${code}`)).not.toContain(
      code,
    );
    expect(redactBrowserUrl(`https://example.test/callback?q=cats&code=${code}`)).toMatch(/q=cats/);
    expect(
      redactBrowserUrl(`https://example.test/#access_token=${token}&token_type=bearer`),
    ).not.toContain(token);
    expect(
      redactBrowserUrl(
        `https://example.test/reset/${encodeURIComponent(encodeURIComponent(code))}`,
      ),
    ).not.toContain(code);
    expect(redactBrowserUrl(`https://${code}:${token}@example.test/private`)).toBe(
      'https://example.test/private',
    );
    expect(
      redactBrowserUrl(`https://example.test/cb?next=${encodeURIComponent('/reset/' + code)}`),
    ).not.toContain(code);
    expect(redactBrowserUrl('https://example.test/commit/' + 'a'.repeat(40))).toBe(
      'https://example.test/commit/' + 'a'.repeat(40),
    );
    expect(redactBrowserUrl('https://example.test/cb?page=2&sort=name')).toBe(
      'https://example.test/cb?page=2&sort=name',
    );
    expect(redactBrowserUrl('https://example.test/#/home')).toBe('https://example.test/#/home');
    expect(redactBrowserUrl('not a url')).toBe('not a url');
  });
});

describe('bridge · 连接与身份', () => {
  it('冷启动并发 status 只开一个监听;未连接时动作快速失败', async () => {
    const { bridge } = await fixture();
    const statuses = await Promise.all(Array.from({ length: 8 }, () => bridge.status()));
    expect(new Set(statuses.map((s) => (s.ok ? s.port : -1))).size).toBe(1);
    expect(statuses[0]).toMatchObject({ ok: true, extension_connected: false });
    const result = await bridge.act('text', { url: 'https://example.test' });
    expect(result).toMatchObject({ error: 'EXTENSION_DISCONNECTED', execution: 'not_executed' });
  });

  // Review 2026-10-29: a caller still holding a closed bridge reopened an ownerless listener the
  // extension could connect to after the plugin was disabled or replaced.
  it('关闭后的桥接不会被 status/act 重新拉起', async () => {
    const { bridge } = await fixture();
    await bridge.close();
    expect(await bridge.status()).toMatchObject({ ok: false, error: 'BRIDGE_STOPPED' });
    expect(await bridge.act('text', { url: 'https://example.test' })).toMatchObject({
      ok: false,
      error: 'BRIDGE_STOPPED',
      execution: 'not_executed',
    });
    expect(bridge.listeningPort).toBe(0);
  });

  it('回环 HTTP 拒绝网页、预检、改绑 Host、旧会话与任意端点', async () => {
    const { url, ready } = await fixture();
    const c = await ready();
    expect((await fetch(url + '/health')).status).toBe(403);
    expect((await c.request('/health', undefined, { Origin: 'https://example.test' })).status).toBe(
      403,
    );
    const rebound = await new Promise<number>((resolve) => {
      const req = http.get(
        url + '/health',
        { headers: { Host: 'example.test', 'X-My-Browser-Extension': EXT_ID } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(0));
    });
    expect(rebound).toBe(403);
    expect(
      (
        await fetch(url + '/health', {
          method: 'OPTIONS',
          headers: { 'X-My-Browser-Extension': EXT_ID },
        })
      ).status,
    ).toBe(403);
    expect((await c.request('/poll', undefined, { 'X-My-Browser-Session': 'old' })).status).toBe(
      409,
    );
    expect((await c.request('/act', { action: 'click' })).status).toBe(404);
  });

  // Review 2026-10-30 (Codex P1): a plugin could pair any extension id it pushed.
  it('插件推送的配对只接受清单里钉死的扩展 id', async () => {
    const { bridge } = await fixture();
    bridge.setTrustedClients([
      { id: 'c1', origin: 'chrome-extension://' + EXT_ID, extensionId: EXT_ID, publicKey: 'k' },
      { id: 'c2', origin: 'chrome-extension://' + 'z'.repeat(32), extensionId: 'z'.repeat(32), publicKey: 'k' },
    ]);
    const status = await bridge.status();
    expect(status.extension_ids).toEqual([EXT_ID, STORE_ID]);
    // Only the listed extension is kept as a pin: the unknown one never becomes trusted.
    expect((bridge as unknown as { pins: Array<{ extensionId: string }> }).pins.map((p) => p.extensionId)).toEqual([EXT_ID]);
  });

  it('官方扩展经 native 绑定后无需手工配对即可认证;伪造调用方不能自称官方', async () => {
    const { bridge, client } = await fixture();
    for (const extensionId of [EXT_ID, STORE_ID]) {
      const browser = await client({ extensionId });
      const unsigned = await browser.request('/health');
      expect(unsigned.session).toBeUndefined();
      const status = await bridge.status();
      expect(status.ok && status.clients.find((c) => c.id === browser.id)?.identitySupported).toBe(
        true,
      );
      expect((await browser.request('/poll')).status).toBe(409);
      const first = await browser.health();
      expect(first.pairing_required).toBe(false);
      expect(first.session).toBeTruthy();
      expect(first.plugin).toBe('my-browser');
      expect(first.installedVersion).toBe('0.5.0');
      expect((await browser.request('/learning/challenge')).status).toBe(200);
      bridge.setTrustedClients([]);
      expect((await browser.request('/poll')).status).toBe(200);
      expect((await browser.health()).session).toBe(first.session);
    }
    const forged = await client({ native: false });
    const health = await forged.health();
    expect(health.session).toBeUndefined();
    expect(health.native_binding_required).toBe(true);
    expect((await forged.request('/poll')).status).toBe(409);
    expect((await forged.request('/native/bind', { clientId: forged.id })).status).toBe(403);
    const status = await bridge.status();
    expect(status.ok && status.extension_connected).toBe(true);
    expect(bridge.connectedClients().some((c) => c.id === forged.id)).toBe(false);
  });

  it('未知 Chromium 扩展身份不会被静默信任;Safari 身份需经显式配对', async () => {
    const { bridge, client } = await fixture();
    const unknown = await client({ browser: 'edge', extensionId: 'z'.repeat(32) });
    expect((await unknown.health()).pairing_required).toBe(true);
    const status = await bridge.status();
    expect(status.ok && status.clients[0].identitySupported).toBe(false);
    const safari = await client({
      browser: 'safari',
      extensionId: 'com.example.browser.Extension',
      origin: 'safari-web-extension://' + crypto.randomUUID(),
    });
    expect((await safari.health()).pairing_required).toBe(true);
    await safari.pair();
    const r = await safari.health();
    expect(r.pairing_required).toBe(false);
    expect(r.session).toBeTruthy();
    bridge.setTrustedClients([]);
    expect((await safari.request('/poll')).status).toBe(409);
  });

  it('Chrome 与 Edge 作业绑定到各自连接;多连接且未指定 browser 时绝不猜', async () => {
    const { bridge, client } = await fixture();
    const chrome = await client();
    const edge = await client({ browser: 'edge', extensionId: STORE_ID });
    await chrome.health();
    await edge.health();
    expect(await bridge.act('text', { url: 'https://example.test' })).toMatchObject({
      error: 'BROWSER_REQUIRED',
    });
    const done = bridge.act('text', { url: 'https://example.test', browser: edge.id });
    expect((await chrome.request('/poll')).job).toBeNull();
    const { job } = await edge.request('/poll');
    expect(job).toBeTruthy();
    expect((await chrome.request('/ack', { id: job.id })).status).toBe(409);
    expect((await edge.request('/ack', { id: job.id })).ok).toBe(true);
    expect(
      (await chrome.request('/result', { id: job.id, result: { ok: true, text: 'wrong' } })).status,
    ).toBe(409);
    await edge.request('/result', {
      id: job.id,
      result: { ok: true, url: 'https://example.test', text: 'correct' },
    });
    const r = await done;
    expect(r).toMatchObject({ text: 'correct', browser: edge.id, untrusted_content: true });
    expect((r.timing as { totalMs: number }).totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe('bridge · 作业生命周期', () => {
  it('poll/ack/result 真实往返;重复 ack 被拒', async () => {
    const { bridge, ready } = await fixture();
    const c = await ready();
    const promise = bridge.act('text', { url: 'https://example.test' });
    await sleep(5);
    const { job } = await c.request('/poll');
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.action).toBe('text');
    expect((await c.request('/ack', { id: job.id })).ok).toBe(true);
    expect((await c.request('/ack', { id: job.id })).status).toBe(409);
    await c.request('/result', {
      id: job.id,
      result: { ok: true, url: 'https://example.test', text: 'Hello' },
    });
    expect((await promise).text).toBe('Hello');
    const status = await bridge.status();
    expect(status.ok && status.pending).toBe(0);
  });

  // Re-review 2026-10-29: jobs queued while the browser restarted were delivered to whatever tab
  // had the same number in the new session.
  it('浏览器重启(启动 id 变化)时结束它排队中的作业,不投递到新会话', async () => {
    const { bridge, ready } = await fixture();
    const c = await ready();
    await c.request('/health', undefined, { 'X-My-Browser-Boot': '11111111-1111-1111-1111-111111111111' });
    const pending = bridge.act('text', { url: 'https://example.test' });
    await sleep(5);
    await c.request('/health', undefined, { 'X-My-Browser-Boot': '22222222-2222-2222-2222-222222222222' });
    expect(await pending).toMatchObject({ ok: false, error: 'BROWSER_RESTARTED', execution: 'not_executed' });
    expect((await c.request('/poll')).job ?? null).toBeNull();
  });

  it('已确认的交互超时记为 unknown 且绝不重投;未确认的过期作业不能再执行', async () => {
    const { bridge, ready } = await fixture({ jobTimeout: 80 });
    const c = await ready();
    const resultPromise = bridge.act('click', { url: 'https://example.test', selector: 'button' });
    await sleep(5);
    const { job } = await c.request('/poll');
    await c.request('/ack', { id: job.id });
    expect((await resultPromise).execution).toBe('unknown');
    expect((await c.request('/poll')).job).toBeNull();
    expect((await c.request('/result', { id: job.id, result: { ok: true } })).status).toBe(409);
    const queued = await bridge.act('text', { url: 'https://example.test' });
    expect(queued.execution).toBe('not_executed');
    const promise = bridge.act('text', { url: 'https://example.test' });
    await sleep(5);
    const delivered = (await c.request('/poll')).job;
    expect((await promise).execution).toBe('not_executed');
    expect((await c.request('/ack', { id: delivered.id })).status).toBe(409);
  });

  // 2026-10-30: site lists are gone. A plugin of the site-list era still pushes one; it is acknowledged
  // and blocks nothing. Addresses come back whole, as in Cindy's own browser.
  it('旧插件推送的站点名单不再生效;标签页地址原样返回', async () => {
    const { bridge, ready } = await fixture();
    const c = await ready();
    expect(
      bridge.setPolicy({ read: { block: ['example.test'] }, interact: { allow: [], block: [] } }),
    ).toMatchObject({ ok: true, policy: { read: { block: [] }, interact: { allow: ['*'] } } });
    const p = bridge.act('tabs', {});
    await sleep(5);
    const { job } = await c.request('/poll');
    expect((await c.request('/ack', { id: job.id })).policy).toMatchObject({ read: { block: [] } });
    await c.request('/result', {
      id: job.id,
      result: {
        tabs: [
          { id: 1, url: 'https://example.test?code=11111111-1111-4111-8111-111111111111', title: 'mail' },
          { id: 2, url: 'chrome://settings', title: 'settings' },
        ],
      },
    });
    const tabs = (await p).tabs as Array<Record<string, unknown>>;
    expect(tabs[0].title).toBe('mail');
    expect(tabs[0].url).toContain('11111111');
    expect(tabs[1]).toEqual({ id: 2, redacted: true });
    const clicked = bridge.act('click', { url: 'https://example.test', selector: 'button' });
    await sleep(5);
    const delivered = (await c.request('/poll')).job;
    expect((await c.request('/ack', { id: delivered.id })).ok).toBe(true);
    expect((await c.request('/authorize', { id: delivered.id, url: 'https://example.test' })).ok).toBe(true);
    await c.request('/result', { id: delivered.id, result: { ok: true, execution: 'executed' } });
    expect((await clicked).ok).toBe(true);
  });

  // Review 2026-10-30 (Codex P1): a relayed answer from a plugin is bounded before it is held.
  it('插件返回的转交结果过大时改为结构化失败', async () => {
    const { bridge, ready } = await fixture();
    const c = await ready();
    const job = { id: crypto.randomUUID(), request: { op: 'translate', text: 'hello', source: { url: 'https://example.test/' } } };
    expect((await c.signed('/learning/start', job)).ok).toBe(true);
    expect(bridge.relayResult(job.id, { ok: true, translations: ['x'.repeat(9_000_000)] })).toEqual({ ok: true });
    const answer = await c.signed('/learning/result', { id: job.id });
    expect(answer.done).toBe(true);
    expect(answer.result).toMatchObject({ ok: false, error: 'RESULT_TOO_LARGE' });
  });

  // Review 2026-10-30 (Codex P1): debugger events are [method, params] tuples and must stay arrays.
  it('cdp 事件列表保留元组形状并按数量封顶', async () => {
    const { bridge, ready } = await fixture();
    const c = await ready();
    const pending = bridge.act('cdp', { url: 'https://example.test', tabId: 1, op: 'events' });
    await sleep(5);
    const { job } = await c.request('/poll');
    await c.request('/ack', { id: job.id });
    await c.request('/result', {
      id: job.id,
      result: { ok: true, events: Array.from({ length: 5200 }, (_, i) => ['Network.responseReceived', { requestId: String(i) }]) },
    });
    const result = await pending;
    const events = result.events as Array<unknown>;
    expect(events).toHaveLength(5000);
    expect(Array.isArray(events[0])).toBe(true);
    expect((events[0] as [string, unknown])[0]).toBe('Network.responseReceived');
    expect(result.truncated).toBe(true);
  });

  // Review 2026-10-30 (Codex P2): every read result is bounded, not only extract records.
  it('requests / links / text 等读取结果也有数量与大小上限', async () => {
    // The result body is about 31 MB; a loaded CI runner needs far longer than the default 200 ms.
    const { bridge, ready } = await fixture({ jobTimeout: 20000 });
    const c = await ready();
    const pending = bridge.act('requests', { url: 'https://example.test', tabId: 1 });
    await sleep(5);
    const { job } = await c.request('/poll');
    await c.request('/ack', { id: job.id });
    await c.request('/result', {
      id: job.id,
      result: {
        ok: true,
        requests: Array.from({ length: 1500 }, (_, i) => ({ url: 'https://example.test/' + i, note: 'n'.repeat(20000) })),
        text: 't'.repeat(900_000),
      },
    });
    const result = await pending;
    const requests = result.requests as Array<{ url: string; note: string }>;
    expect(requests).toHaveLength(1000);
    expect(requests[0].note.length).toBe(8192);
    expect((result.text as string).length).toBe(400_000);
    expect(result.truncated).toBe(true);
  });

  it('提取结果按最终预算截断,链接要么完整要么省略;__proto__ 字段按自有属性保留', async () => {
    const { bridge, ready } = await fixture({ jobTimeout: 3000 });
    const c = await ready();
    const url = 'https://example.test/?q=' + 'x'.repeat(280);
    const record = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['field' + i, url]));
    expect(url.length * 30).toBeGreaterThan(6000);
    const promise = bridge.act('extract', {
      url: 'https://example.test',
      fields: { link: 'a' },
      multiple: true,
    });
    await sleep(5);
    const { job } = await c.request('/poll');
    await c.request('/ack', { id: job.id });
    await c.request('/result', {
      id: job.id,
      result: {
        ok: true,
        url: 'https://example.test',
        truncated: false,
        records: [record, record],
        count: 2,
      },
    });
    const result = await promise;
    const values = (result.records as Array<Record<string, string | null>>).flatMap((row) =>
      Object.values(row),
    );
    expect(values.reduce((n, v) => n + (v?.length || 0), 0)).toBeLessThanOrEqual(6000);
    expect(result.truncated).toBe(true);
    expect(values.every((v) => v === null || v === url)).toBe(true);
    const single = bridge.act('extract', {
      url: 'https://example.test',
      fields: { text: 'p' },
      maxChars: 256,
    });
    await sleep(5);
    const next = (await c.request('/poll')).job;
    await c.request('/ack', { id: next.id });
    await c.request('/result', {
      id: next.id,
      result: {
        ok: true,
        record: JSON.parse('{"__proto__":"kept","text":"' + 't'.repeat(300) + '","missing":null}'),
      },
    });
    const bounded = await single;
    const row = bounded.record as Record<string, unknown>;
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect((row as { text: string }).text.length).toBe(252);
    expect(bounded.truncated).toBe(true);
  });
});

describe('bridge · 转交请求(翻译/字幕)', () => {
  it('转交请求必须由配对密钥签名;去重、进度投影、取消与策略撤销都按合同', async () => {
    const { bridge, ready, relays } = await fixture();
    const c = await ready();
    const job = {
      id: crypto.randomUUID(),
      // view: the tab the request came from; per-tab subtitle state depends on it reaching the plugin.
      request: { op: 'translate', text: 'hello', view: 'tab:12', source: { url: 'https://example.test/' } },
    };
    expect(
      (await c.request('/learning/start', job, { Origin: 'https://example.test' })).status,
    ).toBe(403);
    expect((await c.request('/learning/start', job)).status).toBe(403);
    expect((await c.signed('/learning/start', job)).ok).toBe(true);
    await c.signed('/learning/start', job);
    expect(relays).toHaveLength(1);
    expect(relays[0]).toMatchObject({
      id: job.id,
      clientId: c.id,
      request: { op: 'translate', text: 'hello', view: 'tab:12' },
    });
    // 改动请求体后旧证明失效。
    const challenge = await c.request('/learning/challenge');
    const body = { id: crypto.randomUUID(), request: { op: 'config' } };
    const digest = Buffer.from(
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))),
    ).toString('base64url');
    const proof = await c.key.sign(challenge.challenge + '\\nPOST\\n/learning/start\\n' + digest);
    expect(
      (
        await c.request(
          '/learning/start',
          { ...body, request: { op: 'config', text: 'tampered' } },
          { 'X-My-Browser-Learning-Challenge': challenge.challenge, 'X-My-Browser-Proof': proof },
        )
      ).status,
    ).toBe(403);
    expect(bridge.relayActive(job.id).active).toBe(true);
    bridge.relayProgress(job.id, { stage: 'model', attempt: 2, prompt: 'must not escape' });
    const progress = (await c.signed('/learning/result', { id: job.id })).progress;
    expect(progress).toMatchObject({ stage: 'model', attempt: 2 });
    expect(progress.prompt).toBeUndefined();
    bridge.relayProgress(job.id, { stage: 'untrusted arbitrary text' });
    expect((await c.signed('/learning/result', { id: job.id })).progress.stage).toBe('model');
    expect(bridge.relayResult(job.id, { ok: true, translations: ['你好'] })).toEqual({ ok: true });
    expect(await c.signed('/learning/result', { id: job.id })).toMatchObject({
      done: true,
      result: { translations: ['你好'] },
    });
    const config = { id: crypto.randomUUID(), request: { op: 'config' } };
    await c.signed('/learning/start', config);
    await c.signed('/learning/cancel', { id: config.id });
    expect(bridge.relayResult(config.id, { ok: true }).ok).toBe(false);
    expect(
      (await c.signed('/learning/start', { id: 'bad', request: { op: 'config' } })).status,
    ).toBe(400);
    expect(
      (await c.signed('/learning/start', { id: crypto.randomUUID(), request: { op: 'nope' } }))
        .status,
    ).toBe(400);
  });
});

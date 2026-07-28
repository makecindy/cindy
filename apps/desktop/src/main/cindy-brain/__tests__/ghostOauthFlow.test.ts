/**
 * ghostOauthFlow 单测:通用声明式 OAuth 引擎(规则 14,零 Electron)。
 * 假浏览器 = 测试进程直接 HTTP 请求 loopback 回调端口;假 token 端点 = 注入
 * fetchImpl。凭证字节断言只在测试夹具内流转。
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  cancelActiveGhostOauthFlow,
  fetchGhostOauthAvatar,
  fetchGhostOauthIdentity,
  refreshGhostOauthToken,
  startGhostOauthFlow,
  type GhostOauthBrokerClient,
  type GhostOauthClientConfig,
} from '../ghostOauthFlow.js';

const BASE_CONFIG: GhostOauthClientConfig = {
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  scopes: ['read:a', 'write:b'],
  clientId: 'client-123',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 从 openExternal 捕获的授权 URL 中提取回调地址与 state,模拟浏览器完成授权。 */
function browserRedirect(authorizeUrl: string, params: (u: URL) => Record<string, string>): void {
  const url = new URL(authorizeUrl);
  const redirectUri = url.searchParams.get('redirect_uri');
  if (!redirectUri) throw new Error('authorize URL 缺 redirect_uri');
  const cb = new URL(redirectUri);
  for (const [k, v] of Object.entries(params(url))) cb.searchParams.set(k, v);
  // 不 await:引擎在 race 回调,fire-and-forget 即可;失败让测试超时暴露。
  setImmediate(() => {
    void fetch(cb.toString()).catch(() => undefined);
  });
}

/** 探一个当前空闲的 loopback 端口(探测与后续使用之间有极小竞态,可接受)。 */
async function probeFreePort(): Promise<number> {
  const probe = http.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  await new Promise((r) => probe.close(r));
  return port;
}

describe('startGhostOauthFlow', () => {
  it('happy path:PKCE + state 校验 + code 换 token', async () => {
    let capturedAuthorizeUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      // PKCE:verifier 的 S256 必须等于授权 URL 里的 challenge。
      const challenge = new URL(capturedAuthorizeUrl).searchParams.get('code_challenge');
      const verifier = form.get('code_verifier');
      expect(verifier).toBeTruthy();
      const derived = createHash('sha256')
        .update(verifier ?? '')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(derived).toBe(challenge);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('code-abc');
      expect(form.get('client_id')).toBe('client-123');
      expect(form.get('client_secret')).toBeNull();
      expect(String(input)).toBe(BASE_CONFIG.tokenUrl);
      return jsonResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'read:a',
      });
    });

    const result = await startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: (url) => {
        capturedAuthorizeUrl = url;
        const u = new URL(url);
        expect(u.searchParams.get('response_type')).toBe('code');
        expect(u.searchParams.get('scope')).toBe('read:a write:b');
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        browserRedirect(url, (au) => ({
          code: 'code-abc',
          state: au.searchParams.get('state') ?? '',
        }));
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.accessToken).toBe('at-1');
      expect(result.bundle.refreshToken).toBe('rt-1');
      expect(result.bundle.grantedScope).toBe('read:a');
      expect(result.bundle.expiresAt).toBeGreaterThan(Date.now());
      // 60s 安全余量已扣除。
      expect(result.bundle.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    }
  });

  it('clientSecret 提供时进表单;extra 参数上 URL 且保留参数不可覆盖', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      expect(form.get('client_secret')).toBe('sec-xyz');
      return jsonResponse({ access_token: 'at-2' });
    });

    const result = await startGhostOauthFlow({
      config: {
        ...BASE_CONFIG,
        clientSecret: 'sec-xyz',
        extraAuthorizeParams: {
          access_type: 'offline',
          audience: 'api.example.com',
          client_id: 'EVIL-OVERRIDE',
          state: 'EVIL-STATE',
        },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get('access_type')).toBe('offline');
        expect(u.searchParams.get('audience')).toBe('api.example.com');
        // 保留参数不被意识声明顶掉。
        expect(u.searchParams.get('client_id')).toBe('client-123');
        expect(u.searchParams.get('state')).not.toBe('EVIL-STATE');
        browserRedirect(url, (au) => ({
          code: 'c2',
          state: au.searchParams.get('state') ?? '',
        }));
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 服务商没发 refresh token / expires_in 时的降级形态。
      expect(result.bundle.refreshToken).toBeNull();
      expect(result.bundle.expiresAt).toBeNull();
    }
  });

  it('pkce:false 时不带 challenge、不发 verifier', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      expect(form.get('code_verifier')).toBeNull();
      return jsonResponse({ access_token: 'at-3' });
    });

    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: (url) => {
        expect(new URL(url).searchParams.get('code_challenge')).toBeNull();
        browserRedirect(url, (au) => ({ code: 'c3', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result.ok).toBe(true);
  });

  it('state 不匹配 → CALLBACK_INVALID,不碰 token 端点', async () => {
    const fetchImpl = vi.fn();
    const result = await startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: (url) => {
        browserRedirect(url, () => ({ code: 'c4', state: 'forged-state' }));
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'CALLBACK_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('授权服务器回 error 参数 → CALLBACK_INVALID', async () => {
    const result = await startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: (url) => {
        browserRedirect(url, () => ({ error: 'access_denied' }));
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'CALLBACK_INVALID' });
  });

  it("error 含 $' 等替换模式字符: 失败页占位符不泄漏、HTML 照常转义(回归: 函数替换器)", async () => {
    let bodyText = '';
    const result = await startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: (url) => {
        const u = new URL(url);
        const cb = new URL(u.searchParams.get('redirect_uri') ?? '');
        cb.searchParams.set('error', "$'<b>x</b>$&");
        setImmediate(() => {
          void fetch(cb.toString(), { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
            .then(async (r) => {
              bodyText = await r.text();
            })
            .catch(() => undefined);
        });
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'CALLBACK_INVALID' });
    await vi.waitFor(() => expect(bodyText.length).toBeGreaterThan(0));
    expect(bodyText).not.toContain('{detail}'); // $ 模式展开会把占位符字面量漏出来
    expect(bodyText).not.toContain('<b>'); // HTML 仍被转义
    expect(bodyText).toContain('&lt;b&gt;');
    expect(bodyText).toContain('授权服务器返回错误'); // Accept-Language 命中中文
  });

  it('超时 → TIMEOUT', async () => {
    const result = await startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: () => undefined,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ ok: false, error: 'TIMEOUT' });
  });

  it('cancelActiveGhostOauthFlow → CANCELLED', async () => {
    const pending = startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: () => {
        setImmediate(() => cancelActiveGhostOauthFlow());
      },
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'CANCELLED' });
  });

  it('第二单顶掉在途第一单', async () => {
    let secondDone: Promise<unknown> = Promise.resolve();
    const first = startGhostOauthFlow({
      config: BASE_CONFIG,
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-5' })) as unknown as typeof fetch,
      openExternal: () => {
        // 第一单拉起浏览器后,立刻发起第二单。
        secondDone = startGhostOauthFlow({
          config: BASE_CONFIG,
          fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-6' })) as unknown as typeof fetch,
          openExternal: (url2) => {
            browserRedirect(url2, (au) => ({ code: 'c6', state: au.searchParams.get('state') ?? '' }));
          },
        });
      },
    });
    await expect(first).resolves.toMatchObject({ ok: false, error: 'CANCELLED' });
    await expect(secondDone).resolves.toMatchObject({ ok: true });
  });

  it('token 端点非 2xx → EXCHANGE_FAILED,摘要不含凭证', async () => {
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, clientSecret: 'super-secret' },
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: 'invalid_client', error_description: 'bad client' }, 401),
      ) as unknown as typeof fetch,
      openExternal: (url) => {
        browserRedirect(url, (au) => ({ code: 'c7', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'EXCHANGE_FAILED' });
    if (!result.ok) {
      expect(result.detail).toContain('invalid_client');
      expect(result.detail ?? '').not.toContain('super-secret');
    }
  });

  it('redirectPort:回调钉死声明端口(Atlassian 精确匹配场景)', async () => {
    // 先探一个空闲端口再钉给引擎(端口探测与 listen 之间有极小竞态,可接受)。
    const probe = http.createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise((r) => probe.close(r));

    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false, redirectPort: freePort },
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-fixed' })) as unknown as typeof fetch,
      openExternal: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${freePort}/callback`);
        browserRedirect(url, (au) => ({ code: 'c-fixed', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('redirectPort 被占用 → LISTEN_FAILED,detail 带端口号人话提示', async () => {
    const blocker = http.createServer();
    const heldPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      const openExternal = vi.fn();
      const result = await startGhostOauthFlow({
        config: { ...BASE_CONFIG, redirectPort: heldPort },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      });
      expect(result).toMatchObject({ ok: false, error: 'LISTEN_FAILED' });
      if (!result.ok) expect(result.detail).toContain(String(heldPort));
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('钉死端口:第二单顶掉第一单后立刻复用同一端口(自家僵尸监听自愈,无需回收器)', async () => {
    const fixedPort = await probeFreePort();
    let secondDone: Promise<unknown> = Promise.resolve();
    const first = startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: () => {
        // 第一单占着钉死端口等回调时,第二单同端口进场——必须等到第一单的
        // 监听真正关闭后成功 listen,而不是 LISTEN_FAILED。
        secondDone = startGhostOauthFlow({
          config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort },
          fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-heal' })) as unknown as typeof fetch,
          openExternal: (url2) => {
            browserRedirect(url2, (au) => ({ code: 'c-heal', state: au.searchParams.get('state') ?? '' }));
          },
        });
      },
    });
    await expect(first).resolves.toMatchObject({ ok: false, error: 'CANCELLED' });
    await expect(secondDone).resolves.toMatchObject({ ok: true });
  });

  it('钉死端口:第二单还在排队时第三单进场——前两单 CANCELLED,最后一单赢', async () => {
    const fixedPort = await probeFreePort();
    let secondDone: Promise<unknown> = Promise.resolve();
    let thirdDone: Promise<unknown> = Promise.resolve();
    const neverOpen = vi.fn();
    const first = startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: () => {
        // 第二单进场(排队等第一单收尾),紧接着第三单进场顶掉排队中的第二单。
        secondDone = startGhostOauthFlow({
          config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort },
          fetchImpl: vi.fn() as unknown as typeof fetch,
          openExternal: neverOpen,
        });
        thirdDone = startGhostOauthFlow({
          config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort },
          fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-third' })) as unknown as typeof fetch,
          openExternal: (url3) => {
            browserRedirect(url3, (au) => ({ code: 'c-third', state: au.searchParams.get('state') ?? '' }));
          },
        });
      },
    });
    await expect(first).resolves.toMatchObject({ ok: false, error: 'CANCELLED' });
    await expect(secondDone).resolves.toMatchObject({ ok: false, error: 'CANCELLED' });
    await expect(thirdDone).resolves.toMatchObject({ ok: true });
    // 排队期即被顶掉的单不该拉起浏览器(不弹无主授权页)。
    expect(neverOpen).not.toHaveBeenCalled();
  });

  it('redirectPort 被外部占用:reclaimPort 回收成功后自动重试并完成授权', async () => {
    const blocker = http.createServer();
    const heldPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const reclaimPort = vi.fn(async (p: number) => {
      expect(p).toBe(heldPort);
      // 模拟"强杀占用进程":关掉占用监听后放行重试。
      await new Promise((r) => blocker.close(r));
      return true;
    });
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false, redirectPort: heldPort },
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-reclaim' })) as unknown as typeof fetch,
      openExternal: (url) => {
        browserRedirect(url, (au) => ({ code: 'c-reclaim', state: au.searchParams.get('state') ?? '' }));
      },
      reclaimPort,
    });
    expect(result).toMatchObject({ ok: true });
    expect(reclaimPort).toHaveBeenCalledTimes(1);
  });

  it('redirectPort 被外部占用且 reclaimPort 回收失败 → LISTEN_FAILED,不拉浏览器', async () => {
    const blocker = http.createServer();
    const heldPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      const openExternal = vi.fn();
      const reclaimPort = vi.fn(async () => false);
      const result = await startGhostOauthFlow({
        config: { ...BASE_CONFIG, redirectPort: heldPort },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
        reclaimPort,
      });
      expect(result).toMatchObject({ ok: false, error: 'LISTEN_FAILED' });
      if (!result.ok) expect(result.detail).toContain(String(heldPort));
      expect(reclaimPort).toHaveBeenCalledTimes(1);
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('tokenBroker:code 交给 broker,不直连 token 端点;PKCE 缺省开,verifier 透传 broker', async () => {
    const fetchImpl = vi.fn();
    let challengeFromUrl: string | null = null;
    const broker: GhostOauthBrokerClient = {
      exchange: vi.fn(
        async (slug: string, params: { code: string; redirectUri: string; codeVerifier?: string }) => {
          expect(slug).toBe('jira');
          expect(params.code).toBe('c-broker');
          expect(params.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
          // PKCE:broker 收到的 verifier 必须与授权页 challenge 对得上(S256)。
          expect(typeof params.codeVerifier).toBe('string');
          const digest = createHash('sha256')
            .update(params.codeVerifier as string)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          expect(digest).toBe(challengeFromUrl);
          return {
            ok: true as const,
            bundle: { accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: Date.now() + 1000, grantedScope: null },
          };
        },
      ),
      refresh: vi.fn(),
    };
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, tokenBroker: 'jira' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      broker,
      openExternal: (url) => {
        challengeFromUrl = new URL(url).searchParams.get('code_challenge');
        expect(challengeFromUrl).toBeTruthy();
        browserRedirect(url, (au) => ({ code: 'c-broker', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.bundle.accessToken).toBe('at-b');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(broker.exchange).toHaveBeenCalledTimes(1);
  });

  it('tokenBroker 服务不可用时保留 SERVICE_UNAVAILABLE 分类', async () => {
    const broker: GhostOauthBrokerClient = {
      exchange: vi.fn(async () => ({
        ok: false as const,
        error: 'SERVICE_UNAVAILABLE' as const,
        invalidGrant: false,
      })),
      refresh: vi.fn(),
    };
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, tokenBroker: 'feishu' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      broker,
      openExternal: (url) => {
        browserRedirect(url, (authorizeUrl) => ({
          code: 'c-unavailable',
          state: authorizeUrl.searchParams.get('state') ?? '',
        }));
      },
    });

    expect(result).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', detail: undefined });
  });

  it('tokenBroker + pkce:false(jira/slack 形态):授权页无 challenge,broker 不收 verifier', async () => {
    const broker: GhostOauthBrokerClient = {
      exchange: vi.fn(
        async (_slug: string, params: { code: string; redirectUri: string; codeVerifier?: string }) => {
          expect(params.codeVerifier).toBeUndefined();
          return {
            ok: true as const,
            bundle: { accessToken: 'at-np', refreshToken: null, expiresAt: null, grantedScope: null },
          };
        },
      ),
      refresh: vi.fn(),
    };
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, tokenBroker: 'jira', pkce: false },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      broker,
      openExternal: (url) => {
        expect(new URL(url).searchParams.get('code_challenge')).toBeNull();
        browserRedirect(url, (au) => ({ code: 'c-np', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('tokenBroker 声明但未接线 broker → INVALID_CONFIG,不拉浏览器', async () => {
    const openExternal = vi.fn();
    await expect(
      startGhostOauthFlow({
        config: { ...BASE_CONFIG, tokenBroker: 'jira' },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('publicRedirectUri:authorize URL 与 broker exchange 都用公网弹跳地址,本地监听仍在 loopback', async () => {
    const fixedPort = await probeFreePort();
    const PUBLIC_URI = 'https://broker.example.com/jira/bounce';
    let capturedRedirectParam: string | null = null;
    const broker: GhostOauthBrokerClient = {
      exchange: vi.fn(async (slug: string, params: { code: string; redirectUri: string }) => {
        expect(slug).toBe('jira');
        expect(params.code).toBe('c-pub');
        // 双地址模型:code 交换带的 redirect_uri 必须与 authorize 时一致 = 公网弹跳地址。
        expect(params.redirectUri).toBe(PUBLIC_URI);
        return {
          ok: true as const,
          bundle: { accessToken: 'at-pub', refreshToken: 'rt-pub', expiresAt: Date.now() + 1000, grantedScope: null },
        };
      }),
      refresh: vi.fn(),
    };
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, tokenBroker: 'jira', redirectPort: fixedPort, publicRedirectUri: PUBLIC_URI },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      broker,
      openExternal: (url) => {
        capturedRedirectParam = new URL(url).searchParams.get('redirect_uri');
        // 假浏览器模拟弹跳路由的 302:公网地址打不通,直接回打本机 loopback
        // 缺省 /callback(未声明 callbackPath 时监听路径不变)。
        const cb = new URL(`http://127.0.0.1:${fixedPort}/callback`);
        cb.searchParams.set('code', 'c-pub');
        cb.searchParams.set('state', new URL(url).searchParams.get('state') ?? '');
        setImmediate(() => {
          void fetch(cb.toString()).catch(() => undefined);
        });
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.bundle.accessToken).toBe('at-pub');
    // 报给服务商的 redirect_uri 是公网弹跳地址,而不是 loopback。
    expect(capturedRedirectParam).toBe(PUBLIC_URI);
    expect(broker.exchange).toHaveBeenCalledTimes(1);
  });

  it('callbackPath 非默认:声明路径收回调成功,缺省 /callback 404', async () => {
    const fixedPort = await probeFreePort();
    let defaultPathStatus = 0;
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, pkce: false, redirectPort: fixedPort, callbackPath: '/slack-mcp/callback' },
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-cbp' })) as unknown as typeof fetch,
      openExternal: (url) => {
        const u = new URL(url);
        // 单地址模型下 redirect_uri 直接带声明的 callbackPath。
        expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${fixedPort}/slack-mcp/callback`);
        const state = u.searchParams.get('state') ?? '';
        setImmediate(() => {
          void (async () => {
            // 先打缺省 /callback:非声明路径 404,不结算本单。
            const res404 = await fetch(`http://127.0.0.1:${fixedPort}/callback?code=x&state=${state}`);
            defaultPathStatus = res404.status;
            await fetch(`http://127.0.0.1:${fixedPort}/slack-mcp/callback?code=c-cbp&state=${state}`);
          })().catch(() => undefined);
        });
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(defaultPathStatus).toBe(404);
  });

  it('publicRedirectUri 为 http → INVALID_CONFIG,不拉浏览器', async () => {
    const openExternal = vi.fn();
    await expect(
      startGhostOauthFlow({
        config: { ...BASE_CONFIG, publicRedirectUri: 'http://broker.example.com/slack-mcp/bounce' },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('scopeDelimiter ",":authorize URL 的 scope 参数逗号拼接(Slack 形态)', async () => {
    const result = await startGhostOauthFlow({
      config: { ...BASE_CONFIG, scopeDelimiter: ',' },
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-sd' })) as unknown as typeof fetch,
      openExternal: (url) => {
        expect(new URL(url).searchParams.get('scope')).toBe('read:a,write:b');
        browserRedirect(url, (au) => ({ code: 'c-sd', state: au.searchParams.get('state') ?? '' }));
      },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('非 https 端点 / 缺 clientId → INVALID_CONFIG', async () => {
    const openExternal = vi.fn();
    await expect(
      startGhostOauthFlow({
        config: { ...BASE_CONFIG, authorizeUrl: 'http://auth.example.com/authorize' },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    await expect(
      startGhostOauthFlow({
        config: { ...BASE_CONFIG, clientId: '' },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('refreshGhostOauthToken', () => {
  it('轮换型服务商:响应带新 refresh token 时用新的', async () => {
    const result = await refreshGhostOauthToken({
      config: BASE_CONFIG,
      refreshToken: 'rt-old',
      fetchImpl: vi.fn(async (_i: unknown, init?: RequestInit) => {
        const form = new URLSearchParams(String(init?.body ?? ''));
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('rt-old');
        return jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.bundle.refreshToken).toBe('rt-new');
  });

  it('非轮换型服务商:响应不带 refresh token 时沿用旧的', async () => {
    const result = await refreshGhostOauthToken({
      config: BASE_CONFIG,
      refreshToken: 'rt-keep',
      fetchImpl: vi.fn(async () => jsonResponse({ access_token: 'at-new' })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.bundle.refreshToken).toBe('rt-keep');
  });

  it('invalid_grant → invalidGrant:true(调用方作废存量引导重授权)', async () => {
    const result = await refreshGhostOauthToken({
      config: BASE_CONFIG,
      refreshToken: 'rt-revoked',
      fetchImpl: vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: 'EXCHANGE_FAILED', invalidGrant: true });
  });

  it('网络异常 → NETWORK 且 invalidGrant:false', async () => {
    const result = await refreshGhostOauthToken({
      config: BASE_CONFIG,
      refreshToken: 'rt-x',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: 'NETWORK', invalidGrant: false });
  });

  it('tokenBroker:refresh 走 broker,invalidGrant 原样透传;broker 未回新 rt 时沿用旧的', async () => {
    const fetchImpl = vi.fn();
    const brokerOk: GhostOauthBrokerClient = {
      exchange: vi.fn(),
      refresh: vi.fn(async (slug: string, params: { refreshToken: string }) => {
        expect(slug).toBe('jira');
        expect(params.refreshToken).toBe('rt-old');
        return {
          ok: true as const,
          bundle: { accessToken: 'at-nb', refreshToken: null, expiresAt: null, grantedScope: null },
        };
      }),
    };
    const ok = await refreshGhostOauthToken({
      config: { ...BASE_CONFIG, tokenBroker: 'jira' },
      refreshToken: 'rt-old',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      broker: brokerOk,
    });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.bundle.refreshToken).toBe('rt-old');
    expect(fetchImpl).not.toHaveBeenCalled();

    const brokerRejected: GhostOauthBrokerClient = {
      exchange: vi.fn(),
      refresh: vi.fn(async () => ({
        ok: false as const,
        error: 'EXCHANGE_FAILED' as const,
        invalidGrant: true,
        detail: 'JIRA_OAUTH_FAILED refresh rejected',
      })),
    };
    await expect(
      refreshGhostOauthToken({
        config: { ...BASE_CONFIG, tokenBroker: 'jira' },
        refreshToken: 'rt-old',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        broker: brokerRejected,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'EXCHANGE_FAILED', invalidGrant: true });
  });

  it('tokenBroker 声明但未接线 broker → EXCHANGE_FAILED 且不作废存量(invalidGrant:false)', async () => {
    await expect(
      refreshGhostOauthToken({
        config: { ...BASE_CONFIG, tokenBroker: 'jira' },
        refreshToken: 'rt-keep',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'EXCHANGE_FAILED', invalidGrant: false });
  });
});

describe('fetchGhostOauthIdentity', () => {
  it('点分路径取标签(未声明模板时 display 为 null)', async () => {
    const identity = await fetchGhostOauthIdentity({
      url: 'https://api.example.com/me',
      labelPath: 'user.email',
      accessToken: 'at-1',
      fetchImpl: vi.fn(async (_i: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer at-1');
        return jsonResponse({ user: { email: 'a@b.com' } });
      }) as unknown as typeof fetch,
    });
    expect(identity).toEqual({ label: 'a@b.com', display: null, avatarUrl: null });
  });

  it('displayTemplate 渲染展示名(多占位符,同一份响应取值)', async () => {
    const identity = await fetchGhostOauthIdentity({
      url: 'https://slack.com/api/auth.test',
      labelPath: 'user_id',
      displayTemplate: '{team} · {user}',
      accessToken: 'at-1',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ ok: true, team: 'acme', user: 'devuser', user_id: 'U0EXAMPLE1' }),
      ) as unknown as typeof fetch,
    });
    expect(identity).toEqual({ label: 'U0EXAMPLE1', display: 'acme · devuser', avatarUrl: null });
  });

  it('模板任一占位符取不到值 → display 降级 null,label 不受影响', async () => {
    const identity = await fetchGhostOauthIdentity({
      url: 'https://slack.com/api/auth.test',
      labelPath: 'user_id',
      displayTemplate: '{team} · {user}',
      accessToken: 'at-1',
      fetchImpl: vi.fn(async () => jsonResponse({ ok: true, user_id: 'U0EXAMPLE1', team: 42 })) as unknown as typeof fetch,
    });
    expect(identity).toEqual({ label: 'U0EXAMPLE1', display: null, avatarUrl: null });
  });

  it('路径不存在 / 非字符串 / 非 https / 请求失败 → 双 null(纯展示,不阻断)', async () => {
    const none = { label: null, display: null, avatarUrl: null };
    const okFetch = vi.fn(async () => jsonResponse({ user: { email: 42 } })) as unknown as typeof fetch;
    await expect(
      fetchGhostOauthIdentity({ url: 'https://x.com/me', labelPath: 'user.email', accessToken: 'a', fetchImpl: okFetch }),
    ).resolves.toEqual(none);
    await expect(
      fetchGhostOauthIdentity({ url: 'http://x.com/me', labelPath: 'e', accessToken: 'a', fetchImpl: okFetch }),
    ).resolves.toEqual(none);
    await expect(
      fetchGhostOauthIdentity({
        url: 'https://x.com/me',
        labelPath: 'e',
        accessToken: 'a',
        fetchImpl: vi.fn(async () => {
          throw new Error('boom');
        }) as unknown as typeof fetch,
      }),
    ).resolves.toEqual(none);
  });

  it('avatarPath 取头像 https 地址;非 https / 非字符串降级 null(label 不受影响)', async () => {
    const mk = (avatar: unknown) =>
      fetchGhostOauthIdentity({
        url: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
        labelPath: 'data.union_id',
        avatarPath: 'data.avatar_thumb',
        accessToken: 'at-1',
        fetchImpl: vi.fn(async () =>
          jsonResponse({ data: { union_id: 'on_x', avatar_thumb: avatar } }),
        ) as unknown as typeof fetch,
      });
    await expect(mk('https://cdn.example.com/a.png')).resolves.toEqual({
      label: 'on_x',
      display: null,
      avatarUrl: 'https://cdn.example.com/a.png',
    });
    await expect(mk('http://cdn.example.com/a.png')).resolves.toMatchObject({ avatarUrl: null });
    await expect(mk(42)).resolves.toMatchObject({ label: 'on_x', avatarUrl: null });
  });
});

describe('fetchGhostOauthAvatar', () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const imageResponse = (mime: string, bytes: Buffer = pngBytes): Response =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': mime } });

  it('图片响应转 data URL,且请求不带 Authorization(头像域名无凭证)', async () => {
    const fetchImpl = vi.fn(async (_i: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
      return imageResponse('image/png');
    });
    await expect(
      fetchGhostOauthAvatar({ url: 'https://cdn.example.com/a.png', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);
  });

  it('非 https / 非图片 mime / 超限 / 请求失败 → null(best-effort 不阻断)', async () => {
    await expect(
      fetchGhostOauthAvatar({ url: 'http://cdn.example.com/a.png', fetchImpl: vi.fn() as unknown as typeof fetch }),
    ).resolves.toBeNull();
    await expect(
      fetchGhostOauthAvatar({
        url: 'https://cdn.example.com/a.html',
        fetchImpl: vi.fn(async () => imageResponse('text/html')) as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    await expect(
      fetchGhostOauthAvatar({
        url: 'https://cdn.example.com/big.png',
        fetchImpl: vi.fn(async () => imageResponse('image/png', Buffer.alloc(256 * 1024 + 1))) as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    await expect(
      fetchGhostOauthAvatar({
        url: 'https://cdn.example.com/a.png',
        fetchImpl: vi.fn(async () => {
          throw new Error('boom');
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });
});

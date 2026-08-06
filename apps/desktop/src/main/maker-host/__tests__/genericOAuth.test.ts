/**
 * generic-oauth Runner + oauth-token 路由分支 + active-catalog 发现模型泛化 merge 单测。
 *
 * 覆盖（存储 / fetch / 时钟注入，不联网、不触电 Electron）：
 *   - blob 缓存读写、has/logout 语义；
 *   - 临期单飞刷新：refresh_token 交换、登出竞态不回写、并发只刷一次；
 *   - readCachedGenericOAuthAccessToken 同步返回 + 临期触发后台刷新；
 *   - discoverGenericOAuthModels 解析 OpenAI /models 形状 + 失败回 null；
 *   - buildRouteDecision 的 oauth-token 分支（Bearer 覆盖、cc 抹 x-api-key、codex 抹 OpenAI
 *     账号元数据头、无 token passthrough）；
 *   - 登录流（回环回调模拟）成功路径 + 凭证落盘失败的登录硬失败 / 刷新保内存态语义；
 *   - setDiscoveredProviderModels 的 additions-only merge。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { OAuthProviderDescriptor } from '@cindy/model-providers';

import {
  cancelGenericOAuthLogin,
  configureGenericOAuth,
  deriveModelsDiscoveryUrl,
  genericOAuthCredentialRealm,
  hasGenericOAuthLogin,
  logoutGenericOAuth,
  removeGenericOAuthCredentialsReversibly,
  readCachedGenericOAuthAccessToken,
  refreshGenericOAuthIfNeeded,
  discoverGenericOAuthModels,
  parseModelsListResponseDetailed,
  resetGenericOAuthMemoryCache,
  runGenericOAuthLogin,
  type GenericOAuthStorage,
} from '../generic-oauth.js';
import {
  buildRouteDecision,
  isHostInjectedAuthSession,
  setOAuthTokenReader,
  resolveSessionRouteDecision,
} from '../provider-route.js';
import {
  setActiveCatalog,
  setCustomProviders,
  setDiscoveredProviderModels,
  getActiveCatalog,
} from '../active-catalog.js';
import { setSessionProvider } from '../session-provider-store.js';

const OAUTH: OAuthProviderDescriptor = {
  authorizeUrl: 'https://auth.acme.example/oauth2/authorize',
  tokenUrl: 'https://auth.acme.example/oauth2/token',
  clientId: 'client-1',
  scopes: 'openid offline_access',
  modelsDiscoveryUrl: 'https://api.acme.example/v1/models',
};
const DEVICE_OAUTH: OAuthProviderDescriptor = {
  flow: 'device-code',
  deviceAuthorizationUrl: 'https://auth.acme.example/oauth2/device',
  tokenUrl: 'https://auth.acme.example/oauth2/token',
  clientId: 'device-client-1',
  scopes: 'openid offline_access',
  modelsDiscoveryUrl: 'https://api.acme.example/v1/models',
};

function oauthProvider(oauth: OAuthProviderDescriptor = OAUTH, id = 'acme', name = 'Acme') {
  return {
    id,
    name,
    source: 'user' as const,
    auth: { method: 'oauth' as const, oauth },
    routing: {
      codex: {
        upstream: 'https://api.acme.example/v1',
        authStrategy: 'oauth-token' as const,
      },
    },
  };
}

const ACME_PROVIDER = oauthProvider();
const DEVICE_PROVIDER = oauthProvider(DEVICE_OAUTH, 'device', 'Device Provider');

function memStorage(): GenericOAuthStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: (id) => map.get(id) ?? null,
    readStrict: (id) => map.get(id) ?? null,
    write: (id, v) => {
      map.set(id, v);
      return true;
    },
    remove: (id) => {
      map.delete(id);
      return true;
    },
  };
}

let storage = memStorage();
let nowMs = 1_000_000;
let fetchCalls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
let fetchResponder: (url: string) => Response | Promise<Response> = () =>
  new Response('{}', { status: 500 });
let openedUrls: string[] = [];

beforeEach(() => {
  storage = memStorage();
  nowMs = 1_000_000;
  fetchCalls = [];
  openedUrls = [];
  resetGenericOAuthMemoryCache();
  configureGenericOAuth({
    storage,
    now: () => nowMs,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body ? String(init.body) : undefined,
        headers: (init?.headers ?? undefined) as Record<string, string> | undefined,
      });
      return fetchResponder(String(url));
    }) as typeof fetch,
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    sleep: async (ms) => {
      nowMs += ms;
    },
  });
});

afterEach(() => {
  resetGenericOAuthMemoryCache();
  setOAuthTokenReader(() => null);
});

function seedBlob(provider: ReturnType<typeof oauthProvider>, blob: Record<string, unknown>): void {
  storage.map.set(
    provider.id,
    JSON.stringify({
      version: 2,
      ...blob,
      credential_realm: genericOAuthCredentialRealm(provider),
    }),
  );
  resetGenericOAuthMemoryCache(); // 让下次读走注入 storage
}

describe('blob 读写 / has / logout', () => {
  it('credential realm 规范化默认 flow，并区分来源、描述符与凭证目标', () => {
    const explicitFlow = oauthProvider({ ...OAUTH, flow: 'authorization-code' });
    expect(genericOAuthCredentialRealm(explicitFlow)).toBe(
      genericOAuthCredentialRealm(ACME_PROVIDER),
    );
    expect(genericOAuthCredentialRealm({ ...ACME_PROVIDER, source: 'builtin' })).not.toBe(
      genericOAuthCredentialRealm(ACME_PROVIDER),
    );
    expect(
      genericOAuthCredentialRealm(
        oauthProvider({
          ...OAUTH,
          tokenUrl: 'https://auth2.acme.example/oauth2/token',
        }),
      ),
    ).not.toBe(genericOAuthCredentialRealm(ACME_PROVIDER));
    expect(
      genericOAuthCredentialRealm({
        ...ACME_PROVIDER,
        routing: {
          codex: {
            ...ACME_PROVIDER.routing.codex,
            upstream: 'https://api2.acme.example/v1',
          },
        },
      }),
    ).not.toBe(genericOAuthCredentialRealm(ACME_PROVIDER));
  });

  it('无凭证 → has=false、token=null；写入后可读；logout 清空', () => {
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
    seedBlob(ACME_PROVIDER, { access_token: 'at-1' });
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(true);
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('at-1');
    logoutGenericOAuth('acme');
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
    expect(storage.map.has('acme')).toBe(false);
  });

  it('坏 JSON blob 安全兜底为未登录', () => {
    storage.map.set('acme', 'not-json');
    resetGenericOAuthMemoryCache();
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
  });

  it('可回滚删除会在配置写失败后恢复原 OAuth blob', () => {
    seedBlob(ACME_PROVIDER, { access_token: 'at-1', refresh_token: 'rt-1' });

    const restore = removeGenericOAuthCredentialsReversibly('acme');
    expect(restore).not.toBeNull();
    expect(storage.map.has('acme')).toBe(false);
    expect(restore?.()).toBe(true);

    resetGenericOAuthMemoryCache();
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('at-1');
  });

  it('冷缓存严格快照不可读时在删除前中止，不把现有凭证误判成缺失', () => {
    storage.map.set('acme', JSON.stringify({ access_token: 'at-1' }));
    const remove = storage.remove;
    storage.remove = () => {
      throw new Error('must not remove');
    };
    storage.readStrict = () => {
      throw new Error('safeStorage unavailable');
    };
    resetGenericOAuthMemoryCache();

    expect(removeGenericOAuthCredentialsReversibly('acme')).toBeNull();
    expect(storage.map.get('acme')).toContain('at-1');

    storage.remove = remove;
  });

  it('回滚按原始字符串恢复持久 blob，同时恢复删除前的热缓存', () => {
    const raw = JSON.stringify({
      version: 2,
      access_token: 'durable',
      refresh_token: 'rt',
      credential_realm: genericOAuthCredentialRealm(ACME_PROVIDER),
    });
    storage.map.set('acme', raw);
    resetGenericOAuthMemoryCache();
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('durable');

    const restore = removeGenericOAuthCredentialsReversibly('acme');
    expect(restore?.()).toBe(true);
    expect(storage.map.get('acme')).toBe(raw);
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('durable');
  });

  it('凭证删除失败时保留当前登录态并返回失败', () => {
    seedBlob(ACME_PROVIDER, { access_token: 'at-1' });
    storage.remove = () => false;

    expect(logoutGenericOAuth('acme')).toBe(false);
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(true);
  });

  it('旧 blob 或同 id 不同来源/路由都不能复用已有 token', () => {
    storage.map.set('acme', JSON.stringify({ access_token: 'legacy-unbound' }));
    resetGenericOAuthMemoryCache();
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBeNull();

    seedBlob(ACME_PROVIDER, { access_token: 'local-token' });
    const publishedCollision = {
      ...ACME_PROVIDER,
      source: 'builtin' as const,
      routing: {
        codex: {
          ...ACME_PROVIDER.routing.codex,
          upstream: 'https://catalog.example/v1',
        },
      },
    };
    expect(hasGenericOAuthLogin(publishedCollision)).toBe(false);
    expect(readCachedGenericOAuthAccessToken(publishedCollision)).toBeNull();
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('local-token');
  });
});

describe('临期刷新（单飞）', () => {
  it('临期 + refresh_token → 交换新 token 并落盘', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_at: nowMs + 1_000,
    });
    fetchResponder = () =>
      new Response(
        JSON.stringify({ access_token: 'new', refresh_token: 'rt-2', expires_in: 3600 }),
        { status: 200 },
      );
    await refreshGenericOAuthIfNeeded(ACME_PROVIDER);
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('new');
    expect(fetchCalls[0]?.url).toBe(OAUTH.tokenUrl);
    expect(fetchCalls[0]?.body).toContain('grant_type=refresh_token');
    expect(fetchCalls[0]?.body).toContain('refresh_token=rt-1');
  });

  it('未临期 / 无 refresh_token → 不发请求', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'ok',
      expires_at: nowMs + 10 * 60_000,
    });
    await refreshGenericOAuthIfNeeded(ACME_PROVIDER);
    expect(fetchCalls).toHaveLength(0);
  });

  it('刷新期间登出 → 不回写（撤销登出是禁止的）', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_at: nowMs + 1_000,
    });
    fetchResponder = () => {
      // 刷新响应到达前用户登出。
      logoutGenericOAuth('acme');
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), {
        status: 200,
      });
    };
    await refreshGenericOAuthIfNeeded(ACME_PROVIDER);
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
  });

  it('readCachedGenericOAuthAccessToken：临期时同步返回旧 token 并后台触发刷新', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_at: nowMs + 1_000,
    });
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 });
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('old'); // 不阻塞
    await refreshGenericOAuthIfNeeded(ACME_PROVIDER); // 排队等后台那次完成（单飞去重）
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('new');
  });

  it('旧 realm 的在途刷新不能覆盖同 id 新 realm 凭证', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'old-a',
      refresh_token: 'refresh-a',
      expires_at: nowMs + 1_000,
    });
    let finishRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    fetchResponder = () => {
      markRefreshStarted();
      return refreshResponse;
    };

    const inflight = refreshGenericOAuthIfNeeded(ACME_PROVIDER);
    await refreshStarted;
    const providerB = {
      ...ACME_PROVIDER,
      routing: {
        codex: {
          ...ACME_PROVIDER.routing.codex,
          upstream: 'https://api-b.acme.example/v1',
        },
      },
    };
    seedBlob(providerB, { access_token: 'token-b', refresh_token: 'refresh-b' });
    finishRefresh(
      new Response(JSON.stringify({ access_token: 'late-a', expires_in: 3600 }), {
        status: 200,
      }),
    );
    await inflight;

    expect(readCachedGenericOAuthAccessToken(providerB)).toBe('token-b');
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBeNull();
  });
});

describe('登录流与凭证落盘失败', () => {
  /** 模拟浏览器授权：解析授权 URL 里的回调地址与 state，回打回环回调（fire-and-forget——
   *  回调响应要等 succeed()/close() 才写回，await 会与登录流互相等死锁）。 */
  function autoAuthorize(): void {
    configureGenericOAuth({
      openExternal: async (authUrl) => {
        const u = new URL(authUrl);
        const redirect = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        void fetch(`${redirect}?code=code-1&state=${encodeURIComponent(state)}`).catch(() => {});
      },
    });
  }

  it('成功路径：token 交换后凭证落盘 + 内存可读', async () => {
    autoAuthorize();
    fetchResponder = () =>
      new Response(
        JSON.stringify({ access_token: 'at-new', refresh_token: 'rt', expires_in: 3600 }),
        { status: 200 },
      );
    const res = await runGenericOAuthLogin(ACME_PROVIDER);
    expect(res.ok).toBe(true);
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(true);
    expect(JSON.parse(storage.map.get('acme')!).access_token).toBe('at-new');
    expect(JSON.parse(storage.map.get('acme')!).credential_realm).toBe(
      genericOAuthCredentialRealm(ACME_PROVIDER),
    );
    expect(JSON.parse(storage.map.get('acme')!).version).toBe(2);
  });

  it('owner/provider guard 在 token 交换期间失效时拒绝落盘', async () => {
    autoAuthorize();
    let current = true;
    fetchResponder = () => {
      current = false;
      return new Response(JSON.stringify({ access_token: 'wrong-owner-token' }), { status: 200 });
    };

    const result = await runGenericOAuthLogin(ACME_PROVIDER, {
      isCurrent: () => current,
    });

    expect(result).toEqual({ ok: false, reason: 'login_cancelled' });
    expect(storage.map.has('acme')).toBe(false);
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
  });

  it('owner/provider guard 在回环监听启动期间失效时不会打开旧授权页', async () => {
    let current = true;
    configureGenericOAuth({
      openExternal: async () => {
        openedUrls.push('unexpected');
        cancelGenericOAuthLogin('acme');
      },
    });

    const login = runGenericOAuthLogin(ACME_PROVIDER, {
      isCurrent: () => current,
    });
    current = false;

    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(openedUrls).toEqual([]);
    expect(storage.map.has('acme')).toBe(false);
  });

  it('迟到取消只回滚本次登录写入的凭证，不误删更新的 blob', async () => {
    autoAuthorize();
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 });
    let rollback: (() => boolean) | undefined;

    const res = await runGenericOAuthLogin(ACME_PROVIDER, {
      onCredentialPersisted: (fn) => {
        rollback = fn;
      },
    });
    expect(res.ok).toBe(true);
    expect(rollback).toBeTypeOf('function');

    storage.map.set('acme', JSON.stringify({ access_token: 'newer-login' }));
    expect(rollback?.()).toBe(true);
    expect(JSON.parse(storage.map.get('acme')!).access_token).toBe('newer-login');
  });

  it('取消回滚用严格持久读取核对本次 token，不受热路径 fail-soft 读取影响', async () => {
    autoAuthorize();
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 });
    let rollback: (() => boolean) | undefined;

    await runGenericOAuthLogin(ACME_PROVIDER, {
      onCredentialPersisted: (fn) => {
        rollback = fn;
      },
    });
    storage.read = () => null;

    expect(rollback?.()).toBe(true);
    expect(storage.map.has('acme')).toBe(false);
  });

  it('取消回滚固定到登录开始时的 owner，不会在切号后误删新 owner 凭证', async () => {
    autoAuthorize();
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'token-owner-a', expires_in: 3600 }), {
        status: 200,
      });
    let currentOwner = 'owner-a';
    const ownerMaps = new Map<string, Map<string, string>>();
    const viewFor = (owner: string): GenericOAuthStorage => {
      const map = ownerMaps.get(owner) ?? new Map<string, string>();
      ownerMaps.set(owner, map);
      return {
        read: (id) => map.get(id) ?? null,
        readStrict: (id) => map.get(id) ?? null,
        write: (id, value) => {
          map.set(id, value);
          return true;
        },
        remove: (id) => {
          map.delete(id);
          return true;
        },
      };
    };
    const ownerScopedStorage: GenericOAuthStorage = {
      read: (id) => viewFor(currentOwner).read(id),
      readStrict: (id) => viewFor(currentOwner).readStrict(id),
      write: (id, value) => viewFor(currentOwner).write(id, value),
      remove: (id) => viewFor(currentOwner).remove(id),
      capture: () => viewFor(currentOwner),
    };
    configureGenericOAuth({ storage: ownerScopedStorage });
    let rollback: (() => boolean) | undefined;

    const result = await runGenericOAuthLogin(ACME_PROVIDER, {
      onCredentialPersisted: (fn) => {
        rollback = fn;
      },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(ownerMaps.get('owner-a')!.get('acme')!).access_token).toBe(
      'token-owner-a',
    );

    currentOwner = 'owner-b';
    ownerScopedStorage.write('acme', JSON.stringify({ access_token: 'token-owner-b' }));
    expect(rollback?.()).toBe(true);
    expect(ownerMaps.get('owner-a')!.has('acme')).toBe(false);
    expect(JSON.parse(ownerMaps.get('owner-b')!.get('acme')!).access_token).toBe(
      'token-owner-b',
    );
  });

  it('取消回滚无法严格核对持久 token 时报告失败并保留凭证', async () => {
    autoAuthorize();
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 });
    let rollback: (() => boolean) | undefined;

    await runGenericOAuthLogin(ACME_PROVIDER, {
      onCredentialPersisted: (fn) => {
        rollback = fn;
      },
    });
    storage.readStrict = () => {
      throw new Error('safeStorage unavailable');
    };

    expect(rollback?.()).toBe(false);
    expect(JSON.parse(storage.map.get('acme')!).access_token).toBe('at-new');
  });

  it('登录时 storage.write 失败 → 硬失败且不留「已连接」内存态（回归：防重启后授权静默丢失）', async () => {
    autoAuthorize();
    storage.write = () => false;
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 });
    const res = await runGenericOAuthLogin(ACME_PROVIDER);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('安全存储');
    expect(hasGenericOAuthLogin(ACME_PROVIDER)).toBe(false);
    expect(storage.map.has('acme')).toBe(false);
  });

  it('刷新时 storage.write 失败 → 内存态仍更新（会话不断链），盘上保持旧值', async () => {
    seedBlob(ACME_PROVIDER, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_at: nowMs + 1_000,
    });
    storage.write = () => false;
    fetchResponder = () =>
      new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 });
    await refreshGenericOAuthIfNeeded(ACME_PROVIDER);
    expect(readCachedGenericOAuthAccessToken(ACME_PROVIDER)).toBe('new'); // 内存态已是新 token
    expect(JSON.parse(storage.map.get('acme')!).access_token).toBe('old'); // 盘上还是旧值
  });

  it('Device Grant：展示一次性代码，按 pending / slow_down 轮询并安全落盘', async () => {
    const waits: number[] = [];
    configureGenericOAuth({ sleep: async (ms) => void waits.push(ms) });
    let tokenPolls = 0;
    fetchResponder = (url) => {
      if (url === DEVICE_OAUTH.deviceAuthorizationUrl) {
        return new Response(
          JSON.stringify({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.acme.example/device',
            verification_uri_complete: 'https://auth.acme.example/device?user_code=ABCD-EFGH',
            expires_in: 600,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      tokenPolls += 1;
      if (tokenPolls === 1) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
      }
      if (tokenPolls === 2) {
        return new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: 'device-access',
          refresh_token: 'device-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };
    const progress: unknown[] = [];

    const result = await runGenericOAuthLogin(DEVICE_PROVIDER, {
      onProgress: (event) => progress.push(event),
    });

    expect(result).toEqual({ ok: true });
    expect(progress).toEqual([
      {
        phase: 'device-code',
        verificationUrl: 'https://auth.acme.example/device?user_code=ABCD-EFGH',
        userCode: 'ABCD-EFGH',
        expiresAt: nowMs + 10 * 60_000,
      },
    ]);
    expect(waits).toEqual([1_000, 1_000, 6_000]);
    expect(openedUrls).toEqual([]);
    expect(new URLSearchParams(fetchCalls[0]?.body).get('client_id')).toBe('device-client-1');
    expect(new URLSearchParams(fetchCalls[1]?.body).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    const persisted = storage.map.get('device')!;
    expect(JSON.parse(persisted).access_token).toBe('device-access');
    expect(persisted).not.toContain('secret-device-code');
    expect(persisted).not.toContain('ABCD-EFGH');
  });

  it('Device Grant：持续 pending 时按注入时钟到期，不会无限轮询', async () => {
    let tokenPolls = 0;
    fetchResponder = (url) => {
      if (url === DEVICE_OAUTH.deviceAuthorizationUrl) {
        return new Response(
          JSON.stringify({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.acme.example/device',
            expires_in: 2,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      tokenPolls += 1;
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
    };

    const result = await runGenericOAuthLogin(DEVICE_PROVIDER, {
      onProgress: () => undefined,
    });

    expect(result).toEqual({ ok: false, reason: 'device_code_expired' });
    expect(tokenPolls).toBe(2);
    expect(nowMs).toBe(1_002_000);
    expect(storage.map.has('device')).toBe(false);
  });

  it('Device Grant：授权响应返回前 owner/provider guard 失效时不广播旧一次性代码', async () => {
    let finishAuthorization!: (response: Response) => void;
    fetchResponder = () =>
      new Promise<Response>((resolve) => {
        finishAuthorization = resolve;
      });
    let current = true;
    const progress: unknown[] = [];

    const login = runGenericOAuthLogin(DEVICE_PROVIDER, {
      isCurrent: () => current,
      onProgress: (event) => progress.push(event),
    });
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    current = false;
    finishAuthorization(
      new Response(
        JSON.stringify({
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.acme.example/device',
          expires_in: 600,
        }),
        { status: 200 },
      ),
    );

    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(progress).toEqual([]);
    expect(fetchCalls).toHaveLength(1);
    expect(storage.map.has('device')).toBe(false);
  });

  it('Device Grant：标准 client_id/scope 不会被扩展参数覆盖', async () => {
    fetchResponder = () => new Response('{}', { status: 200 });
    const result = await runGenericOAuthLogin(
      oauthProvider(
        {
          ...DEVICE_OAUTH,
          extraDeviceParams: {
            client_id: 'wrong-client',
            scope: 'wrong-scope',
            audience: 'models',
          },
        },
        'device',
        'Device Provider',
      ),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_device_authorization_response',
    });
    const body = new URLSearchParams(fetchCalls[0]?.body);
    expect(body.getAll('client_id')).toEqual(['device-client-1']);
    expect(body.getAll('scope')).toEqual(['openid offline_access']);
    expect(body.get('audience')).toBe('models');
  });

  it('Authorization Code：标准 PKCE 参数不会被扩展参数或端点 query 覆盖', async () => {
    configureGenericOAuth({
      openExternal: async (authUrl) => {
        openedUrls.push(authUrl);
        cancelGenericOAuthLogin('acme');
      },
    });
    const result = await runGenericOAuthLogin(
      oauthProvider({
        ...OAUTH,
        authorizeUrl: `${OAUTH.authorizeUrl}?client_id=endpoint-client`,
        extraAuthParams: {
          client_id: 'wrong-client',
          scope: 'wrong-scope',
          audience: 'models',
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'login_cancelled' });
    const authUrl = new URL(openedUrls[0]!);
    expect(authUrl.searchParams.getAll('client_id')).toEqual(['client-1']);
    expect(authUrl.searchParams.getAll('scope')).toEqual(['openid offline_access']);
    expect(authUrl.searchParams.get('audience')).toBe('models');
  });

  it('Device Grant：进度回调后取消，不再轮询或写入凭证', async () => {
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.acme.example/device',
          expires_in: 600,
        }),
        { status: 200 },
      );

    const result = await runGenericOAuthLogin(DEVICE_PROVIDER, {
      onProgress: () => cancelGenericOAuthLogin('device'),
    });

    expect(result).toEqual({ ok: false, reason: 'login_cancelled' });
    expect(fetchCalls).toHaveLength(1);
    expect(storage.map.has('device')).toBe(false);
  });

  it('Device Grant：拒绝非 https 验证页响应', async () => {
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'http://auth.acme.example/device',
          expires_in: 600,
        }),
        { status: 200 },
      );

    const result = await runGenericOAuthLogin(DEVICE_PROVIDER);
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_device_authorization_response',
    });
  });
});

describe('discoverGenericOAuthModels', () => {
  it('解析 {data:[{id}]} 形状并去重', async () => {
    seedBlob(ACME_PROVIDER, { access_token: 'at' });
    fetchResponder = () =>
      new Response(JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-1' }] }), {
        status: 200,
      });
    const models = await discoverGenericOAuthModels(ACME_PROVIDER);
    expect(models).toEqual([
      { id: 'm-1', name: 'm-1' },
      { id: 'm-2', name: 'm-2' },
    ]);
  });

  it('未登录 / 非 2xx / 坏形状 → null', async () => {
    expect(await discoverGenericOAuthModels(ACME_PROVIDER)).toBeNull(); // 未登录
    seedBlob(ACME_PROVIDER, { access_token: 'at' });
    fetchResponder = () => new Response('{}', { status: 401 });
    expect(await discoverGenericOAuthModels(ACME_PROVIDER)).toBeNull();
    fetchResponder = () => new Response('{"weird":true}', { status: 200 });
    expect(await discoverGenericOAuthModels(ACME_PROVIDER)).toBeNull();
  });

  it('cc-wire 发现请求带 anthropic-version(缺失会被 Anthropic 兼容端点 400 拒);codex/缺省不带', async () => {
    seedBlob(ACME_PROVIDER, { access_token: 'at' });
    fetchResponder = () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    await discoverGenericOAuthModels(ACME_PROVIDER, 'claude-code');
    expect(fetchCalls[0]?.headers).toEqual({
      authorization: 'Bearer at',
      'anthropic-version': '2023-06-01',
    });
    await discoverGenericOAuthModels(ACME_PROVIDER, 'codex');
    expect(fetchCalls[1]?.headers).toEqual({ authorization: 'Bearer at' });
    await discoverGenericOAuthModels(ACME_PROVIDER);
    expect(fetchCalls[2]?.headers).toEqual({ authorization: 'Bearer at' });
  });

  it('发现目标只能来自描述符或当前 agent 路由；两者皆缺 → null 不发请求', async () => {
    const noDiscovery = { ...OAUTH, modelsDiscoveryUrl: undefined };
    const derivedProvider = oauthProvider(noDiscovery);
    derivedProvider.routing.codex.upstream = 'https://derived.example/v1';
    seedBlob(derivedProvider, { access_token: 'at' });
    fetchResponder = () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    await discoverGenericOAuthModels(derivedProvider, 'codex');
    expect(fetchCalls[0]?.url).toBe('https://derived.example/v1/models');
    expect(await discoverGenericOAuthModels(oauthProvider(noDiscovery))).toBeNull();
    expect(fetchCalls).toHaveLength(1); // 第二次没发请求
  });
});

describe('parseModelsListResponseDetailed', () => {
  it('retains OpenRouter-style capability hints', () => {
    expect(
      parseModelsListResponseDetailed({
        data: [
          {
            id: 'openai/gpt-5',
            name: 'GPT-5',
            context_length: 400_000,
            max_completion_tokens: 16_384,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['tools', 'reasoning_effort', 'temperature'],
            mode: 'chat',
            type: 'chat',
          },
        ],
      }),
    ).toEqual([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        providerReported: {
          contextWindow: 400_000,
          maxOutput: 16_384,
          modalities: { input: ['text', 'image'], output: ['text'] },
          capabilities: {
            supportedParameters: ['tools', 'reasoning_effort', 'temperature'],
            toolCall: true,
            reasoning: true,
            temperature: true,
          },
          mode: 'chat',
          type: 'chat',
        },
      },
    ]);
  });

  it('uses Anthropic display_name and common context aliases', () => {
    expect(
      parseModelsListResponseDetailed({
        models: [
          {
            id: 'claude-sonnet',
            display_name: 'Claude Sonnet',
            max_context_length: 1_000_000,
            maxOutput: 8_192,
          },
        ],
      }),
    ).toEqual([
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        providerReported: { contextWindow: 1_000_000, maxOutput: 8_192 },
      },
    ]);
  });

  it('supports pure string arrays without fabricating provider hints', () => {
    expect(parseModelsListResponseDetailed(['model-a', 'model-a', 'model-b'])).toEqual([
      { id: 'model-a', name: 'model-a' },
      { id: 'model-b', name: 'model-b' },
    ]);
  });

  it('preserves raw upstream mode and type for the resolve wire adapter', () => {
    expect(
      parseModelsListResponseDetailed({
        data: [
          { id: 'responses-model', mode: 'responses' },
          { id: 'embedding-model', mode: 'embedding', type: 'embedding' },
        ],
      }),
    ).toEqual([
      {
        id: 'responses-model',
        name: 'responses-model',
        providerReported: { mode: 'responses' },
      },
      {
        id: 'embedding-model',
        name: 'embedding-model',
        providerReported: { mode: 'embedding', type: 'embedding' },
      },
    ]);
  });
});
describe('deriveModelsDiscoveryUrl', () => {
  it('/vN 结尾只追加 /models，其余追加 /v1/models（尾斜杠归一）', () => {
    expect(deriveModelsDiscoveryUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/models',
    );
    expect(deriveModelsDiscoveryUrl('https://api.acme.example/anthropic')).toBe(
      'https://api.acme.example/anthropic/v1/models',
    );
    expect(deriveModelsDiscoveryUrl('https://api.acme.example/')).toBe(
      'https://api.acme.example/v1/models',
    );
  });

  it('基于 pathname 追加模型端点，保留 query 并丢弃 fragment', () => {
    expect(deriveModelsDiscoveryUrl('https://api.acme.example/v1?tenant=a#ignored')).toBe(
      'https://api.acme.example/v1/models?tenant=a',
    );
    expect(deriveModelsDiscoveryUrl('https://api.acme.example/root/?tenant=a')).toBe(
      'https://api.acme.example/root/v1/models?tenant=a',
    );
  });
});

describe('oauth-token 路由分支', () => {
  const routing = {
    upstream: 'https://api.acme.example',
    authStrategy: 'oauth-token' as const,
    headerDelete: ['anthropic-beta'],
  };

  it('有 token：Bearer 覆盖 + upstream override；cc 额外抹 x-api-key', () => {
    const d = buildRouteDecision(routing, null, 'claude-code', null, 'at-9');
    expect(d).toEqual({
      headerOverride: { authorization: 'Bearer at-9' },
      upstreamOverride: 'https://api.acme.example',
      headerDelete: ['anthropic-beta', 'x-api-key'],
    });
    const dc = buildRouteDecision(routing, null, 'codex', null, 'at-9');
    // codex：描述符自带的删除项保留，并整组追加 OpenAI 账号元数据头
    // （ChatGPT OAuth spawn 的子进程会带这些头，发往第三方上游前必须抹掉；
    // 自定义供应商目录条目无法声明 headerDelete，只能靠 oauth-token 分支代码层兜底）。
    expect(dc?.headerDelete).toEqual(
      expect.arrayContaining([
        'anthropic-beta',
        'chatgpt-account-id',
        'openai-beta',
        'originator',
        'session_id',
      ]),
    );
    expect(dc?.headerDelete).toHaveLength(5);
  });

  it('无 token → 仍路由到本供应商上游并置哑 token（绝不回落默认路由防凭证泄漏）', () => {
    const d = buildRouteDecision(routing, null, 'claude-code', null, null);
    expect(d?.upstreamOverride).toBe('https://api.acme.example');
    expect(d?.headerOverride?.authorization).toBe('Bearer xdt-missing-provider-oauth-token');
    expect(d?.headerDelete).toContain('x-api-key');
  });

  it('isHostInjectedAuthSession: oauth-token 会话视为 host 注入鉴权（codex env-key 态不落默认网关）', () => {
    setActiveCatalog({
      version: 't',
      providers: [
        {
          id: 'acme',
          name: 'Acme',
          source: 'builtin',
          agents: ['codex'],
          auth: { method: 'oauth', oauth: OAUTH },
          routing: { codex: { upstream: 'https://api.acme.example', authStrategy: 'oauth-token' } },
          models: { codex: [] },
        },
      ],
    });
    setSessionProvider('sess-ht', 'acme');
    expect(isHostInjectedAuthSession('sess-ht', 'codex')).toBe(true);
    expect(isHostInjectedAuthSession('sess-ht', 'claude-code')).toBe(false); // 该 agent 无路由
    expect(isHostInjectedAuthSession('sess-unknown', 'codex')).toBe(false); // 未选供应商
  });

  it('resolveSessionRouteDecision 经注入 token reader 走通全链路', async () => {
    setActiveCatalog({
      version: 't',
      providers: [
        {
          id: 'acme',
          name: 'Acme',
          source: 'builtin',
          agents: ['claude-code'],
          auth: { method: 'oauth', oauth: OAUTH },
          routing: { 'claude-code': routing },
          models: {
            'claude-code': [
              { id: 'acme-1', name: 'A1', contextWindow: 1000, efforts: [], defaultEffort: null },
            ],
          },
        },
      ],
    });
    setSessionProvider('sess-1', 'acme');
    const tokenReader = vi.fn((provider) => (provider.id === 'acme' ? 'at-x' : null));
    setOAuthTokenReader(tokenReader);
    // oauth-token 分支同步返回；await 兼容联合返回类型（provider-oauth-header 分支才是 Promise）。
    const d = await resolveSessionRouteDecision('sess-1', 'claude-code', null);
    expect(d?.headerOverride?.authorization).toBe('Bearer at-x');
    expect(d?.upstreamOverride).toBe('https://api.acme.example');
    expect(tokenReader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acme',
        routing: { 'claude-code': routing },
      }),
    );
  });
});

describe('setDiscoveredProviderModels additions-only merge', () => {
  it('只补新 id，静态条目 first-wins；空数组清空 discovery', () => {
    setActiveCatalog({
      version: 't',
      providers: [
        {
          id: 'acme',
          name: 'Acme',
          source: 'builtin',
          agents: ['claude-code'],
          auth: { method: 'oauth', oauth: OAUTH },
          routing: {
            'claude-code': { upstream: 'https://api.acme.example', authStrategy: 'oauth-token' },
          },
          models: {
            'claude-code': [
              {
                id: 'static-1',
                name: 'Static',
                contextWindow: 1000,
                efforts: [],
                defaultEffort: null,
              },
            ],
          },
        },
      ],
    });
    setDiscoveredProviderModels('acme', 'claude-code', [
      {
        id: 'static-1',
        name: 'OVERRIDE-IGNORED',
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'disc-1',
        name: 'Discovered',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const p = getActiveCatalog().providers.find((x) => x.id === 'acme')!;
    expect(p.models['claude-code']!.map((m) => m.name)).toEqual(['Static', 'Discovered']);

    setDiscoveredProviderModels('acme', 'claude-code', []);
    const p2 = getActiveCatalog().providers.find((x) => x.id === 'acme')!;
    expect(p2.models['claude-code']!.map((m) => m.id)).toEqual(['static-1']);
  });

  it('自定义供应商同样吃到发现 augment（回归：custom 追加须在 augment 之前）', () => {
    setActiveCatalog({ version: 't', providers: [] });
    setCustomProviders([
      {
        id: 'my-sub',
        name: 'My Sub',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'oauth', oauth: OAUTH },
        routing: {
          'claude-code': { upstream: 'https://api.my.example', authStrategy: 'oauth-token' },
        },
        models: { 'claude-code': [] },
      },
    ]);
    setDiscoveredProviderModels('my-sub', 'claude-code', [
      { id: 'disc-a', name: 'Disc A', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ]);
    const p = getActiveCatalog().providers.find((x) => x.id === 'my-sub')!;
    expect(p.models['claude-code']!.map((m) => m.id)).toEqual(['disc-a']);
    // 清理进程级单例状态，避免泄漏到其它用例。
    setDiscoveredProviderModels('my-sub', 'claude-code', []);
    setCustomProviders([]);
  });
});

// ── PR3:generic 裸文本 done 消除(callback-pages-classification 页壳改造点 5)──

describe('close() 回执路径(裸 done 消除)', () => {
  it('code 已回、exchange 未决时取消 → 浏览器收到品牌化失败页,绝不再收裸文本 done(唯一输出路径断言)', async () => {
    let callbackResponse: Promise<Response> | null = null;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    configureGenericOAuth({
      openExternal: async (authUrl) => {
        const u = new URL(authUrl);
        const redirect = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        callbackResponse = fetch(`${redirect}?code=code-1&state=${encodeURIComponent(state)}`);
      },
      // token exchange 悬挂直到 abort:复现「code 已回、succeed/fail 前流程被终结」
      fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          exchangeStarted();
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as typeof fetch,
    });

    const login = runGenericOAuthLogin(ACME_PROVIDER);
    await started;
    cancelGenericOAuthLogin('acme');
    const res = await login;
    expect(res.ok).toBe(false);

    const body = await (await callbackResponse!).text();
    expect(body).not.toBe('done');
    expect(body).not.toContain('>done<');
    // 唯一输出路径 = shared builder(legacy visual):品牌失败页 + provider 文案
    expect(body).toContain('data-cindy-oauth-result="error"');
    expect(body).toContain('<span class="badge"');
    expect(body).toContain('Acme');
  });
});

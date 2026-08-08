/**
 * claudeOauthRefresh.test.ts —— host 侧订阅 OAuth 刷新器(claude-oauth-refresh)单测。
 *
 * 背景:cc >= 2.1.198 在 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 下不自读凭证库,
 * 订阅 token 经 env 递入、到期刷新由 host 负责。覆盖:
 *   - 判定与容错:有效期直通 / 临期刷新 / forceRefresh 语义 / 服务端拒绝与网络失败降级;
 *   - 跨进程锁协议(与 cc 共享 <configDir>/.oauth_refresh.lock,真实 tmpdir 目录锁):
 *     锁内重读他人已刷则直接用不刷(防 refresh token 连环旋转)、健康锁等待后放弃、
 *     stale 锁可抢;
 *   - 收尾语义:invalidate 后在途刷新不写回;invalid_grant 通知 onInvalidGrant;
 *   - spawn 非阻塞:getOAuthForSpawn 立即返回现值,临期只触发后台刷新。
 * 全部走 createClaudeOAuthRefresher 依赖注入,不碰真实 keychain / 网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClaudeOAuthRefresher,
  EXPIRY_MARGIN_MS,
  type ClaudeOAuthRefresherDeps,
} from '../claude-oauth-refresh.js';
import {
  CLAUDE_AI_OAUTH_UNATTRIBUTED_SESSION_REVISION,
  type ClaudeAiOAuth,
} from '../claude-credentials-store.js';
import { NATIVE_PROVIDER_AUTH_BINDING_LOCK_STALE_MS } from '../nativeProviderAuthBinding.js';

const NOW = 1_800_000_000_000;

const tmpDirs: string[] = [];
function makeLockDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-oauth-lock-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function fixtureOAuth(overrides: Partial<ClaudeAiOAuth> = {}): ClaudeAiOAuth {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: NOW + 8 * 3600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeps(overrides: Partial<ClaudeOAuthRefresherDeps> = {}): {
  deps: ClaudeOAuthRefresherDeps;
  written: ClaudeAiOAuth[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const written: ClaudeAiOAuth[] = [];
  const fetchMock = vi.fn(async () =>
    jsonResponse(200, {
      access_token: 'at-new',
      refresh_token: 'rt-new',
      expires_in: 28800,
      scope: 'user:inference user:profile',
    }),
  );
  const deps: ClaudeOAuthRefresherDeps = {
    readOAuth: () => fixtureOAuth(),
    readOwnerScope: () => ({ dataOwnerId: 'owner-a', generation: 7, boundaryPending: false }),
    replaceOAuth: (_expected, next) => {
      written.push(next);
      return 'written';
    },
    fetchFn: fetchMock as unknown as typeof fetch,
    now: () => NOW,
    lockDir: (() => {
      const d = makeLockDir();
      return () => d;
    })(),
    sleep: async () => undefined,
    clearRejectedCredential: () => 'changed',
    proactiveRenewal: false,
    ...overrides,
  };
  return { deps, written, fetchMock };
}

describe('claude-oauth-refresh — 基础判定', () => {
  it('未登录(无凭证)→ null,不发请求', async () => {
    const { deps, fetchMock } = makeDeps({ readOAuth: () => null });
    const r = createClaudeOAuthRefresher(deps);
    expect(await r.getValidOAuth()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('token 距过期还早 → 原样返回,不发请求', async () => {
    const { deps, fetchMock } = makeDeps();
    const r = createClaudeOAuthRefresher(deps);
    expect((await r.getValidOAuth())?.accessToken).toBe('at-old');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('临期 → 刷新、按响应合并并写回;请求体对齐 cc 官方协议', async () => {
    const current = fixtureOAuth({ expiresAt: NOW + EXPIRY_MARGIN_MS - 1 });
    const { deps, written, fetchMock } = makeDeps({ readOAuth: () => current });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      scope: 'user:inference user:profile',
    });
    expect(typeof body.client_id).toBe('string');
    expect(out).toMatchObject({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: NOW + 28800 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.accessToken).toBe('at-new');
  });

  it('响应未旋转 refresh_token → 沿用旧值', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const { deps } = makeDeps({
      readOAuth: () => current,
      fetchFn: (async () =>
        jsonResponse(200, { access_token: 'at-new', expires_in: 60 })) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    expect((await r.getValidOAuth())?.refreshToken).toBe('rt-old');
  });

  it('forceRefresh:token 未过期也强制刷新', async () => {
    const { deps, fetchMock } = makeDeps();
    const r = createClaudeOAuthRefresher(deps);
    expect((await r.getValidOAuth({ forceRefresh: true }))?.accessToken).toBe('at-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('staleToken 基线:库值已换代 → 直接返回库值,不消耗轮换(即便 forceRefresh)', async () => {
    // 会话用 at-old spawn,后台预续期已把库刷成 at-renewed;该会话 401 回调带
    // staleToken=at-old → 直接交出 at-renewed,不再刷(防长会话群体 401 连环旋转)。
    const renewed = fixtureOAuth({ accessToken: 'at-renewed' });
    const { deps, fetchMock } = makeDeps({ readOAuth: () => renewed });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth({ forceRefresh: true, staleToken: 'at-old' });
    expect(out?.accessToken).toBe('at-renewed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staleToken 基线:库值就是失败那枚 → 照常强刷', async () => {
    const { deps, fetchMock } = makeDeps();
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth({ forceRefresh: true, staleToken: 'at-old' });
    expect(out?.accessToken).toBe('at-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('authorization revision distinguishes a same-token r2 adoption from a later real r2 401', async () => {
    const r2 = fixtureOAuth({
      accessToken: 'at-same',
      refreshToken: 'rt-same',
      cindyAuthorizationRevision: 'login-revision-2',
    });
    const { deps, fetchMock } = makeDeps({ readOAuth: () => r2 });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(
      refresher.getValidOAuth({
        forceRefresh: true,
        staleToken: 'at-same',
        staleAuthorizationRevision: 'login-revision-1',
      }),
    ).resolves.toBe(r2);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      refresher.getValidOAuth({
        forceRefresh: true,
        staleToken: 'at-same',
        staleAuthorizationRevision: 'login-revision-2',
      }),
    ).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('markerless session baseline refreshes itself but adopts a same-token explicit r2', async () => {
    const markerless = fixtureOAuth({ accessToken: 'at-same', refreshToken: 'rt-same' });
    const markerlessDeps = makeDeps({ readOAuth: () => markerless });
    const markerlessRefresher = createClaudeOAuthRefresher(markerlessDeps.deps);
    await expect(
      markerlessRefresher.getValidOAuth({
        forceRefresh: true,
        staleToken: 'at-same',
        staleAuthorizationRevision: CLAUDE_AI_OAUTH_UNATTRIBUTED_SESSION_REVISION,
      }),
    ).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(markerlessDeps.fetchMock).toHaveBeenCalledOnce();

    const r2 = fixtureOAuth({
      accessToken: 'at-same',
      refreshToken: 'rt-same',
      cindyAuthorizationRevision: 'login-revision-2',
    });
    const r2Deps = makeDeps({ readOAuth: () => r2 });
    const r2Refresher = createClaudeOAuthRefresher(r2Deps.deps);
    await expect(
      r2Refresher.getValidOAuth({
        forceRefresh: true,
        staleToken: 'at-same',
        staleAuthorizationRevision: CLAUDE_AI_OAUTH_UNATTRIBUTED_SESSION_REVISION,
      }),
    ).resolves.toBe(r2);
    expect(r2Deps.fetchMock).not.toHaveBeenCalled();
  });

  it('锁内按有效授权代次识别同 token 的 markerless r2,不再刷新 r1', async () => {
    const r1 = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyCredentialRejectionRevision: 'login-revision-1',
    });
    const r2 = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyCredentialRejectionRevision: 'login-revision-2',
    });
    let reads = 0;
    const { deps, fetchMock } = makeDeps({
      readOAuth: () => {
        reads += 1;
        return reads === 1 ? r1 : r2;
      },
    });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(refresher.getValidOAuth({ forceRefresh: true })).resolves.toBe(r2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('无 refreshToken:非强制原样返回,强制返回 null,不发请求', async () => {
    const current = fixtureOAuth({ refreshToken: null, expiresAt: NOW - 1 });
    const { deps, fetchMock } = makeDeps({ readOAuth: () => current });
    const r = createClaudeOAuthRefresher(deps);
    expect((await r.getValidOAuth())?.accessToken).toBe('at-old');
    expect(await r.getValidOAuth({ forceRefresh: true })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络失败:非强制退回现有 token,强制返回 null', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const failFetch = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const soft = createClaudeOAuthRefresher(
      makeDeps({ readOAuth: () => current, fetchFn: failFetch }).deps,
    );
    expect((await soft.getValidOAuth())?.accessToken).toBe('at-old');
    const hard = createClaudeOAuthRefresher(
      makeDeps({ readOAuth: () => current, fetchFn: failFetch }).deps,
    );
    expect(await hard.getValidOAuth({ forceRefresh: true })).toBeNull();
  });

  it('token endpoint malformed JSON or reflected error text never becomes a credential verdict', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const onInvalidGrant = vi.fn();
    const malformed = createClaudeOAuthRefresher(
      makeDeps({
        readOAuth: () => current,
        onInvalidGrant,
        fetchFn: (async () =>
          new Response('{"access_token":"parser-secret', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch,
      }).deps,
    );
    await expect(malformed.getValidOAuth({ forceRefresh: true })).resolves.toBeNull();

    const reflected = createClaudeOAuthRefresher(
      makeDeps({
        readOAuth: () => current,
        onInvalidGrant,
        fetchFn: (async () =>
          jsonResponse(400, {
            error: 'reflected-refresh-token-secret',
          })) as unknown as typeof fetch,
      }).deps,
    );
    await expect(reflected.getValidOAuth({ forceRefresh: true })).resolves.toBeNull();
    expect(onInvalidGrant).not.toHaveBeenCalled();
  });

  it('写回凭证库失败 → 仍返回刷新后的新 token(本次可用,错误已记日志)', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const replaceOAuth = vi.fn(() => {
      throw new Error('keychain write denied');
    });
    const { deps } = makeDeps({
      readOAuth: () => current,
      replaceOAuth,
    });
    const r = createClaudeOAuthRefresher(deps);
    expect((await r.getValidOAuth())?.accessToken).toBe('at-new');
    expect(replaceOAuth).toHaveBeenCalledOnce();
  });

  it('ELOCKED write-back retries the full CAS beyond the orphaned storage lock window', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const delays: number[] = [];
    const replaceOAuth = vi.fn((_expected: ClaudeAiOAuth, _next: ClaudeAiOAuth) => {
      void _expected;
      void _next;
      if (replaceOAuth.mock.calls.length <= 10) {
        throw new Error('credential store is busy', {
          cause: Object.assign(new Error('held'), { code: 'ELOCKED' }),
        });
      }
      return 'written' as const;
    });
    const { deps } = makeDeps({
      readOAuth: () => current,
      replaceOAuth,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const out = await createClaudeOAuthRefresher(deps).getValidOAuth({ forceRefresh: true });

    expect(out?.accessToken).toBe('at-new');
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(
      NATIVE_PROVIDER_AUTH_BINDING_LOCK_STALE_MS,
    );
    expect(replaceOAuth).toHaveBeenCalledTimes(delays.length + 1);
    for (const [expected, next] of replaceOAuth.mock.calls) {
      expect(expected).toBe(current);
      expect(next).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    }
  });

  it('进程内 single-flight:并发调用共享一次刷新请求,结束后可再刷', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let resolveFetch!: (r: Response) => void;
    const gate = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fetchMock = vi.fn(() => gate);
    const { deps } = makeDeps({
      readOAuth: () => current,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const [a, b] = [r.getValidOAuth(), r.getValidOAuth({ forceRefresh: true })];
    resolveFetch(
      jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra?.accessToken).toBe('at-new');
    expect(rb?.accessToken).toBe('at-new');
  });
});

describe('claude-oauth-refresh — 订阅身份回填(review P2)', () => {
  it('凭证缺 subscriptionType/rateLimitTier → token 先落盘,身份经后台二次写回', async () => {
    // 经 XDMaker 浏览器 OAuth 登录的存量用户:subscriptionType null(旧链路靠 cc 刷新回填)。
    // review 2026-07-04 P2:profile RTT 不得夹在「刷」与「写回」之间(rotated refresh
    // token 落盘不能被推迟)—— 第一次写回必须是纯 token,身份字段走锁外回填二次写回。
    const current = fixtureOAuth({
      expiresAt: NOW - 1,
      subscriptionType: null,
      rateLimitTier: null,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/profile')) {
        return jsonResponse(200, {
          organization: { organization_type: 'claude_max', rate_limit_tier: 'tier_x' },
        });
      }
      return jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 });
    });
    // readOAuth 反映最近写入(真实凭证库语义)—— backfill 锁内重读校验的是写回后的新 token
    const written: ClaudeAiOAuth[] = [];
    const { deps } = makeDeps({
      readOAuth: () => (written.length > 0 ? written[written.length - 1]! : current),
      replaceOAuth: (_expected, next) => {
        written.push(next);
        return 'written';
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth();
    // 主流程返回值 = 纯刷新结果(不等 profile),rotated token 已在第一次写回落盘
    expect(out?.accessToken).toBe('at-new');
    expect(written[0]).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(written[0]!.subscriptionType).toBeNull();
    // 后台回填完成后二次写回,只补身份字段(claude_max → max,对齐 cc pCn 映射)
    await vi.waitFor(() => {
      expect(written.length).toBe(2);
    });
    expect(written[1]).toMatchObject({ subscriptionType: 'max', rateLimitTier: 'tier_x' });
  });

  it('profile 拉取失败 → 刷新主流程不受影响,无二次写回,待下次再补', async () => {
    const current = fixtureOAuth({
      expiresAt: NOW - 1,
      subscriptionType: null,
      rateLimitTier: null,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/profile')) throw new Error('profile down');
      return jsonResponse(200, { access_token: 'at-new', expires_in: 60 });
    });
    const { deps, written } = makeDeps({
      readOAuth: () => current,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth();
    expect(out?.accessToken).toBe('at-new');
    // 等 profile 失败路径走完:仍只有第一次 token 写回
    await new Promise((res) => setTimeout(res, 50));
    expect(written).toHaveLength(1);
  });

  it('profile 在途期间凭证被换(换账号/再刷新)→ 丢弃回填,防跨账号档位污染', async () => {
    const stale = fixtureOAuth({ expiresAt: NOW - 1, subscriptionType: null, rateLimitTier: null });
    const swapped = fixtureOAuth({
      accessToken: 'at-other-account',
      subscriptionType: null,
      rateLimitTier: null,
    });
    let reads = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/profile')) {
        return jsonResponse(200, {
          organization: { organization_type: 'claude_max', rate_limit_tier: 'tier_x' },
        });
      }
      return jsonResponse(200, { access_token: 'at-new', expires_in: 60 });
    });
    const { deps, written } = makeDeps({
      // 主流程读序:①入口 ②锁内重读 ③写回前 postFetch 校验(均返回旧凭证,让 token
      // 正常写回);backfill 锁内重读(第 4 次起)返回已被换掉的凭证 —— 模拟 profile
      // 在途期间换登录。
      readOAuth: () => (reads++ < 3 ? stale : swapped),
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    await r.getValidOAuth();
    await new Promise((res) => setTimeout(res, 50));
    expect(written).toHaveLength(1); // 只有 token 写回,无身份 merge 写回
    expect(written[0]!.accessToken).toBe('at-new');
  });

  it('身份字段齐全 → 不发 profile 请求', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 }); // fixture 自带 max/tier
    const { deps, fetchMock } = makeDeps({ readOAuth: () => current });
    const r = createClaudeOAuthRefresher(deps);
    await r.getValidOAuth();
    const profileCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/oauth/profile'),
    );
    expect(profileCalls).toHaveLength(0);
  });
});

describe('claude-oauth-refresh — 跨进程锁协议', () => {
  it('config dir 不存在(仅 Keychain 登录过)→ 自动建目录拿锁,刷新不被跳过', async () => {
    // review P2:macOS 仅经 XDMaker OAuth 登录的用户 ~/.claude 可能从未创建,
    // 锁 mkdir ENOENT 不能被当成「拿不到锁」跳过刷新。
    const missingDir = path.join(makeLockDir(), 'not-created-yet', '.claude');
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const { deps, written, fetchMock } = makeDeps({
      lockDir: () => missingDir,
      readOAuth: () => current,
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth();
    expect(out?.accessToken).toBe('at-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(fs.existsSync(missingDir)).toBe(true); // 父目录被补建
    expect(fs.existsSync(path.join(missingDir, '.oauth_refresh.lock'))).toBe(false); // 锁已释放
  });

  it('锁内重读发现他人已刷 → 直接采用新值,不再发刷新请求(防连环旋转)', async () => {
    // 模拟:进锁前读到 at-old(过期);锁内重读时另一进程已写入 at-other。
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const renewed = fixtureOAuth({ accessToken: 'at-other', expiresAt: NOW + 3600_000 });
    let reads = 0;
    const { deps, fetchMock } = makeDeps({
      readOAuth: () => (reads++ === 0 ? stale : renewed),
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth({ forceRefresh: true });
    expect(out?.accessToken).toBe('at-other');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('锁被健康进程持有 → 放弃前轮询,持有者稍后写回也能捡到', async () => {
    // review P2:持有者刷新 HTTP 预算(10s)可能长于我们的锁等待(~7.5s),放弃前
    // 在预算内轮询凭证库,写回一落地就采用,不 null 掉整个 turn。
    const dir = makeLockDir();
    fs.mkdirSync(path.join(dir, '.oauth_refresh.lock')); // 他人健康持锁
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const renewed = fixtureOAuth({ accessToken: 'at-other', expiresAt: NOW + 3600_000 });
    let reads = 0;
    const { deps, fetchMock } = makeDeps({
      lockDir: () => dir,
      now: () => Date.now(),
      // 前几次读(含锁外首轮轮询)都是旧值,「持有者」在轮询中途才写回
      readOAuth: () => (reads++ < 4 ? stale : renewed),
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth({ forceRefresh: true });
    expect(out?.accessToken).toBe('at-other');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('锁被健康进程持有 → 退避重试后放弃;锁外重读拿到他人成果则采用', async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, '.oauth_refresh.lock');
    fs.mkdirSync(lockPath); // 他人持锁,mtime = 现在(未 stale)
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const renewed = fixtureOAuth({ accessToken: 'at-other', expiresAt: NOW + 3600_000 });
    let reads = 0;
    const { deps, fetchMock } = makeDeps({
      lockDir: () => dir,
      // stat.mtime 是真实时间;now 用真实时间基准的 fixture 使锁不判 stale
      now: () => Date.now(),
      readOAuth: () => (reads++ === 0 ? stale : renewed),
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth({ forceRefresh: true });
    expect(out?.accessToken).toBe('at-other'); // 放弃拿锁后锁外重读采用他人成果
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true); // 不动别人健康的锁
  });

  it('stale 锁(持有者已死)→ 抢占并正常刷新,释放后锁目录清掉', async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, '.oauth_refresh.lock');
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000); // mtime 60s 前 → 超过 stale 10s
    fs.utimesSync(lockPath, old, old);
    const current = fixtureOAuth({ expiresAt: Date.now() - 1 });
    const { deps, written, fetchMock } = makeDeps({
      lockDir: () => dir,
      now: () => Date.now(),
      readOAuth: () => current,
    });
    const r = createClaudeOAuthRefresher(deps);
    const out = await r.getValidOAuth();
    expect(out?.accessToken).toBe('at-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false); // 释放
  });

  it('stale 接管 claim 到别人刚重建的健康锁 → rollback 还回,不删不刷', async () => {
    // review 2026-07-04 P2 TOCTOU 回归(claim → compare → rollback 协议):rename 走的
    // 若是别人在间隙重建的 fresh 锁(tomb 上比对 mtime 不符),必须原样还回、放弃接管,
    // 绝不能出现双持锁并发刷新。
    const dir = makeLockDir();
    const lockPath = path.join(dir, '.oauth_refresh.lock');
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old); // stat 时判 stale
    const current = fixtureOAuth({ expiresAt: Date.now() - 1 });
    const realStat = fs.statSync.bind(fs);
    // 模拟先手在 stat→rename 间隙完成接管:claim 后对 tomb 的比对返回 fresh mtime
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((
      pp: fs.PathLike,
      ...rest: unknown[]
    ) => {
      const st = realStat(pp as string, ...(rest as []));
      if (String(pp).includes('.oauth_refresh.stale-')) {
        Object.defineProperty(st, 'mtimeMs', { value: Date.now(), configurable: true });
      }
      return st;
    }) as typeof fs.statSync);
    try {
      const { deps, fetchMock } = makeDeps({
        lockDir: () => dir,
        now: () => Date.now(),
        readOAuth: () => current,
      });
      const r = createClaudeOAuthRefresher(deps);
      const out = await r.getValidOAuth({ forceRefresh: true });
      expect(out).toBeNull(); // 拿不到锁 + 锁外重读无新值 + force → null
      expect(fetchMock).not.toHaveBeenCalled(); // 绝不双持锁并发刷新
      expect(fs.existsSync(lockPath)).toBe(true); // 他人的锁被 rollback 还回原位
      // 无 tomb 残留
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.oauth_refresh.stale-'))).toHaveLength(
        0,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('刷新全程持锁,成功后释放', async () => {
    const dir = makeLockDir();
    const lockPath = path.join(dir, '.oauth_refresh.lock');
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let lockedDuringFetch = false;
    const { deps } = makeDeps({
      lockDir: () => dir,
      readOAuth: () => current,
      fetchFn: (async () => {
        lockedDuringFetch = fs.existsSync(lockPath);
        return jsonResponse(200, { access_token: 'at-new', expires_in: 60 });
      }) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    await r.getValidOAuth();
    expect(lockedDuringFetch).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('claude-oauth-refresh — 收尾语义', () => {
  it('等待 refresh lock 期间 owner 切换 → 旧调用绝不返回新 owner 的 token', async () => {
    const dir = makeLockDir();
    fs.mkdirSync(path.join(dir, '.oauth_refresh.lock'));
    let generation = 7;
    const oldCredential = fixtureOAuth({ expiresAt: NOW - 1 });
    const newCredential = fixtureOAuth({
      accessToken: 'at-owner-b',
      refreshToken: 'rt-owner-b',
    });
    const { deps } = makeDeps({
      lockDir: () => dir,
      now: () => Date.now(),
      readOwnerScope: () => ({
        dataOwnerId: generation === 7 ? 'owner-a' : 'owner-b',
        generation,
        boundaryPending: false,
      }),
      readOAuth: () => (generation === 7 ? oldCredential : newCredential),
      sleep: async () => {
        generation = 8;
      },
    });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(refresher.getValidOAuth({ forceRefresh: true })).resolves.toBeNull();
  });

  it('刷新 HTTP 在途期间凭证库被换账号 → 丢弃刷新结果,采信库中新凭证', async () => {
    // review P2:换账号登录不经锁、不 bump generation,旧账号刷新结果写回会静默撤销换号。
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const switched = fixtureOAuth({
      accessToken: 'at-new-account',
      refreshToken: 'rt-new-account',
      expiresAt: NOW + 3600_000,
    });
    let swapped = false;
    let resolveFetch!: (r: Response) => void;
    const gate = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const { deps, written } = makeDeps({
      readOAuth: () => (swapped ? switched : stale),
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const pending = r.getValidOAuth({ forceRefresh: true });
    await new Promise((res) => setTimeout(res, 10)); // 让流程推进到 HTTP 在途
    swapped = true; // 换账号登录写库
    resolveFetch(
      jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
    );
    const out = await pending;
    expect(out?.accessToken).toBe('at-new-account'); // 采信新账号凭证
    expect(written).toHaveLength(0); // 旧账号刷新结果绝不写回
  });

  it('最后一次 replacement 检查后外部进程换 token → 条件写拒绝覆盖并返回新值', async () => {
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const switched = fixtureOAuth({
      accessToken: 'at-external-new-account',
      refreshToken: 'rt-external-new-account',
    });
    let stored = stale;
    const { deps } = makeDeps({
      readOAuth: () => stored,
      replaceOAuth: () => {
        // 模拟 standalone Claude 恰好在 refresh 的 postFetch read 之后、写锁之前换号。
        stored = switched;
        return 'changed';
      },
    });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(refresher.getValidOAuth({ forceRefresh: true })).resolves.toMatchObject({
      accessToken: 'at-external-new-account',
    });
    expect(stored).toBe(switched);
  });

  it('invalidate(登出)后在途刷新完成也不写回、不返回', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let resolveFetch!: (r: Response) => void;
    const gate = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const { deps, written } = makeDeps({
      readOAuth: () => current,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const pending = r.getValidOAuth({ forceRefresh: true });
    r.invalidate(); // 登出发生在刷新在途时
    resolveFetch(
      jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
    );
    expect(await pending).toBeNull();
    expect(written).toHaveLength(0); // 「已断开」状态凭证不复活
  });

  it('invalid_grant 但库已被换账号 → 采信新凭证,不触发 invalidate', async () => {
    // review P2:旧账号刷新失败(invalid_grant)不能 invalidate 掉在途换号登录的新账号。
    const stale = fixtureOAuth({ expiresAt: NOW - 1 });
    const switched = fixtureOAuth({
      accessToken: 'at-new-account',
      refreshToken: 'rt-new-account',
      expiresAt: NOW + 3600_000,
    });
    let swapped = false;
    let resolveFetch!: (r: Response) => void;
    const gate = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => (swapped ? switched : stale),
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    const pending = r.getValidOAuth({ forceRefresh: true });
    await new Promise((res) => setTimeout(res, 10));
    swapped = true; // HTTP 在途期间换账号登录
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));
    const out = await pending;
    expect(out?.accessToken).toBe('at-new-account');
    expect(onInvalidGrant).not.toHaveBeenCalled();
    expect(onCredentialRejected).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
    });

    swapped = false;
    expect(r.getOAuthForSpawn()).toBeNull();
  });

  it('invalid_grant(锁内确认)→ 通知 onInvalidGrant;传输类失败不通知', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => current,
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (async () =>
        jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch,
    });
    const r = createClaudeOAuthRefresher(deps);
    expect(await r.getValidOAuth({ forceRefresh: true })).toBeNull();
    expect(onInvalidGrant).toHaveBeenCalledTimes(1);
    expect(onInvalidGrant).toHaveBeenCalledWith({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
      durabilityEstablished: true,
    });
    expect(onCredentialRejected).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
    });

    const onInvalidGrant2 = vi.fn();
    const { deps: deps2 } = makeDeps({
      readOAuth: () => current,
      onInvalidGrant: onInvalidGrant2,
      fetchFn: (async () => jsonResponse(500, {})) as unknown as typeof fetch,
    });
    const r2 = createClaudeOAuthRefresher(deps2);
    expect(await r2.getValidOAuth({ forceRefresh: true })).toBeNull();
    expect(onInvalidGrant2).not.toHaveBeenCalled();
  });

  it('owner 已切换时仍重试 ELOCKED 的 token-global 拒绝记录,但不清理新会话', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let generation = 7;
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    let rejectionAttempts = 0;
    const onCredentialRejected = vi.fn(() => {
      rejectionAttempts += 1;
      if (rejectionAttempts === 1) {
        throw Object.assign(new Error('binding lock busy'), { code: 'ELOCKED' });
      }
    });
    const { deps } = makeDeps({
      readOAuth: () => current,
      readOwnerScope: () => ({ dataOwnerId: 'owner-a', generation, boundaryPending: false }),
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 8;
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBeNull();
    expect(onInvalidGrant).not.toHaveBeenCalled();
    expect(onCredentialRejected).toHaveBeenCalledTimes(2);
    expect(onCredentialRejected).toHaveBeenLastCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
    });
    expect(refresher.getOAuthForSpawn()).toBeNull();
  });

  it('ELOCKED rejection persistence outlives an orphaned binding lock before exact-clear fallback', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const delays: number[] = [];
    const onCredentialRejected = vi.fn(() => {
      throw Object.assign(new Error('orphaned binding lock'), { code: 'ELOCKED' });
    });
    const clearRejectedCredential = vi.fn(() => 'changed' as const);
    const { deps } = makeDeps({
      readOAuth: () => current,
      onCredentialRejected,
      clearRejectedCredential,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchFn: (async () =>
        jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(refresher.getValidOAuth({ forceRefresh: true })).resolves.toBeNull();
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(
      NATIVE_PROVIDER_AUTH_BINDING_LOCK_STALE_MS,
    );
    expect(onCredentialRejected).toHaveBeenCalledTimes(delays.length + 1);
    expect(clearRejectedCredential).toHaveBeenCalledOnce();
  });

  it('owner 已切换且拒绝记录永久失败时仍执行 token 精确清除', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let generation = 7;
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn(() => {
      throw Object.assign(new Error('sidecar permission denied'), { code: 'EACCES' });
    });
    const clearRejectedCredential = vi.fn(() => 'cleared' as const);
    const { deps } = makeDeps({
      readOAuth: () => current,
      readOwnerScope: () => ({ dataOwnerId: 'owner-a', generation, boundaryPending: false }),
      onInvalidGrant,
      onCredentialRejected,
      clearRejectedCredential,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 8;
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBeNull();
    expect(onCredentialRejected).toHaveBeenCalledOnce();
    expect(clearRejectedCredential).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
    });
    expect(onInvalidGrant).not.toHaveBeenCalled();
  });

  it('owner 切换不会取消 grant-scoped 耐久恢复重试', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let generation = 7;
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn(() => {
      throw Object.assign(new Error('primary sidecar unavailable'), { code: 'EACCES' });
    });
    let recoveryAttempts = 0;
    const onCredentialRejectionRecovery = vi.fn(() => {
      recoveryAttempts += 1;
      return recoveryAttempts >= 2;
    });
    const clearRejectedCredential = vi.fn(() => {
      throw Object.assign(new Error('credential store unavailable'), { code: 'EACCES' });
    });
    const { deps } = makeDeps({
      readOAuth: () => current,
      readOwnerScope: () => ({ dataOwnerId: 'owner-a', generation, boundaryPending: false }),
      onInvalidGrant,
      onCredentialRejected,
      onCredentialRejectionRecovery,
      clearRejectedCredential,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 8;
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBeNull();
    await vi.waitFor(() => expect(onCredentialRejectionRecovery).toHaveBeenCalledTimes(2));
    expect(onInvalidGrant).not.toHaveBeenCalled();
  });

  it('invalid_grant 不在 grant recovery 落盘前返回,避免退出窗口丢失拒绝状态', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryAttempts = 0;
    const onCredentialRejectionRecovery = vi.fn(() => {
      recoveryAttempts += 1;
      return recoveryAttempts >= 2;
    });
    const onInvalidGrant = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => current,
      onCredentialRejected: () => {
        throw Object.assign(new Error('primary sidecar unavailable'), { code: 'EACCES' });
      },
      onCredentialRejectionRecovery,
      clearRejectedCredential: () => {
        throw Object.assign(new Error('credential store unavailable'), { code: 'EACCES' });
      },
      onInvalidGrant,
      sleep: async () => recoveryGate,
      fetchFn: (async () =>
        jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);

    const pending = refresher.getValidOAuth({ forceRefresh: true });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(onCredentialRejectionRecovery).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseRecovery();
    await expect(pending).resolves.toBeNull();
    expect(onCredentialRejectionRecovery).toHaveBeenCalledTimes(2);
    expect(onInvalidGrant).toHaveBeenCalledWith(
      expect.objectContaining({ durabilityEstablished: true }),
    );
  });

  it('主拒绝记录和精确清除都失败时,grant-scoped recovery 仍让 proof 可耐久', async () => {
    const current = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyAuthorizationRevision: 'login-revision-1',
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn(() => {
      throw Object.assign(new Error('primary sidecar unreadable'), { code: 'EACCES' });
    });
    const onCredentialRejectionRecovery = vi.fn(() => true);
    const clearRejectedCredential = vi.fn(() => {
      throw Object.assign(new Error('credential store busy'), { code: 'EACCES' });
    });
    const { deps } = makeDeps({
      readOAuth: () => current,
      onInvalidGrant,
      onCredentialRejected,
      onCredentialRejectionRecovery,
      clearRejectedCredential,
      fetchFn: (async () =>
        jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);

    await expect(refresher.getValidOAuth({ forceRefresh: true })).resolves.toBeNull();
    expect(onCredentialRejected).toHaveBeenCalledOnce();
    expect(onCredentialRejectionRecovery).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      cindyAuthorizationRevision: 'login-revision-1',
    });
    expect(clearRejectedCredential).toHaveBeenCalledOnce();
    expect(onInvalidGrant).toHaveBeenCalledWith({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: {
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        cindyAuthorizationRevision: 'login-revision-1',
      },
      durabilityEstablished: true,
    });
  });

  it('shared reauthorization revision wins over a late invalid_grant with identical tokens', async () => {
    const original = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyAuthorizationRevision: 'login-revision-1',
    });
    let stored = original;
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => stored,
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A second Cindy process commits a browser login that happens to receive
    // the same token bytes. The shared, non-secret revision is the only signal
    // available to the first process.
    stored = {
      ...original,
      cindyAuthorizationRevision: 'login-revision-2',
    };
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBe(stored);
    expect(onCredentialRejected).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      cindyAuthorizationRevision: 'login-revision-1',
    });
    expect(onInvalidGrant).not.toHaveBeenCalled();
    expect(refresher.getOAuthForSpawn()).toBe(stored);
  });

  it('markerless r2 wins over a late markerless r1 invalid_grant in the first process', async () => {
    const r1 = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyCredentialRejectionRevision: 'login-revision-1',
    });
    const r2 = fixtureOAuth({
      expiresAt: NOW - 1,
      cindyCredentialRejectionRevision: 'login-revision-2',
    });
    let stored = r1;
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => stored,
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    stored = r2;
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBe(r2);
    expect(onCredentialRejected).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      cindyCredentialRejectionRevision: 'login-revision-1',
    });
    expect(onInvalidGrant).not.toHaveBeenCalled();
    expect(refresher.getOAuthForSpawn()).toBe(r2);
  });

  it('authorization of a different identity does not forgive the rejected token', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const onInvalidGrant = vi.fn();
    const onCredentialRejected = vi.fn();
    const { deps } = makeDeps({
      readOAuth: () => current,
      onInvalidGrant,
      onCredentialRejected,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    refresher.acceptCredential({ accessToken: 'at-other', refreshToken: 'rt-other' });
    resolveFetch(jsonResponse(400, { error: 'invalid_grant' }));

    await expect(pending).resolves.toBeNull();
    expect(onCredentialRejected).toHaveBeenCalledWith({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
    });
    expect(onInvalidGrant).toHaveBeenCalledTimes(1);
    expect(refresher.getOAuthForSpawn()).toBeNull();
  });

  it('exact rejected credential stays suppressed across owner generations and replacement rollback', async () => {
    let stored = fixtureOAuth();
    let ownerGeneration = 7;
    const replacement = fixtureOAuth({
      accessToken: 'at-replacement',
      refreshToken: 'rt-replacement',
    });
    const { deps, fetchMock } = makeDeps({
      readOAuth: () => stored,
      readOwnerScope: () => ({
        dataOwnerId: 'owner-a',
        generation: ownerGeneration,
        boundaryPending: false,
      }),
    });
    const refresher = createClaudeOAuthRefresher(deps);

    expect(
      refresher.rejectCredential({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
      }),
    ).toBe(true);
    expect(refresher.getOAuthForSpawn()).toBeNull();
    await expect(refresher.getValidOAuth()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    ownerGeneration = 8;
    expect(refresher.getOAuthForSpawn()).toBeNull();

    stored = replacement;
    expect(refresher.getOAuthForSpawn()).toBe(replacement);
    await expect(refresher.getValidOAuth()).resolves.toBe(replacement);

    for (let index = 0; index < 9; index += 1) {
      expect(
        refresher.rejectCredential({
          source: 'invalid_grant',
          owner: { dataOwnerId: 'owner-a', generation: ownerGeneration },
          rejectedCredential: {
            accessToken: `at-other-rejected-${index}`,
            refreshToken: `rt-other-rejected-${index}`,
          },
        }),
      ).toBe(true);
    }

    stored = fixtureOAuth();
    expect(refresher.getOAuthForSpawn()).toBeNull();
    await expect(refresher.getValidOAuth()).resolves.toBeNull();
  });

  it('explicit authorization accepts the exact rejected identity again', async () => {
    const current = fixtureOAuth();
    const { deps } = makeDeps({ readOAuth: () => current });
    const refresher = createClaudeOAuthRefresher(deps);
    const identity = { accessToken: 'at-old', refreshToken: 'rt-old' };

    expect(
      refresher.rejectCredential({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: identity,
      }),
    ).toBe(true);
    expect(refresher.getOAuthForSpawn()).toBeNull();

    refresher.acceptCredential(identity);
    expect(refresher.getOAuthForSpawn()).toBe(current);
    await expect(refresher.getValidOAuth()).resolves.toBe(current);
  });

  it('one process keeps the old grant fenced while another accepts identical tokens with a new revision', () => {
    const oldGrant = fixtureOAuth({ cindyAuthorizationRevision: 'login-revision-1' });
    const newGrant = fixtureOAuth({ cindyAuthorizationRevision: 'login-revision-2' });
    let stored = oldGrant;
    const { deps } = makeDeps({ readOAuth: () => stored });
    const firstProcess = createClaudeOAuthRefresher(deps);
    const secondProcess = createClaudeOAuthRefresher(deps);

    expect(
      firstProcess.rejectCredential({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: {
          accessToken: oldGrant.accessToken,
          refreshToken: oldGrant.refreshToken,
          cindyAuthorizationRevision: oldGrant.cindyAuthorizationRevision,
        },
      }),
    ).toBe(true);
    expect(firstProcess.getOAuthForSpawn()).toBeNull();

    stored = newGrant;
    secondProcess.acceptCredential(newGrant);
    expect(firstProcess.getOAuthForSpawn()).toBe(newGrant);

    stored = oldGrant;
    expect(firstProcess.getOAuthForSpawn()).toBeNull();
  });

  it('exact rejection fences an already in-flight refresh before it can write back', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const { deps, written } = makeDeps({
      readOAuth: () => current,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const pending = refresher.getValidOAuth({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(
      refresher.rejectCredential({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
      }),
    ).toBe(true);
    resolveFetch(
      jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
    );

    await expect(pending).resolves.toBeNull();
    expect(written).toHaveLength(0);
  });

  it('exact rejection fences every non-force waiter sharing an in-flight refresh', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    let resolveFetch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const { deps, written } = makeDeps({
      readOAuth: () => current,
      fetchFn: (() => gate) as unknown as typeof fetch,
    });
    const refresher = createClaudeOAuthRefresher(deps);
    const first = refresher.getValidOAuth();
    const second = refresher.getValidOAuth();
    await new Promise((resolve) => setTimeout(resolve, 10));

    refresher.rejectCredential({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
    });
    resolveFetch(
      jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(written).toHaveLength(0);
  });
});

describe('claude-oauth-refresh — spawn 非阻塞', () => {
  it('健康 token:同步返回现值,不触发刷新', () => {
    const { deps, fetchMock } = makeDeps();
    const r = createClaudeOAuthRefresher(deps);
    expect(r.getOAuthForSpawn()?.accessToken).toBe('at-old');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('临期 token:立即返回旧值(不阻塞),后台单飞完成刷新写回', async () => {
    const current = fixtureOAuth({ expiresAt: NOW - 1 });
    const { deps, written, fetchMock } = makeDeps({ readOAuth: () => current });
    const r = createClaudeOAuthRefresher(deps);
    const out = r.getOAuthForSpawn(); // 同步路径
    expect(out?.accessToken).toBe('at-old'); // 注旧 token,401 回调兜底
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(written).toHaveLength(1);
    });
    expect(written[0]!.accessToken).toBe('at-new');
  });
});

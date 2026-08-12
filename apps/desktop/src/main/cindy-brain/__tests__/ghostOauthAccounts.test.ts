/**
 * ghostOauthAccounts 单测:账号清单持久化 / access token 缓存与单飞刷新 /
 * invalid_grant 过期标记 / 断开与默认账号(规则 14,内存假体零 Electron)。
 */
import * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';

import {
  GHOST_OAUTH_INVALID_GRANT_RECHECK_DELAY_MS,
  GHOST_OAUTH_MAX_ACCOUNTS,
  GhostOauthAccountManager,
  missingAuthScopes,
  type GhostOauthDecl,
  type GhostOauthVault,
} from '../ghostOauthAccounts.js';

/** invalid_grant 路径的即时延时假体(不注入会真等 2 秒拖慢用例)。 */
const instantSleep = async (): Promise<void> => {};

const GHOST = 'cindy-google';
const KEY = 'google_account';

const DECL: GhostOauthDecl = {
  authorizeUrl: 'https://accounts.example.com/authorize',
  tokenUrl: 'https://accounts.example.com/token',
  scopes: ['scope.a'],
  identity: { url: 'https://api.example.com/userinfo', labelPath: 'email' },
};

function memoryVault(
  seed?: Record<string, string>,
): GhostOauthVault & { data: Map<string, string> } {
  const data = new Map<string, string>(
    Object.entries(seed ?? {}).map(([k, v]) => [`${GHOST}\u0000${k}`, v]),
  );
  return {
    data,
    read: (ghostId, key) => data.get(`${ghostId}\u0000${key}`) ?? null,
    store: (ghostId, key, value) => {
      data.set(`${ghostId}\u0000${key}`, value);
      return true;
    },
    remove: (ghostId, key) => {
      data.delete(`${ghostId}\u0000${key}`);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 模拟浏览器:从授权 URL 提取回调地址与 state 并回打 code。 */
function autoBrowser(code = 'code-1'): (url: string) => void {
  return (url) => {
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri') ?? '');
    cb.searchParams.set('code', code);
    cb.searchParams.set('state', u.searchParams.get('state') ?? '');
    setImmediate(() => {
      void fetch(cb.toString()).catch(() => undefined);
    });
  };
}

/** 预置一个"已连接账号"的保险库(绕过交互授权直测刷新链路)。 */
function seededVault(rt = 'rt-seed'): ReturnType<typeof memoryVault> {
  return memoryVault({
    [`${KEY}-client-id`]: 'cid',
    [`${KEY}-client-secret`]: 'csec',
    [`${KEY}-accounts`]: JSON.stringify({
      defaultAccountId: 'acc-1',
      accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
    }),
    [`${KEY}-rt-acc-1`]: rt,
  });
}

function oauthManifest(clientId: string): GhostManifest {
  return {
    schemaVersion: 2,
    kind: 'chip',
    id: GHOST,
    name: 'Google',
    description: 'test',
    whenToUse: 'test',
    version: '1.0.0',
    author: 'test',
    entry: 'main.js',
    slots: ['network'],
    network: {
      hosts: ['api.example.com'],
      secrets: [
        {
          key: KEY,
          label: 'Google account',
          source: 'oauth',
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['api.example.com'],
          },
          oauth: { ...DECL, clientId },
        },
      ],
    },
  };
}

describe('插件 OAuth clientId 迁移', () => {
  it('仅内置 clientId 变化时标记迁移过期，保留且不再消费旧 refresh token', async () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-old-client',
    });
    const onAccountStatusChanged = vi.fn();
    const fetchImpl = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
      onAccountStatusChanged,
    });

    expect(
      mgr.expireAccountsForChangedClients(
        oauthManifest('old-client'),
        oauthManifest('new-client'),
      ),
    ).toBe(1);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('expired');
    expect(mgr.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(1);
    await expect(
      mgr.getFreshAccessToken(GHOST, KEY, { ...DECL, clientId: 'new-client' }),
    ).resolves.toMatchObject({ ok: false, error: 'AUTH_EXPIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-old-client');
    expect(onAccountStatusChanged).toHaveBeenCalledWith({
      ghostId: GHOST,
      secretKey: KEY,
      status: 'expired',
    });
  });

  it('clientId 未变化或用户使用自定义 clientId 时不改变账号状态', () => {
    const unchangedVault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
    });
    const unchanged = new GhostOauthAccountManager({
      vault: unchangedVault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    expect(
      unchanged.expireAccountsForChangedClients(
        oauthManifest('same-client'),
        oauthManifest('same-client'),
      ),
    ).toBe(0);
    expect(unchanged.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    expect(unchanged.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(0);

    const customizedVault = memoryVault({
      [`${KEY}-client-id`]: 'custom-client',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
    });
    const customized = new GhostOauthAccountManager({
      vault: customizedVault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    expect(
      customized.expireAccountsForChangedClients(
        oauthManifest('old-client'),
        oauthManifest('new-client'),
      ),
    ).toBe(0);
    expect(customized.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    expect(customized.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(0);
  });

  it('迁移状态写入失败时抛错并保留旧账号与 refresh token', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-old-client',
    });
    const store = vault.store;
    vault.store = (ghostId, key, value) =>
      key === `${KEY}-accounts` ? false : store(ghostId, key, value);
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    expect(() =>
      mgr.expireAccountsForChangedClients(
        oauthManifest('old-client'),
        oauthManifest('new-client'),
      ),
    ).toThrow('Unable to persist OAuth client migration state');
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-old-client');
  });
});

describe('missingAuthScopes(快照推断)', () => {
  it.each([
    ['全量快照没有新增 scope', ['scope.a'], { authFace: 'full', authScopes: ['scope.a'] }, false],
    [
      '全量快照存在新增 scope',
      ['scope.a', 'scope.b'],
      { authFace: 'full', authScopes: ['scope.a'] },
      true,
    ],
    [
      '主动降面账号不猜',
      ['scope.a', 'scope.b'],
      { authFace: 'subset', authScopes: ['scope.a'] },
      false,
    ],
    ['老账号无快照不猜', ['scope.a', 'scope.b'], {}, false],
    ['只有 scope 面没有 full 标记不猜', ['scope.a', 'scope.b'], { authScopes: ['scope.a'] }, false],
  ] as const)('%s', (_name, declScopes, row, expected) => {
    expect(missingAuthScopes(declScopes, row).length > 0).toBe(expected);
  });

  it('老清单与非法快照继续宽松读取，不误报陈旧授权', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-old',
        accounts: [
          { id: 'acc-old', label: 'old@example.com', status: 'connected', createdAt: 1 },
          {
            id: 'acc-bad',
            label: 'bad@example.com',
            status: 'connected',
            createdAt: 2,
            authScopes: ['scope.a', 42],
            authFace: 'unknown',
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    const expanded = { ...DECL, scopes: ['scope.a', 'scope.b'] };

    expect(mgr.listAccounts(GHOST, KEY, expanded)).toMatchObject([
      { id: 'acc-old', scopeStale: false },
      { id: 'acc-bad', scopeStale: false },
    ]);
    expect(mgr.defaultMissingScopes(GHOST, KEY, expanded)).toEqual([]);
  });

  it('老账号无快照但有真实错误证据时触发建议与详情页角标', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-old',
        accounts: [
          {
            id: 'acc-old',
            label: 'old@example.com',
            status: 'connected',
            createdAt: 1,
            insufficientScopes: ['scope.b'],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    const expanded = { ...DECL, scopes: ['scope.a', 'scope.b'] };

    expect(mgr.defaultMissingScopes(GHOST, KEY, expanded)).toEqual(['scope.b']);
    expect(mgr.listAccounts(GHOST, KEY, expanded)[0]?.scopeStale).toBe(true);
  });

  it('真实错误证据优先于快照推断；无证据时回退快照', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@example.com',
            status: 'connected',
            createdAt: 1,
            authScopes: ['scope.a'],
            authFace: 'full',
            insufficientScopes: ['scope.c'],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    const expanded = { ...DECL, scopes: ['scope.a', 'scope.b', 'scope.c'] };

    expect(mgr.defaultMissingScopes(GHOST, KEY, expanded)).toEqual(['scope.c']);
    const manifest = JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}');
    delete manifest.accounts[0].insufficientScopes;
    vault.store(GHOST, `${KEY}-accounts`, JSON.stringify(manifest));
    expect(mgr.defaultMissingScopes(GHOST, KEY, expanded)).toEqual(['scope.b', 'scope.c']);
  });

  it('非法错误证据按 undefined 宽松读取，并回退快照推断', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@example.com',
            status: 'connected',
            createdAt: 1,
            authScopes: ['scope.a'],
            authFace: 'full',
            insufficientScopes: ['scope.b', 42],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    expect(
      mgr.defaultMissingScopes(GHOST, KEY, { ...DECL, scopes: ['scope.a', 'scope.b'] }),
    ).toEqual(['scope.b']);
  });

  it.each([
    ['纯空白', ['   ']],
    ['单项超长', ['x'.repeat(257)]],
    ['条数超限', Array.from({ length: 65 }, (_, index) => `scope.${index}`)],
  ])('%s 的持久化坏证据对判定惰性(按当前声明过滤,不整包丢弃)', (_name, insufficientScopes) => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@example.com',
            status: 'connected',
            createdAt: 1,
            insufficientScopes,
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    expect(mgr.defaultMissingScopes(GHOST, KEY, DECL)).toEqual([]);
  });

  it('历史证据已不在当前声明时忽略，并回退快照推断', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@example.com',
            status: 'connected',
            createdAt: 1,
            authScopes: ['scope.a'],
            authFace: 'full',
            insufficientScopes: ['scope.removed'],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    expect(
      mgr.defaultMissingScopes(GHOST, KEY, { ...DECL, scopes: ['scope.a', 'scope.b'] }),
    ).toEqual(['scope.b']);
  });

  it('错误证据只合并到默认账号，重复上报去重', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-2',
        accounts: [
          { id: 'acc-1', label: 'one@example.com', status: 'connected', createdAt: 1 },
          {
            id: 'acc-2',
            label: 'two@example.com',
            status: 'connected',
            createdAt: 2,
            insufficientScopes: ['scope.a'],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    const decl = ['scope.a', 'scope.b'];
    expect(mgr.reportInsufficientScopes(GHOST, KEY, ['scope.a', 'scope.b', 'scope.b'], decl)).toBe(
      'stored',
    );
    expect(mgr.reportInsufficientScopes(GHOST, KEY, ['scope.b'], decl)).toBe('unchanged');
    const accounts = JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts;
    expect(accounts[0]).not.toHaveProperty('insufficientScopes');
    expect(accounts[1].insufficientScopes).toEqual(['scope.a', 'scope.b']);
    expect(
      new GhostOauthAccountManager({
        vault: memoryVault(),
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal: vi.fn(),
      }).reportInsufficientScopes(GHOST, KEY, ['scope.a'], decl),
    ).toBe(false);
  });

  it('合并时按当前声明面裁剪,清单换代后的过期证据被淘汰,条数不越积越多', () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@example.com',
            status: 'connected',
            createdAt: 1,
            insufficientScopes: ['scope.old', 'scope.b'],
          },
        ],
      }),
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    expect(mgr.reportInsufficientScopes(GHOST, KEY, ['scope.c'], ['scope.b', 'scope.c'])).toBe(
      'stored',
    );
    const accounts = JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts;
    expect(accounts[0].insufficientScopes).toEqual(['scope.b', 'scope.c']);
  });
});

describe('connectAccount', () => {
  it('端口回收器只对第一方官方意识放行(第三方 redirectPort 不许借刀杀进程)', async () => {
    const blocker = http.createServer();
    const heldPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      const decl: GhostOauthDecl = {
        authorizeUrl: DECL.authorizeUrl,
        tokenUrl: DECL.tokenUrl,
        scopes: DECL.scopes,
        clientId: 'cid-baked',
        redirectPort: heldPort,
      };
      const reclaimPort = vi.fn(async () => false);
      const mkMgr = (): GhostOauthAccountManager =>
        new GhostOauthAccountManager({
          vault: memoryVault(),
          fetchImpl: vi.fn() as unknown as typeof fetch,
          openExternal: vi.fn(),
          reclaimPort,
        });
      // 第三方 id:门控挡住,占用直接报错,回收器(杀进程)绝不能被调用。
      await expect(mkMgr().connectAccount('evil-tools', KEY, decl)).resolves.toMatchObject({
        ok: false,
        error: 'LISTEN_FAILED',
      });
      expect(reclaimPort).not.toHaveBeenCalled();
      // 官方前缀 id:回收器放行被调用(此处回收失败仍 LISTEN_FAILED,只验门控)。
      await expect(mkMgr().connectAccount('cindy-google', KEY, decl)).resolves.toMatchObject({
        ok: false,
        error: 'LISTEN_FAILED',
      });
      expect(reclaimPort).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('happy path:授权 + 身份标签 + 清单与 rt 落库 + 默认账号', async () => {
    const vault = memoryVault({ [`${KEY}-client-id`]: 'cid' });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (url === DECL.identity?.url) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer at-1');
        return jsonResponse({ email: 'user@example.com' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });

    const result = await mgr.connectAccount(GHOST, KEY, DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.label).toBe('user@example.com');
    expect(result.account.isDefault).toBe(true);
    expect(result.account.status).toBe('connected');
    expect(result.account.scopeStale).toBe(false);

    const listed = mgr.listAccounts(GHOST, KEY, DECL);
    expect(listed).toHaveLength(1);
    expect(vault.read(GHOST, `${KEY}-rt-${result.account.id}`)).toBe('rt-1');
    // 清单里不落任何令牌字节。
    expect(vault.read(GHOST, `${KEY}-accounts`)).not.toContain('rt-1');
    expect(vault.read(GHOST, `${KEY}-accounts`)).not.toContain('at-1');
    const persistedAccount = JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts[0];
    expect(persistedAccount).toMatchObject({
      authScopes: ['scope.a'],
      authFace: 'full',
    });
    expect(persistedAccount).not.toHaveProperty('insufficientScopes');

    // 授权余温:access token 已进缓存,取用不再走网络。
    const fetchCalls = fetchImpl.mock.calls.length;
    const token = await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    expect(token).toMatchObject({ ok: true, accessToken: 'at-1' });
    expect(fetchImpl.mock.calls.length).toBe(fetchCalls);
  });

  it('授权回调后目标插件已卸载或声明已替换时不持久化凭证', async () => {
    const vault = memoryVault({ [`${KEY}-client-id`]: 'cid' });
    const isConnectTargetCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        return jsonResponse({
          access_token: 'at-stale',
          refresh_token: 'rt-stale',
          expires_in: 3600,
        });
      }
      if (url === DECL.identity?.url) {
        return jsonResponse({ email: 'stale@example.com' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
      isConnectTargetCurrent,
    });

    await expect(mgr.connectAccount(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'INVALID_CONFIG',
    });
    expect(isConnectTargetCurrent).toHaveBeenCalledTimes(2);
    expect(isConnectTargetCurrent).toHaveBeenLastCalledWith(GHOST, KEY, DECL);
    expect(vault.read(GHOST, `${KEY}-accounts`)).toBeNull();
    expect([...vault.data.values()]).not.toContain('rt-stale');
    expect([...vault.data.values()]).not.toContain('at-stale');
  });

  it('声明 avatarPath → 连接时下载头像存库(不带凭证),listAccounts 带 avatarDataUrl,断开清掉', async () => {
    const avatarDecl: GhostOauthDecl = {
      ...DECL,
      identity: {
        url: 'https://api.example.com/userinfo',
        labelPath: 'email',
        avatarPath: 'picture',
      },
    };
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const expectedDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const vault = memoryVault({ [`${KEY}-client-id`]: 'cid' });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (url === 'https://api.example.com/userinfo') {
        return jsonResponse({
          email: 'user@example.com',
          picture: 'https://cdn.example.com/a.png',
        });
      }
      if (url === 'https://cdn.example.com/a.png') {
        // 头像下载绝不带 Authorization(CDN 域名不在凭证注入白名单)。
        expect(new Headers(init?.headers).get('Authorization')).toBeNull();
        return new Response(new Uint8Array(pngBytes), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });

    const result = await mgr.connectAccount(GHOST, KEY, avatarDecl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.avatarDataUrl).toBe(expectedDataUrl);
    expect(vault.read(GHOST, `${KEY}-avatar-${result.account.id}`)).toBe(expectedDataUrl);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.avatarDataUrl).toBe(expectedDataUrl);

    // 断开:头像键随账号一起清。
    mgr.disconnectAccount(GHOST, KEY, result.account.id);
    expect(vault.read(GHOST, `${KEY}-avatar-${result.account.id}`)).toBeNull();
  });

  it('第三方意识声明 avatarPath → 不触发头像下载(SSRF 门控,恒无头像)', async () => {
    // client 凭证内置在详单里(memoryVault 的种子键挂在 GHOST 命名空间下,
    // 第三方 ghostId 读不到)。
    const avatarDecl: GhostOauthDecl = {
      ...DECL,
      clientId: 'cid-baked',
      identity: {
        url: 'https://api.example.com/userinfo',
        labelPath: 'email',
        avatarPath: 'picture',
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (url === 'https://api.example.com/userinfo') {
        return jsonResponse({
          email: 'user@example.com',
          picture: 'https://internal.example/secret.png',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount('evil-tools', KEY, avatarDecl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.avatarDataUrl).toBeNull();
    // 头像地址从未被主机请求过(fetch 只打过 token 与身份端点)。
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://internal.example/secret.png',
    );
  });

  it('头像下载失败 → 连接照常成功,avatarDataUrl 为 null(best-effort)', async () => {
    const avatarDecl: GhostOauthDecl = {
      ...DECL,
      identity: {
        url: 'https://api.example.com/userinfo',
        labelPath: 'email',
        avatarPath: 'picture',
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (url === 'https://api.example.com/userinfo') {
        return jsonResponse({
          email: 'user@example.com',
          picture: 'https://cdn.example.com/a.png',
        });
      }
      throw new Error('avatar cdn down');
    });
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount(GHOST, KEY, avatarDecl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.avatarDataUrl).toBeNull();
    expect(result.account.label).toBe('user@example.com');
  });

  it('client 未配置 → NO_CLIENT_CONFIG,不拉浏览器', async () => {
    const openExternal = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal,
    });
    await expect(mgr.connectAccount(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'NO_CLIENT_CONFIG',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('账号数达上限且非同身份 → 授权后拒 ACCOUNT_LIMIT(上限只拦真新增)', async () => {
    const accounts = Array.from({ length: GHOST_OAUTH_MAX_ACCOUNTS }, (_, i) => ({
      id: `acc-${i}`,
      label: `u${i}@x.com`,
      status: 'connected',
      createdAt: i,
    }));
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({ defaultAccountId: 'acc-0', accounts }),
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({
          access_token: 'at-full',
          refresh_token: 'rt-full',
          expires_in: 3600,
        });
      }
      return jsonResponse({ email: 'brand-new@x.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    await expect(mgr.connectAccount(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'ACCOUNT_LIMIT',
    });
    // 清单未被污染。
    expect(mgr.listAccounts(GHOST, KEY)).toHaveLength(GHOST_OAUTH_MAX_ACCOUNTS);
  });

  it('同身份重复授权 → 合并到既有账号(不新增行,rt 覆盖,expired 复活)', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@b.com',
            status: 'expired',
            expiredReason: 'oauth_client_changed',
            createdAt: 1,
          },
          { id: 'acc-2', label: 'other@b.com', status: 'connected', createdAt: 2 },
        ],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-dead',
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-re', refresh_token: 'rt-fresh', expires_in: 3600 });
      }
      return jsonResponse({ email: 'a@b.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount(GHOST, KEY, DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 复用既有 id,不新增行;状态复活;默认位不变。
    expect(result.account.id).toBe('acc-1');
    expect(result.account.status).toBe('connected');
    expect(result.account.isDefault).toBe(true);
    const listed = mgr.listAccounts(GHOST, KEY);
    expect(listed).toHaveLength(2);
    expect(mgr.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(0);
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-fresh');
    expect(JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts[0]).toMatchObject({
      authScopes: ['scope.a'],
      authFace: 'full',
    });
    // 授权余温:合并账号的 access token 已进缓存。
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL, 'acc-1')).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-re',
    });
  });

  it('clientId 迁移重连未返回 refresh token 时移除旧 token', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'a@b.com',
            status: 'expired',
            expiredReason: 'oauth_client_changed',
            createdAt: 1,
          },
        ],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-old-client',
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-re', expires_in: 3600 });
      }
      return jsonResponse({ email: 'a@b.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });

    await expect(mgr.connectAccount(GHOST, KEY, DECL)).resolves.toMatchObject({ ok: true });
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBeNull();
    expect(mgr.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(0);
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL, 'acc-1')).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-re',
    });
  });

  it('onAccountConnected 钩子:新连与同身份重连都触发(带标签);钩子抛错不影响连接结果', async () => {
    // 新连:带身份标签触发一次
    const onNew = vi.fn();
    const fetchNew = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      return jsonResponse({ email: 'user@example.com' });
    });
    const mgrNew = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: fetchNew as unknown as typeof fetch,
      openExternal: autoBrowser(),
      onAccountConnected: onNew,
    });
    expect((await mgrNew.connectAccount(GHOST, KEY, DECL)).ok).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith({
      ghostId: GHOST,
      secretKey: KEY,
      label: 'user@example.com',
    });

    // 同身份重连(合并):同样触发;钩子抛错不影响 ok 结果
    const onMerge = vi.fn(() => {
      throw new Error('toast down');
    });
    const fetchMerge = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-re', refresh_token: 'rt-fresh', expires_in: 3600 });
      }
      return jsonResponse({ email: 'a@b.com' });
    });
    const mgrMerge = new GhostOauthAccountManager({
      vault: memoryVault({
        [`${KEY}-client-id`]: 'cid',
        [`${KEY}-accounts`]: JSON.stringify({
          defaultAccountId: 'acc-1',
          accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
        }),
        [`${KEY}-rt-acc-1`]: 'rt-old',
      }),
      fetchImpl: fetchMerge as unknown as typeof fetch,
      openExternal: autoBrowser(),
      onAccountConnected: onMerge,
    });
    const merged = await mgrMerge.connectAccount(GHOST, KEY, DECL);
    expect(merged.ok).toBe(true);
    expect(onMerge).toHaveBeenCalledWith({ ghostId: GHOST, secretKey: KEY, label: 'a@b.com' });

    // 未声明 identity → label 为 null(接线侧据此落 oauthConnectedNoLabel 文案)
    const onNoLabel = vi.fn();
    const noIdentityDecl: GhostOauthDecl = {
      authorizeUrl: DECL.authorizeUrl,
      tokenUrl: DECL.tokenUrl,
      scopes: DECL.scopes,
    };
    const mgrNoLabel = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: vi.fn(async () =>
        jsonResponse({ access_token: 'at-n', refresh_token: 'rt-n', expires_in: 3600 }),
      ) as unknown as typeof fetch,
      openExternal: autoBrowser(),
      onAccountConnected: onNoLabel,
    });
    expect((await mgrNoLabel.connectAccount(GHOST, KEY, noIdentityDecl)).ok).toBe(true);
    expect(onNoLabel).toHaveBeenCalledWith({ ghostId: GHOST, secretKey: KEY, label: null });
  });

  it('满员时同身份重连仍放行(上限不拦重连)', async () => {
    const accounts = Array.from({ length: GHOST_OAUTH_MAX_ACCOUNTS }, (_, i) => ({
      id: `acc-${i}`,
      label: `u${i}@x.com`,
      status: 'connected',
      createdAt: i,
    }));
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({ defaultAccountId: 'acc-0', accounts }),
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3600 });
      }
      return jsonResponse({ email: 'u3@x.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount(GHOST, KEY, DECL);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.account.id).toBe('acc-3');
    expect(mgr.listAccounts(GHOST, KEY)).toHaveLength(GHOST_OAUTH_MAX_ACCOUNTS);
  });
});

describe('内置 client 回落链', () => {
  const BAKED: GhostOauthDecl = { ...DECL, clientId: 'baked-cid', clientSecret: 'baked-sec' };

  it('保险库无自填时用清单内置 client(零配置连接)', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        expect(form.get('client_id')).toBe('baked-cid');
        expect(form.get('client_secret')).toBe('baked-sec');
        return jsonResponse({ access_token: 'at-b', refresh_token: 'rt-b', expires_in: 3600 });
      }
      return jsonResponse({ email: 'b@c.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    expect(mgr.clientConfigured(GHOST, KEY, BAKED)).toBe(true);
    expect(mgr.clientCustomized(GHOST, KEY)).toBe(false);
    await expect(mgr.connectAccount(GHOST, KEY, BAKED)).resolves.toMatchObject({ ok: true });
  });

  it('自填成对覆盖内置(不混搭 secret);清除自填回落内置', async () => {
    const vault = memoryVault({ [`${KEY}-client-id`]: 'custom-cid' });
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DECL.tokenUrl) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        expect(form.get('client_id')).toBe('custom-cid');
        // 成对语义:自填只有 id 没有 secret = 纯 PKCE,绝不混内置 secret。
        seen.push(form.get('client_secret'));
        return jsonResponse({ access_token: 'at-c', expires_in: 3600 });
      }
      return jsonResponse({ email: 'c@d.com' });
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    expect(mgr.clientCustomized(GHOST, KEY)).toBe(true);
    await expect(mgr.connectAccount(GHOST, KEY, BAKED)).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual([null]);

    mgr.clearClientConfig(GHOST, KEY);
    expect(mgr.clientCustomized(GHOST, KEY)).toBe(false);
    expect(mgr.clientConfigured(GHOST, KEY, BAKED)).toBe(true);
    expect(mgr.clientConfigured(GHOST, KEY, DECL)).toBe(false);
  });
});

describe('getFreshAccessToken', () => {
  it('缓存冷:走 refresh,轮换 rt 覆盖落库', async () => {
    const vault = seededVault('rt-old');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'at-r', refresh_token: 'rt-rotated', expires_in: 3600 }),
    );
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    const result = await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    expect(result).toMatchObject({ ok: true, accessToken: 'at-r', accountId: 'acc-1' });
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-rotated');

    // 缓存热:第二次不再走网络。
    await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('并发单飞:两单并发只刷一次', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'at-sf', expires_in: 3600 }));
    const mgr = new GhostOauthAccountManager({
      vault: seededVault(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    const [a, b] = await Promise.all([
      mgr.getFreshAccessToken(GHOST, KEY, DECL),
      mgr.getFreshAccessToken(GHOST, KEY, DECL),
    ]);
    expect(a).toMatchObject({ ok: true, accessToken: 'at-sf' });
    expect(b).toMatchObject({ ok: true, accessToken: 'at-sf' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalid_grant → AUTH_EXPIRED + 账号标 expired + rt 清除', async () => {
    const vault = seededVault('rt-revoked');
    const onAccountStatusChanged = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: 'invalid_grant' }, 400),
      ) as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep: instantSleep,
      onAccountStatusChanged,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'AUTH_EXPIRED',
    });
    expect(mgr.listAccounts(GHOST, KEY)[0]).toMatchObject({ status: 'expired' });
    expect(mgr.clientMigrationExpiredAccountCount(GHOST, KEY)).toBe(0);
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBeNull();
    expect(onAccountStatusChanged).toHaveBeenCalledWith({
      ghostId: GHOST,
      secretKey: KEY,
      status: 'expired',
    });
  });

  it('refresh 成功复活 expired 账号后发脱敏状态回调', async () => {
    const vault = seededVault('rt-restored');
    vault.store(
      GHOST,
      `${KEY}-accounts`,
      JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'expired', createdAt: 1 }],
      }),
    );
    const onAccountStatusChanged = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ access_token: 'at-restored', expires_in: 3600 }),
      ) as unknown as typeof fetch,
      openExternal: vi.fn(),
      onAccountStatusChanged,
    });

    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-restored',
    });
    expect(onAccountStatusChanged).toHaveBeenCalledWith({
      ghostId: GHOST,
      secretKey: KEY,
      status: 'connected',
    });
  });

  it('状态未变化或账号清单写入失败时不发状态回调', async () => {
    const vault = seededVault('rt-revoked');
    const store = vault.store;
    vault.store = (ghostId, key, value) =>
      key === `${KEY}-accounts` ? false : store(ghostId, key, value);
    const onAccountStatusChanged = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: 'invalid_grant' }, 400),
      ) as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep: instantSleep,
      onAccountStatusChanged,
    });

    await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    expect(onAccountStatusChanged).not.toHaveBeenCalled();
  });

  it('瞬时刷新失败 → REFRESH_FAILED,账号不标过期', async () => {
    const mgr = new GhostOauthAccountManager({
      vault: seededVault(),
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: 'server_error' }, 500),
      ) as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'REFRESH_FAILED',
    });
    expect(mgr.listAccounts(GHOST, KEY)[0]).toMatchObject({ status: 'connected' });
  });

  it('invalidateAccessToken 作废缓存,下一单强制重刷(401 通道)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'at-x', expires_in: 3600 }));
    const mgr = new GhostOauthAccountManager({
      vault: seededVault(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    mgr.invalidateAccessToken(GHOST, KEY, 'acc-1');
    await mgr.getFreshAccessToken(GHOST, KEY, DECL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('显式 accountId 不存在 / 无任何账号 → NO_ACCOUNT', async () => {
    const mgr = new GhostOauthAccountManager({
      vault: seededVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL, 'acc-ghost')).resolves.toMatchObject({
      ok: false,
      error: 'NO_ACCOUNT',
    });
    const empty = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(empty.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'NO_ACCOUNT',
    });
  });
});

describe('多实例共库的 RT 轮换竞态(invalid_grant 防误删)', () => {
  /** 按请求体里的 refresh_token 分派响应的 token 端点假体。 */
  function rotationFetch(
    handlers: Record<string, (vault: ReturnType<typeof memoryVault>) => Response>,
    vault: ReturnType<typeof memoryVault>,
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const rt = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
      const handler = handlers[rt];
      if (!handler) throw new Error(`unexpected refresh_token ${rt}`);
      return handler(vault);
    });
  }

  it('invalid_grant 但库里 RT 已被其它实例轮换 → 用新 RT 重试成功,不标 expired 不删凭证', async () => {
    const vault = seededVault('rt-stale');
    const fetchImpl = rotationFetch(
      {
        'rt-stale': (v) => {
          // 模拟并发赢家:输家收到 invalid_grant 时,新 RT 已经在共享保险库里。
          v.store(GHOST, `${KEY}-rt-acc-1`, 'rt-winner');
          return jsonResponse({ error: 'invalid_grant' }, 400);
        },
        'rt-winner': () =>
          jsonResponse({ access_token: 'at-retry', refresh_token: 'rt-next', expires_in: 3600 }),
      },
      vault,
    );
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep: instantSleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-retry',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    // 重试轮换出的最新 RT 已落库。
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-next');
  });

  it('赢家落库晚于输家失败 → 延迟二次重读兜住轮换,重试成功', async () => {
    const vault = seededVault('rt-stale');
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBe(GHOST_OAUTH_INVALID_GRANT_RECHECK_DELAY_MS);
      // 等待窗口内赢家才把新 RT 写进共享保险库。
      vault.store(GHOST, `${KEY}-rt-acc-1`, 'rt-winner');
    });
    const fetchImpl = rotationFetch(
      {
        'rt-stale': () => jsonResponse({ error: 'invalid_grant' }, 400),
        'rt-winner': () => jsonResponse({ access_token: 'at-late', expires_in: 3600 }),
      },
      vault,
    );
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-late',
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    // 未回新 RT 的成功刷新沿用赢家写入的那枚,不许误删。
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-winner');
  });

  it('轮换重试仍 invalid_grant → 判真失效:标 expired 并删除最后用过的那枚(不再无限重试)', async () => {
    const vault = seededVault('rt-stale');
    const sleep = vi.fn(async () => {
      vault.store(GHOST, `${KEY}-rt-acc-1`, 'rt-second');
    });
    const fetchImpl = rotationFetch(
      {
        'rt-stale': () => jsonResponse({ error: 'invalid_grant' }, 400),
        'rt-second': () => jsonResponse({ error: 'invalid_grant' }, 400),
      },
      vault,
    );
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'AUTH_EXPIRED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('expired');
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBeNull();
  });

  it('判死时库里已被并发写入更新的 RT → compare-and-delete 不误删', async () => {
    const vault = seededVault('rt-stale');
    const sleep = vi.fn(async () => {
      vault.store(GHOST, `${KEY}-rt-acc-1`, 'rt-second');
    });
    const fetchImpl = rotationFetch(
      {
        'rt-stale': () => jsonResponse({ error: 'invalid_grant' }, 400),
        'rt-second': (v) => {
          // 重试也失败,但失败响应到达前又有实例写入了更新的 RT。
          v.store(GHOST, `${KEY}-rt-acc-1`, 'rt-third');
          return jsonResponse({ error: 'invalid_grant' }, 400);
        },
      },
      vault,
    );
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
      sleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: false,
      error: 'AUTH_EXPIRED',
    });
    // 标 expired 引导重连,但并发写入的 rt-third 不许被删(留给写入它的实例)。
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('expired');
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-third');
  });

  it('broker 模式同一套竞态语义:invalid_grant 后发现轮换 → 用新 RT 重试', async () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-stale',
    });
    const refresh = vi.fn(async (_slug: string, params: { refreshToken: string }) => {
      if (params.refreshToken === 'rt-stale') {
        vault.store(GHOST, `${KEY}-rt-acc-1`, 'rt-winner');
        return { ok: false as const, error: 'EXCHANGE_FAILED' as const, invalidGrant: true };
      }
      expect(params.refreshToken).toBe('rt-winner');
      return {
        ok: true as const,
        bundle: {
          accessToken: 'at-bk2',
          refreshToken: null,
          expiresAt: Date.now() + 60_000,
          grantedScope: null,
        },
      };
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
      broker: { exchange: vi.fn(), refresh },
      sleep: instantSleep,
    });
    const brokerDecl: GhostOauthDecl = {
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['read:x'],
      clientId: 'builtin-cid',
      pkce: false,
      tokenBroker: 'feishu',
    };
    await expect(mgr.getFreshAccessToken(GHOST, KEY, brokerDecl)).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-bk2',
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('connected');
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBe('rt-winner');
  });

  it('轮换新 RT 落库失败 → 本轮仍返回可用 token,但 warn 大声留痕', async () => {
    const vault = seededVault('rt-old');
    const failingVault: GhostOauthVault = {
      read: (g, k) => vault.read(g, k),
      store: (g, k, v) => (k === `${KEY}-rt-acc-1` ? false : vault.store(g, k, v)),
      remove: (g, k) => vault.remove(g, k),
    };
    const warn = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault: failingVault,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ access_token: 'at-w', refresh_token: 'rt-rotated', expires_in: 3600 }),
      ) as unknown as typeof fetch,
      openExternal: vi.fn(),
      logger: { info: vi.fn(), warn },
      sleep: instantSleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, DECL)).resolves.toMatchObject({
      ok: true,
      accessToken: 'at-w',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('落库失败'),
      expect.objectContaining({ ghostId: GHOST, accountId: 'acc-1' }),
    );
  });
});

describe('账号清单操作', () => {
  it('disconnect:摘行 + 清 rt + 默认账号顺延;setDefault 未知账号 → false', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          { id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 },
          { id: 'acc-2', label: 'c@d.com', status: 'connected', createdAt: 2 },
        ],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-1',
      [`${KEY}-rt-acc-2`]: 'rt-2',
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });

    mgr.disconnectAccount(GHOST, KEY, 'acc-1');
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBeNull();
    const listed = mgr.listAccounts(GHOST, KEY);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'acc-2', isDefault: true });

    expect(mgr.setDefaultAccount(GHOST, KEY, 'nope')).toBe(false);
    expect(mgr.setDefaultAccount(GHOST, KEY, 'acc-2')).toBe(true);
  });

  it('坏清单 JSON 容错为空,不炸', () => {
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-accounts`]: '{broken' }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    expect(mgr.listAccounts(GHOST, KEY)).toEqual([]);
  });

  it('clientConfigured 只回布尔', () => {
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    expect(mgr.clientConfigured(GHOST, KEY)).toBe(true);
    expect(mgr.clientConfigured(GHOST, 'other_key')).toBe(false);
  });
});

describe('tokenBroker 模式', () => {
  const BROKER_DECL: GhostOauthDecl = {
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['read:x'],
    clientId: 'builtin-cid',
    clientIdAlternatives: ['global-cid'],
    pkce: false,
    tokenBroker: 'jira',
  };

  it('connect 全链走 broker;用户自填 client 被忽略(恒用内置 clientId)', async () => {
    // 预置"用户自填过 client"的保险库——broker 模式必须无视它。
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'custom-cid-should-be-ignored',
      [`${KEY}-client-secret`]: 'custom-sec-should-be-ignored',
    });
    const fetchImpl = vi.fn();
    const exchange = vi.fn(async () => ({
      ok: true as const,
      bundle: {
        accessToken: 'at-bk',
        refreshToken: 'rt-bk',
        expiresAt: Date.now() + 60_000,
        grantedScope: null,
      },
    }));
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: (url) => {
        // 授权 URL 用内置 clientId,而不是用户自填的。
        expect(new URL(url).searchParams.get('client_id')).toBe('builtin-cid');
        autoBrowser('c-bk')(url);
      },
      broker: { exchange, refresh: vi.fn() },
    });

    const result = await mgr.connectAccount(GHOST, KEY, BROKER_DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(vault.read(GHOST, `${KEY}-rt-${result.account.id}`)).toBe('rt-bk');
    expect(exchange).toHaveBeenCalledTimes(1);
    // token 交换不直连 tokenUrl。
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain(BROKER_DECL.tokenUrl);
  });

  it('clientConfigured:brokered + 内置 clientId 恒 true,与保险库无关', () => {
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    expect(mgr.clientConfigured(GHOST, KEY, BROKER_DECL)).toBe(true);
    // brokered 但清单没内置 clientId → false(没有可用的授权身份)。
    expect(mgr.clientConfigured(GHOST, KEY, { ...BROKER_DECL, clientId: undefined })).toBe(false);
  });

  it('connect 可选清单内备用 clientId;未声明值防御性拒绝', async () => {
    const openExternal = vi.fn((url: string) => {
      expect(new URL(url).searchParams.get('client_id')).toBe('global-cid');
      autoBrowser('c-global')(url);
    });
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal,
      broker: {
        exchange: vi.fn(async () => ({
          ok: true as const,
          bundle: {
            accessToken: 'at-global',
            refreshToken: 'rt-global',
            expiresAt: Date.now() + 60_000,
            grantedScope: null,
          },
        })),
        refresh: vi.fn(),
      },
    });
    await expect(
      mgr.connectAccount(GHOST, KEY, BROKER_DECL, { clientId: 'global-cid' }),
    ).resolves.toMatchObject({ ok: true });
    expect(openExternal).toHaveBeenCalledTimes(1);

    const blockedOpenExternal = vi.fn();
    const blocked = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: blockedOpenExternal,
      broker: { exchange: vi.fn(), refresh: vi.fn() },
    });
    await expect(
      blocked.connectAccount(GHOST, KEY, BROKER_DECL, { clientId: 'foreign-cid' }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    expect(blockedOpenExternal).not.toHaveBeenCalled();
  });

  it('刷新链路走 broker.refresh;invalidGrant 标 expired 并清 rt', async () => {
    const vault = memoryVault({
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'a@b.com', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-dead',
    });
    const refresh = vi.fn(async () => ({
      ok: false as const,
      error: 'EXCHANGE_FAILED' as const,
      invalidGrant: true,
      detail: 'upstream rejected',
    }));
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: vi.fn(),
      broker: { exchange: vi.fn(), refresh },
      sleep: instantSleep,
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, BROKER_DECL)).resolves.toMatchObject({
      ok: false,
      error: 'AUTH_EXPIRED',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vault.read(GHOST, `${KEY}-rt-acc-1`)).toBeNull();
    expect(mgr.listAccounts(GHOST, KEY)[0]?.status).toBe('expired');
  });
});

describe('brokerBounce(双地址弹跳回调)', () => {
  /** brokerBounce 必与 tokenBroker + redirectPort 成套(校验层约束,这里按同形态构造)。 */
  function bounceDecl(redirectPort: number): GhostOauthDecl {
    return {
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['read:x'],
      clientId: 'builtin-cid',
      pkce: false,
      tokenBroker: 'jira',
      redirectPort,
      brokerBounce: { path: '/jira/bounce', callbackPath: '/jira/callback' },
    };
  }

  it('resolveBrokerPublicUrl 缺失 / 回 null → INVALID_CONFIG,不发起授权流', async () => {
    // 解析器未注入。
    const openExternal1 = vi.fn();
    const mgrNoResolver = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: openExternal1,
      broker: { exchange: vi.fn(), refresh: vi.fn() },
    });
    await expect(
      mgrNoResolver.connectAccount(GHOST, KEY, bounceDecl(53699)),
    ).resolves.toMatchObject({
      ok: false,
      error: 'INVALID_CONFIG',
    });
    expect(openExternal1).not.toHaveBeenCalled();

    // 解析器注入但回 null(broker 基地址未配置)。
    const openExternal2 = vi.fn();
    const mgrNullResolver = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: openExternal2,
      broker: { exchange: vi.fn(), refresh: vi.fn() },
      resolveBrokerPublicUrl: vi.fn(() => null),
    });
    await expect(
      mgrNullResolver.connectAccount(GHOST, KEY, bounceDecl(53699)),
    ).resolves.toMatchObject({
      ok: false,
      error: 'INVALID_CONFIG',
    });
    expect(openExternal2).not.toHaveBeenCalled();
  });

  it('解析成功:redirect_uri 用解析出的公网地址,本地监听在 brokerBounce.callbackPath', async () => {
    const probe = http.createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise((r) => probe.close(r));

    const PUBLIC_URI = 'https://broker.example.com/jira/bounce';
    const resolveBrokerPublicUrl = vi.fn((p: string) => {
      expect(p).toBe('/jira/bounce');
      return PUBLIC_URI;
    });
    const exchange = vi.fn(async (_slug: string, params: { code: string; redirectUri: string }) => {
      // broker exchange 收到的 redirectUri = 公网弹跳地址(与 authorize 一致)。
      expect(params.redirectUri).toBe(PUBLIC_URI);
      return {
        ok: true as const,
        bundle: {
          accessToken: 'at-bb',
          refreshToken: 'rt-bb',
          expiresAt: Date.now() + 60_000,
          grantedScope: null,
        },
      };
    });
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openExternal: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get('redirect_uri')).toBe(PUBLIC_URI);
        // 模拟弹跳路由的 302:直接回打本机 loopback 的声明 callbackPath。
        const cb = new URL(`http://127.0.0.1:${freePort}/jira/callback`);
        cb.searchParams.set('code', 'c-bb');
        cb.searchParams.set('state', u.searchParams.get('state') ?? '');
        setImmediate(() => {
          void fetch(cb.toString()).catch(() => undefined);
        });
      },
      broker: { exchange, refresh: vi.fn() },
      resolveBrokerPublicUrl,
    });
    const result = await mgr.connectAccount(GHOST, KEY, bounceDecl(freePort));
    expect(result).toMatchObject({ ok: true });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe('connectAccount · opts.scopes 收窄', () => {
  const NARROW_DECL: GhostOauthDecl = {
    authorizeUrl: 'https://accounts.example.com/authorize',
    tokenUrl: 'https://accounts.example.com/token',
    scopes: ['read:x', 'write:y'],
    clientId: 'builtin-cid',
  };

  it('声明子集 → 授权 URL 的 scope 面收窄为子集', async () => {
    let capturedScope: string | null = null;
    const vault = memoryVault();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ access_token: 'at-narrow', refresh_token: 'rt-narrow', expires_in: 3600 }),
      ) as unknown as typeof fetch,
      openExternal: (url) => {
        capturedScope = new URL(url).searchParams.get('scope');
        autoBrowser('c-narrow')(url);
      },
    });
    await expect(
      mgr.connectAccount(GHOST, KEY, NARROW_DECL, { scopes: ['read:x'] }),
    ).resolves.toMatchObject({ ok: true });
    expect(capturedScope).toBe('read:x');
    expect(JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts[0]).toMatchObject({
      authScopes: ['read:x'],
      authFace: 'subset',
    });
    expect(
      mgr.listAccounts(GHOST, KEY, {
        ...NARROW_DECL,
        scopes: ['read:x', 'write:y', 'admin:z'],
      })[0]?.scopeStale,
    ).toBe(false);
  });

  it('含未声明条目 / 空数组 → INVALID_CONFIG,不拉浏览器', async () => {
    const openExternal = vi.fn();
    const mkMgr = (): GhostOauthAccountManager =>
      new GhostOauthAccountManager({
        vault: memoryVault(),
        fetchImpl: vi.fn() as unknown as typeof fetch,
        openExternal,
      });
    await expect(
      mkMgr().connectAccount(GHOST, KEY, NARROW_DECL, { scopes: ['read:x', 'admin:z'] }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    await expect(
      mkMgr().connectAccount(GHOST, KEY, NARROW_DECL, { scopes: [] }),
    ).resolves.toMatchObject({ ok: false, error: 'INVALID_CONFIG' });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('identity.displayTemplate 展示名', () => {
  /** Slack 形态的声明:labelPath 是稳定 user_id,展示名由模板渲染。 */
  const SLACK_DECL: GhostOauthDecl = {
    authorizeUrl: 'https://slack.example.com/authorize',
    tokenUrl: 'https://slack.example.com/token',
    scopes: ['scope.a'],
    identity: {
      url: 'https://slack.example.com/auth.test',
      labelPath: 'user_id',
      displayTemplate: '{team} · {user}',
    },
  };

  function slackFetch(identityBody: Record<string, unknown>): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: string | URL | Request) => {
      if (String(input) === SLACK_DECL.tokenUrl) {
        return jsonResponse({ access_token: 'at-s', refresh_token: 'rt-s', expires_in: 3600 });
      }
      return jsonResponse(identityBody);
    });
  }

  it('新连:view.label 展示渲染名,清单里 label 仍是稳定身份键', async () => {
    const vault = memoryVault({ [`${KEY}-client-id`]: 'cid' });
    const onConnected = vi.fn();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: slackFetch({
        team: 'acme',
        user: 'devuser',
        user_id: 'U0EXAMPLE1',
      }) as unknown as typeof fetch,
      openExternal: autoBrowser(),
      onAccountConnected: onConnected,
    });
    const result = await mgr.connectAccount(GHOST, KEY, SLACK_DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.label).toBe('acme · devuser');
    expect(mgr.listAccounts(GHOST, KEY)[0]?.label).toBe('acme · devuser');
    // 清单持久层:合并键 label 仍是稳定 user_id,展示名单独落 displayLabel。
    const manifest = JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}') as {
      accounts: Array<{ label: string; displayLabel: string }>;
    };
    expect(manifest.accounts[0]).toMatchObject({
      label: 'U0EXAMPLE1',
      displayLabel: 'acme · devuser',
    });
    // 授权成功提示用展示名。
    expect(onConnected).toHaveBeenCalledWith({
      ghostId: GHOST,
      secretKey: KEY,
      label: 'acme · devuser',
    });
  });

  it('同身份重连:按稳定键合并到老账号(旧行 label 是 user_id),并补上展示名', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-legacy',
        accounts: [
          {
            id: 'acc-legacy',
            label: 'U0EXAMPLE1',
            status: 'connected',
            createdAt: 1,
            insufficientScopes: ['scope.a'],
          },
        ],
      }),
      [`${KEY}-rt-acc-legacy`]: 'rt-old',
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: slackFetch({
        team: 'acme',
        user: 'devuser',
        user_id: 'U0EXAMPLE1',
      }) as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount(GHOST, KEY, SLACK_DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 合并进老行(不新增),展示名刷新。
    expect(result.account.id).toBe('acc-legacy');
    expect(result.account.label).toBe('acme · devuser');
    expect(mgr.listAccounts(GHOST, KEY)).toHaveLength(1);
    expect(JSON.parse(vault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts[0]).not.toHaveProperty(
      'insufficientScopes',
    );
    expect(mgr.defaultMissingScopes(GHOST, KEY, SLACK_DECL)).toEqual([]);
  });

  it('同身份重连清除证据时账号清单写失败，返回 VAULT_WRITE_FAILED 而不假报成功', async () => {
    const baseVault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-legacy',
        accounts: [
          {
            id: 'acc-legacy',
            label: 'U0EXAMPLE1',
            status: 'connected',
            createdAt: 1,
            insufficientScopes: ['scope.a'],
          },
        ],
      }),
      [`${KEY}-rt-acc-legacy`]: 'rt-old',
    });
    const vault: GhostOauthVault = {
      read: baseVault.read,
      remove: baseVault.remove,
      store: (ghostId, storageKey, value) =>
        storageKey === `${KEY}-accounts` ? false : baseVault.store(ghostId, storageKey, value),
    };
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: slackFetch({
        team: 'acme',
        user: 'devuser',
        user_id: 'U0EXAMPLE1',
      }) as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });

    await expect(mgr.connectAccount(GHOST, KEY, SLACK_DECL)).resolves.toMatchObject({
      ok: false,
      error: 'VAULT_WRITE_FAILED',
    });
    expect(JSON.parse(baseVault.read(GHOST, `${KEY}-accounts`) ?? '{}').accounts[0]).toMatchObject({
      insufficientScopes: ['scope.a'],
    });
  });

  it('模板占位符取不到值 → 展示名降级,view.label 回落稳定身份键', async () => {
    const mgr = new GhostOauthAccountManager({
      vault: memoryVault({ [`${KEY}-client-id`]: 'cid' }),
      fetchImpl: slackFetch({ user_id: 'U0EXAMPLE1' }) as unknown as typeof fetch,
      openExternal: autoBrowser(),
    });
    const result = await mgr.connectAccount(GHOST, KEY, SLACK_DECL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.label).toBe('U0EXAMPLE1');
  });

  it('老账号回填:令牌刷新成功后 best-effort 补展示名(不用重连)', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-legacy',
        accounts: [{ id: 'acc-legacy', label: 'U0EXAMPLE1', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-legacy`]: 'rt-old',
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: slackFetch({
        team: 'acme',
        user: 'devuser',
        user_id: 'U0EXAMPLE1',
      }) as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, SLACK_DECL)).resolves.toMatchObject({
      ok: true,
    });
    // 回填是 fire-and-forget,轮询等它落库。
    await vi.waitFor(() => {
      expect(mgr.listAccounts(GHOST, KEY)[0]?.label).toBe('acme · devuser');
    });
  });

  it('回填幂等:已有展示名的账号刷新令牌不再拉身份端点', async () => {
    const vault = memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [
          {
            id: 'acc-1',
            label: 'U0EXAMPLE1',
            displayLabel: 'acme · devuser',
            status: 'connected',
            createdAt: 1,
          },
        ],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-old',
    });
    const fetchImpl = slackFetch({ team: 'acme', user: 'devuser', user_id: 'U0EXAMPLE1' });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, SLACK_DECL)).resolves.toMatchObject({
      ok: true,
    });
    // 给潜在的异步回填一个宏任务窗口,再断言没有第二次网络调用。
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mgr.listAccounts(GHOST, KEY)[0]?.label).toBe('acme · devuser');
  });
});

describe('identity.avatarPath 头像回填', () => {
  const AVATAR_DECL: GhostOauthDecl = {
    ...DECL,
    identity: {
      url: 'https://api.example.com/userinfo',
      labelPath: 'email',
      avatarPath: 'picture',
    },
  };
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

  /** avatarPath 上线前连的老账号(库里有 rt、无头像键)。 */
  function legacyVault(): ReturnType<typeof memoryVault> {
    return memoryVault({
      [`${KEY}-client-id`]: 'cid',
      [`${KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'user@example.com', status: 'connected', createdAt: 1 }],
      }),
      [`${KEY}-rt-acc-1`]: 'rt-old',
    });
  }

  function avatarFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DECL.tokenUrl) return jsonResponse({ access_token: 'at-2', expires_in: 3600 });
      if (url === 'https://api.example.com/userinfo') {
        return jsonResponse({
          email: 'user@example.com',
          picture: 'https://cdn.example.com/a.png',
        });
      }
      if (url === 'https://cdn.example.com/a.png') {
        return new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it('老账号回填:令牌刷新成功后 best-effort 补头像(不用重连)', async () => {
    const vault = legacyVault();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: avatarFetch() as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, AVATAR_DECL)).resolves.toMatchObject({
      ok: true,
    });
    // 回填是 fire-and-forget,轮询等它落库。
    await vi.waitFor(() => {
      expect(vault.read(GHOST, `${KEY}-avatar-acc-1`)).toBe(PNG_DATA_URL);
    });
    expect(mgr.listAccounts(GHOST, KEY)[0]?.avatarDataUrl).toBe(PNG_DATA_URL);
  });

  it('第三方意识回填不下载头像(SSRF 门控与 connect 同口径)', async () => {
    // displayTemplate 让第三方的回填仍会拉一次身份端点(展示名回填不设官方门),
    // 但身份响应里的头像地址绝不能被主机请求。
    // 模板刻意渲染出与种子 label 不同的值:waitFor 锚在"displayLabel 确已
    // 回填"上才不恒真——patchAccount(同步)之后若门被删,cdn fetch 在同一
    // 同步段内已发生,下面的负断言是确定性的,不与 backfill 微任务链竞态。
    const decl: GhostOauthDecl = {
      ...AVATAR_DECL,
      clientId: 'cid-baked',
      identity: { ...AVATAR_DECL.identity!, displayTemplate: '{email}·bf' },
    };
    const vault = memoryVault();
    vault.store(
      'evil-tools',
      `${KEY}-accounts`,
      JSON.stringify({
        defaultAccountId: 'acc-1',
        accounts: [{ id: 'acc-1', label: 'user@example.com', status: 'connected', createdAt: 1 }],
      }),
    );
    vault.store('evil-tools', `${KEY}-rt-acc-1`, 'rt-old');
    const fetchImpl = avatarFetch();
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken('evil-tools', KEY, decl)).resolves.toMatchObject({
      ok: true,
    });
    // 等展示名回填落库,证明身份端点确实拉过了(而不是回填整体没跑)。
    await vi.waitFor(() => {
      expect(mgr.listAccounts('evil-tools', KEY)[0]?.label).toBe('user@example.com·bf');
    });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://cdn.example.com/a.png',
    );
    expect(vault.read('evil-tools', `${KEY}-avatar-acc-1`)).toBeNull();
  });

  it('头像下载期间账号被断开 → 不写孤儿头像键', async () => {
    const vault = legacyVault();
    let releaseAvatar!: () => void;
    const gate = new Promise<void>((r) => {
      releaseAvatar = r;
    });
    let avatarRequestedResolve!: () => void;
    const avatarRequested = new Promise<void>((r) => {
      avatarRequestedResolve = r;
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DECL.tokenUrl) return jsonResponse({ access_token: 'at-2', expires_in: 3600 });
      if (url === 'https://api.example.com/userinfo') {
        return jsonResponse({
          email: 'user@example.com',
          picture: 'https://cdn.example.com/a.png',
        });
      }
      if (url === 'https://cdn.example.com/a.png') {
        avatarRequestedResolve();
        await gate;
        return new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const mgr = new GhostOauthAccountManager({
      vault,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openExternal: vi.fn(),
    });
    await expect(mgr.getFreshAccessToken(GHOST, KEY, AVATAR_DECL)).resolves.toMatchObject({
      ok: true,
    });
    // 等回填走到头像下载(此时被 gate 卡住),断开账号后再放行下载。
    await avatarRequested;
    mgr.disconnectAccount(GHOST, KEY, 'acc-1');
    releaseAvatar();
    await new Promise((r) => setTimeout(r, 20));
    // 下载完成但账号已不在清单:不许写孤儿头像键。
    expect(vault.read(GHOST, `${KEY}-avatar-acc-1`)).toBeNull();
    expect([...vault.data.keys()].some((k) => k.includes('-avatar-'))).toBe(false);
  });
});

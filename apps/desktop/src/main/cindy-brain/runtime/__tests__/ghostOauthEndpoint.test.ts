/**
 * ghostOauthEndpoint 单测:/oauth 协议端点分派(规则 14,假体零 Electron)。
 * 覆盖:状态回查(零令牌字节)、client 凭证只写、connect 结构化透传、
 * 断开/默认账号、未声明 key 统一 404、坏 body / 超长 / 错误 method。
 */
import { describe, expect, it, vi } from 'vitest';

import { GhostKvError } from '../../ghostKvStore.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from '../ghostSecretsEndpoint.js';
import { handleGhostOauthRequest, type GhostOauthEndpointManager } from '../ghostOauthEndpoint.js';
import type { GhostOauthDecl } from '../../ghostOauthAccounts.js';

const GHOST = 'g-oauth';
const DECL: GhostOauthDecl = {
  authorizeUrl: 'https://accounts.example.com/authorize',
  tokenUrl: 'https://accounts.example.com/token',
  scopes: ['read.a'],
};
const SECRETS = new Map<string, GhostOauthDecl>([['acct', DECL]]);

function fakeManager(
  overrides: Partial<GhostOauthEndpointManager> = {},
): GhostOauthEndpointManager {
  return {
    clientConfigured: vi.fn(() => true),
    clientCustomized: vi.fn(() => false),
    setClientConfig: vi.fn(() => true),
    clearClientConfig: vi.fn(),
    listAccounts: vi.fn(() => [
      {
        id: 'acc-1',
        label: 'a@b.com',
        status: 'connected' as const,
        isDefault: true,
        createdAt: 1,
        avatarDataUrl: null,
        scopeStale: true,
      },
    ]),
    connectAccount: vi.fn(async () => ({
      ok: true as const,
      account: {
        id: 'acc-2',
        label: 'c@d.com',
        status: 'connected' as const,
        isDefault: false,
        createdAt: 2,
        avatarDataUrl: null,
        scopeStale: false,
      },
    })),
    disconnectAccount: vi.fn(),
    setDefaultAccount: vi.fn(() => true),
    reportInsufficientScopes: vi.fn(() => 'stored' as const),
    ...overrides,
  };
}

function call(params: {
  method: string;
  pathname: string;
  body?: string;
  manager?: GhostOauthEndpointManager;
  bodyError?: Error;
}) {
  return handleGhostOauthRequest({
    method: params.method,
    pathname: params.pathname,
    readBodyText: async () => {
      if (params.bodyError) throw params.bodyError;
      return params.body ?? '';
    },
    oauthSecrets: SECRETS,
    manager: params.manager ?? fakeManager(),
    ghostId: GHOST,
  });
}

describe('GET /oauth', () => {
  it('回全部 oauth 凭证槽状态,零令牌字节', async () => {
    const manager = fakeManager();
    const outcome = await call({ method: 'GET', pathname: '/oauth', manager });
    expect(outcome.status).toBe(200);
    const parsed = JSON.parse(outcome.body ?? '[]') as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ key: 'acct', clientConfigured: true, clientCustom: false });
    expect((parsed[0].accounts as unknown[])[0]).toMatchObject({
      id: 'acc-1',
      isDefault: true,
      scopeStale: true,
    });
    expect(manager.listAccounts).toHaveBeenCalledWith(GHOST, 'acct', DECL);
    // 端点契约:响应体里不可能出现 token 类字段。
    expect(outcome.body).not.toMatch(/token|secret/i);
  });

  it('非 GET → 405', async () => {
    expect((await call({ method: 'POST', pathname: '/oauth' })).status).toBe(405);
  });
});

describe('PUT /oauth/<key>/client', () => {
  it('写入 clientId(+可选 clientSecret),204', async () => {
    const manager = fakeManager();
    const outcome = await call({
      method: 'PUT',
      pathname: '/oauth/acct/client',
      body: JSON.stringify({ clientId: ' cid-1 ', clientSecret: 'sec-1' }),
      manager,
    });
    expect(outcome.status).toBe(204);
    expect(manager.setClientConfig).toHaveBeenCalledWith(GHOST, 'acct', 'cid-1', 'sec-1');
  });

  it('clientSecret 省略/空串 = 纯 PKCE(undefined 传入)', async () => {
    const manager = fakeManager();
    await call({
      method: 'PUT',
      pathname: '/oauth/acct/client',
      body: JSON.stringify({ clientId: 'cid' }),
      manager,
    });
    expect(manager.setClientConfig).toHaveBeenCalledWith(GHOST, 'acct', 'cid', undefined);
    await call({
      method: 'PUT',
      pathname: '/oauth/acct/client',
      body: JSON.stringify({ clientId: 'cid', clientSecret: '  ' }),
      manager,
    });
    expect(manager.setClientConfig).toHaveBeenLastCalledWith(GHOST, 'acct', 'cid', undefined);
  });

  it('坏 body / 空 clientId → 400;超长 → 413;写失败 → 500;DELETE 清除 → 204', async () => {
    expect(
      (await call({ method: 'PUT', pathname: '/oauth/acct/client', body: '{broken' })).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          pathname: '/oauth/acct/client',
          body: JSON.stringify({ clientId: '' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          pathname: '/oauth/acct/client',
          body: JSON.stringify({ clientId: 'x'.repeat(GHOST_SECRET_VALUE_MAX_CHARS + 1) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call({
          method: 'PUT',
          pathname: '/oauth/acct/client',
          body: JSON.stringify({ clientId: 'cid' }),
          bodyError: new GhostKvError('TOO_LARGE', 'too large'),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call({
          method: 'PUT',
          pathname: '/oauth/acct/client',
          body: JSON.stringify({ clientId: 'cid' }),
          manager: fakeManager({ setClientConfig: vi.fn(() => false) }),
        })
      ).status,
    ).toBe(500);
    const manager = fakeManager();
    expect((await call({ method: 'DELETE', pathname: '/oauth/acct/client', manager })).status).toBe(
      204,
    );
    expect(manager.clearClientConfig).toHaveBeenCalledWith(GHOST, 'acct');
  });
});

describe('POST /oauth/<key>/connect', () => {
  it('成功:200 + {ok:true, account}', async () => {
    const outcome = await call({ method: 'POST', pathname: '/oauth/acct/connect' });
    expect(outcome.status).toBe(200);
    expect(JSON.parse(outcome.body ?? '{}')).toMatchObject({ ok: true, account: { id: 'acc-2' } });
  });

  it('业务失败(超时/拒绝):200 + {ok:false, error}(结构化,页面可提示)', async () => {
    const outcome = await call({
      method: 'POST',
      pathname: '/oauth/acct/connect',
      manager: fakeManager({
        connectAccount: vi.fn(async () => ({ ok: false as const, error: 'TIMEOUT' as const })),
      }),
    });
    expect(outcome.status).toBe(200);
    expect(JSON.parse(outcome.body ?? '{}')).toMatchObject({ ok: false, error: 'TIMEOUT' });
  });

  it('GET → 405;流程异常 → 500', async () => {
    expect((await call({ method: 'GET', pathname: '/oauth/acct/connect' })).status).toBe(405);
    expect(
      (
        await call({
          method: 'POST',
          pathname: '/oauth/acct/connect',
          manager: fakeManager({
            connectAccount: vi.fn(async () => {
              throw new Error('boom');
            }),
          }),
        })
      ).status,
    ).toBe(500);
  });
});

describe('POST /oauth/<key>/connect · scopes body(降面授权)', () => {
  const SCOPED: GhostOauthDecl = {
    authorizeUrl: 'https://accounts.example.com/authorize',
    tokenUrl: 'https://accounts.example.com/token',
    scopes: ['read.a', 'write.b'],
  };
  const SCOPED_SECRETS = new Map<string, GhostOauthDecl>([['acct', SCOPED]]);

  function connectWith(body: string | undefined, manager = fakeManager()) {
    return handleGhostOauthRequest({
      method: 'POST',
      pathname: '/oauth/acct/connect',
      readBodyText: async () => body ?? '',
      oauthSecrets: SCOPED_SECRETS,
      manager,
      ghostId: GHOST,
    });
  }

  it('合法子集透传给 manager 的 opts.scopes(重复条目去重)', async () => {
    const manager = fakeManager();
    const outcome = await connectWith(JSON.stringify({ scopes: ['read.a', 'read.a'] }), manager);
    expect(outcome.status).toBe(200);
    expect(manager.connectAccount).toHaveBeenCalledWith(GHOST, 'acct', SCOPED, {
      scopes: ['read.a'],
    });
  });

  it('无 body / 空 body / 无 scopes 字段的对象 = 不传 opts(申请全量声明面)', async () => {
    const manager = fakeManager();
    await connectWith(undefined, manager);
    expect(manager.connectAccount).toHaveBeenLastCalledWith(GHOST, 'acct', SCOPED, undefined);
    await connectWith('   ', manager);
    expect(manager.connectAccount).toHaveBeenLastCalledWith(GHOST, 'acct', SCOPED, undefined);
    await connectWith('{}', manager);
    expect(manager.connectAccount).toHaveBeenLastCalledWith(GHOST, 'acct', SCOPED, undefined);
  });

  it('超集 / 空数组 / 非数组 / 含非字符串 / body 非 JSON 对象 → 400 且不触发授权流', async () => {
    for (const body of [
      JSON.stringify({ scopes: ['read.a', 'admin.z'] }), // 含未声明条目
      JSON.stringify({ scopes: [] }), // 空数组
      JSON.stringify({ scopes: 'read.a' }), // 非数组
      JSON.stringify({ scopes: ['read.a', 42] }), // 含非字符串
      JSON.stringify(['read.a']), // body 是数组不是对象
      JSON.stringify('read.a'), // body 是标量
      '{broken', // 坏 JSON
    ]) {
      const manager = fakeManager();
      const outcome = await connectWith(body, manager);
      expect(outcome.status, `body=${body}`).toBe(400);
      expect(manager.connectAccount, `body=${body}`).not.toHaveBeenCalled();
    }
  });
});

describe('POST /oauth/<key>/insufficient-scopes', () => {
  const DECLARED_SCOPES = Array.from({ length: 320 }, (_, index) => `scope.${index}`);
  const SCOPED: GhostOauthDecl = {
    authorizeUrl: 'https://accounts.example.com/authorize',
    tokenUrl: 'https://accounts.example.com/token',
    scopes: DECLARED_SCOPES,
  };
  const SCOPED_SECRETS = new Map<string, GhostOauthDecl>([['acct', SCOPED]]);

  function report(
    body: string,
    manager = fakeManager(),
    onChanged = vi.fn(),
    pathname = '/oauth/acct/insufficient-scopes',
  ) {
    return handleGhostOauthRequest({
      method: 'POST',
      pathname,
      readBodyText: async () => body,
      oauthSecrets: SCOPED_SECRETS,
      manager,
      ghostId: GHOST,
      onChanged,
    });
  }

  it('合法证据落默认账号并广播变更(重复条目由存取层去重)，成功 204', async () => {
    const manager = fakeManager();
    const onChanged = vi.fn();
    const outcome = await report(
      JSON.stringify({ scopes: ['scope.1', 'scope.1', 'scope.2'] }),
      manager,
      onChanged,
    );
    expect(outcome.status).toBe(204);
    expect(manager.reportInsufficientScopes).toHaveBeenCalledWith(
      GHOST,
      'acct',
      ['scope.1', 'scope.1', 'scope.2'],
      DECLARED_SCOPES,
    );
    expect(onChanged).toHaveBeenCalledWith('acct');
  });

  it('证据未变时成功 204 但不广播,重复上报不空转投影与配置卡重评估', async () => {
    const manager = fakeManager({ reportInsufficientScopes: vi.fn(() => 'unchanged' as const) });
    const onChanged = vi.fn();
    const outcome = await report(JSON.stringify({ scopes: ['scope.1'] }), manager, onChanged);
    expect(outcome.status).toBe(204);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('320 条边界放行；321 条拒绝', async () => {
    const accepted = fakeManager();
    expect((await report(JSON.stringify({ scopes: DECLARED_SCOPES }), accepted)).status).toBe(204);
    expect(accepted.reportInsufficientScopes).toHaveBeenCalledWith(
      GHOST,
      'acct',
      DECLARED_SCOPES,
      DECLARED_SCOPES,
    );

    const rejected = fakeManager();
    expect(
      (await report(JSON.stringify({ scopes: [...DECLARED_SCOPES, DECLARED_SCOPES[0]] }), rejected))
        .status,
    ).toBe(400);
    expect(rejected.reportInsufficientScopes).not.toHaveBeenCalled();
  });

  it('任一未声明 scope 越界时整包 400，不落任何数据', async () => {
    const manager = fakeManager();
    const outcome = await report(
      JSON.stringify({ scopes: ['scope.1', 'scope.not-declared'] }),
      manager,
    );
    expect(outcome.status).toBe(400);
    expect(manager.reportInsufficientScopes).not.toHaveBeenCalled();
  });

  it.each([
    ['非数组', { scopes: 'scope.1' }],
    ['空数组', { scopes: [] }],
    ['空字符串', { scopes: [''] }],
    ['空白字符串', { scopes: ['   '] }],
    ['超长字符串', { scopes: ['x'.repeat(257)] }],
    ['非字符串', { scopes: [42] }],
  ])('%s → 400 且不入库', async (_name, body) => {
    const manager = fakeManager();
    expect((await report(JSON.stringify(body), manager)).status).toBe(400);
    expect(manager.reportInsufficientScopes).not.toHaveBeenCalled();
  });

  it('未知 key 404；非 POST 405；持久化失败 500', async () => {
    expect(
      (
        await report(
          JSON.stringify({ scopes: ['scope.1'] }),
          fakeManager(),
          vi.fn(),
          '/oauth/unknown/insufficient-scopes',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleGhostOauthRequest({
          method: 'GET',
          pathname: '/oauth/acct/insufficient-scopes',
          readBodyText: async () => '',
          oauthSecrets: SCOPED_SECRETS,
          manager: fakeManager(),
          ghostId: GHOST,
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await report(
          JSON.stringify({ scopes: ['scope.1'] }),
          fakeManager({ reportInsufficientScopes: vi.fn(() => false as const) }),
        )
      ).status,
    ).toBe(500);
  });
});

describe('账号操作', () => {
  it('DELETE /oauth/<key>/accounts/<id> 断开 → 204', async () => {
    const manager = fakeManager();
    const outcome = await call({
      method: 'DELETE',
      pathname: '/oauth/acct/accounts/acc-1',
      manager,
    });
    expect(outcome.status).toBe(204);
    expect(manager.disconnectAccount).toHaveBeenCalledWith(GHOST, 'acct', 'acc-1');
  });

  it('POST /oauth/<key>/default 设默认;未知账号 404;坏 body 400', async () => {
    const manager = fakeManager();
    expect(
      (
        await call({
          method: 'POST',
          pathname: '/oauth/acct/default',
          body: JSON.stringify({ accountId: 'acc-1' }),
          manager,
        })
      ).status,
    ).toBe(204);
    expect(manager.setDefaultAccount).toHaveBeenCalledWith(GHOST, 'acct', 'acc-1');
    expect(
      (
        await call({
          method: 'POST',
          pathname: '/oauth/acct/default',
          body: JSON.stringify({ accountId: 'nope' }),
          manager: fakeManager({ setDefaultAccount: vi.fn(() => false) }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', pathname: '/oauth/acct/default', body: '{}' })).status,
    ).toBe(400);
  });
});

describe('路径与 key 准入', () => {
  it('未声明 key / 非法子路径统一 404,不给区分面', async () => {
    for (const pathname of [
      '/oauth/unknown/client',
      '/oauth/acct',
      '/oauth/acct/unknown',
      '/oauth/acct/accounts',
      '/oauth/acct/client/extra',
      '/oauth/',
    ]) {
      const outcome = await call({ method: 'GET', pathname });
      expect([404, 405]).toContain(outcome.status);
      const outcome2 = await call({ method: 'PUT', pathname, body: '{}' });
      expect([404, 405]).toContain(outcome2.status);
    }
    expect(
      (await call({ method: 'PUT', pathname: '/oauth/unknown/client', body: '{"clientId":"x"}' }))
        .status,
    ).toBe(404);
  });
});

describe('tokenBroker 门控', () => {
  const BROKERED: GhostOauthDecl = {
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'builtin-cid',
    clientIdAlternatives: ['global-cid'],
    pkce: false,
    tokenBroker: 'jira',
  };
  const BROKERED_SECRETS = new Map<string, GhostOauthDecl>([['acct', BROKERED]]);

  function callAs(
    ghostId: string,
    method: string,
    pathname: string,
    manager = fakeManager(),
    body: Record<string, unknown> = {},
  ) {
    return handleGhostOauthRequest({
      method,
      pathname,
      readBodyText: async () => JSON.stringify(body),
      oauthSecrets: BROKERED_SECRETS,
      manager,
      ghostId,
    });
  }

  it('brokered 凭证的 client 自填/清除通道一律 405', async () => {
    const manager = fakeManager();
    await expect(
      callAs('xd-atlassian', 'PUT', '/oauth/acct/client', manager),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      callAs('xd-atlassian', 'DELETE', '/oauth/acct/client', manager),
    ).resolves.toMatchObject({ status: 405 });
    expect(manager.setClientConfig).not.toHaveBeenCalled();
    expect(manager.clearClientConfig).not.toHaveBeenCalled();
  });

  it('connect:官方前缀 id 放行;第三方 id 结构化拒(不触发授权流程)', async () => {
    const okManager = fakeManager();
    const allowed = await callAs('xd-atlassian', 'POST', '/oauth/acct/connect', okManager);
    expect(allowed.status).toBe(200);
    expect(okManager.connectAccount).toHaveBeenCalledTimes(1);

    const blockedManager = fakeManager();
    const blocked = await callAs('third-party', 'POST', '/oauth/acct/connect', blockedManager);
    expect(blocked.status).toBe(200);
    expect(JSON.parse(blocked.body ?? '{}')).toMatchObject({
      ok: false,
      error: 'BROKER_FORBIDDEN',
    });
    expect(blockedManager.connectAccount).not.toHaveBeenCalled();
  });

  it('connect:可选择清单声明的备用 clientId;未声明值在端点拒绝', async () => {
    const manager = fakeManager();
    const selected = await callAs('xd-atlassian', 'POST', '/oauth/acct/connect', manager, {
      clientId: 'global-cid',
    });
    expect(selected.status).toBe(200);
    expect(manager.connectAccount).toHaveBeenCalledWith('xd-atlassian', 'acct', BROKERED, {
      clientId: 'global-cid',
    });

    const rejectedManager = fakeManager();
    const rejected = await callAs('xd-atlassian', 'POST', '/oauth/acct/connect', rejectedManager, {
      clientId: 'foreign-cid',
    });
    expect(rejected.status).toBe(400);
    expect(rejectedManager.connectAccount).not.toHaveBeenCalled();
  });
});

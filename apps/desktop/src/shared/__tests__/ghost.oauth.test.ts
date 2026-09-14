/**
 * ghost · OAuth 凭证声明(source: 'oauth')校验与确认框条目。
 * 独立文件(不并入 ghost.test.ts):OAuth 契约(2026-07-13 通用声明式定案)
 * 的专属回归面——authorizeUrl / tokenUrl 域名钉白名单、scopes 上限、保留
 * 参数拒绝、identity 声明、确认框展示授权域名与 scopes 原文。
 */
import { describe, expect, it } from 'vitest';

import {
  GHOST_OAUTH_CLIENT_ID_ALTERNATIVES_MAX,
  GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS,
  GHOST_OAUTH_SCOPES_MAX,
  ghostPermissionItems,
  validateGhostManifest,
  type GhostManifest,
} from '../ghost.js';

/** 带 network 槽 + oauth 凭证的最小合法清单。 */
function oauthManifest(overrides?: {
  secret?: Record<string, unknown>;
  oauth?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'g-oauth',
    name: 'OAuth 意识',
    version: '1.0.0',
    entry: 'main.js',
    slots: ['network'],
    settingsHtml: 'settings.html',
    network: {
      hosts: ['accounts.example.com', 'api.example.com'],
      secrets: [
        {
          key: 'acct',
          label: 'Example 账号',
          source: 'oauth',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          ...(overrides && Object.hasOwn(overrides, 'oauth')
            ? overrides.oauth !== undefined
              ? { oauth: overrides.oauth }
              : {}
            : {
                oauth: {
                  authorizeUrl: 'https://accounts.example.com/authorize',
                  tokenUrl: 'https://accounts.example.com/token',
                  scopes: ['read.a', 'write.b'],
                },
              }),
          ...(overrides?.secret ?? {}),
        },
      ],
    },
  };
}

describe('ghost · oauth 凭证声明校验', () => {
  it('合法声明通过,归一化保留 oauth 详单', () => {
    const result = validateGhostManifest(oauthManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secret = result.manifest.network?.secrets?.[0];
    expect(secret?.source).toBe('oauth');
    expect(secret?.oauth?.authorizeUrl).toBe('https://accounts.example.com/authorize');
    expect(secret?.oauth?.scopes).toEqual(['read.a', 'write.b']);
  });

  it('source: oauth 而缺 oauth 详单 → 拒', () => {
    expect(validateGhostManifest(oauthManifest({ oauth: undefined })).ok).toBe(false);
  });

  it('非 oauth 来源声明 oauth 详单 → 拒', () => {
    const m = oauthManifest();
    const secret = (m.network as { secrets: Record<string, unknown>[] }).secrets[0];
    delete secret.source;
    expect(validateGhostManifest(m).ok).toBe(false);
  });

  it('oauth 与 exchange 互斥', () => {
    const result = validateGhostManifest(
      oauthManifest({
        secret: {
          exchange: { url: 'https://api.example.com/token', bodyFormat: '{"k":"{value}"}', tokenPath: 't' },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('exchange');
  });

  it('authorizeUrl / tokenUrl / identity.url 域名必须命中 hosts 白名单', () => {
    for (const field of ['authorizeUrl', 'tokenUrl'] as const) {
      const oauth: Record<string, unknown> = {
        authorizeUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
      };
      oauth[field] = 'https://evil.com/x';
      expect(validateGhostManifest(oauthManifest({ oauth })).ok, field).toBe(false);
    }
    expect(
      validateGhostManifest(
        oauthManifest({
          oauth: {
            authorizeUrl: 'https://accounts.example.com/authorize',
            tokenUrl: 'https://accounts.example.com/token',
            identity: { url: 'https://evil.com/me', labelPath: 'email' },
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('http / 带端口 / 内嵌凭证的端点 → 拒', () => {
    for (const bad of [
      'http://accounts.example.com/authorize',
      'https://accounts.example.com:8443/authorize',
      'https://u:p@accounts.example.com/authorize',
    ]) {
      expect(
        validateGhostManifest(
          oauthManifest({ oauth: { authorizeUrl: bad, tokenUrl: 'https://accounts.example.com/token' } }),
        ).ok,
        bad,
      ).toBe(false);
    }
  });

  it('scopes:超上限 / 含空白 / 重复 → 拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, scopes: Array.from({ length: GHOST_OAUTH_SCOPES_MAX + 1 }, (_, i) => `s${i}`) } }),
      ).ok,
    ).toBe(false);
    expect(validateGhostManifest(oauthManifest({ oauth: { ...base, scopes: ['bad scope'] } })).ok).toBe(false);
    expect(validateGhostManifest(oauthManifest({ oauth: { ...base, scopes: ['dup', 'dup'] } })).ok).toBe(false);
  });

  it('extraAuthorizeParams:保留参数 / 非法键名 / 超长值 → 拒;合法参数通过', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    for (const reserved of GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS) {
      expect(
        validateGhostManifest(oauthManifest({ oauth: { ...base, extraAuthorizeParams: { [reserved]: 'x' } } })).ok,
        reserved,
      ).toBe(false);
    }
    expect(
      validateGhostManifest(oauthManifest({ oauth: { ...base, extraAuthorizeParams: { 'Bad-Key': 'x' } } })).ok,
    ).toBe(false);
    expect(
      validateGhostManifest(oauthManifest({ oauth: { ...base, extraAuthorizeParams: { ok_key: 'x'.repeat(201) } } })).ok,
    ).toBe(false);
    const good = validateGhostManifest(
      oauthManifest({
        oauth: { ...base, extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' } },
      }),
    );
    expect(good.ok).toBe(true);
  });

  it('内置 client 凭证:合法通过并保留;孤儿 secret / 含空白 / 超长拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    const good = validateGhostManifest(
      oauthManifest({ oauth: { ...base, clientId: 'cid-1.apps.example.com', clientSecret: 'GOCSPX-abc' } }),
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.manifest.network?.secrets?.[0]?.oauth?.clientId).toBe('cid-1.apps.example.com');
      expect(good.manifest.network?.secrets?.[0]?.oauth?.clientSecret).toBe('GOCSPX-abc');
    }
    expect(validateGhostManifest(oauthManifest({ oauth: { ...base, clientSecret: 'orphan' } })).ok).toBe(false);
    expect(validateGhostManifest(oauthManifest({ oauth: { ...base, clientId: 'has space' } })).ok).toBe(false);
    expect(validateGhostManifest(oauthManifest({ oauth: { ...base, clientId: 'x'.repeat(201) } })).ok).toBe(false);
  });

  it('identity.labelPath 形状校验(点分路径)', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, identity: { url: 'https://api.example.com/me', labelPath: 'user.email' } } }),
      ).ok,
    ).toBe(true);
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, identity: { url: 'https://api.example.com/me', labelPath: 'a..b' } } }),
      ).ok,
    ).toBe(false);
  });

  it('identity.displayTemplate:占位符校验(至少一个合法点分路径;纯静态 / 坏路径 / 超长 → 拒)', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    const withTemplate = (displayTemplate: unknown): ReturnType<typeof oauthManifest> =>
      oauthManifest({
        oauth: {
          ...base,
          identity: { url: 'https://api.example.com/me', labelPath: 'user_id', displayTemplate },
        },
      });
    const ok = validateGhostManifest(withTemplate('{team} · {user}'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.identity?.displayTemplate).toBe('{team} · {user}');
    }
    // 未声明模板 = 归一化后不带该字段(展示回落 labelPath 值)。
    const plain = validateGhostManifest(
      oauthManifest({ oauth: { ...base, identity: { url: 'https://api.example.com/me', labelPath: 'email' } } }),
    );
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.manifest.network?.secrets?.[0]?.oauth?.identity?.displayTemplate).toBeUndefined();
    }
    expect(validateGhostManifest(withTemplate('no placeholder')).ok).toBe(false);
    expect(validateGhostManifest(withTemplate('{a..b}')).ok).toBe(false);
    expect(validateGhostManifest(withTemplate('{}')).ok).toBe(false);
    expect(validateGhostManifest(withTemplate('')).ok).toBe(false);
    expect(validateGhostManifest(withTemplate(42)).ok).toBe(false);
    expect(validateGhostManifest(withTemplate(`{user}${'x'.repeat(200)}`)).ok).toBe(false);
  });

  it('identity.avatarPath:合法点分路径通过并保留;坏路径 / 非字符串 / 超长 → 拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    const withAvatarPath = (avatarPath: unknown): ReturnType<typeof oauthManifest> =>
      oauthManifest({
        oauth: {
          ...base,
          identity: { url: 'https://api.example.com/me', labelPath: 'user_id', avatarPath },
        },
      });
    const ok = validateGhostManifest(withAvatarPath('data.avatar_thumb'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.identity?.avatarPath).toBe('data.avatar_thumb');
    }
    // 未声明 = 归一化后不带该字段(账号无头像,设置页回落首字圆片)。
    const plain = validateGhostManifest(
      oauthManifest({ oauth: { ...base, identity: { url: 'https://api.example.com/me', labelPath: 'email' } } }),
    );
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.manifest.network?.secrets?.[0]?.oauth?.identity?.avatarPath).toBeUndefined();
    }
    expect(validateGhostManifest(withAvatarPath('a..b')).ok).toBe(false);
    expect(validateGhostManifest(withAvatarPath(42)).ok).toBe(false);
    expect(validateGhostManifest(withAvatarPath('x'.repeat(129))).ok).toBe(false);
  });

  it('oauth 凭证同样要求 settingsHtml(client 凭证与连接按钮由意识设置页收单)', () => {
    const m = oauthManifest();
    delete m.settingsHtml;
    expect(validateGhostManifest(m).ok).toBe(false);
  });

  it('redirectPort:合法端口通过并保留;越界 / 非整数 → 拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
    };
    const ok = validateGhostManifest(oauthManifest({ oauth: { ...base, redirectPort: 53682 } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.redirectPort).toBe(53682);
    }
    for (const bad of [80, 1023, 65536, 0, -1, 1.5, '53682']) {
      expect(
        validateGhostManifest(oauthManifest({ oauth: { ...base, redirectPort: bad } })).ok,
        `redirectPort=${String(bad)} 应拒`,
      ).toBe(false);
    }
  });

  it('tokenBroker 无 redirectPort 仍可从共用读路径解析;新包约束由 Host 准入点承担', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      clientId: 'builtin-client-id',
    };
    const missingPort = validateGhostManifest(
      oauthManifest({ oauth: { ...base, tokenBroker: 'jira' } }),
    );
    expect(missingPort.ok).toBe(true);
    if (missingPort.ok) {
      expect(missingPort.manifest.network?.secrets?.[0]?.oauth).toMatchObject({
        tokenBroker: 'jira',
      });
      expect(
        missingPort.manifest.network?.secrets?.[0]?.oauth?.redirectPort,
      ).toBeUndefined();
    }

    // 这两个对照防止兼容调整误伤原本合法的显式端口与普通 OAuth。
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, tokenBroker: 'jira', redirectPort: 17872 } }),
      ).ok,
    ).toBe(true);
    expect(validateGhostManifest(oauthManifest({ oauth: base })).ok).toBe(true);
  });

  it('tokenBroker:合法 slug 通过并保留;非法形状 / 与 clientSecret 互斥 → 拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      clientId: 'builtin-client-id',
      redirectPort: 17872,
    };
    // broker 模式典型组合:内置 clientId + 无 clientSecret + pkce:false。
    const ok = validateGhostManifest(
      oauthManifest({ oauth: { ...base, tokenBroker: 'jira', pkce: false } }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const oa = ok.manifest.network?.secrets?.[0]?.oauth;
      expect(oa?.tokenBroker).toBe('jira');
      expect(oa?.pkce).toBe(false);
      expect(oa?.clientSecret).toBeUndefined();
    }
    for (const bad of ['Jira', '9jira', 'a'.repeat(33), '', 'jira jira']) {
      expect(
        validateGhostManifest(oauthManifest({ oauth: { ...base, tokenBroker: bad } })).ok,
        `tokenBroker=${JSON.stringify(bad)} 应拒`,
      ).toBe(false);
    }
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, clientSecret: 'sec', tokenBroker: 'jira' } }),
      ).ok,
    ).toBe(false);
  });

  it('clientIdAlternatives:仅 broker + 默认 clientId 可用,合法值保留且重复/非法值拒绝', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      clientId: 'cn-client-id',
      tokenBroker: 'slack',
      redirectPort: 17872,
    };
    const ok = validateGhostManifest(
      oauthManifest({ oauth: { ...base, clientIdAlternatives: ['global-client-id'] } }),
    );
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.clientIdAlternatives).toEqual([
        'global-client-id',
      ]);
    }

    for (const clientIdAlternatives of [
      [],
      ['cn-client-id'],
      ['global-client-id', 'global-client-id'],
      ['has space'],
      ['x'.repeat(201)],
      [42],
      Array.from({ length: GHOST_OAUTH_CLIENT_ID_ALTERNATIVES_MAX + 1 }, (_, i) => `client-${i}`),
    ]) {
      expect(
        validateGhostManifest(oauthManifest({ oauth: { ...base, clientIdAlternatives } })).ok,
        JSON.stringify(clientIdAlternatives),
      ).toBe(false);
    }
    expect(
      validateGhostManifest(
        oauthManifest({
          oauth: {
            ...base,
            clientId: undefined,
            clientIdAlternatives: ['global-client-id'],
          },
        }),
      ).ok,
      '缺默认 clientId 应拒',
    ).toBe(false);
    expect(
      validateGhostManifest(
        oauthManifest({
          oauth: {
            ...base,
            tokenBroker: undefined,
            clientIdAlternatives: ['global-client-id'],
          },
        }),
      ).ok,
      '非 broker 模式应拒',
    ).toBe(false);
  });

  it('brokerBounce:必须与 tokenBroker、redirectPort 成套;路径形状校验;合法归一化保留', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      clientId: 'builtin-client-id',
      pkce: false,
    };
    const bounce = { path: '/slack-mcp/bounce', callbackPath: '/slack-mcp/callback' };

    // 合法(全套声明)通过并归一化保留。
    const ok = validateGhostManifest(
      oauthManifest({ oauth: { ...base, tokenBroker: 'slack', redirectPort: 17872, brokerBounce: bounce } }),
    );
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.brokerBounce).toEqual(bounce);
    }

    // 缺 tokenBroker / 缺 redirectPort → 拒(三者是一套约定)。
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, redirectPort: 17872, brokerBounce: bounce } }),
      ).ok,
      '缺 tokenBroker 应拒',
    ).toBe(false);
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, tokenBroker: 'slack', brokerBounce: bounce } }),
      ).ok,
      '缺 redirectPort 应拒',
    ).toBe(false);

    // 路径形状:不以 / 开头、带 query、含 .. 段、超长、非字符串 → 拒(path 与 callbackPath 同规则)。
    for (const badPath of [
      'slack-mcp/bounce',
      '/bounce?x=1',
      '/a/../b',
      '/',
      `/${'a'.repeat(128)}`,
      42,
    ]) {
      for (const field of ['path', 'callbackPath'] as const) {
        expect(
          validateGhostManifest(
            oauthManifest({
              oauth: {
                ...base,
                tokenBroker: 'slack',
                redirectPort: 17872,
                brokerBounce: { ...bounce, [field]: badPath },
              },
            }),
          ).ok,
          `brokerBounce.${field}=${JSON.stringify(badPath)} 应拒`,
        ).toBe(false);
      }
    }
    // 非对象形态 → 拒。
    expect(
      validateGhostManifest(
        oauthManifest({ oauth: { ...base, tokenBroker: 'slack', redirectPort: 17872, brokerBounce: '/x' } }),
      ).ok,
    ).toBe(false);
  });

  it('scopeDelimiter:"," 通过并保留;其它值(";" / 空格 / 空串)→ 拒', () => {
    const base = {
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      scopes: ['read.a', 'write.b'],
    };
    const ok = validateGhostManifest(oauthManifest({ oauth: { ...base, scopeDelimiter: ',' } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.network?.secrets?.[0]?.oauth?.scopeDelimiter).toBe(',');
    }
    for (const bad of [';', ' ', '', ', ']) {
      expect(
        validateGhostManifest(oauthManifest({ oauth: { ...base, scopeDelimiter: bad } })).ok,
        `scopeDelimiter=${JSON.stringify(bad)} 应拒`,
      ).toBe(false);
    }
  });
});
describe('ghost · oauth 确认框条目', () => {
  it('展示授权域名 + scopes 原文逐条', () => {
    const result = validateGhostManifest(oauthManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = ghostPermissionItems(result.manifest as GhostManifest);
    const oauthItem = items.find((i) => i.key === 'network:secret:acct');
    expect(oauthItem).toBeDefined();
    expect(oauthItem).toMatchObject({
      kind: 'network',
      labelKey: 'networkSecretOauth',
      labelArgs: { name: 'Example 账号', host: 'accounts.example.com' },
      detailKey: 'networkSecretOauthDetail',
    });
    expect(oauthItem?.detail).toBe('read.a\nwrite.b');
  });

  it('无 scopes 时不带 detail(不渲染空段)', () => {
    const result = validateGhostManifest(
      oauthManifest({
        oauth: {
          authorizeUrl: 'https://accounts.example.com/authorize',
          tokenUrl: 'https://accounts.example.com/token',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = ghostPermissionItems(result.manifest as GhostManifest).find(
      (i) => i.key === 'network:secret:acct',
    );
    expect(item?.detail).toBeUndefined();
  });
});

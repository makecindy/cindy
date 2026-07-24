import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENDPOINT_KEYS,
  parseClientEndpointManifest,
  resolveClientEndpointsStrict,
} from '../clientEndpoints';

const VALID_MANIFEST = {
  schemaVersion: 1,
  apiBaseUrl: 'https://api.example.com',
  authApiBaseUrl: 'https://auth.example.com',
  deviceLinkApiBaseUrl: 'https://device-link.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.example.com',
  ossApiBaseUrl: 'https://oss.example.com',
  heartbeatUrl: 'https://heartbeat.example.com',
  telegramHookWsUrl: 'wss://telegram-hook.example.com',
  slackHookWsUrl: 'wss://slack-hook.example.com',
  websiteUrl: 'https://www.example.com',
  modelAccessApiBaseUrl: 'https://model-access.example.com',
  voiceApiBaseUrl: 'https://voice.example.com',
  githubApiBaseUrl: 'https://github-api.example.com',
  skillhubApiBaseUrl: 'https://skillhub.example.com',
  cdnBaseUrl: 'https://cdn.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update.example.com',
};

describe('parseClientEndpointManifest(字段可按 region 缺省)', () => {
  it('接受合法全量清单并归一尾斜杠', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, authApiBaseUrl: 'https://auth.example.com///' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.authApiBaseUrl).toBe('https://auth.example.com');
    expect(result.endpoints.slackHookWsUrl).toBe('wss://slack-hook.example.com');
    expect(Object.keys(result.endpoints).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
  });

  it('忽略未知字段(向前兼容)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, futureKey: 'x', _note: '正本内注释' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.endpoints).sort()).toEqual([...CLIENT_ENDPOINT_KEYS].sort());
  });

  it.each(CLIENT_ENDPOINT_KEYS)('缺失字段 %s → 补空串且不阻断解析', (key) => {
    const manifest: Record<string, unknown> = { ...VALID_MANIFEST };
    delete manifest[key];
    const result = parseClientEndpointManifest(JSON.stringify(manifest));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints[key]).toBe('');
  });

  it.each(CLIENT_ENDPOINT_KEYS)('空白字段 %s → 归一为空串且不阻断解析', (key) => {
    const result = parseClientEndpointManifest(
      JSON.stringify({ ...VALID_MANIFEST, [key]: '   ' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints[key]).toBe('');
  });

  it.each([
    ['非法 JSON', 'not-json{', 'invalid-json'],
    ['数组', '[]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    [
      'schemaVersion 缺失',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: undefined }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 非整数',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: 1.5 }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 字符串',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: '1' }),
      'invalid-schema-version',
    ],
    [
      'schemaVersion 超前',
      JSON.stringify({ ...VALID_MANIFEST, schemaVersion: 2 }),
      'unsupported-schema-version:2',
    ],
  ])('拒绝:%s', (_label, raw, reason) => {
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    ['https 字段给 http', { authApiBaseUrl: 'http://auth.example.com' }, 'invalid-protocol:authApiBaseUrl'],
    ['wss 字段给 ws', { slackHookWsUrl: 'ws://hook.example.com' }, 'invalid-protocol:slackHookWsUrl'],
    ['cdnBaseUrl 给 http', { cdnBaseUrl: 'http://cdn.example.com' }, 'invalid-protocol:cdnBaseUrl'],
    ['非 URL', { websiteUrl: 'not a url' }, 'invalid-field:websiteUrl'],
    ['非字符串', { websiteUrl: 42 }, 'invalid-field:websiteUrl'],
    [
      'URL 带凭据',
      { authApiBaseUrl: 'https://user:pass@auth.example.com' },
      'credentials-in-url:authApiBaseUrl',
    ],
  ])('单字段非法整份拒绝:%s', (_label, patch, reason) => {
    const raw = JSON.stringify({ ...VALID_MANIFEST, ...patch });
    expect(parseClientEndpointManifest(raw)).toEqual({ ok: false, reason });
  });

  describe('review 可选字符串字段(手机版审核模式的送审版本号)', () => {
    it('缺失 → reviewVersion=null(线上老清单不受影响,不阻断)', () => {
      const result = parseClientEndpointManifest(JSON.stringify(VALID_MANIFEST));
      expect(result).toMatchObject({ ok: true, reviewVersion: null });
    });

    it.each([
      ['空串', ''],
      ['纯空白', '   '],
    ])('%s → reviewVersion=null(审核模式关闭)', (_label, value) => {
      const result = parseClientEndpointManifest(
        JSON.stringify({ ...VALID_MANIFEST, review: value }),
      );
      expect(result).toMatchObject({ ok: true, reviewVersion: null });
    });

    it('版本号字符串 → trim 后原样透出', () => {
      const result = parseClientEndpointManifest(
        JSON.stringify({ ...VALID_MANIFEST, review: ' 1.4.0 ' }),
      );
      expect(result).toMatchObject({ ok: true, reviewVersion: '1.4.0' });
    });

    it.each([
      ['boolean true', true],
      ['数字 1', 1],
      ['null', null],
    ])('存在但非 string(%s)→ 整份拒绝(配置错要炸出来)', (_label, value) => {
      expect(
        parseClientEndpointManifest(JSON.stringify({ ...VALID_MANIFEST, review: value })),
      ).toEqual({ ok: false, reason: 'invalid-field:review' });
    });
  });

  it('忽略已退役字段 apiBaseUrl / cdnInternalBaseUrl / xdGatewayBaseUrl(老清单向前兼容)', () => {
    const result = parseClientEndpointManifest(
      JSON.stringify({
        ...VALID_MANIFEST,
        cdnInternalBaseUrl: 'http://cdn-internal.example.com:20080/app',
        xdGatewayBaseUrl: 'https://gateway.example.com',
      }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect('apiBaseUrl' in result.endpoints).toBe(false);
    expect('cdnInternalBaseUrl' in result.endpoints).toBe(false);
    expect('xdGatewayBaseUrl' in result.endpoints).toBe(false);
  });
});

describe('allowHttp 宽松模式(仅 dev 本地文件路径)', () => {
  const LOCAL_MANIFEST = {
    ...VALID_MANIFEST,
    apiBaseUrl: 'http://localhost:3333',
    authApiBaseUrl: 'http://localhost:3344',
    deviceLinkApiBaseUrl: 'http://localhost:3335',
    telegramHookWsUrl: 'ws://localhost:3347',
    slackHookWsUrl: 'ws://localhost:3346',
  };

  it('默认(不传 options)拒绝 http/ws——packaged 校验零放松', () => {
    expect(parseClientEndpointManifest(JSON.stringify(LOCAL_MANIFEST))).toEqual({
      ok: false,
      reason: 'invalid-protocol:authApiBaseUrl',
    });
  });

  it('allowHttp:true 时接受 http localhost 与 ws', () => {
    const result = parseClientEndpointManifest(JSON.stringify(LOCAL_MANIFEST), {
      allowHttp: true,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.endpoints.authApiBaseUrl).toBe('http://localhost:3344');
    expect(result.endpoints.slackHookWsUrl).toBe('ws://localhost:3346');
  });

  it('allowHttp:true 仍拒绝垃圾输入 / 带凭据,但允许缺字段', () => {
    expect(parseClientEndpointManifest('broken{{', { allowHttp: true })).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    const missing: Record<string, unknown> = { ...LOCAL_MANIFEST };
    delete missing.cdnBaseUrl;
    const missingResult = parseClientEndpointManifest(JSON.stringify(missing), {
      allowHttp: true,
    });
    expect(missingResult).toMatchObject({ ok: true });
    if (!missingResult.ok) throw new Error('unreachable');
    expect(missingResult.endpoints.cdnBaseUrl).toBe('');
    expect(
      parseClientEndpointManifest(
        JSON.stringify({ ...LOCAL_MANIFEST, authApiBaseUrl: 'http://user:pass@localhost:3344' }),
        { allowHttp: true },
      ),
    ).toEqual({ ok: false, reason: 'credentials-in-url:authApiBaseUrl' });
  });

  it('allowHttp:true 仍拒绝非 http/https 协议(如 file:)', () => {
    expect(
      parseClientEndpointManifest(
        JSON.stringify({ ...LOCAL_MANIFEST, authApiBaseUrl: 'file:///etc/hosts' }),
        { allowHttp: true },
      ),
    ).toEqual({ ok: false, reason: 'invalid-protocol:authApiBaseUrl' });
  });

  it('resolveClientEndpointsStrict 透传 options', () => {
    const result = resolveClientEndpointsStrict(JSON.stringify(LOCAL_MANIFEST), {
      allowHttp: true,
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe('resolveClientEndpointsStrict(清单即唯一事实源)', () => {
  it('拉取失败(null)→ ok:false,不产出任何端点', () => {
    expect(resolveClientEndpointsStrict(null)).toEqual({ ok: false, reason: 'fetch-failed' });
  });

  it('清单非法 → ok:false;缺字段 → ok:true 且补空串', () => {
    expect(resolveClientEndpointsStrict('broken{{')).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    const missing: Record<string, unknown> = { ...VALID_MANIFEST };
    delete missing.heartbeatUrl;
    const missingResult = resolveClientEndpointsStrict(JSON.stringify(missing));
    expect(missingResult).toMatchObject({ ok: true });
    if (!missingResult.ok) throw new Error('unreachable');
    expect(missingResult.endpoints.heartbeatUrl).toBe('');
  });

  it('成功:所有字段来自清单本身', () => {
    const result = resolveClientEndpointsStrict(JSON.stringify(VALID_MANIFEST));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    for (const key of CLIENT_ENDPOINT_KEYS) {
      expect(result.endpoints[key]).toBe(
        (VALID_MANIFEST as unknown as Record<string, string>)[key].replace(/\/+$/, ''),
      );
    }
  });
});

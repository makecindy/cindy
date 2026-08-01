/**
 * 自定义供应商 OAuth 形态（用户自行扩展订阅授权供应商）单测：
 *   - buildUserProvider：oauth 配置 → auth 透传 + 路由策略 oauth-token（apiKey 形态不变）；
 *   - validateCustomProviderConfig：oauth 描述符校验（必填 / https / 端口）与 apiKey 互斥；
 *   - provider-service：oauth 形态 user 供应商连接态 = genericOAuthConnected（不再恒 true）。
 */

import { describe, it, expect } from 'vitest';

import { buildUserProvider, type CustomProviderConfig } from '@cindy/model-providers';

import { mergeDiscoveredModelsIntoConfig, validateCustomProviderConfig } from '../custom-provider-store.js';
import { parseModelsListResponse } from '../generic-oauth.js';
import { createProviderService } from '../provider-service.js';

const OAUTH = {
  authorizeUrl: 'https://auth.acme.example/authorize',
  tokenUrl: 'https://auth.acme.example/token',
  clientId: 'c1',
  scopes: 'openid',
};
const DEVICE_OAUTH = {
  flow: 'device-code' as const,
  deviceAuthorizationUrl: 'https://auth.acme.example/device',
  tokenUrl: 'https://auth.acme.example/token',
  clientId: 'device-client',
  scopes: 'openid',
};

const BASE: CustomProviderConfig = {
  id: 'acme-sub',
  name: 'Acme Sub',
  auth: { method: 'oauth', oauth: OAUTH },
  runtimes: {
    'claude-code': { baseUrl: 'https://api.acme.example/anthropic', models: [{ id: 'm1', name: 'M1' }] },
  },
};

describe('buildUserProvider oauth 形态', () => {
  it('auth 透传 + 路由 oauth-token；apiKey 形态保持 api-key-header', () => {
    const p = buildUserProvider(BASE);
    expect(p.auth).toEqual({ method: 'oauth', oauth: OAUTH });
    expect(p.routing['claude-code']?.authStrategy).toBe('oauth-token');

    const plain = buildUserProvider({ ...BASE, auth: undefined });
    expect(plain.auth).toEqual({ method: 'apiKey' });
    expect(plain.routing['claude-code']?.authStrategy).toBe('api-key-header');
  });
});

describe('validateCustomProviderConfig auth 段', () => {
  it('完整 oauth 配置通过；缺字段 / http 端点 / 非法端口拒绝', () => {
    expect(validateCustomProviderConfig(BASE).ok).toBe(true);
    const bad = (oauth: object) =>
      validateCustomProviderConfig({ ...BASE, auth: { method: 'oauth', oauth } });
    expect(bad({ ...OAUTH, clientId: '' }).ok).toBe(false);
    expect(bad({ ...OAUTH, tokenUrl: 'http://auth.acme.example/token' }).ok).toBe(false);
    expect(bad({ ...OAUTH, redirectPort: 70000 }).ok).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: { method: 'oauth', oauth: DEVICE_OAUTH },
      }).ok,
    ).toBe(true);
    expect(bad({ ...DEVICE_OAUTH, deviceAuthorizationUrl: 'http://auth.acme.example/device' }).ok)
      .toBe(false);
    expect(bad({ ...DEVICE_OAUTH, redirectPort: 9123 }).ok).toBe(false);
  });

  it('apiKey method 不允许携带 oauth 描述符；非法 method 拒绝', () => {
    expect(validateCustomProviderConfig({ ...BASE, auth: { method: 'apiKey', oauth: OAUTH } }).ok).toBe(false);
    expect(validateCustomProviderConfig({ ...BASE, auth: { method: 'weird' } }).ok).toBe(false);
    expect(validateCustomProviderConfig({ ...BASE, auth: { method: 'apiKey' } }).ok).toBe(true);
  });

  it('none method 只允许无密钥回环代理，且不允许夹带 OAuth 描述符', () => {
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: { method: 'none' },
        runtimes: {
          codex: {
            baseUrl: 'http://127.0.0.1:4000/v1',
            modelsUrl: 'http://localhost:4000/v1/models',
            models: [],
          },
        },
      }).ok,
    ).toBe(true);
    expect(validateCustomProviderConfig({ ...BASE, auth: { method: 'none' } }).ok).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: { method: 'none' },
        runtimes: {
          codex: {
            baseUrl: 'http://127.0.0.1:4000/v1',
            modelsUrl: 'https://models.example/v1/models',
            models: [],
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: { method: 'none', oauth: OAUTH },
      }).ok,
    ).toBe(false);
  });

  it('拒绝扩展参数覆盖 OAuth 标准字段', () => {
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: {
          method: 'oauth',
          oauth: { ...DEVICE_OAUTH, extraDeviceParams: { client_id: 'other-client' } },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...BASE,
        auth: {
          method: 'oauth',
          oauth: { ...OAUTH, extraAuthParams: { state: 'fixed-state' } },
        },
      }).ok,
    ).toBe(false);
  });

  it('拒绝与 OAuth flow 不兼容的字段和带 userinfo 的上游地址', () => {
    const bad = (oauth: object) =>
      validateCustomProviderConfig({ ...BASE, auth: { method: 'oauth', oauth } });
    expect(bad({ ...OAUTH, deviceAuthorizationUrl: DEVICE_OAUTH.deviceAuthorizationUrl }).ok)
      .toBe(false);
    expect(bad({ ...DEVICE_OAUTH, authorizeUrl: OAUTH.authorizeUrl }).ok).toBe(false);
    expect(
      validateCustomProviderConfig({
        ...BASE,
        runtimes: {
          'claude-code': {
            ...BASE.runtimes['claude-code']!,
            baseUrl: 'https://user:pass@api.acme.example/anthropic',
          },
        },
      }).ok,
    ).toBe(false);
  });

  it('OAuth 形态模型可留空（授权后自动发现填充，用户免手填）', () => {
    const noModels = {
      ...BASE,
      runtimes: { 'claude-code': { baseUrl: 'https://api.acme.example/anthropic', models: [] } },
    };
    expect(validateCustomProviderConfig(noModels).ok).toBe(true);
  });
});

describe('mergeDiscoveredModelsIntoConfig（发现结果持久化的 additions-only 合并）', () => {
  it('只追加新 id，已有条目 first-wins；无新增返回 null；runtime 未配置返回 null', () => {
    const merged = mergeDiscoveredModelsIntoConfig(BASE, 'claude-code', [
      { id: 'm1', name: 'OVERRIDE-IGNORED' },
      { id: 'm2', name: 'M2' },
      { id: '', name: 'bad' },
    ]);
    expect(merged?.runtimes['claude-code']?.models).toEqual([
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' },
    ]);
    // 原配置不被就地修改（纯函数）。
    expect(BASE.runtimes['claude-code']?.models).toEqual([{ id: 'm1', name: 'M1' }]);

    expect(mergeDiscoveredModelsIntoConfig(BASE, 'claude-code', [{ id: 'm1', name: 'M1' }])).toBeNull();
    expect(mergeDiscoveredModelsIntoConfig(BASE, 'codex', [{ id: 'x', name: 'X' }])).toBeNull();
  });

  it('端点声明的 contextWindow 随发现落盘,非法值丢弃回落默认(#386)', () => {
    const merged = mergeDiscoveredModelsIntoConfig(BASE, 'claude-code', [
      { id: 'big', name: 'Big', contextWindow: 1_000_000 },
      { id: 'bogus', name: 'Bogus', contextWindow: 0 },
    ]);
    expect(merged?.runtimes['claude-code']?.models).toEqual([
      { id: 'm1', name: 'M1' },
      { id: 'big', name: 'Big', contextWindow: 1_000_000 },
      { id: 'bogus', name: 'Bogus' },
    ]);
  });
});

describe('parseModelsListResponse contextWindow 提取(#386)', () => {
  it('从 context_length / context_window / max_context_length / max_input_tokens 尽力提取,非法值缺省', () => {
    expect(
      parseModelsListResponse({
        data: [
          { id: 'a', context_length: 1_048_576 },
          { id: 'b', name: 'B', context_window: 262144.9 },
          { id: 'c', max_context_length: 131072 },
          // Anthropic 兼容端点的字段口径(与 model-discovery/anthropic.ts 对齐,review P1)。
          { id: 'f', max_input_tokens: 200_000 },
          { id: 'd', context_length: -5 },
          { id: 'e' },
          // 0 < v < 1 会通过 v > 0 但 Math.floor 取整成 0——按取整后的值校验
          // 才不会漏这个区间(review P2)。
          { id: 'g', context_length: 0.5 },
          // 超出安全整数范围的异常值同样要拒绝,否则落盘后 Main 的正数校验会
          // 因超界拒绝整份供应商配置,内置 OAuth 发现分支则会把这个失真值当
          // 真实窗口注入目录(review P2)。
          { id: 'h', context_length: 1e20 },
        ],
      }),
    ).toEqual([
      { id: 'a', name: 'a', contextWindow: 1_048_576 },
      { id: 'b', name: 'B', contextWindow: 262144 },
      { id: 'c', name: 'c', contextWindow: 131072 },
      { id: 'f', name: 'f', contextWindow: 200_000 },
      { id: 'd', name: 'd' },
      { id: 'e', name: 'e' },
      { id: 'g', name: 'g' },
      { id: 'h', name: 'h' },
    ]);
  });

  it('字符串数组形状不携带 contextWindow', () => {
    expect(parseModelsListResponse({ models: ['m1'] })).toEqual([{ id: 'm1', name: 'm1' }]);
  });
});

describe('provider-service 连接态', () => {
  it('oauth 形态 user 供应商连接态 = genericOAuthConnected；apiKey 形态恒 true', async () => {
    const catalog = {
      version: 't',
      providers: [
        buildUserProvider(BASE),
        buildUserProvider({ ...BASE, id: 'plain', auth: undefined }),
      ],
    };
    const svc = createProviderService({
      getCatalog: () => catalog,
      connection: { xd: () => false, anthropic: () => false, openai: () => false, xai: () => false },
      genericOAuthConnected: (id) => id === 'acme-sub',
    });
    const views = await svc.listProviders();
    expect(views.find((v) => v.id === 'acme-sub')?.connected).toBe(true);
    expect(views.find((v) => v.id === 'plain')?.connected).toBe(true);

    const svcLoggedOut = createProviderService({
      getCatalog: () => catalog,
      connection: { xd: () => false, anthropic: () => false, openai: () => false, xai: () => false },
      genericOAuthConnected: () => false,
    });
    const views2 = await svcLoggedOut.listProviders();
    expect(views2.find((v) => v.id === 'acme-sub')?.connected).toBe(false);
  });
});

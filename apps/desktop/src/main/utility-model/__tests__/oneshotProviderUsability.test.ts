/**
 * oneshotProviderUsability.test.ts — 凭证同步探测单测(store 全 mock)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '@cindy/model-providers';

vi.mock('../../maker-host/auth-adapters.js', () => ({ readClaudeApiKey: vi.fn() }));
vi.mock('../../maker-host/claude-oauth-refresh.js', () => ({ getClaudeAiOAuthForSpawn: vi.fn() }));
vi.mock('../../maker-host/codex-oauth-readiness.js', () => ({ hasChatgptOneshotReadiness: vi.fn() }));
vi.mock('../../maker-host/generic-oauth.js', () => ({ readCachedGenericOAuthAccessToken: vi.fn() }));
vi.mock('../../maker-host/grok-oauth-login.js', () => ({ hasGrokOAuthLogin: vi.fn() }));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ readCustomProviderKey: vi.fn() }));

import { readClaudeApiKey } from '../../maker-host/auth-adapters.js';
import { getClaudeAiOAuthForSpawn } from '../../maker-host/claude-oauth-refresh.js';
import { hasChatgptOneshotReadiness } from '../../maker-host/codex-oauth-readiness.js';
import { readCachedGenericOAuthAccessToken } from '../../maker-host/generic-oauth.js';
import { hasGrokOAuthLogin } from '../../maker-host/grok-oauth-login.js';
import { effectiveXdGatewayBaseUrl } from '../../model-access/effectiveEndpoint.js';
import { readCustomProviderKey } from '../../secrets/providerSecretStore.js';

import { hasOneshotProviderCredential } from '../oneshotProviderUsability';

function provider(over: Partial<Provider> & { id: string }): Provider {
  return {
    name: over.id,
    source: 'builtin',
    agents: ['codex'],
    auth: { method: 'api-key' },
    routing: { codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' } },
    models: { codex: [] },
    ...over,
  } as Provider;
}

beforeEach(() => {
  vi.mocked(readClaudeApiKey).mockReset();
  vi.mocked(getClaudeAiOAuthForSpawn).mockReset();
  vi.mocked(hasChatgptOneshotReadiness).mockReset();
  vi.mocked(readCachedGenericOAuthAccessToken).mockReset();
  vi.mocked(hasGrokOAuthLogin).mockReset();
  vi.mocked(effectiveXdGatewayBaseUrl).mockReset();
  vi.mocked(readCustomProviderKey).mockReset();
});

describe('hasOneshotProviderCredential · 内置四家', () => {
  it('xd:key 与端点都要在', () => {
    vi.mocked(readClaudeApiKey).mockReturnValue('k');
    vi.mocked(effectiveXdGatewayBaseUrl).mockReturnValue('https://gw.example.com');
    expect(hasOneshotProviderCredential(provider({ id: 'xd' }), 'codex')).toBe(true);
    vi.mocked(readClaudeApiKey).mockReturnValue(null as never);
    expect(hasOneshotProviderCredential(provider({ id: 'xd' }), 'codex')).toBe(false);
    vi.mocked(readClaudeApiKey).mockReturnValue('k');
    vi.mocked(effectiveXdGatewayBaseUrl).mockReturnValue('  ');
    expect(hasOneshotProviderCredential(provider({ id: 'xd' }), 'codex')).toBe(false);
  });

  it('anthropic/openai/xai 各自跟订阅登录态;其余内置 id 一律不可用', () => {
    vi.mocked(getClaudeAiOAuthForSpawn).mockReturnValue({ accessToken: 't' } as never);
    expect(hasOneshotProviderCredential(provider({ id: 'anthropic' }), 'claude-code')).toBe(true);
    vi.mocked(getClaudeAiOAuthForSpawn).mockReturnValue(null);
    expect(hasOneshotProviderCredential(provider({ id: 'anthropic' }), 'claude-code')).toBe(false);

    vi.mocked(hasChatgptOneshotReadiness).mockReturnValue(true);
    expect(hasOneshotProviderCredential(provider({ id: 'openai' }), 'codex')).toBe(true);
    vi.mocked(hasChatgptOneshotReadiness).mockReturnValue(false);
    expect(hasOneshotProviderCredential(provider({ id: 'openai' }), 'codex')).toBe(false);

    vi.mocked(hasGrokOAuthLogin).mockReturnValue(true);
    expect(hasOneshotProviderCredential(provider({ id: 'xai' }), 'codex')).toBe(true);
    vi.mocked(hasGrokOAuthLogin).mockReturnValue(false);
    expect(hasOneshotProviderCredential(provider({ id: 'xai' }), 'codex')).toBe(false);

    // 第五个内置(假设 gemini 配上 agent)不在执行侧可执行集合内:不可用。
    expect(hasOneshotProviderCredential(provider({ id: 'gemini' }), 'codex')).toBe(false);
  });
});

describe('hasOneshotProviderCredential · 自定义供应商', () => {
  const custom = (id: string, routing: Provider['routing'], auth?: Provider['auth']) =>
    provider({ id, source: 'user', ...(auth !== undefined ? { auth } : {}), routing });

  it('authStrategy none 无需凭证即可用', () => {
    const p = custom('local', { codex: { upstream: 'http://127.0.0.1:8317', authStrategy: 'none' } });
    expect(hasOneshotProviderCredential(p, 'codex')).toBe(true);
  });

  it('api-key-header:safeStorage 有 key,或旧版 headerOverride 带凭证头', () => {
    const p = custom('c1', { codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' } });
    vi.mocked(readCustomProviderKey).mockReturnValue(null as never);
    expect(hasOneshotProviderCredential(p, 'codex')).toBe(false);
    vi.mocked(readCustomProviderKey).mockReturnValue('k' as never);
    expect(hasOneshotProviderCredential(p, 'codex')).toBe(true);

    vi.mocked(readCustomProviderKey).mockReturnValue(null as never);
    const legacy = custom('c2', {
      codex: {
        upstream: 'https://up.example.com',
        authStrategy: 'api-key-header',
        headerOverride: { Authorization: 'Bearer legacy' },
      } as never,
    });
    expect(hasOneshotProviderCredential(legacy, 'codex')).toBe(true);
  });

  it('oauth-token:有缓存 access token 才可用', () => {
    const p = custom(
      'c3',
      { codex: { upstream: 'https://up.example.com', authStrategy: 'oauth-token' } },
      { method: 'oauth', oauth: { issuer: 'https://issuer.example.com' } } as never,
    );
    vi.mocked(readCachedGenericOAuthAccessToken).mockReturnValue(null);
    expect(hasOneshotProviderCredential(p, 'codex')).toBe(false);
    vi.mocked(readCachedGenericOAuthAccessToken).mockReturnValue('cached' as never);
    expect(hasOneshotProviderCredential(p, 'codex')).toBe(true);
  });

  it('legacy custom xai 的 OAuth 凭证仍按存储 id 读取', () => {
    const oauth = { issuer: 'https://issuer.example.com' } as never;
    const p = custom(
      'custom:xai',
      { codex: { upstream: 'https://up.example.com', authStrategy: 'oauth-token' } },
      { method: 'oauth', oauth },
    );
    vi.mocked(readCachedGenericOAuthAccessToken).mockReturnValue('cached' as never);

    expect(hasOneshotProviderCredential(p, 'codex')).toBe(true);
    expect(readCachedGenericOAuthAccessToken).toHaveBeenCalledWith('xai', oauth);
  });

  it('不支持的鉴权策略 / 缺 routing → 不可用', () => {
    const bespoke = custom('c4', { codex: { upstream: 'https://up.example.com', authStrategy: 'bespoke' as never } });
    expect(hasOneshotProviderCredential(bespoke, 'codex')).toBe(false);
    const noRouting = custom('c5', {});
    expect(hasOneshotProviderCredential(noRouting, 'codex')).toBe(false);
  });
});

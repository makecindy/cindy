import { beforeEach, describe, expect, it, vi } from 'vitest';

// remote-claude-route 只做纯路由 → cc env 翻译,带副作用的依赖全部 mock(其中
// auth-adapters 触 electron,必须 mock 掉)。claude-gateway-config 与
// claude-oauth-spawn-env 是纯函数,保留真实实现。
const readClaudeApiKey = vi.fn<() => string | null>(() => null);
const getClaudeAiOAuthForSpawn = vi.fn<() => unknown>(() => null);
const hasClaudeAiOAuth = vi.fn<() => boolean>(() => false);
const getActiveCatalog = vi.fn<() => { providers: unknown[] }>(() => ({ providers: [] }));
const resolveProviderRouteDecision = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const gatewayDefaultRouteDecision = vi.fn<(...args: unknown[]) => unknown>();
const isProviderRouteMutationInProgress = vi.fn<(...args: unknown[]) => boolean>(() => false);

vi.mock('../auth-adapters.js', () => ({ readClaudeApiKey: () => readClaudeApiKey() }));
vi.mock('../claude-oauth-refresh.js', () => ({
  getClaudeAiOAuthForSpawn: () => getClaudeAiOAuthForSpawn(),
}));
vi.mock('../claude-credentials-store.js', () => ({ hasClaudeAiOAuth: () => hasClaudeAiOAuth() }));
vi.mock('../active-catalog.js', () => ({ getActiveCatalog: () => getActiveCatalog() }));
vi.mock('../provider-route.js', () => ({
  resolveProviderRouteDecision: (...args: unknown[]) => resolveProviderRouteDecision(...args),
  gatewayDefaultRouteDecision: (...args: unknown[]) => gatewayDefaultRouteDecision(...args),
  isProviderRouteMutationInProgress: (...args: unknown[]) => isProviderRouteMutationInProgress(...args),
}));

import { resolveRemoteClaudeRoute } from '../remote-claude-route.js';

function parseCustomHeaders(serialized: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (serialized ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

beforeEach(() => {
  readClaudeApiKey.mockReset().mockReturnValue(null);
  getClaudeAiOAuthForSpawn.mockReset().mockReturnValue(null);
  hasClaudeAiOAuth.mockReset().mockReturnValue(false);
  getActiveCatalog.mockReset().mockReturnValue({ providers: [] });
  resolveProviderRouteDecision.mockReset().mockResolvedValue(null);
  gatewayDefaultRouteDecision.mockReset().mockReturnValue(null);
  isProviderRouteMutationInProgress.mockReset().mockReturnValue(false);
});

describe('resolveRemoteClaudeRoute — 默认路由(未显式选供应商)', () => {
  it('连了订阅、没网关 key + Anthropic 原生模型 → 订阅直连(隐式上游 + OAuth token)', async () => {
    hasClaudeAiOAuth.mockReturnValue(true);
    getClaudeAiOAuthForSpawn.mockReturnValue({
      accessToken: 'tok-sub',
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    });
    const route = await resolveRemoteClaudeRoute({ providerId: null, model: 'claude-opus-5' });
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe('https://api.anthropic.com');
    expect(route!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-sub');
    expect(route!.env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference');
    expect(route!.env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('max');
    expect(route!.env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe('tier-1');
    // 订阅直连不塞 api key / bearer 门,凭证走 OAuth token
    expect(route!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('未连订阅 → null(回落网关远端路径)', async () => {
    hasClaudeAiOAuth.mockReturnValue(false);
    expect(await resolveRemoteClaudeRoute({ providerId: null, model: 'claude-opus-5' })).toBeNull();
  });

  it('连了订阅但非 Anthropic 模型 → null(网关)', async () => {
    hasClaudeAiOAuth.mockReturnValue(true);
    getClaudeAiOAuthForSpawn.mockReturnValue({ accessToken: 'tok' });
    expect(
      await resolveRemoteClaudeRoute({ providerId: null, model: 'deepseek/deepseek-v4-flash' }),
    ).toBeNull();
  });

  it('连了订阅 + 有网关 key + Anthropic 模型 → null(镜像本地默认:全量换网关 key,不升级成直连)', async () => {
    hasClaudeAiOAuth.mockReturnValue(true);
    getClaudeAiOAuthForSpawn.mockReturnValue({ accessToken: 'tok-sub' });
    readClaudeApiKey.mockReturnValue('gw-key');
    gatewayDefaultRouteDecision.mockReturnValue({ headerOverride: { 'x-api-key': 'gw-key' } });
    expect(
      await resolveRemoteClaudeRoute({ providerId: null, model: 'claude-opus-5' }),
    ).toBeNull();
    expect(gatewayDefaultRouteDecision).toHaveBeenCalledWith('claude-code', 'gw-key');
  });

  it('连了订阅、有网关 key 但网关不可用(decision null)→ Anthropic 模型仍订阅直连', async () => {
    hasClaudeAiOAuth.mockReturnValue(true);
    getClaudeAiOAuthForSpawn.mockReturnValue({ accessToken: 'tok-sub' });
    readClaudeApiKey.mockReturnValue('gw-key');
    gatewayDefaultRouteDecision.mockReturnValue(null);
    const route = await resolveRemoteClaudeRoute({ providerId: null, model: 'claude-opus-5' });
    expect(route!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-sub');
  });
});

describe('resolveRemoteClaudeRoute — 显式供应商', () => {
  it('显式 xd 网关 → null(维持网关远端路径)', async () => {
    expect(await resolveRemoteClaudeRoute({ providerId: 'xd', model: 'deepseek-v4-flash' })).toBeNull();
    expect(resolveProviderRouteDecision).not.toHaveBeenCalled();
  });

  it('显式 anthropic → native OAuth 订阅直连(不走 oauth-passthrough route)', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'anthropic',
      routing: { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' },
      decision: { upstreamOverride: 'https://api.anthropic.com' },
    });
    hasClaudeAiOAuth.mockReturnValue(true);
    getClaudeAiOAuthForSpawn.mockReturnValue({ accessToken: 'tok-sub' });
    const route = await resolveRemoteClaudeRoute({ providerId: 'anthropic', model: 'claude-opus-5' });
    expect(route!.endpoint).toBe('https://api.anthropic.com');
    expect(route!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-sub');
    expect(resolveProviderRouteDecision).not.toHaveBeenCalled();
  });

  it('自定义 api-key-header 供应商 → x-api-key 当门,Authorization 走 custom headers(R2)', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'my-anthropic',
      routing: { upstream: 'https://api.myprovider.com/v1', authStrategy: 'api-key-header' },
      decision: {
        upstreamOverride: 'https://api.myprovider.com/v1',
        headerOverride: {
          'x-api-key': 'k-user',
          authorization: 'Bearer k-user',
          'x-custom-tenant': 'acme',
        },
      },
    });
    const route = await resolveRemoteClaudeRoute({ providerId: 'my-anthropic', model: 'claude-opus-5' });
    expect(route!.endpoint).toBe('https://api.myprovider.com/v1');
    // 单鉴权门 = ANTHROPIC_API_KEY;另一个鉴权头 + 定制头进 custom headers
    expect(route!.env.ANTHROPIC_API_KEY).toBe('k-user');
    expect(route!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const custom = parseCustomHeaders(route!.env.ANTHROPIC_CUSTOM_HEADERS);
    expect(custom['authorization']).toBe('Bearer k-user');
    expect(custom['x-custom-tenant']).toBe('acme');
  });

  it('custom headers 值含换行 → sanitize 防注入(copilot review)', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'my-anthropic',
      routing: { upstream: 'https://api.myprovider.com/v1', authStrategy: 'api-key-header' },
      decision: {
        upstreamOverride: 'https://api.myprovider.com/v1',
        headerOverride: {
          'x-api-key': 'k-user',
          'x-evil': 'line1\ninjected-header: bad\r\nline2',
        },
      },
    });
    const route = await resolveRemoteClaudeRoute({ providerId: 'my-anthropic', model: 'claude-opus-5' });
    const custom = parseCustomHeaders(route!.env.ANTHROPIC_CUSTOM_HEADERS);
    // 换行被剥成单行,不产生注入的头行
    expect(custom['x-evil']).toBe('line1 injected-header: bad line2');
    expect(route!.env.ANTHROPIC_CUSTOM_HEADERS!.split('\n')).toHaveLength(1);
  });

  it('通用 oauth-token 供应商 → REMOTE_PROVIDER_UNSUPPORTED(远端无 refresh 通道)', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'generic-oauth',
      routing: { upstream: 'https://api.g.com/anthropic', authStrategy: 'oauth-token' },
      decision: {
        upstreamOverride: 'https://api.g.com/anthropic',
        headerOverride: { authorization: 'Bearer oauth-xyz' },
      },
    });
    await expect(
      resolveRemoteClaudeRoute({ providerId: 'generic-oauth', model: 'some-model' }),
    ).rejects.toThrow(/REMOTE_PROVIDER_UNSUPPORTED/);
  });

  it('无鉴权(none)自托管(非 loopback)→ 占位 key 过 cc auth gate', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'selfhost',
      routing: { upstream: 'https://internal.local/anthropic', authStrategy: 'none' },
      decision: { upstreamOverride: 'https://internal.local/anthropic', headerOverride: {} },
    });
    const route = await resolveRemoteClaudeRoute({ providerId: 'selfhost', model: 'm' });
    expect(route!.env.ANTHROPIC_API_KEY).toBe('cindy-remote-no-auth');
  });

  it('无鉴权(none)+ loopback upstream → REMOTE_PROVIDER_UNSUPPORTED(远端 localhost 必错)', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'selfhost',
      routing: { upstream: 'http://localhost:8080/anthropic', authStrategy: 'none' },
      decision: { upstreamOverride: 'http://localhost:8080/anthropic', headerOverride: {} },
    });
    await expect(resolveRemoteClaudeRoute({ providerId: 'selfhost', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });
});

describe('resolveRemoteClaudeRoute — 远端无法表达的能力 → 明确报错', () => {
  const base = {
    providerId: 'p',
    decision: { headerOverride: { 'x-api-key': 'k' } },
  };

  it('自定义 requestPath → REMOTE_PROVIDER_UNSUPPORTED', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      ...base,
      routing: { upstream: 'https://x/v1', authStrategy: 'api-key-header', requestPath: '/v2/messages' },
    });
    await expect(resolveRemoteClaudeRoute({ providerId: 'p', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });

  it('modelIdRewrite → REMOTE_PROVIDER_UNSUPPORTED', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      ...base,
      routing: {
        upstream: 'https://x/v1',
        authStrategy: 'api-key-header',
        modelIdRewrite: { stripPrefix: 'x/' },
      },
    });
    await expect(resolveRemoteClaudeRoute({ providerId: 'p', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });

  it('oauth-passthrough(依赖子进程自带 bearer)→ REMOTE_PROVIDER_UNSUPPORTED', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'xai',
      routing: { upstream: 'https://api.x.ai/v1', authStrategy: 'oauth-passthrough' },
      decision: { upstreamOverride: 'https://api.x.ai/v1' },
    });
    await expect(resolveRemoteClaudeRoute({ providerId: 'xai', model: 'xai/grok-4.5' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });

  it('decision 解析为 null(如非 xd 的 gateway-key 路由缺网关 key)→ 前置报错,不拿占位鉴权打真上游', async () => {
    resolveProviderRouteDecision.mockResolvedValue({
      providerId: 'partner-gw',
      routing: { upstream: 'https://partner.example/v1', authStrategy: 'gateway-key' },
      decision: null,
    });
    await expect(resolveRemoteClaudeRoute({ providerId: 'partner-gw', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });

  it('路由凭证 mutation 窗口内 → REMOTE_PROVIDER_UPDATING(不误报不支持)', async () => {
    isProviderRouteMutationInProgress.mockReturnValue(true);
    await expect(resolveRemoteClaudeRoute({ providerId: 'my-provider', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UPDATING/,
    );
    expect(resolveProviderRouteDecision).not.toHaveBeenCalled();
  });

  it('TOCTOU: resolver 返回 null 后 mutation 窗口开启 → REMOTE_PROVIDER_UPDATING', async () => {
    // 前置检查通过(false),resolver 返回 null,兜底检查命中(true)—— 模拟窗口在两次判定之间开启。
    isProviderRouteMutationInProgress.mockReturnValueOnce(false).mockReturnValue(true);
    resolveProviderRouteDecision.mockResolvedValue(null);
    await expect(resolveRemoteClaudeRoute({ providerId: 'my-provider', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UPDATING/,
    );
  });

  it('显式未知供应商(无 claude-code 路由)→ REMOTE_PROVIDER_UNSUPPORTED', async () => {
    resolveProviderRouteDecision.mockResolvedValue(null);
    await expect(resolveRemoteClaudeRoute({ providerId: 'ghost', model: 'm' })).rejects.toThrow(
      /REMOTE_PROVIDER_UNSUPPORTED/,
    );
  });

  it('订阅未连接但走到订阅直连路径 → REMOTE_NATIVE_OAUTH_UNAVAILABLE', async () => {
    getClaudeAiOAuthForSpawn.mockReturnValue(null);
    resolveProviderRouteDecision.mockResolvedValue(null);
    await expect(
      resolveRemoteClaudeRoute({ providerId: 'anthropic', model: 'claude-opus-5' }),
    ).rejects.toThrow(/REMOTE_NATIVE_OAUTH_UNAVAILABLE/);
  });
});

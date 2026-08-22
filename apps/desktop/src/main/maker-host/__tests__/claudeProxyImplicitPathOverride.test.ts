import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAppCapabilities } = vi.hoisted(() => ({
  mockGetAppCapabilities: vi.fn(() => ({ canUseCindyGateway: true })),
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: mockGetAppCapabilities,
}));
vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function self() { return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: self }; }),
  }),
  desktopMakerLogger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('../runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.example.com',
}));
vi.mock('../silent-encrypted-retry-store', () => ({
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
}));
vi.mock('../claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));

import { buildUserProvider } from '@cindy/model-providers';

import {
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import {
  setCustomProviderKeyReader,
  setPendingCredentialSwitchReader,
  setProviderOAuthTokenReader,
  setProviderViewsReader,
} from '../provider-route';
import { getActiveCatalog, setCustomProviders } from '../active-catalog';
import { clearSessionProvider, setSessionProvider } from '../session-provider-store';
import { buildRegistry } from '@cindy/model-providers';

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

describe('cc proxy ①.5 implicit route — requestPath 透传 (#3210 P2 follow-up)', () => {
  beforeEach(() => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
    setPendingCredentialSwitchReader(() => undefined);
    setProviderOAuthTokenReader(() => null);
    setCustomProviders([
      buildUserProvider({
        id: 'tenant-bridge',
        name: 'Tenant Bridge',
        runtimes: {
          'claude-code': {
            baseUrl: 'https://tenant.example.com/api/anthropic',
            // 用户在多租户网关后配置了子路径,会话绑定后由 resolveSessionRouteDecision
            // 写 pathOverride;隐式首包也必须带上,否则打到原始 /v1/messages 会 404。
            requestPath: '/tenant/acme/v1/messages',
            wireProtocol: 'anthropic-messages',
            models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'tenant-key');
    setProviderViewsReader(async () =>
      buildRegistry(getActiveCatalog(), { 'tenant-bridge': true }, {}),
    );
  });

  afterEach(() => {
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    setProviderViewsReader(async () => []);
    clearSessionProvider('sess-implicit');
  });

  it('forwards the user-configured requestPath when routing the implicit first packet', async () => {
    const transform = createModelRoutingTransform();
    const decision = await Promise.resolve(
      transform(
        { model: 'glm-5.3' },
        ctxWith({ 'x-api-key': 'sk-gw' }),
      ),
    );
    expect(decision).toMatchObject({
      upstreamOverride: 'https://tenant.example.com/api/anthropic',
      pathOverride: '/tenant/acme/v1/messages',
      headerOverride: {
        'x-api-key': 'tenant-key',
      },
    });
  });

  it('does not override an explicit XD session with the implicit user bridge (#3210 P1 follow-up)', async () => {
    // 会话已显式选 XD,但运行期 gateway key 被清除、cc 子进程仍携带冻结的
    // x-api-key。此时 ① 段 scope 门放行到 ② 段,那里有专门的 XD passthrough
    // 分支(按会话实际流量记 gateway 账)。①.5 隐式段绝不能用用户 bridge 覆盖它,
    // 否则用户明确选 XD 的提示词与计费被改送到另一上游。
    setClaudeProxySessionIdResolver((sdkId) =>
      sdkId === 'sdk-xd' ? 'sess-xd' : null,
    );
    setSessionProvider('sess-xd', 'xd');
    const transform = createModelRoutingTransform();
    const decision = await Promise.resolve(
      transform(
        { model: 'glm-5.3' },
        ctxWith({
          'x-claude-code-session-id': 'sdk-xd',
          'x-api-key': 'sk-frozen',
        }),
      ),
    );
    // 走 ② 段:已选 XD 时由网关 key 决策接管(记 gateway 账),绝不能落到
    // 用户自定义 bridge(tenant-key)。断言不是 tenant bridge 即可——具体
    // headerOverride 由 ② 段的 spawn-aware 默认路由决定(gateway key 或 passthrough)。
    expect(decision).not.toMatchObject({
      upstreamOverride: 'https://tenant.example.com/api/anthropic',
    });
    if (decision && 'headerOverride' in decision && decision.headerOverride) {
      expect(decision.headerOverride['x-api-key']).not.toBe('tenant-key');
    }
  });
});

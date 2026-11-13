/**
 * 测试价值（放行表第 24 行，Codex 回环代理的入站凭据）
 * - 可观察结果：共用的 Codex 代理核心交给代理包的选项。createCodexProxyHandle 建出的每一种代理
 *   （主代理、三种模式的控制面代理、自定义上下文代理、受邀者代理）：不传入站检查端口
 *   时，选项里没有 authorizeInbound；传了（Node Host）时只多这一项，且就是传入的那个
 *   函数，其余选项的键逐项相同。
 * - 规则依据：Host 的 Codex 回环代理要求入站凭据；这个端口是可选的，不传时行为不变。
 * - 最小失败输入：不传时也带上一个检查；只给主代理传、漏了控制面或自定义上下文代理；顺带改动了
 *   其它选项。
 * - tier：unit（代理包的创建函数换成记录选项的桩，不起端口）。
 */
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as Array<{ kind: string; options: Record<string, unknown> }>);
const current = vi.hoisted(() => ({ kind: '' }));
vi.mock('@cindy/anthropic-compat-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>()),
  createAnthropicCompatProxy: vi.fn(async (options: Record<string, unknown>) => {
    captured.push({ kind: current.kind, options });
    return { url: `http://127.0.0.1:${10_000 + captured.length}`, dispose: async () => {} };
  }),
}));

import { createCodexProxyHost, type CodexProxyHostPorts } from '../codex-proxy-host.js';

const ports = (): CodexProxyHostPorts => ({
  bearerKeyFromHeaders: () => null,
  reportCindyGatewayKeyRejected: () => {},
  createAttachmentRecovery: () => null,
  restrictSubscriptionRequest: (decision: unknown) => decision,
  withSubscriptionFastRequestPolicy: (decision: unknown) => decision,
  peekGrokAccessToken: () => null,
  isClaudeSubscriptionProviderId: () => false,
  isXaiSubscriptionProviderId: (id?: string | null) => id === 'xai',
  buildCodexGatewayBaseUrl: () => 'http://127.0.0.1:2/v1',
  CODEX_OAUTH_UPSTREAM: 'http://127.0.0.1:3',
  claudeUpstreamEndpoint: () => 'http://127.0.0.1:2',
  isOpenAiSubscriptionProviderId: (id?: string | null) => id === 'openai',
  createXaiProxyAuthInvalidationObserver: () => undefined,
  resolveDesktopOutboundProxy: async () => null,
  outboundFetch: async () => new Response(null),
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
  recordXaiRateLimitSnapshot: () => {},
  CODEX_IMAGE_GENERATION_ACTOR_HEADER: 'x-cindy-image-generation-actor',
  codexCustomProviderRoutesSignature: () => '',
  findCodexAppliedCustomProviderRoute: () => null,
  isCodexCustomProviderNamespacePath: () => false,
  parseCodexCustomProviderPath: () => ({ kind: 'none' }),
  relativeProviderRequestPath: (url: string) => url,
  setAppliedCustomProviderRoutes: () => {},
} as unknown as CodexProxyHostPorts);

/** Every kind of proxy createCodexProxyHandle builds, in a fixed order. */
async function startEveryKind(host: ReturnType<typeof createCodexProxyHost>, tag: string) {
  const start = async (kind: string, run: () => Promise<void>) => { current.kind = `${tag}:${kind}`; await run(); };
  await start('main', () => host.ensureCodexProxyReady());
  for (const mode of ['oauth-bearer', 'env-key', 'provider-oauth'] as const)
    await start(`control-plane:${mode}`, () => host.ensureCodexControlPlaneProxyReady(mode));
  await start('custom-context', () => host.ensureCodexCustomContextProxyReady('scope-custom', 'env-key', []));
  await start('guest', () => host.ensureCodexCustomContextProxyReady('scope-guest', 'provider-oauth', [], 'xai', 'guest-session'));
  await host.disposeCodexProxy();
}

describe('the optional inbound check port of the Codex proxy core', () => {
  it('reaches every kind of proxy when given, is absent otherwise, and changes nothing else', async () => {
    await startEveryKind(createCodexProxyHost(ports()), 'without');
    const gate = () => null;
    await startEveryKind(createCodexProxyHost({ ...ports(), authorizeInbound: gate }), 'with');
    const kinds = ['main', 'control-plane:oauth-bearer', 'control-plane:env-key', 'control-plane:provider-oauth', 'custom-context', 'guest'];
    const byKind = (tag: string) => kinds.map(kind => captured.filter(entry => entry.kind === `${tag}:${kind}`));
    const without = byKind('without');
    const withGate = byKind('with');
    for (const [index, kind] of kinds.entries()) {
      expect(without[index], kind).toHaveLength(1);
      expect(withGate[index], kind).toHaveLength(1);
      const a = without[index]![0]!.options;
      const b = withGate[index]![0]!.options;
      expect('authorizeInbound' in a, kind).toBe(false);
      expect(b.authorizeInbound, kind).toBe(gate);
      expect(Object.keys(b).filter(key => key !== 'authorizeInbound'), kind).toEqual(Object.keys(a));
    }
  });
});

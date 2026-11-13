/**
 * 测试价值（放行表第 24 行，24a）
 * - 可观察结果：共用代理核心交给代理包的选项。不传入站检查端口时，
 *   选项里没有 authorizeInbound；传了（Node Host）时只多这一项，且就是传入的那个函数，
 *   其余选项的键逐项相同。
 * - 规则依据：Host 的回环代理要求入站凭据；这个端口是可选的，不传时行为不变。
 * - 最小失败输入：不传时也带上一个检查；传了却没交给代理包；顺带改动了其它选项。
 * - tier：unit（代理包的创建函数换成记录选项的桩，不起端口）。
 */
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@cindy/anthropic-compat-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>()),
  createAnthropicCompatProxy: vi.fn(async (options: Record<string, unknown>) => {
    captured.push(options);
    return { url: 'http://127.0.0.1:1', dispose: async () => {} };
  }),
}));

import { createAnthropicCompatProxyHost, type AnthropicCompatProxyHostPorts } from '../anthropicCompatProxyHostCore.js';

const ports = (): AnthropicCompatProxyHostPorts => ({
  createAttachmentRecovery: () => null,
  outboundFetch: async () => new Response(null),
  isOpenAiSubscriptionProviderId: () => false,
  createPiWebSocketRequestPreparer: () => async () => null,
  resolvePiWebSocketUpstream: () => null,
  piWebSocketTransforms: () => [],
  isClaudeSubscriptionProviderId: () => false,
  isXaiSubscriptionProviderId: () => false,
  getPiNativeSubscriptionHandler: () => async () => {},
  getResponsesBridgeHandler: () => null,
  subscriptionRequestAllowsFast: () => false,
  withSubscriptionFastRequestPolicy: (decision: unknown) => decision,
  resolveDesktopOutboundProxy: async () => null,
  claudeUpstreamEndpoint: () => 'http://127.0.0.1:2',
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
} as unknown as AnthropicCompatProxyHostPorts);

describe('the optional inbound check port', () => {
  it('is absent from the proxy options unless given, and changes nothing else', async () => {
    await createAnthropicCompatProxyHost(ports()).ensureAnthropicCompatProxyReady();
    const gate = () => null;
    await createAnthropicCompatProxyHost({ ...ports(), authorizeInbound: gate }).ensureAnthropicCompatProxyReady();
    const [without, withGate] = captured;
    expect(without).toBeDefined();
    expect('authorizeInbound' in without!).toBe(false);
    expect(withGate!.authorizeInbound).toBe(gate);
    expect(Object.keys(withGate!).filter(key => key !== 'authorizeInbound')).toEqual(Object.keys(without!));
  });
});

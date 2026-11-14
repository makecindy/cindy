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
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';

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

// #10523, unit: the old initialized flag let concurrent ensure callers return
// early and permanently disabled retries after a rejected creation. Inject only
// the listener factory; exercise the production lifecycle and launch endpoint.
describe('proxy startup and launch endpoint', () => {
  const handle = () => ({ url: 'http://127.0.0.1:12345', dispose: vi.fn(async () => {}) });
  type Handle = Awaited<ReturnType<typeof createAnthropicCompatProxy>>;

  it('waits for one in-flight creation before materializing either launch endpoint', async () => {
    let complete!: (value: Handle) => void;
    const create = vi.mocked(createAnthropicCompatProxy);
    create.mockClear();
    create.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const proxy = createAnthropicCompatProxyHost(ports());
    let settled = false;
    const first = proxy.ensureAnthropicCompatProxyReady();
    const second = proxy.resolveClaudeAgentEndpoint().then(url => { settled = true; return url; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(proxy.isAnthropicCompatProxyHandleReady()).toBe(false);
    const listener = handle();
    complete(listener as Handle);
    await first;
    expect(await second).toBe(listener.url);
    expect(create).toHaveBeenCalledOnce();
    await proxy.disposeAnthropicCompatProxy();
    expect(listener.dispose).toHaveBeenCalledOnce();
  });

  it('rejects the launch after failure and recovers on the next explicit attempt', async () => {
    const create = vi.mocked(createAnthropicCompatProxy);
    create.mockRejectedValueOnce(new Error('EADDRINUSE fixture'));
    const proxy = createAnthropicCompatProxyHost(ports());
    await expect(proxy.resolveClaudeAgentEndpoint()).rejects.toThrow('Local model proxy is not ready');
    expect(proxy.isAnthropicCompatProxyHandleReady()).toBe(false);
    const listener = handle();
    create.mockResolvedValueOnce(listener as Handle);
    expect(await proxy.resolveClaudeAgentEndpoint()).toBe(listener.url);
    await proxy.disposeAnthropicCompatProxy();
  });

  it('disposes a late listener and lets a new ensure wait for shutdown before recovering', async () => {
    let complete!: (value: Handle) => void;
    const create = vi.mocked(createAnthropicCompatProxy);
    create.mockClear();
    create.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const proxy = createAnthropicCompatProxyHost(ports());
    const start = proxy.ensureAnthropicCompatProxyReady();
    await Promise.resolve();
    const stop = proxy.disposeAnthropicCompatProxy();
    const next = handle();
    create.mockResolvedValueOnce(next as Handle);
    const recovered = proxy.resolveClaudeAgentEndpoint();
    const late = handle();
    complete(late as Handle);
    await Promise.all([start, stop]);
    expect(await recovered).toBe(next.url);
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    await proxy.disposeAnthropicCompatProxy();
  });
});

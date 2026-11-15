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
import sharp from 'sharp';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { createWebSocketMessageTransform } from '@cindy/anthropic-compat-proxy';
import type { RequestSizeController } from '@cindy/anthropic-compat-proxy';
import { createAttachmentRecoveryService } from '../oversizedAttachmentRecoveryCore.js';
import { createAnthropicCompatProxyHost, type AnthropicCompatProxyHostPorts } from '../anthropicCompatProxyHostCore.js';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store.js';
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
  createRequestSizeController: (_resolve: unknown, preprocessor: import('@cindy/anthropic-compat-proxy').InlineImagePreprocessor): ReturnType<CodexProxyHostPorts['createRequestSizeController']> => ({ preprocessor, control: async () => null }),
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
      // PR 2: every proxy kind forwards a real prepare/tighten adapter.
      expect(a.requestSizeController).toMatchObject({ preprocessor: { prepare: expect.any(Function), tighten: expect.any(Function) } });
      const b = withGate[index]![0]!.options;
      expect('authorizeInbound' in a, kind).toBe(false);
      expect(b.authorizeInbound, kind).toBe(gate);
      expect(Object.keys(b).filter(key => key !== 'authorizeInbound'), kind).toEqual(Object.keys(a));
    }
  });
});


// Unit, PR 2 provider handoff: real shared host factory -> real controller.route
// -> real image encoder. Proxy socket creation and storage are stubbed; this
// does not claim account authentication or outbound routing/HTTP coverage.
it.each(['codex', 'claude-code'] as const)('passes the selected provider to image compression for %s without Pi headers', async engine => {
  const recovery = createAttachmentRecoveryService({
    getUserDataDir: () => { throw new Error('Provider-only test must not touch storage'); },
    media: {} as never, // route() uses no media ports; any accidental storage call fails.
  });
  const factoryPorts = { ...ports(), createRequestSizeController: recovery.createRequestSizeController };
  const codex = engine === 'codex' ? createCodexProxyHost(factoryPorts) : undefined;
  const claude = engine === 'claude-code' ? createAnthropicCompatProxyHost({
    ...factoryPorts,
    createPiWebSocketRequestPreparer: () => undefined,
    resolvePiWebSocketUpstream: () => undefined,
    piWebSocketTransforms: () => [],
    getPiNativeSubscriptionHandler: () => undefined,
    getResponsesBridgeHandler: () => undefined,
    subscriptionRequestAllowsFast: () => true,
  } as unknown as AnthropicCompatProxyHostPorts) : undefined;
  const sessionId = `image-provider-${engine}`;
  const threadId = `image-thread-${engine}`;
  current.kind = `image-provider:${engine}`;
  codex?.registerComposed(sessionId, threadId, '');
  claude?.setClaudeProxySessionIdResolver(id => id);
  try {
    if (codex) await codex.ensureCodexProxyReady();
    else await claude!.ensureAnthropicCompatProxyReady();
    const controller = captured.find(entry => entry.kind === current.kind)!.options.requestSizeController as RequestSizeController;
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#245681' } }).png({ compressionLevel: 0 }).toBuffer();
    const headers: Record<string, string> = codex ? { 'thread-id': threadId } : { 'x-claude-code-session-id': sessionId };
    for (const [providerId, modelId, expectedMime] of [
      ['openai', 'gpt-6-astra', 'image/webp'],
      ['xai', 'grok-4', 'image/png'],
      ['zhipu', 'glm-5', 'image/png'],
    ]) {
      setSessionProvider(sessionId, providerId);
      const route = controller.route!({ reqId: 1, method: 'POST', url: codex ? '/v1/responses' : '/v1/messages', headers }, { model: modelId });
      expect(route.providerId).toBe(providerId);
      const image = await controller.preprocessor!.prepare({ bytes: png, mimeType: 'image/png', route, signal: new AbortController().signal });
      expect(image?.mimeType).toBe(expectedMime);
      expect(image).toMatchObject({ width: 64, height: 48, changed: true });
      expect(await sharp(image!.bytes).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    }
  } finally {
    clearSessionProvider(sessionId);
    codex?.unregister(sessionId);
    await codex?.disposeCodexProxy();
    await claude?.disposeAnthropicCompatProxy();
  }
});

// Unit: exercise the real host WebSocket frame transform and real encoder, not
// just prepare(). Fifty-two images would cross the count limit in a full replay.
it('compresses PNGs in an incremental Codex WebSocket frame without removing images', async () => {
  const recovery = createAttachmentRecoveryService({
    getUserDataDir: () => { throw new Error('Incremental frames must not use storage'); },
    media: {} as never,
  });
  const controllers: RequestSizeController[] = [];
  const host = createCodexProxyHost({ ...ports(),
    createRequestSizeController: (...args) => {
      const controller = recovery.createRequestSizeController(...args);
      vi.spyOn(controller, 'control');
      controllers.push(controller);
      return controller;
    },
  });
  current.kind = 'image-websocket-incremental';
  host.registerComposed('image-ws-session', 'image-ws-thread', '');
  setSessionProvider('image-ws-session', 'openai');
  try {
    await host.ensureCodexProxyReady();
    const options = captured.find(entry => entry.kind === current.kind)!.options as unknown as {
      webSocketTransforms: (context: { url: string; headers: Record<string, string> }) => { outbound: Transform };
    };
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#456789' } }).png({ compressionLevel: 0 }).toBuffer();
    const image = { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` };
    const payload = Buffer.from(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', previous_response_id: 'prior-response', input: Array(52).fill(image) }));
    const header = Buffer.alloc(14);
    header[0] = 129; header[1] = 128 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    const { outbound } = options.webSocketTransforms({ url: '/backend-api/codex/responses', headers: { 'thread-id': 'image-ws-thread' } });
    const forwarded: Buffer[] = [];
    outbound.on('data', chunk => forwarded.push(Buffer.from(chunk)));
    const ended = once(outbound, 'end');
    outbound.end(Buffer.concat([header, payload]));
    await ended;
    let message: Buffer = Buffer.alloc(0);
    const reader = createWebSocketMessageTransform(true, decoded => { message = decoded; return decoded; });
    reader.resume();
    const read = once(reader, 'end');
    reader.end(Buffer.concat(forwarded));
    await read;
    expect(controllers[0].control).toHaveBeenCalledWith(expect.any(Buffer), 'responses', expect.objectContaining({ allowRemoval: false }));
    const body = JSON.parse(message.toString());
    expect(body.previous_response_id).toBe('prior-response');
    expect(body.input).toHaveLength(52);
    for (const item of body.input) expect(item.image_url).toMatch(/^data:image\/webp;base64,/);
    expect(await sharp(Buffer.from(body.input[0].image_url.split(',')[1], 'base64')).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
    expect(message.length).toBeLessThan(payload.length * 0.85);
  } finally {
    clearSessionProvider('image-ws-session');
    host.unregister('image-ws-session');
    await host.disposeCodexProxy();
  }
});

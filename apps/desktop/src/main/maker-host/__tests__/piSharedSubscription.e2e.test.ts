import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { buildUserProvider } from '@cindy/model-providers';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => false, activeOwnerScopeKey: () => 'cloud:pi-codec-fixture',
}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../runtime-configs.js', () => ({ claudeUpstreamEndpoint: () => 'https://unused.example' }));
vi.mock('../subscription-fast-policy.js', () => ({ createSubscriptionFastPolicy: () => ({ isAllowed: () => true }) }));
vi.mock('../logger-adapter.js', () => {
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
  return { createMakerLogger: () => logger, desktopMakerLogger: logger };
});
// Account state and cloud transport use fixtures. Pi, the loopback proxy, the
// routing transform, native decoder and live grant checks are production code.
vi.mock('../anthropic-responses-bridge-host.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../anthropic-responses-bridge-host.js')>();
  return { ...actual, getPiNativeSubscriptionHandler: (provider: string, session: string) =>
    actual.getPiNativeSubscriptionHandler(provider, session, {
      fetch: fixture.fetch,
      getChatgptAuth: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }),
      getGrokToken: async () => 'fixture-token', peekGrokToken: () => 'fixture-token',
      invalidateChatgpt: async () => false, invalidateXai: async () => 'ignored', recordXaiRateLimit() {},
    }),
  };
});

import { createModelRoutingTransform } from '../anthropic-compat-proxy-host.js';
import { setCustomProviders } from '../active-catalog.js';
import { bindHostedSessionProvider } from '../session-provider-store.js';
import { registerGuestProviderRoute } from '../guest-provider-route-store.js';
import { registerPiProxySession } from '../pi-proxy-session-auth.js';

const binary = path.resolve('../../apps/pi-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi');
const providerId = 'openai-native-codec-fixture';
const wireModel = 'gpt-6.1-sol';
const catalogModel = `chatgpt/${wireModel}`;

function reply(): string {
  const item = { id: 'msg_codec', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: 'native-proxy-ok', annotations: [] }] };
  const response = { id: 'resp_codec', object: 'response', status: 'completed', model: wireModel, output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'native-proxy-ok' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
}

// Regression: real Pi sends zstd while the generic proxy's parsedBody is undefined.
// The old host rejected this authorized request as model ''. Unit tests separately
// covered plaintext routing and compressed forwarding, never their composition.
// Tier: e2e (real child process + loopback HTTP), no user credentials or cloud calls.
it.skipIf(!existsSync(binary)).each(['guest', 'owner'])('replies through the real Pi/proxy path for %s and rejects a revoked grant', async trust => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-pi-shared-codec-'));
  let allowed = true;
  const binding = trust === 'guest'
    ? registerGuestProviderRoute('codec-runtime', providerId, model => allowed && model === catalogModel)
    : bindHostedSessionProvider('codec-runtime', providerId, (provider, model) => allowed && provider === providerId && model === catalogModel);
  const disposeToken = registerPiProxySession('codec-runtime', 'fixture-route-token', () => providerId);
  setCustomProviders([buildUserProvider({ id: providerId, name: 'Native codec fixture', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.example', wireProtocol: 'openai-responses', models: [{ id: wireModel, name: 'Fixture' }] } },
  })]);
  fixture.fetch.mockReset().mockImplementation(async (_url, init) => {
    expect(init.headers['content-encoding']).toBe('zstd');
    const payload = JSON.parse(zstdDecompressSync(Buffer.from(init.body)).toString());
    expect(payload.model).toBe(wireModel);
    return new Response(reply(), { headers: { 'content-type': 'text/event-stream' } });
  });
  let proxy: Awaited<ReturnType<typeof createAnthropicCompatProxy>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    proxy = await createAnthropicCompatProxy({ upstream: 'http://127.0.0.1:9', transformRequest: [], routingTransform: createModelRoutingTransform() });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const key = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })}.`;
    await writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'openai-codex': {
      baseUrl: proxy.url, apiKey: key,
      headers: { 'x-cindy-pi-session-id': 'codec-runtime', 'x-cindy-pi-session-token': 'fixture-route-token', 'x-cindy-pi-provider-id': providerId },
      models: [{ id: wireModel, name: 'Fixture', api: 'openai-codex-responses', input: ['text'], reasoning: false, contextWindow: 200000, maxTokens: 4096 }],
    } } }));
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { maxRetries: 0 } }));
    const run = async () => {
      child = spawn(binary, ['--print', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '--provider', 'openai-codex', '--model', wireModel, 'Reply briefly.'], {
        cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      // real-wait: bound the actual Pi child lifetime; normal completion clears the deadline.
      const timer = setTimeout(() => child?.kill(), 15000);
      try { const [code] = await once(child, 'close'); return { code, stdout, stderr }; }
      finally { clearTimeout(timer); }
    };
    const success = await run();
    expect(success.code, success.stderr).toBe(0);
    expect(success.stdout).toContain('native-proxy-ok');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    allowed = false;
    const denied = await run();
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('not available');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  } finally {
    child?.kill(); await proxy?.dispose(); disposeToken(); binding.release(); setCustomProviders([]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

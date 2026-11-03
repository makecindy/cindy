import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../../../../../../packages/maker-core/src/agents/pi/native-provider-adapter-source.js';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../../../../../../packages/maker-core/src/agents/pi/cindy-bridge-source.js';

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'fixture-owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../codex-account-auth.js', () => ({ isOpenAiSubscriptionProviderId: (id: string) => id === 'openai' || id === 'account-b' }));
vi.mock('../session-provider-store.js', () => ({ getSessionProvider: () => null, hasHostedSessionModelAccess: () => false }));
vi.mock('../guest-provider-route-store.js', () => ({ guestProviderRouteForSession: () => null }));
vi.mock('../anthropic-responses-bridge-host.js', () => ({ getChatgptBridgeAuthForDispatch: vi.fn(), invalidateChatgptBridgeAuth: vi.fn(async () => false) }));
const fastPolicy = vi.hoisted(() => ({ allowed: true }));
vi.mock('../subscription-fast-request-policy.js', () => ({ subscriptionRequestAllowsFast: () => fastPolicy.allowed }));
import { createPiWebSocketRequestPreparer, resolvePiWebSocketUpstream, piWebSocketTransforms } from '../pi-subscription-websocket.js';
import { registerPiProxySession } from '../pi-proxy-session-auth.js';

const binary = process.env.CINDY_TEST_PI_BINARY ?? resolve('../../apps/pi-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi');
const fastHookStart = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('async function nativeFastPayload(');
const fastHookEnd = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('type CindyAdapterAlias', fastHookStart);
if (fastHookStart < 0 || fastHookEnd <= fastHookStart) throw new Error('Production Fast hook fixture is unavailable');
const fastHookSource = CINDY_BRIDGE_EXTENSION_SOURCE.slice(fastHookStart, fastHookEnd);
let image: string;

function responseEvents(index: number, tool: boolean) {
  const item = tool
    ? { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'fixture_probe', arguments: '{}', status: 'completed' }
    : { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-complete', annotations: [], logprobs: [] }] };
  const response = { id: `resp_${index}`, status: 'completed', output: [item], model: 'gpt-6-astra',
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: index ? 90 : 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 105 } };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(tool ? { arguments: '' } : { content: [] }) } },
    ...(tool
      ? [{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' }, { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' }]
      : [{ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'fixture-complete' },
          { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'fixture-complete' }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
}

describe.skipIf(!existsSync(binary))('actual Pi subscription incremental transport', () => {
  beforeAll(async () => {
    image = (await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()).toString('base64');
  });
  it.each([
    { label: 'standard', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false },
    { label: 'fast and context profile', source: 'openai', provider: 'openai-codex', fast: true, fallback: false, reconnect: false },
    { label: 'independent account', source: 'account-b', provider: 'openai-codex-account', fast: false, fallback: false, reconnect: false },
    { label: 'reconnect', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: true },
    { label: 'native SSE fallback', source: 'openai', provider: 'openai-codex', fast: false, fallback: true, reconnect: false },
    // Regression #7427: exercise the native 1009 fallback on the first request,
    // a reused connection and reconnect, without rewriting or discarding history.
    { label: 'oversized first history', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false, oversized: 'initial' },
    { label: 'oversized reused socket', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false, oversized: 'tool' },
    { label: 'oversized reconnect history', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: true, oversized: 'reconnect' },
    { label: 'original SSE baseline', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false, baseline: true },
    { label: 'live Fast change', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false, toggleFast: true },
    { label: 'Fast restriction between tool steps', source: 'openai', provider: 'openai-codex', fast: true, fallback: false, reconnect: false, restrictFast: true },
    { label: 'missing continuation', source: 'openai', provider: 'openai-codex', fast: false, fallback: false, reconnect: false, missingContinuation: true },
  ])('preserves tool/image history and native recovery: $label', async scenario => {
    fastPolicy.allowed = true;
    const directory = await mkdtemp(join(tmpdir(), 'cindy-pi-ws-'));
    const requests: Array<Record<string, any>> = [];
    const handshakes: Array<Record<string, any>> = [];
    const uploads: Array<{ transport: string; bytes: number }> = [];
    const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    let acknowledgeDisconnect!: () => void;
    const disconnected = new Promise<void>(resolve => { acknowledgeDisconnect = resolve; });
    const upstream = createServer((_req, res) => { void disconnected.then(() => res.end('closed')); });
    let connections = 0;
    let continuationRejected = false;
    upstream.on('upgrade', (req, socket, head) => {
      handshakes.push({ ...req.headers });
      if (scenario.fallback) { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'); return; }
      connections++;
      ws.handleUpgrade(req, socket, head, client => {
        client.once('close', acknowledgeDisconnect);
        // A real upstream rejects oversized messages with close 1009.
        client.on('error', () => {});
        client.on('message', async raw => {
          uploads.push({ transport: 'websocket', bytes: Buffer.byteLength(raw.toString()) });
          const body = JSON.parse(raw.toString());
          const index = requests.length - (continuationRejected ? 1 : 0);
          requests.push(body);
          if (scenario.missingContinuation && index === 2 && !continuationRejected) {
            continuationRejected = true;
            client.send(JSON.stringify({ type: 'error', code: 'previous_response_not_found', message: 'Fixture continuation expired' }));
            return;
          }
          if (scenario.toggleFast && index === 0) await writeFile(join(directory, 'options.json'), JSON.stringify({ fast: true }));
          if (scenario.restrictFast && index === 0) fastPolicy.allowed = false;
          for (const event of responseEvents(index, index < 3)) client.send(JSON.stringify(event));
          if (scenario.reconnect && index === 1) client.close();
        });
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
    const closeAuth = registerPiProxySession('fixture-session', 'fixture-token', () => scenario.source);
    const prepare = createPiWebSocketRequestPreparer(async () => ({ accessToken: 'fixture-upstream-token', accountId: 'fixture-upstream-account', canDispatch: () => true }));
    const proxy = await createAnthropicCompatProxy({
      upstream: upstreamUrl, transformRequest: [],
      resolveWebSocketUpstream: ctx => resolvePiWebSocketUpstream(ctx) ? upstreamUrl : null,
      prepareWebSocketRequest: prepare,
      webSocketTransforms: piWebSocketTransforms,
      routingTransform: () => ({ localHandler: async ({ rawBody, parsedBody, ctx, res }) => {
        const index = requests.length;
        uploads.push({ transport: 'sse', bytes: rawBody.length });
        const decoded = parsedBody ?? JSON.parse((ctx.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(rawBody) : rawBody).toString());
        requests.push({ ...decoded, fallback: true });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of responseEvents(index, index < 3)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } }),
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const model = scenario.fast ? 'gpt-6-astra[1m]' : 'gpt-6-astra';
      const key = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'child-placeholder' } })).toString('base64url')}.fixture`;
      await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { [scenario.provider]: {
        baseUrl: proxy.url, api: 'openai-codex-responses', apiKey: '$CINDY_FIXTURE_KEY',
        headers: { 'x-cindy-pi-session-id': 'fixture-session', 'x-cindy-pi-session-token': 'fixture-token', 'x-cindy-pi-provider-id': scenario.source },
        models: [{ id: model, name: 'Fixture', api: 'openai-codex-responses', contextWindow: 2_000_000, maxTokens: 4096, input: ['text', 'image'], reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } }));
      await writeFile(join(directory, 'auth.json'), '{}');
      await writeFile(join(directory, 'options.json'), JSON.stringify({ fast: scenario.fast }));
      // Keep the global setting at SSE: only the production subscription adapter may override it.
      await writeFile(join(directory, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { enabled: false } }));
      await writeFile(join(directory, 'adapter.ts'), PI_NATIVE_PROVIDER_ADAPTER_SOURCE + '\n' + fastHookSource + `
import { Type } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
export default async function(pi: any) {
  await registerCindyNativeProviderAdapters(pi);
  if (!${Boolean(scenario.baseline)}) pi.on('before_provider_request', (event, ctx) => nativeFastPayload(event.payload, ctx.model, {
    ui: { input: async () => JSON.stringify(JSON.parse(readFileSync(process.env.CINDY_FIXTURE_OPTIONS_FILE, 'utf8'))) },
  }));
  let count = 0;
  pi.registerTool({ name: 'fixture_probe', label: 'Fixture', description: 'Fixture probe', parameters: Type.Object({}),
    execute: async () => {
      ++count;
      if (${scenario.reconnect} && count === 2) await fetch('${upstreamUrl}/wait-for-disconnect');
      if ((${JSON.stringify(scenario.oversized)} === 'tool' && count === 1) || (${JSON.stringify(scenario.oversized)} === 'reconnect' && count === 2)) {
        return { content: Array.from({ length: 20 }, () => ({ type: 'image', data: '${image}', mimeType: 'image/png' })), details: {} };
      }
      return { content: count === 1
      ? [{ type: 'image', data: '${image}', mimeType: 'image/png' }]
      : [{ type: 'text', text: 'fixture-tool-ok' }], details: {} };
    } });
}
`);
      // Supply the large initial history through a file rather than exceeding argv limits.
      await writeFile(join(directory, 'prompt.txt'), 'Run the fixture tool.\n' + 'fixture-context '.repeat(scenario.oversized === 'initial' ? 1_200_000 : 65_536));
      child = spawn(binary, ['--print', '--mode', 'json', '--no-session', '--no-extensions', '--extension', join(directory, 'adapter.ts'),
        '--provider', scenario.provider, '--model', model, `@${join(directory, 'prompt.txt')}`], {
        cwd: directory, env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: '1',
          CINDY_FIXTURE_KEY: key, CINDY_FIXTURE_OPTIONS_FILE: join(directory, 'options.json'),
          CINDY_PI_FAST_MODELS: JSON.stringify([{ provider: scenario.provider, id: model }]),
          CINDY_PI_NATIVE_PROVIDER_ADAPTERS: JSON.stringify([{ id: scenario.provider, provider: scenario.provider, cachedCodex: !scenario.baseline, keyEnv: 'CINDY_FIXTURE_KEY' }]),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; let errors = '';
      child.stdout!.on('data', chunk => { output += chunk; });
      child.stderr!.on('data', chunk => { errors += chunk; });
      const timer = setTimeout(() => child?.kill(), 20_000);
      const [exit] = await once(child, 'exit'); clearTimeout(timer);
      expect(exit, errors + output.slice(-3000)).toBe(0);
      expect(output).toContain('fixture-complete');
      // Body bytes observed at the receiving endpoint: WS JSON versus native
      // zstd SSE. Excludes handshake, RFC6455, HTTP and TLS framing overhead.
      console.info('Pi fixture request body bytes', JSON.stringify({ scenario: scenario.label, uploads }));
      expect(requests).toHaveLength(scenario.missingContinuation ? 5 : 4);
      if (scenario.baseline) {
        expect(handshakes).toHaveLength(0);
        expect(requests.every(body => body.fallback && !body.previous_response_id && JSON.stringify(body).length > 900_000)).toBe(true);
        expect(JSON.stringify(requests[3].input)).toContain('data:image/png;base64,');
      } else if (scenario.oversized) {
        const firstFallback = requests.findIndex(body => body.fallback);
        expect(firstFallback, JSON.stringify(requests.map(body => ({ fallback: body.fallback, bytes: Buffer.byteLength(JSON.stringify(body)), previous: body.previous_response_id })))).toBe(scenario.oversized === 'initial' ? 0 : scenario.oversized === 'tool' ? 1 : 2);
        expect(requests.slice(firstFallback).every(body => body.fallback && !body.previous_response_id)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(requests[firstFallback]))).toBeGreaterThan(16 * 1024 * 1024);
        expect(requests.filter(body => !body.fallback).every(body => Buffer.byteLength(JSON.stringify(body)) <= 15 * 1024 * 1024)).toBe(true);
        expect(handshakes).toHaveLength(scenario.reconnect ? 2 : 1);
        expect(JSON.stringify(requests.at(-1)!.input)).toContain('data:image/png;base64,');
        if (scenario.oversized === 'initial') expect(JSON.stringify(requests.at(-1)!.input)).toContain('fixture-context');
        else expect(JSON.stringify(requests.at(-1)!.input).match(/data:image\/png;base64,/g)).toHaveLength(scenario.oversized === 'reconnect' ? 21 : 20);
      } else if (scenario.fallback) {
        expect(requests.every(body => body.fallback)).toBe(true);
      } else {
        for (const [index, body] of requests.entries()) {
          const tier = scenario.restrictFast && index > 0 ? 'default'
            : scenario.fast || (scenario.toggleFast && index > 0) ? 'priority' : undefined;
          expect(body.model).toBe('gpt-6-astra');
          expect(body.service_tier, `request ${index}`).toBe(tier);
        }
        expect(JSON.stringify(requests[0]).length).toBeGreaterThan(900_000);
        expect(JSON.stringify(requests[1].input)).toContain('data:image/png;base64,');
        expect(requests[1].previous_response_id).toBe(scenario.toggleFast ? undefined : 'resp_0');
        const last = requests.at(-1)!;
        expect(last.previous_response_id).toBe('resp_2');
        expect(JSON.stringify(last).length).toBeLessThan(20_000);
        expect(uploads.at(-1)).toMatchObject({ transport: 'websocket' });
        expect(uploads.at(-1)!.bytes).toBeLessThan(20_000);
        expect(JSON.stringify(last.input)).not.toContain('data:image/png;base64,');
        if (scenario.reconnect) {
          expect(connections).toBe(2);
          expect(requests[2].previous_response_id).toBeUndefined();
          expect(JSON.stringify(requests[2].input)).toContain('data:image/png;base64,');
        } else if (scenario.missingContinuation) {
          expect(requests[2].previous_response_id).toBe('resp_1');
          expect(requests[3].previous_response_id).toBeUndefined();
          expect(JSON.stringify(requests[3].input)).toContain('data:image/png;base64,');
        } else {
          expect(connections).toBe(1);
          expect(requests[2].previous_response_id).toBe('resp_1');
          expect(JSON.stringify(requests[2].input)).not.toContain('data:image/png;base64,');
        }
      }
      if (!scenario.baseline) {
        expect(handshakes[0]).toMatchObject({ authorization: 'Bearer fixture-upstream-token', 'chatgpt-account-id': 'fixture-upstream-account' });
        expect(Object.keys(handshakes[0]).some(key => key.startsWith('x-cindy-'))).toBe(false);
      }
    } finally {
      child?.kill(); closeAuth(); await proxy.dispose();
      for (const client of ws.clients) client.terminate(); ws.close();
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

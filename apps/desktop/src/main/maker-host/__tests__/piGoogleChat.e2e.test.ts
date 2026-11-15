/**
 * #10200: static native-Google route tests miss dynamically discovered Chat models.
 * E2E tier: production catalog builder -> PiAgent models.json -> official Pi binary
 * -> strict loopback Chat server -> translated text/error/done. No real account.
 * Only the destination is redirected after building the official Google spec;
 * model parameters and the production serializer are not mocked.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { PiAgent } from '../../../../../../packages/maker-core/src/agents/pi/index.js';
import type { AgentDeps, AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { AgentEvent } from '../../../../../../packages/maker-core/src/types/events.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { buildPiNativeProvidersFromConfigs } from '../pi-native-catalog.js';

const binary = process.env.CINDY_TEST_PI_BINARY ?? path.resolve('../../apps/pi-bin',
  `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi');
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

describe.skipIf(!existsSync(binary))('Google Chat launch through real Pi', () => {
  it.each([
    { status: 200, staleRoute: false },
    // #10225: the route resolver drops this legacy path before the request.
    { status: 200, staleRoute: true },
    { status: 400, staleRoute: false },
    { status: 401, staleRoute: false },
  ])('settles HTTP $status (stale route: $staleRoute)', async ({ status, staleRoute }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cindy-google-chat-'));
    const agentHome = path.join(root, 'agent');
    const workingDir = path.join(root, 'work');
    mkdirSync(workingDir);
    const requests: Array<{ url: string; body: Record<string, unknown>; status: number }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const hasStore = Object.hasOwn(body, 'store');
      const code = hasStore ? 400 : status;
      requests.push({ url: req.url ?? '', body, status: code });
      if (code !== 200) {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code, status: code === 401 ? 'UNAUTHENTICATED' : 'INVALID_ARGUMENT',
          message: hasStore ? 'Invalid JSON payload received. Unknown name "store": Cannot find field.'
            : code === 401 ? 'API key not valid. Please pass a valid API key.' : 'Missing required field: messages.' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content: 'fixture-ok' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [choice] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    let handle: AgentSessionHandle | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      const official = 'https://generativelanguage.googleapis.com/v1beta/openai';
      const config = { id: 'google-fixture', name: 'Google', runtimes: { pi: {
        catalogPresetId: 'google-gemini-api', baseUrl: official, wireProtocol: 'openai-chat' as const,
        models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', ...(staleRoute ? {
          api: 'openai-completions' as const,
          route: { baseUrl: 'https://stale.example/v1', wireProtocol: 'anthropic-messages' as const,
            requestPath: '/custom/messages' },
        } : {}) }],
      } } };
      const catalog = { ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers, buildUserProvider(config)] };
      const native = buildPiNativeProvidersFromConfigs([config], () => 'fixture-key', undefined, undefined, catalog);
      const provider = native.providers[0];
      expect(provider.models[0].api ?? provider.api).toBe('openai-completions');
      expect(provider.models[0].baseUrl ?? provider.baseUrl).toBe(official);
      // Keep the selected API, model and compat intact; route the HTTP test only to loopback.
      provider.baseUrl = `${endpoint}/v1beta/openai`;
      const deps: AgentDeps = {
        auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' as const }),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
          getAuthEnv: async () => ({}) },
        binaryPath: binary, logger, runtimeConfig: { endpoint },
        resolvePiAgentHome: () => agentHome,
        resolvePiGlobalContextHome: () => root,
        resolvePiNativeProviders: async () => native,
      };
      handle = await new PiAgent(deps).startSession({ sessionId: `google-chat-${status}`, workingDir,
        providerId: provider.id, model: 'gemini-3.8-flash' });
      const runtimeDir = path.join(agentHome, 'run-tmp');
      const configHome = readdirSync(runtimeDir).map(name => path.join(runtimeDir, name))
        .find(dir => existsSync(path.join(dir, 'models.json')))!;
      const serialized = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8'));
      const events: AgentEvent[] = [];
      const collected = (async () => {
        for await (const event of handle!.events()) {
          events.push(event);
          if (event.type === 'done') break;
        }
      })();
      const started = performance.now();
      await handle.send({ type: 'user', content: 'Hello' });
      await collected;
      const elapsedMs = performance.now() - started;
      expect(requests.map(request => ({ url: request.url, hasStore: Object.hasOwn(request.body, 'store'),
        status: request.status })), JSON.stringify(events.filter(event => event.type === 'error' || event.type === 'done')))
        .toEqual([{ url: '/v1beta/openai/chat/completions', hasStore: false, status }]);
      expect(serialized.providers[provider.id].models[0].compat.supportsStore).toBe(false);
      if (status === 200) {
        expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'completed' });
        expect(events.some(event => event.type === 'text' && JSON.stringify(event.data).includes('fixture-ok'))).toBe(true);
      } else {
        expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'failed' });
        expect(events.some(event => event.type === 'error' && JSON.stringify(event.data)
          .includes(status === 401 ? 'API key not valid' : 'Missing required field'))).toBe(true);
      }
      // Event completion, not a sleep: a 4xx must not enter the six-retry backoff.
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      try {
        await handle?.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

/**
 * Regression: Codex may report Ultra/Fast while the Desktop proxy changes or
 * drops the outgoing effort or priority tier. The smallest failing input is a
 * Terra request on the official API route with both options selected.
 * E2E tier: native Codex, the real Desktop proxy and a loopback API;
 * no account or paid inference. The maker-core test bypasses the Desktop proxy,
 * while the existing proxy unit suite does not start a real Codex process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import type { CodexModelListItem } from '../../../../../../packages/maker-core/src/agents/codex/app-server/protocol.js';
import type { AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

const fixture = vi.hoisted(() => ({ root: '', gateway: '' }));
vi.mock('electron', () => ({ app: {
  isPackaged: true, getPath: () => fixture.root, getAppPath: () => fixture.root,
}, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return { getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key] };
});
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: () => fixture.gateway }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
  getLogLevel: () => 'info', getLogDir: () => fixture.root,
}));
vi.mock('@cindy/anthropic-compat-proxy', async importOriginal => {
  const actual = await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>();
  return { ...actual, createAnthropicCompatProxy: (options: Parameters<typeof actual.createAnthropicCompatProxy>[0]) =>
    actual.createAnthropicCompatProxy({ ...options, resolveOutboundProxy: () => null }) };
});

const binary = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

describe.skipIf(!binary)('native Terra Ultra and Fast through the Cindy proxy', () => {
  it.each([
    { model: 'gpt-5.6-terra', effort: 'max' },
    { model: 'gpt-6.1-terra', effort: 'xhigh' },
  ])('forwards $model Ultra and Fast to a loopback API', async ({ model, effort }) => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-terra-native-'));
    const home = path.join(fixture.root, 'home');
    const codex = path.join(fixture.root, 'codex');
    const work = path.join(fixture.root, 'work');
    const requests: Array<Record<string, unknown>> = [];
    const failures: unknown[] = [];
    let homeSpy: { mockRestore(): void } | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let catalogForCleanup: typeof import('../active-catalog.js') | undefined;
    let routingForCleanup: typeof import('../provider-route.js') | undefined;
    let proxyForCleanup: typeof import('../codex-proxy-host.desktop.js') | undefined;
    let sessionsForCleanup: typeof import('../session-provider-store.js') | undefined;
    let agent: CodexAgent | undefined;
    let handle: AgentSessionHandle | undefined;
    try {
      for (const dir of [home, codex, work]) fs.mkdirSync(dir);
      homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
      const apiServer = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
            res.writeHead(404).end();
            return;
          }
          expect(req.headers.authorization).toBe('Bearer synthetic-openai-key');
          requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
          const item = { type: 'message', id: 'msg_terra_result', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'SYNTHETIC_TERRA_OK', annotations: [] }] };
          const events = [
            { type: 'response.created', response: { id: 'terra-response', status: 'in_progress', output: [] } },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: 'terra-response', status: 'completed', output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
          res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
        } catch (error) {
          failures.push(error);
          res.writeHead(500).end('Synthetic API failure');
        }
      });
      server = apiServer;
      await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
      fixture.gateway = 'http://127.0.0.1:' + (apiServer.address() as AddressInfo).port;
      const catalog = await import('../active-catalog.js');
      catalogForCleanup = catalog;
      const routing = await import('../provider-route.js');
      routingForCleanup = routing;
      const proxy = await import('../codex-proxy-host.desktop.js');
      proxyForCleanup = proxy;
      const sessions = await import('../session-provider-store.js');
      sessionsForCleanup = sessions;
      const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');
      const provider = buildUserProvider({ id: 'openai-api', name: 'Synthetic OpenAI', runtimes: { codex: {
        baseUrl: fixture.gateway + '/v1', wireProtocol: 'openai-responses', models: [{ id: model, name: model,
          discoveredMetadata: { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], supportsFastMode: true } }],
      } } });
      catalog.setCustomProviders([provider]);
      routing.setCustomProviderKeyReader(() => 'synthetic-openai-key');
      sessions.setSessionProvider('native-terra-api', 'openai-api');
      proxy.setCodexProxyAuthInjection('provider-oauth');
      await proxy.ensureCodexProxyReady();
      const endpoint = proxy.getCodexProxyEndpoint();
      fs.writeFileSync(path.join(codex, 'config.toml'), [
        'model=' + JSON.stringify(model), 'model_provider="cindy_gateway"',
        'check_for_update_on_startup=false', 'chatgpt_base_url=' + JSON.stringify(fixture.gateway),
        '[analytics]', 'enabled=false', '[features]', 'plugins=false', 'remote_plugin=false',
        '[mcp_servers.cindy_memory]', 'command="false"', 'enabled=false',
      ].join('\n'));
      const env = { HOME: home, USERPROFILE: home, CODEX_HOME: codex, TMPDIR: fixture.root,
        OPENAI_API_KEY: '', CODEX_API_KEY: '', XDT_CODEX_API_KEY: 'synthetic-placeholder',
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost' };
      agent = new CodexAgent({ binaryPath: binary!, logger,
        auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {}, getAuthEnv: async () => env },
        runtimeConfig: { behaviorFlags: env }, resolveCodexLocalAuthPolicy: routing.captureCodexLocalAuthPolicy,
        prepareCodexExtraSpawnConfig: async () => ({
          extraArgs: buildCodexProxySpawnArgs(endpoint, 'provider-oauth'), extraEnv: {},
          codexProxyActive: true, codexOpenAiWebSocketsEnabled: false,
        }),
        registerCodexSystemPromptForThread: ({ sessionId, threadId, text, ...options }) =>
          proxy.registerComposed(sessionId, threadId, text, options),
      });
      let listed: readonly CodexModelListItem[] = [];
      expect(await agent.refreshLocalModels({ credentialMode: 'provider-oauth',
        onModelsListed: models => { listed = models; } })).toBe(true);
      const discovered = listed.find(item => item.model === model);
      expect(discovered?.supportedReasoningEfforts?.map(item => item.reasoningEffort)).toContain('ultra');
      expect(discovered?.additionalSpeedTiers).toContain('fast');
      handle = await agent.startSession({ sessionId: 'native-terra-api', providerId: 'openai-api', model,
        effort: 'ultra', fastMode: true, workingDir: work, permissionMode: 'bypassPermissions', makerMemoryEnabled: false });
      const events: string[] = [];
      const complete = (async () => {
        for await (const event of handle!.events()) {
          events.push(JSON.stringify(event));
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
        throw new Error('Native Codex ended before completing the turn');
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([complete, handle.send({ type: 'user', content: 'Reply with the fixture response.' }, { throwOnStartFailure: true })]),
          new Promise<never>((_, reject) => {
            // real-wait: cancelled deadline for a native process and loopback response.
            timer = setTimeout(() => reject(new Error('Native Terra turn timed out')), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(failures).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model, reasoning: { effort }, service_tier: 'priority' });
      expect(JSON.stringify(requests[0]!.input)).toContain('Proactive multi-agent delegation is active.');
      expect(events.join('')).toContain('SYNTHETIC_TERRA_OK');
    } finally {
      try {
        await handle?.close();
        await agent?.dispose();
        proxyForCleanup?.unregister('native-terra-api');
        sessionsForCleanup?.clearSessionProvider('native-terra-api');
        await proxyForCleanup?.disposeCodexProxy();
        proxyForCleanup?.clearCodexProxyAuthInjection();
        routingForCleanup?.setCustomProviderKeyReader(() => null);
        catalogForCleanup?.setCustomProviders([]);
      } finally {
        homeSpy?.mockRestore();
        const apiServer = server;
        if (apiServer) {
          apiServer.closeAllConnections();
          await new Promise<void>(resolve => apiServer.close(() => resolve()));
        }
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fixture.gateway = '';
      }
    }
  }, 60_000);
});

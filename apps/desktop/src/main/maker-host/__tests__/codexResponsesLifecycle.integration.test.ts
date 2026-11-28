import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: {
  isPackaged: true, getPath: () => fixture.root, getAppPath: () => fixture.root,
}, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../codex-gateway-config.desktop.js', async importOriginal => ({
  ...await importOriginal<typeof import('../codex-gateway-config.desktop.js')>(),
  buildCodexGatewayBaseUrl: () => 'http://127.0.0.1:9',
}));
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};
const binary = process.env.CINDY_TEST_CODEX_BINARY;

// Integration: the native app-server must emit a terminal error for an orphan
// text delta followed by empty success (#4509). Proxy-only tests cannot detect
// whether Codex retries, silently completes, or delivers the existing error.
// Output-limit regression: the production adapter must preserve the typed
// diagnosis with absent/partial text or reasoning and accept the next distinct
// input after native cleanup. Unit mocks cannot verify these native boundaries.
it.skipIf(!binary).each([
  { routeKind: 'ordinary', truncationOnly: false },
  { routeKind: 'namespaced', truncationOnly: false },
  { routeKind: 'hosted', truncationOnly: false },
  { routeKind: 'namespaced', truncationOnly: true },
])('diagnoses Responses lifecycle on $routeKind (output-limit=$truncationOnly)', async ({ routeKind, truncationOnly }) => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-4509-'));
  const home = path.join(fixture.root, 'home');
  const codex = path.join(fixture.root, 'codex');
  const work = path.join(fixture.root, 'work');
  for (const dir of [home, codex, work]) fs.mkdirSync(dir);
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  const cases = truncationOnly ? ['incomplete', 'incomplete-partial', 'incomplete-reasoning'] : routeKind === 'hosted'
    ? ['orphan']
    : ['orphan', 'valid', 'done-only', 'missing-done', 'empty', 'incomplete'];
  let testCase = '';
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain synthetic body */ }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404).end();
      return;
    }
    requests.push(testCase);
    const response = { id: 'resp_replay', object: 'response', model: 'probe-model' };
    const item = { id: 'msg_1', type: 'message', role: 'assistant' };
    const events: Record<string, unknown>[] = [
      { type: 'response.created', response: { ...response, status: 'in_progress' } },
    ];
    if (testCase === 'incomplete-reasoning') {
      events.push({ type: 'response.output_item.done', output_index: 0, item: {
        id: 'reasoning_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Synthetic reasoning' }],
      } });
    }
    if (testCase === 'valid' || testCase === 'missing-done' || testCase === 'incomplete-partial') {
      events.push({ type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', content: [{ type: 'output_text', text: '' }] } });
    }
    if (['orphan', 'valid', 'missing-done', 'incomplete-partial'].includes(testCase)) {
      for (const delta of ['HELLO', ' WORLD']) {
        events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta });
      }
    }
    if (testCase === 'valid' || testCase === 'done-only') {
      events.push({ type: 'response.output_item.done', output_index: 0,
        item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'HELLO WORLD' }] } });
    }
    events.push(testCase.startsWith('incomplete')
      ? { type: 'response.incomplete', response: { ...response, status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' } } }
      : { type: 'response.completed', output: [], response: { ...response, status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const catalog = await import('../active-catalog.js');
  const routing = await import('../provider-route.js');
  const proxy = await import('../codex-proxy-host.desktop.js');
  const sessions = await import('../session-provider-store.js');
  const { deriveCodexCustomProviderRoutes, buildCodexCustomProviderArgs } = await import('../codex-custom-provider-route.js');
  const { buildCodexProxySpawnArgs, CODEX_GATEWAY_PROVIDER_ID } = await import('../codex-gateway-config.js');
  const providerId = 'cprov-lifecycle-probe';
  const sessionId = 'native-lifecycle-task';
  const scope = 'native-lifecycle';
  let agent: CodexAgent | undefined;
  try {
    catalog.setCustomProviders([buildUserProvider({ id: providerId, name: 'Synthetic Responses',
      runtimes: { codex: { baseUrl: endpoint + '/v1', wireProtocol: 'openai-responses', supportsImageGeneration: routeKind === 'namespaced',
        models: [{ id: 'probe-model', name: 'Probe', contextWindow: 200000 }] } } })]);
    routing.setCustomProviderKeyReader(() => 'synthetic-key');
    if (routeKind === 'hosted') sessions.bindHostedSessionProvider(sessionId, providerId, () => true);
    else sessions.setSessionProvider(sessionId, providerId);
    const routes = deriveCodexCustomProviderRoutes(catalog.getActiveCatalog());
    let modelProviderId = CODEX_GATEWAY_PROVIDER_ID;
    let extraArgs: string[];
    if (routeKind === 'namespaced') {
      const route = routes.find(candidate => candidate.providerId === providerId);
      if (!route) throw new Error('Synthetic namespaced route is unavailable');
      modelProviderId = route.modelProviderId;
      await proxy.ensureCodexCustomContextProxyReady(scope, 'provider-oauth', routes);
      extraArgs = buildCodexCustomProviderArgs(proxy.getCodexCustomContextProxyEndpoint(scope), 'provider-oauth', routes).extraArgs;
    } else {
      proxy.setCodexProxyAuthInjection('env-key');
      await proxy.ensureCodexProxyReady();
      extraArgs = buildCodexProxySpawnArgs(proxy.getCodexProxyEndpoint(), 'env-key');
    }
    fs.writeFileSync(path.join(codex, 'config.toml'), [
      'model="probe-model"', `model_provider="${modelProviderId}"`,
      'check_for_update_on_startup=false', `chatgpt_base_url="${endpoint}"`,
      'web_search="disabled"', '[analytics]', 'enabled=false',
      '[features]', 'plugins=false', 'remote_plugin=false',
    ].join('\n'));
    const env = { HOME: home, USERPROFILE: home, CODEX_HOME: codex, TMPDIR: fixture.root,
      OPENAI_API_KEY: '', CODEX_API_KEY: '', XDT_CODEX_API_KEY: 'synthetic-placeholder',
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
    agent = new CodexAgent({ binaryPath: binary!, logger,
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => env },
      runtimeConfig: { behaviorFlags: env }, resolveCodexLocalAuthPolicy: routing.captureCodexLocalAuthPolicy,
      prepareCodexExtraSpawnConfig: async () => ({ extraEnv: {}, codexProxyActive: true,
        extraArgs: [...extraArgs,
          '-c', `model_providers.${modelProviderId}.request_max_retries=0`,
          '-c', `model_providers.${modelProviderId}.stream_max_retries=1`],
      }),
      registerCodexSystemPromptForThread: ({ sessionId, threadId, text, ...options }) => proxy.registerComposed(sessionId, threadId, text, options),
    });
    const handle = await agent.startSession({ sessionId, providerId, model: 'probe-model', workingDir: work, makerMemoryEnabled: false });
    try {
      for (testCase of cases) {
        const collect = (async () => {
          const events = [];
          for await (const event of handle.events()) {
            events.push(event);
            if (event.type === 'done' || event.type === 'error') break;
          }
          return events;
        })();
        await handle.send({ type: 'user', content: 'Synthetic text replay' }, { throwOnStartFailure: true });
        const events = await collect;
        const terminal = events.at(-1);
        const text = events.filter(event => event.type === 'text');
        if (routeKind === 'hosted') {
          expect(text).toHaveLength(0);
          expect(terminal).toMatchObject({ type: 'done', data: { result: '' } });
        } else if (testCase === 'orphan' || testCase.startsWith('incomplete')) {
          const reason = testCase === 'orphan' ? 'output_text_delta_without_item' : 'max_output_tokens';
          expect(text.map(event => (event.data as { text: string }).text).join('')).toBe(testCase === 'incomplete-partial' ? 'HELLO WORLD' : '');
          expect(terminal).toMatchObject({
            type: 'error', data: { message: expect.stringContaining(reason), isTerminal: true, willRetry: false },
          });
          if (testCase.startsWith('incomplete')) {
            expect(terminal).toMatchObject({ data: { reason: 'output-limit' } });
          }
        } else if (testCase === 'missing-done') {
          expect(terminal).toMatchObject({ type: 'done', data: { result: '' } });
          expect(text).toMatchObject([
            { data: { text: 'HELLO', isFinal: false } },
            { data: { text: ' WORLD', isFinal: false } },
          ]);
        } else {
          const result = testCase === 'empty' ? '' : 'HELLO WORLD';
          expect(terminal).toMatchObject({ type: 'done', data: { result } });
          if (result) expect(text.at(-1)).toMatchObject({ data: { text: result, isFinal: true } });
          else expect(text).toHaveLength(0);
        }
        // Native emits error before its authoritative turn/completed. Wait for
        // that boundary before sending a distinct continuation; do not steer
        // into the failed turn or expect a paired done suppressed by the adapter.
        if (truncationOnly) await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
      }
      expect(requests).toEqual(cases);
    } finally { await handle.close(); }
  } finally {
    await agent?.dispose();
    proxy.unregister(sessionId);
    sessions.clearSessionProvider(sessionId);
    await proxy.releaseCodexCustomContextProxy(scope);
    await proxy.disposeCodexProxy();
    proxy.clearCodexProxyAuthInjection();
    routing.setCustomProviderKeyReader(() => null);
    catalog.setCustomProviders([]);
    homeSpy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}, 60_000);

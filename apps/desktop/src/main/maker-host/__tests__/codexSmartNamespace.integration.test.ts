import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider, type ProviderView } from '@cindy/model-providers';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import type { AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: {
  isPackaged: true, getPath: () => fixture.root, getAppPath: () => fixture.root,
}, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));

const binary = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

// Explicit runtime opt-in; no installed binary discovery or real account access.
describe.skipIf(!binary)('native smart child inherited Provider namespace', () => {
  it('completes a selected child turn, then continues the parent with its original key', async () => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-smart-native-'));
    const home = path.join(fixture.root, 'home');
    const codex = path.join(fixture.root, 'codex');
    const work = path.join(fixture.root, 'work');
    for (const dir of [home, codex, work]) fs.mkdirSync(dir);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const wires: Array<{ path: string; model: string; thread: string; parent: string; key: string; effort: unknown }> = [];
    const registrations: Array<{ parentThreadId: string; childThreadId: string }> = [];
    const completions = new Map<string, string>();
    const issued = new Set<string>();
    const failures: unknown[] = [];
    let rootThread = '';
    let agent: CodexAgent | undefined;
    let handle: AgentSessionHandle | undefined;
    const hostPrototype = AppServerHost.prototype as unknown as { routeNotification(method: string, params: unknown): void };
    const notify = hostPrototype.routeNotification;
    const notifications = vi.spyOn(hostPrototype, 'routeNotification').mockImplementation(function (this: AppServerHost, method, params) {
      const event = params as { threadId?: string; turn?: { status?: string } };
      if (method === 'turn/completed' && event.threadId) completions.set(event.threadId, event.turn?.status ?? 'unknown');
      return notify.call(this, method, params);
    });
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const thread = String(req.headers['thread-id'] ?? '');
        const parent = String(req.headers['x-codex-parent-thread-id'] ?? '');
        const child = parent !== '';
        wires.push({ path: req.url, model: body.model, thread, parent,
          key: String(req.headers.authorization), effort: body.reasoning?.effort });
        expect(req.headers.authorization).toBe(`Bearer synthetic-${child ? 'cprov-child' : 'cprov-parent'}`);
        expect(req.headers['chatgpt-account-id']).toBeUndefined();
        expect(body.model).toBe(child ? 'gpt-6-astra' : 'api-parent');
        if (child) expect(req.headers['x-openai-subagent']).toBe('collab_spawn');
        // Use the actual tool schema emitted by this exact native runtime.
        const namespace = body.tools?.find((tool: { type: string; name: string }) => tool.type === 'namespace' && tool.name === 'multi_agent_v1');
        const spawn = namespace?.tools?.find((tool: { name: string }) => tool.name === 'spawn_agent');
        let item: unknown;
        if (!issued.has(thread) && thread === rootThread) {
          expect(spawn).toBeTruthy();
          if (thread === rootThread) expect(spawn.parameters.properties.model).toBeTruthy();
          issued.add(thread);
          item = { id: `fc-${wires.length}`, type: 'function_call', call_id: `call-${wires.length}`,
            namespace: namespace.name, name: spawn.name, arguments: JSON.stringify({
              message: 'Synthetic child task. Nested delegation is authorized.', fork_context: false,
              ...(spawn.parameters.properties.model ? { model: 'gpt-6-astra' } : {}),
            }) };
        } else {
          item = { id: `m-${wires.length}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic complete' }] };
        }
        const id = `r-${wires.length}`;
        const events = [{ type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item },
          { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) { failures.push(error); res.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const catalog = await import('../active-catalog.js');
    const routing = await import('../provider-route.js');
    const proxy = await import('../codex-proxy-host.js');
    const sessions = await import('../session-provider-store.js');
    const { deriveCodexCustomProviderRoutes, buildCodexCustomProviderArgs } = await import('../codex-custom-provider-route.js');
    const { selectCodexSmartSubagentCandidates } = await import('../codex-smart-subagent-routing.js');
    try {
      const providers = ['parent', 'child'].map(id => buildUserProvider({ id: `cprov-${id}`, name: id, runtimes: { codex: {
        baseUrl: `${endpoint}/${id}`, wireProtocol: 'openai-responses', supportsImageGeneration: id === 'parent',
        models: [{ id: id === 'parent' ? 'api-parent' : 'gpt-6-astra', name: id, contextWindow: 200_000, reasoningEfforts: ['high'] }],
      } } }));
      catalog.setCustomProviders(providers);
      routing.setCustomProviderKeyReader(id => `synthetic-${id}`);
      const candidates = selectCodexSmartSubagentCandidates(providers.map(provider => ({ ...provider, connected: true, agents: ['codex'] })) as ProviderView[],
        { allowChatGptOAuth: true, oauthProviderId: 'cprov-parent' });
      expect(candidates.some(candidate => candidate.providerId === 'cprov-child' && candidate.model.id === 'gpt-6-astra')).toBe(true);
      expect(candidates.some(candidate => candidate.providerId === 'openai')).toBe(false);
      const routes = deriveCodexCustomProviderRoutes(catalog.getActiveCatalog());
      const parentRoute = routes.find(route => route.providerId === 'cprov-parent')!;
      await proxy.ensureCodexCustomContextProxyReady('native-smart', 'provider-oauth', routes);
      const proxyEndpoint = proxy.getCodexCustomContextProxyEndpoint('native-smart');
      fs.writeFileSync(path.join(codex, 'config.toml'), [
        'model="api-parent"', `model_provider=${JSON.stringify(parentRoute.modelProviderId)}`,
        'check_for_update_on_startup=false', `chatgpt_base_url=${JSON.stringify(endpoint)}`,
        '[analytics]', 'enabled=false', '[features]', 'plugins=false', 'remote_plugin=false',
        '[agents]', 'max_depth=2', '[mcp_servers.cindy_memory]', 'command="/usr/bin/false"', 'enabled=false',
      ].join('\n'));
      const env = { HOME: home, USERPROFILE: home, CODEX_HOME: codex, TMPDIR: fixture.root,
        OPENAI_API_KEY: '', CODEX_API_KEY: '', XDT_CODEX_API_KEY: 'synthetic-placeholder',
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
      sessions.setSessionProvider('native-smart-task', 'cprov-parent');
      agent = new CodexAgent({ binaryPath: binary!, logger,
        auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {}, getAuthEnv: async () => env },
        runtimeConfig: { behaviorFlags: env }, resolveCodexLocalAuthPolicy: routing.captureCodexLocalAuthPolicy,
        prepareCodexExtraSpawnConfig: async () => ({
          ...buildCodexCustomProviderArgs(proxyEndpoint, 'provider-oauth', routes), codexProxyActive: true,
          extraArgs: [...buildCodexCustomProviderArgs(proxyEndpoint, 'provider-oauth', routes).extraArgs,
            '-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true'],
          smartSubagentRoutes: candidates.map(candidate => ({ providerId: candidate.providerId, catalogModel: candidate.model.id, reasoningEffort: 'high' })),
        }),
        registerCodexSystemPromptForThread: ({ sessionId, threadId, text, ...options }) => proxy.registerComposed(sessionId, threadId, text, options),
        registerCodexChildThreadForParent: ({ parentThreadId, childThreadId }) => {
          registrations.push({ parentThreadId, childThreadId }); proxy.registerChildThread(parentThreadId, childThreadId);
        },
        getCodexSubagentIdentity: ({ childThreadId }) => proxy.getObservedCodexSubagentIdentity(childThreadId),
      });
      handle = await agent.startSession({ sessionId: 'native-smart-task', providerId: 'cprov-parent', model: 'api-parent', workingDir: work });
      rootThread = handle.id;
      const send = async () => {
        const done = (async () => { for await (const event of handle!.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        } })();
        await handle!.send({ type: 'user', content: 'synthetic delegation and completion' }, { throwOnStartFailure: true });
        await done;
      };
      await send();
      await vi.waitFor(() => {
        expect(failures).toEqual([]);
        expect(registrations).toHaveLength(1);
        for (const { childThreadId } of registrations) expect(completions.get(childThreadId)).toBe('completed');
      }, { timeout: 20_000 });
      expect(registrations[0]?.parentThreadId).toBe(rootThread);
      expect(wires.filter(wire => wire.parent)).toHaveLength(1);
      expect(wires.filter(wire => wire.parent).every(wire => wire.path === '/child/responses' && wire.model === 'gpt-6-astra' && wire.effort === 'high')).toBe(true);
      const before = wires.length;
      await send();
      expect(wires.slice(before)).toHaveLength(1);
      expect(wires.at(-1)).toMatchObject({ thread: rootThread, path: '/parent/responses', model: 'api-parent' });
      expect(failures).toEqual([]);
    } finally {
      await handle?.close(); await agent?.dispose();
      proxy.unregister('native-smart-task'); sessions.clearSessionProvider('native-smart-task');
      await proxy.releaseCodexCustomContextProxy('native-smart');
      routing.setCustomProviderKeyReader(() => null); catalog.setCustomProviders([]);
      notifications.mockRestore(); homeSpy.mockRestore();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

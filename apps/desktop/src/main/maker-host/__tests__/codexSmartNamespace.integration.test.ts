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
const diagnostics: string[] = [];
const log: Logger['debug'] = (message, details) => {
  if (message === 'stderr' && typeof details?.line === 'string') diagnostics.push(details.line);
};
const logger: Logger = { trace: log, debug: log, info: log, warn: log, error: log, fatal: log, child: () => logger };

// #9183: the existing v1 route smoke did not check v2 message classification.
// Integration tier: real CodexAgent/app-server/catalog/proxy, synthetic loopback SSE
// and credentials. Missing marker is the failure input; explicit [] is the control.
// Explicit runtime opt-in; no installed binary discovery or real account access.
describe.skipIf(!binary)('9183 original plaintext misclassification in real native smart collaboration', () => {
  it.each([{ child: 'gpt-6-astra', explicit: false, smart: false },
    ...['gpt-6-astra', 'qwen-synthetic-child'].flatMap(child => [false, true].map(explicit => ({ child, explicit, smart: true })))])('native child $child smart=$smart plaintext marker=$explicit', async ({ child: childModel, explicit, smart: smartEnabled }) => {
    diagnostics.length = 0;
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-smart-native-'));
    const home = path.join(fixture.root, 'home');
    const codex = path.join(fixture.root, 'codex');
    const work = path.join(fixture.root, 'work');
    for (const dir of [home, codex, work]) fs.mkdirSync(dir);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const captured: any[] = [];
    const wires: Array<{ path: string; model: string; thread: string; parent: string; key: string; effort: unknown }> = [];
    const registrations: Array<{ parentThreadId: string; childThreadId: string }> = [];
    const completions = new Map<string, string>();
    const issued = new Set<string>();
    const failures: unknown[] = [];
    let rootThread = '';
    let nextMessage: 'send_message' | 'followup_task' | undefined;
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
        expect(body.model).toBe(child ? childModel : 'api-parent');
        if (child) captured.push(body);
        if (child) expect(req.headers['x-openai-subagent']).toBe('collab_spawn');
        // Use the actual tool schema emitted by this exact native runtime.
        const namespace = body.tools?.find((tool: { type: string; name: string }) => tool.type === 'namespace' && tool.name === (smartEnabled ? 'collaboration' : 'multi_agent_v1'));
        const spawn = namespace?.tools?.find((tool: { name: string }) => tool.name === 'spawn_agent');
        let item: unknown;
        if (!issued.has(thread) && thread === rootThread) {
          expect(spawn).toBeTruthy();
          if (thread === rootThread) expect(spawn.parameters.properties.model).toBeTruthy();
          issued.add(thread);
          item = { id: `fc-${wires.length}`, type: 'function_call', call_id: `call-${wires.length}`,
            namespace: namespace.name, name: spawn.name, ...(explicit ? { encrypted_function_args: [] } : {}), arguments: JSON.stringify({
              message: 'synthetic-9183-first-assignment-unique',
              ...(spawn.parameters.properties.task_name ? { task_name: 'probe' } : {}),
              ...(spawn.parameters.properties.fork_turns ? { fork_turns: 'none' } : { fork_context: false }),
              ...(spawn.parameters.properties.model ? { model: childModel } : {}),
            }) };
        } else if (thread === rootThread && nextMessage) {
          const name = nextMessage;
          nextMessage = undefined;
          const tool = namespace?.tools?.find((tool: { name: string }) => tool.name === name);
          expect(tool).toBeTruthy();
          const props = tool.parameters.properties;
          const target = props.target ? { target: '/root/probe' } : { id: registrations[0]!.childThreadId };
          item = { id: `fc-${wires.length}`, type: 'function_call', call_id: `call-${wires.length}`,
            namespace: namespace.name, name, ...(explicit ? { encrypted_function_args: [] } : {}),
            arguments: JSON.stringify({ ...target, message: `synthetic-9183-${name}-unique` }) };
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
    const proxy = await import('../codex-proxy-host.desktop.js');
    const sessions = await import('../session-provider-store.js');
    const { deriveCodexCustomProviderRoutes, buildCodexCustomProviderArgs } = await import('../codex-custom-provider-route.js');
    const { selectCodexSmartSubagentCandidates, prepareCodexSmartSubagentConfig } = await import('../codex-smart-subagent-routing.js');
    try {
      const providers = ['parent', 'child'].map(id => buildUserProvider({ id: `cprov-${id}`, name: id, runtimes: { codex: {
        baseUrl: `${endpoint}/${id}`, wireProtocol: 'openai-responses', supportsImageGeneration: id === 'parent',
        models: [{ id: id === 'parent' ? 'api-parent' : childModel, name: id, contextWindow: 200_000, reasoningEfforts: ['high'] }],
      } } }));
      catalog.setCustomProviders(providers);
      routing.setCustomProviderKeyReader(id => `synthetic-${id}`);
      const candidates = selectCodexSmartSubagentCandidates(providers.map(provider => ({ ...provider, connected: true, agents: ['codex'] })) as ProviderView[],
        { allowChatGptOAuth: true, oauthProviderId: 'cprov-parent' });
      expect(candidates.some(candidate => candidate.providerId === 'cprov-child' && candidate.model.id === childModel)).toBe(true);
      expect(candidates.some(candidate => candidate.providerId === 'openai')).toBe(false);
      // Minimal native ModelInfo fixture: no developer catalog, prompts or login.
      fs.writeFileSync(path.join(codex, 'models_cache.json'), JSON.stringify({ models: [{
        slug: 'gpt-5.6-terra', display_name: 'Synthetic', description: 'Loopback fixture',
        default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
        shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
        model_messages: { instructions_template: 'Synthetic isolated integration test.', instructions_variables: {} },
        include_skills_usage_instructions: false, default_reasoning_summary: 'none',
        support_verbosity: false, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text_and_image',
        truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 200000,
        effective_context_window_percent: 95, input_modalities: ['text'], multi_agent_version: 'v2',
        experimental_supported_tools: [], supports_image_detail_original: false,
        supports_search_tool: false, supports_experimental_context: false,
        use_responses_lite: false, supports_reasoning_effort_updates: true,
        node_repl_auto_review_required: false, node_repl_disabled: true, tool_mode: null,
        default_verbosity: 'low', max_context_window: 200000, multi_agent_reasoning_effort: 'high',
      }] }));
      const smart = prepareCodexSmartSubagentConfig({
        codexHome: codex, providerViews: providers.map(provider => ({ ...provider, connected: true, agents: ['codex'] })) as ProviderView[],
        allowChatGptOAuth: true, oauthProviderId: 'cprov-parent', catalogRevision: 1,
      });
      expect(smart).not.toBeNull();
      if (!smart) throw new Error('Synthetic smart catalog was not prepared');
      const { buildCodexSubagentSpawnArgs } = await import('../codex-subagent-config.js');
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
            ...(smartEnabled ? buildCodexSubagentSpawnArgs({ codexSmartSubagentRouting: true } as any, smart) : ['-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true'])],
          smartSubagentRoutes: candidates.map(candidate => ({ providerId: candidate.providerId, catalogModel: candidate.model.id, reasoningEffort: 'high' })),
        }),
        registerCodexSystemPromptForThread: ({ sessionId, threadId, text, ...options }) => proxy.registerComposed(sessionId, threadId, text, options),
        registerCodexChildThreadForParent: ({ parentThreadId, childThreadId }) => {
          if (!registrations.some(entry => entry.parentThreadId === parentThreadId && entry.childThreadId === childThreadId)) {
            registrations.push({ parentThreadId, childThreadId });
          }
          proxy.registerChildThread(parentThreadId, childThreadId);
        },
        getCodexSubagentIdentity: ({ childThreadId }) => proxy.getObservedCodexSubagentIdentity(childThreadId),
      });
      try {
        handle = await agent.startSession({ sessionId: 'native-smart-task', providerId: 'cprov-parent', model: 'api-parent', workingDir: work });
      } catch (error) {
        throw new Error(`${String(error)}: ${diagnostics.join('\n')}`);
      }
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
      expect(wires.filter(wire => wire.parent).every(wire => wire.path === '/child/responses' && wire.model === childModel && wire.effort === 'high')).toBe(true);
      const childWire = captured[0];
      expect(childWire).toBeDefined();
      expect(JSON.stringify(childWire.input)).toContain('synthetic-9183-first-assignment-unique');
      const encrypted = (childWire.input ?? []).flatMap((x: any) => x.type === 'agent_message' ? x.content ?? [] : []).filter((x: any) => x.type === 'encrypted_content');
      expect(encrypted).toHaveLength(0);
      for (const name of smartEnabled ? ['send_message', 'followup_task'] as const : []) {
        nextMessage = name;
        await send();
      }
      if (smartEnabled) await vi.waitFor(() => {
        expect(failures).toEqual([]);
        const messages = JSON.stringify(captured.map(body => body.input));
        expect(messages).toContain('synthetic-9183-send_message-unique');
        expect(messages).toContain('synthetic-9183-followup_task-unique');
        expect(completions.get(registrations[0]!.childThreadId)).toBe('completed');
      }, { timeout: 20_000 });
      for (const body of captured) {
        expect((body.input ?? []).flatMap((item: any) => item.type === 'agent_message' ? item.content ?? [] : [])
          .filter((part: any) => part.type === 'encrypted_content')).toHaveLength(0);
      }
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


// Local bridges own the HTTP response and bypass the forwarded response adapter.
// Test their actual wire output; the native matrix above proves the classification
// of the identical canonical function_call envelope at the downstream boundary.
describe('9183 local bridge final delivery', () => {
  it.each(['openai-chat', 'anthropic-messages'] as const)('marks the real %s bridge output', async wireProtocol => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-marker-bridge-'));
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fixture.root);
    const failures: unknown[] = [];
    const names = ['spawn_agent', 'send_message', 'followup_task'];
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        expect(body.model).toBe('gpt-6-astra');
        expect(req.headers.authorization ?? `Bearer ${req.headers['x-api-key']}`).toBe('Bearer synthetic-bridge-key');
        expect(req.headers['chatgpt-account-id']).toBeUndefined();
        const tools = names.map(name => {
          const tool = body.tools?.find((tool: any) => (tool.function?.name ?? tool.name ?? '').endsWith(name));
          expect(tool).toBeDefined();
          return { id: `call-${name}`, name: tool.function?.name ?? tool.name, arguments: JSON.stringify({ message: `bridge-${name}` }) };
        });
        let events: unknown[];
        if (wireProtocol === 'openai-chat') {
          const chunk = (delta: unknown, finish_reason: string | null) => ({ id: 'bridge-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] });
          events = [chunk({ role: 'assistant', tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }, null), chunk({}, 'tool_calls')];
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
        } else {
          events = [{ type: 'message_start', message: { id: 'bridge-anthropic', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            ...tools.flatMap((tool, index) => [
              { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
              { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments } },
              { type: 'content_block_stop', index },
            ]),
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        }
      } catch (error) { failures.push(error); res.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const catalog = await import('../active-catalog.js');
    const routing = await import('../provider-route.js');
    const sessions = await import('../session-provider-store.js');
    const proxy = await import('../codex-proxy-host.desktop.js');
    try {
      catalog.setCustomProviders([buildUserProvider({ id: 'bridge-parent', name: 'Synthetic bridge', runtimes: { codex: { baseUrl: endpoint, wireProtocol, models: [{ id: 'gpt-6-astra', name: 'Synthetic', contextWindow: 200000 }] } } })]);
      routing.setCustomProviderKeyReader(() => 'synthetic-bridge-key');
      sessions.setSessionProvider('bridge-task', 'bridge-parent');
      proxy.registerComposed('bridge-task', 'bridge-thread', 'Synthetic bridge instructions');
      proxy.setCodexProxyAuthInjection('provider-oauth');
      await proxy.ensureCodexProxyReady();
      const response = await fetch(`${proxy.getCodexProxyEndpoint()}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-placeholder', 'thread-id': 'bridge-thread' }, body: JSON.stringify({
        model: 'gpt-6-astra', stream: true, input: [{ role: 'user', content: 'Synthetic collaboration' }], tools: [{ type: 'namespace', name: 'collaboration', tools: names.map(name => ({ type: 'function', name, parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })) }],
      }) });
      expect(response.ok).toBe(true);
      const wire = await response.text();
      expect(failures).toEqual([]);
      const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      expect(events.some(event => event.type === 'response.completed')).toBe(true);
      const calls = events.flatMap(event => event.item ? [event.item] : event.response?.output ?? []).filter(item => item.type === 'function_call');
      expect(calls.length).toBeGreaterThanOrEqual(9);
      for (const call of calls) expect(call).toMatchObject({ namespace: 'collaboration', name: expect.stringMatching(/^(spawn_agent|send_message|followup_task)$/), encrypted_function_args: [] });
      const done = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
      expect(done.map(item => JSON.parse(item.arguments).message).sort()).toEqual(names.map(name => `bridge-${name}`).sort());
    } finally {
      proxy.unregister('bridge-task'); sessions.clearSessionProvider('bridge-task');
      await proxy.disposeCodexProxy();
      routing.setCustomProviderKeyReader(() => null); catalog.setCustomProviders([]);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      homeSpy.mockRestore(); fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

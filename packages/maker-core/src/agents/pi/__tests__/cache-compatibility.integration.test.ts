import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../native-provider-adapter-source.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
const binary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../apps/pi-bin', process.platform + '-' + process.arch, process.platform === 'win32' ? 'pi.exe' : 'pi');
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
function responses() {
  const item = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [], logprobs: [] }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((event, sequence_number) => 'event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join('');
}

// Integration tier: public PiAgent -> generated bridge -> official Pi -> loopback
// HTTP, covering #5878/#6570/#6649, both adapters, one transcript input and TTL.
describe.skipIf(!existsSync(binary))('Pi cache recovery over real native RPC/HTTP', () => {
  // #7561: real Pi registry, not a mock of its registration semantics. The
  // former object wrapper destroyed name/config registrations even without 400.
  it('preserves both registration forms, model headers, class receivers and later owners', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-provider-registration-'));
    const output = path.join(root, 'result.json');
    const extension = path.join(root, 'probe.ts');
    const probe = String.raw`
import { writeFileSync } from 'node:fs';
import { envApiKeyAuth } from '@earendil-works/pi-ai';
const CINDY_HOSTED = null;
PRODUCTION_ADAPTER
export default function(pi) {
  pi.on('session_start', async (_event, ctx) => {
    const calls = [];
    let wraps = 0;
    const model = { id: 'fixture', name: 'Fixture', provider: 'fixture-provider', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 32,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const handle = async function* (name, m, c, o) {
      const payload = await o.onPayload?.({ custom_serializer: name, model: m.id }, m);
      calls.push({ name, headers: o.headers, apiKey: o.apiKey, payload });
      yield { type: 'done', message: { stopReason: 'stop', content: [] } };
    };
    class OriginalProvider {
      #name;
      id = model.provider;
      name = 'Fixture';
      constructor(name) { this.#name = name; }
      get auth() { return { apiKey: envApiKeyAuth('key', ['FIXTURE_KEY']) }; }
      getModels() { void this.#name; return [model]; }
      stream(m,c,o) { return handle(this.#name + ':full',m,c,o); }
      streamSimple(m,c,o) { return handle(this.#name + ':simple',m,c,o); }
    }
    try {
      const config = { api: model.api, apiKey: 'fixture-key', baseUrl: model.baseUrl,
        headers: { 'x-provider': 'provider-header' },
        models: [{ ...model, headers: { 'x-model': 'model-header' } }],
        streamSimple: (m,c,o) => handle('config',m,c,o) };
      pi.registerProvider(model.provider, config);
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      const savedConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
      let installed;
      const adapter = await registerCindyNativeProviderAdapters({
        ...pi, on: (event, fn) => { if(event === 'session_start') installed = fn; },
      }, { accepts: m => m.provider === model.provider, ownRegistry() {},
        wrap: (m,o,invoke) => { wraps++; return invoke(o); } });
      await installed({},ctx);
      const run = async (simple = true) => {
        const selected = ctx.modelRegistry.find(model.provider, model.id);
        const request = await ctx.modelRegistry.runtime.prepareRequest(selected, { onPayload: p => ({ ...p, hook: true }) });
        for await (const _event of request.provider[simple ? 'streamSimple' : 'stream'](request.model, { messages: [] }, request.options)) {}
      };
      await run();
      await adapter.refresh({ nonce: 'refresh', env: {}, aliases: [] }, ctx, new Set());
      await run(false);
      const retained = ctx.modelRegistry.getRegisteredProviderConfig(model.provider) === savedConfig;
      pi.registerProvider(Object.freeze(new OriginalProvider('native')));
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      await run();
      await adapter.refresh({ nonce: 'native', env: {}, aliases: [] }, ctx, new Set());
      await run(false);
      pi.registerProvider(Object.freeze(new OriginalProvider('later')));
      await adapter.refresh({ nonce: 'next', env: {}, aliases: [] }, ctx, new Set());
      await run();
      const later = ctx.modelRegistry.getRegisteredNativeProvider(model.provider).name === 'Fixture';
      pi.unregisterProvider(model.provider);
      await adapter.refresh({ nonce: 'removed', env: {}, aliases: [] }, ctx, new Set());
      const removed = !ctx.modelRegistry.getRegisteredNativeProvider(model.provider)
        && !ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
      writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({ calls, wraps, retained, later, removed }));
      process.exit(0);
    } catch(error) { writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({ error: String(error), stack: error.stack })); process.exit(1); }
  });
}
`;
    try {
      writeFileSync(extension, probe.replace('PRODUCTION_ADAPTER', PI_NATIVE_PROVIDER_ADAPTER_SOURCE));
      const child = spawnSync(binary, ['--mode', 'rpc', '--no-extensions', '-e', extension, '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools'], {
        cwd: root, input: '', timeout: 20000, encoding: 'utf8',
        env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1', CINDY_PI_NATIVE_PROVIDER_ADAPTERS: '[]', FIXTURE_KEY: 'fixture-key', FIXTURE_OUTPUT: output },
      });
      const result = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { stderr: child.stderr, error: child.error?.message };
      expect({ status: child.status, error: result.error }).toEqual({ status: 0, error: undefined });
      expect(result).toMatchObject({ retained: true, later: true, removed: true, wraps: 5 });
      expect(result.calls.map((call: any) => call.name)).toEqual(['config', 'config', 'native:simple', 'native:full', 'later:simple']);
      for (const call of result.calls) {
        expect(call.apiKey).toBe('fixture-key');
        expect(call.payload).toEqual({ custom_serializer: call.name, model: 'fixture', hook: true });
      }
      for (const call of result.calls.slice(0,2)) expect(call.headers).toMatchObject({ 'x-provider': 'provider-header', 'x-model': 'model-header' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('merges learning from two official Pi processes sharing one execution-side store', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-cache-concurrent-'));
    const storeFile = path.join(root, 'compat.json');
    const handles: AgentSessionHandle[] = [];
    const successful: Array<() => void> = [];
    const requests = new Map<string, number>();
    const gateway = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      const route = req.url!;
      requests.set(route, (requests.get(route) ?? 0) + 1);
      if ('prompt_cache_key' in payload || 'prompt_cache_retention' in payload) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'opaque refusal', type: 'invalid_request_error' } }));
        return;
      }
      // Both native processes finish the contrast together, before either can
      // learn from the other's file. This complements the exact rename barrier.
      successful.push(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(responses()); });
      if (successful.length === 2) for (const finish of successful) finish();
    });
    try {
      await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
      const address = gateway.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
      await Promise.all(['a', 'b'].map(async id => {
        const workingDir = path.join(root, 'work-' + id); mkdirSync(workingDir);
        const deps: AgentDeps = {
          binaryPath: binary, logger,
          auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
          runtimeConfig: { endpoint: 'http://127.0.0.1:0' },
          resolvePiAgentHome: () => path.join(root, 'agent-' + id),
          resolvePiNativeCompatStorePath: () => storeFile,
          resolvePiNativeProviders: async () => ({ providers: [{ id, sourceProviderId: id, name: id,
            apiKeyEnvVar: 'CINDY_PI_KEY_FIXTURE', baseUrl: 'http://127.0.0.1:' + address.port + '/' + id + '/api.openai.com/v1',
            api: 'openai-responses', models: [{ id: 'fixture', contextWindow: 32768, maxTokens: 100 }] }],
            env: { CINDY_PI_KEY_FIXTURE: 'fixture-key' } }),
          preparePiExtraSpawnConfig: async () => ({ mcpEnv: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'xdg') } }),
        };
        const handle = await new PiAgent(deps).startSession({ workingDir, sessionId: id,
          model: 'fixture', providerId: id, permissionMode: 'bypassPermissions' });
        handles.push(handle);
        const events: AgentEvent[] = [];
        const finish = (async () => { for await (const event of handle.events()) { events.push(event); if (event.type === 'done') break; } })();
        await handle.send({ type: 'user', content: 'Reply OK' });
        await finish;
        expect(events.filter(event => event.type === 'done')).toHaveLength(1);
        expect(events.some(event => event.type === 'error')).toBe(false);
      }));
      await vi.waitFor(() => expect(Object.keys(JSON.parse(readFileSync(storeFile, 'utf8')).routes)).toHaveLength(2));
      const routes = JSON.parse(readFileSync(storeFile, 'utf8')).routes;
      expect(Object.keys(routes).map(key => JSON.parse(key)[0]).sort()).toEqual(['a', 'b']);
      expect([...requests.values()]).toEqual([2, 2]);
    } finally {
      gateway.closeAllConnections();
      await Promise.all(handles.map(handle => handle.close()));
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it.each(['openai-completions', 'openai-responses'].flatMap(api => [
    { api, mode: 'opaque', rejection: { error: { message: 'opaque refusal', type: 'invalid_request_error', param: null } } },
    { api, mode: 'explicit', rejection: { message: '未知请求字段：prompt_cache_retention', type: 'invalid_request_error' } },
    { api, mode: 'always-fails', rejection: { message: 'Validation: Unsupported parameter(s): prompt_cache_key', type: 'invalid_request_error' } },
    { api, mode: 'supported', rejection: {} },
    // #7561: actual followUp start has no second agent_start. Exercise the
    // public send queue and outgoing HTTP, beyond the unit lifecycle fixture.
    { api, mode: 'queued', rejection: { error: { message: 'opaque refusal', type: 'invalid_request_error' } } },
    { api, mode: 'steer', rejection: { error: { message: 'opaque refusal', type: 'invalid_request_error' } } },
    { api, mode: 'mixed', rejection: { error: { message: 'opaque refusal', type: 'invalid_request_error' } } },
  ]))('preserves bounded recovery and native caching: $api / $mode', async ({ api, mode, rejection }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-cache-integration-'));
    const received: Array<Record<string, unknown>> = [];
    let rejectCache = mode !== 'supported';
    let persistentFailure = mode === 'always-fails';
    let firstArrived!: () => void;
    const firstRequest = new Promise<void>(resolve => { firstArrived = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    const gateway = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer fixture-key');
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); received.push(data);
      const held = ['queued', 'steer', 'mixed'].includes(mode) && received.length === 1;
      if (held) { firstArrived(); await firstReleased; }
      const successfulSteer = mode === 'mixed' && received.length === 2;
      if (!held && !successfulSteer && (persistentFailure || rejectCache && ('prompt_cache_key' in data || 'prompt_cache_retention' in data))) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(rejection)); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(api === 'openai-responses' ? responses() : 'data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n' + 'data: [DONE]\n\n');
    });
    let handle: AgentSessionHandle | undefined;
    try {
      await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
      const address = gateway.address(); if (!address || typeof address === 'string') throw new Error('missing loopback listener');
      let endpoint = 'http://127.0.0.1:' + address.port + '/api.openai.com/v1';
      const storeFile = path.join(root, 'compat.json');
      const deps: AgentDeps = {
        binaryPath: binary, logger,
        auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
        runtimeConfig: { endpoint: 'http://127.0.0.1:0' },
        resolvePiAgentHome: () => path.join(root, 'agent'),
        resolvePiNativeCompatStorePath: () => storeFile,
        resolvePiNativeProviders: async () => ({ providers: [{ id: 'strict', sourceProviderId: 'strict', name: 'Strict fixture', apiKeyEnvVar: 'CINDY_PI_KEY_FIXTURE', baseUrl: endpoint, api: api as 'openai-completions' | 'openai-responses', modelIdAliases: { 'fixture-alias': 'fixture-public' }, models: [{ id: 'fixture-public', wireId: 'fixture', api: api as 'openai-completions' | 'openai-responses', contextWindow: 32768, maxTokens: 100 }] }], env: { CINDY_PI_KEY_FIXTURE: 'fixture-key' } }),
        preparePiExtraSpawnConfig: async () => ({ mcpEnv: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'xdg') } }),
      };
      const workingDir = path.join(root, 'work'); mkdirSync(workingDir);
      const opts = { workingDir, model: 'fixture-alias', providerId: 'strict', permissionMode: 'bypassPermissions' as const };
      const run = async () => {
        const events: AgentEvent[] = [];
        const finish = (async () => { for await (const event of handle!.events()) { events.push(event); if (event.type === 'done') break; } })();
        await handle!.send({ type: 'user', content: 'Reply OK' });
        if (['queued', 'steer', 'mixed'].includes(mode) && received.length <= 1) {
          await firstRequest;
          if (mode !== 'steer') await handle!.send({ type: 'user', content: 'Reply OK to the queued message' });
          if (mode !== 'queued') await handle!.steer({ type: 'user', content: 'Reply OK to the inserted steer' });
          releaseFirst();
        }
        await finish; return events;
      };
      const agent = new PiAgent(deps);
      handle = await agent.startSession({ ...opts, sessionId: 'first' });
      const first = await run();
      expect(received).toHaveLength(mode === 'supported' ? 1 : mode === 'queued' ? 3 : mode === 'mixed' ? 4 : 2);
      expect(received[0]).toHaveProperty('prompt_cache_key');
      expect(received[0]).toHaveProperty('prompt_cache_retention', '24h');
      if (mode !== 'supported' && mode !== 'steer') {
        const original = mode === 'queued' ? 1 : mode === 'mixed' ? 2 : 0;
        expect(received[original]).toHaveProperty('prompt_cache_retention', '24h');
        const { prompt_cache_key: _key, prompt_cache_retention: _retention, ...without } = received[original];
        expect(received[original + 1]).toEqual(without);
      }
      expect(first.filter(e => e.type === 'done')).toHaveLength(1);
      const sessions = path.join(root, 'agent', 'sessions');
      const transcripts = readdirSync(sessions, { recursive: true }).map(name => path.join(sessions, name.toString())).filter(name => name.endsWith('.jsonl'));
      const entries = transcripts.flatMap(name => readFileSync(name, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
      const userInputs = mode === 'mixed' ? 3 : ['queued', 'steer'].includes(mode) ? 2 : 1;
      expect(entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user')).toHaveLength(userInputs);
      expect(entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant')).toHaveLength(userInputs);
      if (mode === 'always-fails' || mode === 'steer') {
        expect(first.filter(e => e.type === 'error')).toHaveLength(1);
        expect(first.find(e => e.type === 'error')?.data).toMatchObject({ piCacheRecoveryHandled: true });
        expect(existsSync(storeFile)).toBe(false);
        persistentFailure = false; rejectCache = false;
        await run(); expect(received).toHaveLength(3);
        expect(received[2]).toHaveProperty('prompt_cache_key');
        return;
      }
      expect(first.some(e => e.type === 'error')).toBe(false);
      expect(first.find(e => e.type === 'done')?.data).toMatchObject({ result: 'OK' });
      if (mode === 'supported') { expect(existsSync(storeFile)).toBe(false); return; }
      const store = JSON.parse(readFileSync(storeFile, 'utf8'));
      const records = Object.values(store.routes) as Array<{ learnedAt: number; expiresAt: number; evidence: string }>;
      expect(records).toHaveLength(1);
      expect(records[0].expiresAt - records[0].learnedAt).toBe((mode === 'explicit' ? 7 : 1) * 86400000);
      expect(readFileSync(storeFile, 'utf8')).not.toContain(endpoint);
      if (mode === 'queued' || mode === 'mixed') return;
      await handle.close(); handle = await agent.startSession({ ...opts, sessionId: 'learned' });
      await run(); expect(received).toHaveLength(3); expect(received[2]).not.toHaveProperty('prompt_cache_key');
      // The same running Pi must restore real fields when its rule expires.
      records[0].expiresAt = Date.now() - 1;
      writeFileSync(storeFile, JSON.stringify(store)); rejectCache = false;
      await run(); expect(received).toHaveLength(4); expect(received[3]).toHaveProperty('prompt_cache_key');
      await handle.close(); endpoint += '/other';
      handle = await agent.startSession({ ...opts, sessionId: 'other-route' });
      await run(); expect(received[4]).toHaveProperty('prompt_cache_retention', '24h');
    } finally {
      releaseFirst();
      await handle?.close(); gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

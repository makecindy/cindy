import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';
import { nativeProviderAdapterAliases, PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../native-provider-adapter-source.js';

type RegisteredProvider = { id: string; auth: { apiKey?: unknown; oauth?: unknown }; getModels: () => unknown[]; filterModels?: () => unknown;
  streamSimple(model: unknown, context: unknown, options: unknown): Promise<unknown> | AsyncIterable<unknown> };

type Alias = { id: string; name: string; provider: string; keyEnv?: string; remoteProviderId?: string; models?: Array<{ id: string; grant: string }> };

function loadAdapter(initialAliases: Alias[] = [], network?: { fetch: unknown; stream: RegisteredProvider['streamSimple']; guest?: boolean }) {
  const env: Record<string, string> = {
    CINDY_PI_NATIVE_PROVIDER_ADAPTERS: JSON.stringify(initialAliases),
    CINDY_PI_KEY_OLD: 'old-secret',
    CINDY_PI_OPENAI_PROXY_KEY: 'old-proxy-secret',
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const providers = new Map<string, RegisteredProvider>();
  const actions: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(name, handler); },
    registerProvider(provider: RegisteredProvider) {
      // Pi's native object registration dereferences auth even for host-authenticated proxies.
      void provider.auth.oauth;
      void provider.auth.apiKey;
      actions.push(`register:${provider.id}`);
      providers.set(provider.id, provider);
    },
    unregisterProvider(id: string) { actions.push(`unregister:${id}`); providers.delete(id); },
  };
  let models: Array<{ provider: string; id: string }> = initialAliases.flatMap((alias) => alias.models
    ? ['allowed', 'denied'].map(id => ({ provider: alias.id, id })) : [{ provider: alias.id, id: 'old' }]);
  let nextModels = models;
  const ctx = {
    modelRegistry: {
      runtime: { async prepareRequest(model: any, options: any) { return { model, options, provider: ctx.modelRegistry.getProvider(model.provider) }; } },
      getAll: () => models,
      getRegisteredNativeProvider: (id: string) => providers.get(id),
      getProvider: (id: string) => providers.get(id) ?? ({ id, name: id, auth: { apiKey: 'preserved-auth' },
        getModels: () => models.filter(model => model.provider === id),
        filterModels: () => [], stream: network?.stream, streamSimple: network?.stream ?? (async function* () {}) }),
      async refresh(options: { allowNetwork?: boolean }) {
        expect(options).toEqual({ allowNetwork: false });
        actions.push('refresh');
        models = nextModels;
        return { aborted: false, errors: new Map() };
      },
    },
  };
  const source = PI_NATIVE_PROVIDER_ADAPTER_SOURCE.replaceAll('import(', '__loadPiAi(');
  const compiled = ts.transpileModule(source + '\n(globalThis as any).adapter = { parseCindyProviderRefreshSnapshot, registerCindyNativeProviderAdapters };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const sandbox: Record<string, unknown> = {
    process: { env },
    CINDY_HOSTED: { guest: network?.guest ?? true, url: 'http://127.0.0.1:9', token: 'run-token' },
    fetch: network?.fetch, AbortSignal,
    __loadPiAi: async (name: string) => name.endsWith('/compat')
      ? { getApiProvider: () => network ? { stream: network.stream, streamSimple: network.stream } : undefined }
      : { lazyStream: network ? (_model: unknown, factory: () => unknown) => factory() : () => undefined,
        envApiKeyAuth: (label: string, envVars: string[]) => ({ label, envVars }) },
  };
  runInNewContext(compiled, sandbox);
  const adapter = sandbox.adapter as {
    parseCindyProviderRefreshSnapshot: (raw: unknown, nonce: string) => {
      nonce: string; env: Record<string, string>; aliases: Alias[];
    } | undefined;
    registerCindyNativeProviderAdapters: (pi: unknown, cacheRecovery?: unknown) => Promise<{
      refresh: (snapshot: { nonce: string; env: Record<string, string>; aliases: Alias[] }, ctx: unknown, secrets: Set<string>) => Promise<void>;
    }>;
  };
  return { adapter, env, pi, ctx, handlers, providers, actions, setModels: (value: typeof models) => { nextModels = value; } };
}

describe('Cindy native provider refresh bridge', () => {
  it('wraps only managed cache routes and keeps the native serializer and payload hook', async () => {
    const stream = vi.fn(async function* () {});
    const h = loadAdapter([], { fetch: vi.fn(), stream });
    h.setModels([{ provider: 'managed', id: 'wire' }, { provider: 'extension-owned', id: 'other' }]);
    await h.ctx.modelRegistry.refresh({ allowNetwork: false });
    const wrap = vi.fn((model, options, invoke) => invoke(options));
    await h.adapter.registerCindyNativeProviderAdapters(h.pi, { accepts: (model: any) => model.provider === 'managed', wrap, ownRegistry: vi.fn() });
    await h.handlers.get('session_start')!({}, h.ctx);
    expect([...h.providers.keys()]).toEqual([]);
    const model = { provider: 'managed', id: 'wire', api: 'openai-responses' };
    const options = { apiKey: 'fixture-key', onPayload: vi.fn() };
    const prepared = await h.ctx.modelRegistry.runtime.prepareRequest(model, options);
    expect(prepared.provider.auth).toEqual({ apiKey: 'preserved-auth' });
    await prepared.provider.streamSimple(prepared.model, { messages: [] }, prepared.options);
    expect(wrap).toHaveBeenCalledWith(model, options, expect.any(Function), 'managed');
    expect(stream).toHaveBeenCalledWith(model, { messages: [] }, options);
  });
  it.each(['original', 'newer', 'removed'])('preserves extension provider ownership across catalog refresh: %s', async owner => {
    const fallbackStream = vi.fn(async function* () {});
    const h = loadAdapter([], { fetch: vi.fn(), stream: fallbackStream });
    const models = [{ provider: 'managed', id: 'wire' }];
    h.setModels(models);
    await h.ctx.modelRegistry.refresh({ allowNetwork: false });
    const provider = (name: string) => ({ id: 'managed', name, auth: { apiKey: name },
      getModels: () => models, filterModels: vi.fn(),
      stream: vi.fn(async function* () {}), streamSimple: vi.fn(async function* () {}) });
    const original = provider('original-extension');
    const replacement = provider('newer-extension');
    h.pi.registerProvider(original);
    const adapter = await h.adapter.registerCindyNativeProviderAdapters(h.pi, { accepts: () => true, ownRegistry: vi.fn(),
      wrap: (_model: unknown, options: unknown, invoke: any) => invoke(options) });
    await h.handlers.get('session_start')!({}, h.ctx);
    if (owner === 'newer') h.pi.registerProvider(replacement);
    if (owner === 'removed') h.pi.unregisterProvider('managed');
    await adapter.refresh({ nonce: 'refresh', env: {}, aliases: [] }, h.ctx, new Set());
    const current = (await h.ctx.modelRegistry.runtime.prepareRequest({ provider: 'managed', id: 'wire', api: 'openai-responses' }, {})).provider;
    if (owner === 'removed') {
      expect(current.auth).toEqual({ apiKey: 'preserved-auth' });
      expect(original.streamSimple).not.toHaveBeenCalled();
      return;
    }
    const expected = owner === 'newer' ? replacement : original;
    expect(current.auth).toBe(expected.auth);
    current.filterModels!();
    expect(expected.filterModels).toHaveBeenCalledOnce();
    await current.streamSimple({ provider: 'managed', id: 'wire', api: 'openai-responses' }, { messages: [] }, {});
    expect(expected.streamSimple).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });
  it.each(['getProvider', 'getRegisteredNativeProvider'])('leaves an older runtime provider intact without %s', async missing => {
    const h = loadAdapter();
    h.setModels([{ provider: 'managed', id: 'wire' }]);
    await h.ctx.modelRegistry.refresh({ allowNetwork: false });
    (h.ctx.modelRegistry as any)[missing] = undefined;
    await h.adapter.registerCindyNativeProviderAdapters(h.pi, { accepts: () => true, ownRegistry: vi.fn() });
    await h.handlers.get('session_start')!({}, h.ctx);
    expect(h.providers.size).toBe(0);
  });
  // Review 4333949156 / sharing §12, unit: existing native-stream coverage only
  // used guest=true. An owner-hosted BYOM provider must also query its real source
  // before the SDK, including after refresh; revoked/failed checks cannot stream.
  it.each([undefined, 'native'] as const)('checks owner native streams with adapter=%s at startup and after refresh', async adapterProvider => {
    const aliases = nativeProviderAdapterAliases([{ id: 'runtime', sourceProviderId: 'catalog-provider',
      name: 'BYOM', adapterProvider, models: [{ id: 'old' }],
    }], undefined, true);
    let allowed = true;
    const fetchGrant = vi.fn(async () => ({ ok: true, json: async () => ({ allowed }) }));
    const stream = vi.fn(async function* () {});
    const h = loadAdapter(aliases, { fetch: fetchGrant, stream, guest: false });
    const adapter = await h.adapter.registerCindyNativeProviderAdapters(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    expect(h.providers.has('runtime')).toBe(true);
    const request = () => h.providers.get('runtime')!.streamSimple({ provider: 'runtime', id: 'old', api: 'openai-responses' }, { messages: [] }, {});
    await request();
    expect(fetchGrant).toHaveBeenCalledWith('http://127.0.0.1:9/cindy/model-access', expect.objectContaining({
      body: JSON.stringify({ model: 'old', providerId: 'catalog-provider' }),
    }));
    expect(stream).toHaveBeenCalledTimes(1);
    const snapshot = h.adapter.parseCindyProviderRefreshSnapshot(JSON.stringify({ nonce: 'abcdefghijklmnop', env: {}, aliases }), 'abcdefghijklmnop')!;
    await adapter.refresh(snapshot, h.ctx, new Set());
    allowed = false;
    await expect(request()).rejects.toThrow('not authorized');
    fetchGrant.mockResolvedValueOnce({ ok: true, json: async () => ({ allowed: false, code: 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED' }) });
    await expect(request()).rejects.toThrow('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]');
    fetchGrant.mockRejectedValueOnce(new Error('disconnected'));
    await expect(request()).rejects.toThrow('disconnected');
    expect(stream).toHaveBeenCalledTimes(1);
  });
  // Unit, sharing §12: Pi API-key transports bypass the HTTP proxy. The existing
  // refresh tests never opened a native stream. Execute the generated adapter:
  // only A is listed; revocation/failure must stop before the native SDK opens.
  it('filters inherited models and authorizes each guest native stream before calling the SDK', async () => {
    let allowed = true;
    const fetchGrant = vi.fn(async () => ({ ok: true, json: async () => ({ allowed }) }));
    const stream = vi.fn(async function* () {});
    const h = loadAdapter([{ id: 'byok', name: 'BYOK', provider: 'native', models: [{ id: 'allowed', grant: 'catalog-a' }] }],
      { fetch: fetchGrant, stream });
    const adapter = await h.adapter.registerCindyNativeProviderAdapters(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    const provider = h.providers.get('byok')!;
    expect(provider.getModels()).toEqual([{ provider: 'byok', id: 'allowed' }]);
    const request = (id = 'allowed') => provider.streamSimple({ provider: 'byok', id, api: 'openai-responses' }, { messages: [] }, {});
    await request();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(fetchGrant).toHaveBeenCalledWith('http://127.0.0.1:9/cindy/model-access', expect.objectContaining({
      headers: { Authorization: 'Bearer run-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'catalog-a' }),
    }));
    allowed = false;
    await expect(request()).rejects.toThrow('not authorized');
    await expect(request('denied')).rejects.toThrow('not authorized');
    fetchGrant.mockRejectedValueOnce(new Error('disconnected'));
    await expect(request()).rejects.toThrow('disconnected');
    await adapter.refresh({ nonce: 'abcdefghijklmnop', env: {}, aliases: [{ id: 'byok', name: 'BYOK', provider: 'native', models: [] }] }, h.ctx, new Set());
    expect(h.providers.get('byok')!.getModels()).toEqual([]);
    await expect(h.providers.get('byok')!.streamSimple({ id: 'allowed' }, { messages: [] }, {})).rejects.toThrow('not authorized');
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it('validates the entire nonce-bound snapshot before any env or provider mutation', () => {
    const { adapter } = loadAdapter();
    const nonce = 'abcdefghijklmnop';
    const valid = { nonce, env: { CINDY_PI_KEY_NEW: 'secret', CINDY_PI_SESSION_TOKEN: 'token' }, aliases: [
      { id: 'custom:xai', name: 'xAI', provider: 'xai', keyEnv: 'CINDY_PI_KEY_NEW' },
    ] };
    expect(adapter.parseCindyProviderRefreshSnapshot(JSON.stringify(valid), nonce)?.aliases).toEqual(valid.aliases);
    expect(adapter.parseCindyProviderRefreshSnapshot(JSON.stringify({ ...valid, nonce: 'other' }), nonce)).toBeUndefined();
    expect(adapter.parseCindyProviderRefreshSnapshot(JSON.stringify({ ...valid, env: { OPENAI_API_KEY: 'secret' } }), nonce)).toBeUndefined();
    expect(adapter.parseCindyProviderRefreshSnapshot(JSON.stringify({ ...valid, aliases: [
      { ...valid.aliases[0], keyEnv: 'OPENAI_API_KEY' },
    ] }), nonce)).toBeUndefined();
    expect(adapter.parseCindyProviderRefreshSnapshot(JSON.stringify({ ...valid, aliases: [
      { ...valid.aliases[0], keyEnv: 'CINDY_PI_OPENAI_PROXY_KEY' },
    ] }), nonce)).toBeUndefined();
  });

  it('replaces only adapters it registered and refreshes models without clearing extension state', async () => {
    const old = { id: 'old', name: 'Old', provider: 'anthropic', keyEnv: 'CINDY_PI_KEY_OLD' };
    const next = { id: 'next', name: 'Next', provider: 'openai', keyEnv: 'CINDY_PI_KEY_NEXT' };
    const h = loadAdapter([old]);
    const controller = await h.adapter.registerCindyNativeProviderAdapters(h.pi);
    h.handlers.get('session_start')?.({}, h.ctx);
    h.providers.set('package-owned', { id: 'package-owned', auth: {}, getModels: () => [], streamSimple: async () => undefined });
    h.setModels([{ provider: 'next', id: 'new-model' }]);
    const secrets = new Set(['CINDY_PI_KEY_OLD']);
    await controller.refresh({ nonce: 'abcdefghijklmnop', env: { CINDY_PI_KEY_NEXT: 'next-secret' }, aliases: [next] }, h.ctx, secrets);
    expect(h.actions).toEqual(['register:old', 'unregister:old', 'refresh', 'register:next', 'refresh']);
    expect([...h.providers.keys()]).toEqual(['package-owned', 'next']);
    expect(h.env.CINDY_PI_KEY_OLD).toBeUndefined();
    expect(h.env.CINDY_PI_KEY_NEXT).toBe('next-secret');
    expect([...secrets]).toEqual(['CINDY_PI_KEY_NEXT']);
    expect(h.handlers.size).toBe(1);
  });

  // #6454: existing refresh coverage only used API-key aliases. Execute the generated
  // production extension (unit tier) with the minimal missing-keyEnv input, then
  // transition both ways without losing the refreshed model or key resolver.
  it('registers proxy-authenticated providers at startup and after changing auth routes', async () => {
    const proxy = { id: 'minimax-oauth', name: 'MiniMax', provider: 'minimax-cn' };
    const keyed = { id: 'minimax-key', name: 'MiniMax key', provider: 'minimax-cn', keyEnv: 'CINDY_PI_KEY_NEXT' };
    const h = loadAdapter([proxy]);
    const controller = await h.adapter.registerCindyNativeProviderAdapters(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    expect(h.providers.get(proxy.id)?.auth).toEqual({});
    expect(h.providers.get(proxy.id)?.getModels()).toEqual([{ provider: proxy.id, id: 'old' }]);

    const secrets = new Set<string>();
    h.setModels([{ provider: keyed.id, id: 'keyed-model' }]);
    await controller.refresh({ nonce: 'abcdefghijklmnop', env: { CINDY_PI_KEY_NEXT: 'fixture-key' }, aliases: [keyed] }, h.ctx, secrets);
    expect(h.providers.has(proxy.id)).toBe(false);
    expect(h.providers.get(keyed.id)?.auth.apiKey).toEqual({ label: 'API key', envVars: ['CINDY_PI_KEY_NEXT'] });

    h.setModels([{ provider: proxy.id, id: 'MiniMax-M3' }]);
    await controller.refresh({ nonce: 'qrstuvwxyzabcdef', env: {}, aliases: [proxy] }, h.ctx, secrets);
    expect([...h.providers.keys()]).toEqual([proxy.id]);
    expect(h.providers.get(proxy.id)?.auth).toEqual({});
    expect(h.providers.get(proxy.id)?.getModels()).toEqual([{ provider: proxy.id, id: 'MiniMax-M3' }]);
    expect(h.env.CINDY_PI_KEY_NEXT).toBeUndefined();
    expect(secrets.size).toBe(0);
  });

  it.each([
    ['missing', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, {}],
    ['configured', () => JSON.stringify({ compaction: { reserveTokens: 1234 } }), { compaction: { reserveTokens: 1234 } }],
  ])('loads legacy runtime settings when the file is %s', (_label, read, expected) => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const start = source.indexOf('const initialNativeSettings =');
    const end = source.indexOf("pi.registerCommand('cindy-native-provider-refresh'", start);
    const code = source.slice(start, end) + ';globalThis.settings = initialNativeSettings;';
    const sandbox: Record<string, unknown> = {
      pi: {}, process: { env: { PI_CODING_AGENT_DIR: '/fixture' } },
      path: { join: () => '/fixture/settings.json' }, readFileSync: read,
    };
    runInNewContext(code, sandbox);
    expect(sandbox.settings).toEqual(expected);
  });

  it.each(['EACCES', 'invalid-json'])('does not hide %s while loading legacy settings', (kind) => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const start = source.indexOf('const initialNativeSettings =');
    const end = source.indexOf("pi.registerCommand('cindy-native-provider-refresh'", start);
    expect(() => runInNewContext(source.slice(start, end), {
      pi: {}, process: { env: { PI_CODING_AGENT_DIR: '/fixture' } },
      path: { join: () => '/fixture/settings.json' },
      readFileSync: () => {
        if (kind === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return '{';
      },
    })).toThrow();
  });

  it('acknowledges success only after applying a valid staged snapshot', async () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const start = source.indexOf('const initialNativeSettings =');
    const end = source.indexOf('if (!currentPermissionState().reviewOnly)', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(
      `async function setup(pi: any, nativeProviderAdapters: any, parseCindyProviderRefreshSnapshot: any) {\nconst SECRET_ENV_NAMES = new Set<string>();\n${source.slice(start, end)}\n}\n(globalThis as any).setup = setup;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const sandbox: Record<string, unknown> = { piCodingAgent: { VERSION: '1.0.0' },
      process: { env: { PI_CODING_AGENT_DIR: '/fixture' } }, path: { join: () => '/fixture/settings.json' },
      readFileSync: () => JSON.stringify({ compaction: { reserveTokens: 1234 } }),
    };
    runInNewContext(code, sandbox);
    const setup = sandbox.setup as (
      pi: unknown, controller: unknown, parse: (raw: unknown, nonce: string) => unknown,
    ) => Promise<void>;
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const applied: unknown[] = [];
    let loaded = false;
    await setup({ getSettings: () => {
      if (!loaded) throw new Error('Action methods cannot be called during extension loading');
      return { compaction: { reserveTokens: 1234 } };
    },
      registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } },
      { refresh: async (snapshot: unknown) => { applied.push(snapshot); } },
      (raw, nonce) => raw === 'valid' ? { nonce, env: {}, aliases: [] } : undefined);
    loaded = true;
    const calls: Array<{ title: string; payload: unknown }> = [];
    const ctx = { ui: { input: async (title: string, raw: string) => {
      const payload = JSON.parse(raw) as unknown;
      calls.push({ title, payload });
      return title === 'cindy:provider-refresh' ? 'valid' : undefined;
    } } };
    await handler?.('abcdefghijklmnop', ctx);
    expect(applied).toHaveLength(1);
    expect(calls).toEqual([
      { title: 'cindy:provider-refresh', payload: { nonce: 'abcdefghijklmnop' } },
      { title: 'cindy:provider-refresh-ack', payload: { nonce: 'abcdefghijklmnop', ok: true,
        runtimeSettings: { version: '1.0.0', compaction: { reserveTokens: 1234 } } } },
    ]);
    calls.length = 0;
    await handler?.('abcdefghijklmnop', { ui: { input: async (title: string, raw: string) => {
      calls.push({ title, payload: JSON.parse(raw) });
      return title === 'cindy:provider-refresh'
        ? JSON.stringify({ nonce: 'abcdefghijklmnop', operation: 'inspect' }) : undefined;
    } } });
    expect(applied).toHaveLength(1); // Inspection never refreshes providers or credentials.
    expect(calls.at(-1)?.payload).toMatchObject({ ok: true, runtimeSettings: { version: '1.0.0' } });
  });
});

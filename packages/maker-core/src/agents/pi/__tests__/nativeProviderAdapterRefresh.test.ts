import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';
import { PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../native-provider-adapter-source.js';

type Alias = { id: string; name: string; provider: string; keyEnv?: string };

function loadAdapter(initialAliases: Alias[] = []) {
  const env: Record<string, string> = {
    CINDY_PI_NATIVE_PROVIDER_ADAPTERS: JSON.stringify(initialAliases),
    CINDY_PI_KEY_OLD: 'old-secret',
    CINDY_PI_OPENAI_PROXY_KEY: 'old-proxy-secret',
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const providers = new Map<string, unknown>();
  const actions: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(name, handler); },
    registerProvider(provider: { id: string }) { actions.push(`register:${provider.id}`); providers.set(provider.id, provider); },
    unregisterProvider(id: string) { actions.push(`unregister:${id}`); providers.delete(id); },
  };
  let models: Array<{ provider: string; id: string }> = initialAliases.map((alias) => ({ provider: alias.id, id: 'old' }));
  let nextModels = models;
  const ctx = {
    modelRegistry: {
      getAll: () => models,
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
    __loadPiAi: async (name: string) => name.endsWith('/compat')
      ? { getApiProvider: () => undefined }
      : { lazyStream: () => undefined, envApiKeyAuth: () => undefined },
  };
  runInNewContext(compiled, sandbox);
  const adapter = sandbox.adapter as {
    parseCindyProviderRefreshSnapshot: (raw: unknown, nonce: string) => {
      nonce: string; env: Record<string, string>; aliases: Alias[];
    } | undefined;
    registerCindyNativeProviderAdapters: (pi: unknown) => Promise<{
      refresh: (snapshot: { nonce: string; env: Record<string, string>; aliases: Alias[] }, ctx: unknown, secrets: Set<string>) => Promise<void>;
    }>;
  };
  return { adapter, env, pi, ctx, handlers, providers, actions, setModels: (value: typeof models) => { nextModels = value; } };
}

describe('Cindy native provider refresh bridge', () => {
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
    h.providers.set('package-owned', { id: 'package-owned' });
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

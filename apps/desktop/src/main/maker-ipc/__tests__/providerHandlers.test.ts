import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type { CustomProviderConfig, ProviderView } from '@cindy/model-providers';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { listCustomProviders } from '../../maker-host/custom-provider-store.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerProviderHandlers, type ProviderHandlerDeps } from '../providerHandlers.js';
import { IpcHarness } from './helpers/ipcHarness.js';

/** 最小 ProviderView 桩（只放断言要用的字段；handler 不解读结构，原样透传）。 */
function fakeView(id: string, connected: boolean): ProviderView {
  return { id, connected } as unknown as ProviderView;
}

const CREATE_SQL = `
  CREATE TABLE custom_providers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, runtimes TEXT NOT NULL DEFAULT '{}',
    auth TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_custom_providers_sort_order ON custom_providers (sort_order);
`;

const validConfig: CustomProviderConfig = {
  id: 'openrouter',
  name: 'OpenRouter',
  runtimes: {
    codex: { baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'meta/llama-4', name: 'Llama 4' }] },
  },
};

let raw: Database.Database | null = null;
let client: DbClient | null = null;

function mountDb(): void {
  const dbHandle = new Database(':memory:');
  dbHandle.exec(CREATE_SQL);
  raw = dbHandle;
  client = {
    query: async () => [],
    queryOne: async () => undefined,
    exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
    tx: async () => {
      throw new Error('tx not used');
    },
    drizzle: drizzle(dbHandle, { schema }),
    vecAvailable: false,
    dispose: async () => {},
  };
  setCurrentDbClient(client, 'test-user');
}

function makeDeps(over: Partial<ProviderHandlerDeps> = {}): ProviderHandlerDeps {
  return {
    listProviders: async () => [],
    getModelVisibilityOverrides: () => ({}),
    refreshCatalog: vi.fn(async () => {}),
    broadcastChanged: vi.fn(() => {}),
    listPresets: () => [],
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    fetchModels: vi.fn(async () => ({ ok: true, models: [{ id: 'm1', name: 'M1' }] })),
    oauthLogin: vi.fn(async () => ({ ok: true })),
    oauthLogout: vi.fn(async () => {}),
    oauthCancel: vi.fn(() => {}),
    clearOAuthCredentials: vi.fn(() => {}),
    scanLocalCli: vi.fn(async () => []),
    ...over,
  };
}

afterEach(() => {
  if (client) clearCurrentDbClient(client);
  raw?.close();
  client = null;
  raw = null;
});

describe('provider:list IPC handler', () => {
  it('wraps the injected service result as { providers } + visibility overrides snapshot', async () => {
    const harness = new IpcHarness();
    const views = [fakeView('xd', true), fakeView('anthropic', false)];
    const listProviders = vi.fn(async () => views);
    const overrides = { 'claude-code:xd:claude-opus-4-8': false };
    registerProviderHandlers(
      harness,
      makeDeps({ listProviders, getModelVisibilityOverrides: () => overrides }),
    );

    const result = await harness.invoke(MAKER_INVOKE.PROVIDER_LIST);
    expect(result).toEqual({ providers: views, modelVisibilityOverrides: overrides });
    expect(listProviders).toHaveBeenCalledOnce();
  });

  it('propagates service errors to the caller', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        listProviders: async () => {
          throw new Error('boom');
        },
      }),
    );
    await expect(harness.invoke(MAKER_INVOKE.PROVIDER_LIST)).rejects.toThrow('boom');
  });
});

describe('provider:custom:* CRUD handlers', () => {
  it('creates a valid provider, persists it, refreshes + broadcasts', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    const res = await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);
    expect(res).toEqual({ ok: true });
    expect(await listCustomProviders()).toHaveLength(1);
    expect(deps.refreshCatalog).toHaveBeenCalledOnce();
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
  });

  it('rejects invalid config (bad id) with INVALID_PARAMS and does not write', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, { ...validConfig, id: 'Bad Id' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(await listCustomProviders()).toEqual([]);
    expect(deps.refreshCatalog).not.toHaveBeenCalled();
  });

  it('rejects duplicate id with ALREADY_EXISTS', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerProviderHandlers(harness, makeDeps());
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);
    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig),
    ).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it('updates an existing provider; missing id → NOT_FOUND', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);

    const upd = await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...validConfig,
      name: 'OR v2',
    });
    expect(upd).toEqual({ ok: true });
    expect((await listCustomProviders())[0].name).toBe('OR v2');

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, { ...validConfig, id: 'ghost' }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('deletes (idempotent) + broadcasts; bad providerId → INVALID_PARAMS', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);

    const del = await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, 'openrouter');
    expect(del).toEqual({ ok: true });
    expect(await listCustomProviders()).toEqual([]);

    await expect(harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, '')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });
});

describe('provider:presets handler', () => {
  it('returns injected presets as { presets }', async () => {
    const harness = new IpcHarness();
    const presets = [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        runtimes: { codex: { baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'a', name: 'A' }] } },
      },
    ];
    registerProviderHandlers(harness, makeDeps({ listPresets: () => presets }));
    expect(await harness.invoke(MAKER_INVOKE.PROVIDER_PRESETS_LIST)).toEqual({ presets });
  });
});

describe('provider:test-connection handler', () => {
  it('forwards parsed adhoc input and returns the structured result', async () => {
    const harness = new IpcHarness();
    const testConnection = vi.fn(async () => ({
      ok: false as const,
      code: 'AUTH_INVALID' as const,
      status: 401,
      latencyMs: 5,
    }));
    registerProviderHandlers(harness, makeDeps({ testConnection }));

    const result = await harness.invoke(MAKER_INVOKE.PROVIDER_TEST_CONNECTION, {
      kind: 'adhoc',
      spec: {
        agent: 'claude-code',
        baseUrl: 'https://x.example',
        modelId: 'm',
        requestPath: '/tenant/acme/infer?stream=1',
        apiKey: 'k',
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
    expect(testConnection).toHaveBeenCalledWith({
      kind: 'adhoc',
      spec: {
        agent: 'claude-code',
        baseUrl: 'https://x.example',
        modelId: 'm',
        wireProtocol: undefined,
        requestPath: '/tenant/acme/infer?stream=1',
        apiKey: 'k',
        headers: undefined,
      },
    });
  });

  it('rejects malformed input with INVALID_PARAMS (bad agent / bad url / missing model)', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);
    const bad = [
      null,
      { kind: 'adhoc', spec: { agent: 'gemini', baseUrl: 'https://x.example', modelId: 'm' } },
      { kind: 'adhoc', spec: { agent: 'codex', baseUrl: 'ftp://x', modelId: 'm' } },
      { kind: 'adhoc', spec: { agent: 'codex', baseUrl: 'https://x.example', modelId: '' } },
      {
        kind: 'adhoc',
        spec: {
          agent: 'codex',
          baseUrl: 'https://x.example',
          modelId: 'm',
          requestPath: '/unescaped path',
        },
      },
      { kind: 'saved', providerId: '', agent: 'codex' },
    ];
    for (const input of bad) {
      await expect(harness.invoke(MAKER_INVOKE.PROVIDER_TEST_CONNECTION, input)).rejects.toThrow(/INVALID_PARAMS/);
    }
    expect(deps.testConnection).not.toHaveBeenCalled();
  });

  it('maps saved-resolve errors (provider not found) to INVALID_PARAMS', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        testConnection: async () => {
          throw new Error("provider 'ghost' not found");
        },
      }),
    );
    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_TEST_CONNECTION, { kind: 'saved', providerId: 'ghost', agent: 'codex' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
  });
});

describe('provider:models-fetch handler', () => {
  it('forwards parsed input and returns the structured result', async () => {
    const harness = new IpcHarness();
    const fetchModels = vi.fn(async () => ({
      ok: true as const,
      models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
    }));
    registerProviderHandlers(harness, makeDeps({ fetchModels }));

    const result = await harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_FETCH, {
      agent: 'claude-code',
      baseUrl: 'https://x.example/anthropic',
      modelsUrl: 'https://x.example/v1/models',
      apiKey: 'k',
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: 'kimi-k3', name: 'Kimi K3' }] });
    expect(fetchModels).toHaveBeenCalledWith({
      agent: 'claude-code',
      baseUrl: 'https://x.example/anthropic',
      modelsUrl: 'https://x.example/v1/models',
      apiKey: 'k',
      headers: undefined,
    });
  });

  it('rejects malformed input with INVALID_PARAMS (bad agent / bad url / bad modelsUrl / bad headers)', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);
    const bad = [
      null,
      { agent: 'gemini', baseUrl: 'https://x.example' },
      { agent: 'codex', baseUrl: 'ftp://x' },
      { agent: 'codex', baseUrl: '' },
      { agent: 'codex', baseUrl: 'https://x.example', modelsUrl: 'not-a-url' },
      { agent: 'codex', baseUrl: 'https://x.example', headers: { a: 1 } },
    ];
    for (const input of bad) {
      await expect(harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_FETCH, input)).rejects.toThrow(/INVALID_PARAMS/);
    }
    expect(deps.fetchModels).not.toHaveBeenCalled();
  });
});

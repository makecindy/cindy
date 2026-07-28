import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type { AgentKind, CustomProviderConfig, ProviderView } from '@cindy/model-providers';

import { BUILTIN_REFRESHABLE_PROVIDER_IDS } from '../../../shared/providerModelRefresh.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { listCustomProviders } from '../../maker-host/custom-provider-store.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
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
    beginRouteMutation: vi.fn(() => () => {}),
    broadcastChanged: vi.fn(() => {}),
    listPresets: () => [],
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    fetchModels: vi.fn(async () => ({ ok: true, models: [{ id: 'm1', name: 'M1' }] })),
    rediscoverModels: vi.fn(async () => null),
    refreshBuiltinModels: vi.fn(async () => {}),
    requestModelsAutoRefresh: vi.fn(async () => {}),
    // 生产恒定接线（register.ts）。默认桩 = 已接线且信任，好让其余用例只关心自己的分支；
    // 「漏接线」是独立用例，显式不传这个 dep。
    assertTrustedSender: vi.fn(() => {}),
    oauthLogin: vi.fn(async () => ({ ok: true })),
    oauthLogout: vi.fn(async () => {}),
    oauthCancel: vi.fn(() => {}),
    removeOAuthCredentials: vi.fn(() => () => true),
    readCustomProviderKeyForMutation: vi.fn(() => null),
    storeCustomProviderKey: vi.fn(() => true),
    removeCustomProviderKey: vi.fn(() => ({ success: true })),
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

describe('provider:models-rediscover handler', () => {
  it('校验 sender 后才发起重新发现;不可信 sender 直接拒绝', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn(() => {
      throwIpcError('PERMISSION_DENIED', '此操作只能从 Cindy 主页面发起');
    });
    const deps = makeDeps({ assertTrustedSender });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, 'anthropic'),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    // 拒绝发生在任何上游动作之前:绝不让不可信 sender 触发带凭证的请求。
    expect(deps.rediscoverModels).not.toHaveBeenCalled();
  });

  it('守卫未接线时 fail-closed,不靠可选链静默放行', async () => {
    // 可选依赖漏接是没有任何信号的退化:`deps.assertTrustedSender?.()` 会让这条带凭证的
    // 通道退回无守卫状态。缺守卫即拒绝(PR #548 review)。
    const harness = new IpcHarness();
    const deps = makeDeps({ assertTrustedSender: undefined });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, 'anthropic'),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(deps.rediscoverModels).not.toHaveBeenCalled();
  });

  it('成功时返回 ok 且不重复广播(发现流程自己收口)', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, 'anthropic')).resolves.toEqual({
      ok: true,
    });
    expect(deps.rediscoverModels).toHaveBeenCalledWith('anthropic');
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('回传失败归因供 renderer 渲染分类文案,但剥掉 detail', async () => {
    const harness = new IpcHarness();
    // detail 可能是上游原始响应体:provider 列表那条路径已经剥了,这条独立的返回路径
    // 必须各自剥,否则等于开了第二个泄漏口。
    const failure = {
      kind: 'regionBlocked' as const,
      at: '2026-07-27T00:00:00.000Z',
      detail: 'HTTP 403: {"error":{"type":"unsupported_country_region_territory"}}',
    };
    registerProviderHandlers(harness, makeDeps({ rediscoverModels: vi.fn(async () => failure) }));

    const res = (await harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, 'anthropic')) as {
      ok: boolean;
      failure?: Record<string, unknown>;
    };
    expect(res).toEqual({ ok: false, failure: { kind: 'regionBlocked', at: failure.at } });
    expect(res.failure).not.toHaveProperty('detail');
  });

  it('意外异常转结构化 INTERNAL,不以裸 Error 漏给 renderer', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        rediscoverModels: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, 'anthropic'),
    ).rejects.toThrow(/INTERNAL/);
  });
});

describe('provider:models-refresh handler', () => {
  it('guards the sender, validates the built-in id, and forwards the refresh', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn();
    const refreshBuiltinModels = vi.fn(async () => {});
    registerProviderHandlers(
      harness,
      makeDeps({ assertTrustedSender, refreshBuiltinModels }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REFRESH, 'anthropic'),
    ).resolves.toEqual({ ok: true, providerId: 'anthropic' });
    expect(assertTrustedSender).toHaveBeenCalledOnce();
    expect(refreshBuiltinModels).toHaveBeenCalledWith('anthropic');
  });

  it('rejects unsupported ids before refreshing', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REFRESH, 'custom-provider'),
    ).rejects.toThrow(
      `[INVALID_PARAMS] providerId must be one of: ${BUILTIN_REFRESHABLE_PROVIDER_IDS.join(', ')}`,
    );
    expect(deps.refreshBuiltinModels).not.toHaveBeenCalled();
  });

  it('does not run the refresh when the sender guard rejects', async () => {
    const harness = new IpcHarness();
    const refreshBuiltinModels = vi.fn(async () => {});
    registerProviderHandlers(
      harness,
      makeDeps({
        assertTrustedSender: () => {
          throw new Error('[PERMISSION_DENIED] untrusted sender');
        },
        refreshBuiltinModels,
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REFRESH, 'openai'),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(refreshBuiltinModels).not.toHaveBeenCalled();
  });

  it('maps source refresh failures to a generic IPC error', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        refreshBuiltinModels: async () => {
          throw new Error('/secret/path should stay in main logs');
        },
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REFRESH, 'xai'),
    ).rejects.toThrow("[INTERNAL] model list refresh failed for 'xai'");
  });

  it('preserves structured IPC errors from provider-specific refreshers', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        refreshBuiltinModels: async () => {
          throwIpcError('MODEL_ACCESS_FAILED', 'Cindy AI model list refresh failed.');
        },
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_REFRESH, 'xd'),
    ).rejects.toMatchObject({
      code: 'MODEL_ACCESS_FAILED',
      message: '[MODEL_ACCESS_FAILED] Cindy AI model list refresh failed.',
    });
  });
});

describe('provider:models-auto-refresh handler', () => {
  it('guards the sender and forwards an allowed renderer trigger', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn();
    const requestModelsAutoRefresh = vi.fn(async () => {});
    registerProviderHandlers(
      harness,
      makeDeps({ assertTrustedSender, requestModelsAutoRefresh }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_AUTO_REFRESH, 'model-selector-open'),
    ).resolves.toEqual({ ok: true });
    expect(assertTrustedSender).toHaveBeenCalledOnce();
    expect(requestModelsAutoRefresh).toHaveBeenCalledWith('model-selector-open');
  });

  it('rejects foreground and unknown renderer triggers', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_AUTO_REFRESH, 'foreground'),
    ).rejects.toThrow(
      '[INVALID_PARAMS] trigger must be one of: providers-open, model-selector-open',
    );
    expect(deps.requestModelsAutoRefresh).not.toHaveBeenCalled();
  });

  it('does not forward when the trusted sender guard rejects', async () => {
    const harness = new IpcHarness();
    const requestModelsAutoRefresh = vi.fn(async () => {});
    registerProviderHandlers(
      harness,
      makeDeps({
        assertTrustedSender: () => {
          throw new Error('[PERMISSION_DENIED] untrusted sender');
        },
        requestModelsAutoRefresh,
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_AUTO_REFRESH, 'providers-open'),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(requestModelsAutoRefresh).not.toHaveBeenCalled();
  });
});

describe('provider:custom:* CRUD handlers', () => {
  it('rejects credential-mutating CRUD before parsing or touching secrets for an untrusted sender', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn(() => {
      throwIpcError('PERMISSION_DENIED', 'untrusted provider mutation sender');
    });
    const deps = makeDeps({ assertTrustedSender });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
        validConfig,
        { codex: 'must-not-stage' },
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
        validConfig,
        { codex: 'must-not-stage' },
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, validConfig.id),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    expect(assertTrustedSender).toHaveBeenCalledTimes(3);
    expect(deps.readCustomProviderKeyForMutation).not.toHaveBeenCalled();
    expect(deps.storeCustomProviderKey).not.toHaveBeenCalled();
    expect(deps.removeCustomProviderKey).not.toHaveBeenCalled();
    expect(deps.removeOAuthCredentials).not.toHaveBeenCalled();
  });

  it('fails closed when the provider mutation sender guard is not wired', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ assertTrustedSender: undefined });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig),
    ).rejects.toThrow(/PERMISSION_DENIED.*guard unavailable/);
    expect(deps.storeCustomProviderKey).not.toHaveBeenCalled();
  });

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

  it('rolls back partial create keys before any provider config is committed', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>();
    const storeCalls: string[] = [];
    const removeCalls: AgentKind[] = [];
    registerProviderHandlers(harness, makeDeps({
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        storeCalls.push(`${agent}:${value}`);
        if (agent === 'codex') return false;
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        removeCalls.push(agent);
        keys.delete(agent);
        return { success: true };
      }),
    }));
    const config: CustomProviderConfig = {
      ...validConfig,
      id: 'partial-create',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'claude-model', name: 'Claude model' }],
        },
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'codex-model', name: 'Codex model' }],
        },
      },
    };

    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
        config,
        { 'claude-code': 'first-key', codex: 'second-key' },
      ),
    ).rejects.toThrow(/failed to update codex provider credential/);

    expect(await listCustomProviders()).toEqual([]);
    expect(keys.size).toBe(0);
    expect(storeCalls).toEqual([
      'claude-code:first-key',
      'codex:second-key',
    ]);
    expect(removeCalls).toEqual(['codex', 'claude-code']);
  });

  it('does not stage supplied API keys when creating a no-auth provider', async () => {
    mountDb();
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);
    const config: CustomProviderConfig = {
      ...validConfig,
      id: 'local-no-auth',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          ...validConfig.runtimes.codex!,
          baseUrl: 'http://127.0.0.1:4000/v1',
        },
      },
    };

    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
        config,
        { codex: 'must-not-be-stored' },
      ),
    ).resolves.toEqual({ ok: true });

    expect(deps.readCustomProviderKeyForMutation).not.toHaveBeenCalled();
    expect(deps.storeCustomProviderKey).not.toHaveBeenCalled();
    expect(deps.removeCustomProviderKey).not.toHaveBeenCalled();
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

  it('clears an OAuth token when its descriptor changes but preserves it for model-only edits', async () => {
    mountDb();
    const harness = new IpcHarness();
    const calls: string[] = [];
    const oauthCancel = vi.fn(() => calls.push('cancel'));
    const removeOAuthCredentials = vi.fn(() => {
      calls.push('clear');
      return () => true;
    });
    const deps = makeDeps({ oauthCancel, removeOAuthCredentials });
    registerProviderHandlers(harness, deps);
    const oauth = {
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      clientId: 'desktop',
      scopes: 'openid models.read',
    };
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth,
      },
    };
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);

    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      name: 'OpenRouter renamed',
    });
    expect(removeOAuthCredentials).not.toHaveBeenCalled();
    expect(oauthCancel).not.toHaveBeenCalled();

    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      auth: {
        method: 'oauth',
        oauth: {
          ...oauth,
          tokenUrl: 'https://auth.example/token-v2',
        },
      },
    });
    expect(calls).toEqual(['cancel', 'clear']);
    expect(oauthCancel).toHaveBeenCalledWith('openrouter');
    expect(removeOAuthCredentials).toHaveBeenCalledWith('openrouter');
  });

  it('rejects unknown recursive OAuth fields at the IPC validation boundary', async () => {
    mountDb();
    const harness = new IpcHarness();
    registerProviderHandlers(harness, makeDeps());
    const oauth = {
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      clientId: 'desktop',
      scopes: 'openid',
    } as Record<string, unknown>;
    oauth.unknown = oauth;

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, {
        ...validConfig,
        auth: { method: 'oauth', oauth },
      }),
    ).rejects.toThrow(/INVALID_PARAMS.*unknown is not allowed/);
    expect(await listCustomProviders()).toEqual([]);
  });

  it('keeps the existing config when OAuth credential removal fails', async () => {
    mountDb();
    const harness = new IpcHarness();
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'desktop',
          scopes: 'openid',
        },
      },
    };
    const deps = makeDeps({ removeOAuthCredentials: vi.fn(() => null) });
    registerProviderHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
        ...oauthConfig,
        auth: {
          method: 'oauth',
          oauth: {
            ...oauthConfig.auth!.oauth,
            clientId: 'replacement-client',
          },
        },
      }),
    ).rejects.toThrow(/INTERNAL.*failed to remove existing OAuth credentials/);
    expect((await listCustomProviders())[0]?.auth).toEqual(oauthConfig.auth);
    expect(deps.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it('restores OAuth credentials when the config write fails after removal', async () => {
    mountDb();
    const harness = new IpcHarness();
    const restore = vi.fn(() => true);
    const removeOAuthCredentials = vi.fn(() => restore);
    registerProviderHandlers(harness, makeDeps({ removeOAuthCredentials }));
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'desktop',
          scopes: 'openid',
        },
      },
    };
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);
    raw!.exec(`
      CREATE TRIGGER fail_custom_provider_update
      BEFORE UPDATE ON custom_providers
      BEGIN
        SELECT RAISE(ABORT, 'simulated write failure');
      END
    `);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
        ...oauthConfig,
        auth: {
          method: 'oauth',
          oauth: {
            ...oauthConfig.auth!.oauth,
            clientId: 'replacement-client',
          },
        },
      }),
    ).rejects.toThrow(/simulated write failure/);

    expect(removeOAuthCredentials).toHaveBeenCalledWith(oauthConfig.id);
    expect(restore).toHaveBeenCalledOnce();
    expect((await listCustomProviders())[0]?.auth).toEqual(oauthConfig.auth);
  });

  it('serializes provider updates so a failed write restores credentials before the next edit', async () => {
    mountDb();
    const harness = new IpcHarness();
    const calls: string[] = [];
    let removalCount = 0;
    const removeOAuthCredentials = vi.fn(() => {
      removalCount += 1;
      calls.push(`remove-${removalCount}`);
      return () => {
        calls.push(`restore-${removalCount}`);
        if (removalCount === 1) raw!.exec('DROP TRIGGER fail_first_custom_provider_update');
        return true;
      };
    });
    registerProviderHandlers(harness, makeDeps({ removeOAuthCredentials }));
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'desktop',
          scopes: 'openid',
        },
      },
    };
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);
    raw!.exec(`
      CREATE TRIGGER fail_first_custom_provider_update
      BEFORE UPDATE ON custom_providers
      BEGIN
        SELECT RAISE(ABORT, 'simulated first write failure');
      END
    `);

    const first = harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      auth: {
        method: 'oauth',
        oauth: { ...oauthConfig.auth!.oauth, clientId: 'failed-client' },
      },
    });
    const second = harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      auth: {
        method: 'oauth',
        oauth: { ...oauthConfig.auth!.oauth, clientId: 'winning-client' },
      },
    });

    await expect(first).rejects.toThrow(/simulated first write failure/);
    await expect(second).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['remove-1', 'restore-1', 'remove-2']);
    const savedAuth = (await listCustomProviders())[0]?.auth;
    expect(savedAuth?.method === 'oauth' ? savedAuth.oauth.clientId : undefined).toBe(
      'winning-client',
    );
  });

  it('restores a staged API key when the provider config write fails', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>([['codex', 'old-key']]);
    const storeCalls: string[] = [];
    registerProviderHandlers(harness, makeDeps({
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        storeCalls.push(`${agent}:${value}`);
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        keys.delete(agent);
        return { success: true };
      }),
    }));
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);
    raw!.exec(`
      CREATE TRIGGER fail_custom_provider_update
      BEFORE UPDATE ON custom_providers
      BEGIN
        SELECT RAISE(ABORT, 'simulated write failure');
      END
    `);

    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
        { ...validConfig, name: 'Must not persist' },
        { codex: 'replacement-key' },
      ),
    ).rejects.toThrow(/simulated write failure/);

    expect(storeCalls).toEqual(['codex:replacement-key', 'codex:old-key']);
    expect(keys.get('codex')).toBe('old-key');
    expect((await listCustomProviders())[0]?.name).toBe(validConfig.name);
  });

  it('aborts before overwriting an existing key that cannot be read for rollback', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>();
    let unreadable = false;
    const readCustomProviderKeyForMutation = vi.fn((_providerId, agent: AgentKind) => {
      if (unreadable && agent === 'claude-code') {
        throw new Error('encryption temporarily unavailable');
      }
      return keys.get(agent) ?? null;
    });
    const storeCustomProviderKey = vi.fn((_providerId, agent: AgentKind, value: string) => {
      keys.set(agent, value);
      return true;
    });
    const removeCustomProviderKey = vi.fn((_providerId, agent: AgentKind) => {
      keys.delete(agent);
      return { success: true };
    });
    registerProviderHandlers(harness, makeDeps({
      readCustomProviderKeyForMutation,
      storeCustomProviderKey,
      removeCustomProviderKey,
    }));
    const config: CustomProviderConfig = {
      ...validConfig,
      id: 'strict-snapshot',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'claude-model', name: 'Claude model' }],
        },
      },
    };
    await harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
      config,
      { 'claude-code': 'old-key' },
    );
    unreadable = true;
    storeCustomProviderKey.mockClear();
    removeCustomProviderKey.mockClear();

    await expect(
      harness.invoke(
        MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
        { ...config, name: 'Must not persist' },
        { 'claude-code': 'replacement-key' },
      ),
    ).rejects.toThrow(/failed to read existing claude-code provider credential/);

    expect(keys.get('claude-code')).toBe('old-key');
    expect(storeCustomProviderKey).not.toHaveBeenCalled();
    expect(removeCustomProviderKey).not.toHaveBeenCalled();
    expect((await listCustomProviders())[0]?.name).toBe(config.name);
  });

  it('serializes create key staging with a later cross-window update', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>();
    const storeCalls: string[] = [];
    let releaseRefresh!: () => void;
    let reachedRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const firstReachedRefresh = new Promise<void>((resolve) => {
      reachedRefresh = resolve;
    });
    let refreshCount = 0;
    const refreshCatalog = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        reachedRefresh();
        await refreshGate;
      }
    });
    registerProviderHandlers(harness, makeDeps({
      refreshCatalog,
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        storeCalls.push(`${agent}:${value}`);
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        keys.delete(agent);
        return { success: true };
      }),
    }));

    const create = harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
      validConfig,
      { codex: 'created-key' },
    );
    await firstReachedRefresh;
    const update = harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
      { ...validConfig, name: 'Later edit' },
      { codex: 'updated-key' },
    );
    await Promise.resolve();

    expect(storeCalls).toEqual(['codex:created-key']);
    expect((await listCustomProviders())[0]?.name).toBe(validConfig.name);

    releaseRefresh();
    await expect(create).resolves.toEqual({ ok: true });
    await expect(update).resolves.toEqual({ ok: true });
    expect(storeCalls).toEqual(['codex:created-key', 'codex:updated-key']);
    expect(keys.get('codex')).toBe('updated-key');
    expect((await listCustomProviders())[0]?.name).toBe('Later edit');
  });

  it('serializes API key staging with config updates across concurrent renderer edits', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>([['codex', 'old-key']]);
    const storeCalls: string[] = [];
    let holdRefresh = false;
    let releaseRefresh!: () => void;
    let reachedRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const firstReachedRefresh = new Promise<void>((resolve) => {
      reachedRefresh = resolve;
    });
    const refreshCatalog = vi.fn(async () => {
      if (!holdRefresh) return;
      reachedRefresh();
      await refreshGate;
    });
    const deps = makeDeps({
      refreshCatalog,
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        storeCalls.push(`${agent}:${value}`);
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        keys.delete(agent);
        return { success: true };
      }),
    });
    registerProviderHandlers(harness, deps);
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);
    holdRefresh = true;

    const first = harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
      { ...validConfig, name: 'First edit' },
      { codex: 'first-key' },
    );
    await firstReachedRefresh;
    const second = harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE,
      { ...validConfig, name: 'Second edit' },
      { codex: 'second-key' },
    );
    await Promise.resolve();

    expect(storeCalls).toEqual(['codex:first-key']);
    expect(keys.get('codex')).toBe('first-key');

    releaseRefresh();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(storeCalls).toEqual(['codex:first-key', 'codex:second-key']);
    expect(keys.get('codex')).toBe('second-key');
    expect((await listCustomProviders())[0]?.name).toBe('Second edit');
  });

  it('deletes (idempotent) + broadcasts; bad providerId → INVALID_PARAMS', async () => {
    mountDb();
    const harness = new IpcHarness();
    const calls: string[] = [];
    const keys = new Map<AgentKind, string>();
    const deps = makeDeps({
      oauthCancel: vi.fn(() => calls.push('cancel')),
      removeOAuthCredentials: vi.fn(() => {
        calls.push('clear');
        return () => true;
      }),
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        keys.delete(agent);
        return { success: true };
      }),
    });
    registerProviderHandlers(harness, deps);
    await harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
      validConfig,
      { codex: 'delete-me' },
    );

    const del = await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, 'openrouter');
    expect(del).toEqual({ ok: true });
    expect(await listCustomProviders()).toEqual([]);
    expect(keys.size).toBe(0);
    expect(calls).toEqual(['cancel', 'clear']);

    await expect(harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, '')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('does not delete a provider when OAuth credential removal fails', async () => {
    mountDb();
    const harness = new IpcHarness();
    const keys = new Map<AgentKind, string>();
    const deps = makeDeps({
      removeOAuthCredentials: vi.fn(() => null),
      readCustomProviderKeyForMutation: vi.fn(
        (_providerId, agent) => keys.get(agent) ?? null,
      ),
      storeCustomProviderKey: vi.fn((_providerId, agent, value) => {
        keys.set(agent, value);
        return true;
      }),
      removeCustomProviderKey: vi.fn((_providerId, agent) => {
        keys.delete(agent);
        return { success: true };
      }),
    });
    registerProviderHandlers(harness, deps);
    await harness.invoke(
      MAKER_INVOKE.PROVIDER_CUSTOM_CREATE,
      validConfig,
      { codex: 'must-survive' },
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, 'openrouter'),
    ).rejects.toThrow(/INTERNAL.*failed to remove existing OAuth credentials/);
    expect(await listCustomProviders()).toHaveLength(1);
    expect(keys.get('codex')).toBe('must-survive');
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
        authMethod: 'apiKey',
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
        authMethod: 'apiKey',
        wireProtocol: undefined,
        requestPath: '/tenant/acme/infer?stream=1',
        apiKey: 'k',
        headers: undefined,
      },
    });
  });

  it('rejects remote no-auth adhoc probes before invoking the network dependency', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_TEST_CONNECTION, {
        kind: 'adhoc',
        spec: {
          agent: 'codex',
          baseUrl: 'https://remote.example/v1',
          modelId: 'm',
          authMethod: 'none',
        },
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.testConnection).not.toHaveBeenCalled();
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
      { kind: 'adhoc', spec: { agent: 'codex', baseUrl: 'https://x.example', modelId: 'm', requestPath: '//evil.example' } },
      { kind: 'adhoc', spec: { agent: 'codex', baseUrl: 'https://x.example', modelId: 'm', requestPath: '/infer#fragment' } },
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
  it('rejects an untrusted sender before issuing a credentialed model request', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn(() => {
      throwIpcError('PERMISSION_DENIED', '此操作只能从 Cindy 主页面发起');
    });
    const deps = makeDeps({ assertTrustedSender });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_FETCH, {
        agent: 'codex',
        baseUrl: 'https://attacker.example/v1',
        authMethod: 'apiKey',
        apiKey: 'credential-must-not-leave-main',
        headers: { 'x-api-key': 'custom-credential' },
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(assertTrustedSender).toHaveBeenCalledOnce();
    expect(deps.fetchModels).not.toHaveBeenCalled();
  });

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
      authMethod: 'apiKey',
      modelsUrl: 'https://x.example/v1/models',
      apiKey: 'k',
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: 'kimi-k3', name: 'Kimi K3' }] });
    expect(fetchModels).toHaveBeenCalledWith({
      agent: 'claude-code',
      baseUrl: 'https://x.example/anthropic',
      authMethod: 'apiKey',
      modelsUrl: 'https://x.example/v1/models',
      apiKey: 'k',
      headers: undefined,
    });
  });

  it('rejects remote no-auth model discovery URLs before invoking fetch', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_FETCH, {
        agent: 'codex',
        authMethod: 'none',
        baseUrl: 'http://127.0.0.1:4000/v1',
        modelsUrl: 'https://remote.example/v1/models',
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.fetchModels).not.toHaveBeenCalled();
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

describe('provider:oauth mutation ordering', () => {
  it('cancels an active login before removing OAuth credentials', async () => {
    const harness = new IpcHarness();
    const calls: string[] = [];
    const deps = makeDeps({
      oauthCancel: vi.fn(() => calls.push('cancel')),
      oauthLogout: vi.fn(async () => {
        calls.push('logout');
      }),
    });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGOUT, 'openrouter'),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['cancel', 'logout']);
  });

  it('encodes credential deletion failures as an IPC INTERNAL error', async () => {
    const harness = new IpcHarness();
    registerProviderHandlers(
      harness,
      makeDeps({
        oauthLogout: vi.fn().mockRejectedValue(new Error('safe storage deletion failed')),
      }),
    );

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGOUT, 'openrouter'),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('does not let a stale window release cancel a newer generic OAuth operation', async () => {
    const harness = new IpcHarness();
    const pending: Array<{
      isCurrent: () => boolean;
      finish: (result: { ok: boolean }) => void;
    }> = [];
    const oauthLogin = vi.fn(
      async (
        _providerId: string,
        isCurrent: () => boolean,
      ): Promise<{ ok: boolean }> =>
        new Promise((resolve) => {
          pending.push({ isCurrent, finish: resolve });
        }),
    );
    const oauthCancel = vi.fn();
    registerProviderHandlers(harness, makeDeps({ oauthLogin, oauthCancel }));

    const first = harness.invokeFrom(
      101,
      MAKER_INVOKE.PROVIDER_OAUTH_LOGIN,
      'openrouter',
      { ownerId: 'window-101-provider-login' },
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = harness.invokeFrom(
      202,
      MAKER_INVOKE.PROVIDER_OAUTH_LOGIN,
      'openrouter',
      { ownerId: 'window-202-provider-login' },
    );
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].isCurrent()).toBe(false);
    expect(pending[1].isCurrent()).toBe(true);

    await expect(
      harness.invokeFrom(
        101,
        MAKER_INVOKE.PROVIDER_OAUTH_CANCEL,
        'openrouter',
        { releaseOwner: true, ownerId: 'window-101-provider-login' },
      ),
    ).resolves.toEqual({ ok: true });
    expect(oauthCancel).not.toHaveBeenCalled();
    expect(pending[1].isCurrent()).toBe(true);

    await expect(
      harness.invokeFrom(
        202,
        MAKER_INVOKE.PROVIDER_OAUTH_CANCEL,
        'openrouter',
        { releaseOwner: true, ownerId: 'window-202-provider-login' },
      ),
    ).resolves.toEqual({ ok: true });
    expect(oauthCancel).toHaveBeenCalledOnce();
    expect(oauthCancel).toHaveBeenCalledWith('openrouter');
    expect(pending[1].isCurrent()).toBe(false);

    pending[0].finish({ ok: false });
    pending[1].finish({ ok: false });
    await expect(first).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    await expect(second).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
  });

  it('cancels the current owned generic OAuth operation when its window is destroyed', async () => {
    const harness = new IpcHarness();
    let isCurrent!: () => boolean;
    let finishLogin!: (result: { ok: boolean }) => void;
    const oauthLogin = vi.fn(
      async (
        _providerId: string,
        checkCurrent: () => boolean,
      ): Promise<{ ok: boolean }> =>
        new Promise((resolve) => {
          isCurrent = checkCurrent;
          finishLogin = resolve;
        }),
    );
    const oauthCancel = vi.fn();
    registerProviderHandlers(harness, makeDeps({ oauthLogin, oauthCancel }));

    const login = harness.invokeFrom(
      101,
      MAKER_INVOKE.PROVIDER_OAUTH_LOGIN,
      'openrouter',
      { ownerId: 'window-101-destroyed' },
    );
    await vi.waitFor(() => expect(oauthLogin).toHaveBeenCalledOnce());
    expect(isCurrent()).toBe(true);

    harness.destroySender(101);
    expect(oauthCancel).toHaveBeenCalledWith('openrouter');
    expect(isCurrent()).toBe(false);

    finishLogin({ ok: false });
    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
  });

  it('invalidates post-login work when the provider is edited before discovery finishes', async () => {
    mountDb();
    const harness = new IpcHarness();
    let finishLogin!: (result: {
      ok: boolean;
      rollbackCredentials?: () => boolean;
    }) => void;
    let loginIsCurrent!: () => boolean;
    const oauthLogin = vi.fn(
      async (
        _providerId: string,
        isCurrent: () => boolean,
      ): Promise<{ ok: boolean; rollbackCredentials?: () => boolean }> => {
        loginIsCurrent = isCurrent;
        return new Promise((resolve) => {
          finishLogin = resolve;
        });
      },
    );
    registerProviderHandlers(harness, makeDeps({ oauthLogin }));
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'desktop',
          scopes: 'openid models.read',
        },
      },
    };
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);

    const login = harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, oauthConfig.id);
    await vi.waitFor(() => expect(oauthLogin).toHaveBeenCalledOnce());
    expect(loginIsCurrent()).toBe(true);

    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      runtimes: {
        codex: {
          ...oauthConfig.runtimes.codex,
          baseUrl: 'https://new-endpoint.example/v1',
        },
      },
    });
    expect(loginIsCurrent()).toBe(false);

    const rollbackCredentials = vi.fn(() => true);
    finishLogin({ ok: true, rollbackCredentials });
    await expect(login).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(rollbackCredentials).toHaveBeenCalledOnce();
  });

  it('encodes failed stale-login credential rollback as an IPC INTERNAL error', async () => {
    const harness = new IpcHarness();
    let finishLogin!: (result: { ok: boolean; rollbackCredentials?: () => boolean }) => void;
    const oauthLogin = vi.fn(
      async (): Promise<{ ok: boolean; rollbackCredentials?: () => boolean }> =>
        new Promise((resolve) => {
          finishLogin = resolve;
        }),
    );
    registerProviderHandlers(harness, makeDeps({ oauthLogin }));

    const login = harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, 'openrouter');
    await vi.waitFor(() => expect(oauthLogin).toHaveBeenCalledOnce());
    await harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_CANCEL, 'openrouter');
    finishLogin({ ok: true, rollbackCredentials: () => false });

    await expect(login).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('rejects a new login until provider update and catalog refresh fully settle', async () => {
    mountDb();
    const harness = new IpcHarness();
    let finishRefresh!: () => void;
    const blockedRefresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshCatalog = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(blockedRefresh);
    const oauthLogin = vi.fn(async () => ({ ok: true }));
    registerProviderHandlers(harness, makeDeps({ refreshCatalog, oauthLogin }));
    const oauthConfig: CustomProviderConfig = {
      ...validConfig,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'desktop',
          scopes: 'openid',
        },
      },
    };
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, oauthConfig);

    const update = harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...oauthConfig,
      name: 'Updated while refresh is blocked',
    });
    await vi.waitFor(() => expect(refreshCatalog).toHaveBeenCalledTimes(2));

    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, oauthConfig.id),
    ).resolves.toEqual({ ok: false, reason: 'provider_update_in_progress' });
    expect(oauthLogin).not.toHaveBeenCalled();

    finishRefresh();
    await expect(update).resolves.toEqual({ ok: true });
    await expect(
      harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, oauthConfig.id),
    ).resolves.toEqual({ ok: true });
    expect(oauthLogin).toHaveBeenCalledOnce();
  });

  it('serializes explicit logout behind an in-flight provider update', async () => {
    mountDb();
    const harness = new IpcHarness();
    let finishRefresh!: () => void;
    const blockedRefresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshCatalog = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(blockedRefresh)
      .mockResolvedValueOnce(undefined);
    const oauthLogout = vi.fn().mockResolvedValue(undefined);
    registerProviderHandlers(harness, makeDeps({ refreshCatalog, oauthLogout }));
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig);

    const update = harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, {
      ...validConfig,
      name: 'Update before logout',
    });
    await vi.waitFor(() => expect(refreshCatalog).toHaveBeenCalledTimes(2));

    const logout = harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGOUT, validConfig.id);
    await Promise.resolve();
    expect(oauthLogout).not.toHaveBeenCalled();

    finishRefresh();
    await expect(update).resolves.toEqual({ ok: true });
    await expect(logout).resolves.toEqual({ ok: true });
    expect(oauthLogout).toHaveBeenCalledOnce();
  });

  it('cleans mutation entries without reviving an older login generation', async () => {
    const harness = new IpcHarness();
    const pending: Array<{
      isCurrent: () => boolean;
      finish: (result: {
        ok: boolean;
        rollbackCredentials?: () => boolean;
      }) => void;
    }> = [];
    const oauthLogin = vi.fn(
      async (
        _providerId: string,
        isCurrent: () => boolean,
      ): Promise<{ ok: boolean; rollbackCredentials?: () => boolean }> =>
        new Promise((resolve) => {
          pending.push({ isCurrent, finish: resolve });
        }),
    );
    registerProviderHandlers(harness, makeDeps({ oauthLogin }));

    const first = harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, 'openrouter');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_CANCEL, 'openrouter');
    expect(pending[0].isCurrent()).toBe(false);

    const second = harness.invoke(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, 'openrouter');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].isCurrent()).toBe(false);
    expect(pending[1].isCurrent()).toBe(true);

    const rollbackCredentials = vi.fn(() => true);
    pending[0].finish({ ok: true, rollbackCredentials });
    pending[1].finish({ ok: true });
    await expect(first).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    await expect(second).resolves.toEqual({ ok: true });
    expect(rollbackCredentials).toHaveBeenCalledOnce();
  });
});

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

/** 目录成员校验用的视图桩:models[agent] ∪ imageModels ∪ videoModels 只放 id。 */
function catalogView(
  id: string,
  models: Partial<Record<AgentKind, string[]>>,
  media: { image?: string[]; video?: string[] } = {},
): ProviderView {
  return {
    id,
    connected: true,
    models: Object.fromEntries(
      Object.entries(models).map(([agent, ids]) => [agent, (ids ?? []).map((m) => ({ id: m }))]),
    ),
    imageModels: (media.image ?? []).map((m) => ({ id: m, name: m })),
    videoModels: (media.video ?? []).map((m) => ({ id: m, name: m })),
  } as unknown as ProviderView;
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
    setModelsDisabled: vi.fn(() => {}),
    setProviderDisabled: vi.fn(() => {}),
    getLedgerCurrency: () => 'USD',
    readModelPriceOverride: vi.fn((target) => ({
      target,
      editable: target.providerId !== 'xd',
      reference: null,
      effective: null,
      override: null,
      conflict: false,
      registryUpdatedAt: null,
      allowedCurrencies: ['USD' as const],
    })),
    writeModelPriceOverride: vi.fn(() => {}),
    clearModelPriceOverride: vi.fn(() => {}),
    stageClearProviderModelPriceOverrides: vi.fn(() => () => true),
    broadcastPricingChanged: vi.fn(() => {}),
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

describe('model-disable:set handler', () => {
  /** 停用写入(disabled=true)按目录成员校验,fixture 提供 xd 的真实清单。 */
  const xdCatalog = () => [
    catalogView(
      'xd',
      { 'claude-code': ['claude-opus-5'], codex: ['chatgpt/gpt-5.5'] },
      { image: ['seedream-5'], video: ['seedance-2'] },
    ),
  ];

  it('model 形态:写停用 override 并广播 PROVIDER_CHANGED', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ listProviders: async () => xdCatalog() });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model',
        providerId: 'xd',
        modelIds: ['claude-opus-5', 'chatgpt/gpt-5.5'],
        disabled: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setModelsDisabled).toHaveBeenCalledWith('xd', ['claude-opus-5', 'chatgpt/gpt-5.5'], true);
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
  });

  it('专属媒体清单(imageModels/videoModels)的 id 同样是合法停用目标', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ listProviders: async () => xdCatalog() });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: ['seedream-5', 'seedance-2'], disabled: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setModelsDisabled).toHaveBeenCalledWith('xd', ['seedream-5', 'seedance-2'], true);
  });

  it('停用按目录成员校验:未知 providerId / 未知 modelId → INVALID_PARAMS,不写', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ listProviders: async () => xdCatalog() });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'ghost', modelIds: ['claude-opus-5'], disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5', 'not-in-catalog'], disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'provider', providerId: 'ghost', disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();
    expect(deps.setProviderDisabled).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('恢复启用(disabled=false)不校验成员:目录漂移后仍能清掉陈旧 override', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({ listProviders: async () => [] });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'retired', modelIds: ['gone-model'], disabled: false,
      }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setModelsDisabled).toHaveBeenCalledWith('retired', ['gone-model'], false);
  });

  it('写入串行:先到的停用(等目录校验)不被后到的启用超车,最后一次操作赢', async () => {
    const harness = new IpcHarness();
    const order: string[] = [];
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const deps = makeDeps({
      // 停用请求要等目录校验;启用(删条目)不查目录 —— 不串行时启用会先落盘。
      listProviders: async () => {
        await catalogGate;
        return xdCatalog();
      },
      setModelsDisabled: vi.fn((_p: string, _ids: readonly string[], disabled: boolean) => {
        order.push(disabled ? 'disable' : 'enable');
      }),
    });
    registerProviderHandlers(harness, deps);

    const disableReq = harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
      kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5'], disabled: true,
    });
    const enableReq = harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
      kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5'], disabled: false,
    });
    await Promise.resolve();
    expect(order).toEqual([]); // 启用被队列挡在停用后面,而不是抢先落盘
    releaseCatalog();
    await Promise.all([disableReq, enableReq]);
    expect(order).toEqual(['disable', 'enable']);
  });

  it('异步窗口内切账号 → INTERNAL 拒写:A 的点击不落进 B 的 owner-scoped 偏好', async () => {
    const harness = new IpcHarness();
    let owner = 'owner-a';
    const deps = makeDeps({
      currentOwnerId: () => owner,
      // 目录校验的 await 窗口内发生账号切换。
      listProviders: async () => {
        owner = 'owner-b';
        return xdCatalog();
      },
    });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5'], disabled: true,
      }),
    ).rejects.toThrow(/INTERNAL/);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();

    // 账号稳定时照常放行。
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5'], disabled: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setModelsDisabled).toHaveBeenCalledOnce();
  });

  it('落盘异常 → 结构化 INTERNAL,不把文件系统细节透过 IPC 边界', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({
      listProviders: async () => xdCatalog(),
      setModelsDisabled: vi.fn(() => {
        throw new Error('EACCES: permission denied, rename /Users/x/userData/model-disable-prefs.json');
      }),
    });
    registerProviderHandlers(harness, deps);

    const req = harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
      kind: 'model', providerId: 'xd', modelIds: ['claude-opus-5'], disabled: true,
    });
    await expect(req).rejects.toThrow(/INTERNAL/);
    await req.catch((err: unknown) => {
      expect(String(err)).not.toContain('EACCES');
      expect(String(err)).not.toContain('userData');
    });
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('reset 形态:恢复默认删除整组 override(不做目录成员校验)并广播', async () => {
    // 恢复默认要能清掉指向已下架模型的陈旧条目 —— 与「恢复启用」同语义,故意不查目录
    // (configuration-and-overrides.md §4;R24)。
    const harness = new IpcHarness();
    const listProviders = vi.fn(async () => [] as ProviderView[]);
    const deps = makeDeps({
      listProviders,
      clearProviderDisableOverrides: vi.fn(() => {}),
    });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'reset', providerId: 'gone-provider' }),
    ).resolves.toEqual({ ok: true });
    expect(deps.clearProviderDisableOverrides).toHaveBeenCalledWith('gone-provider');
    expect(listProviders).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();

    // 未接线时结构化 INTERNAL,不静默吞掉。
    const harness2 = new IpcHarness();
    const deps2 = makeDeps({ clearProviderDisableOverrides: undefined });
    registerProviderHandlers(harness2, deps2);
    await expect(
      harness2.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'reset', providerId: 'xd' }),
    ).rejects.toThrow(/INTERNAL/);
  });

  it('provider 形态:写供应商级停用并广播', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'provider', providerId: 'xd', disabled: false }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setProviderDisabled).toHaveBeenCalledWith('xd', false);
    expect(deps.broadcastChanged).toHaveBeenCalledOnce();
  });

  it('入参非法(缺 modelIds / 未知 kind)→ INVALID_PARAMS,不写不广播', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'model', providerId: 'xd', modelIds: [], disabled: true }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'nope', providerId: 'xd', disabled: true }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();
    expect(deps.setProviderDisabled).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('入参超限(超长 id / 超大数组)→ INVALID_PARAMS,不落盘(本通道同步序列化写文件)', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    const hugeId = 'x'.repeat(300);
    const hugeList = Array.from({ length: 600 }, (_v, i) => `m-${i}`);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: hugeId, modelIds: ['m1'], disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: [hugeId], disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
        kind: 'model', providerId: 'xd', modelIds: hugeList, disabled: true,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();
    expect(deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('设置类写操作:不可信 sender / 守卫未接线一律拒绝', async () => {
    const harness = new IpcHarness();
    const rejecting = makeDeps({
      assertTrustedSender: vi.fn(() => {
        throwIpcError('PERMISSION_DENIED', '此操作只能从 Cindy 主页面发起');
      }),
    });
    registerProviderHandlers(harness, rejecting);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'provider', providerId: 'xd', disabled: true }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(rejecting.setProviderDisabled).not.toHaveBeenCalled();

    const harness2 = new IpcHarness();
    const unwired = makeDeps({ assertTrustedSender: undefined });
    registerProviderHandlers(harness2, unwired);
    await expect(
      harness2.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, { kind: 'provider', providerId: 'xd', disabled: true }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(unwired.setProviderDisabled).not.toHaveBeenCalled();
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
      stageClearProviderModelPriceOverrides: vi.fn(() => () => true),
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
    expect(deps.stageClearProviderModelPriceOverrides).toHaveBeenCalledWith('openrouter');
    expect(deps.broadcastPricingChanged).toHaveBeenCalled();

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

  it('删除事务持 disable 写队列直到目录刷新:并发停用写排在刷新后,按成员校验拒绝', async () => {
    // R22:只把清理入队的话,清理落盘后队列即释放,「删除完成前」的窗口里并发
    // MODEL_DISABLE_SET 仍能从未刷新的 listProviders() 里找到该 provider、预埋新
    // override,同 id 重建复活停用状态。整体持锁后,并发写必须排到 afterChange 刷完
    // 目录之后 —— 那时成员校验已看不到该 provider,自然 INVALID_PARAMS 拒绝。
    mountDb();
    const harness = new IpcHarness();
    let catalogHasProvider = true;
    const deps = makeDeps({
      listProviders: async () =>
        catalogHasProvider ? [catalogView('openrouter', { codex: ['meta/llama-4'] })] : [],
      stageClearProviderDisableOverrides: vi.fn(() => () => true),
    });
    registerProviderHandlers(harness, deps);
    // create 的收尾也调 refreshCatalog(makeDeps 默认无门闩,直接放行);create 完成后
    // 再把 refreshCatalog 换成带门闩的实现给删除用。
    await harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, validConfig, { codex: 'k' });
    let releaseDeleteRefresh!: () => void;
    const deleteRefreshGate = new Promise<void>((resolve) => {
      releaseDeleteRefresh = resolve;
    });
    let deleteRefreshEntered!: () => void;
    const deleteRefreshEnteredGate = new Promise<void>((resolve) => {
      deleteRefreshEntered = resolve;
    });
    (deps.refreshCatalog as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      deleteRefreshEntered();
      await deleteRefreshGate;
      catalogHasProvider = false;
    });

    const del = harness.invoke(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, 'openrouter');
    // 等删除事务推进到 afterChange(此刻配置已删、队列仍被删除事务持有)。
    await deleteRefreshEnteredGate;
    const set = harness.invoke(MAKER_INVOKE.MODEL_DISABLE_SET, {
      kind: 'model', providerId: 'openrouter', modelIds: ['meta/llama-4'], disabled: true,
    });
    let setSettled = false;
    void set.then(() => { setSettled = true; }, () => { setSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    // 队列被删除事务持有 —— 并发停用写不得在目录刷新前落盘或返回。
    expect(setSettled).toBe(false);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();

    releaseDeleteRefresh();
    await expect(del).resolves.toEqual({ ok: true });
    await expect(set).rejects.toThrow(/INVALID_PARAMS.*unknown providerId/);
    expect(deps.setModelsDisabled).not.toHaveBeenCalled();
  });
});

describe('model price override handlers', () => {
  const target = {
    providerId: 'openrouter',
    agent: 'codex' as const,
    modelId: 'meta/llama-4',
  };

  it('reads and writes a catalog member through the trusted visual settings path', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({
      listProviders: async () => [
        catalogView('openrouter', { codex: ['meta/llama-4'] }),
      ],
    });
    registerProviderHandlers(harness, deps);

    await harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_GET, target);
    expect(deps.readModelPriceOverride).toHaveBeenCalledWith(target);

    const desired = {
      currency: 'USD' as const,
      inputPerMtok: 1.25,
      outputPerMtok: 5,
      cacheReadPerMtok: null,
    };
    await harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_SET, target, desired);
    expect(deps.writeModelPriceOverride).toHaveBeenCalledWith(target, desired);
    expect(deps.broadcastPricingChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown models, malformed prices, and XD sale-price overrides', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps({
      listProviders: async () => [
        catalogView('openrouter', { codex: ['meta/llama-4'] }),
        catalogView('xd', { codex: ['gpt-5.5'] }),
      ],
    });
    registerProviderHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_GET, {
        ...target,
        modelId: 'missing',
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_SET, target, {
        currency: 'USD',
        inputPerMtok: -1,
        outputPerMtok: 5,
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_SET, target, {
        currency: 'CNY',
        inputPerMtok: 1,
        outputPerMtok: 5,
      }),
    ).rejects.toThrow(/CNY price overrides cannot project into a USD ledger/);
    await expect(
      harness.invoke(
        MAKER_INVOKE.MODEL_PRICE_OVERRIDE_SET,
        { providerId: 'xd', agent: 'codex', modelId: 'gpt-5.5' },
        { currency: 'USD', inputPerMtok: 1, outputPerMtok: 2 },
      ),
    ).rejects.toThrow(/server-controlled/);
    expect(deps.writeModelPriceOverride).not.toHaveBeenCalled();
  });

  it('guards price reads before returning owner-scoped override data', async () => {
    const harness = new IpcHarness();
    const assertTrustedSender = vi.fn(() => {
      throwIpcError('PERMISSION_DENIED', 'untrusted price override reader');
    });
    const deps = makeDeps({
      assertTrustedSender,
      listProviders: async () => [catalogView('openrouter', { codex: ['meta/llama-4'] })],
    });
    registerProviderHandlers(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_GET, target)).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(assertTrustedSender).toHaveBeenCalledOnce();
    expect(deps.readModelPriceOverride).not.toHaveBeenCalled();
  });

  it('resets an orphaned sparse override without requiring the model to remain listed', async () => {
    const harness = new IpcHarness();
    const deps = makeDeps();
    registerProviderHandlers(harness, deps);

    await harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_RESET, target);
    expect(deps.clearModelPriceOverride).toHaveBeenCalledWith(target);
    expect(deps.broadcastPricingChanged).toHaveBeenCalledTimes(1);
  });

  it('converts reset persistence failures to a stable IPC error without leaking paths', async () => {
    const harness = new IpcHarness();
    const clearModelPriceOverride = vi.fn(() => {
      throw new Error('EROFS: read-only file system, unlink /private/userData/model-price.json');
    });
    const deps = makeDeps({ clearModelPriceOverride });
    registerProviderHandlers(harness, deps);

    let failure: unknown;
    try {
      await harness.invoke(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_RESET, target);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/INTERNAL.*failed to reset model price override/);
    expect((failure as Error).message).not.toContain('/private/userData');
    expect(deps.broadcastPricingChanged).not.toHaveBeenCalled();
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

  it('preserves the Codex Anthropic Messages wire protocol for API-key discovery', async () => {
    const harness = new IpcHarness();
    const fetchModels = vi.fn(async () => ({ ok: true as const, models: [] }));
    registerProviderHandlers(harness, makeDeps({ fetchModels }));

    await harness.invoke(MAKER_INVOKE.PROVIDER_MODELS_FETCH, {
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      authMethod: 'apiKey',
      apiKey: 'sk-test',
    });

    expect(fetchModels).toHaveBeenCalledWith({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      authMethod: 'apiKey',
      modelsUrl: null,
      apiKey: 'sk-test',
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

/**
 * useDeviceProviders 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:远程走隧道 maker:provider:list、按 deviceId 隔离、inflight 去重、缓存命中不重拉、
 * evict 只清该设备、evict 在途结果丢弃不复活 —— 与 useAgentCapabilities 同范式。
 * 模块级缓存:每个用例 vi.resetModules() + 动态 import 拿干净模块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectedProvidersForAgent,
  visibleModelUnion,
  type ProviderView,
} from '@cindy/model-providers';

beforeEach(() => {
  vi.resetModules();
});

type Providers = {
  providers: ProviderView[];
  modelVisibilityOverrides?: Record<string, boolean>;
};
const provider = (id: string): ProviderView => ({
  id,
  name: id,
  source: 'builtin',
  agents: ['claude-code'],
  auth: { method: 'none' },
  routing: {
    'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' },
  },
  models: { 'claude-code': [] },
  connected: true,
});
const result = (deviceId: string): Providers => ({ providers: [provider(`${deviceId}-xd`)] });

const providerWithModel = (id: string) => ({
  ...provider(id),
  models: {
    'claude-code': [
      {
        id: `${id}-model`,
        name: `${id} Model`,
        contextWindow: 200_000,
        efforts: ['medium'],
        defaultEffort: 'medium',
      },
    ],
  },
});

/** stub window.electronAPI.deviceLink.invoke,返回 spy。 */
function stubDeviceLink() {
  const invoke = vi.fn(async (deviceId: string) => result(deviceId));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  return invoke;
}

describe('useDeviceProviders deviceId-aware cache', () => {
  it('远程路径:prefetch 命中 deviceLink.invoke(maker:provider:list, [])', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
  });

  it('非法 provider 响应进入 error，不得把 null 当成权威空列表', async () => {
    const invoke = vi.fn(async () => null);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid', listener);

    await mod.prefetchDeviceProviders('dev-invalid');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider list response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders('dev-invalid')).toBeNull();
  });

  it('provider 数组混入非法元素时丢掉坏项，保留合法供应商', async () => {
    const invoke = vi.fn(async () => ({ providers: [provider('valid'), null] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid-item', listener);

    await mod.prefetchDeviceProviders('dev-invalid-item');

    expect(mod.getCachedDeviceProviders('dev-invalid-item')?.providers.map((row) => row.id)).toEqual([
      'valid',
    ]);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        providers: [expect.objectContaining({ id: 'valid' })],
      }),
    );
  });

  it('接受不含执行字段的安全投影 provider', async () => {
    const projected = {
      id: 'projected',
      name: 'Projected',
      agents: ['claude-code'],
      models: {
        'claude-code': [
          {
            id: 'projected-model',
            name: 'Projected Model',
            contextWindow: 200_000,
            efforts: ['medium'],
            defaultEffort: 'medium',
          },
        ],
      },
      connected: true,
    };
    const invoke = vi.fn(async () => ({ providers: [projected] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-projected');

    const cached = mod.getCachedDeviceProviders('dev-projected');
    expect(cached).toEqual({
      providers: [{ ...projected, routing: { 'claude-code': {} } }],
    });
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'claude-code')).toHaveLength(1);
    expect(
      visibleModelUnion(cached?.providers ?? [], 'claude-code', () => true).map((m) => m.id),
    ).toEqual(['projected-model']);
  });

  it('补齐 agents 声明但缺失的远程 routing entry,保留已有 disabled 标记', async () => {
    const projected = {
      ...providerWithModel('partial-routing'),
      agents: ['claude-code', 'codex'],
      routing: { codex: { disabled: true } },
    };
    const invoke = vi.fn(async () => ({ providers: [projected] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-partial-routing');

    const cached = mod.getCachedDeviceProviders('dev-partial-routing');
    expect(cached?.providers[0]?.routing).toEqual({
      codex: { disabled: true },
      'claude-code': {},
    });
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'claude-code')).toHaveLength(1);
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'codex')).toEqual([]);
  });

  it('嵌套模型损坏时丢掉坏模型，保留供应商', async () => {
    const malformed = {
      ...provider('malformed-model'),
      models: {
        'claude-code': [
          null,
          {
            id: 'kept',
            name: 'Kept',
            contextWindow: 200_000,
            efforts: ['medium'],
            defaultEffort: 'medium',
          },
        ],
      },
    };
    const invoke = vi.fn(async () => ({ providers: [malformed] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-malformed-model');

    expect(
      mod.getCachedDeviceProviders('dev-malformed-model')?.providers[0]?.models['claude-code'],
    ).toEqual([
      expect.objectContaining({ id: 'kept' }),
    ]);
  });

  it('模型有 efforts 却没有自洽 defaultEffort 时丢掉该行，不整表失败', async () => {
    const invoke = vi.fn(async () => ({
      providers: [
        {
          ...provider('openai'),
          models: {
            'claude-code': [
              {
                id: 'gpt-5.6-luna',
                name: 'GPT-5.6-Luna',
                contextWindow: 1_050_000,
                efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              },
              {
                id: 'claude-opus-5',
                name: 'Claude Opus 5',
                contextWindow: 200_000,
                efforts: ['high'],
                defaultEffort: 'high',
              },
            ],
          },
        },
      ],
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-luna');

    expect(
      mod.getCachedDeviceProviders('dev-luna')?.providers[0]?.models['claude-code']?.map((m) => m.id),
    ).toEqual(['claude-opus-5']);
  });

  it.each([
    ['provider.suspended', { ...provider('bad-suspended'), suspended: 'true' }],
    [
      'routing.disabled',
      {
        ...provider('bad-route-disabled'),
        routing: { 'claude-code': { disabled: 'true' } },
      },
    ],
    [
      'routing.wireProtocol',
      {
        ...provider('bad-wire-protocol'),
        routing: { 'claude-code': { wireProtocol: 'future-protocol' } },
      },
    ],
  ])('%s 类型损坏时整份 provider 响应失败', async (field, malformed) => {
    const deviceId = `dev-invalid-${field}`;
    const invoke = vi.fn(async () => ({ providers: [malformed] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders(deviceId, listener);

    await mod.prefetchDeviceProviders(deviceId);

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider list response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders(deviceId)).toBeNull();
  });

  it.each([
    ['model.disabled', 'true'],
    ['model.supportsFastMode', 'true'],
    ['model.defaultEnabled', 'false'],
  ])('%s 类型损坏时丢掉该模型，不整表失败', async (field, badValue) => {
    const key = field.split('.')[1] as 'disabled' | 'supportsFastMode' | 'defaultEnabled';
    const invoke = vi.fn(async () => ({
      providers: [
        {
          ...providerWithModel('kept-provider'),
          models: {
            'claude-code': [
              {
                ...providerWithModel('kept-provider').models['claude-code'][0],
                [key]: badValue,
              },
              {
                id: 'good',
                name: 'Good',
                contextWindow: 200_000,
                efforts: ['medium'],
                defaultEffort: 'medium',
              },
            ],
          },
        },
      ],
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders(`dev-drop-${key}`);

    expect(
      mod
        .getCachedDeviceProviders(`dev-drop-${key}`)
        ?.providers[0]?.models['claude-code']?.map((model) => model.id),
    ).toEqual(['good']);
  });

  it('模型可见性 override 含非布尔值时不得缓存', async () => {
    const invoke = vi.fn(async () => ({
      providers: [provider('invalid-override')],
      modelVisibilityOverrides: { 'claude-code:invalid-override:model': 'hidden' },
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid-override', listener);

    await mod.prefetchDeviceProviders('dev-invalid-override');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider visibility response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders('dev-invalid-override')).toBeNull();
  });

  it('缓存命中:同设备二次 prefetch 不再发请求', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('缓存并通知被控端的模型可见性 override 快照', async () => {
    const overrides = { 'codex:openai:hidden-model': false };
    const invoke = vi.fn(async () => ({
      ...result('dev-1'),
      modelVisibilityOverrides: overrides,
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-1', listener);

    await mod.prefetchDeviceProviders('dev-1');

    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({
      providers: [provider('dev-1-xd')],
      modelVisibilityOverrides: overrides,
    });
    expect(listener).toHaveBeenCalledWith({
      status: 'ready',
      providers: [provider('dev-1-xd')],
      modelVisibilityOverrides: overrides,
    });
  });

  it('inflight 去重:同设备并发只发一次', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await Promise.all([mod.prefetchDeviceProviders('dev-1'), mod.prefetchDeviceProviders('dev-1')]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('key 隔离:dev-1 / dev-2 各拉各的,互不影响', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-2', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    // dev-2 已缓存:再 prefetch 不重拉(隔离 + 命中)。
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('驱逐:evict 后同设备重新拉取;只清该设备(dev-2 仍命中缓存)', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
    mod.evictDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1'); // 缓存已清 → 重拉(+1)
    await mod.prefetchDeviceProviders('dev-2'); // 未清 → 命中(+0)
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('evict 在途 prefetch → 结果丢弃,不复活缓存(重连/升级目标端后串旧)', async () => {
    const resolvers: Array<(v: Providers) => void> = [];
    const invoke = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    const p = mod.prefetchDeviceProviders('dev-1'); // 在途(invoke 未 resolve)
    mod.evictDeviceProviders('dev-1'); // 设备下线 → 驱逐(代际自增)
    resolvers.forEach((r) => r(result('dev-1-stale'))); // 在途请求随后才回来
    await p;

    // 被驱逐的在途结果不得回写缓存 → 再 prefetch 必须重新发请求(总计 2 次)。
    const p2 = mod.prefetchDeviceProviders('dev-1');
    resolvers.forEach((r) => r(result('dev-1-fresh'))); // resolve 第二轮(含已 resolve 的第一轮,no-op)
    await p2;
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reject(旧版被控端不识别通道)→ 不缓存,下次重试', async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      throw new Error(
        "[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'maker:provider:list' not allowed remotely",
      );
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-old'); // swallow
    await mod.prefetchDeviceProviders('dev-old'); // 上次失败未缓存 → 再发
    expect(call).toBe(2);
  });

  it('错误事件区分旧端不支持与真实连接失败', async () => {
    const unsupported = new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed remotely');
    const policyFailure = new Error('proxy policy: request not allowed remotely');
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] timed out'))
      .mockRejectedValueOnce(policyFailure);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const oldDeviceListener = vi.fn();
    const offlineListener = vi.fn();
    const policyFailureListener = vi.fn();
    mod.subscribeDeviceProviders('dev-old', oldDeviceListener);
    mod.subscribeDeviceProviders('dev-offline', offlineListener);
    mod.subscribeDeviceProviders('dev-policy-failure', policyFailureListener);

    await mod.prefetchDeviceProviders('dev-old');
    await mod.prefetchDeviceProviders('dev-offline');
    await mod.prefetchDeviceProviders('dev-policy-failure');

    expect(mod.isDeviceProvidersUnsupportedError(unsupported)).toBe(true);
    expect(mod.isDeviceProvidersUnsupportedError(policyFailure)).toBe(false);
    expect(oldDeviceListener).toHaveBeenCalledWith({
      status: 'error',
      error: unsupported.message,
      unsupported: true,
    });
    expect(offlineListener).toHaveBeenCalledWith({
      status: 'error',
      error: '[DEVICE_LINK_TIMEOUT] timed out',
      unsupported: false,
    });
    expect(policyFailureListener).toHaveBeenCalledWith({
      status: 'error',
      error: policyFailure.message,
      unsupported: false,
    });
  });

  it('新快照只通知对应 deviceId 的已挂载订阅者', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    const dev1 = vi.fn();
    const dev2 = vi.fn();
    const off1 = mod.subscribeDeviceProviders('dev-1', dev1);
    const off2 = mod.subscribeDeviceProviders('dev-2', dev2);

    await mod.prefetchDeviceProviders('dev-1');
    expect(dev1).toHaveBeenCalledWith({
      status: 'ready',
      providers: [provider('dev-1-xd')],
    });
    expect(dev2).not.toHaveBeenCalled();

    off1();
    off2();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('revision 后新请求先完成、旧请求后完成时只通知新快照', async () => {
    const resolvers: Array<(value: Providers) => void> = [];
    const invoke = vi.fn(() => new Promise<Providers>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-1', listener);

    const stale = mod.prefetchDeviceProviders('dev-1');
    mod.evictDeviceProviders('dev-1');
    const fresh = mod.prefetchDeviceProviders('dev-1');
    resolvers[1](result('fresh'));
    await fresh;
    resolvers[0](result('stale'));
    await stale;

    expect(listener).toHaveBeenNthCalledWith(1, { status: 'loading' });
    expect(listener).toHaveBeenNthCalledWith(2, {
      status: 'ready',
      providers: [provider('fresh-xd')],
    });
  });
});

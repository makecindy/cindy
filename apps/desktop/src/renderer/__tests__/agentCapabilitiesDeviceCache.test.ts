/**
 * useAgentCapabilities 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:本机 / 各被控设备的能力缓存按 (deviceId, agentKind) 隔离、远程走隧道、本机走本地、
 * inflight 去重、驱逐只清该设备 —— 这是控制端在远程会话里"忘掉本地能力"的基础。
 * 模块级缓存:每个用例 vi.resetModules() + 动态 import 拿到干净模块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

interface Caps {
  availableModels: Array<{
    id: string;
    displayName: string;
    contextWindow: number;
    efforts: string[];
    defaultEffort: string | null;
  }>;
  hasFastMode: boolean;
  effortLevels: unknown[];
  permissionModes: unknown[];
}
const caps = (label: string, ctx = 1): Caps => ({
  availableModels: [
    { id: 'm', displayName: label, contextWindow: ctx, efforts: [], defaultEffort: null },
  ],
  hasFastMode: false,
  effortLevels: [],
  permissionModes: [],
});

/** stub window.electronAPI.maker (local) + deviceLink (tunnel),返回两个 spy。 */
function stubElectron() {
  const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
  const invoke = vi.fn(async (deviceId: string, _channel: string, args: unknown[]) =>
    caps(`${deviceId}:${String(args[0])}`),
  );
  vi.stubGlobal('window', { electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } } });
  return { getCapabilities, invoke };
}

function stubLocalCatalog() {
  let providerId = 'provider-old';
  let capabilityRevision = 'old';
  let unavailableAgent: string | null = null;
  const getCapabilities = vi.fn(async (agent: string) => {
    if (agent === unavailableAgent) throw new Error(`Agent '${agent}' is not registered`);
    return caps(`${capabilityRevision}:${agent}`);
  });
  const listProviders = vi.fn(async () => ({
    dataOwnerId: null,
    ownerGeneration: 0,
    providers: [{ id: providerId }],
    providerOrder: [providerId],
  }));
  vi.stubGlobal('window', { electronAPI: { maker: { getCapabilities, listProviders } } });
  return {
    getCapabilities,
    setSnapshot(nextProviderId: string, nextCapabilityRevision: string): void {
      providerId = nextProviderId;
      capabilityRevision = nextCapabilityRevision;
    },
    setUnavailableAgent(agent: string | null): void {
      unavailableAgent = agent;
    },
  };
}

describe('useAgentCapabilities deviceId-aware cache', () => {
  it('本机路径:preload 命中 maker.getCapabilities,不碰 deviceLink', async () => {
    const { getCapabilities, invoke } = stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.preloadAllCapabilities();
    expect(getCapabilities).toHaveBeenCalledWith('claude-code');
    expect(getCapabilities).toHaveBeenCalledWith('codex');
    expect(getCapabilities).toHaveBeenCalledWith('pi');
    expect(invoke).not.toHaveBeenCalled();
    expect(mod.getCachedCapabilities('claude-code')?.availableModels[0].displayName).toBe(
      'local:claude-code',
    );
  });

  it('本机目录热刷新会原子替换核心 agent 的缓存快照', async () => {
    const { getCapabilities } = stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.preloadAllCapabilities();
    getCapabilities.mockImplementation(async (agent: string) => caps(`refreshed:${agent}`));

    await mod.refreshLocalCapabilities();

    expect(mod.getCachedCapabilities('claude-code')?.availableModels[0].displayName).toBe(
      'refreshed:claude-code',
    );
    expect(mod.getCachedCapabilities('codex')?.availableModels[0].displayName).toBe(
      'refreshed:codex',
    );
  });

  it('本机目录快照在可选 Pi 不可用时仍返回 Claude Code 与 Codex 能力', async () => {
    const { getCapabilities } = stubElectron();
    getCapabilities.mockImplementation(async (agent: string) => {
      if (agent === 'pi') throw new Error("Agent 'pi' is not registered");
      return caps(`local:${agent}`);
    });
    const mod = await import('@/hooks/useAgentCapabilities');

    await expect(mod.loadLocalCapabilitiesSnapshot()).resolves.toEqual([
      ['claude-code', caps('local:claude-code')],
      ['codex', caps('local:codex')],
    ]);
    expect(getCapabilities).toHaveBeenCalledWith('pi');
  });

  it('本机目录快照在核心 agent 不可用时仍拒绝提交部分能力', async () => {
    const { getCapabilities } = stubElectron();
    getCapabilities.mockImplementation(async (agent: string) => {
      if (agent === 'codex') throw new Error("Agent 'codex' is not registered");
      return caps(`local:${agent}`);
    });
    const mod = await import('@/hooks/useAgentCapabilities');

    await expect(mod.loadLocalCapabilitiesSnapshot()).rejects.toThrow(
      "Agent 'codex' is not registered",
    );
  });

  it('Pi 不可用且没有旧快照时仍联合提交 provider 与核心能力', async () => {
    const harness = stubLocalCatalog();
    harness.setSnapshot('provider-initial', 'initial');
    harness.setUnavailableAgent('pi');
    const catalog = await import('@/lib/localCatalogSnapshot');
    const providers = await import('@/lib/providersSnapshotStore');
    const capabilities = await import('@/hooks/useAgentCapabilities');

    await expect(catalog.refreshLocalCatalogSnapshot()).resolves.toBe(true);

    expect(providers.getCachedProvidersSnapshot()?.providers).toEqual([{ id: 'provider-initial' }]);
    expect(capabilities.getCachedCapabilities('claude-code')?.availableModels[0].displayName).toBe(
      'initial:claude-code',
    );
    expect(capabilities.getCachedCapabilities('codex')?.availableModels[0].displayName).toBe(
      'initial:codex',
    );
    expect(capabilities.getCachedCapabilities('pi')).toBeNull();
  });

  it('Pi 不可用时用新 provider 快照替换 last-valid snapshot', async () => {
    const harness = stubLocalCatalog();
    const catalog = await import('@/lib/localCatalogSnapshot');
    const providers = await import('@/lib/providersSnapshotStore');
    const capabilities = await import('@/hooks/useAgentCapabilities');
    await expect(catalog.refreshLocalCatalogSnapshot()).resolves.toBe(true);

    harness.setSnapshot('provider-new', 'new');
    harness.setUnavailableAgent('pi');
    await expect(catalog.refreshLocalCatalogSnapshot()).resolves.toBe(true);

    expect(providers.getCachedProvidersSnapshot()?.providers).toEqual([{ id: 'provider-new' }]);
    expect(capabilities.getCachedCapabilities('claude-code')?.availableModels[0].displayName).toBe(
      'new:claude-code',
    );
    expect(capabilities.getCachedCapabilities('codex')?.availableModels[0].displayName).toBe(
      'new:codex',
    );
  });

  it('核心 agent 失败时联合刷新保留 last-valid provider 与能力快照', async () => {
    const harness = stubLocalCatalog();
    const catalog = await import('@/lib/localCatalogSnapshot');
    const providers = await import('@/lib/providersSnapshotStore');
    const capabilities = await import('@/hooks/useAgentCapabilities');
    await expect(catalog.refreshLocalCatalogSnapshot()).resolves.toBe(true);

    harness.setSnapshot('provider-rejected', 'rejected');
    harness.setUnavailableAgent('codex');
    await expect(catalog.refreshLocalCatalogSnapshot()).resolves.toBe(false);

    expect(providers.getCachedProvidersSnapshot()?.providers).toEqual([{ id: 'provider-old' }]);
    expect(capabilities.getCachedCapabilities('claude-code')?.availableModels[0].displayName).toBe(
      'old:claude-code',
    );
    expect(capabilities.getCachedCapabilities('codex')?.availableModels[0].displayName).toBe(
      'old:codex',
    );
  });

  it('远程路径:prefetch 命中 deviceLink.invoke(maker:get-capabilities),不碰本地 maker', async () => {
    const { getCapabilities, invoke } = stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.prefetchDeviceCapabilities('dev-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-capabilities', ['claude-code']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-capabilities', ['codex']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-capabilities', ['pi']);
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(mod.getCachedCapabilities('claude-code', 'dev-1')?.availableModels[0].displayName).toBe(
      'dev-1:claude-code',
    );
    // 本地缓存不受影响(没预热过)
    expect(mod.getCachedCapabilities('claude-code')).toBeNull();
  });

  it('非法 capabilities 响应进入 error，不得发布 ready 或落缓存', async () => {
    const invoke = vi.fn(async () => null);
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');
    const listener = vi.fn();
    mod.subscribeDeviceCapabilities('dev-invalid', 'codex', listener);

    await mod.prefetchDeviceCapabilities('dev-invalid');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid agent capabilities response',
    });
    expect(mod.getCachedCapabilities('codex', 'dev-invalid')).toBeNull();
  });

  it('capabilities 模型数组混入非法元素时整份进入 error，不得部分发布或落缓存', async () => {
    const invoke = vi.fn(async () => ({
      ...caps('invalid'),
      availableModels: [...caps('valid').availableModels, null],
    }));
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');
    const listener = vi.fn();
    mod.subscribeDeviceCapabilities('dev-invalid-item', 'codex', listener);

    await mod.prefetchDeviceCapabilities('dev-invalid-item');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid agent capabilities response',
    });
    expect(mod.getCachedCapabilities('codex', 'dev-invalid-item')).toBeNull();
  });

  it('模型默认 effort 不在可用列表中时不得落缓存', async () => {
    const invoke = vi.fn(async () => ({
      ...caps('invalid-effort'),
      availableModels: [
        {
          id: 'm',
          displayName: 'Invalid Effort',
          contextWindow: 1,
          efforts: ['low'],
          defaultEffort: 'high',
        },
      ],
    }));
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');
    const listener = vi.fn();
    mod.subscribeDeviceCapabilities('dev-invalid-effort', 'codex', listener);

    await mod.prefetchDeviceCapabilities('dev-invalid-effort');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid agent capabilities response',
    });
    expect(mod.getCachedCapabilities('codex', 'dev-invalid-effort')).toBeNull();
  });

  it.each(['effortLevels', 'permissionModes'] as const)(
    '%s 混入非法 descriptor 时不得发布 ready',
    async (field) => {
      const invoke = vi.fn(async () => ({
        ...caps('invalid-descriptor'),
        [field]: [{ id: 'invalid', displayName: null }],
      }));
      const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
      vi.stubGlobal('window', {
        electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
      });
      const mod = await import('@/hooks/useAgentCapabilities');
      const listener = vi.fn();
      mod.subscribeDeviceCapabilities(`dev-invalid-${field}`, 'codex', listener);

      await mod.prefetchDeviceCapabilities(`dev-invalid-${field}`);

      expect(listener).toHaveBeenCalledWith({
        status: 'error',
        error: 'Invalid agent capabilities response',
      });
      expect(mod.getCachedCapabilities('codex', `dev-invalid-${field}`)).toBeNull();
    },
  );

  it('key 隔离:local / dev-1 / dev-2 各自独立不串', async () => {
    stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.preloadAllCapabilities();
    await mod.prefetchDeviceCapabilities('dev-1');
    await mod.prefetchDeviceCapabilities('dev-2');
    expect(mod.getCachedCapabilities('codex')?.availableModels[0].displayName).toBe('local:codex');
    expect(mod.getCachedCapabilities('codex', 'dev-1')?.availableModels[0].displayName).toBe(
      'dev-1:codex',
    );
    expect(mod.getCachedCapabilities('codex', 'dev-2')?.availableModels[0].displayName).toBe(
      'dev-2:codex',
    );
  });

  it('inflight 去重:同 key 并发只发一次请求', async () => {
    const { invoke } = stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await Promise.all([
      mod.prefetchDeviceCapabilities('dev-1'),
      mod.prefetchDeviceCapabilities('dev-1'),
    ]);
    // cc + codex + pi 各一次 = 3 次,而非 6 次
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('驱逐:evict 只清该设备,本地与其它设备保留', async () => {
    stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    await mod.preloadAllCapabilities();
    await mod.prefetchDeviceCapabilities('dev-1');
    await mod.prefetchDeviceCapabilities('dev-2');
    mod.evictDeviceCapabilities('dev-1');
    expect(mod.getCachedCapabilities('claude-code', 'dev-1')).toBeNull();
    expect(mod.getCachedCapabilities('codex', 'dev-1')).toBeNull();
    expect(mod.getCachedCapabilities('claude-code', 'dev-2')).not.toBeNull();
    expect(mod.getCachedCapabilities('claude-code')).not.toBeNull(); // 本地保留
  });

  it('[New-E] evict 在途 prefetch → 结果丢弃,不复活缓存', async () => {
    // 受控 deferred invoke:两个 agent 的 fetch 都卡在 in-flight,evict 后再 resolve。
    const resolvers: Array<(v: Caps) => void> = [];
    const invoke = vi.fn(() => new Promise<Caps>((r) => resolvers.push(r)));
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');

    const p = mod.prefetchDeviceCapabilities('dev-1'); // 在途(deps.invoke 未 resolve)
    mod.evictDeviceCapabilities('dev-1'); // 设备下线 → 驱逐(代际自增)
    resolvers.forEach((r) => r(caps('dev-1:stale'))); // 在途请求随后才回来
    await p;

    // 关键:被驱逐的在途结果不得回写 cache(否则重连 / 升级目标端后串旧 model/effort)。
    expect(mod.getCachedCapabilities('claude-code', 'dev-1')).toBeNull();
    expect(mod.getCachedCapabilities('codex', 'dev-1')).toBeNull();
  });

  it('[New-E] evict 后的新一轮 fetch 不被旧在途回调误删 inflight,能正常落缓存', async () => {
    // 两轮:第一轮在途被 evict;evict 后第二轮 fetch 应正常完成并落缓存(代际匹配)。
    const resolvers: Array<(v: Caps) => void> = [];
    const invoke = vi.fn(() => new Promise<Caps>((r) => resolvers.push(r)));
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');

    const p1 = mod.prefetchDeviceCapabilities('dev-1'); // 第一轮在途
    mod.evictDeviceCapabilities('dev-1'); // 驱逐,代际 → 1
    const p2 = mod.prefetchDeviceCapabilities('dev-1'); // 第二轮(代际 1)
    resolvers.forEach((r) => r(caps('dev-1:fresh'))); // 全部 resolve(含两轮)
    await Promise.all([p1, p2]);

    // 第二轮(当前代际)结果正常落缓存;第一轮(旧代际)被丢弃,不覆盖。
    expect(mod.getCachedCapabilities('claude-code', 'dev-1')?.availableModels[0].displayName).toBe(
      'dev-1:fresh',
    );
  });

  it('provider revision 后两个 agent 的新快照都会通知已挂载订阅者', async () => {
    stubElectron();
    const mod = await import('@/hooks/useAgentCapabilities');
    const claudeListener = vi.fn();
    const codexListener = vi.fn();
    mod.subscribeDeviceCapabilities('dev-1', 'claude-code', claudeListener);
    mod.subscribeDeviceCapabilities('dev-1', 'codex', codexListener);

    await mod.prefetchDeviceCapabilities('dev-1');

    expect(claudeListener).toHaveBeenCalledWith({
      status: 'ready',
      capabilities: expect.objectContaining({
        availableModels: [expect.objectContaining({ displayName: 'dev-1:claude-code' })],
      }),
    });
    expect(codexListener).toHaveBeenCalledWith({
      status: 'ready',
      capabilities: expect.objectContaining({
        availableModels: [expect.objectContaining({ displayName: 'dev-1:codex' })],
      }),
    });
  });

  it('revision 后新能力先完成、旧能力后完成时只通知并保留新快照', async () => {
    const resolvers: Array<(v: Caps) => void> = [];
    const invoke = vi.fn(() => new Promise<Caps>((resolve) => resolvers.push(resolve)));
    const getCapabilities = vi.fn(async (k: string) => caps(`local:${k}`));
    vi.stubGlobal('window', {
      electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } },
    });
    const mod = await import('@/hooks/useAgentCapabilities');
    const claudeListener = vi.fn();
    const codexListener = vi.fn();
    mod.subscribeDeviceCapabilities('dev-1', 'claude-code', claudeListener);
    mod.subscribeDeviceCapabilities('dev-1', 'codex', codexListener);

    const stale = mod.prefetchDeviceCapabilities('dev-1');
    mod.evictDeviceCapabilities('dev-1');
    const fresh = mod.prefetchDeviceCapabilities('dev-1');
    // 每轮按 ALL_AGENT_KINDS 顺序 push 三个 resolver(cc/codex/pi):
    // 第一轮(stale)= [0][1][2],第二轮(fresh)= [3][4][5]。
    resolvers[3](caps('fresh:claude'));
    resolvers[4](caps('fresh:codex'));
    resolvers[5](caps('fresh:pi'));
    await fresh;
    resolvers[0](caps('stale:claude'));
    resolvers[1](caps('stale:codex'));
    resolvers[2](caps('stale:pi'));
    await stale;

    expect(claudeListener).toHaveBeenNthCalledWith(1, { status: 'loading' });
    expect(codexListener).toHaveBeenNthCalledWith(1, { status: 'loading' });
    expect(claudeListener).toHaveBeenNthCalledWith(2, {
      status: 'ready',
      capabilities: expect.objectContaining({
        availableModels: [expect.objectContaining({ displayName: 'fresh:claude' })],
      }),
    });
    expect(codexListener).toHaveBeenNthCalledWith(2, {
      status: 'ready',
      capabilities: expect.objectContaining({
        availableModels: [expect.objectContaining({ displayName: 'fresh:codex' })],
      }),
    });
    expect(mod.getCachedCapabilities('claude-code', 'dev-1')?.availableModels[0].displayName).toBe(
      'fresh:claude',
    );
    expect(mod.getCachedCapabilities('codex', 'dev-1')?.availableModels[0].displayName).toBe(
      'fresh:codex',
    );
  });
});

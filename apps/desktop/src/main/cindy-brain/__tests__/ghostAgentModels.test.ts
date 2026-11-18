import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import {
  createGhostAgentModelsCache,
  GHOST_AGENT_MODELS_CACHE_MAX_CATALOGS,
  projectGhostAgentModels,
  withGhostModelDescriptions,
} from '../ghostAgentModels.js';

const provider = (id: string, efforts: string[]) =>
  ({
    id,
    name: id,
    source: 'user',
    connected: true,
    agents: ['codex'],
    routing: { codex: { enabled: true } },
    models: {
      codex: [
        { id: 'model', name: 'Model', mode: 'chat', efforts, defaultEffort: efforts[0] ?? null },
      ],
    },
    auth: { apiKey: 'secret' },
    endpoint: 'private',
    subscriptionAccount: { identity: 'private' },
  }) as unknown as ProviderView;

describe('plugin model projection', () => {
  it('uses per-route user visibility before catalog defaults without removing hidden models', () => {
    const a = provider('a', ['high']);
    a.models.codex![0]!.defaultEnabled = false;
    const b = provider('b', ['high']);
    const result = projectGhostAgentModels([a,b], ['codex'], (_, id) => id === 'a' ? true : false);
    expect(result.ok && result.models.map(m => m.visible)).toEqual([true,false]);
    const defaults = projectGhostAgentModels([a,b], ['codex']);
    expect(defaults.ok && defaults.models.map(m => m.visible)).toEqual([false,true]);
  });
  it('preserves per-provider efforts and exposes only explicit metadata fields', () => {
    const result = projectGhostAgentModels([
      provider('a', ['low', 'high']),
      provider('b', ['medium']),
    ], ['codex']);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: ['low', 'high'],
          defaultEffort: 'low',
          supportsFastMode: false,
        },
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'b',
          providerName: 'b',
          efforts: ['medium'],
          defaultEffort: 'medium',
          supportsFastMode: false,
        },
      ],
    });
  });
  /**
   * 测试价值
   * - 生产入口与可观察结果：插件 GET /agent-models 的投影带上与 App 模型选择器同源的展示数据
   *   （图标、分组、上下文窗口、Fast、档位显示名、供应商标、本地化说明），缺的字段不输出。
   * - Bug／规则依据：plugin-security-and-authoring.md「只读 Agent 模型目录」2026-11 可选展示字段。
   * - 现有覆盖缺口：既有用例只钉住原字段集合，没有新增字段的来源与缺省行为。
   * - 最小失败输入：一个带 icon/group/contextWindow/Fast/档位显示名的目录行和一个全缺省的目录行。
   * - tier：unit。
   * - 实测耗时：1.2 s（与 ghost.tasks.test.ts 同跑，macOS arm64）。
   */
  it('adds optional picker display data from the catalog and omits what is missing', () => {
    const rich = provider('rich', ['high']);
    (rich as { logoKind?: string }).logoKind = 'openai';
    Object.assign(rich.models.codex![0]!, {
      icon: 'codex', group: 'gpt', contextWindow: 272_000, supportsFastMode: true, supportsUltrafastMode: true,
      effortDisplayNames: { high: 'Deep' }, description: 'raw catalog text is not the picker copy',
    });
    const plain = provider('plain', []);
    const projected = withGhostModelDescriptions(
      projectGhostAgentModels([rich, plain], ['codex']),
      (model) => model.group === 'gpt' ? `blurb:${model.id}` : undefined,
    );
    if (!projected.ok) throw new Error('projection failed');
    expect(projected.models[0]).toEqual({
      visible: true, id: 'model', name: 'Model', agent: 'codex', providerId: 'rich', providerName: 'rich',
      efforts: ['high'], defaultEffort: 'high', icon: 'codex', group: 'gpt', contextWindow: 272_000,
      supportsFastMode: true, supportsUltrafastMode: true, effortDisplayNames: { high: 'Deep' }, logoKind: 'openai',
      description: 'blurb:model',
    });
    expect(projected.models[1]).toEqual({
      visible: true, id: 'model', name: 'Model', agent: 'codex', providerId: 'plain', providerName: 'plain',
      efforts: [], defaultEffort: null, supportsFastMode: false,
    });
  });
  it('excludes disconnected, suspended, disabled, retired, paid-locked and non-chat routes', () => {
    const a = provider('a', []);
    a.models.codex!.push(
      ...['disabled', 'retired', 'locked', 'image'].map((id) => ({
        ...a.models.codex![0]!,
        id,
        disabled: id === 'disabled',
        status: id === 'retired' ? ('retired' as const) : undefined,
        availability: id === 'locked' ? ('requires_payment' as const) : undefined,
        mode: id === 'image' ? 'image' : 'chat',
      })),
    );
    const result = projectGhostAgentModels([
      a,
      { ...provider('offline', []), connected: false },
      { ...provider('paused', []), suspended: true },
    ], ['codex']);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: [],
          defaultEffort: null,
          supportsFastMode: false,
        },
      ],
    });
  });
  it('only exposes registered runtimes, including registration after initial startup', () => {
    const p = provider('p', ['high']);
    p.agents = ['codex', 'pi'];
    p.routing.pi = p.routing.codex;
    p.models.pi = [...p.models.codex!];
    expect(projectGhostAgentModels([p], [])).toEqual({ ok: true, models: [] });
    const before = projectGhostAgentModels([p], ['codex']);
    expect(before.ok && before.models.map(m => m.agent)).toEqual(['codex']);
    const after = projectGhostAgentModels([p], ['codex', 'pi']);
    expect(after.ok && after.models.map(m => m.agent)).toEqual(['codex', 'pi']);
  });

  it('projects a remote location with catalog defaults and distinct provider rows', async () => {
    const anthropic = provider('anthropic', ['high']);
    const api = provider('anthropic-api', ['high']);
    anthropic.models.codex![0]!.defaultEnabled = false;
    const result = await createGhostAgentModelsCache().catalog('owner', 'claude', async () => [anthropic, api]);
    expect(result).toEqual({
      ok: true,
      agentDeviceId: 'claude',
      models: [
        {
          visible: false,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'anthropic',
          providerName: 'anthropic',
          efforts: ['high'],
          defaultEffort: 'high',
          supportsFastMode: false,
        },
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'anthropic-api',
          providerName: 'anthropic-api',
          efforts: ['high'],
          defaultEffort: 'high',
          supportsFastMode: false,
        },
      ],
    });
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：插件目录缓存同 owner+device 的并发读取只请求一次；失败结果不缓存，下一次读取返回目录。
   * - Bug／规则依据：makecindy/cindy#7472 Greptile「同时读取会重复发请求」。
   * - 现有覆盖缺口：既有用例只覆盖已完成的目录结果，没有覆盖空缓存下的并发读取或失败清理。
   * - 最小失败输入：同一 owner 和 device 两次并发读取，首次拒绝、重试返回一个可见模型。
   * - tier：unit。
   * - 实测耗时：0.59 s（修复后单文件运行，macOS arm64）。
   */
  it('shares an in-flight catalog read for the same owner and device, then retries after failure', async () => {
    const cache = createGhostAgentModelsCache();
    const read = vi.fn<() => Promise<ProviderView[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([provider('recovered', ['high'])]);

    const [first, second] = await Promise.all([
      cache.catalog('owner', 'device', read),
      cache.catalog('owner', 'device', read),
    ]);

    const unavailable = { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
    expect(first).toEqual(unavailable);
    expect(second).toEqual(unavailable);
    expect(read).toHaveBeenCalledTimes(1);

    await expect(cache.catalog('owner', 'device', read)).resolves.toMatchObject({
      ok: true,
      agentDeviceId: 'device',
      models: [{ providerId: 'recovered' }],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：插件目录缓存命中仍有效的目录，过期或被容量淘汰的目录重新读取。
   * - Bug／规则依据：makecindy/cindy#7472 Greptile「旧目录一直占内存」。
   * - 现有覆盖缺口：现有用例没有验证 TTL 过期回收，也没有跨 owner 的总目录条数上限。
   * - 最小失败输入：达到 64 项后保留 1 个新鲜目录，其余过期；写入超限目录后重读新鲜项与最早项。
   * - tier：unit。
   * - 实测耗时：0.57 s（修复后单文件运行，macOS arm64）。
   */
  it('evicts expired catalogs before enforcing a bounded cache size', async () => {
    let now = 0;
    const cache = createGhostAgentModelsCache({ now: () => now, ttlMs: 60_000 });
    const readFor = (id: string) => vi.fn<() => Promise<ProviderView[]>>()
      .mockResolvedValue([provider(id, ['high'])]);
    const expiredReads = Array.from(
      { length: GHOST_AGENT_MODELS_CACHE_MAX_CATALOGS - 1 },
      (_, index) => readFor(`expired-${index}`),
    );

    for (const [index, read] of expiredReads.entries()) {
      await cache.catalog(`expired-owner-${index}`, `expired-device-${index}`, read);
    }

    now = 1_000;
    const freshRead = readFor('fresh');
    await cache.catalog('fresh-owner', 'fresh-device', freshRead);
    now = 2_000;
    for (const [index, read] of expiredReads.entries()) {
      await cache.catalog(`expired-owner-${index}`, `expired-device-${index}`, read);
    }

    now = 60_001;
    const newRead = readFor('new');
    await cache.catalog('new-owner', 'new-device', newRead);
    await cache.catalog('fresh-owner', 'fresh-device', freshRead);
    expect(freshRead).toHaveBeenCalledTimes(1);

    const bounded = createGhostAgentModelsCache({ now: () => 0, ttlMs: 60_000 });
    const capacityReads = Array.from(
      { length: GHOST_AGENT_MODELS_CACHE_MAX_CATALOGS + 1 },
      (_, index) => readFor(`capacity-${index}`),
    );
    for (const [index, read] of capacityReads.entries()) {
      await bounded.catalog(`capacity-owner-${index}`, `capacity-device-${index}`, read);
    }
    await bounded.catalog('capacity-owner-0', 'capacity-device-0', capacityReads[0]!);
    expect(capacityReads[0]).toHaveBeenCalledTimes(2);
  });
});

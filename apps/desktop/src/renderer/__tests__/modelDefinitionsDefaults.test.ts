/**
 * getDefaultModelForVendor 的种子默认取法 —— 目录排序第一的默认可见模型。
 *
 * 回归「默认模型写死在渲染层」：原先 cc 写死 `claude-opus-4-8`（目录里旗舰早已是 Opus 5），
 * codex 这里写死 `gpt-5.5` 而 newMakerDraft 写死 `gpt-5.4` —— 两个值不同，且都是目录里
 * `defaultEnabled: false` 的默认收起条目，也就是种子默认模型压根不在用户看到的清单里。
 *
 * 注意这只是**种子**：真正的落点由 calibrateDraftModel 按「可用的里面选，供应商优先订阅」
 * 决定（见 draftModelCalibration.test.ts），这里拿不到连接态与来源。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRegistry } from '@cindy/model-providers';

beforeEach(() => {
  vi.resetModules();
});

interface StubModel {
  id: string;
  displayName: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
  sortOrder?: number;
  defaultEnabled?: boolean;
}

function model(id: string, over: Partial<StubModel> = {}): StubModel {
  return {
    id,
    displayName: id,
    contextWindow: 200_000,
    efforts: ['high'],
    defaultEffort: 'high',
    ...over,
  };
}

function stubCapabilities(byAgent: Record<'claude-code' | 'codex', StubModel[]>): void {
  const getCapabilities = vi.fn(async (kind: 'claude-code' | 'codex') => ({
    availableModels: byAgent[kind],
    hasFastMode: false,
    effortLevels: [],
    permissionModes: [],
  }));
  vi.stubGlobal('window', { electronAPI: { maker: { getCapabilities } } });
}

async function loadWith(byAgent: Record<'claude-code' | 'codex', StubModel[]>) {
  stubCapabilities(byAgent);
  const caps = await import('@/hooks/useAgentCapabilities');
  const md = await import('@/lib/modelDefinitions');
  await caps.preloadAllCapabilities();
  return md;
}

describe('getDefaultModelForVendor', () => {
  it('取 sortOrder 最小的模型，而不是清单里排前面的', async () => {
    const md = await loadWith({
      'claude-code': [model('first-in-list', { sortOrder: 30 }), model('flagship', { sortOrder: 0 })],
      codex: [model('gpt-old', { sortOrder: 20 }), model('gpt-new', { sortOrder: 17 })],
    });

    expect(md.getDefaultModelForVendor('cc').id).toBe('flagship');
    expect(md.getDefaultModelForVendor('codex').id).toBe('gpt-new');
  });

  it('跳过默认收起的模型 —— 用户在清单里看不到它', async () => {
    const md = await loadWith({
      'claude-code': [
        model('hidden-legacy', { sortOrder: 1, defaultEnabled: false }),
        model('visible', { sortOrder: 6 }),
      ],
      codex: [],
    });

    expect(md.getDefaultModelForVendor('cc').id).toBe('visible');
  });

  it('整份清单都默认收起时退回纯排序第一，不返回空', async () => {
    const md = await loadWith({
      'claude-code': [
        model('hidden-b', { sortOrder: 9, defaultEnabled: false }),
        model('hidden-a', { sortOrder: 2, defaultEnabled: false }),
      ],
      codex: [],
    });

    expect(md.getDefaultModelForVendor('cc').id).toBe('hidden-a');
  });

  it('缺 sortOrder 的条目排末尾，同序取先出现者', async () => {
    const md = await loadWith({
      'claude-code': [model('no-order'), model('ordered', { sortOrder: 40 })],
      codex: [model('tie-first', { sortOrder: 5 }), model('tie-second', { sortOrder: 5 })],
    });

    expect(md.getDefaultModelForVendor('cc').id).toBe('ordered');
    expect(md.getDefaultModelForVendor('codex').id).toBe('tie-first');
  });

  it('不跨 vendor 串味', async () => {
    const md = await loadWith({
      'claude-code': [model('cc-only', { sortOrder: 50 })],
      codex: [model('codex-only', { sortOrder: 0 })],
    });

    expect(md.getDefaultModelForVendor('cc').id).toBe('cc-only');
    expect(md.getDefaultModelForVendor('codex').id).toBe('codex-only');
  });

  it('不修改 capabilities 缓存的清单顺序（排序必须走副本）', async () => {
    // 展示层按 capabilities 的顺序渲染；原地 sort 会把它搅乱。
    const md = await loadWith({
      'claude-code': [model('b', { sortOrder: 9 }), model('a', { sortOrder: 0 })],
      codex: [],
    });

    md.getDefaultModelForVendor('cc');
    expect(md.getModelsForVendor('cc').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('capabilities 未加载时给冷启动占位，且与 coldStartModelIdForVendor 同源', async () => {
    stubCapabilities({ 'claude-code': [], codex: [] });
    const md = await import('@/lib/modelDefinitions');

    // 占位值必须与那个导出一致 —— 否则首帧会闪一个之后被换掉的模型名。
    expect(md.getDefaultModelForVendor('cc').id).toBe(md.coldStartModelIdForVendor('cc'));
    expect(md.getDefaultModelForVendor('codex').id).toBe(md.coldStartModelIdForVendor('codex'));
  });

  it('cc 冷启动占位的 id 与展示名必须是 bundled 目录里排序第一的可见模型', async () => {
    // 占位不是「另一份产品默认」，只是目录还没到位时的同值影子。两者漂移就会出现首帧一个
    // 模型、清单到位后换成另一个的跳变。
    //
    // 只锁 cc：anthropic 的动态发现清单会被 registry 用目录 sortOrder 覆盖，
    // 所以 registry 就是 cc tab 排序的权威。codex 侧不能这么锁，理由见下一条。
    //
    // 展示名一起锁住：renderer 刻意不 import BUNDLED_CATALOG（会把整份目录 JSON 打进
    // bundle，为一个瞬态 label 不值得），所以 label 只能写在代码里 —— 那就由这条断言保证
    // 它不漂移，而不是靠人记得两处一起改。
    stubCapabilities({ 'claude-code': [], codex: [] });
    const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
    const md = await import('@/lib/modelDefinitions');
    const first = Object.entries(bundledMeta(BUNDLED_CATALOG))
      .filter(([, v]) => v.agents?.includes('claude-code') && v.defaultEnabled !== false)
      .sort(
        ([, a], [, b]) =>
          (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
      )[0];

    expect(first).toBeDefined();
    expect(md.coldStartModelIdForVendor('cc')).toBe(first?.[0]);
    expect(md.getDefaultModelForVendor('cc').label).toBe(first?.[1].name);
  });

  it('codex 冷启动占位必须是目录里属 codex tab、默认可见、非折扣组的模型', async () => {
    // 这里刻意**不锁「排序第一」**：codex tab 的 sortOrder 有两个互相矛盾的来源 ——
    //   · ChatGPT 订阅清单来自动态发现，按上游 priority 算（Sol→17、Terra→18、Luna→19）；
    //   · Cindy AI 网关清单按 registry 的静态值（Luna=17、Sol=18、Terra=19）。
    // 两套顺序对 GPT-5.6 三兄弟正好相反，于是「排序第一」会随用户连的是订阅还是网关而不同。
    // 占位按订阅口径取（校准规则优先订阅供应商），锁死目录静态序会锁成另一个模型。
    // 这个不一致本身是目录数据问题，待产品裁决后再收紧本条断言。
    stubCapabilities({ 'claude-code': [], codex: [] });
    const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
    const md = await import('@/lib/modelDefinitions');
    const meta = bundledMeta(BUNDLED_CATALOG);
    const placeholder = md.coldStartModelIdForVendor('codex');
    const entry = meta[placeholder];

    expect(entry).toBeDefined();
    expect(entry?.agents).toContain('codex');
    expect(entry?.defaultEnabled).not.toBe(false);
    expect(entry?.group).not.toBe('gpt-budget');
    expect(md.getDefaultModelForVendor('codex').label).toBe(entry?.name);
  });
});

interface BundledMetaEntry {
  agents?: readonly string[];
  group?: string;
  name?: string;
  sortOrder?: number;
  defaultEnabled?: boolean;
}

function bundledMeta(catalog: { modelRegistry?: ModelRegistry }): Record<string, BundledMetaEntry> {
  const models: Record<string, BundledMetaEntry> = {};
  for (const entry of catalog.modelRegistry?.models ?? []) {
    for (const route of entry.routes) {
      if (route.providerId !== 'xd') continue;
      models[route.modelId] = {
        agents: route.agents,
        group: entry.group,
        name: entry.name,
        sortOrder: entry.sortOrder,
        defaultEnabled: entry.defaultEnabled,
      };
    }
  }
  return models;
}

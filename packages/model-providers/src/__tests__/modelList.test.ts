/**
 * modelList 标准派生的行为锁:
 *   1. parity 矩阵 —— visibleModelUnion / buildProviderSections 薄壳化后,输出必须与
 *      改写前的历史实现**深等含顺序**(历史实现在本文件内联保存为 legacy* 参照物,
 *      来源 = 改写前 sections.ts 的原文,勿改);
 *   2. 溯源元数据(sourceProviderId / sourceAccess / sourceConnected)的正确性 ——
 *      flat 清单订阅徽章的数据地基;
 *   3. options 各口径(providerScope / dedupe / exclude / keepSelected)的边界。
 */

import { describe, expect, it } from 'vitest';

import { deriveModelList, deriveModelSections } from '../modelList.js';
import { buildProviderSections, visibleModelUnion, type SectionModel } from '../sections.js';
import { connectedProvidersForAgent, type ProviderView } from '../registry.js';
import { BUNDLED_CATALOG } from '../catalog.js';
import type { AgentKind, CatalogModel } from '../types.js';

// ── 历史实现参照物(改写前 sections.ts 原文,只删 export;parity 的对照组,勿动)──

function legacyVisibleModelUnion(
  providers: readonly ProviderView[],
  agent: AgentKind,
  isVisible: (providerId: string, model: CatalogModel) => boolean,
): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const provider of connectedProvidersForAgent([...providers], agent)) {
    for (const m of provider.models[agent] ?? []) {
      if (seen.has(m.id)) continue;
      if (!isVisible(provider.id, m)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

function legacyBuildProviderSections(args: {
  providers: readonly ProviderView[];
  agent: AgentKind;
  selectedModelId?: string;
  selectedProviderId?: string | null;
  isVisible: (providerId: string, modelId: string) => boolean;
  query?: string;
}): Array<{ provider: ProviderView; models: SectionModel[] }> {
  const q = (args.query ?? '').trim().toLowerCase();
  const sections: Array<{ provider: ProviderView; models: SectionModel[] }> = [];
  for (const provider of args.providers) {
    const catalog = provider.models[args.agent] ?? [];
    const models: SectionModel[] = [];
    for (const m of catalog) {
      const isSelected = m.id === args.selectedModelId && provider.id === args.selectedProviderId;
      if (!isSelected && !args.isVisible(provider.id, m.id)) continue;
      if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) continue;
      const sm: SectionModel = {
        id: m.id,
        displayName: m.name,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
        contextWindow: m.contextWindow,
      };
      if (m.description !== undefined) sm.description = m.description;
      if (m.effortDisplayNames !== undefined) sm.effortDisplayNames = m.effortDisplayNames;
      if (m.supportsFastMode !== undefined) sm.supportsFastMode = m.supportsFastMode;
      if (m.icon !== undefined) sm.icon = m.icon;
      models.push(sm);
    }
    if (models.length > 0) sections.push({ provider, models });
  }
  return sections;
}

// ── fixture:合成一个带跨供应商同名模型/订阅来源/隐藏模型的目录 ────────────────

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: extra.name ?? id.toUpperCase(),
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    ...extra,
  } as CatalogModel;
}

function provider(
  id: string,
  agents: AgentKind[],
  models: Partial<Record<AgentKind, CatalogModel[]>>,
  extra: Partial<ProviderView> = {},
): ProviderView {
  return {
    id,
    name: id,
    agents,
    routing: Object.fromEntries(agents.map((agent) => [agent, {}])),
    models,
    connected: true,
    ...extra,
  } as ProviderView;
}

/** anthropic(订阅) + xd(托管) 同 offer opus;xd 另有独占与默认隐藏模型;custom 无 access。 */
function fixtureProviders(): ProviderView[] {
  return [
    provider(
      'anthropic',
      ['claude-code'],
      { 'claude-code': [model('claude-opus-5'), model('claude-haiku-4-5')] },
      { access: { kind: 'subscription', product: 'Claude.ai' } },
    ),
    provider(
      'xd',
      ['claude-code', 'codex'],
      {
        'claude-code': [
          model('claude-opus-5'),
          model('xd-only-model'),
          model('hidden-model', { defaultEnabled: false }),
        ],
        codex: [model('gpt-5.5'), model('codex/gpt-5.5', { group: 'gpt-budget' })],
      },
      { access: { kind: 'managed' } },
    ),
    provider('custom-a', ['codex'], { codex: [model('gpt-5.5'), model('custom-only')] }),
    provider('disconnected-p', ['claude-code'], { 'claude-code': [model('dc-only')] }, {
      connected: false,
    }),
  ];
}

const VISIBLE_ALL = () => true;
const VISIBILITY_BY_DEFAULT = (_pid: string, m: CatalogModel) => m.defaultEnabled !== false;

// ── 1. parity 矩阵 ───────────────────────────────────────────────────────────

describe('parity: visibleModelUnion 薄壳 vs 历史实现', () => {
  const agents: AgentKind[] = ['claude-code', 'codex'];
  const visibilities = [VISIBLE_ALL, VISIBILITY_BY_DEFAULT];
  const connectionCombos = [
    (p: ProviderView) => p, // 原样
    (p: ProviderView) => ({ ...p, connected: p.id !== 'xd' }), // xd 断开
    (p: ProviderView) => ({ ...p, connected: false }), // 全断
  ];

  it('全矩阵深等(含顺序)', () => {
    for (const agent of agents) {
      for (const vis of visibilities) {
        for (const combo of connectionCombos) {
          const providers = fixtureProviders().map(combo);
          const legacy = legacyVisibleModelUnion(providers, agent, vis);
          const current = visibleModelUnion(providers, agent, vis);
          // 薄壳返回 ModelListEntry(超集);目录字段部分必须与 legacy 深等含顺序。
          expect(current.map((m) => m.id)).toEqual(legacy.map((m) => m.id));
          current.forEach((m, i) => expect(m).toMatchObject(legacy[i]));
        }
      }
    }
  });

  it('BUNDLED_CATALOG 真实目录同样深等', () => {
    for (const agent of ['claude-code', 'codex'] as AgentKind[]) {
      const providers: ProviderView[] = BUNDLED_CATALOG.providers.map((p) => ({
        ...p,
        connected: true,
      }));
      const legacy = legacyVisibleModelUnion(providers, agent, VISIBLE_ALL);
      const current = visibleModelUnion(providers, agent, VISIBLE_ALL);
      expect(current.map((m) => m.id)).toEqual(legacy.map((m) => m.id));
    }
  });
});

describe('parity: buildProviderSections 薄壳 vs 历史实现', () => {
  const cases: Array<Parameters<typeof buildProviderSections>[0]> = [
    // 常规: 已连接列表(调用方口径)
    {
      providers: fixtureProviders().filter((p) => p.connected),
      agent: 'claude-code',
      isVisible: () => true,
    },
    // 可见性过滤 + 选中豁免(选中的 hidden-model 保留)
    {
      providers: fixtureProviders(),
      agent: 'claude-code',
      selectedModelId: 'hidden-model',
      selectedProviderId: 'xd',
      isVisible: (_pid, mid) => mid !== 'hidden-model',
    },
    // 选中豁免不生效: selectedProviderId 为 null(历史语义: null 不豁免任何行)
    {
      providers: fixtureProviders(),
      agent: 'claude-code',
      selectedModelId: 'hidden-model',
      selectedProviderId: null,
      isVisible: (_pid, mid) => mid !== 'hidden-model',
    },
    // query 过滤
    { providers: fixtureProviders(), agent: 'codex', isVisible: () => true, query: 'gpt' },
    // **未收窄列表**(含 disconnected):历史实现不收窄,薄壳必须保持
    { providers: fixtureProviders(), agent: 'claude-code', isVisible: () => true },
  ];

  it('全用例深等(含顺序与字段存在性)', () => {
    for (const args of cases) {
      expect(buildProviderSections(args)).toEqual(legacyBuildProviderSections(args));
    }
  });
});

// ── 2. 溯源元数据 ────────────────────────────────────────────────────────────

describe('ModelListEntry 溯源', () => {
  it('first-wins 去重时溯源 = 首见供应商(订阅 access 保真)', () => {
    const list = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
    });
    const opus = list.find((m) => m.id === 'claude-opus-5');
    // anthropic 在数组序里先于 xd → 首见胜出,溯源是订阅来源
    expect(opus?.sourceProviderId).toBe('anthropic');
    expect(opus?.sourceAccess).toEqual({ kind: 'subscription', product: 'Claude.ai' });
    const xdOnly = list.find((m) => m.id === 'xd-only-model');
    expect(xdOnly?.sourceProviderId).toBe('xd');
    expect(xdOnly?.sourceAccess).toEqual({ kind: 'managed' });
  });

  it('custom provider 无 access → sourceAccess 键不写入(诚实缺省,非 undefined 值)', () => {
    const list = deriveModelList({
      providers: fixtureProviders(),
      agent: 'codex',
      providerScope: 'connected-for-agent',
    });
    const customOnly = list.find((m) => m.id === 'custom-only');
    expect(customOnly?.sourceProviderId).toBe('custom-a');
    expect(customOnly && 'sourceAccess' in customOnly).toBe(false);
  });

  it('all-for-agent 范围下 sourceConnected 如实反映连接态', () => {
    const list = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'all-for-agent',
    });
    expect(list.find((m) => m.id === 'dc-only')?.sourceConnected).toBe(false);
    expect(list.find((m) => m.id === 'claude-opus-5')?.sourceConnected).toBe(true);
  });
});

// ── 3. options 边界 ──────────────────────────────────────────────────────────

describe('deriveModelList options', () => {
  it("providerScope: 'connected-for-agent' 剔除断开来源;'all-for-agent' 保留", () => {
    const connected = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
    });
    expect(connected.some((m) => m.id === 'dc-only')).toBe(false);
    const all = deriveModelList({ providers: fixtureProviders(), agent: 'claude-code' });
    expect(all.some((m) => m.id === 'dc-only')).toBe(true);
  });

  it("dedupe:'none' 时同 id 每供应商各一行", () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
      dedupe: 'none',
    });
    const opusRows = rows.filter((m) => m.id === 'claude-opus-5');
    expect(opusRows.map((r) => r.sourceProviderId)).toEqual(['anthropic', 'xd']);
  });

  it('excludeProvider 被排除者不占 first-wins 的 seen(同 id 由后续供应商补上)', () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
      excludeProvider: (p) => p.id === 'anthropic',
    });
    const opus = rows.find((m) => m.id === 'claude-opus-5');
    expect(opus?.sourceProviderId).toBe('xd');
  });

  it('excludeModel 同样不占 seen', () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'codex',
      providerScope: 'connected-for-agent',
      excludeModel: (m, p) => p.id === 'xd' && m.id === 'gpt-5.5',
    });
    const gpt = rows.find((m) => m.id === 'gpt-5.5');
    expect(gpt?.sourceProviderId).toBe('custom-a');
  });

  it('keepSelected(providerId=null)在 flat 语义下按 model id 豁免任意供应商行', () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
      isVisible: (_pid, m) => m.id !== 'hidden-model',
      keepSelected: { providerId: null, modelId: 'hidden-model' },
    });
    expect(rows.some((m) => m.id === 'hidden-model')).toBe(true);
  });

  // 2026-07 codex review: 选中 (provider, model) 排在 rail 后位时,不能被前位供应商的
  // 同 id 首见行去重掉 —— 否则 flat 列表带着**错误来源**的溯源与徽章(选订阅版显示成
  // 托管版同款事故形状)。选中行原位替换首见行:位置守首见槽(顺序契约),溯源归选中方。
  it('keepSelected 点名后位供应商时,选中行替换首见行而非被 first-wins 丢弃', () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
      keepSelected: { providerId: 'xd', modelId: 'claude-opus-5' },
    });
    const opusRows = rows.filter((m) => m.id === 'claude-opus-5');
    expect(opusRows).toHaveLength(1);
    // anthropic 先见,但选中方是 xd → 溯源必须是 xd(managed),不是 anthropic(subscription)
    expect(opusRows[0].sourceProviderId).toBe('xd');
    expect(opusRows[0].sourceAccess).toEqual({ kind: 'managed' });
    // 位置守首见槽:仍是列表第一行(anthropic 段位),顺序契约不因替换漂移
    expect(rows[0].id).toBe('claude-opus-5');
  });

  it('keepSelected 点名首见供应商本身时行为不变(不触发替换)', () => {
    const rows = deriveModelList({
      providers: fixtureProviders(),
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
      keepSelected: { providerId: 'anthropic', modelId: 'claude-opus-5' },
    });
    const opus = rows.find((m) => m.id === 'claude-opus-5');
    expect(opus?.sourceProviderId).toBe('anthropic');
  });
});

describe('溯源字段键集锁(visibleModelUnion 薄壳的 wire 安全前提)', () => {
  it('条目额外键恰为 {sourceProviderId, sourceConnected[, sourceAccess]},新增即警报', () => {
    // visibleModelUnion 的条目会流经 main/renderer 消费方;它们过 wire 前做显式投影的
    // 前提是「额外字段就这三个」。这里锁死键集 —— 未来往 ModelListEntry 加字段时,
    // 必须重新核查全部消费方的投影完整性后再更新本断言。
    const providersFx = fixtureProviders();
    const withAccess = deriveModelList({
      providers: providersFx,
      agent: 'claude-code',
      providerScope: 'connected-for-agent',
    }).find((m) => m.id === 'claude-opus-5')!;
    const catalogKeys = new Set(
      Object.keys(providersFx[0].models['claude-code']!.find((m) => m.id === 'claude-opus-5')!),
    );
    const extraKeys = Object.keys(withAccess).filter((k) => !catalogKeys.has(k));
    expect(extraKeys.sort()).toEqual(['sourceAccess', 'sourceConnected', 'sourceProviderId']);
  });
});

describe('deriveModelSections', () => {
  it('逐供应商独立出段,空段剔除,段序 = rail 序', () => {
    const sections = deriveModelSections({
      providers: fixtureProviders(),
      agent: 'codex',
      providerScope: 'connected-for-agent',
    });
    expect(sections.map((s) => s.provider.id)).toEqual(['xd', 'custom-a']);
    expect(sections[0].models.every((m) => m.sourceProviderId === 'xd')).toBe(true);
  });
});

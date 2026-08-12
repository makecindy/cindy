/**
 * 统一模型选择器(模型优先)M3 / M4 的**纯逻辑锁**:行生效配置合成、收藏副本语义、
 * 收藏置顶 + 分组陈列、rail 派生、浮层定位、档位绝对色。
 *
 * 为什么这些必须有测试:行右侧的三元组与浮层里的每个控件显示的是**同一份合成结果**,
 * 一旦两边规则漂移,用户会看到「行上写着 high、浮层滑杆停在 medium」这种自相矛盾;
 * 而档位色按「第几档」相对取值(而不是按档位 key 绝对取值)是最容易犯、也最难目检出来的
 * 错误 —— 封顶 high 的模型会假装自己是顶档紫。
 */

import { describe, expect, it } from 'vitest';

import type { UnifiedAgentCapability, UnifiedModelEntry } from '@cindy/model-providers';

import {
  buildUnifiedListSections,
  buildUnifiedRail,
  computeFlyoutPlacement,
  isRecommendedFavoriteConfig,
  resolveFavoriteRowConfig,
  resolveUnifiedRowConfig,
} from '@/components/new-chat/unifiedModelSelection';
import type { ModelFavoriteItem } from '@/state/modelFavorites';
import {
  EFFORT_TIER_COLORS,
  effortTierColor,
  effortTierColorAt,
  hexLerp,
} from '@/themes/effortTierColors';

function capability(
  agent: UnifiedAgentCapability['agent'],
  over: Partial<UnifiedAgentCapability> = {},
): UnifiedAgentCapability {
  return {
    agent,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsFastMode: false,
    contextWindow: 200_000,
    contextWindowVerified: false,
    ...over,
  };
}

function entryOf(over: Partial<UnifiedModelEntry> = {}): UnifiedModelEntry {
  return {
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    sourceConnected: true,
    candidates: ['claude-code'],
    recommended: 'claude-code',
    capabilities: { 'claude-code': capability('claude-code') },
    ...over,
  };
}

function favoriteOf(over: Partial<ModelFavoriteItem> = {}): ModelFavoriteItem {
  return {
    uid: 'fav-1',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    agent: 'cc',
    ...over,
  };
}

describe('resolveUnifiedRowConfig', () => {
  it('无 override 时落推荐引擎与目录默认档', () => {
    const config = resolveUnifiedRowConfig({ entry: entryOf() });
    expect(config.engine).toBe('cc');
    expect(config.agent).toBe('claude-code');
    expect(config.effort).toBe('medium');
    expect(config.fast).toBe(false);
    expect(config.customized).toBe(false);
  });

  it('override 命中候选时采用它,并标记为已自定义', () => {
    const entry = entryOf({
      candidates: ['claude-code', 'codex'],
      capabilities: {
        'claude-code': capability('claude-code'),
        codex: capability('codex', { efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' }),
      },
    });
    const config = resolveUnifiedRowConfig({ entry, engineOverride: 'codex' });
    expect(config.engine).toBe('codex');
    expect(config.efforts).toEqual(['low', 'high', 'xhigh']);
    expect(config.effort).toBe('high');
    expect(config.customized).toBe(true);
  });

  it('override 不在候选里 → 静默回落推荐(不造假按钮)', () => {
    const config = resolveUnifiedRowConfig({ entry: entryOf(), engineOverride: 'codex' });
    expect(config.engine).toBe('cc');
    expect(config.customized).toBe(false);
  });

  it('记忆档位不被该 (模型, 引擎) 支持时回落目录默认', () => {
    const config = resolveUnifiedRowConfig({
      entry: entryOf(),
      memoryEffort: () => 'xhigh',
    });
    expect(config.effort).toBe('medium');
    expect(config.customized).toBe(false);
  });

  it('记忆档位被支持时采用它并计为自定义', () => {
    const config = resolveUnifiedRowConfig({ entry: entryOf(), memoryEffort: () => 'high' });
    expect(config.effort).toBe('high');
    expect(config.customized).toBe(true);
  });

  it('Fast 需要目录能力 × agent 运行时能力都为真', () => {
    const fastEntry = entryOf({
      capabilities: { 'claude-code': capability('claude-code', { supportsFastMode: true }) },
    });
    const both = resolveUnifiedRowConfig({
      entry: fastEntry,
      memoryFast: () => true,
      agentFastModeCapable: () => true,
    });
    expect(both.fastCapable).toBe(true);
    expect(both.fast).toBe(true);
    expect(both.customized).toBe(true);

    const runtimeOff = resolveUnifiedRowConfig({
      entry: fastEntry,
      memoryFast: () => true,
      agentFastModeCapable: () => false,
    });
    expect(runtimeOff.fastCapable).toBe(false);
    expect(runtimeOff.fast).toBe(false);

    const catalogOff = resolveUnifiedRowConfig({
      entry: entryOf(),
      memoryFast: () => true,
      agentFastModeCapable: () => true,
    });
    expect(catalogOff.fastCapable).toBe(false);
    expect(catalogOff.fast).toBe(false);
  });

  it('无档位的模型 → effort 为 null(不可调,滑杆不画)', () => {
    const config = resolveUnifiedRowConfig({
      entry: entryOf({
        capabilities: {
          'claude-code': capability('claude-code', { efforts: [], defaultEffort: null }),
        },
      }),
    });
    expect(config.efforts).toEqual([]);
    expect(config.effort).toBeNull();
  });

  it('深度 / Fast 记忆按**生效引擎**取,不串到另一个引擎的槽', () => {
    const entry = entryOf({
      candidates: ['claude-code', 'codex'],
      capabilities: {
        'claude-code': capability('claude-code'),
        codex: capability('codex', { efforts: ['low', 'medium', 'high'], defaultEffort: 'low' }),
      },
    });
    const asked: string[] = [];
    const config = resolveUnifiedRowConfig({
      entry,
      engineOverride: 'codex',
      memoryEffort: (agent) => {
        asked.push(agent);
        return agent === 'codex' ? 'high' : 'low';
      },
    });
    expect(asked).toEqual(['codex']);
    expect(config.effort).toBe('high');
  });
});

describe('收藏 = 配置副本', () => {
  it('收藏条目只读自己存的配置,不读模型 override / 记忆', () => {
    const entry = entryOf({
      candidates: ['claude-code', 'codex'],
      capabilities: {
        'claude-code': capability('claude-code'),
        codex: capability('codex'),
      },
    });
    const config = resolveFavoriteRowConfig({
      entry,
      item: favoriteOf({ agent: 'codex', effort: 'high' }),
    });
    expect(config.engine).toBe('codex');
    expect(config.effort).toBe('high');
    // 收藏行不参与「已自定义」语义(底栏是第三态「收藏配置」)。
    expect(config.customized).toBe(false);
  });

  it('条目里的引擎 / 档位已不被目录支持时按同一套规则收敛', () => {
    const config = resolveFavoriteRowConfig({
      entry: entryOf(),
      item: favoriteOf({ agent: 'codex', effort: 'ultra' }),
    });
    expect(config.engine).toBe('cc');
    expect(config.effort).toBe('medium');
  });

  it('isRecommendedFavoriteConfig 区分「就是推荐配置」与「非默认副本」', () => {
    const entry = entryOf({
      candidates: ['claude-code', 'codex'],
      capabilities: {
        'claude-code': capability('claude-code', { supportsFastMode: true }),
        codex: capability('codex'),
      },
    });
    const plain = resolveFavoriteRowConfig({ entry, item: favoriteOf({ effort: 'medium' }) });
    expect(isRecommendedFavoriteConfig(entry, plain)).toBe(true);

    const otherEffort = resolveFavoriteRowConfig({ entry, item: favoriteOf({ effort: 'high' }) });
    expect(isRecommendedFavoriteConfig(entry, otherEffort)).toBe(false);

    const otherEngine = resolveFavoriteRowConfig({ entry, item: favoriteOf({ agent: 'codex' }) });
    expect(isRecommendedFavoriteConfig(entry, otherEngine)).toBe(false);

    const withFast = resolveFavoriteRowConfig({
      entry,
      item: favoriteOf({ effort: 'medium', fast: true }),
      agentFastModeCapable: () => true,
    });
    expect(isRecommendedFavoriteConfig(entry, withFast)).toBe(false);
  });
});

describe('buildUnifiedListSections', () => {
  const opus = entryOf({ group: 'anthropic', sortOrder: 1 });
  const gpt = entryOf({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    group: 'gpt',
    sortOrder: 2,
    candidates: ['codex'],
    recommended: 'codex',
    capabilities: { codex: capability('codex') },
  });

  it('收藏区置顶,且不把模型本体从供应商组里移走', () => {
    const sections = buildUnifiedListSections({
      entries: [opus, gpt],
      favorites: [favoriteOf()],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections[0].kind).toBe('favorites');
    expect(sections[0].rows[0].anchor).toEqual({
      kind: 'fav',
      uid: 'fav-1',
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    const modelRows = sections.slice(1).flatMap((section) => section.rows);
    expect(modelRows.map((row) => row.entry.modelId)).toEqual(['claude-opus-5', 'gpt-5.5']);
  });

  it('分组按 sortOrder 决定组内与组间顺序', () => {
    const sections = buildUnifiedListSections({
      entries: [gpt, opus],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections.map((section) => section.category)).toEqual(['anthropic', 'gpt']);
  });

  it('搜索命中名称 / id / 描述', () => {
    const described = entryOf({ description: '擅长长上下文推理' });
    for (const query of ['opus', 'CLAUDE-OPUS', '长上下文']) {
      const sections = buildUnifiedListSections({
        entries: [described, gpt],
        favorites: [],
        query,
        rail: { kind: 'all' },
      });
      const ids = sections.flatMap((section) => section.rows.map((row) => row.entry.modelId));
      expect(ids).toEqual(['claude-opus-5']);
    }
  });

  it('rail 按供应商筛选时,收藏区也只留该来源', () => {
    const sections = buildUnifiedListSections({
      entries: [opus, gpt],
      favorites: [favoriteOf()],
      query: '',
      rail: { kind: 'provider', providerId: 'openai' },
    });
    expect(sections.every((section) => section.kind !== 'favorites')).toBe(true);
    expect(sections.flatMap((s) => s.rows.map((r) => r.entry.providerId))).toEqual(['openai']);
  });

  it('rail = 收藏时只出收藏区', () => {
    const sections = buildUnifiedListSections({
      entries: [opus, gpt],
      favorites: [favoriteOf()],
      query: '',
      rail: { kind: 'favorites' },
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('favorites');
  });

  it('收藏指向的模型当前不可路由时该条不显示(但不删条目)', () => {
    const sections = buildUnifiedListSections({
      entries: [gpt],
      favorites: [favoriteOf()],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections.every((section) => section.kind !== 'favorites')).toBe(true);
  });

  it('同模型多条收藏各占一行、锚点互不相同', () => {
    const sections = buildUnifiedListSections({
      entries: [opus],
      favorites: [
        favoriteOf({ uid: 'fav-1', effort: 'high' }),
        favoriteOf({ uid: 'fav-2', effort: 'low' }),
      ],
      query: '',
      rail: { kind: 'favorites' },
    });
    expect(sections[0].rows.map((row) => row.favorite?.uid)).toEqual(['fav-1', 'fav-2']);
  });
});

describe('会话内形态(同引擎过滤 / pinnedEngine)', () => {
  const dual = entryOf({
    providerId: 'xd',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    candidates: ['claude-code', 'codex'],
    recommended: 'claude-code',
    capabilities: {
      'claude-code': capability('claude-code'),
      codex: capability('codex', { efforts: ['low', 'high'], defaultEffort: 'high' }),
    },
  });
  const codexOnly = entryOf({
    providerId: 'xd',
    modelId: 'codex/gpt-5.5',
    displayName: 'GPT-5.5 折扣',
    candidates: ['codex'],
    recommended: 'codex',
    capabilities: { codex: capability('codex') },
  });

  it('pinnedEngine 顶替推荐作为缺省,但让位于用户显式 override', () => {
    const pinned = resolveUnifiedRowConfig({ entry: dual, pinnedEngine: 'codex' });
    expect(pinned.engine).toBe('codex');
    // 落在会话引擎上是缺省而不是自定义 —— 否则会话里几乎每行都被提亮。
    expect(pinned.customized).toBe(false);
    expect(pinned.effort).toBe('high');

    const overridden = resolveUnifiedRowConfig({
      entry: dual,
      pinnedEngine: 'codex',
      engineOverride: 'cc',
    });
    expect(overridden.engine).toBe('cc');
    expect(overridden.customized).toBe(true);
  });

  it('pinnedEngine 不在候选时忽略,回落推荐', () => {
    const config = resolveUnifiedRowConfig({ entry: codexOnly, pinnedEngine: 'cc' });
    expect(config.engine).toBe('codex');
    expect(config.customized).toBe(false);
  });

  it('同引擎视图按**候选**过滤模型(能留在本会话引擎上的都算无损)', () => {
    const sections = buildUnifiedListSections({
      entries: [dual, codexOnly],
      favorites: [],
      query: '',
      rail: { kind: 'engine', agent: 'claude-code' },
    });
    const ids = sections.flatMap((s) => s.rows.map((r) => r.entry.modelId));
    expect(ids).toEqual(['gpt-5.5']);
  });

  it('同引擎视图里收藏按**条目自己存的引擎**过滤', () => {
    const favCc = favoriteOf({ uid: 'fav-1', providerId: 'xd', modelId: 'gpt-5.5', agent: 'cc' });
    const favCodex = favoriteOf({
      uid: 'fav-2',
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
    });
    const sections = buildUnifiedListSections({
      entries: [dual],
      favorites: [favCc, favCodex],
      query: '',
      rail: { kind: 'engine', agent: 'claude-code' },
    });
    expect(sections[0].kind).toBe('favorites');
    expect(sections[0].rows.map((row) => row.favorite?.uid)).toEqual(['fav-1']);
  });

  it('「全部」视图不做引擎过滤(跨引擎是显式入口)', () => {
    const sections = buildUnifiedListSections({
      entries: [dual, codexOnly],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
    });
    const ids = sections.flatMap((s) => s.rows.map((r) => r.entry.modelId));
    expect(ids).toEqual(['gpt-5.5', 'codex/gpt-5.5']);
  });
});

describe('buildUnifiedRail', () => {
  it('★ 仅在有收藏时出现;供应商按行首次出现序排列', () => {
    const entries = [
      entryOf({ providerId: 'xd', modelId: 'a' }),
      entryOf({ providerId: 'anthropic', modelId: 'b' }),
      entryOf({ providerId: 'xd', modelId: 'c' }),
    ];
    expect(buildUnifiedRail(entries, [])).toEqual([
      { kind: 'all' },
      { kind: 'provider', providerId: 'xd' },
      { kind: 'provider', providerId: 'anthropic' },
    ]);
    expect(buildUnifiedRail(entries, [favoriteOf()])[0]).toEqual({ kind: 'favorites' });
  });

  it('会话内多一格「同引擎」,位置在 ★ 之下、全部之上', () => {
    const entries = [entryOf({ providerId: 'xd', modelId: 'a' })];
    expect(buildUnifiedRail(entries, [favoriteOf()], 'codex')).toEqual([
      { kind: 'favorites' },
      { kind: 'engine', agent: 'codex' },
      { kind: 'all' },
      { kind: 'provider', providerId: 'xd' },
    ]);
    // 草稿场景不出现这一格。
    expect(buildUnifiedRail(entries, []).some((item) => item.kind === 'engine')).toBe(false);
  });
});

describe('computeFlyoutPlacement', () => {
  const panel = { top: 100, bottom: 500, left: 400, right: 800 };
  const size = { width: 264, height: 300 };
  const viewport = { width: 1440, height: 900 };

  it('默认贴面板左外侧,顶端跟随锚点行', () => {
    const placement = computeFlyoutPlacement({
      anchor: { top: 240, bottom: 280, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(placement.side).toBe('left');
    expect(placement.left).toBe(400 - 10 - 264);
    expect(placement.top).toBe(240 - 12);
  });

  it('左边放不下时翻到右侧', () => {
    const placement = computeFlyoutPlacement({
      anchor: { top: 240, bottom: 280, left: 20, right: 380 },
      panel: { ...panel, left: 20, right: 380 },
      size,
      viewport,
    });
    expect(placement.side).toBe('right');
    expect(placement.left).toBe(390);
  });

  it('垂直方向夹到视口安全区内', () => {
    const low = computeFlyoutPlacement({
      anchor: { top: 880, bottom: 900, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(low.top).toBe(900 - 300 - 8);

    const high = computeFlyoutPlacement({
      anchor: { top: 0, bottom: 40, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(high.top).toBe(8);
  });

  it('两侧都放不下时仍留在视口内', () => {
    const placement = computeFlyoutPlacement({
      anchor: { top: 240, bottom: 280, left: 10, right: 590 },
      panel: { ...panel, left: 10, right: 590 },
      size,
      viewport: { width: 600, height: 900 },
    });
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + size.width).toBeLessThanOrEqual(600 - 8 + 1);
  });
});

describe('档位绝对色', () => {
  it('色映射按档位 key 绝对取值 —— 封顶 high 的模型拉满仍是蓝,不是紫', () => {
    expect(effortTierColor('high')).toBe('#3B82F6');
    expect(effortTierColor('max')).toBe('#8B5CF6');
    // 只有真正支持 max / ultra 的模型才会出现顶档紫。
    const cappedTop = ['low', 'medium', 'high'].at(-1) as string;
    expect(effortTierColor(cappedTop)).not.toBe(EFFORT_TIER_COLORS.max);
  });

  it('minimal 与 low 同绿、ultra 与 max 同紫(规格 §1.3)', () => {
    expect(effortTierColor('minimal')).toBe(effortTierColor('low'));
    expect(effortTierColor('ultra')).toBe(effortTierColor('max'));
  });

  it('未知档位回落中间档色,不谎报顶档', () => {
    expect(effortTierColor('brand-new-tier')).toBe(EFFORT_TIER_COLORS.medium);
    expect(effortTierColor(null)).toBe(EFFORT_TIER_COLORS.medium);
  });

  it('hexLerp 端点精确、中点插值(输出统一大写,与常量表同形)', () => {
    expect(hexLerp('#000000', '#ffffff', 0)).toBe('#000000');
    expect(hexLerp('#000000', '#ffffff', 1)).toBe('#FFFFFF');
    expect(hexLerp('#000000', '#ffffff', 0.5)).toBe('#808080');
    // 越界钳制,不产生非法色值。
    expect(hexLerp('#000000', '#ffffff', 5)).toBe('#FFFFFF');
  });

  it('拖动中的条色在相邻档色之间连续过渡', () => {
    const stops = ['low', 'medium', 'high'];
    expect(effortTierColorAt(stops, 0)).toBe(effortTierColor('low'));
    expect(effortTierColorAt(stops, 1)).toBe(effortTierColor('medium'));
    expect(effortTierColorAt(stops, 0.5)).toBe(
      hexLerp(effortTierColor('low'), effortTierColor('medium'), 0.5),
    );
    // 越界坐标钳制到首 / 末档色。
    expect(effortTierColorAt(stops, 9)).toBe(effortTierColor('high'));
    expect(effortTierColorAt([], 0)).toBe(EFFORT_TIER_COLORS.medium);
  });
});

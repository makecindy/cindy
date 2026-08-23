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

import type {
  UnifiedAgentCapability,
  UnifiedModelEntry,
} from '@cindy/model-providers';

import {
  UNIFIED_FLYOUT_GAP,
  buildUnifiedListSections,
  engineOfAgentKind,
  entryMatchesModelId,
  wireModelIdOf,
  buildUnifiedRail,
  computeFlyoutPlacement,
  computeSelectedRowScrollTop,
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
    // 上游把行改成「归一化 id + 每引擎 wire id」后,wireModelId 是必填:测试夹具给一个
    // 与 agent 相关的假 id 即可,本层逻辑不解释它(发请求才用)。
    wireModelId: `wire-${agent}`,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    defaultEffortSource: 'catalog',
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
    candidates: ['claude-code'],
    recommended: 'claude-code',
    nativeAgent: 'claude-code',
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

  it('分组按供应商:每家各自成组,组名 = providerLabel(2026-08-16 裁决,废除「授权登录」合并组)', () => {
    const xdModel = entryOf({
      providerId: 'xd',
      modelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      sortOrder: 1,
    });
    const customModel = entryOf({ providerId: 'custom-a', modelId: 'my-model' });
    const sections = buildUnifiedListSections({
      entries: [opus, gpt, xdModel, customModel],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
    });
    // 供应商决定价格:每家一组、与模型设置页同一套名字,不引入「授权登录」这种第二套口径。
    expect(sections.map((section) => section.group)).toEqual([
      { type: 'provider', providerId: 'anthropic' },
      { type: 'provider', providerId: 'openai' },
      { type: 'provider', providerId: 'xd' },
      { type: 'provider', providerId: 'custom-a' },
    ]);
  });

  it('供应商簇内按 sortOrder 排,簇间保持首见序(不做全局 sortOrder 混排)', () => {
    const opusLate = entryOf({ modelId: 'claude-sonnet-5', sortOrder: 9 });
    const opusEarly = entryOf({ sortOrder: 1 });
    const sections = buildUnifiedListSections({
      // openai 条目先出现 → openai 簇在前;anthropic 簇内 9/1 倒序入参。
      entries: [gpt, opusLate, opusEarly],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
    });
    // openai 先出现 → openai 组在前;anthropic 组内 9/1 入参按 sortOrder 回正。
    expect(sections[0].rows.map((row) => row.entry.modelId)).toEqual(['gpt-5.5']);
    expect(sections[1].rows.map((row) => row.entry.modelId)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('传 providerOrder 时组间按设置页拖动序排,未收录供应商按首见序追加', () => {
    const xdModel = entryOf({
      providerId: 'xd',
      modelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
    });
    const sections = buildUnifiedListSections({
      entries: [opus, gpt, xdModel],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
      // 目录首见序 = anthropic → openai → xd;拖动序点名 openai 提前,
      // 未收录的 xd 按首见序追加,顺序表里的未知 id 直接忽略。
      providerOrder: ['unknown-provider', 'openai', 'anthropic'],
    });
    expect(sections.map((section) => section.group?.providerId)).toEqual([
      'openai',
      'anthropic',
      'xd',
    ]);
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
  // pinned 的适用面是**无主场**(nativeAgent=null)的行:grok / 国产 / BYOM 这类
  // 全场平等的模型,会话内默认落在当前引擎上才是无损直切。
  const dual = entryOf({
    providerId: 'xd',
    modelId: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    candidates: ['claude-code', 'codex'],
    recommended: 'claude-code',
    nativeAgent: null,
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
    nativeAgent: 'codex',
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

  it('主场在别处的行**不跟随** pinned:codex 会话里 Claude 行仍显示 claude-code 主场', () => {
    // Chris 2026-08-14 实测:codex 会话打开面板,Claude 模型整列被标成 Codex,「像被
    // 批量改了配置」,且选中会静默骑 bridge。主场明确的行保持主场,选中走跨引擎切换。
    const claude = entryOf({
      providerId: 'xd',
      candidates: ['claude-code', 'codex'],
      recommended: 'claude-code',
      nativeAgent: 'claude-code',
      capabilities: { 'claude-code': capability('claude-code'), codex: capability('codex') },
    });
    const config = resolveUnifiedRowConfig({ entry: claude, pinnedEngine: 'codex' });
    expect(config.engine).toBe('cc');
    // 主场就是会话引擎的行照常 pinned(等价于推荐,行为不变)。
    const gpt = entryOf({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      candidates: ['claude-code', 'codex'],
      recommended: 'codex',
      nativeAgent: 'codex',
      capabilities: { 'claude-code': capability('claude-code'), codex: capability('codex') },
    });
    expect(resolveUnifiedRowConfig({ entry: gpt, pinnedEngine: 'codex' }).engine).toBe('codex');
    // 显式 override 仍是最高优先:确要「Claude 骑 codex」的,浮层里点过胶囊就照显示。
    expect(
      resolveUnifiedRowConfig({ entry: claude, pinnedEngine: 'codex', engineOverride: 'codex' })
        .engine,
    ).toBe('codex');
  });

  it('forceEngine(选中行)压过 override 与 pinned:显示与正在跑的事实一致', () => {
    const forced = resolveUnifiedRowConfig({
      entry: dual,
      engineOverride: 'codex',
      pinnedEngine: 'codex',
      forceEngine: 'cc',
    });
    expect(forced.engine).toBe('cc');
    // 不在候选内的 forceEngine 忽略(防御脏数据),回落正常链。
    const ignored = resolveUnifiedRowConfig({ entry: codexOnly, forceEngine: 'pi' });
    expect(ignored.engine).toBe('codex');
  });

  it('同引擎视图按**候选**过滤模型(不注入解析器时维持旧行为)', () => {
    const sections = buildUnifiedListSections({
      entries: [dual, codexOnly],
      favorites: [],
      query: '',
      rail: { kind: 'engine', agent: 'claude-code' },
    });
    const ids = sections.flatMap((s) => s.rows.map((r) => r.entry.modelId));
    expect(ids).toEqual(['deepseek/deepseek-v4-pro']);
  });

  // Chris 2026-08-23:同引擎视图的准入是候选,生效引擎只做排序优先级 —— 默认 / 用户选过
  // 本引擎的在前,仅兼容的在后;不再把后者藏掉。
  describe('同引擎视图:生效引擎是排序优先级,不是隐藏条件', () => {
    /** 注入侧的真实形态:调用方给的是 resolveUnifiedRowConfig / resolveFavoriteRowConfig 的 engine。 */
    const engineOfRow = (
      overrides: Record<string, 'cc' | 'codex' | 'pi'> = {},
      pinnedEngine: 'cc' | 'codex' | 'pi' = 'cc',
    ) => (entry: UnifiedModelEntry, favorite?: ModelFavoriteItem) =>
      favorite
        ? resolveFavoriteRowConfig({ entry, item: favorite }).engine
        : resolveUnifiedRowConfig({
            entry,
            pinnedEngine,
            ...(overrides[entry.modelId] ? { engineOverride: overrides[entry.modelId] } : {}),
          }).engine;

    const idsOf = (
      entries: UnifiedModelEntry[],
      effectiveEngineOf: ReturnType<typeof engineOfRow>,
    ): string[] =>
      buildUnifiedListSections({
        entries,
        favorites: [],
        query: '',
        rail: { kind: 'engine', agent: 'claude-code' },
        effectiveEngineOf,
      })
        .flatMap((s) => s.rows)
        .map((row) => row.entry.modelId);

    it('override 指到别的引擎 → 仍显示,排在优先行后面', () => {
      // dual 候选含 cc,用户把它的引擎 override 到了 codex → 兼容段,不是消失。
      expect(idsOf([dual], engineOfRow({ 'deepseek/deepseek-v4-pro': 'codex' }))).toEqual([
        'deepseek/deepseek-v4-pro',
      ]);
      expect(idsOf([dual], engineOfRow())).toEqual(['deepseek/deepseek-v4-pro']);
    });

    it('override 指到当前引擎 → 即使主场在别处也排进优先段', () => {
      const gptDual = entryOf({
        providerId: 'xd',
        modelId: 'gpt-5.5',
        candidates: ['claude-code', 'codex'],
        recommended: 'codex',
        nativeAgent: 'codex',
        capabilities: { 'claude-code': capability('claude-code'), codex: capability('codex') },
      });
      const guest = entryOf({
        providerId: 'xd',
        modelId: 'gpt-5.6',
        candidates: ['claude-code', 'codex'],
        recommended: 'codex',
        nativeAgent: 'codex',
        capabilities: { 'claude-code': capability('claude-code'), codex: capability('codex') },
      });
      expect(idsOf([guest, gptDual], engineOfRow({ 'gpt-5.5': 'cc' }))).toEqual([
        'gpt-5.5',
        'gpt-5.6',
      ]);
    });

    it('主场在别处的行排在生效引擎=当前引擎的行后面', () => {
      const gptDual = entryOf({
        providerId: 'xd',
        modelId: 'gpt-5.5',
        candidates: ['claude-code', 'codex'],
        recommended: 'codex',
        nativeAgent: 'codex',
        capabilities: { 'claude-code': capability('claude-code'), codex: capability('codex') },
      });
      // cc 会话里:dual 无主场被 pinned 到 cc(优先),gpt 主场在 codex(兼容)。
      expect(idsOf([gptDual, dual], engineOfRow())).toEqual([
        'deepseek/deepseek-v4-pro',
        'gpt-5.5',
      ]);
    });

    it('含优先行的供应商组排在纯兼容供应商组前面,即使 providerOrder 相反', () => {
      const opus = entryOf({
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        candidates: ['claude-code', 'pi'],
        recommended: 'claude-code',
        nativeAgent: 'claude-code',
        capabilities: {
          'claude-code': capability('claude-code'),
          pi: capability('pi'),
        },
      });
      const grok = entryOf({
        providerId: 'xai',
        modelId: 'grok-4.6',
        candidates: ['pi'],
        recommended: 'pi',
        nativeAgent: null,
        capabilities: { pi: capability('pi') },
      });
      const sections = buildUnifiedListSections({
        entries: [opus, grok],
        favorites: [],
        query: '',
        rail: { kind: 'engine', agent: 'pi' },
        effectiveEngineOf: (entry) => engineOfAgentKind(entry.recommended),
        providerOrder: ['anthropic', 'xai'],
      });
      expect(sections.flatMap((s) => s.rows.map((row) => row.entry.modelId))).toEqual([
        'grok-4.6',
        'claude-opus-5',
      ]);
    });

    it('无主场的行照常跟随 pinnedEngine 通过过滤(§2.1 例外不受影响)', () => {
      expect(dual.nativeAgent).toBeNull();
      expect(idsOf([dual], engineOfRow({}, 'cc'))).toEqual(['deepseek/deepseek-v4-pro']);
    });

    it('收藏解析回落到别家(条目存的引擎掉出候选)→ 该收藏行同样不显示', () => {
      // 条目存 cc,但这个模型只在 codex 有条目 → resolveFavoriteRowConfig 回落 codex。
      const staleFav = favoriteOf({
        uid: 'fav-9',
        providerId: 'xd',
        modelId: 'codex/gpt-5.5',
        agent: 'cc',
      });
      const withResolver = buildUnifiedListSections({
        entries: [codexOnly],
        favorites: [staleFav],
        query: '',
        rail: { kind: 'engine', agent: 'claude-code' },
        effectiveEngineOf: engineOfRow(),
      });
      expect(withResolver.some((s) => s.kind === 'favorites')).toBe(false);
      // 不注入解析器时维持旧行为(只看条目自己存的引擎)—— 旧断言不被本次改动掀翻。
      const withoutResolver = buildUnifiedListSections({
        entries: [codexOnly],
        favorites: [staleFav],
        query: '',
        rail: { kind: 'engine', agent: 'claude-code' },
      });
      expect(withoutResolver[0]?.kind).toBe('favorites');
    });

    it('收藏解析回落到**当前引擎**(条目存的引擎掉出候选)→ 该收藏行必须显示', () => {
      // 2026-08-19 review P2:此前先按 item.agent 硬排除,会把这条错杀出「无损」视图 ——
      // 它存的 codex 已不在候选里,解析回落到 cc(= 当前会话引擎),点它无损、画出来也是
      // cc。注入解析器时判据只有「解析后的生效引擎」这一个,与模型行同构。
      const ccOnly = entryOf({
        providerId: 'xd',
        modelId: 'claude-opus-5',
        candidates: ['claude-code'],
        recommended: 'claude-code',
        nativeAgent: 'claude-code',
        capabilities: { 'claude-code': capability('claude-code') },
      });
      const staleCodexFav = favoriteOf({
        uid: 'fav-10',
        providerId: 'xd',
        modelId: 'claude-opus-5',
        agent: 'codex',
      });
      const sections = buildUnifiedListSections({
        entries: [ccOnly],
        favorites: [staleCodexFav],
        query: '',
        rail: { kind: 'engine', agent: 'claude-code' },
        effectiveEngineOf: engineOfRow(),
      });
      expect(sections[0]?.kind).toBe('favorites');
      expect(sections[0]?.rows.map((row) => row.favorite?.uid)).toEqual(['fav-10']);
    });

    it('「全部」视图不受生效引擎影响(跨引擎是显式入口)', () => {
      const sections = buildUnifiedListSections({
        entries: [dual, codexOnly],
        favorites: [],
        query: '',
        rail: { kind: 'all' },
        effectiveEngineOf: engineOfRow({ 'deepseek/deepseek-v4-pro': 'codex' }),
      });
      expect(sections.flatMap((s) => s.rows).map((r) => r.entry.modelId)).toEqual([
        'deepseek/deepseek-v4-pro',
        'codex/gpt-5.5',
      ]);
    });
  });

  it('同引擎视图里收藏按**条目自己存的引擎**过滤', () => {
    const favCc = favoriteOf({
      uid: 'fav-1',
      providerId: 'xd',
      modelId: 'deepseek/deepseek-v4-pro',
      agent: 'cc',
    });
    const favCodex = favoriteOf({
      uid: 'fav-2',
      providerId: 'xd',
      modelId: 'deepseek/deepseek-v4-pro',
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
    expect(ids).toEqual(['deepseek/deepseek-v4-pro', 'codex/gpt-5.5']);
  });
});

describe('buildUnifiedRail', () => {
  it('★ 常驻,供应商按行首次出现序排列', () => {
    const entries = [
      entryOf({ providerId: 'xd', modelId: 'a' }),
      entryOf({ providerId: 'anthropic', modelId: 'b' }),
      entryOf({ providerId: 'xd', modelId: 'c' }),
    ];
    // ★ 常驻(2026-08-13 裁决:空收藏也显示,点进去看引导空态,不再按有无收藏隐藏)。
    expect(buildUnifiedRail(entries)).toEqual([
      { kind: 'favorites' },
      { kind: 'all' },
      { kind: 'provider', providerId: 'xd' },
      { kind: 'provider', providerId: 'anthropic' },
    ]);
    expect(buildUnifiedRail(entries)[0]).toEqual({ kind: 'favorites' });
  });

  it('会话内多一格「同引擎」,位置在 ★ 之下、全部之上', () => {
    const entries = [entryOf({ providerId: 'xd', modelId: 'a' })];
    expect(buildUnifiedRail(entries, 'codex')).toEqual([
      { kind: 'favorites' },
      { kind: 'engine', agent: 'codex' },
      { kind: 'all' },
      { kind: 'provider', providerId: 'xd' },
    ]);
    // 草稿场景不出现这一格。
    expect(buildUnifiedRail(entries).some((item) => item.kind === 'engine')).toBe(false);
  });

  it('传 providerOrder 时供应商图标按设置页拖动序排,未收录供应商按首见序追加', () => {
    const entries = [
      entryOf({ providerId: 'xd', modelId: 'a' }),
      entryOf({ providerId: 'anthropic', modelId: 'b' }),
      entryOf({ providerId: 'openai', modelId: 'c' }),
    ];
    expect(buildUnifiedRail(entries, undefined, ['openai', 'xd'])).toEqual([
      { kind: 'favorites' },
      { kind: 'all' },
      { kind: 'provider', providerId: 'openai' },
      { kind: 'provider', providerId: 'xd' },
      { kind: 'provider', providerId: 'anthropic' },
    ]);
  });
});

describe('computeSelectedRowScrollTop(选中行居中,Chris 2026-08-19)', () => {
  const base = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000, headerInset: 0 };

  it('把选中行的中心对齐到可视区中心', () => {
    // 行 [1000,1044] → 中心 1022;可视区高 400 → 目标 scrollTop = 1022 - 200 = 822。
    expect(
      computeSelectedRowScrollTop({ ...base, rowTop: 1000, rowBottom: 1044 }),
    ).toEqual({ scrollTop: 822, oversized: false });
  });

  it('列表头部的行夹到 0(不能负滚),尾部的行夹到 scrollHeight - clientHeight', () => {
    expect(computeSelectedRowScrollTop({ ...base, rowTop: 8, rowBottom: 52 }).scrollTop).toBe(0);
    expect(
      computeSelectedRowScrollTop({ ...base, rowTop: 1950, rowBottom: 1994 }).scrollTop,
    ).toBe(1600);
  });

  it('题头实底从可视高度里扣掉:居中位置随之下移半条题头', () => {
    // badge 题头盖住顶部 38px:可视区 [scrollTop+38, +400),中心比无题头时低 (38+38/2)?
    // 目标 = 中心 - inset - (clientHeight - inset)/2 = 1022 - 38 - 181 = 803。
    expect(
      computeSelectedRowScrollTop({ ...base, headerInset: 38, rowTop: 1000, rowBottom: 1044 })
        .scrollTop,
    ).toBe(803);
  });

  it('行比可视区还高 → 顶对齐并标 oversized(调用方据此一次收工,防振荡)', () => {
    const result = computeSelectedRowScrollTop({
      ...base,
      clientHeight: 40,
      rowTop: 1000,
      rowBottom: 1080,
    });
    expect(result.oversized).toBe(true);
    expect(result.scrollTop).toBe(1000);
  });

  it('内容不足以滚动时恒返回 0(morph 首帧的极矮容器不会算出负值)', () => {
    expect(
      computeSelectedRowScrollTop({
        scrollTop: 0,
        clientHeight: 12,
        scrollHeight: 12,
        headerInset: 0,
        rowTop: 0,
        rowBottom: 44,
      }).scrollTop,
    ).toBe(0);
  });
});

describe('computeFlyoutPlacement', () => {
  const panel = { top: 100, bottom: 500, left: 400, right: 800 };
  const size = { width: 264, height: 300 };
  const viewport = { width: 1440, height: 900 };

  it('默认贴面板左外侧,顶端跟随锚点行', () => {
    const placement = computeFlyoutPlacement({
      anchor: { top: 150, bottom: 190, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(placement.side).toBe('left');
    expect(placement.left).toBe(400 - UNIFIED_FLYOUT_GAP - 264);
    expect(placement.top).toBe(150 - 12);
  });

  it('左边放不下时翻到右侧', () => {
    const placement = computeFlyoutPlacement({
      anchor: { top: 240, bottom: 280, left: 20, right: 380 },
      panel: { ...panel, left: 20, right: 380 },
      size,
      viewport,
    });
    expect(placement.side).toBe('right');
    expect(placement.left).toBe(380 + UNIFIED_FLYOUT_GAP);
  });

  it('垂直钳制在面板内:底部行 → 与面板底对齐,顶部行不高过面板顶(设计稿 flyFinish)', () => {
    // 锚点在面板底部附近:浮层底不越过面板底(500),top = 500 - 300 = 200。
    const low = computeFlyoutPlacement({
      anchor: { top: 470, bottom: 500, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(low.top).toBe(500 - 300);

    // 锚点在面板顶(带 rowOffset 会高过面板顶):钳回面板顶(100)。
    const high = computeFlyoutPlacement({
      anchor: { top: 100, bottom: 140, left: 410, right: 780 },
      panel,
      size,
      viewport,
    });
    expect(high.top).toBe(100);
  });

  it('面板贴近屏幕边缘时视口安全区仍兜底', () => {
    // 面板底伸到视口外:面板钳制想给 top=880-300=580… 视口钳制把它压回 900-300-8。
    const placement = computeFlyoutPlacement({
      anchor: { top: 860, bottom: 880, left: 410, right: 780 },
      panel: { ...panel, top: 400, bottom: 1000 },
      size,
      viewport,
    });
    expect(placement.top).toBe(900 - 300 - 8);
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

/**
 * 合并行(归一化行身份 + 每引擎 wire id)。这一层最容易做错的是**两个 id 的分工**:
 * 行身份用来「记住这一行」(anchor / override / 收藏),wire id 用来「发出去 / 读写既有
 * 按 wire id 索引的表」。混用不会立刻崩,而是悄悄写出一份谁也读不到的记忆、或者让选中的
 * 模型在列表里不高亮。
 */
describe('合并行:行身份 vs wire id', () => {
  const merged = entryOf({
    providerId: 'openai',
    modelId: 'gpt-5.6',
    displayName: 'GPT-5.6',
    candidates: ['claude-code', 'codex'],
    recommended: 'codex',
    nativeAgent: 'codex',
    capabilities: {
      // 同一逻辑模型:codex 上是 root 条目,cc 上是 bridge 壳 —— wire id 不同。
      codex: capability('codex', { wireModelId: 'gpt-5.6' }),
      'claude-code': capability('claude-code', { wireModelId: 'chatgpt/gpt-5.6' }),
    },
  });

  it('wireModelIdOf 按引擎取真实要发的 id,缺失回落行身份', () => {
    expect(wireModelIdOf(merged, 'codex')).toBe('gpt-5.6');
    expect(wireModelIdOf(merged, 'claude-code')).toBe('chatgpt/gpt-5.6');
    // pi 不在候选 → 没有能力条目 → 回落行身份(调用方不该拿它发请求,但不能崩)。
    expect(wireModelIdOf(merged, 'pi')).toBe('gpt-5.6');
  });

  it('entryMatchesModelId 同时认行身份与任一引擎的 wire id', () => {
    expect(entryMatchesModelId(merged, 'gpt-5.6')).toBe(true);
    expect(entryMatchesModelId(merged, 'chatgpt/gpt-5.6')).toBe(true);
    expect(entryMatchesModelId(merged, 'gpt-5.5')).toBe(false);
    expect(entryMatchesModelId(merged, null)).toBe(false);
  });

  it('生效配置带上该引擎的 wireModelId(切引擎即换 wire id)', () => {
    expect(resolveUnifiedRowConfig({ entry: merged }).wireModelId).toBe('gpt-5.6');
    expect(
      resolveUnifiedRowConfig({ entry: merged, engineOverride: 'cc' }).wireModelId,
    ).toBe('chatgpt/gpt-5.6');
    expect(
      resolveFavoriteRowConfig({ entry: merged, item: favoriteOf({ agent: 'cc' }) }).wireModelId,
    ).toBe('chatgpt/gpt-5.6');
  });

  it('老收藏存的是某引擎的 wire id 时仍能认出这一行(升级不丢收藏)', () => {
    const legacy = favoriteOf({
      uid: 'fav-legacy',
      providerId: 'openai',
      modelId: 'chatgpt/gpt-5.6',
      agent: 'cc',
    });
    const sections = buildUnifiedListSections({
      entries: [merged],
      favorites: [legacy],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections[0].kind).toBe('favorites');
    expect(sections[0].rows[0].entry.modelId).toBe('gpt-5.6');
  });
});

describe('默认种子置顶与原生底座排序', () => {
  const seed = entryOf({
    providerId: 'xd',
    modelId: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    group: 'china',
    sortOrder: 9,
  });
  const opus = entryOf({ group: 'anthropic', sortOrder: 1 });
  const gpt = entryOf({
    providerId: 'xd',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    group: 'gpt',
    sortOrder: 2,
    candidates: ['claude-code', 'codex'],
    recommended: 'claude-code',
    nativeAgent: 'codex',
    capabilities: {
      'claude-code': capability('claude-code'),
      codex: capability('codex'),
    },
  });

  it('没有「默认」小节:默认推荐改以种子收藏交付,列表只有收藏与供应商分组', () => {
    // Chris 2026-08-16 裁决:去掉默认小节;seed 行留在自己的供应商组里。
    const sections = buildUnifiedListSections({
      entries: [opus, gpt, seed],
      favorites: [favoriteOf()],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections.every((section) => section.kind === 'favorites' || section.kind === 'group')).toBe(true);
    const grouped = sections.filter((s) => s.kind === 'group').flatMap((s) => s.rows.map((r) => r.entry.modelId));
    expect(grouped).toContain('deepseek-v4-pro');
  });

  it('同引擎视图把原生底座 == 该引擎的行排在仅兼容的行前面', () => {
    const sections = buildUnifiedListSections({
      // 入参顺序:opus(native cc)在前,gpt(native codex)在后。
      entries: [opus, gpt],
      favorites: [],
      query: '',
      rail: { kind: 'engine', agent: 'codex' },
    });
    // codex 视图:native=codex 的 GPT 组先出现;opus 的 cc 原生行仅兼容 → 排在后面。
    // (opus 只有 cc 候选,在 codex 视图里会被准入过滤掉,故这里只剩 GPT 一组。)
    expect(sections.flatMap((s) => s.rows.map((r) => r.entry.modelId))).toEqual(['gpt-5.5']);

    const bothCandidates = entryOf({
      providerId: 'xd',
      modelId: 'claude-opus-5',
      displayName: 'Opus 5',
      group: 'anthropic',
      sortOrder: 1,
      candidates: ['claude-code', 'codex'],
      recommended: 'claude-code',
      nativeAgent: 'claude-code',
      capabilities: {
        'claude-code': capability('claude-code'),
        codex: capability('codex'),
      },
    });
    const mixed = buildUnifiedListSections({
      entries: [bothCandidates, gpt],
      favorites: [],
      query: '',
      rail: { kind: 'engine', agent: 'codex' },
    });
    // sortOrder 上 Opus(1)在 GPT(2)之前,但 codex 会话里原生 codex 的 GPT 该排前面。
    expect(mixed.flatMap((s) => s.rows.map((r) => r.entry.modelId))).toEqual([
      'gpt-5.5',
      'claude-opus-5',
    ]);
  });

  it('新会话全量视图不按原生底座重排(服务端编排说了算)', () => {
    const sections = buildUnifiedListSections({
      entries: [opus, gpt],
      favorites: [],
      query: '',
      rail: { kind: 'all' },
    });
    expect(sections.flatMap((s) => s.rows.map((r) => r.entry.modelId))).toEqual([
      'claude-opus-5',
      'gpt-5.5',
    ]);
  });
});

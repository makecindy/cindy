/**
 * sourceSwitch.test.ts
 * ---------------------------------------------------------------------------
 * 回归 components/new-chat/sourceSwitch.ts 的纯逻辑:
 *   - categorize:按 id 前缀归类
 *   - resolveSourceSwitch:切来源时「目标 model / effort」的决策优先级
 *       1. 记忆命中(仍被 offer + 当前 agent 可见)→ 恢复 model + effort
 *       2. 记忆命中但与当前模型相同 → 不动模型,只带回 effort
 *       3. 记忆的 effort 已不被目标模型支持 → 只恢复 model,effort 留空
 *       4. 无记忆 + 当前模型不被新来源 offer → reconcile 到 CATEGORY_ORDER 首个可用
 *       5. 无记忆 + 当前模型仍被 offer → 全不动
 *       6. 记忆 stale(模型不被 offer / 不可见)→ 回退到 4/5 规则
 *
 * 纯函数 + 仅依赖 @cindy/model-providers 的 providerOffersModel(agent-scoped),可在 node env 直接测。
 * 本组用例全部以 claude-code 会话视角(visibleModels = claude-* )验证。
 */

import { describe, it, expect } from 'vitest';

import type { AgentKind, ProviderView } from '@cindy/model-providers';
import {
  buildProviderSections,
  categorize,
  groupOf,
  groupModelsForDisplay,
  isSelectedSourceDisconnected,
  resolveEffort,
  resolveProviderSwitchEffort,
  resolveSourceSwitch,
  type SwitchModel,
} from '@/components/new-chat/sourceSwitch';
import type { Effort } from '@/lib/userPreferences.types';

const AGENT: AgentKind = 'claude-code';

/** 最小 ProviderView —— resolveSourceSwitch 只读 provider.models[agent][].id。 */
function provider(id: string, modelIds: string[]): ProviderView {
  return {
    id,
    name: id,
    models: { [AGENT]: modelIds.map((mid) => ({ id: mid })) },
  } as unknown as ProviderView;
}

const models = (...defs: Array<[string, string[]]>): SwitchModel[] =>
  defs.map(([id, efforts]) => ({ id, efforts }));

describe('categorize', () => {
  it('按 id 前缀归类', () => {
    expect(categorize('claude-opus-4-8')).toBe('anthropic');
    expect(categorize('gpt-5.4')).toBe('gpt');
    expect(categorize('codex/gpt-5.4')).toBe('gpt-budget');
    expect(categorize('gemini-3-pro')).toBe('google');
    expect(categorize('moonshotai/kimi-k2')).toBe('china');
  });
});

describe('groupOf — 数据优先,前缀兜底', () => {
  it('合法 group 字段优先于 id 前缀', () => {
    // id 看着像 gpt,但目录把它归到 china → 以 group 为准
    expect(groupOf({ id: 'gpt-weird', group: 'china' })).toBe('china');
    expect(groupOf({ id: 'codex/gpt-5.5', group: 'gpt-budget' })).toBe('gpt-budget');
  });
  it('无 group / 未知 group → 回退 categorize', () => {
    expect(groupOf({ id: 'claude-opus-4-8' })).toBe('anthropic');
    expect(groupOf({ id: 'gemini-3-flash' })).toBe('google');
    expect(groupOf({ id: 'gpt-5.5', group: 'mistral' })).toBe('gpt'); // 未知 group 忽略,按前缀
  });
});

describe('groupModelsForDisplay — sortOrder 升序 + group 分桶 + 桶序按最小 sortOrder', () => {
  it('按 sortOrder 排序并分桶,桶序 = 桶内首个出现序', () => {
    const out = groupModelsForDisplay([
      { id: 'qwen/q', group: 'china', sortOrder: 40 },
      { id: 'gpt-5.5', group: 'gpt', sortOrder: 20 },
      { id: 'codex/gpt-5.5', group: 'gpt-budget', sortOrder: 10 },
      { id: 'claude-opus-4-8', group: 'anthropic', sortOrder: 0 },
      { id: 'gpt-5.4', group: 'gpt', sortOrder: 21 },
    ]);
    // 桶序:anthropic(0) → gpt-budget(10) → gpt(20) → china(40)
    expect(out.map((g) => g.category)).toEqual(['anthropic', 'gpt-budget', 'gpt', 'china']);
    // gpt 桶内按 sortOrder:5.5(20) 在 5.4(21) 前
    expect(out.find((g) => g.category === 'gpt')!.models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('缺 sortOrder 的排末尾;group 缺省回退前缀', () => {
    const out = groupModelsForDisplay([
      { id: 'gpt-5.5', sortOrder: 20 }, // 无 group → 前缀 gpt
      { id: 'claude-opus-4-8' }, // 无 group 无 sortOrder → anthropic,排末尾
    ]);
    expect(out.map((g) => g.category)).toEqual(['gpt', 'anthropic']);
  });
});

describe('resolveSourceSwitch', () => {
  const visible = models(
    ['claude-opus-4-8', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high']],
    ['claude-haiku-4-5', []],
  );

  it('记忆命中(与当前模型不同):恢复 model + effort', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-opus-4-8', 'claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'claude-sonnet-4-6',
      visibleModels: visible,
      remembered: { model: 'claude-opus-4-8', effort: 'max' },
    });
    expect(r).toEqual({ reconciledModelId: 'claude-opus-4-8', reconciledEffort: 'max' });
  });

  it('记忆命中(与当前模型相同):不动模型,只带回 effort', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-opus-4-8']),
      agent: AGENT,
      currentModelId: 'claude-opus-4-8',
      visibleModels: visible,
      remembered: { model: 'claude-opus-4-8', effort: 'high' },
    });
    expect(r.reconciledModelId).toBeUndefined();
    expect(r.reconciledEffort).toBe('high');
  });

  it('记忆的 effort 已不被目标模型支持:只恢复 model,effort 留空', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'claude-opus-4-8',
      visibleModels: visible,
      // sonnet 不支持 'max'
      remembered: { model: 'claude-sonnet-4-6', effort: 'max' },
    });
    expect(r.reconciledModelId).toBe('claude-sonnet-4-6');
    expect(r.reconciledEffort).toBeUndefined();
  });

  it('无记忆 + 当前模型不被新来源 offer:reconcile 到 CATEGORY_ORDER 首个可用', () => {
    const r = resolveSourceSwitch({
      // anthropic 类排在最前;两者都 offer 时取 opus(visible 中 opus 在前)
      provider: provider('anthropic', ['claude-sonnet-4-6', 'claude-opus-4-8']),
      agent: AGENT,
      currentModelId: 'gpt-5.4', // 不被 anthropic offer
      visibleModels: visible,
      remembered: undefined,
    });
    expect(r.reconciledModelId).toBe('claude-opus-4-8');
    expect(r.reconciledEffort).toBeUndefined();
  });

  it('reconcile 候选按 mode 准入过滤(issue #882 review):mode 非 chat 且 id 落 categorize 兜底组时不被选中', () => {
    // 故意造一个 id 不含任何非聊天关键词、只能靠 categorize 兜底落 'china' 的场景:
    // 旧实现用纯 id 正则的 categorize 判定候选分组,'china' 在 CHAT_VENDOR_CATEGORY_ORDER
    // 里、会被当成有效候选;换成 mode 优先的 classifyModel 后,mode='embedding' 权威判定
    // 为非聊天,不再落进任何厂商组,候选列表为空。该来源只 offer 这一个模型,
    // 没有别的候选可选 —— 必须不选中它、保持模型不变,而不是"退而求其次"选一个非聊天模型。
    const r = resolveSourceSwitch({
      provider: provider('xd', ['some-vendor-neutral-id']),
      agent: AGENT,
      currentModelId: 'gpt-5.4', // 不被该来源 offer,触发 reconcile
      visibleModels: [{ id: 'some-vendor-neutral-id', efforts: [], mode: 'embedding' }],
      remembered: undefined,
    });
    expect(r.reconciledModelId).toBeUndefined();
  });

  it('候选校验目标 provider 自己的那份数据,不是 visibleModels 并集里的同 id 条目(issue #882,2026-07 review:fresh evidence——并集条目可能来自另一个 provider 的聊天分类,和目标 provider 自己的 mode 不一致)', () => {
    // 目标 provider('xd')上 'shared-id' 是非聊天(image_generation);但 visibleModels
    // 并集里同 id 的条目标了 mode='chat'(模拟它是从另一个 provider 的聊天分类合并过来的)。
    const targetProviderWithNonChatCopy = {
      id: 'xd',
      name: 'xd',
      models: { [AGENT]: [{ id: 'shared-id', mode: 'image_generation' }] },
    } as unknown as ProviderView;

    const r = resolveSourceSwitch({
      provider: targetProviderWithNonChatCopy,
      agent: AGENT,
      currentModelId: 'gpt-5.4', // 不被 xd offer,触发 reconcile
      visibleModels: [{ id: 'shared-id', efforts: ['low', 'high'], mode: 'chat' }],
      remembered: undefined,
    });
    // 不能选中它——目标 provider 自己的这份条目不是聊天模型,即便并集里同 id 条目标了 chat。
    expect(r.reconciledModelId).toBeUndefined();
  });

  it('记忆命中校验目标 provider 自己的那份数据(同上,remembered 分支)', () => {
    const targetProviderWithNonChatCopy = {
      id: 'xd',
      name: 'xd',
      models: { [AGENT]: [{ id: 'shared-id', mode: 'image_generation' }] },
    } as unknown as ProviderView;

    const r = resolveSourceSwitch({
      provider: targetProviderWithNonChatCopy,
      agent: AGENT,
      currentModelId: 'gpt-5.4',
      visibleModels: [{ id: 'shared-id', efforts: ['low', 'high'], mode: 'chat' }],
      remembered: { model: 'shared-id', effort: 'high' },
    });
    // 记忆指向的模型在目标 provider 上不是聊天模型 → 记忆失效,不恢复它;也没有别的候选。
    expect(r.reconciledModelId).toBeUndefined();
    expect(r.reconciledEffort).toBeUndefined();
  });

  it('无记忆 + 当前模型仍被 offer:全不动', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-opus-4-8', 'claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'claude-opus-4-8',
      visibleModels: visible,
      remembered: undefined,
    });
    expect(r).toEqual({ reconciledModelId: undefined, reconciledEffort: undefined });
  });

  it('记忆 stale(模型不再被该来源 offer):回退到 reconcile', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'gpt-5.4',
      visibleModels: visible,
      // 记忆里是 opus,但该来源现在只 offer sonnet → 记忆失效
      remembered: { model: 'claude-opus-4-8', effort: 'max' },
    });
    expect(r.reconciledModelId).toBe('claude-sonnet-4-6');
    expect(r.reconciledEffort).toBeUndefined();
  });

  it('记忆模型不在当前 agent 可见列表(visibleModels)中:视为失效', () => {
    const r = resolveSourceSwitch({
      provider: provider('xd', ['gpt-5.4', 'claude-opus-4-8']),
      agent: AGENT,
      currentModelId: 'claude-opus-4-8',
      visibleModels: visible, // 只有 claude-* 可见(cc agent)
      // xd offer gpt-5.4,但当前 cc agent 看不到它 → 不恢复
      remembered: { model: 'gpt-5.4', effort: 'high' },
    });
    expect(r.reconciledModelId).toBeUndefined();
    expect(r.reconciledEffort).toBeUndefined();
  });

  it('isVisible:reconcile 跳过被用户隐藏的模型,落到下一个可见的', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-opus-4-8', 'claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'gpt-5.4', // 不被 offer → 触发 reconcile
      visibleModels: visible,
      remembered: undefined,
      // opus 被用户隐藏 → 应跳过,落到 sonnet
      isVisible: (id) => id !== 'claude-opus-4-8',
    });
    expect(r.reconciledModelId).toBe('claude-sonnet-4-6');
  });

  it('isVisible:记忆的模型已被隐藏 → 视为失效,回退 reconcile', () => {
    const r = resolveSourceSwitch({
      provider: provider('anthropic', ['claude-opus-4-8', 'claude-sonnet-4-6']),
      agent: AGENT,
      currentModelId: 'gpt-5.4', // 不被 offer
      visibleModels: visible,
      remembered: { model: 'claude-opus-4-8', effort: 'max' }, // 记忆是 opus
      isVisible: (id) => id !== 'claude-opus-4-8', // 但 opus 已隐藏
    });
    expect(r.reconciledModelId).toBe('claude-sonnet-4-6');
    expect(r.reconciledEffort).toBeUndefined();
  });
});

describe('resolveEffort —— 选中模型后 effort 落档优先级', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('无 effort 档(efforts 为空)→ 始终 low(占位,UI 不显示)', () => {
    expect(
      resolveEffort({ efforts: [], defaultEffort: null, activeEffort: 'high', preferred: 'max' }),
    ).toBe('low');
  });

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max',
        providerEffort: 'medium',
        rememberedEffort: 'xhigh',
      }),
    ).toBe('max');
  });

  it('preferred 不受支持 → 跳过,落到 providerEffort((agent,provider,model) 精确记忆)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max', // 不在 efforts
        providerEffort: 'medium',
        rememberedEffort: 'high',
      }),
    ).toBe('medium');
  });

  it('providerEffort > rememberedEffort:同模型跨来源记忆精确恢复', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        providerEffort: 'xhigh',
        rememberedEffort: 'medium',
      }),
    ).toBe('xhigh');
  });

  it('无 provider 记忆 → 落到 per-model rememberedEffort', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        rememberedEffort: 'medium',
      }),
    ).toBe('medium');
  });

  it('记忆都不受支持 → 沿用当前 activeEffort(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'medium',
        providerEffort: 'max', // 不在 efforts
        rememberedEffort: 'xhigh', // 不在 efforts
      }),
    ).toBe('medium');
  });

  it('全无可用 → 模型默认 defaultEffort', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        activeEffort: 'max', // 不在 efforts
      }),
    ).toBe('high');
  });

  it('defaultEffort 为 null → 落 efforts 首档(catalog 病态数据防御,现实数据不可达)', () => {
    expect(
      resolveEffort({
        efforts: ['medium', 'high'],
        defaultEffort: null,
        activeEffort: 'max', // 不在 efforts
      }),
    ).toBe('medium');
  });

  it('自定义供应商首次选中(无任何记忆,activeEffort 来自上个模型且受支持)→ 沿用', () => {
    // 自定义模型 catalog 默认档 high;若用户从一个 high 的模型切过来,沿用 high。
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
        activeEffort: 'high',
      }),
    ).toBe('high');
  });
});

describe('resolveProviderSwitchEffort —— 同模型只切来源(严格 per-供应商,不沿用 activeEffort)', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'medium',
        preferred: 'max',
        fallbackEffort: 'low',
      }),
    ).toBe('max');
  });

  it('新来源有该模型记忆 → 恢复 providerEffort', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'xhigh',
        fallbackEffort: 'low',
      }),
    ).toBe('xhigh');
  });

  it('【bug 回归】新来源无记忆 → 落模型默认,绝不沿用 fallback(=当前来源 activeEffort)', () => {
    // 这正是「改了 A 来源 Opus 的 effort(=fallback max),选 B 来源同名 Opus」的场景:
    // B 没记忆 → 必须落到模型默认 high,而不是继承 A 的 max。
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: undefined,
        fallbackEffort: 'max', // = A 来源当前档,绝不能被选中
      }),
    ).toBe('high');
  });

  it('providerEffort 不受目标模型支持 → 跳过,落模型默认', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        providerEffort: 'max', // 不在 efforts
        fallbackEffort: 'low',
      }),
    ).toBe('high');
  });

  it('无记忆、defaultEffort 为 null → efforts 首档(仍不取 fallback)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['medium', 'high'],
        defaultEffort: null,
        fallbackEffort: 'max',
      }),
    ).toBe('medium');
  });

  it('模型无 effort 档(efforts 为空)→ fallbackEffort(占位,UI 不显示 effort)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: [],
        defaultEffort: null,
        fallbackEffort: 'high',
      }),
    ).toBe('high');
  });
});

describe('buildProviderSections —— 单栏按供应商分段', () => {
  // 造带 name/efforts 的最小 catalog model(buildProviderSections 读 name 做搜索 + 展示)。
  const m = (id: string, name?: string) => ({
    id,
    name: name ?? id,
    contextWindow: 200_000,
    efforts: ['low', 'high'] as Effort[],
    defaultEffort: 'high' as Effort,
  });
  /** 最小 ProviderView —— buildProviderSections 只读 provider.models[agent][].{id,name,...}。 */
  const prov = (id: string, modelDefs: Array<ReturnType<typeof m>>): ProviderView =>
    ({ id, name: id, models: { [AGENT]: modelDefs } }) as unknown as ProviderView;

  const allVisible = () => true;

  it('按供应商顺序分段,组内保留 catalog 顺序(不二次排序)', () => {
    const sections = buildProviderSections({
      providers: [
        prov('xd', [m('claude-opus-4-8', 'Opus 4.8'), m('gpt-5.5', 'GPT-5.5')]),
        prov('anthropic', [m('claude-opus-4-8', 'Opus 4.8'), m('claude-sonnet-4-6', 'Sonnet 4.6')]),
      ],
      agent: AGENT,
      isVisible: allVisible,
    });
    expect(sections.map((s) => s.provider.id)).toEqual(['xd', 'anthropic']);
    expect(sections[0].models.map((x) => x.id)).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    expect(sections[1].models.map((x) => x.id)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });

  it('同一模型被多个供应商 offer → 各供应商段各出现一次', () => {
    const sections = buildProviderSections({
      providers: [
        prov('xd', [m('claude-opus-4-8')]),
        prov('anthropic', [m('claude-opus-4-8')]),
      ],
      agent: AGENT,
      isVisible: allVisible,
    });
    expect(sections).toHaveLength(2);
    expect(sections[0].models[0].id).toBe('claude-opus-4-8');
    expect(sections[1].models[0].id).toBe('claude-opus-4-8');
  });

  it('isVisible 过滤隐藏模型;但当前选中(供应商,模型)即便隐藏也保留', () => {
    const sections = buildProviderSections({
      providers: [prov('xd', [m('claude-opus-4-8'), m('claude-sonnet-4-6')])],
      agent: AGENT,
      selectedModelId: 'claude-opus-4-8',
      selectedProviderId: 'xd',
      // 两个都"隐藏",只有选中的 opus 该保留
      isVisible: () => false,
    });
    expect(sections[0].models.map((x) => x.id)).toEqual(['claude-opus-4-8']);
  });

  it('query 命中 displayName / id(大小写不敏感)', () => {
    const providers = [prov('xd', [m('claude-opus-4-8', 'Opus 4.8'), m('gpt-5.5', 'GPT-5.5')])];
    expect(
      buildProviderSections({ providers, agent: AGENT, isVisible: allVisible, query: 'opus' })[0].models.map(
        (x) => x.id,
      ),
    ).toEqual(['claude-opus-4-8']);
    // 命中 id 前缀
    expect(
      buildProviderSections({ providers, agent: AGENT, isVisible: allVisible, query: 'gpt-5' })[0].models.map(
        (x) => x.id,
      ),
    ).toEqual(['gpt-5.5']);
  });

  it('过滤后空的供应商段被丢弃;单供应商仍返回一个段', () => {
    const sections = buildProviderSections({
      providers: [prov('xd', [m('gpt-5.5')]), prov('anthropic', [m('claude-opus-4-8')])],
      agent: AGENT,
      isVisible: allVisible,
      query: 'gpt', // anthropic 段过滤后为空
    });
    expect(sections.map((s) => s.provider.id)).toEqual(['xd']);
  });
});

describe('isSelectedSourceDisconnected — 会话显式来源断连判定', () => {
  const MODEL_ID = 'claude-opus-4-8';
  /** 最小 ProviderView —— 来源必须同时 connected、匹配 agent 且提供当前模型。 */
  const view = (id: string, connected: boolean, agents: AgentKind[] = [AGENT]): ProviderView =>
    ({
      id,
      name: id,
      connected,
      agents,
      routing: Object.fromEntries(agents.map((agent) => [agent, {}])),
      models: { [AGENT]: [{ id: MODEL_ID }] },
    }) as unknown as ProviderView;

  it('选中来源仍在已连接栏内 → false', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [view('xd', true), view('anthropic', true)],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'anthropic',
        providersLoading: false,
      }),
    ).toBe(false);
  });

  it('选中来源存在但 connected=false → true(订阅 OAuth 被外部清除的事故场景)', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [view('xd', true), view('anthropic', false)],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'anthropic',
        providersLoading: false,
      }),
    ).toBe(true);
  });

  it('选中来源在 providers 里不存在(自定义供应商被删)→ true', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [view('xd', true)],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'my-custom',
        providersLoading: false,
      }),
    ).toBe(true);
  });

  it('选中来源已连接但不服务当前 agent → true(agents 维度也要匹配)', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [view('openai', true, ['codex'])],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'openai',
        providersLoading: false,
      }),
    ).toBe(true);
  });

  it('来源已连接且服务当前 agent，但不提供当前模型 → true', () => {
    const provider = {
      ...view('openai', true),
      models: { [AGENT]: [{ id: 'chatgpt/gpt-5.5' }] },
    } as unknown as ProviderView;
    expect(
      isSelectedSourceDisconnected({
        providers: [provider],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'openai',
        providersLoading: false,
      }),
    ).toBe(true);
  });

  it('providersLoading 期间恒 false(避免首帧闪断开态)', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'anthropic',
        providersLoading: true,
      }),
    ).toBe(false);
  });

  it('未显式选来源(null / undefined)或 agent 解析不出 → false', () => {
    expect(
      isSelectedSourceDisconnected({
        providers: [view('xd', true)],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: null,
        providersLoading: false,
      }),
    ).toBe(false);
    expect(
      isSelectedSourceDisconnected({
        providers: [view('xd', true)],
        agent: null,
        modelId: MODEL_ID,
        selectedProviderId: 'xd',
        providersLoading: false,
      }),
    ).toBe(false);
  });

  it('选中来源仍连着,但这个模型在它上面已经不是聊天模型 → true(issue #882 第 3 点,2026-07 review)', () => {
    const nonChatView = {
      id: 'xd',
      name: 'xd',
      connected: true,
      agents: [AGENT],
      routing: { [AGENT]: {} },
      models: { [AGENT]: [{ id: MODEL_ID, mode: 'image_generation' }] },
    } as unknown as ProviderView;
    expect(
      isSelectedSourceDisconnected({
        providers: [nonChatView],
        agent: AGENT,
        modelId: MODEL_ID,
        selectedProviderId: 'xd',
        providersLoading: false,
      }),
    ).toBe(true);
  });
});

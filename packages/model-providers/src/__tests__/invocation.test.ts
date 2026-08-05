/**
 * 调用合成标准(invocation.ts)+ effort 新语义(effortResolution.ts 扩充部分)的行为锁。
 *
 * effort 三个新函数的用例放本文件而非 effortResolution.test.ts —— 该文件保持**零修改**,
 * 作为「P1 不动既有语义」的证明之一。
 *
 * nearestSupportedEffort 的级联全分支与
 * apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts 的 normalizeResolvedEffort
 * 非显式分支逐字节对齐(P4 切换时那边的既有测试是第二道锁)。
 */

import { describe, expect, it } from 'vitest';

import {
  EFFORT_VALUES,
  effortRank,
  lowestEffort,
  nearestSupportedEffort,
  reconcileInvocationEffort,
} from '../effortResolution.js';
import { resolveModelInvocation, type InvocationCatalogContext } from '../invocation.js';
import type { AgentKind, CatalogModel } from '../types.js';
import type { ProviderView } from '../registry.js';

// ── effort 扩充 ──────────────────────────────────────────────────────────────

describe('EFFORT_VALUES / effortRank / lowestEffort', () => {
  it('七档强弱序单一来源', () => {
    expect(EFFORT_VALUES).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
  it('未知档排最高之上(保守不上调,与 clamp 的历史行为一致)', () => {
    expect(effortRank('nonsense')).toBe(EFFORT_VALUES.length);
    expect(effortRank('ultra')).toBeLessThan(effortRank('nonsense'));
  });
  it('lowestEffort: 最低档;空 → null(title-one-shot 语义)', () => {
    expect(lowestEffort(['high', 'low', 'max'])).toBe('low');
    expect(lowestEffort([])).toBeNull();
  });
});

describe('nearestSupportedEffort — Orca 跨引擎词表翻译(双向就近,全分支)', () => {
  it('支持 → 原样', () => {
    expect(nearestSupportedEffort('high', ['low', 'high'])).toBe('high');
  });
  it('minimal → low', () => {
    expect(nearestSupportedEffort('minimal', ['low', 'medium', 'high'])).toBe('low');
  });
  it('ultra → max(Claude 词表)', () => {
    expect(nearestSupportedEffort('ultra', ['low', 'high', 'max'])).toBe('max');
  });
  it('ultra → xhigh(模型无 max,级联到最高兼容档而不是丢回默认)', () => {
    expect(nearestSupportedEffort('ultra', ['low', 'high', 'xhigh'])).toBe('xhigh');
  });
  it('max → xhigh(Claude 意图落 GPT 词表)', () => {
    expect(nearestSupportedEffort('max', ['low', 'high', 'xhigh'])).toBe('xhigh');
  });
  it('xhigh → max(GPT 意图落 Claude 词表 —— 这是**上调**,在翻译语义里正确)', () => {
    expect(nearestSupportedEffort('xhigh', ['low', 'high', 'max'])).toBe('max');
  });
  it('命不中级联映射 → null(由调用方决定回落默认还是报错)', () => {
    expect(nearestSupportedEffort('medium', ['xhigh'])).toBeNull();
    expect(nearestSupportedEffort('ultra', ['low', 'medium'])).toBeNull();
  });
});

describe('reconcileInvocationEffort — 无人值守统一回落链', () => {
  const MODEL = { efforts: ['low', 'high'] as const, defaultEffort: 'high' as string | null };

  it('requested ∈ 支持档 → 先于 override(用户显式选择不被运营表压过;IM resolveEffort 语义)', () => {
    expect(
      reconcileInvocationEffort({
        requested: 'low',
        model: MODEL,
        overrides: { 'm-1': 'high' },
        modelId: 'm-1',
        noEffortFallback: 'high',
      }),
    ).toBe('low');
  });

  it('requested 非法时 override 作为回落生效', () => {
    expect(
      reconcileInvocationEffort({
        requested: 'ultra',
        model: MODEL,
        overrides: { 'm-1': 'high' },
        modelId: 'm-1',
        noEffortFallback: 'high',
      }),
    ).toBe('high');
  });

  it('模型未知/无档的三种历史语义按 noEffortsBehavior 显式选择', () => {
    const base = {
      requested: 'low' as const,
      model: undefined,
      overrides: { 'm-1': 'xhigh' } as const,
      modelId: 'm-1',
      noEffortFallback: 'high' as const,
    };
    // hook 语义(默认): 无档就不看 requested/override,恒 fallback
    expect(reconcileInvocationEffort(base)).toBe('high');
    // IM resolveEffort 语义: requested || fallback
    expect(reconcileInvocationEffort({ ...base, noEffortsBehavior: 'requested-first' })).toBe('low');
    expect(
      reconcileInvocationEffort({ ...base, requested: null, noEffortsBehavior: 'requested-first' }),
    ).toBe('high');
    // getImDefaultEffortFor 语义: override || fallback(该场景 requested 恒空)
    expect(
      reconcileInvocationEffort({ ...base, requested: null, noEffortsBehavior: 'override-first' }),
    ).toBe('xhigh');
  });

  it('overrides 表不受原型链污染(model id 为 constructor 等原型键时不取 Object 原型)', () => {
    expect(
      reconcileInvocationEffort({
        requested: null,
        model: undefined,
        overrides: {},
        modelId: 'constructor',
        noEffortFallback: 'high',
        noEffortsBehavior: 'override-first',
      }),
    ).toBe('high');
  });

  it('override 不被支持档接受 → 跳过,走后续链', () => {
    expect(
      reconcileInvocationEffort({
        requested: 'low',
        model: MODEL,
        overrides: { 'm-1': 'ultra' },
        modelId: 'm-1',
        noEffortFallback: 'high',
      }),
    ).toBe('low');
  });

  it('无 effort 档 → noEffortFallback 参数化(IM=high / hook=undefined / mobile=空串)', () => {
    const noEfforts = { efforts: [] as const, defaultEffort: null };
    expect(
      reconcileInvocationEffort({ requested: 'high', model: noEfforts, noEffortFallback: 'high' }),
    ).toBe('high');
    expect(
      reconcileInvocationEffort({
        requested: 'high',
        model: noEfforts,
        noEffortFallback: undefined,
      }),
    ).toBeUndefined();
    expect(
      reconcileInvocationEffort({ requested: 'high', model: noEfforts, noEffortFallback: '' }),
    ).toBe('');
  });

  it('requested ∈ 支持档 → requested;否则模型默认;默认非法 → 首档', () => {
    expect(reconcileInvocationEffort({ requested: 'low', model: MODEL, noEffortFallback: undefined })).toBe('low');
    expect(reconcileInvocationEffort({ requested: 'ultra', model: MODEL, noEffortFallback: undefined })).toBe('high');
    expect(
      reconcileInvocationEffort({
        requested: 'ultra',
        model: { efforts: ['low', 'medium'], defaultEffort: 'xhigh' },
        noEffortFallback: undefined,
      }),
    ).toBe('low');
  });
});

// ── resolveModelInvocation ───────────────────────────────────────────────────

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    ...extra,
  } as CatalogModel;
}

function providers(): ProviderView[] {
  return [
    {
      id: 'anthropic',
      name: 'anthropic',
      agents: ['claude-code'],
      routing: { 'claude-code': {} },
      models: { 'claude-code': [model('claude-opus-5')] },
      connected: true,
      access: { kind: 'subscription', product: 'Claude.ai' },
    },
    {
      id: 'xd',
      name: 'xd',
      agents: ['claude-code', 'codex'],
      routing: { 'claude-code': {}, codex: {} },
      models: {
        'claude-code': [model('claude-opus-5'), model('claude-sonnet-4-6')],
        codex: [model('gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'] })],
      },
      connected: true,
      access: { kind: 'managed' },
    },
    {
      id: 'openai',
      name: 'openai',
      agents: ['codex'],
      routing: { codex: {} },
      models: { codex: [model('gpt-5.5')] },
      connected: false,
    },
  ] as ProviderView[];
}

const SCENARIO = {
  agentKind: 'claude-code' as AgentKind,
  modelFor: (agent: AgentKind) => (agent === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6'),
  noEffortFallback: undefined,
  permissionMode: 'bypassPermissions',
};

const PERM_MODES = (agent: AgentKind): readonly string[] =>
  agent === 'codex' ? ['ask', 'auto', 'bypassPermissions'] : ['ask', 'acceptEdits', 'auto', 'bypassPermissions'];

function ctx(over: Partial<InvocationCatalogContext> = {}): InvocationCatalogContext {
  return { providers: providers(), getPermissionModes: PERM_MODES, ...over };
}

describe('resolveModelInvocation — 六元组回落链', () => {
  it('全显式且全可用 → 原样直传,零回落', () => {
    const r = resolveModelInvocation(
      {
        agentKind: 'claude-code',
        model: 'claude-opus-5',
        effort: 'low',
        providerId: 'anthropic',
        permissionMode: 'acceptEdits',
        fastMode: true,
      },
      SCENARIO,
      ctx(),
    );
    expect(r).toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-5',
      effort: 'low',
      providerId: 'anthropic',
      permissionMode: 'acceptEdits',
      fastMode: true,
    });
    expect(r.fallbacksApplied).toEqual([]);
  });

  it('全空 → 场景默认(model 过可用性校验;permission 落场景默认;effort 落模型默认)', () => {
    const r = resolveModelInvocation({}, SCENARIO, ctx());
    expect(r).toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      providerId: null,
      permissionMode: 'bypassPermissions',
      fastMode: false,
    });
  });

  it('agent 非法 → 场景默认 agent,并记录回落轨迹', () => {
    const r = resolveModelInvocation({ agentKind: 'weird' }, SCENARIO, ctx());
    expect(r.agentKind).toBe('claude-code');
    expect(r.fallbacksApplied).toContain('agent:scenario-default');
  });

  it('显式 model 不可用 → 场景默认;场景默认也不可用 → 该 agent 首个可用', () => {
    const r1 = resolveModelInvocation({ model: 'gone-model' }, SCENARIO, ctx());
    expect(r1.model).toBe('claude-sonnet-4-6');
    expect(r1.fallbacksApplied).toContain('model:scenario-default');

    const r2 = resolveModelInvocation(
      { model: 'gone-model' },
      { ...SCENARIO, modelFor: () => 'also-gone' },
      ctx(),
    );
    expect(r2.model).toBe('claude-opus-5'); // anthropic 段首个
    expect(r2.fallbacksApplied).toContain('model:first-available');
  });

  it('目录与 caps 全不可用 → 场景默认裸值(宁发可能非法的 id 不发空串,历史降级)', () => {
    const r = resolveModelInvocation({}, SCENARIO, ctx({ providers: null }));
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.fallbacksApplied).toContain('model:scenario-default-unverified');
  });

  it('目录不可用但有 caps → caps 兜底清单参与校验', () => {
    const r = resolveModelInvocation(
      { model: 'caps-model' },
      SCENARIO,
      ctx({
        providers: null,
        getCapabilityModels: () => [{ id: 'caps-model', efforts: ['medium'], defaultEffort: 'medium' }],
      }),
    );
    expect(r.model).toBe('caps-model');
    expect(r.effort).toBe('medium');
  });

  it('providerId: 已连接且提供最终模型 → 保留;不提供 → 收敛到可见替代源', () => {
    const keep = resolveModelInvocation(
      { model: 'claude-opus-5', providerId: 'anthropic' },
      SCENARIO,
      ctx(),
    );
    expect(keep.providerId).toBe('anthropic');

    // anthropic 不提供 sonnet → 不再回 null(下游默认路由不看可见性),直接收敛到
    // 提供该模型的可见替代源(2026-07 codex review 行为升级)
    const drop = resolveModelInvocation(
      { model: 'claude-sonnet-4-6', providerId: 'anthropic' },
      SCENARIO,
      ctx(),
    );
    expect(drop.providerId).toBe('xd');
    expect(drop.fallbacksApplied).toContain('provider:visible-fallback');
  });

  it('providerId: 断开的来源不算可用,收敛到提供该模型的可见替代源', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' },
      { ...SCENARIO, agentKind: 'codex' },
      ctx(),
    );
    // openai 断开 → xd(已连接且提供 gpt-5.5)顶上,不回 null
    expect(r.providerId).toBe('xd');
    expect(r.fallbacksApplied).toContain('provider:visible-fallback');
  });

  it('providerId: 点名来源这份具体条目是非聊天 mode → 不算「真实提供」,收敛到聊天可用的替代源(issue #882 第 3 点,2026-07 review 第 18 轮)', () => {
    // anthropic 的 claude-opus-5 被网关标成非聊天(如 embedding);xd 上同 id 仍是正常
    // 聊天模型 —— 只看 id 存在(旧 providerOffersModel)会误留在 anthropic 上,必须
    // 收敛到 xd。故意不传 ctx.isVisible,复现修复前「无可见性回调时直接放行」的路径。
    const withNonChatCopy: ProviderView[] = providers().map((p) =>
      p.id === 'anthropic'
        ? { ...p, models: { 'claude-code': [model('claude-opus-5', { mode: 'embedding' })] } }
        : p,
    ) as ProviderView[];
    const r = resolveModelInvocation(
      { model: 'claude-opus-5', providerId: 'anthropic' },
      SCENARIO,
      ctx({ providers: withNonChatCopy }),
    );
    expect(r.providerId).toBe('xd');
    expect(r.fallbacksApplied).toContain('provider:visible-fallback');
  });

  it('providerId: 目录不可用 → 透传原值(路由层兜底,与 IM/hook 历史降级一致)', () => {
    const r = resolveModelInvocation(
      { providerId: 'anthropic' },
      SCENARIO,
      ctx({ providers: null }),
    );
    expect(r.providerId).toBe('anthropic');
    expect(r.fallbacksApplied).toContain('provider:unverified-passthrough');
  });

  it('permissionMode: 显式档不被支持 → 该 agent **最严**档,绝不落场景默认 bypass', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex', permissionMode: 'acceptEdits' },
      { ...SCENARIO, agentKind: 'codex' },
      ctx(),
    );
    expect(r.permissionMode).toBe('ask');
    expect(r.permissionMode).not.toBe('bypassPermissions');
    expect(r.fallbacksApplied).toContain('permission:strictest-fallback');
  });

  it('permissionMode: 未注入档位表时显式值原样放行(无从校验,不瞎猜)', () => {
    const r = resolveModelInvocation(
      { permissionMode: 'acceptEdits' },
      SCENARIO,
      ctx({ getPermissionModes: undefined }),
    );
    expect(r.permissionMode).toBe('acceptEdits');
  });

  it('isVisible 注入时,隐藏模型不算「可用」(与选择器口径一致)', () => {
    const r = resolveModelInvocation(
      { model: 'claude-opus-5' },
      SCENARIO,
      ctx({ isVisible: (_pid, m) => m.id !== 'claude-opus-5' }),
    );
    expect(r.model).toBe('claude-sonnet-4-6');
  });

  it('场景 effort(effortFor)在显式 effort 缺失时参与回落', () => {
    const r = resolveModelInvocation(
      { model: 'claude-opus-5' },
      { ...SCENARIO, effortFor: () => 'low' },
      ctx(),
    );
    expect(r.effort).toBe('low');
  });

  it('effortOverrides 只在显式档非法时生效(用户显式选择优先于运营表)', () => {
    const keep = resolveModelInvocation(
      { model: 'claude-opus-5', effort: 'low' },
      { ...SCENARIO, effortOverrides: { 'claude-opus-5': 'high' } },
      ctx(),
    );
    expect(keep.effort).toBe('low');

    const fall = resolveModelInvocation(
      { model: 'claude-opus-5', effort: 'ultra' },
      { ...SCENARIO, effortOverrides: { 'claude-opus-5': 'high' } },
      ctx(),
    );
    expect(fall.effort).toBe('high');
  });

  it('显式 effort 非法时先试场景默认档,再落模型默认(hook 的显式>草稿>默认链)', () => {
    const r = resolveModelInvocation(
      { model: 'claude-opus-5', effort: 'ultra' },
      { ...SCENARIO, effortFor: () => 'low' },
      ctx(),
    );
    expect(r.effort).toBe('low');
  });
});

// ── 2026-07 review 修正的行为锁(#433 第二轮) ─────────────────────────────────

describe('resolveModelInvocation — 空权限档位表不放宽(Greptile P2 + codex P1 同点)', () => {
  it('显式档 + 空档位表 → 原样保留,绝不落场景默认 bypass', () => {
    const r = resolveModelInvocation(
      { permissionMode: 'acceptEdits' },
      SCENARIO,
      ctx({ getPermissionModes: () => [] }),
    );
    expect(r.permissionMode).toBe('acceptEdits');
    expect(r.fallbacksApplied).toContain('permission:modes-unavailable');
  });

  it('无显式档 + 空档位表 → 场景默认(该分支语义不变)', () => {
    const r = resolveModelInvocation({}, SCENARIO, ctx({ getPermissionModes: () => [] }));
    expect(r.permissionMode).toBe('bypassPermissions');
  });
});

describe('resolveModelInvocation — explicitModelPolicy(Orca 严格拒绝语义)', () => {
  const STRICT = { ...SCENARIO, explicitModelPolicy: 'reject' as const };

  it('显式模型经校验不可用 → rejected 置位;其余字段仍按回落链合成(纯诊断)', () => {
    const r = resolveModelInvocation({ model: 'gone-model' }, STRICT, ctx());
    expect(r.rejected).toEqual({
      field: 'model',
      value: 'gone-model',
      reason: 'explicit-model-unavailable',
    });
    expect(r.fallbacksApplied).toContain('model:explicit-rejected');
    expect(r.model).toBe('claude-sonnet-4-6');
  });

  it('显式模型可用 → 不触发 rejected', () => {
    const r = resolveModelInvocation({ model: 'claude-opus-5' }, STRICT, ctx());
    expect(r.rejected).toBeUndefined();
  });

  it('目录与 caps 全不可用 → 未经校验采纳显式值,不触发 rejected', () => {
    const r = resolveModelInvocation({ model: 'gone-model' }, STRICT, ctx({ providers: null }));
    expect(r.rejected).toBeUndefined();
    expect(r.model).toBe('gone-model');
    expect(r.fallbacksApplied).toContain('model:explicit-unverified');
  });

  it("缺省策略('fallback')下不可用显式模型静默落场景默认(IM/hook 历史语义,不变)", () => {
    const r = resolveModelInvocation({ model: 'gone-model' }, SCENARIO, ctx());
    expect(r.rejected).toBeUndefined();
    expect(r.model).toBe('claude-sonnet-4-6');
  });
});

describe('resolveModelInvocation — 显式 agent 无可用模型时回落能跑的 agent(IM pickModel 语义)', () => {
  it('显式 codex 零可用模型、场景默认 claude-code 有 → 回落并记录', () => {
    // isVisible 把 codex 模型全部藏掉 → codex available=[](非 null)
    const r = resolveModelInvocation(
      { agentKind: 'codex' },
      SCENARIO,
      ctx({ isVisible: (_pid, m) => !m.id.startsWith('gpt') && !m.id.startsWith('codex/') }),
    );
    expect(r.agentKind).toBe('claude-code');
    expect(r.fallbacksApplied).toContain('agent:model-less-fallback');
    expect(r.model).toBe('claude-sonnet-4-6');
  });

  it('场景默认 agent 同样无模型 → 保持显式选择(回落无意义)', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex' },
      SCENARIO,
      ctx({ isVisible: () => false }),
    );
    expect(r.agentKind).toBe('codex');
    expect(r.fallbacksApplied).not.toContain('agent:model-less-fallback');
  });

  it('能力数据不可用(available=null)→ 不猜,维持显式 agent', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex' },
      SCENARIO,
      ctx({ providers: null }),
    );
    expect(r.agentKind).toBe('codex');
    expect(r.fallbacksApplied).not.toContain('agent:model-less-fallback');
  });
});

describe('resolveModelInvocation — providerId 校验含 per-provider 可见性(codex review)', () => {
  it('模型经他源可用、点名来源被 isVisible 排除 → 收敛到可见替代源,不绕过来源级契约', () => {
    // claude-opus-5 在 anthropic 可见、在 xd 被隐藏;显式点名 xd 不能放行。
    // 也不能回 null:下游默认路由(nativeDefaultSourceId,claude-code 优先 xd)不看可见性,
    // 会又选回被隐藏的 xd —— 必须显式收敛到可见的 anthropic(codex review 二轮)。
    const r = resolveModelInvocation(
      { model: 'claude-opus-5', providerId: 'xd' },
      SCENARIO,
      ctx({ isVisible: (pid, m) => !(pid === 'xd' && m.id === 'claude-opus-5') }),
    );
    expect(r.model).toBe('claude-opus-5');
    expect(r.providerId).toBe('anthropic');
    expect(r.fallbacksApplied).toContain('provider:visible-fallback');
  });

  it('点名来源可见 → 照常保留(既有语义不变)', () => {
    const r = resolveModelInvocation(
      { model: 'claude-opus-5', providerId: 'xd' },
      SCENARIO,
      ctx({ isVisible: () => true }),
    );
    expect(r.providerId).toBe('xd');
  });
});

describe('resolveModelInvocation — 诊断标记区分 unverified 与零可选(Copilot review)', () => {
  it('清单可用但为空 → model:no-available-models,不再误标 unverified', () => {
    const r = resolveModelInvocation({}, SCENARIO, ctx({ isVisible: () => false }));
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.fallbacksApplied).toContain('model:no-available-models');
    expect(r.fallbacksApplied).not.toContain('model:scenario-default-unverified');
  });
});

describe('resolveModelInvocation — codex review 三轮:回落保真度', () => {
  it('agent 回落后,原 agent 的 model/effort 配对偏好作废(不跨 agent 采纳同名 id)', () => {
    // pa(codex)零模型 → 回落 claude-code;显式 'gpt-5.5' 在 pb 的 claude-code 目录恰好
    // 也存在 —— 修复前会被当作新 agent 的显式选择采纳(拿原 agent 的偏好跑新 agent,
    // 还能绕过 reject 策略),修复后作废,落场景默认链。
    const provs = [
      {
        id: 'pa',
        name: 'pa',
        agents: ['codex'],
        routing: { codex: {} },
        models: { codex: [] },
        connected: true,
      },
      {
        id: 'pb',
        name: 'pb',
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: { 'claude-code': [model('claude-sonnet-4-6'), model('gpt-5.5')] },
        connected: true,
      },
    ] as unknown as ProviderView[];
    const r = resolveModelInvocation(
      { agentKind: 'codex', model: 'gpt-5.5', effort: 'low' },
      SCENARIO,
      { providers: provs, getPermissionModes: PERM_MODES },
    );
    expect(r.agentKind).toBe('claude-code');
    expect(r.fallbacksApplied).toContain('agent:model-less-fallback');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.effort).not.toBe('low');
  });

  it('first-available 兜底优先 native 默认源(claude-code 优先 xd),不用 rail 序首个', () => {
    // rail 序 anthropic 在前(首见 'a-first'),但 native 源是 xd —— 兜底必须取 xd 目录序
    // 首个可用('xd-first'),与 IM 现行 nativeDefaultSourceId 口径一致,否则换来源/计费路由。
    const provs = [
      {
        id: 'anthropic',
        name: 'anthropic',
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: { 'claude-code': [model('a-first')] },
        connected: true,
      },
      {
        id: 'xd',
        name: 'xd',
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: { 'claude-code': [model('xd-first'), model('a-first')] },
        connected: true,
      },
    ] as unknown as ProviderView[];
    const r = resolveModelInvocation(
      { model: 'gone' },
      { ...SCENARIO, modelFor: () => 'also-gone' },
      { providers: provs, getPermissionModes: PERM_MODES },
    );
    expect(r.model).toBe('xd-first');
    expect(r.fallbacksApplied).toContain('model:first-available');
  });
});

describe('resolveModelInvocation — codex review 四轮:无点名路径与 provider 偏好作废', () => {
  it('无点名 + native 源上模型被隐藏、他源可见 → 显式收敛到可见源(null 会被下游路由进隐藏源)', () => {
    // claude-code 的 native 默认源是 xd;(xd, claude-opus-5) 被隐藏,anthropic 可见。
    // 下游 effectiveSourceIdForModel(null) 不看可见性会选回 xd —— 必须显式定到 anthropic。
    const r = resolveModelInvocation(
      { model: 'claude-opus-5' },
      SCENARIO,
      ctx({ isVisible: (pid, m) => !(pid === 'xd' && m.id === 'claude-opus-5') }),
    );
    expect(r.model).toBe('claude-opus-5');
    expect(r.providerId).toBe('anthropic');
    expect(r.fallbacksApplied).toContain('provider:visible-fallback');
  });

  it('无点名 + 下游默认落点本就可见 → 维持 null(「null=默认路由」契约不变)', () => {
    const r = resolveModelInvocation(
      { model: 'claude-opus-5' },
      SCENARIO,
      ctx({ isVisible: (pid, m) => !(pid === 'anthropic' && m.id === 'claude-sonnet-4-6') }),
    );
    expect(r.providerId).toBeNull();
    expect(r.fallbacksApplied).not.toContain('provider:visible-fallback');
  });

  it('无点名 + 未注入可见性 → 维持 null(既有契约)', () => {
    const r = resolveModelInvocation({ model: 'claude-opus-5' }, SCENARIO, ctx());
    expect(r.providerId).toBeNull();
  });

  it('agent 回落时 providerId 偏好一并作废,不把原 agent 的路由强加给回落 agent', () => {
    const provs = [
      {
        id: 'pa',
        name: 'pa',
        agents: ['codex'],
        routing: { codex: {} },
        models: { codex: [] },
        connected: true,
      },
      {
        id: 'pb',
        name: 'pb',
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: { 'claude-code': [model('claude-sonnet-4-6')] },
        connected: true,
      },
    ] as unknown as ProviderView[];
    const r = resolveModelInvocation(
      { agentKind: 'codex', providerId: 'pb' },
      SCENARIO,
      { providers: provs, getPermissionModes: PERM_MODES },
    );
    expect(r.agentKind).toBe('claude-code');
    expect(r.fallbacksApplied).toContain('agent:model-less-fallback');
    // 原 agent 的 providerId 偏好作废;无 scenario.providerIdFor → null 默认路由
    expect(r.providerId).toBeNull();
  });
});

describe('resolveModelInvocation — codex review 五轮:native 兜底行级可见性 + 场景权限档校验', () => {
  it('native 源上首模型被隐藏 → 跳到该源下一个可见模型,不经他源路由漂移', () => {
    // xd(native)目录 [opus, sonnet]:opus 在 xd 被隐藏(anthropic 可见)。兜底必须选
    // xd 的 sonnet —— 选 opus 会被 provider 步骤路由去 anthropic,换掉订阅/计费路由。
    const r = resolveModelInvocation(
      { model: 'gone' },
      { ...SCENARIO, modelFor: () => 'also-gone' },
      ctx({ isVisible: (pid, m) => !(pid === 'xd' && m.id === 'claude-opus-5') }),
    );
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.fallbacksApplied).toContain('model:first-available');
  });

  it('无显式权限档时,场景默认档不被最终 agent 支持 → 回落该 agent 最严档', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex' },
      { ...SCENARIO, agentKind: 'codex', permissionMode: 'acceptEdits' },
      ctx(),
    );
    // codex 不支持 acceptEdits(PERM_MODES) → 最严档 ask,不裸透传
    expect(r.permissionMode).toBe('ask');
    expect(r.fallbacksApplied).toContain('permission:scenario-strictest-fallback');
  });

  it('场景默认档被支持 → 原样(既有语义不变)', () => {
    const r = resolveModelInvocation({}, SCENARIO, ctx());
    expect(r.permissionMode).toBe('bypassPermissions');
    expect(r.fallbacksApplied).not.toContain('permission:scenario-strictest-fallback');
  });
});

describe('resolveModelInvocation — model 候选清单本身先过 chat 准入(issue #882 第 3 点,2026-07 review 第 20 轮)', () => {
  it('native 源上首模型是非聊天类型 → 跳过它,兜底选该源下一个聊天模型,不是裸 available[0]', () => {
    // xd(native)目录 [opus(非聊天), sonnet]:旧实现的 availableModelsFor 不过滤 mode,
    // has()/fromNative/available[0] 都可能选中 opus;providerId 步骤只能校验"选中的
    // 来源",无法撤销已经选错的模型。
    const provs = providers().map((p) =>
      p.id === 'xd'
        ? {
            ...p,
            models: {
              ...p.models,
              'claude-code': [
                model('claude-opus-5', { mode: 'embedding' }),
                model('claude-sonnet-4-6'),
              ],
            },
          }
        : p,
    ) as ProviderView[];
    const r = resolveModelInvocation(
      { model: 'gone' },
      { ...SCENARIO, modelFor: () => 'also-gone' },
      { providers: provs, getPermissionModes: PERM_MODES },
    );
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.fallbacksApplied).toContain('model:first-available');
  });

  it('显式偏好的模型 id 在所有来源都只以非聊天类型存在 → 不算「可用」,回落场景默认', () => {
    // 两个来源的 claude-opus-5 都改成非聊天,确保没有任何一份聊天可用的同 id 条目
    // 能让 has() 误放行。
    const provs = providers().map((p) => {
      if (p.id === 'anthropic') {
        return { ...p, models: { 'claude-code': [model('claude-opus-5', { mode: 'embedding' })] } };
      }
      if (p.id === 'xd') {
        return {
          ...p,
          models: {
            ...p.models,
            'claude-code': [
              model('claude-opus-5', { mode: 'embedding' }),
              model('claude-sonnet-4-6'),
            ],
          },
        };
      }
      return p;
    }) as ProviderView[];
    const r = resolveModelInvocation(
      { model: 'claude-opus-5' },
      SCENARIO,
      { providers: provs, getPermissionModes: PERM_MODES },
    );
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.fallbacksApplied).toContain('model:scenario-default');
  });
});

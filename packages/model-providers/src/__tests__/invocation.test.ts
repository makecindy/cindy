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
      models: { 'claude-code': [model('claude-opus-5')] },
      connected: true,
      access: { kind: 'subscription', product: 'Claude.ai' },
    },
    {
      id: 'xd',
      name: 'xd',
      agents: ['claude-code', 'codex'],
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

  it('providerId: 已连接且提供最终模型 → 保留;不提供 → null 默认路由', () => {
    const keep = resolveModelInvocation(
      { model: 'claude-opus-5', providerId: 'anthropic' },
      SCENARIO,
      ctx(),
    );
    expect(keep.providerId).toBe('anthropic');

    // anthropic 不提供 sonnet → 回默认路由,并记录
    const drop = resolveModelInvocation(
      { model: 'claude-sonnet-4-6', providerId: 'anthropic' },
      SCENARIO,
      ctx(),
    );
    expect(drop.providerId).toBeNull();
    expect(drop.fallbacksApplied).toContain('provider:default-route');
  });

  it('providerId: 断开的来源不算可用', () => {
    const r = resolveModelInvocation(
      { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' },
      { ...SCENARIO, agentKind: 'codex' },
      ctx(),
    );
    expect(r.providerId).toBeNull();
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

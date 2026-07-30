/**
 * model-route-guard.test.ts —— 停用轴在 main 会话路由边界的三态裁决矩阵。
 * 纯函数直测(规则 14);register.ts 的 bootstrapSession / SET_MODEL / agent-switch
 * 只是薄接线。语义:pass = 不涉停用;reroute = 隐式默认落点被停用但有启用替代拷贝
 * (调用方以显式来源落地);reject = 显式点名停用来源 / 全部已连接拷贝停用。
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry, type Catalog, type CatalogModel, type Provider } from '@cindy/model-providers';

import { checkModelRoute, resolveLenientRoute } from '../model-route-guard.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

function provider(
  id: string,
  models: CatalogModel[],
  source: Provider['source'] = 'builtin',
): Provider {
  return {
    id,
    name: id,
    source,
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { wireProtocol: 'anthropic-messages', authStrategy: 'api_key' } as never },
    models: { 'claude-code': models },
  };
}

// xd 是 claude-code 的原生默认来源(nativeDefaultSourceId 口径),anthropic 是替代拷贝。
const CATALOG: Catalog = {
  providers: [
    provider('xd', [model('claude-opus-5')]),
    provider('anthropic', [model('claude-opus-5')]),
  ],
} as Catalog;

function views(
  access?: Parameters<typeof buildRegistry>[3],
  connected: Record<string, boolean> = { xd: true, anthropic: true },
) {
  return buildRegistry(CATALOG, connected, {}, access);
}

describe('checkModelRoute', () => {
  it('无停用条目 / 目录不认识该模型 ⇒ pass(不新增拒绝面)', () => {
    expect(checkModelRoute(views(), 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
    expect(checkModelRoute(views(), 'claude-code', 'unknown-model', null)).toEqual({ kind: 'pass' });
  });

  it('显式点名:停用的来源 reject;启用的来源 pass;未知来源按隐式口径裁决', () => {
    const v = views({ disabledModels: { 'xd:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'xd')).toEqual({
      kind: 'reject',
      reason: 'explicit-source-disabled',
    });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'anthropic')).toEqual({ kind: 'pass' });
    // 未知/陈旧的显式来源:实际路由层查不到 routing 会回退原生默认(xd,已停用)——
    // 不 pass-through,按隐式口径裁决 ⇒ 改道到启用替代拷贝(R23)。
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'nonexistent')).toEqual({
      kind: 'reroute',
      providerId: 'anthropic',
    });
    // 未知显式来源 + 原生默认未停用 ⇒ 隐式口径 pass(不新增拒绝面)。
    expect(checkModelRoute(views(), 'claude-code', 'claude-opus-5', 'nonexistent')).toEqual({
      kind: 'pass',
    });
  });

  it('隐式来源:原生默认落点(xd)被停用且替代拷贝已连接启用 ⇒ reroute 到替代来源', () => {
    // 实际路由层对隐式来源走原生默认、不查停用标志 —— 仅放行等于继续用停用拷贝
    // 付费,必须显式改路由(PR #744 review 第三轮)。
    const v = views({ disabledModels: { 'xd:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({
      kind: 'reroute',
      providerId: 'anthropic',
    });
  });

  it('隐式来源:替代拷贝存在但**未连接** ⇒ reject(不能把会话路由到连不上的来源)', () => {
    const v = views(
      { disabledModels: { 'xd:claude-opus-5': true } },
      { xd: true, anthropic: false },
    );
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({
      kind: 'reject',
      reason: 'model-disabled',
    });
  });

  it('隐式来源:原生默认落点未被停用 ⇒ pass,不改变既有路由', () => {
    const v = views({ disabledModels: { 'anthropic:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
  });

  it('零已连接来源 ⇒ pass(连接域问题,交给既有错误路径)', () => {
    const v = views(
      { disabledModels: { 'xd:claude-opus-5': true, 'anthropic:claude-opus-5': true } },
      { xd: false, anthropic: false },
    );
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
  });

  it('能力模型(图像/视频等分组)⇒ reject capability-model(隐式与显式点名同判)', () => {
    // 老控制端可经 allowlisted 通道直接点名图像模型当对话模型 —— 选择器的硬排除
    // 帮不上,必须在同一边界拒绝(PR #744 review 第四轮)。
    const catalog = {
      providers: [provider('xd', [model('seedream-5', { group: 'image' })])],
    } as Catalog;
    const v = buildRegistry(catalog, { xd: true }, {});
    expect(checkModelRoute(v, 'claude-code', 'seedream-5', null)).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
    expect(checkModelRoute(v, 'claude-code', 'seedream-5', 'xd')).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
  });

  it('能力模型分类按将要路由的拷贝判:未连接来源的对话拷贝不构成豁免', () => {
    // 同 id 在 xd 是图像模型、在用户自定义 mycorp 是对话模型,但 mycorp 未连接:
    // 实际路由永远不会落到未连接拷贝,隐式与点名 xd 都必须拒(PR #744 review 第六轮)。
    const catalog = {
      providers: [
        provider('xd', [model('gpt-image-2', { group: 'image' })]),
        provider('mycorp', [model('gpt-image-2', { group: 'custom:mycorp' })], 'user'),
      ],
    } as Catalog;
    const v = buildRegistry(catalog, { xd: true, mycorp: false }, {});
    expect(checkModelRoute(v, 'claude-code', 'gpt-image-2', null)).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
    expect(checkModelRoute(v, 'claude-code', 'gpt-image-2', 'xd')).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
  });

  it('混源同 id 双连接:分类按选中来源 —— 显式选用户家对话拷贝放行,XD 家能力拷贝与隐式默认都拒', () => {
    const catalog = {
      providers: [
        provider('xd', [model('gpt-image-2', { group: 'image' })]),
        provider('mycorp', [model('gpt-image-2', { group: 'custom:mycorp' })], 'user'),
      ],
    } as Catalog;
    const v = buildRegistry(catalog, { xd: true, mycorp: true }, {});
    expect(checkModelRoute(v, 'claude-code', 'gpt-image-2', 'mycorp')).toEqual({ kind: 'pass' });
    expect(checkModelRoute(v, 'claude-code', 'gpt-image-2', 'xd')).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
    // 隐式:原生默认落点是 xd(能力拷贝)—— provider-route 不看分类,必须在边界拒。
    expect(checkModelRoute(v, 'claude-code', 'gpt-image-2', null)).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
  });

  it('供应商级停用与模型级同语义:点名 suspended 来源 reject;默认落点 suspended 且无替代 ⇒ reject', () => {
    expect(
      checkModelRoute(views({ disabledProviders: { xd: true } }), 'claude-code', 'claude-opus-5', 'xd'),
    ).toEqual({ kind: 'reject', reason: 'explicit-source-disabled' });
    expect(
      checkModelRoute(
        views({ disabledProviders: { xd: true, anthropic: true } }),
        'claude-code',
        'claude-opus-5',
        null,
      ),
    ).toEqual({ kind: 'reject', reason: 'model-disabled' });
    // suspended 默认落点 + 启用替代 ⇒ reroute。
    expect(
      checkModelRoute(views({ disabledProviders: { xd: true } }), 'claude-code', 'claude-opus-5', null),
    ).toEqual({ kind: 'reroute', providerId: 'anthropic' });
  });
});

describe('resolveLenientRoute(自动化直建会话的宽松降级)', () => {
  it('原样可用 ⇒ 原样;隐式默认被停用有替代 ⇒ 显式落替代(均不算 degraded)', () => {
    expect(resolveLenientRoute(views(), 'claude-code', 'claude-opus-5', null)).toEqual({
      model: 'claude-opus-5',
      providerId: null,
      degraded: false,
    });
    expect(
      resolveLenientRoute(
        views({ disabledModels: { 'xd:claude-opus-5': true } }),
        'claude-code',
        'claude-opus-5',
        null,
      ),
    ).toEqual({ model: 'claude-opus-5', providerId: 'anthropic', degraded: false });
  });

  it('显式来源被停用但模型仍可路由 ⇒ 丢弃来源保模型(degraded)', () => {
    // anthropic 被点名且停用;xd(隐式默认)未停用 ⇒ 丢显式来源,隐式默认接住。
    expect(
      resolveLenientRoute(
        views({ disabledModels: { 'anthropic:claude-opus-5': true } }),
        'claude-code',
        'claude-opus-5',
        'anthropic',
      ),
    ).toEqual({ model: 'claude-opus-5', providerId: null, degraded: true });
    // 显式来源停用 + 隐式默认(xd)也停用但 anthropic…此例换:显式 xd 停用、隐式默认
    // 落 xd 也停用、替代 anthropic 启用 ⇒ 丢显式来源后 reroute 到替代。
    expect(
      resolveLenientRoute(
        views({ disabledModels: { 'xd:claude-opus-5': true } }),
        'claude-code',
        'claude-opus-5',
        'xd',
      ),
    ).toEqual({ model: 'claude-opus-5', providerId: 'anthropic', degraded: true });
  });

  it('R23:仅换来源(reroute / 丢弃显式来源)也按落地拷贝 reconcile effort', () => {
    // effort 支持是 per-(来源, 模型) 的:xd 拷贝到 max,anthropic 拷贝只到 high。
    const catalog: Catalog = {
      providers: [
        provider('xd', [
          model('claude-opus-5', { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' }),
        ]),
        provider('anthropic', [
          model('claude-opus-5', { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }),
        ]),
      ],
    } as Catalog;
    // 隐式默认(xd)停用 ⇒ reroute 到 anthropic:desiredEffort=max 落地拷贝不支持 ⇒ 取默认档。
    const rerouted = buildRegistry(
      catalog,
      { xd: true, anthropic: true },
      {},
      { disabledModels: { 'xd:claude-opus-5': true } },
    );
    expect(
      resolveLenientRoute(rerouted, 'claude-code', 'claude-opus-5', null, { desiredEffort: 'max' }),
    ).toEqual({ model: 'claude-opus-5', providerId: 'anthropic', degraded: false, effort: 'high' });
    // 落地拷贝仍支持 desiredEffort ⇒ 保留原档。
    expect(
      resolveLenientRoute(rerouted, 'claude-code', 'claude-opus-5', null, { desiredEffort: 'medium' }),
    ).toEqual({ model: 'claude-opus-5', providerId: 'anthropic', degraded: false, effort: 'medium' });
    // 丢弃停用显式来源落隐式默认(xd 拷贝支持 max)⇒ effort 保留。
    const dropped = buildRegistry(
      catalog,
      { xd: true, anthropic: true },
      {},
      { disabledModels: { 'anthropic:claude-opus-5': true } },
    );
    expect(
      resolveLenientRoute(dropped, 'claude-code', 'claude-opus-5', 'anthropic', { desiredEffort: 'max' }),
    ).toEqual({ model: 'claude-opus-5', providerId: null, degraded: true, effort: 'max' });
  });

  it('所有已连接拷贝被停用 ⇒ 连模型一起丢弃(交回 agent 默认路由)', () => {
    expect(
      resolveLenientRoute(
        views({ disabledModels: { 'xd:claude-opus-5': true, 'anthropic:claude-opus-5': true } }),
        'claude-code',
        'claude-opus-5',
        'xd',
      ),
    ).toEqual({ model: undefined, providerId: null, degraded: true });
  });

  it('无模型 ⇒ 原样透传(不涉裁决)', () => {
    expect(resolveLenientRoute(views(), 'claude-code', undefined, 'xd')).toEqual({
      model: undefined,
      providerId: 'xd',
      degraded: false,
    });
  });

  it('④ 换模型:入口默认兜底同走裁决;默认也死时退到目录第一份启用对话模型;全停 ⇒ undefined', () => {
    // xd 只有 opus;anthropic 有 opus + haiku。
    const catalog = {
      providers: [
        provider('xd', [model('claude-opus-5')]),
        provider('anthropic', [model('claude-opus-5'), model('claude-haiku-4-5')]),
      ],
    } as Catalog;
    const mk = (access?: Parameters<typeof buildRegistry>[3]) =>
      buildRegistry(catalog, { xd: true, anthropic: true }, {}, access);
    const opusDead = { disabledModels: { 'xd:claude-opus-5': true, 'anthropic:claude-opus-5': true } };

    // 入口默认(haiku)启用 ⇒ 兜底走它(经裁决,隐式路由可用则不强制显式来源)。
    expect(
      resolveLenientRoute(mk(opusDead), 'claude-code', 'claude-opus-5', null, {
        fallbackModel: 'claude-haiku-4-5',
      }),
    ).toEqual({ model: 'claude-haiku-4-5', providerId: null, degraded: true });

    // 不带入口默认 ⇒ 直接退到目录第一份启用对话模型(显式带上来源,防同 id 隐式
    // 默认又落回停用拷贝)。
    expect(
      resolveLenientRoute(mk(opusDead), 'claude-code', 'claude-opus-5', null),
    ).toEqual({ model: 'claude-haiku-4-5', providerId: 'anthropic', degraded: true });

    // 入口默认自己也被停用、目录再无启用对话模型 ⇒ model undefined(调用方失败收口),
    // 绝不把未经裁决的模型漏回去(PR #744 review 第六轮)。
    const allDead = {
      disabledModels: {
        'xd:claude-opus-5': true,
        'anthropic:claude-opus-5': true,
        'anthropic:claude-haiku-4-5': true,
      },
    };
    expect(
      resolveLenientRoute(mk(allDead), 'claude-code', 'claude-opus-5', 'xd', {
        fallbackModel: 'claude-haiku-4-5',
      }),
    ).toEqual({ model: undefined, providerId: null, degraded: true });
  });

  it('④ 换模型时按解析条目 reconcile effort:超出支持集取默认档,仍支持则保留', () => {
    // haiku 支持 low/high、默认 low;保存档 max 超出支持集。
    const catalog = {
      providers: [
        provider('xd', [model('claude-opus-5')]),
        provider('anthropic', [
          model('claude-opus-5'),
          model('claude-haiku-4-5', { efforts: ['low', 'high'], defaultEffort: 'low' }),
        ]),
      ],
    } as Catalog;
    const opusDead = {
      disabledModels: { 'xd:claude-opus-5': true, 'anthropic:claude-opus-5': true },
    };
    const v = buildRegistry(catalog, { xd: true, anthropic: true }, {}, opusDead);
    expect(
      resolveLenientRoute(v, 'claude-code', 'claude-opus-5', null, { desiredEffort: 'max' }),
    ).toEqual({
      model: 'claude-haiku-4-5',
      providerId: 'anthropic',
      degraded: true,
      effort: 'low',
    });
    expect(
      resolveLenientRoute(v, 'claude-code', 'claude-opus-5', null, { desiredEffort: 'high' }),
    ).toMatchObject({ model: 'claude-haiku-4-5', effort: 'high' });
    // 模型未换(pass)时不产出 effort:调用方保持自己的保存档。
    expect(
      resolveLenientRoute(views(), 'claude-code', 'claude-opus-5', null, { desiredEffort: 'max' }),
    ).toEqual({ model: 'claude-opus-5', providerId: null, degraded: false });
  });
});

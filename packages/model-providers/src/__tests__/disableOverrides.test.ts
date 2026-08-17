/**
 * 「模型 / 供应商停用」(disableOverrides)行为锁:
 *   1. buildRegistry 烘焙 —— suspended / model.disabled 标志按 override 落位;
 *      无停用条目时 models 原引用透传(热路径零额外分配)。
 *   2. rail 过滤 —— connectedProvidersForAgent / sourcesForModel 剔除 suspended
 *      供应商(⇒ effectiveSourceIdForModel 不会解析到停用来源)。
 *   3. 标准派生准入 —— deriveModelList / deriveModelSections 剔除 disabled 模型与
 *      非 agent 分组的能力模型(image/embedding 等);keepSelected 豁免保留停用的
 *      当前选中行(运行中的会话不打断)。
 */

import { describe, expect, it } from 'vitest';

import { actualSourceIdForModel, buildRegistry, connectedProvidersForAgent, effectiveSourceIdForModel, sourcesForModel } from '../registry.js';
import { deriveModelList, deriveModelSections } from '../modelList.js';
import { isModelDisabled, isProviderDisabled, modelDisableKey } from '../disableOverrides.js';
import type { Catalog, CatalogModel, Provider } from '../types.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { wireProtocol: 'anthropic-messages', authStrategy: 'api_key' } as never },
    models: { 'claude-code': models },
  };
}

const CATALOG: Catalog = {
  providers: [
    provider('alpha', [model('claude-opus-5'), model('claude-sonnet-5'), model('gpt-image-2')]),
    provider('beta', [model('claude-opus-5')]),
  ],
} as Catalog;

const ALL_CONNECTED = { alpha: true, beta: true };

describe('disableOverrides 决策函数', () => {
  it('key 形状与真值表', () => {
    expect(modelDisableKey('alpha', 'claude-opus-5')).toBe('alpha:claude-opus-5');
    const access = { disabledModels: { 'alpha:claude-opus-5': true }, disabledProviders: { beta: true } };
    expect(isModelDisabled(access, 'alpha', 'claude-opus-5')).toBe(true);
    expect(isModelDisabled(access, 'beta', 'claude-opus-5')).toBe(false);
    expect(isProviderDisabled(access, 'beta')).toBe(true);
    expect(isProviderDisabled(access, 'alpha')).toBe(false);
    expect(isModelDisabled(undefined, 'alpha', 'claude-opus-5')).toBe(false);
    expect(isProviderDisabled(undefined, 'alpha')).toBe(false);
  });
});

describe('buildRegistry 烘焙', () => {
  it('无停用条目时 models 原引用透传(零额外分配)', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledModels: {}, disabledProviders: {} });
    expect(views[0].models).toBe(CATALOG.providers[0].models);
    expect(views[0].suspended).toBeUndefined();
  });

  it('model 停用条目烘焙成 disabled 标志,只落在点名的 (供应商, 模型)', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
      disabledModels: { 'alpha:claude-opus-5': true },
    });
    const alpha = views.find((v) => v.id === 'alpha')!;
    const beta = views.find((v) => v.id === 'beta')!;
    expect(alpha.models['claude-code']!.find((m) => m.id === 'claude-opus-5')!.disabled).toBe(true);
    expect(alpha.models['claude-code']!.find((m) => m.id === 'claude-sonnet-5')!.disabled).toBeUndefined();
    expect(beta.models['claude-code']!.find((m) => m.id === 'claude-opus-5')!.disabled).toBeUndefined();
  });

  it('供应商停用 ⇒ suspended 标志;connected 保持真实连接态', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledProviders: { beta: true } });
    const beta = views.find((v) => v.id === 'beta')!;
    expect(beta.suspended).toBe(true);
    expect(beta.connected).toBe(true);
  });

  it('disableOverrideCount 统计整组 override,含指向已下架模型的陈旧条目(R26)', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
      // gone-model 已不在 alpha 目录里:烘不出任何 disabled 行,但计数必须包含它,
      // 设置页据此保住「全部启用」恢复入口。
      disabledModels: { 'alpha:claude-opus-5': true, 'alpha:gone-model': true },
      disabledProviders: { beta: true },
    });
    const alpha = views.find((v) => v.id === 'alpha')!;
    const beta = views.find((v) => v.id === 'beta')!;
    expect(alpha.disableOverrideCount).toBe(2);
    expect(beta.disableOverrideCount).toBe(1);
    // 无任何 override 的视图缺席该字段(纯附加,不给老端塞 0)。
    const clean = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledModels: {}, disabledProviders: {} });
    expect(clean.find((v) => v.id === 'alpha')!.disableOverrideCount).toBeUndefined();
  });
});

describe('rail 过滤(suspended)', () => {
  const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledProviders: { alpha: true } });

  it('connectedProvidersForAgent 剔除 suspended 供应商', () => {
    expect(connectedProvidersForAgent(views, 'claude-code').map((p) => p.id)).toEqual(['beta']);
  });

  it('sourcesForModel / effectiveSourceIdForModel 不解析到 suspended 来源', () => {
    expect(sourcesForModel(views, 'claude-opus-5', 'claude-code').map((p) => p.id)).toEqual(['beta']);
    expect(effectiveSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('beta');
  });
});

describe('来源过滤(模型级停用拷贝)', () => {
  // 同 id 模型 alpha 家停用、beta 家启用:默认来源解析必须落到 beta(PR #744 review)。
  const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
    disabledModels: { 'alpha:claude-opus-5': true },
  });

  it('sourcesForModel 剔除停用的那份拷贝', () => {
    expect(sourcesForModel(views, 'claude-opus-5', 'claude-code').map((p) => p.id)).toEqual(['beta']);
  });

  it('effectiveSourceIdForModel 落到启用拷贝;全部拷贝停用时解析为 null', () => {
    expect(effectiveSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('beta');
    const allDisabled = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
      disabledModels: { 'alpha:claude-opus-5': true, 'beta:claude-opus-5': true },
    });
    expect(effectiveSourceIdForModel(allDisabled, null, 'claude-opus-5', 'claude-code')).toBeNull();
  });

  it('actualSourceIdForModel(实际路由口径)保留停用拷贝:运行中会话的展示跟真实路由', () => {
    // 准入口径(effective)解析到替代来源 beta;实际路由口径(actual)必须仍是会话
    // 真正在用的来源 —— 显式点名的停用来源原样保留,隐式解析仍落原生默认
    // (PR #744 review 第五轮:图标/价格/Fast/选中行豁免不能显示成替代来源)。
    expect(actualSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('alpha');
    const suspendedAlpha = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
      disabledProviders: { alpha: true },
    });
    expect(actualSourceIdForModel(suspendedAlpha, 'alpha', 'claude-opus-5', 'claude-code')).toBe(
      'alpha',
    );
  });
});

describe('retired tombstone 的新路由与运行中会话分层', () => {
  const retiredCatalog = {
    providers: [
      provider('alpha', [model('claude-opus-5', { status: 'retired' })]),
      provider('beta', [model('claude-opus-5')]),
    ],
  } as Catalog;
  const views = buildRegistry(retiredCatalog, ALL_CONNECTED, {});

  it('effective 新路由跳过 retired；actual 仍保留运行中会话的真实来源', () => {
    expect(effectiveSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('beta');
    expect(actualSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('alpha');
  });

  it('全部 retired 时禁止新选择，但 keepSelected 仍保留当前行', () => {
    const allRetired = buildRegistry(
      {
        providers: [provider('alpha', [model('claude-opus-5', { status: 'retired' })])],
      } as Catalog,
      { alpha: true },
      {},
    );
    expect(effectiveSourceIdForModel(allRetired, null, 'claude-opus-5', 'claude-code')).toBeNull();
    expect(actualSourceIdForModel(allRetired, null, 'claude-opus-5', 'claude-code')).toBe('alpha');
    expect(deriveModelList({ providers: allRetired, agent: 'claude-code' })).toEqual([]);
    expect(
      deriveModelList({
        providers: allRetired,
        agent: 'claude-code',
        keepSelected: { providerId: 'alpha', modelId: 'claude-opus-5' },
      }).map((entry) => entry.id),
    ).toEqual(['claude-opus-5']);
  });
});

describe('未知 group 的例外只限用户供应商', () => {
  it('user 供应商 + group=custom:<id> 且模型名含 image/audio 关键字 ⇒ 仍是 agent 可选模型', () => {
    const views = buildRegistry(
      {
        providers: [
          {
            ...provider('custom-p', [
              model('gpt-4o-audio-preview', { group: 'custom:custom-p' }),
              model('flux-image-x', { group: 'custom:custom-p' }),
            ]),
            source: 'user' as const,
          },
        ],
      } as Catalog,
      { 'custom-p': true },
    );
    const ids = deriveModelList({ providers: views, agent: 'claude-code' }).map((m) => m.id);
    expect(ids).toEqual(['gpt-4o-audio-preview', 'flux-image-x']);
  });

  it('builtin 网关显式下发的 custom:xd 未知组**不**豁免:图像模型仍被硬排除', () => {
    // 即使服务端显式下发未知组,也不能像用户自定义供应商一样获得豁免；否则这类
    // 图像/音频模型会绕过能力分类重新漏进对话清单。
    const views = buildRegistry(
      {
        providers: [
          provider('xd', [
            model('claude-opus-5', { group: 'custom:xd' }),
            model('gpt-image-2', { group: 'custom:xd' }),
          ]),
        ],
      } as Catalog,
      { xd: true },
    );
    const ids = deriveModelList({ providers: views, agent: 'claude-code' }).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5']);
  });
});

describe('标准派生准入(disabled + 能力模型硬排除)', () => {
  const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
    disabledModels: { 'alpha:claude-sonnet-5': true },
  });

  it('deriveModelList 剔除 disabled 模型与 image 等能力模型', () => {
    const ids = deriveModelList({ providers: views, agent: 'claude-code' }).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5']);
  });

  it('deriveModelSections 同口径;keepSelected 豁免保留停用的选中行', () => {
    const sections = deriveModelSections({
      providers: views,
      agent: 'claude-code',
      providerScope: 'as-given',
      keepSelected: { providerId: 'alpha', modelId: 'claude-sonnet-5' },
    });
    const alpha = sections.find((s) => s.provider.id === 'alpha')!;
    // 停用的选中行豁免保留(运行中的会话不打断);image 能力模型仍被硬排除。
    expect(alpha.models.map((m) => m.id).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('keepSelected **不**豁免能力模型:历史坑遗留的图像模型选中项不再回到清单', () => {
    const sections = deriveModelSections({
      providers: views,
      agent: 'claude-code',
      providerScope: 'as-given',
      keepSelected: { providerId: 'alpha', modelId: 'gpt-image-2' },
    });
    const alpha = sections.find((s) => s.provider.id === 'alpha')!;
    expect(alpha.models.map((m) => m.id)).toEqual(['claude-opus-5']);
  });
});

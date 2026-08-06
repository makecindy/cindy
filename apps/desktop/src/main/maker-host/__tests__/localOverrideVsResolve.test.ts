/**
 * localOverrideVsResolve —— 验证「local override 永远最高」在 **resolve 富化层** 是否成立。
 *
 * 为什么单独一个文件:modelPlane.test.ts 只验 local 对 registry / discovery 的优先级,
 * activeCatalogRevision.test.ts 只验 resolve overlay 自身;**没有任何用例把两者摞在一起**。
 * 而 computeMerged 里 resolve 是最后一层(active-catalog.ts 注释:"deliberately applied
 * after ... local override"),且 applyResolvedOverlay 用 `{ ...model, ...replacement }`
 * 逐字段盖 —— 所以「本地改了会不会被 resolve 盖掉」只能实测。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG, type CatalogModel } from '@cindy/model-providers';

import {
  getActiveCatalog,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setDiscoveredCodexModels,
  setDiscoveredProviderModels,
  setLocalCatalogOverrides,
  setResolvedProviderModels,
} from '../active-catalog.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
} from '../model-plane/localCatalogOverrides.js';

const MODEL_ID = 'xai/override-probe';

/** 发现层给出的「远端事实」。 */
const discovered: CatalogModel[] = [
  {
    id: MODEL_ID,
    name: 'Discovered Name',
    status: 'active',
    contextWindow: 200_000,
    efforts: ['low'],
    defaultEffort: 'low',
  },
];

function xaiCodexIds(): string[] {
  return getActiveCatalog()
    .providers.find((p) => p.id === 'xai')
    ?.models.codex?.map((m) => m.id) ?? [];
}

function xaiCodexModel(): CatalogModel | undefined {
  return getActiveCatalog()
    .providers.find((p) => p.id === 'xai')
    ?.models.codex?.find((m) => m.id === MODEL_ID);
}

function applyLocalPatch(fields: Record<string, unknown>): void {
  const { overrides, invalid } = sanitizeModelCatalogOverrides({
    patches: { [`xai:${MODEL_ID}`]: { agents: ['codex'], base: fields } },
  });
  // 先确认这条 override 本身是合法的,否则「local 没生效」会被误读成优先级问题。
  expect(invalid).toEqual([]);
  setLocalCatalogOverrides(overrides);
}

describe('local override vs resolve 富化层的优先级', () => {
  afterEach(() => {
    setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    setResolvedProviderModels('xai', 'codex', [], [], 'reset');
    setDiscoveredProviderModels('xai', 'codex', []);
    setAnthropicDiscoveredModels([]);
    setDiscoveredCodexModels([]);
    setActiveCatalog(BUNDLED_CATALOG);
  });

  it('基线:没有 resolve 时,local patch 压过发现层', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredProviderModels('xai', 'codex', discovered);
    applyLocalPatch({ contextWindow: 999_999 });

    expect(xaiCodexModel()?.contextWindow).toBe(999_999);
  });

  it('关键:resolve 返回不同 contextWindow 时,local patch 是否仍然胜出', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredProviderModels('xai', 'codex', discovered);
    applyLocalPatch({ contextWindow: 999_999 });

    // snapshot key 必须匹配真实清单,否则 overlay 整层跳过、断言空转(第一版就踩了这个坑)。
    expect(xaiCodexIds()).toContain(MODEL_ID);
    // 服务端 resolve 给出 300_000(与本地改的 999_999 冲突)。
    setResolvedProviderModels(
      'xai',
      'codex',
      [MODEL_ID],
      [{ ...discovered[0], contextWindow: 300_000 }],
      'rev-1',
      xaiCodexIds(),
    );

    // 文件头承诺「local 永远最高:远端刷新只换 remote 层、绝不能覆盖本地修改」。
    expect(xaiCodexModel()?.contextWindow).toBe(999_999);
  });

  it('关键:resolve 改展示字段(name)时,local patch 是否仍然胜出', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredProviderModels('xai', 'codex', discovered);
    applyLocalPatch({ name: 'Local Name' });

    setResolvedProviderModels(
      'xai',
      'codex',
      [MODEL_ID],
      [{ ...discovered[0], name: 'Resolved Name' }],
      'rev-2',
      xaiCodexIds(),
    );

    expect(xaiCodexModel()?.name).toBe('Local Name');
  });

  it('关键:resolve 改 efforts 时,local patch 是否仍然胜出', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredProviderModels('xai', 'codex', discovered);
    applyLocalPatch({ efforts: ['high'], defaultEffort: 'high' });

    setResolvedProviderModels(
      'xai',
      'codex',
      [MODEL_ID],
      [{ ...discovered[0], efforts: ['low', 'medium'], defaultEffort: 'medium' }],
      'rev-3',
      xaiCodexIds(),
    );

    expect(xaiCodexModel()?.efforts).toEqual(['high']);
    expect(xaiCodexModel()?.defaultEffort).toBe('high');
  });

  it('resolve 只补 local 没碰过的字段时应当生效(富化不该被整层丢弃)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredProviderModels('xai', 'codex', discovered);
    applyLocalPatch({ contextWindow: 999_999 });

    setResolvedProviderModels(
      'xai',
      'codex',
      [MODEL_ID],
      [{ ...discovered[0], contextWindow: 300_000, description: 'From resolve' }],
      'rev-4',
      xaiCodexIds(),
    );

    expect(xaiCodexModel()?.description).toBe('From resolve');
  });
});

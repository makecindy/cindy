import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';
import { getSettingsPublicIdentifiers, settingsPublicIdentifiersFromBundledCatalog } from '../publicIdentifiers.js';

function catalog(): Catalog {
  return {
    version: 'fixture',
    providers: [{ ...BUNDLED_CATALOG.providers[0]!, id: 'public-provider', models: {
      codex: [{ id: 'public-model', name: '公开型号', contextWindow: 4096, efforts: ['medium'], defaultEffort: 'medium' }],
    } }],
    modelRegistry: {
      schemaVersion: 2, updatedAt: '2026-09-01', models: [{ id: 'public-canonical', name: '公开名称',
        routes: [{ providerId: 'public-route-provider', modelId: 'vendor/public-route', agents: ['codex'] }],
      }],
    },
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('只由随包公共目录建立精确公开证据', () => {
  it('收录明示的provider、catalog型号、canonical及路由，不做别名归一化', () => {
    const ids = settingsPublicIdentifiersFromBundledCatalog(catalog());
    expect([...ids.providers].sort()).toEqual(['public-provider', 'public-route-provider']);
    expect([...ids.models].sort()).toEqual(['public-canonical', 'public-model', 'vendor/public-route']);
    for (const name of ['公开名称', 'public-model-more', 'public-model[1m]', 'public-route', 'vendor/public-route-more']) {
      expect(ids.models.has(name)).toBe(false);
    }
  });
  it('不读取目录之外的自定义配置、凭据或展示正文', () => {
    const input = catalog();
    const forbidden = vi.fn(() => { throw new Error('不得读取非公开属性'); });
    Object.defineProperty(input, 'customConfigs', { get: forbidden });
    Object.defineProperty(input.providers[0]!, 'auth', { get: forbidden });
    Object.defineProperty(input.providers[0]!, 'name', { get: forbidden });
    Object.defineProperty(input.modelRegistry!.models[0]!, 'name', { get: forbidden });
    expect(settingsPublicIdentifiersFromBundledCatalog(input).models.has('public-canonical')).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('没有目录成员就不给公开证据，不借语法合法猜测', () => {
    expect(settingsPublicIdentifiersFromBundledCatalog({ version: 'empty', providers: [] })).toEqual({ models: new Set(), providers: new Set() });
  });
  it('生产入口只用随包值，无网络且不改变目录，返回值互不污染', () => {
    const network = vi.fn(() => { throw new Error('不得联网发现'); });
    vi.stubGlobal('fetch', network);
    const before = JSON.stringify(BUNDLED_CATALOG);
    const expected = settingsPublicIdentifiersFromBundledCatalog(BUNDLED_CATALOG);
    const first = getSettingsPublicIdentifiers();
    const second = getSettingsPublicIdentifiers();
    expect(first).toEqual(expected); expect(second).toEqual(expected);
    expect(first.models).not.toBe(second.models); expect(first.providers).not.toBe(second.providers);
    expect(JSON.stringify(BUNDLED_CATALOG)).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });
});

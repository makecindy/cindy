import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';
import type { SettingsPublicIdentifiers } from './snapshotProjectionV2.js';

/** 随包公开目录的精确成员关系。不用活动目录、模糊别名、前缀或当前账号可用性作证明。 */
export function settingsPublicIdentifiersFromBundledCatalog(catalog: Catalog): SettingsPublicIdentifiers {
  const models = new Set<string>();
  const providers = new Set<string>();
  for (const provider of catalog.providers) {
    providers.add(provider.id);
    for (const list of Object.values(provider.models)) for (const model of list ?? []) models.add(model.id);
  }
  for (const model of catalog.modelRegistry?.models ?? []) {
    models.add(model.id);
    for (const route of model.routes) { providers.add(route.providerId); models.add(route.modelId); }
  }
  return { models, providers };
}

/** 只读静态常量，不触发联网、发现、授权或用户配置加载。 */
export function getSettingsPublicIdentifiers(): SettingsPublicIdentifiers {
  return settingsPublicIdentifiersFromBundledCatalog(BUNDLED_CATALOG);
}

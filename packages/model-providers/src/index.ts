/**
 * @cindy/model-providers — 模型供应商目录 + 路由抽象（纯逻辑，零 Electron / maker-core 运行时依赖）。
 *
 * - types：Provider / CatalogModel / RoutingDescriptor（models.dev 形状 + agents/routing/runtime 扩展）
 * - catalog：内置目录 BUNDLED_CATALOG + parseCatalog 校验
 * - source：目录源解析与加载（公共 API / 旧 OSS / 本地 / bundled 兜底，IO 由 host 注入）
 * - registry：连接状态合成、按 agent 算可见性、resolveRoute 解析路由素材
 */

export type {
  AgentKind,
  ProviderWireProtocol,
  Effort,
  ProviderSource,
  AuthMethod,
  ProviderAccess,
  AuthStrategy,
  RoutingDescriptor,
  ModelCost,
  CatalogModel,
  Provider,
  Catalog,
  CustomProviderConfig,
  CustomProviderRuntimeConfig,
  ProviderRuntimeModelConfig,
  ProviderPreset,
  ProviderPresetRuntime,
  OAuthProviderDescriptor,
} from './types.js';

export { BUNDLED_CATALOG, BUILTIN_PROVIDERS, parseCatalog, presetDisplayName, sanitizePresets, sortPresetsForLocale } from './catalog.js';

export { buildUserProvider, DEFAULT_CUSTOM_CONTEXT_WINDOW } from './user-provider.js';

export {
  CATALOG_API_PATH,
  CATALOG_CFG_PATH,
  DEFAULT_REMOTE_CATALOG_BUDGET_MS,
  resolveCatalogUrl,
  resolveFallbackCatalogUrl,
  mergeWithBundled,
  loadCatalog,
} from './source.js';
export type { CatalogSourceConfig, CatalogIO } from './source.js';

export {
  buildRegistry,
  providersForAgent,
  connectedProvidersForAgent,
  nativeDefaultSourceId,
  effectiveSourceIdForModel,
  providerOffersModel,
  getModel,
  sourcesForModel,
  resolveRoute,
  modelSupportsFastMode,
  sessionModelSupportsFastMode,
} from './registry.js';
export type { ConnectionState, ProviderView, ResolvedRoute } from './registry.js';

export { isModelVisible, buildProviderSections, visibleModelUnion, resolveModelIconKind } from './sections.js';
export type { SectionModel, ProviderSection, ModelIconKind } from './sections.js';

export { resolveEffort, resolveProviderSwitchEffort, clampEffortToSupported } from './effortResolution.js';

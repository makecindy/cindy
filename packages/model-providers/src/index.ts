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
  CodexCompatibilityWireProtocol,
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
  OAuthAuthorizationCodeDescriptor,
  OAuthDeviceCodeDescriptor,
  OAuthProviderDescriptor,
} from './types.js';

export { resolveCodexCompatibilityWireProtocol } from './codexCompatibility.js';

export { BUNDLED_CATALOG, BUILTIN_PROVIDERS, parseCatalog, presetDisplayName, sanitizePresets, sortPresetsForLocale } from './catalog.js';

export { buildUserProvider, DEFAULT_CUSTOM_CONTEXT_WINDOW } from './user-provider.js';
export {
  appendProviderRequestPath,
  isLoopbackProviderUrl,
  isProviderRequestPath,
} from './provider-url.js';
export { findReservedOAuthExtraParam } from './provider-oauth.js';

export {
  CATALOG_API_PATH,
  CATALOG_CFG_PATH,
  DEFAULT_REMOTE_CATALOG_BUDGET_MS,
  resolveCatalogUrl,
  resolveFallbackCatalogUrl,
  mergeWithBundled,
  loadCatalog,
  loadCatalogWithSource,
} from './source.js';
export type {
  CatalogSourceConfig,
  CatalogIO,
  CatalogLoadResult,
  CatalogLoadSource,
} from './source.js';

export {
  buildRegistry,
  providersForAgent,
  connectedProvidersForAgent,
  nativeDefaultSourceId,
  effectiveSourceIdForModel,
  actualSourceIdForModel,
  providerOffersModel,
  getModel,
  sourcesForModel,
  chatEligibleSourcesForModel,
  resolveRoute,
  modelSupportsFastMode,
  sessionModelSupportsFastMode,
} from './registry.js';
export type {
  ConnectionState,
  ModelDiscoveryFailureState,
  ProviderModelDiscoveryFailure,
  ProviderModelDiscoveryFailureView,
  ProviderView,
  ResolvedRoute,
} from './registry.js';

export {
  modelDisableKey,
  isModelDisabled,
  isProviderDisabled,
} from './disableOverrides.js';
export type { ModelDisableOverrides } from './disableOverrides.js';

export { isModelVisible, buildProviderSections, visibleModelUnion, resolveModelIconKind } from './sections.js';
export type { SectionModel, ProviderSection, ModelIconKind } from './sections.js';

export {
  resolveEffort,
  resolveProviderSwitchEffort,
  clampEffortToSupported,
  EFFORT_VALUES,
  effortRank,
  lowestEffort,
  nearestSupportedEffort,
  reconcileInvocationEffort,
} from './effortResolution.js';

// ── 模型调用标准(2026-07 统一层)─────────────────────────────────────────────
// 清单派生 / 分类徽章 / 调用合成的单点语义,desktop renderer+main 与 mobile 的全部
// 模型消费面分期收口到这里(见 modelList.ts / classification.ts / invocation.ts 头注)。
export { deriveModelList, deriveModelSections } from './modelList.js';
export type {
  ModelSourceMeta,
  ModelListEntry,
  ModelListSection,
  DeriveModelListOptions,
  ProviderScope,
} from './modelList.js';

export {
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
  SUBSCRIPTION_DIRECT_MODEL_PREFIXES,
  isSubscriptionDirectModel,
  CATEGORY_ORDER,
  CHAT_VENDOR_CATEGORY_ORDER,
  categorize,
  classifyModel,
  isChatEligible,
  groupOf,
  isAgentSelectableModel,
  groupModelsForDisplay,
  isBudgetModel,
  modelBadges,
  formatContextWindow,
} from './classification.js';
export type { ModelCategory, DisplayModel, ModelBadges } from './classification.js';

export { resolveModelInvocation } from './invocation.js';
export type {
  InvocationPreferences,
  ScenarioDefaults,
  InvocationCatalogContext,
  ResolvedInvocation,
} from './invocation.js';

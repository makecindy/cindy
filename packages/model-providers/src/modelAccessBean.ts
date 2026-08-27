/**
 * Client-owned DTOs for the Model Access HTTP/catalog boundary.
 *
 * These types deliberately live with the client domain model instead of in a
 * cross-repository package. Runtime parsing still uses the legacy shared
 * validator during the migration; keeping the DTOs local lets the validator
 * move independently in the next phase without changing the wire shape.
 */

export const MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION = 1 as const;
export const MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION = 2 as const;
export const MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION = 3 as const;
export const MODEL_ACCESS_CATALOG_SCHEMA_VERSION = 4 as const;
export const MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION = 5 as const;
export const MODEL_ACCESS_MODELS_PATH = '/api/model-access/models' as const;

export const MODEL_ACCESS_CURRENCIES = ['CNY', 'USD'] as const;
export type ModelCurrency = (typeof MODEL_ACCESS_CURRENCIES)[number];

export const MODEL_ACCESS_V2_AGENTS = ['claude-code', 'codex'] as const;
export const MODEL_ACCESS_AGENTS = ['claude-code', 'codex', 'pi'] as const;
export type ModelAgent = (typeof MODEL_ACCESS_AGENTS)[number];
export type ModelAccessV2Agent = (typeof MODEL_ACCESS_V2_AGENTS)[number];

export const MODEL_ACCESS_WIRE_PROTOCOLS = ['anthropic-messages', 'openai-responses'] as const;
export type ModelAccessWireProtocol = (typeof MODEL_ACCESS_WIRE_PROTOCOLS)[number];

export const MODEL_ACCESS_MEDIA_CAPABILITIES = [
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
] as const;
export type MediaCapability = (typeof MODEL_ACCESS_MEDIA_CAPABILITIES)[number];

export const MODEL_ACCESS_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ModelEffort = (typeof MODEL_ACCESS_EFFORTS)[number];

export const MODEL_REGISTRY_LEGACY_SCHEMA_VERSION = 1 as const;
export const MODEL_REGISTRY_SCHEMA_VERSION = 2 as const;
export const MODEL_REGISTRY_STATUSES = ['preview', 'active', 'deprecated', 'retired'] as const;
export type ModelRegistryStatus = (typeof MODEL_REGISTRY_STATUSES)[number];

export const MODEL_PRICE_VARIANTS = ['standard', 'priority', 'batch', 'fast'] as const;
export type ModelPriceVariant = (typeof MODEL_PRICE_VARIANTS)[number];

export interface ModelReferencePriceSource {
  kind: 'provider-official';
  url: string;
  verifiedAt: string;
}

export interface ModelReferencePrice {
  currency: ModelCurrency;
  variant: ModelPriceVariant;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
  cacheWrite1hPerMtok?: number;
  minInputTokens?: number;
  maxInputTokens?: number;
  effectiveFrom: string;
  effectiveUntil?: string;
  source: ModelReferencePriceSource;
}

export interface ModelRegistryRoute {
  providerId: string;
  modelId: string;
  agents: ModelAccessV2Agent[];
  referencePrices?: ModelReferencePrice[];
}

export interface ModelAgentOverride {
  contextWindow?: number;
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  wireProtocol?: ModelAccessWireProtocol;
}

interface ModelRegistryEntryBase {
  id: string;
  name: string;
  routes: ModelRegistryRoute[];
  status?: ModelRegistryStatus;
  group?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort;
  sortOrder?: number;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  perAgent?: Partial<Record<ModelAgent, ModelAgentOverride>>;
}

export interface ModelRegistryEntryV1 extends ModelRegistryEntryBase {
  newSessionDefault?: never;
}

export interface ModelRegistryEntry extends ModelRegistryEntryBase {
  newSessionDefault?: ModelAccessV2Agent[];
}

interface ModelRegistryBase {
  updatedAt: string;
}

export interface ModelRegistry extends ModelRegistryBase {
  schemaVersion: typeof MODEL_REGISTRY_LEGACY_SCHEMA_VERSION | typeof MODEL_REGISTRY_SCHEMA_VERSION;
  models: ModelRegistryEntry[];
}

export interface ModelRegistryV1 extends ModelRegistryBase {
  schemaVersion: typeof MODEL_REGISTRY_LEGACY_SCHEMA_VERSION;
  models: ModelRegistryEntryV1[];
}

export interface ModelRegistryV2 extends ModelRegistry {
  schemaVersion: typeof MODEL_REGISTRY_SCHEMA_VERSION;
}

export interface ModelTieredPricing {
  range: [number, number];
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
}

export interface ModelPricing {
  costDiscount?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  inputCostPerTokenPriority?: number;
  outputCostPerTokenPriority?: number;
  cacheReadInputTokenCost?: number;
  cacheReadInputTokenCostPriority?: number;
  cacheCreationInputTokenCost?: number;
  inputCostPerTokenAbove200kTokens?: number;
  outputCostPerTokenAbove200kTokens?: number;
  cacheReadInputTokenCostAbove200kTokens?: number;
  inputCostPerTokenAbove200kTokensPriority?: number;
  outputCostPerTokenAbove200kTokensPriority?: number;
  cacheReadInputTokenCostAbove200kTokensPriority?: number;
  inputCostPerTokenAbove272kTokens?: number;
  outputCostPerTokenAbove272kTokens?: number;
  cacheReadInputTokenCostAbove272kTokens?: number;
  inputCostPerTokenAbove272kTokensPriority?: number;
  outputCostPerTokenAbove272kTokensPriority?: number;
  cacheReadInputTokenCostAbove272kTokensPriority?: number;
  inputCostPerCharacter?: number;
  outputCostPerCharacter?: number;
  inputCostPerSecond?: number;
  outputCostPerSecond?: number;
  inputCostPerAudioToken?: number;
  outputCostPerAudioToken?: number;
  inputCostPerAudioPerSecond?: number;
  outputCostPerAudioPerSecond?: number;
  inputCostPerImage?: number;
  outputCostPerImage?: number;
  inputCostPerImageToken?: number;
  outputCostPerImageToken?: number;
  cacheReadInputImageTokenCost?: number;
  inputCostPerVideoPerSecond?: number;
  outputCostPerVideoPerSecond?: number;
  tieredPricing?: ModelTieredPricing[];
}

export interface ModelModalities {
  input: string[];
  output: string[];
}

interface ModelCatalogAgentOverride extends Omit<ModelAgentOverride, 'defaultEffort'> {
  /** Older Model Access responses use null to mean that no effort is preferred. */
  defaultEffort?: ModelEffort | null;
}

interface ModelCatalogEntryBase extends ModelPricing {
  id: string;
  mode?: string;
  /** Optional for compatibility with older Model Access responses. */
  currency?: ModelCurrency;
  /** Missing or empty legacy values default to claude-code in the Desktop catalog. */
  agents?: ModelAgent[];
  name?: string;
  group?: string;
  description?: string;
  icon?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: ModelModalities;
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort | null;
  sortOrder?: number;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  perAgent?: Partial<Record<ModelAgent, ModelCatalogAgentOverride>>;
}

export interface ModelCatalogEntryV1 extends ModelCatalogEntryBase {
  newSessionDefault?: never;
}

export interface ModelCatalogEntry extends ModelCatalogEntryBase {
  newSessionDefault?: ModelAgent[];
}

export type ModelAccessAvailability = 'available' | 'requires_payment';
export type ModelAccessAccountTier = 'free' | 'paid' | 'not_applicable';

export interface ModelCatalogEntryV5 extends ModelCatalogEntry {
  availability: ModelAccessAvailability;
}

export interface ListModelsResponse {
  schemaVersion:
    | typeof MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION;
  models: ModelCatalogEntry[];
  accountTier?: ModelAccessAccountTier;
}

export interface ListModelsResponseV1 {
  schemaVersion: typeof MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION;
  models: ModelCatalogEntryV1[];
}

export interface ListModelsResponseV2 extends ListModelsResponse {
  schemaVersion: typeof MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION;
}

export interface ListModelsResponseV3 extends ListModelsResponse {
  schemaVersion: typeof MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION;
  models: Array<ModelCatalogEntry & { name: string; contextWindow: number }>;
}

export interface ListModelsResponseV4 extends ListModelsResponse {
  schemaVersion: typeof MODEL_ACCESS_CATALOG_SCHEMA_VERSION;
  models: Array<ModelCatalogEntry & { name: string }>;
}

export interface ListModelsResponseV5 extends ListModelsResponse {
  schemaVersion: typeof MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION;
  accountTier: ModelAccessAccountTier;
  models: Array<ModelCatalogEntryV5 & { name: string }>;
}

/** Result returned by local Model Access boundary parsers. */
export type ModelAccessParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

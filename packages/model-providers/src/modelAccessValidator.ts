import {
  validModelMetadata,
  expandedRegistryEntries,
} from "./modelMetadataLayers.js";
import { parseLocalModelCatalog } from "./localModelCatalog.js";
import {
  MODEL_ACCESS_AGENTS,
  MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION,
  MODEL_ACCESS_CURRENCIES,
  MODEL_ACCESS_EFFORTS,
  MODEL_ACCESS_V2_AGENTS,
  MODEL_ACCESS_WIRE_PROTOCOLS,
  MODEL_PRICE_VARIANTS,
  MODEL_REGISTRY_LEGACY_SCHEMA_VERSION,
  MODEL_REGISTRY_SCHEMA_VERSION,
  MODEL_REGISTRY_V3_SCHEMA_VERSION,
  MODEL_REGISTRY_V4_SCHEMA_VERSION,
  MODEL_REGISTRY_V5_SCHEMA_VERSION,
  MODEL_NATIVE_APIS,
  MODEL_REGISTRY_STATUSES,
  type ListModelsResponse,
  type ModelAccessParseResult,
  type ModelAccessV2Agent,
  type ModelAgent,
  type ModelCurrency,
  type ModelEffort,
  type ModelPriceVariant,
  type ModelRegistry,
  type ModelRegistryEntry,
  type ModelRegistryStatus,
} from "./modelAccessBean.js";

/** Local strict validator for untrusted Model Access catalog and Registry payloads. */
type PlainObject = Record<string, unknown>;

const PRICING_FIELDS = [
  "costDiscount",
  "inputCostPerToken",
  "outputCostPerToken",
  "inputCostPerTokenPriority",
  "outputCostPerTokenPriority",
  "cacheReadInputTokenCost",
  "cacheReadInputTokenCostPriority",
  "cacheCreationInputTokenCost",
  "inputCostPerTokenAbove200kTokens",
  "outputCostPerTokenAbove200kTokens",
  "cacheReadInputTokenCostAbove200kTokens",
  "inputCostPerTokenAbove200kTokensPriority",
  "outputCostPerTokenAbove200kTokensPriority",
  "cacheReadInputTokenCostAbove200kTokensPriority",
  "inputCostPerTokenAbove272kTokens",
  "outputCostPerTokenAbove272kTokens",
  "cacheReadInputTokenCostAbove272kTokens",
  "inputCostPerTokenAbove272kTokensPriority",
  "outputCostPerTokenAbove272kTokensPriority",
  "cacheReadInputTokenCostAbove272kTokensPriority",
  "inputCostPerCharacter",
  "outputCostPerCharacter",
  "inputCostPerSecond",
  "outputCostPerSecond",
  "inputCostPerAudioToken",
  "outputCostPerAudioToken",
  "inputCostPerAudioPerSecond",
  "outputCostPerAudioPerSecond",
  "inputCostPerImage",
  "outputCostPerImage",
  "inputCostPerImageToken",
  "outputCostPerImageToken",
  "cacheReadInputImageTokenCost",
  "inputCostPerVideoPerSecond",
  "outputCostPerVideoPerSecond",
] as const;

const LIST_MODELS_RESPONSE_FIELDS = ["schemaVersion", "models"] as const;
// v1 is frozen at its deployed wire shape. `mode` and `modalities` predate this
// shared parser and are listed explicitly so strict dual-reading does not reject
// current producers while still preventing fields from a different schema from
// being accepted under version 1.
const MODEL_CATALOG_ENTRY_V1_FIELDS = [
  "id",
  "mode",
  "currency",
  "agents",
  "name",
  "group",
  "description",
  "icon",
  "contextWindow",
  "maxOutputTokens",
  "modalities",
  "efforts",
  "defaultEffort",
  "sortOrder",
  "supportsFastMode",
  "defaultEnabled",
  "perAgent",
  ...PRICING_FIELDS,
  "tieredPricing",
] as const;
const MODEL_CATALOG_ENTRY_V2_FIELDS = [
  ...MODEL_CATALOG_ENTRY_V1_FIELDS,
  "newSessionDefault",
] as const;
const MODEL_CATALOG_ENTRY_V3_FIELDS = MODEL_CATALOG_ENTRY_V2_FIELDS;
const MODEL_AGENT_OVERRIDE_FIELDS = [
  "contextWindow",
  "efforts",
  "defaultEffort",
  "supportsFastMode",
  "defaultEnabled",
] as const;
const MODEL_AGENT_OVERRIDE_V3_FIELDS = [
  ...MODEL_AGENT_OVERRIDE_FIELDS,
  "wireProtocol",
] as const;
const MODEL_TIERED_PRICING_FIELDS = [
  "range",
  "inputCostPerToken",
  "outputCostPerToken",
  "cacheReadInputTokenCost",
  "cacheCreationInputTokenCost",
] as const;
const MODEL_MODALITIES_FIELDS = ["input", "output"] as const;

const MODEL_REGISTRY_FIELDS = ["schemaVersion", "updatedAt", "models"] as const;
const MODEL_REGISTRY_ENTRY_V1_FIELDS = [
  "id",
  "name",
  "routes",
  "status",
  "group",
  "description",
  "contextWindow",
  "maxOutputTokens",
  "efforts",
  "defaultEffort",
  "sortOrder",
  "supportsFastMode",
  "defaultEnabled",
  "perAgent",
] as const;
const MODEL_REGISTRY_ENTRY_V2_FIELDS = [
  ...MODEL_REGISTRY_ENTRY_V1_FIELDS,
  "newSessionDefault",
] as const;
const MODEL_REGISTRY_ROUTE_FIELDS = [
  "providerId",
  "modelId",
  "agents",
  "referencePrices",
] as const;
const MODEL_REFERENCE_PRICE_FIELDS = [
  "currency",
  "variant",
  "inputPerMtok",
  "outputPerMtok",
  "cacheReadPerMtok",
  "cacheWritePerMtok",
  "cacheWrite1hPerMtok",
  "minInputTokens",
  "maxInputTokens",
  "effectiveFrom",
  "effectiveUntil",
  "source",
] as const;
const MODEL_REFERENCE_PRICE_SOURCE_FIELDS = [
  "kind",
  "url",
  "verifiedAt",
] as const;

function ok<T>(value: T): ModelAccessParseResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): ModelAccessParseResult<T> {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFieldError(
  value: PlainObject,
  allowedFields: readonly string[],
  path: string,
): string | null {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  return unknown
    ? `${path}.${unknown} is not allowed by this schema version`
    : null;
}

export function isModelCurrency(value: unknown): value is ModelCurrency {
  return (
    typeof value === "string" &&
    MODEL_ACCESS_CURRENCIES.includes(value as ModelCurrency)
  );
}

function isModelAgent(value: unknown): value is ModelAgent {
  return (
    typeof value === "string" &&
    MODEL_ACCESS_AGENTS.includes(value as ModelAgent)
  );
}

function isV2ModelAgent(value: unknown): value is ModelAccessV2Agent {
  return (
    typeof value === "string" && MODEL_ACCESS_V2_AGENTS.includes(value as never)
  );
}

function isModelAccessWireProtocol(value: unknown): boolean {
  return (
    typeof value === "string" &&
    MODEL_ACCESS_WIRE_PROTOCOLS.includes(value as never)
  );
}

function acceptsWireProtocol(agent: ModelAgent, protocol: unknown): boolean {
  if (!isModelAccessWireProtocol(protocol)) return false;
  if (agent === "pi") return true;
  return (
    protocol ===
    (agent === "claude-code" ? "anthropic-messages" : "openai-responses")
  );
}

function isModelEffort(value: unknown): value is ModelEffort {
  return (
    typeof value === "string" &&
    MODEL_ACCESS_EFFORTS.includes(value as ModelEffort)
  );
}

function isModelRegistryStatus(value: unknown): value is ModelRegistryStatus {
  return (
    typeof value === "string" &&
    MODEL_REGISTRY_STATUSES.includes(value as ModelRegistryStatus)
  );
}

function isModelPriceVariant(value: unknown): value is ModelPriceVariant {
  return (
    typeof value === "string" &&
    MODEL_PRICE_VARIANTS.includes(value as ModelPriceVariant)
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function referencePriceRangesOverlap(a: PlainObject, b: PlainObject): boolean {
  if (a.currency !== b.currency || a.variant !== b.variant) return false;
  const aMin = typeof a.minInputTokens === "number" ? a.minInputTokens : 0;
  const bMin = typeof b.minInputTokens === "number" ? b.minInputTokens : 0;
  const aMax =
    typeof a.maxInputTokens === "number"
      ? a.maxInputTokens
      : Number.POSITIVE_INFINITY;
  const bMax =
    typeof b.maxInputTokens === "number"
      ? b.maxInputTokens
      : Number.POSITIVE_INFINITY;
  const tokenRangesOverlap = aMin < bMax && bMin < aMax;
  const aUntil = typeof a.effectiveUntil === "string" ? a.effectiveUntil : null;
  const bUntil = typeof b.effectiveUntil === "string" ? b.effectiveUntil : null;
  const dateRangesOverlap =
    (bUntil === null || String(a.effectiveFrom) < bUntil) &&
    (aUntil === null || String(b.effectiveFrom) < aUntil);
  return tokenRangesOverlap && dateRangesOverlap;
}

function isSafeSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function optionalStringError(
  value: unknown,
  path: string,
  max: number,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${path} must be a string when present`;
  if (value.length > max)
    return `${path} must contain at most ${max} characters`;
  return null;
}

function optionalPositiveIntegerError(
  value: unknown,
  path: string,
): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return `${path} must be a positive integer when present`;
  }
  return null;
}

function optionalFiniteNumberError(
  value: unknown,
  path: string,
  options: { nonNegative?: boolean } = {},
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${path} must be a finite number when present`;
  }
  if (options.nonNegative && value < 0) {
    return `${path} must be non-negative when present`;
  }
  return null;
}

function effortListError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((effort) => !isModelEffort(effort))) {
    return `${path} must contain only supported effort values`;
  }
  return null;
}

function modelModalitiesError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${path} must be an object when present`;
  const unknownField = unknownFieldError(value, MODEL_MODALITIES_FIELDS, path);
  if (unknownField) return unknownField;
  for (const direction of MODEL_MODALITIES_FIELDS) {
    if (
      !Array.isArray(value[direction]) ||
      value[direction].some((item) => typeof item !== "string")
    ) {
      return `${path}.${direction} must be an array of strings`;
    }
  }
  return null;
}

function overrideError(
  value: unknown,
  path: string,
  baseEfforts: readonly ModelEffort[] | undefined,
  allowedFields?: readonly string[],
  allowNullDefaultEffort = false,
  baseDefaultEffort?: ModelEffort | null,
  validateDependencies = true,
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = allowedFields
    ? unknownFieldError(value, allowedFields, path)
    : null;
  if (error) return error;
  error = optionalPositiveIntegerError(
    value.contextWindow,
    `${path}.contextWindow`,
  );
  if (error) return error;
  error = effortListError(value.efforts, `${path}.efforts`);
  if (error) return error;
  if (
    value.defaultEffort !== undefined &&
    value.defaultEffort !== null &&
    !isModelEffort(value.defaultEffort)
  ) {
    return `${path}.defaultEffort must be a supported effort value when present`;
  }
  if (value.defaultEffort === null && !allowNullDefaultEffort) {
    return `${path}.defaultEffort must be a supported effort value when present`;
  }
  const effectiveEfforts =
    Array.isArray(value.efforts) && value.efforts.every(isModelEffort)
      ? (value.efforts as ModelEffort[])
      : baseEfforts;
  if (
    validateDependencies &&
    isModelEffort(value.defaultEffort) &&
    effectiveEfforts !== undefined &&
    !effectiveEfforts.includes(value.defaultEffort)
  ) {
    return `${path}.defaultEffort must be included in ${path}.efforts or the base efforts`;
  }
  if (
    validateDependencies &&
    value.defaultEffort === undefined &&
    isModelEffort(baseDefaultEffort) &&
    effectiveEfforts !== undefined &&
    !effectiveEfforts.includes(baseDefaultEffort)
  ) {
    return `${path}.efforts must include the inherited base defaultEffort`;
  }
  for (const key of ["supportsFastMode", "defaultEnabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return `${path}.${key} must be a boolean when present`;
    }
  }
  return null;
}

function tieredPricingError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${path} must be an array when present`;
  for (const [index, tier] of value.entries()) {
    const tierPath = `${path}[${index}]`;
    if (!isPlainObject(tier)) return `${tierPath} must be an object`;
    const unknownField = unknownFieldError(
      tier,
      MODEL_TIERED_PRICING_FIELDS,
      tierPath,
    );
    if (unknownField) return unknownField;
    if (
      !Array.isArray(tier.range) ||
      tier.range.length !== 2 ||
      tier.range.some(
        (bound) => typeof bound !== "number" || !Number.isFinite(bound),
      ) ||
      tier.range[0] < 0 ||
      tier.range[1] < tier.range[0]
    ) {
      return `${tierPath}.range must be an ascending pair of non-negative finite numbers`;
    }
    for (const field of [
      "inputCostPerToken",
      "outputCostPerToken",
      "cacheReadInputTokenCost",
      "cacheCreationInputTokenCost",
    ] as const) {
      const error = optionalFiniteNumberError(
        tier[field],
        `${tierPath}.${field}`,
        {
          nonNegative: true,
        },
      );
      if (error) return error;
    }
  }
  return null;
}

function newSessionDefaultError(
  value: unknown,
  path: string,
  supportedAgents: ReadonlySet<ModelAgent>,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `${path} must be a non-empty array when present`;
  }
  const seen = new Set<ModelAgent>();
  for (const agent of value) {
    if (!isModelAgent(agent))
      return `${path} must contain only supported agents`;
    if (seen.has(agent)) return `${path} must not contain duplicates`;
    seen.add(agent);
    if (!supportedAgents.has(agent)) {
      return `${path} agents must be supported by the model entry`;
    }
  }
  return null;
}

function modelEntryError(
  value: unknown,
  path: string,
  schemaVersion:
    | typeof MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION
    | typeof MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownFieldError(
    value,
    schemaVersion === MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION
      ? MODEL_CATALOG_ENTRY_V1_FIELDS
      : schemaVersion === MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION
        ? MODEL_CATALOG_ENTRY_V2_FIELDS
        : MODEL_CATALOG_ENTRY_V3_FIELDS,
    path,
  );
  if (error) return error;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256
  ) {
    return `${path}.id must be a non-empty string of at most 256 characters`;
  }
  error = optionalStringError(value.mode, `${path}.mode`, 128);
  if (error) return error;
  if (value.currency !== undefined && !isModelCurrency(value.currency)) {
    return `${path}.currency must be CNY or USD when present`;
  }
  if (
    (schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
      schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION) &&
    !Array.isArray(value.agents)
  ) {
    return `${path}.agents must be an array in schema version 3 or 4`;
  }
  if (
    value.agents !== undefined &&
    (!Array.isArray(value.agents) ||
      value.agents.some((agent) =>
        schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
        schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION
          ? !isModelAgent(agent)
          : !isV2ModelAgent(agent),
      ))
  ) {
    return `${path}.agents must be an array of supported agents when present`;
  }
  const supportedAgents = Array.isArray(value.agents)
    ? (value.agents as ModelAgent[])
    : [];
  if (schemaVersion !== MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION) {
    const defaultError = newSessionDefaultError(
      value.newSessionDefault,
      `${path}.newSessionDefault`,
      new Set(supportedAgents),
    );
    if (defaultError) return defaultError;
  }
  const isV4StandaloneModel =
    schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION &&
    (value.mode === "image_generation" ||
      value.mode === "video_generation" ||
      value.mode === "audio_generation" ||
      value.mode === "audio_speech" ||
      value.mode === "audio_transcription" ||
      value.mode === "realtime" ||
      value.mode === "embedding");
  if (isV4StandaloneModel && supportedAgents.length > 0) {
    return `${path}.agents must be empty for a v4 Gateway standalone capability mode`;
  }
  if (
    (schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
      schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION) &&
    supportedAgents.length === 0 &&
    !isV4StandaloneModel
  ) {
    return `${path}.agents may be empty only for a v4 Gateway standalone capability mode`;
  }

  for (const [key, max] of [
    ["name", 256],
    ["group", 128],
    ["description", 2_000],
  ] as const) {
    const error = optionalStringError(value[key], `${path}.${key}`, max);
    if (error) return error;
  }
  if (
    (schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
      schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION) &&
    (typeof value.name !== "string" || value.name.trim().length === 0)
  ) {
    return `${path}.name must be a non-empty string in schema version 3 or 4`;
  }
  if (
    value.icon !== undefined &&
    (typeof value.icon !== "string" || value.icon.trim().length === 0)
  ) {
    return `${path}.icon must be a non-empty string when present`;
  }
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const error = optionalPositiveIntegerError(value[key], `${path}.${key}`);
    if (error) return error;
  }
  if (
    (schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
      (schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION &&
        !isV4StandaloneModel)) &&
    value.contextWindow === undefined
  ) {
    return `${path}.contextWindow is required for schema version 3 and v4 chat models`;
  }
  error = modelModalitiesError(value.modalities, `${path}.modalities`);
  if (error) return error;
  error = effortListError(value.efforts, `${path}.efforts`);
  if (error) return error;
  if (
    value.defaultEffort !== undefined &&
    value.defaultEffort !== null &&
    !isModelEffort(value.defaultEffort)
  ) {
    return `${path}.defaultEffort must be a supported effort value when present`;
  }
  const efforts =
    Array.isArray(value.efforts) && value.efforts.every(isModelEffort)
      ? (value.efforts as ModelEffort[])
      : undefined;
  if (
    isModelEffort(value.defaultEffort) &&
    efforts !== undefined &&
    !efforts.includes(value.defaultEffort)
  ) {
    return `${path}.defaultEffort must be included in ${path}.efforts`;
  }
  error = optionalFiniteNumberError(value.sortOrder, `${path}.sortOrder`);
  if (error) return error;
  for (const key of ["supportsFastMode", "defaultEnabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return `${path}.${key} must be a boolean when present`;
    }
  }

  for (const field of PRICING_FIELDS) {
    error = optionalFiniteNumberError(value[field], `${path}.${field}`, {
      nonNegative: field !== "costDiscount",
    });
    if (error) return error;
  }
  error = tieredPricingError(value.tieredPricing, `${path}.tieredPricing`);
  if (error) return error;

  if (value.perAgent !== undefined) {
    if (!isPlainObject(value.perAgent))
      return `${path}.perAgent must be an object when present`;
    for (const [agent, override] of Object.entries(value.perAgent)) {
      const supportedAgent =
        schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
        schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION
          ? isModelAgent(agent)
          : isV2ModelAgent(agent);
      if (!supportedAgent)
        return `${path}.perAgent.${agent} is not a supported agent`;
      if (!supportedAgents.includes(agent as ModelAgent)) {
        return `${path}.perAgent.${agent} must be included in ${path}.agents`;
      }
      error = overrideError(
        override,
        `${path}.perAgent.${agent}`,
        efforts,
        schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
          schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION
          ? MODEL_AGENT_OVERRIDE_V3_FIELDS
          : MODEL_AGENT_OVERRIDE_FIELDS,
        true,
        isModelEffort(value.defaultEffort) ? value.defaultEffort : null,
      );
      if (error) return error;
      if (
        agent === "pi" &&
        isPlainObject(override) &&
        override.wireProtocol !== undefined &&
        (typeof override.wireProtocol !== "string" ||
          override.wireProtocol.trim().length === 0)
      ) {
        return `${path}.perAgent.pi.wireProtocol must be a non-empty string when present`;
      }
      if (
        agent !== "pi" &&
        isPlainObject(override) &&
        override.wireProtocol !== undefined
      ) {
        if (!isModelAccessWireProtocol(override.wireProtocol)) {
          return `${path}.perAgent.${agent}.wireProtocol must be a supported wire protocol`;
        }
        if (!acceptsWireProtocol(agent as ModelAgent, override.wireProtocol)) {
          const expected =
            agent === "claude-code" ? "anthropic-messages" : "openai-responses";
          return `${path}.perAgent.${agent}.wireProtocol must be ${expected}`;
        }
      }
    }
  }
  if (
    schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
    schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION
  ) {
    for (const agent of supportedAgents) {
      // Pi accepts a missing/future string here because Cindy Server and the local Pi catalog are
      // higher authorities; an unsupported last-priority Gateway hint only closes that model route.
      // Claude and Codex have no such fallback and remain strict contract requirements.
      if (agent === "pi") continue;
      const override = isPlainObject(value.perAgent)
        ? value.perAgent[agent]
        : undefined;
      if (
        !isPlainObject(override) ||
        !isModelAccessWireProtocol(override.wireProtocol)
      ) {
        return `${path}.perAgent.${agent}.wireProtocol is required when ${path}.agents includes ${agent}`;
      }
    }
  }
  return null;
}

type ModelCatalogSchemaVersion =
  | typeof MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION
  | typeof MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION
  | typeof MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION
  | typeof MODEL_ACCESS_CATALOG_SCHEMA_VERSION;

function isKnownAgentForVersion(
  agent: string,
  schemaVersion: ModelCatalogSchemaVersion,
): boolean {
  return schemaVersion === MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION ||
    schemaVersion === MODEL_ACCESS_CATALOG_SCHEMA_VERSION
    ? isModelAgent(agent)
    : isV2ModelAgent(agent);
}

/**
 * Agent kinds are an extensible capability enum on the consumer side. Preserve malformed values
 * for normal validation, but remove well-formed future string values the current client cannot use.
 */
function filterUnknownAgentStrings(
  value: unknown,
  schemaVersion: ModelCatalogSchemaVersion,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter(
    (agent) =>
      typeof agent !== "string" || isKnownAgentForVersion(agent, schemaVersion),
  );
}

function sanitizeModelEntryAgents(
  value: unknown,
  schemaVersion: ModelCatalogSchemaVersion,
): unknown {
  if (!isPlainObject(value)) return value;
  const sanitized: PlainObject = { ...value };
  if ("agents" in sanitized) {
    sanitized.agents = filterUnknownAgentStrings(
      sanitized.agents,
      schemaVersion,
    );
  }
  if (
    schemaVersion !== MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION &&
    "newSessionDefault" in sanitized
  ) {
    const original = sanitized.newSessionDefault;
    const filtered = filterUnknownAgentStrings(
      sanitized.newSessionDefault,
      schemaVersion,
    );
    if (
      Array.isArray(original) &&
      original.length > 0 &&
      Array.isArray(filtered) &&
      filtered.length === 0
    ) {
      delete sanitized.newSessionDefault;
    } else sanitized.newSessionDefault = filtered;
  }
  if (isPlainObject(sanitized.perAgent)) {
    const knownEntries = Object.entries(sanitized.perAgent).filter(([agent]) =>
      isKnownAgentForVersion(agent, schemaVersion),
    );
    if (knownEntries.length === 0) delete sanitized.perAgent;
    else sanitized.perAgent = Object.fromEntries(knownEntries);
  }
  return sanitized;
}

export function parseListModelsResponse(
  value: unknown,
): ModelAccessParseResult<ListModelsResponse> {
  if (!isPlainObject(value)) return fail("response must be an object");
  if (
    value.schemaVersion !== MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_ACCESS_CATALOG_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION
  ) {
    return fail(
      `response.schemaVersion must be ${MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION}, ${MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION}, ${MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION}, ${MODEL_ACCESS_CATALOG_SCHEMA_VERSION}, or ${MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION}`,
    );
  }
  if (value.schemaVersion === MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION) {
    const unknownField = unknownFieldError(
      value,
      ["schemaVersion", "accountTier", "models"],
      "response",
    );
    if (unknownField) return fail(unknownField);
    if (
      !["free", "paid", "not_applicable"].includes(String(value.accountTier))
    ) {
      return fail("response.accountTier must be free, paid, or not_applicable");
    }
    if (!Array.isArray(value.models))
      return fail("response.models must be an array");
    const modelIds = new Set<string>();
    const models: unknown[] = [];
    for (const [index, raw] of value.models.entries()) {
      if (!isPlainObject(raw))
        return fail(`response.models[${index}] must be an object`);
      if (
        raw.availability !== "available" &&
        raw.availability !== "requires_payment"
      ) {
        return fail(
          `response.models[${index}].availability must be available or requires_payment`,
        );
      }
      const { availability, ...legacyShape } = raw;
      const sanitized = sanitizeModelEntryAgents(
        legacyShape,
        MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
      );
      if (isPlainObject(sanitized) && typeof sanitized.id === "string") {
        if (modelIds.has(sanitized.id)) {
          return fail(`response.models[${index}].id must be unique`);
        }
        modelIds.add(sanitized.id);
      }
      const error = modelEntryError(
        sanitized,
        `response.models[${index}]`,
        MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
      );
      if (error) return fail(error);
      models.push({ ...(sanitized as PlainObject), availability });
    }
    return ok({
      schemaVersion: MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION,
      accountTier: value.accountTier,
      models,
    } as ListModelsResponse);
  }
  const unknownField = unknownFieldError(
    value,
    LIST_MODELS_RESPONSE_FIELDS,
    "response",
  );
  if (unknownField) return fail(unknownField);
  const schemaVersion = value.schemaVersion as ModelCatalogSchemaVersion;
  if (!Array.isArray(value.models))
    return fail("response.models must be an array");
  const models = value.models.map((model) =>
    sanitizeModelEntryAgents(model, schemaVersion),
  );
  const modelIds = new Set<string>();
  for (const [index, model] of models.entries()) {
    if (isPlainObject(model) && typeof model.id === "string") {
      if (modelIds.has(model.id)) {
        return fail(`response.models[${index}].id must be unique`);
      }
      modelIds.add(model.id);
    }
    const error = modelEntryError(
      model,
      `response.models[${index}]`,
      schemaVersion,
    );
    if (error) return fail(error);
  }
  return ok({ schemaVersion, models } as ListModelsResponse);
}

function referencePriceError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownFieldError(value, MODEL_REFERENCE_PRICE_FIELDS, path);
  if (error) return error;
  if (!isModelCurrency(value.currency))
    return `${path}.currency must be CNY or USD`;
  if (!isModelPriceVariant(value.variant)) {
    return `${path}.variant must be a supported price variant`;
  }
  for (const field of [
    "inputPerMtok",
    "outputPerMtok",
    "cacheReadPerMtok",
    "cacheWritePerMtok",
    "cacheWrite1hPerMtok",
  ] as const) {
    error = optionalFiniteNumberError(value[field], `${path}.${field}`, {
      nonNegative: true,
    });
    if (error) return error;
  }
  if (value.inputPerMtok === undefined || value.outputPerMtok === undefined) {
    return `${path} must declare inputPerMtok and outputPerMtok`;
  }
  for (const field of ["minInputTokens", "maxInputTokens"] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isInteger(value[field]) || (value[field] as number) < 0)
    ) {
      return `${path}.${field} must be a non-negative integer when present`;
    }
  }
  const min =
    typeof value.minInputTokens === "number" ? value.minInputTokens : 0;
  if (typeof value.maxInputTokens === "number" && value.maxInputTokens <= min) {
    return `${path}.maxInputTokens must be greater than minInputTokens`;
  }
  if (!isIsoDate(value.effectiveFrom)) {
    return `${path}.effectiveFrom must be an ISO calendar date`;
  }
  if (value.effectiveUntil !== undefined) {
    if (!isIsoDate(value.effectiveUntil)) {
      return `${path}.effectiveUntil must be an ISO calendar date when present`;
    }
    if (value.effectiveUntil <= value.effectiveFrom) {
      return `${path}.effectiveUntil must be after effectiveFrom`;
    }
  }
  if (!isPlainObject(value.source)) return `${path}.source must be an object`;
  error = unknownFieldError(
    value.source,
    MODEL_REFERENCE_PRICE_SOURCE_FIELDS,
    `${path}.source`,
  );
  if (error) return error;
  if (value.source.kind !== "provider-official") {
    return `${path}.source.kind must be provider-official`;
  }
  if (!isHttpsUrl(value.source.url))
    return `${path}.source.url must be an HTTPS URL`;
  if (!isIsoDate(value.source.verifiedAt)) {
    return `${path}.source.verifiedAt must be an ISO calendar date`;
  }
  return null;
}

function referencePricesError(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (const [index, price] of value.entries()) {
    const error = referencePriceError(price, `${path}[${index}]`);
    if (error) return error;
    for (let previousIndex = 0; previousIndex < index; previousIndex++) {
      const previous = value[previousIndex];
      if (
        isPlainObject(price) &&
        isPlainObject(previous) &&
        referencePriceRangesOverlap(previous, price)
      )
        return `${path}[${index}] overlaps referencePrices[${previousIndex}] for the same currency and variant`;
    }
  }
  return null;
}

function referencePriceGroupsError(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 32)
    return "baseModel.referencePriceGroups must be an array of at most 32 groups";
  const ids = new Set<string>();
  for (const group of value) {
    if (
      !isPlainObject(group) ||
      unknownFieldError(group, ["id", "prices"], "referencePriceGroup") ||
      !isSafeSlug(group.id)
    )
      return "baseModel.referencePriceGroups contains an invalid group";
    if (ids.has(group.id))
      return "baseModel.referencePriceGroups ids must be unique";
    ids.add(group.id);
    const error = referencePricesError(
      group.prices,
      `baseModel.referencePriceGroups.${group.id}.prices`,
    );
    if (error) return error;
  }
  return null;
}

function registryRouteError(
  value: unknown,
  path: string,
  schemaVersion = 2,
  media = false,
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownFieldError(
    value,
    schemaVersion >= 4
      ? [
          ...MODEL_REGISTRY_ROUTE_FIELDS,
          ...(schemaVersion >= 5 ? ["referencePriceGroup"] : []),
          "defaults",
          "forceOverrides",
          "overrideReason",
          "overrideVerifiedAt",
        ]
      : MODEL_REGISTRY_ROUTE_FIELDS,
    path,
  );
  if (error) return error;
  for (const field of ["defaults", "forceOverrides"] as const) {
    if (value[field] !== undefined && !validModelMetadata(value[field]))
      return `${path}.${field} is invalid`;
  }
  if (
    value.overrideReason !== undefined &&
    (typeof value.overrideReason !== "string" ||
      !value.overrideReason.trim() ||
      value.overrideReason.length > 1000)
  )
    return `${path}.overrideReason is invalid`;
  if (
    value.forceOverrides !== undefined &&
    (typeof value.overrideReason !== "string" ||
      !value.overrideReason.trim() ||
      value.overrideReason.length > 1000)
  )
    return `${path}.overrideReason is required for forceOverrides`;
  if (
    value.overrideVerifiedAt !== undefined &&
    (typeof value.overrideVerifiedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.overrideVerifiedAt) ||
      !Number.isFinite(Date.parse(value.overrideVerifiedAt)) ||
      new Date(value.overrideVerifiedAt).toISOString().slice(0, 10) !==
        value.overrideVerifiedAt)
  )
    return `${path}.overrideVerifiedAt is invalid`;

  if (!isSafeSlug(value.providerId)) {
    return `${path}.providerId must use letters, numbers, underscores, or hyphens`;
  }
  if (
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    value.modelId.length > 256
  ) {
    return `${path}.modelId must be a non-empty string of at most 256 characters`;
  }
  if (
    !Array.isArray(value.agents) ||
    (value.agents.length === 0 && !media) ||
    value.agents.some((agent) => !isV2ModelAgent(agent)) ||
    new Set(value.agents).size !== value.agents.length
  ) {
    return `${path}.agents must be a unique non-empty array of supported agents`;
  }
  if (media && Array.isArray(value.agents) && value.agents.length !== 0) {
    return `${path}.agents must be empty for a media model`;
  }
  if (
    value.referencePriceGroup !== undefined &&
    !isSafeSlug(value.referencePriceGroup)
  )
    return `${path}.referencePriceGroup must be a non-empty slug`;
  if (value.referencePrices !== undefined)
    return referencePricesError(
      value.referencePrices,
      `${path}.referencePrices`,
    );
  return null;
}

function registryEntryError(
  value: unknown,
  path: string,
  schemaVersion: ModelRegistry["schemaVersion"],
  validateDependencies = true,
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownFieldError(
    value,
    schemaVersion === MODEL_REGISTRY_LEGACY_SCHEMA_VERSION
      ? MODEL_REGISTRY_ENTRY_V1_FIELDS
      : schemaVersion >= MODEL_REGISTRY_V3_SCHEMA_VERSION
        ? [
            ...MODEL_REGISTRY_ENTRY_V2_FIELDS,
            "nativeApi",
            ...(schemaVersion >= 4
              ? [
                  "modelRef",
                  "supportsImageInput",
                  "mode",
                  "modalities",
                  "officialDocs",
                ]
              : []),
          ]
        : MODEL_REGISTRY_ENTRY_V2_FIELDS,
    path,
  );
  if (error) return error;
  if (
    value.nativeApi !== undefined &&
    value.nativeApi !== null &&
    !(
      schemaVersion >= 4 ? MODEL_NATIVE_APIS : MODEL_ACCESS_WIRE_PROTOCOLS
    ).includes(value.nativeApi as never)
  ) {
    return `${path}.nativeApi must be a supported API or null`;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256
  ) {
    return `${path}.id must be a non-empty string of at most 256 characters`;
  }
  if (
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 256
  ) {
    return `${path}.name must be a non-empty string of at most 256 characters`;
  }
  for (const key of ["mode", "modalities", "officialDocs"] as const) {
    if (value[key] !== undefined && !validModelMetadata({ [key]: value[key] }))
      return `${path}.${key} is invalid`;
  }
  if (value.status !== undefined && !isModelRegistryStatus(value.status)) {
    return `${path}.status must be a supported registry status`;
  }
  for (const [key, max] of [
    ["group", 128],
    ["description", 2_000],
  ] as const) {
    error = optionalStringError(value[key], `${path}.${key}`, max);
    if (error) return error;
  }
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    error = optionalPositiveIntegerError(value[key], `${path}.${key}`);
    if (error) return error;
  }
  error = effortListError(value.efforts, `${path}.efforts`);
  if (error) return error;
  if (
    value.defaultEffort !== undefined &&
    !(schemaVersion >= 4 && value.defaultEffort === null) &&
    !isModelEffort(value.defaultEffort)
  ) {
    return `${path}.defaultEffort must be a supported effort value when present`;
  }
  const efforts =
    Array.isArray(value.efforts) && value.efforts.every(isModelEffort)
      ? (value.efforts as ModelEffort[])
      : undefined;
  if (
    validateDependencies &&
    value.defaultEffort != null &&
    efforts !== undefined &&
    !efforts.includes(value.defaultEffort as ModelEffort)
  ) {
    return `${path}.defaultEffort must be included in ${path}.efforts`;
  }
  error = optionalFiniteNumberError(value.sortOrder, `${path}.sortOrder`);
  if (error) return error;
  if (
    value.supportsImageInput !== undefined &&
    typeof value.supportsImageInput !== "boolean"
  ) {
    return `${path}.supportsImageInput must be a boolean when present`;
  }
  for (const key of ["supportsFastMode", "defaultEnabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return `${path}.${key} must be a boolean when present`;
    }
  }
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    return `${path}.routes must be a non-empty array`;
  }
  const routeKeys = new Set<string>();
  const supportedAgents = new Set<ModelAgent>();
  for (const [index, route] of value.routes.entries()) {
    const routeMode = isPlainObject(route)
      ? ((isPlainObject(route.forceOverrides)
          ? route.forceOverrides.mode
          : undefined) ??
        (isPlainObject(route.defaults) ? route.defaults.mode : undefined) ??
        value.mode)
      : value.mode;
    error = registryRouteError(
      route,
      `${path}.routes[${index}]`,
      schemaVersion,
      schemaVersion >= 4 &&
        [
          "image_generation",
          "video_generation",
          "audio_speech",
          "audio_transcription",
          "audio_generation",
          "realtime",
          "embedding",
        ].includes(routeMode as string),
    );
    if (error) return error;
    const typedRoute = route as {
      providerId: string;
      modelId: string;
      agents: ModelAgent[];
    };
    const routeKey = `${typedRoute.providerId}\u0000${typedRoute.modelId}`;
    if (routeKeys.has(routeKey))
      return `${path}.routes[${index}] must be unique`;
    routeKeys.add(routeKey);
    for (const agent of typedRoute.agents) supportedAgents.add(agent);
  }
  if (value.perAgent !== undefined) {
    if (!isPlainObject(value.perAgent))
      return `${path}.perAgent must be an object when present`;
    for (const [agent, override] of Object.entries(value.perAgent)) {
      if (!isV2ModelAgent(agent))
        return `${path}.perAgent.${agent} is not a supported agent`;
      if (!supportedAgents.has(agent)) {
        return `${path}.perAgent.${agent} must be supported by at least one route`;
      }
      error = overrideError(
        override,
        `${path}.perAgent.${agent}`,
        efforts,
        MODEL_AGENT_OVERRIDE_FIELDS,
        schemaVersion >= 4,
        isModelEffort(value.defaultEffort) ? value.defaultEffort : null,
        validateDependencies,
      );
      if (error) return error;
    }
  }
  if (schemaVersion >= MODEL_REGISTRY_SCHEMA_VERSION) {
    if (value.status === "retired" && value.newSessionDefault !== undefined) {
      return `${path}.newSessionDefault is not allowed when ${path}.status is retired`;
    }
    const defaultError = newSessionDefaultError(
      value.newSessionDefault,
      `${path}.newSessionDefault`,
      supportedAgents,
    );
    if (defaultError) return defaultError;
  }
  return null;
}

export function parseModelRegistry(
  value: unknown,
): ModelAccessParseResult<ModelRegistry> {
  if (!isPlainObject(value)) return fail("modelRegistry must be an object");
  const unknownField = unknownFieldError(
    value,
    value.schemaVersion === MODEL_REGISTRY_V4_SCHEMA_VERSION ||
      value.schemaVersion === MODEL_REGISTRY_V5_SCHEMA_VERSION
      ? [
          ...MODEL_REGISTRY_FIELDS,
          "nativeApiRules",
          "localModels",
          "baseModels",
        ]
      : value.schemaVersion === MODEL_REGISTRY_V3_SCHEMA_VERSION
        ? [...MODEL_REGISTRY_FIELDS, "nativeApiRules"]
        : MODEL_REGISTRY_FIELDS,
    "modelRegistry",
  );
  if (unknownField) return fail(unknownField);
  if (
    value.schemaVersion !== MODEL_REGISTRY_LEGACY_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_REGISTRY_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_REGISTRY_V3_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_REGISTRY_V4_SCHEMA_VERSION &&
    value.schemaVersion !== MODEL_REGISTRY_V5_SCHEMA_VERSION
  ) {
    return fail("modelRegistry.schemaVersion must be 1, 2, 3, 4 or 5");
  }
  if (!isIsoTimestamp(value.updatedAt)) {
    return fail("modelRegistry.updatedAt must be an ISO timestamp");
  }
  if (
    value.localModels !== undefined &&
    !parseLocalModelCatalog(value.localModels)
  ) {
    return fail("modelRegistry.localModels is invalid");
  }
  if (!Array.isArray(value.models))
    return fail("modelRegistry.models must be an array");
  if (value.nativeApiRules !== undefined) {
    if (!Array.isArray(value.nativeApiRules))
      return fail("modelRegistry.nativeApiRules must be an array");
    const identities = new Set<string>();
    for (const rule of value.nativeApiRules) {
      if (
        !isPlainObject(rule) ||
        unknownFieldError(
          rule,
          ["providerId", "modelIdPrefix", "nativeApi"],
          "nativeApiRule",
        ) ||
        typeof rule.providerId !== "string" ||
        !rule.providerId ||
        rule.providerId.length > 128 ||
        typeof rule.modelIdPrefix !== "string" ||
        !rule.modelIdPrefix ||
        rule.modelIdPrefix.length > 256 ||
        !(
          value.schemaVersion >= 4
            ? MODEL_NATIVE_APIS
            : MODEL_ACCESS_WIRE_PROTOCOLS
        ).includes(rule.nativeApi as never)
      )
        return fail("modelRegistry.nativeApiRules contains an invalid rule");
      const key = `${rule.providerId}\u0000${rule.modelIdPrefix}`;
      if (identities.has(key))
        return fail(
          "modelRegistry.nativeApiRules must have unique provider/prefix pairs",
        );
      identities.add(key);
    }
  }
  const baseIds = new Set<string>();
  const identities = new Set<string>();
  if (value.baseModels !== undefined) {
    if (!Array.isArray(value.baseModels) || value.baseModels.length > 2000)
      return fail("modelRegistry.baseModels is invalid");
    for (const base of value.baseModels) {
      if (
        !isPlainObject(base) ||
        unknownFieldError(
          base,
          [
            "id",
            "aliases",
            "defaults",
            ...(value.schemaVersion >= 5 ? ["referencePriceGroups"] : []),
          ],
          "baseModel",
        ) ||
        typeof base.id !== "string" ||
        !base.id ||
        base.id.length > 256 ||
        !Array.isArray(base.aliases) ||
        base.aliases.length > 32 ||
        !base.aliases.every(
          (a) => typeof a === "string" && a.length > 0 && a.length <= 256,
        ) ||
        !validModelMetadata(base.defaults)
      )
        return fail("modelRegistry.baseModels contains invalid data");
      if (base.referencePriceGroups !== undefined) {
        const error = referencePriceGroupsError(base.referencePriceGroups);
        if (error) return fail(error);
      }
      baseIds.add(base.id);
      if (
        base.defaults.efforts !== undefined &&
        base.defaults.defaultEffort != null &&
        !base.defaults.efforts.includes(base.defaults.defaultEffort)
      ) {
        return fail("modelRegistry.baseModels defaultEffort must be supported");
      }
      for (const identity of [base.id, ...base.aliases]) {
        if (identities.has(identity))
          return fail("modelRegistry.baseModels identity is ambiguous");
        identities.add(identity);
      }
    }
  }
  for (const model of value.models) {
    if (
      isPlainObject(model) &&
      model.modelRef !== undefined &&
      !baseIds.has(model.modelRef as string)
    )
      return fail("modelRegistry.modelRef is unresolved");
  }
  const localModels = value.localModels as
    { models?: { modelRef?: string }[] } | undefined;
  if (
    localModels?.models?.some(
      (model) => model.modelRef !== undefined && !baseIds.has(model.modelRef),
    )
  )
    return fail("modelRegistry.localModels.modelRef is unresolved");
  const modelIds = new Set<string>();
  for (const [index, model] of value.models.entries()) {
    if (isPlainObject(model) && typeof model.id === "string") {
      if (modelIds.has(model.id)) {
        return fail(`modelRegistry.models[${index}].id must be unique`);
      }
      modelIds.add(model.id);
    }
    // Empty Agent lists are valid only for an explicitly typed V4 media route.
    const inheritedMode =
      isPlainObject(model) && typeof model.modelRef === "string"
        ? (
            value.baseModels as
              import("./modelMetadataLayers.js").BaseModel[] | undefined
          )?.find((base) => base.id === model.modelRef)?.defaults.mode
        : undefined;
    const error = registryEntryError(
      isPlainObject(model) &&
        model.mode === undefined &&
        inheritedMode !== undefined
        ? { ...model, mode: inheritedMode }
        : model,
      `modelRegistry.models[${index}]`,
      value.schemaVersion,
      value.schemaVersion < 4,
    );
    if (error) return fail(error);
    const referenceEntry = model as ModelRegistryEntry;
    for (const route of referenceEntry.routes) {
      if (route.referencePriceGroup !== undefined) {
        const base = (
          value.baseModels as
            import("./modelMetadataLayers.js").BaseModel[] | undefined
        )?.find((base) => base.id === referenceEntry.modelRef);
        if (
          !base?.referencePriceGroups?.some(
            (group) => group.id === route.referencePriceGroup,
          )
        )
          return fail("modelRegistry.route.referencePriceGroup is unresolved");
      }
    }
    const typed = model as ModelRegistryEntry;
    for (const effective of expandedRegistryEntries({
      ...(value as unknown as ModelRegistry),
      models: [typed],
    })) {
      const mergedError = registryEntryError(
        effective,
        `modelRegistry.models[${index}]`,
        value.schemaVersion,
      );
      if (mergedError) return fail(mergedError);
    }
  }
  return ok(value as unknown as ModelRegistry);
}

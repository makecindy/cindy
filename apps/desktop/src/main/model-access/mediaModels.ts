import {
  isModelDisabled,
  isProviderDisabled,
  MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
  MODEL_ACCESS_MODELS_PATH,
  parseListModelsResponse,
  type MediaCapability,
  type ModelDisableOverrides,
  type ModelCatalogEntry,
} from '@cindy/model-providers';
import {
  MODEL_ACCESS_INVOCATION_GUIDE_PATH,
  MODEL_ACCESS_INVOCATION_GUIDES_PATH,
  MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION,
  parseResolvedMediaInvocationGuide,
  type ResolvedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { serverApiFetch, ServerApiError } from '../serverApiClient.js';

const MEDIA_MODEL_REQUEST_TIMEOUT_MS = 20_000;
const MEDIA_GUIDE_PREFLIGHT_TIMEOUT_MS = 5_000;
const CINDY_AI_PROVIDER_ID = 'xd';
const MEDIA_MODELS_PATH =
  `${MODEL_ACCESS_MODELS_PATH}?schemaVersion=${MODEL_ACCESS_CATALOG_SCHEMA_VERSION}` as const;

export type MediaGuideCompatibilityErrorCode =
  | 'CLIENT_UPGRADE_REQUIRED'
  | 'GUIDE_INVALID';

export class MediaGuideCompatibilityError extends Error {
  constructor(
    readonly code: MediaGuideCompatibilityErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'MediaGuideCompatibilityError';
  }
}

export class MediaModelCatalogError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'MediaModelCatalogError';
  }
}

export interface UnavailableMediaModel {
  modelId: string;
  errorCode:
    | MediaGuideCompatibilityErrorCode
    | 'GUIDE_NOT_AVAILABLE'
    | 'GUIDE_SERVICE_UNAVAILABLE'
    | 'CAPABILITY_NOT_SUPPORTED';
  message: string;
  retryable: boolean;
}

export interface ExecutableMediaModelsResult {
  models: ModelCatalogEntry[];
  unavailable: UnavailableMediaModel[];
  candidateCount: number;
}

interface ExecutableMediaSnapshot {
  models: ModelCatalogEntry[];
  capabilitiesByModel: Map<string, ReadonlySet<MediaCapability>>;
  unavailableByModel: Map<string, UnavailableMediaModel>;
}

const MEDIA_GUIDE_REFRESH_BACKOFF_INITIAL_MS = 30_000;
const MEDIA_GUIDE_REFRESH_BACKOFF_MAX_MS = 5 * 60_000;

let executableMediaSnapshot: ExecutableMediaSnapshot | null = null;
let executableMediaRefreshInflight: Promise<ExecutableMediaSnapshot> | null = null;
let executableMediaCacheGeneration = 0;
let executableMediaRefreshFailures = 0;
let executableMediaNextRefreshAt = 0;
let executableMediaLastRefreshError: unknown = null;

export function resetExecutableMediaModelCache(): void {
  executableMediaCacheGeneration += 1;
  executableMediaSnapshot = null;
  executableMediaRefreshInflight = null;
  executableMediaRefreshFailures = 0;
  executableMediaNextRefreshAt = 0;
  executableMediaLastRefreshError = null;
}

export function isMediaModelExecutable(
  modelId: string,
  capability: MediaCapability,
): boolean {
  return executableMediaSnapshot?.capabilitiesByModel.get(modelId)?.has(capability) === true;
}

const MEDIA_CAPABILITY_REQUIREMENTS: Record<
  MediaCapability,
  { input: string[]; inputAny?: string[]; output: string }
> = {
  'image.generate': { input: ['text'], output: 'image' },
  'image.edit': { input: ['text', 'image'], output: 'image' },
  'video.generate': { input: ['text'], output: 'video' },
  'video.image_to_video': { input: ['text', 'image'], output: 'video' },
};

export function supportsMediaCapability(
  modalities: { input: string[]; output: string[] } | undefined,
  capability: MediaCapability,
): boolean {
  if (!modalities) return false;
  const requirement = MEDIA_CAPABILITY_REQUIREMENTS[capability];
  const inputs = new Set(modalities.input);
  return (
    modalities.output.includes(requirement.output) &&
    requirement.input.every((input) => inputs.has(input)) &&
    (requirement.inputAny === undefined || requirement.inputAny.some((input) => inputs.has(input)))
  );
}

/**
 * Gateway mode 决定媒体类型；客户端沿用既有 provider/model 停用准入。
 * `defaultEnabled` 是聊天选择器的默认展示轴，不参与媒体能力准入。
 */
export function filterEnabledGatewayMediaModels<
  T extends {
    id: string;
    mode?: string;
    modalities?: { input: string[]; output: string[] };
  },
>(
  models: readonly T[],
  capability: MediaCapability | undefined,
  access: ModelDisableOverrides | undefined,
): T[] {
  if (isProviderDisabled(access, CINDY_AI_PROVIDER_ID)) return [];
  return models.filter((model) => {
    if (isModelDisabled(access, CINDY_AI_PROVIDER_ID, model.id)) return false;
    if (capability?.startsWith('image.') && model.mode !== 'image_generation') return false;
    if (capability?.startsWith('video.') && model.mode !== 'video_generation') return false;
    if (capability !== undefined) return supportsMediaCapability(model.modalities, capability);
    return model.mode === 'image_generation' || model.mode === 'video_generation';
  });
}

/**
 * Cindy Core 的媒体模型发现入口。模型仍来自 Model Access 对 Gateway model-groups
 * 的实时投影；Gateway mode 决定图片/视频模型类型。Guide 独立按 modelId
 * 懒取，不参与模型发现。
 */
async function fetchGatewayMediaModels(): Promise<ModelCatalogEntry[]> {
  const payload = await serverApiFetch<unknown>(MEDIA_MODELS_PATH, {
    baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
    timeoutMs: MEDIA_MODEL_REQUEST_TIMEOUT_MS,
    logLabel: MEDIA_MODELS_PATH,
  });
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('schemaVersion' in payload) ||
    payload.schemaVersion !== MODEL_ACCESS_CATALOG_SCHEMA_VERSION
  ) {
    throw new MediaModelCatalogError(
      '媒体模型目录当前不可用，请稍后重试或使用其他工具。',
      `expected schemaVersion ${MODEL_ACCESS_CATALOG_SCHEMA_VERSION}`,
    );
  }
  const parsed = parseListModelsResponse(payload);
  if (!parsed.ok) {
    throw new MediaModelCatalogError(
      '媒体模型目录当前不可用，请稍后重试或使用其他工具。',
      parsed.error,
    );
  }
  return parsed.value.models.filter(
    (model) => model.mode === 'image_generation' || model.mode === 'video_generation',
  );
}

export async function listAvailableMediaModels(
  capability?: MediaCapability,
): Promise<ModelCatalogEntry[]> {
  return filterEnabledGatewayMediaModels(
    await fetchGatewayMediaModels(),
    capability,
    readModelDisableOverrides(),
  );
}

export async function fetchMediaInvocationGuide(
  modelId: string,
  timeoutMs = MEDIA_MODEL_REQUEST_TIMEOUT_MS,
): Promise<ResolvedMediaInvocationGuide> {
  const query = new URLSearchParams({ modelId });
  const payload = await serverApiFetch<unknown>(
    `${MODEL_ACCESS_INVOCATION_GUIDE_PATH}?${query.toString()}`,
    {
      baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      timeoutMs,
      logLabel: MODEL_ACCESS_INVOCATION_GUIDE_PATH,
    },
  );
  return parseResolvedGuidePayload(payload, modelId);
}

function parseResolvedGuidePayload(
  payload: unknown,
  modelId: string,
): ResolvedMediaInvocationGuide {
  const guide =
    payload && typeof payload === 'object' && 'guide' in payload
      ? (payload as { guide?: unknown }).guide
      : undefined;
  const schemaVersion =
    guide && typeof guide === 'object' && 'schemaVersion' in guide
      ? (guide as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (
    typeof schemaVersion === 'number' &&
    schemaVersion !== MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION
  ) {
    throw new MediaGuideCompatibilityError(
      'CLIENT_UPGRADE_REQUIRED',
      '当前 Cindy 版本不支持该模型的调用协议，请升级客户端或更换模型。',
      `unsupported Guide schemaVersion: ${schemaVersion}`,
    );
  }
  const parsed = parseResolvedMediaInvocationGuide(payload);
  if (!parsed.ok) {
    throw new MediaGuideCompatibilityError(
      'GUIDE_INVALID',
      '该模型的调用说明当前不可用，请更换模型或稍后重试。',
      parsed.error,
    );
  }
  if (parsed.value.modelId !== modelId) {
    throw new MediaGuideCompatibilityError(
      'GUIDE_INVALID',
      '该模型的调用说明当前不可用，请更换模型或稍后重试。',
      'resolved Guide modelId does not match request',
    );
  }
  return parsed.value;
}

async function fetchMediaInvocationGuideBatch(): Promise<{
  byModel: Map<string, unknown>;
  duplicateModelIds: Set<string>;
}> {
  const payload = await serverApiFetch<unknown>(MODEL_ACCESS_INVOCATION_GUIDES_PATH, {
    baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
    timeoutMs: MEDIA_GUIDE_PREFLIGHT_TIMEOUT_MS,
    logLabel: MODEL_ACCESS_INVOCATION_GUIDES_PATH,
  });
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('guides' in payload) ||
    !Array.isArray((payload as { guides?: unknown }).guides) ||
    (payload as { guides: unknown[] }).guides.length > 256
  ) {
    throw new MediaModelCatalogError(
      '媒体调用说明目录当前不可用，请稍后重试或使用其他工具。',
      'batch Guide response must contain a bounded guides array',
    );
  }
  const byModel = new Map<string, unknown>();
  const duplicateModelIds = new Set<string>();
  for (const value of (payload as { guides: unknown[] }).guides) {
    const modelId =
      value && typeof value === 'object' && 'modelId' in value
        ? (value as { modelId?: unknown }).modelId
        : undefined;
    if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 256) continue;
    if (byModel.has(modelId)) {
      byModel.delete(modelId);
      duplicateModelIds.add(modelId);
      continue;
    }
    if (!duplicateModelIds.has(modelId)) byModel.set(modelId, value);
  }
  return { byModel, duplicateModelIds };
}

function unavailableFromGuideError(modelId: string, error: unknown): UnavailableMediaModel {
  if (error instanceof MediaGuideCompatibilityError) {
    return {
      modelId,
      errorCode: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (
    error instanceof ServerApiError &&
    error.code === 'MEDIA_INVOCATION_GUIDE_NOT_FOUND'
  ) {
    return {
      modelId,
      errorCode: 'GUIDE_NOT_AVAILABLE',
      message: '该模型当前没有可用的调用说明。',
      retryable: false,
    };
  }
  return {
    modelId,
    errorCode: 'GUIDE_SERVICE_UNAVAILABLE',
    message: '媒体调用说明暂时无法读取，请稍后重试或选择其他工具。',
    retryable: true,
  };
}

async function buildExecutableMediaSnapshot(): Promise<ExecutableMediaSnapshot> {
  const models = await fetchGatewayMediaModels();
  const batch = await fetchMediaInvocationGuideBatch();
  const capabilitiesByModel = new Map<string, ReadonlySet<MediaCapability>>();
  const unavailableByModel = new Map<string, UnavailableMediaModel>();

  for (const model of models) {
    if (batch.duplicateModelIds.has(model.id)) {
      unavailableByModel.set(model.id, {
        modelId: model.id,
        errorCode: 'GUIDE_INVALID',
        message: '该模型存在重复调用说明，请更换模型或稍后重试。',
        retryable: false,
      });
      continue;
    }
    const rawGuide = batch.byModel.get(model.id);
    if (rawGuide === undefined) {
      unavailableByModel.set(model.id, {
        modelId: model.id,
        errorCode: 'GUIDE_NOT_AVAILABLE',
        message: '该模型当前没有可用的调用说明。',
        retryable: false,
      });
      continue;
    }
    try {
      const resolvedGuide = parseResolvedGuidePayload(rawGuide, model.id);
      const operations = new Set(
        resolvedGuide.guide.operations
          .filter((operation) => supportsMediaCapability(model.modalities, operation.capability))
          .map((operation) => operation.capability),
      );
      if (operations.size === 0) {
        unavailableByModel.set(model.id, {
          modelId: model.id,
          errorCode: 'CAPABILITY_NOT_SUPPORTED',
          message: '该模型当前没有客户端可执行的媒体能力。',
          retryable: false,
        });
        continue;
      }
      capabilitiesByModel.set(model.id, operations);
    } catch (error) {
      unavailableByModel.set(model.id, unavailableFromGuideError(model.id, error));
    }
  }

  return { models, capabilitiesByModel, unavailableByModel };
}

async function getExecutableMediaSnapshot(forceRefresh = false): Promise<ExecutableMediaSnapshot> {
  if (executableMediaSnapshot && !forceRefresh) return executableMediaSnapshot;
  if (executableMediaRefreshInflight) return executableMediaRefreshInflight;
  if (!forceRefresh && Date.now() < executableMediaNextRefreshAt) {
    if (executableMediaSnapshot) return executableMediaSnapshot;
    throw (
      executableMediaLastRefreshError ??
      new MediaModelCatalogError('媒体调用说明目录暂时不可用，请稍后重试。')
    );
  }

  const generation = executableMediaCacheGeneration;
  const refresh = buildExecutableMediaSnapshot();
  executableMediaRefreshInflight = refresh;
  try {
    const snapshot = await refresh;
    if (generation !== executableMediaCacheGeneration) {
      throw new MediaModelCatalogError('媒体模型目录身份已变化，请重试。');
    }
    executableMediaSnapshot = snapshot;
    executableMediaRefreshFailures = 0;
    executableMediaNextRefreshAt = 0;
    executableMediaLastRefreshError = null;
    return snapshot;
  } catch (error) {
    if (generation === executableMediaCacheGeneration) {
      executableMediaRefreshFailures += 1;
      const multiplier = 2 ** Math.min(executableMediaRefreshFailures - 1, 10);
      executableMediaNextRefreshAt =
        Date.now() +
        Math.min(
          MEDIA_GUIDE_REFRESH_BACKOFF_INITIAL_MS * multiplier,
          MEDIA_GUIDE_REFRESH_BACKOFF_MAX_MS,
        );
      executableMediaLastRefreshError = error;
    }
    if (executableMediaSnapshot) return executableMediaSnapshot;
    throw error;
  } finally {
    if (executableMediaRefreshInflight === refresh) executableMediaRefreshInflight = null;
  }
}

/**
 * 当前客户端真正可执行的媒体模型投影。一次批量 Guide 成功会重建全部图片/视频能力；
 * 后续调用只读内存，目录或身份变化时由 reset 显式失效。
 */
export async function listExecutableMediaModels(
  capabilities: readonly MediaCapability[] = [],
  options: { includeDisabled?: boolean; forceRefresh?: boolean } = {},
): Promise<ExecutableMediaModelsResult> {
  const snapshot = await getExecutableMediaSnapshot(options.forceRefresh === true);
  const candidates = filterEnabledGatewayMediaModels(
    snapshot.models,
    undefined,
    options.includeDisabled ? undefined : readModelDisableOverrides(),
  ).filter((model) =>
    capabilities.every((capability) => supportsMediaCapability(model.modalities, capability)),
  );
  const models: ModelCatalogEntry[] = [];
  const unavailable: UnavailableMediaModel[] = [];
  for (const model of candidates) {
    const supported = snapshot.capabilitiesByModel.get(model.id);
    if (supported && capabilities.every((capability) => supported.has(capability))) {
      models.push(model);
      continue;
    }
    unavailable.push(
      snapshot.unavailableByModel.get(model.id) ?? {
        modelId: model.id,
        errorCode: 'CAPABILITY_NOT_SUPPORTED',
        message: '该模型的调用协议不包含请求的媒体能力。',
        retryable: false,
      },
    );
  }
  return { models, unavailable, candidateCount: candidates.length };
}

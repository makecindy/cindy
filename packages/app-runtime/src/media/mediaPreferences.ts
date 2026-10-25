import {isModelDisabled,isModelDisabledWithUniqueLegacyBasename,isProviderDisabled,type Catalog,type MediaCapability,type ModelDisableOverrides} from '@cindy/model-providers';
import type {createActiveCatalog} from '@cindy/model-providers/model-plane/activeCatalog';
import type {GhostMediaCapability} from '@cindy/plugin-runtime/shared/ghost';
import type {LiziMcpLogger} from '@cindy/mcps';
import {deriveCindyMediaConfig,selectExecutableCoreMediaModels,type CindyCapabilityKind,type CindyMediaCatalogConfig} from './cindyMediaCatalog.js';
import {supportsMediaCapability} from './mediaCapabilities.js';
import type {createMediaModelCatalog} from './mediaModels.js';
import type {ProviderMediaRuntimeModel} from './providerMediaRuntime.js';
import type {ImageChannelRegistry} from './imageChannelRegistry.js';
import type {VideoProviderRegistry} from './proxy/video/registry.js';
export interface CindyMediaPreferencesHost extends Pick<ReturnType<typeof createMediaModelCatalog>,'isMediaModelExecutableForGuide'|'isMediaModelExecutable'|'filterEnabledGatewayMediaModels'> {
 logger:LiziMcpLogger;
 getActiveCatalog():Pick<Catalog,'providers'>;
 getXdGatewayModels:ReturnType<typeof createActiveCatalog>['getXdGatewayModels'];
 getImageChannelRegistry():ImageChannelRegistry;
 getVideoProviderRegistry():VideoProviderRegistry|null;
 readModelDisableOverrides():ModelDisableOverrides;
 isKnownEmbeddingModel(model:string):boolean;
 isVideoCatalogProviderReady(providerId:string):boolean;
 isXdGatewayProviderReady(providerId:string):boolean;
 isCatalogMediaModelVisible(providerId:string,modelId:string,defaultEnabled?:boolean):boolean;
 listLocalProviderVideoModels(respectDisplaySwitch?:boolean):ProviderMediaRuntimeModel[];
 listProviderMediaModels():ProviderMediaRuntimeModel[];
}
export type LegacyCindyMediaAction = 'generate' | 'edit';
export type CindyMediaPreferenceModel = CindyMediaCatalogConfig['models'][number] & {
  modelId: string;
  modelName: string;
  providerName: string;
  group: string;
  routing?: import('@cindy/model-providers').Provider['routing'];
};
export interface CindyMediaPreferenceConfig {
  models: CindyMediaPreferenceModel[];
  defaults: { standard: string; draft: string; best: string } | null;
}
export function createCindyMediaPreferences(host:CindyMediaPreferencesHost) {
const {getActiveCatalog,getXdGatewayModels,getImageChannelRegistry,getVideoProviderRegistry,readModelDisableOverrides,isKnownEmbeddingModel,isVideoCatalogProviderReady,isXdGatewayProviderReady,isCatalogMediaModelVisible,listLocalProviderVideoModels,listProviderMediaModels,isMediaModelExecutableForGuide,isMediaModelExecutable,filterEnabledGatewayMediaModels}=host;
const log=host.logger;
const LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID = 'openai-images-v1';


/** 旧 cindy-request 类目清单只保留其固定通道对当前动作真正可执行的 XD 模型。 */
function isXdMediaModelExecutableForCatalog(
  kind: CindyCapabilityKind,
  modelId: string,
  action?: LegacyCindyMediaAction,
): boolean {
  if (kind === 'image') {
    if (action) {
      return isMediaModelExecutableForGuide(
        modelId,
        LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID,
        action === 'edit' ? 'image.edit' : 'image.generate',
      );
    }
    return (
      isMediaModelExecutableForGuide(
        modelId,
        LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID,
        'image.generate',
      ) ||
      isMediaModelExecutableForGuide(modelId, LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID, 'image.edit')
    );
  }
  if (kind === 'video') {
    if (action) {
      return isMediaModelExecutable(
        modelId,
        action === 'edit' ? 'video.image_to_video' : 'video.generate',
      );
    }
    return (
      isMediaModelExecutable(modelId, 'video.generate') ||
      isMediaModelExecutable(modelId, 'video.image_to_video')
    );
  }
  return true;
}

/**
 * 当前媒体能力配置(图像/视频同一套推导)——与会话模型列表**同一获取
 * 来源**:active catalog。XD 媒体由 Gateway `/models` 动态投影，第三方媒体
 * 保留各 Provider 的 imageModels/imageDefaults 或 videoModels/videoDefaults。
 * 清单与默认/档位选型全部来自目录,主机代码零
 * 模型字面量;派生规则见 cindyMediaCatalog.ts。
 *
 * 目录里没有该类目的任何模型(极端:远端目录带了 xd 段却不带媒体清单)→
 * `{ models: [], defaults: null }` = 该能力**暂不可用**,不拿打包常量冒充
 * (与聊天侧「无可用性证明不展示」同口径)。下游如实降级:详情页那几行显示
 * 灰字而不是下拉,cindySlot 早拒而不是拿不在册的型号下单。
 */
function getCatalogMediaConfig(
  kind: CindyCapabilityKind,
  action?: LegacyCindyMediaAction,
  selectedProviderId?: string,
): CindyMediaCatalogConfig {
  try {
    const imageRegistry = kind === 'image' ? getImageChannelRegistry() : null;
    // 停用过滤:用户在 设置 → 模型供应商 停用的媒体模型 / 供应商不进候选清单
    // (与对话模型的准入口径同源,见 model-disable-store)。
    const access = readModelDisableOverrides();
    const catalog = getActiveCatalog();
    const xdMediaModelIds = getXdGatewayModels()
      .filter((model) => model.mode === 'image_generation' || model.mode === 'video_generation')
      .map((model) => model.id);
    // 旧 cindy-request 偏好不携带 providerId；同一完整 modelId 同时来自 XD 与
    // 第三方时必须让托管默认来源先参与 first-wins，避免静默改用第三方凭证计费。
    const orderedProviders =
      kind === 'embed'
        ? catalog.providers
        : [
            ...catalog.providers.filter((provider) => provider.id === 'xd'),
            ...catalog.providers.filter((provider) => provider.id !== 'xd'),
          ];
    const providers = selectedProviderId
      ? orderedProviders.filter((provider) => provider.id === selectedProviderId)
      : orderedProviders;
    const videoRegistry = kind === 'video' ? getVideoProviderRegistry() : null;
    return deriveCindyMediaConfig(
      providers,
      kind,
      (providerId, modelId) =>
        isProviderDisabled(access, providerId) ||
        (providerId === 'xd' && kind !== 'embed'
          ? isModelDisabledWithUniqueLegacyBasename(access, providerId, modelId, xdMediaModelIds)
          : isModelDisabled(access, providerId, modelId)) ||
        // active catalog 保留 Gateway 原始媒体事实源；旧 cindy-request 的同步目录
        // 必须在消费边界复用已缓存的 Guide 预检结果，不能暴露这版客户端不可执行的型号。
        (providerId === 'xd' && !isXdMediaModelExecutableForCatalog(kind, modelId, action)) ||
        // 向量:目录是热更的,可能给出客户端还不认识的型号 id(比 EmbeddingModelId
        // 这个静态联合更新)。不在这里滤掉的话,它会照常展示、可被钉选、甚至成为
        // 目录默认 —— 而执行侧 isKnownEmbeddingModel 那道纵深防御会把每一次请求
        // 变成 INTERNAL。UI 先宣称可用、下单才失败是最难排查的一种坏体验
        // (PR #1707 review)。滤掉后按既有语义降级:被滤条目不占 first-wins,
        // 目录默认指向它时回落清单首项;整份清单都不认识才是空清单 → NO_CANDIDATE。
        // 执行侧那道防御保留 —— 它管的是这里与执行层之间的窗口。
        (kind === 'embed' && !isKnownEmbeddingModel(modelId)) ||
        // A ready provider may contain image models owned by an unready runtime.
        (kind === 'image' && !imageRegistry?.isProviderReady(providerId, modelId)) ||
        // 视频目录可能比当前客户端通道先热更。执行 registry 不认识的型号
        // 必须先过滤，不能把“目录有”冒充成“这版客户端能下单”。
        (kind === 'video' && !(videoRegistry?.hasAlias(modelId, providerId) ?? false)),
      // 执行通道凭证就绪过滤(未就绪的来源整段不进白名单,见 imageChannelRegistry
      // 头注)。视频按目录 provider 归属分别检查：xd 要求账号网关能力与 endpoint
      // 同时在场，xai 要求 SuperGrok OAuth 已连接；未知来源 fail closed。
      // 向量仍只有 xd 一家执行通道。Standalone custom Images use Core media's
      // managed URL/base64 handling; keep new sources out of the frozen legacy API.
      kind === 'image'
        ? (providerId) =>
            imageRegistry?.isProviderLegacyReady(providerId) ?? false
        : kind === 'video'
          ? isVideoCatalogProviderReady
          : isXdGatewayProviderReady,
      // 编辑就绪过滤:仅支持生成的来源(supportsEdit: false)的模型不进编辑清单,
      // 防用户把该型号钉到 image.edit 偏好后在 editImage 路径拿到确定性 400。
      kind === 'image'
        ? (providerId) => imageRegistry?.isProviderEditReady(providerId) ?? false
        : undefined,
      kind === 'image' || kind === 'video' ? isCatalogMediaModelVisible : undefined,
    );
  } catch (err) {
    // 目录读取异常 = 拿不到可用性证明,同「空清单」处理(不静默顶一份旧名单)。
    log.warn(`read catalog ${kind} config failed, treating capability as unavailable`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { models: [], defaults: null };
  }
}

const getCatalogImageConfig = (
  action?: LegacyCindyMediaAction,
): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('image', action);
const getCatalogVideoConfig = (
  action?: LegacyCindyMediaAction,
): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('video', action);
const getCatalogEmbedConfig = (): ReturnType<typeof getCatalogMediaConfig> =>
  getCatalogMediaConfig('embed');

const MEDIA_PREFERENCE_PREFIX = 'media:';

function encodeMediaPreference(providerId: string, modelId: string): string {
  return `${MEDIA_PREFERENCE_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

function decodeMediaPreference(value: string): { providerId: string; modelId: string } | null {
  if (!value.startsWith(MEDIA_PREFERENCE_PREFIX)) return null;
  const encoded = value.slice(MEDIA_PREFERENCE_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const providerId = decodeURIComponent(encoded.slice(0, separator));
    const modelId = decodeURIComponent(encoded.slice(separator + 1));
    return providerId && modelId ? { providerId, modelId } : null;
  } catch {
    return null;
  }
}





/** Art 等插件的媒体偏好统一合并已就绪 Provider 与 Gateway 可执行模型。 */
function getMediaPreferenceConfig(capability: GhostMediaCapability): CindyMediaPreferenceConfig {
  const kind = capability.startsWith('image.') ? 'image' : 'video';
  const coreCapability: MediaCapability =
    capability === 'video.edit' ? 'video.image_to_video' : capability;
  const providers = new Map(
    getActiveCatalog().providers.map((provider) => [provider.id, provider] as const),
  );
  const providerModels: CindyMediaPreferenceModel[] = selectExecutableCoreMediaModels(
    kind === 'video' ? listLocalProviderVideoModels(true) : listProviderMediaModels(),
    kind,
    (model) => supportsMediaCapability(model.modalities, coreCapability),
  ).map((model) => {
    const provider = providers.get(model.providerId);
    const providerName = provider?.name ?? model.providerId;
    return {
      id: encodeMediaPreference(model.providerId, model.id),
      modelId: model.id,
      label: model.name,
      modelName: model.name,
      providerId: model.providerId,
      providerName,
      group: providerName,
      ...(provider?.routing ? { routing: provider.routing } : {}),
      supportsEdit: supportsMediaCapability(model.modalities, kind === 'image' ? 'image.edit' : 'video.image_to_video'),
    };
  });
  const gatewayModels: CindyMediaPreferenceModel[] = selectExecutableCoreMediaModels(
    filterEnabledGatewayMediaModels(
      getXdGatewayModels(),
      coreCapability,
      readModelDisableOverrides(),
    ).filter((model) =>
      isCatalogMediaModelVisible(
        'xd',
        model.id,
        'defaultEnabled' in model ? model.defaultEnabled : undefined,
      ),
    ),
    kind,
    (model) => isMediaModelExecutable(model.id, coreCapability),
  ).map((model) => {
    const provider = providers.get('xd');
    const providerName = provider?.name ?? 'Cindy AI';
    const modelName = model.name ?? model.id;
    return {
      id: encodeMediaPreference('xd', model.id),
      modelId: model.id,
      label: modelName,
      modelName,
      providerId: 'xd',
      providerName,
      group: providerName,
      ...(provider?.routing ? { routing: provider.routing } : {}),
      supportsEdit: isMediaModelExecutable(
        model.id,
        kind === 'image' ? 'image.edit' : 'video.image_to_video',
      ),
    };
  });
  const models = [...gatewayModels, ...providerModels];
  const standard = gatewayModels[0]?.id ?? providerModels[0]?.id;
  return {
    models,
    defaults: standard ? { standard, draft: standard, best: standard } : null,
  };
}

function resolveMediaPreferenceModel(
  config: CindyMediaPreferenceConfig,
  preference: string | undefined,
): CindyMediaPreferenceModel | null {
  if (!preference) return null;
  const exact = config.models.find((model) => model.id === preference);
  if (exact) return exact;
  if (decodeMediaPreference(preference)) return null;
  if (!preference.includes('/')) {
    const legacyXdMatches = config.models.filter(
      (model) =>
        model.providerId === 'xd' &&
        model.modelId.slice(model.modelId.lastIndexOf('/') + 1) === preference,
    );
    if (legacyXdMatches.length === 1) return legacyXdMatches[0]!;
  }
  return (
    config.models.find((model) => model.providerId === 'xd' && model.modelId === preference) ??
    config.models.find((model) => model.modelId === preference) ??
    null
  );
}

function resolveMediaPreferenceOrDefault(
  config: CindyMediaPreferenceConfig,
  preference: string | undefined,
): CindyMediaPreferenceModel | null {
  return (
    resolveMediaPreferenceModel(config, preference) ??
    resolveMediaPreferenceModel(config, config.defaults?.standard)
  );
}

function assertMediaModelStillEnabled(
  kind: 'image' | 'video',
  model: string,
  providerId?: string,
  action: LegacyCindyMediaAction = 'generate',
): void {
  const capability: GhostMediaCapability = `${kind}.${action}`;
  const available =
    providerId && kind === 'image' && providerId !== 'xd'
      ? getMediaPreferenceConfig(capability).models.some(
          (candidate) => candidate.providerId === providerId && candidate.modelId === model,
        )
      : getCatalogMediaConfig(kind, action, providerId).models.some(
          (candidate) =>
            candidate.id === model && (!providerId || candidate.providerId === providerId),
        );
  if (!available) {
    throw new Error(
      kind === 'image'
        ? '图像模型不可用(可能已停用或来源凭证未就绪),本次生成已取消'
        : '视频模型不可用(可能已停用或来源凭证未就绪),本次生成已取消',
    );
  }
}

return {isXdMediaModelExecutableForCatalog,getCatalogMediaConfig,getCatalogImageConfig,getCatalogVideoConfig,getCatalogEmbedConfig,getMediaPreferenceConfig,encodeMediaPreference,decodeMediaPreference,resolveMediaPreferenceModel,resolveMediaPreferenceOrDefault,assertMediaModelStillEnabled};
}

import {isOrganizationManagedProvider,isModelDisabled,isProviderDisabled,xaiApiOfficialRuntimeAgents,XAI_API_CUSTOM_PROVIDER_ID,type AgentKind,type Catalog,type MediaCapability,type ModelDisableOverrides} from '@cindy/model-providers';
import type {LiziMcpLogger} from '@cindy/mcps';
import {ImageChannelRegistry,decodeImageResponse} from './imageChannelRegistry.js';
import {createByokImageChannel,pruneDynamicImageChannels,registerByokImageChannels} from './byokImageChannel.js';
import {createCustomImageChannel,registerCustomImageChannels} from './customImageChannel.js';
import {createCodexImageChannel,type CreateCodexImageChannelOptions} from './codexImageClient.js';
import {createXaiImageChannel,type CreateXaiImageChannelOptions} from './xaiImageClient.js';
import {createGeminiImageChannel} from './geminiImageClient.js';
import {createGatewayImageClient} from './proxy/api/gatewayImageClient.js';
import {normalizeImageParameters} from './imageParameters.js';
import {isCustomVideoProvider,resolveCustomMediaConnection} from './customMediaConnection.js';
import {videoConnectionRevision} from './customVideoProtocol.js';
import type {CindyProxyMediaService} from './proxy/types.js';
import type {VideoProviderRegistry} from './proxy/video/registry.js';
import type {CindyMediaCatalogConfig,CindyCapabilityKind} from './cindyMediaCatalog.js';
import type {ProviderMediaRuntime,ProviderMediaRuntimeModel,ProviderVideoConnection} from './providerMediaRuntime.js';
export interface ProviderMediaChannelsHost {
 logger:LiziMcpLogger; codexLogger:LiziMcpLogger;
 getActiveCatalog():Pick<Catalog,'providers'>;
 getAppCapabilities():{canUseCindyGateway:boolean};
 getCindyProxyMediaService():CindyProxyMediaService;
 getProviderSecretStore():{get(key:string):string|null};
 readCustomProviderKey(id:string,agent:AgentKind):string|null;
 readByokCredential(id:string,kind:'image'):string|null;
 readByokInferenceBase(id:string):string|null;
 activeOwnerScopeKey():string; isGhostBoundaryPending():boolean;
 hasGrokOAuthLogin():boolean;getGrokAccessToken():Promise<string>;
 getGrokOAuthCredentialGeneration():number;
 invalidateXaiBridgeAuth:NonNullable<CreateXaiImageChannelOptions['onAuthRejected']>;
 hasCodexOAuthLoginReadOnly():boolean;
 getCodexImageAuthBinding():{
  hasAuth?(providerId:string):boolean;
  getAuth(providerId?:string):Promise<{accessToken:string;accountId:string|null}>;
  onAuthFailure(failure:{status:number;body:string;failedAccessToken:string},providerId?:string):unknown|Promise<unknown>;
 };
 outboundFetch:typeof fetch;
 assertMediaModelStillEnabled(kind:'image'|'video',model:string,providerId?:string):void;
 getCatalogMediaConfig(kind:CindyCapabilityKind):CindyMediaCatalogConfig;
 getMediaPreferenceConfig(capability:'image.generate'|'image.edit'):{models:Array<{providerId:string;modelId:string;supportsEdit:boolean}>};
 readModelDisableOverrides():ModelDisableOverrides;
 isCatalogMediaModelVisible(providerId:string,modelId:string,defaultEnabled?:boolean):boolean;
 getVideoProviderRegistry():VideoProviderRegistry|null;
 isVideoCatalogProviderReady(providerId:string):boolean;
 configureProviderMediaRuntime(runtime:ProviderMediaRuntime):void;
}
export function createProviderMediaChannels(host:ProviderMediaChannelsHost) {
const {getActiveCatalog,getAppCapabilities,getCindyProxyMediaService,getProviderSecretStore,readCustomProviderKey,readByokCredential,readByokInferenceBase,activeOwnerScopeKey,isGhostBoundaryPending,hasGrokOAuthLogin,getGrokAccessToken,getGrokOAuthCredentialGeneration,invalidateXaiBridgeAuth,hasCodexOAuthLoginReadOnly,getCodexImageAuthBinding,outboundFetch,assertMediaModelStillEnabled,getCatalogMediaConfig,getMediaPreferenceConfig,readModelDisableOverrides,isCatalogMediaModelVisible,getVideoProviderRegistry,isVideoCatalogProviderReady,configureProviderMediaRuntime}=host;
const log=host.logger;
const createCodexChannel=(opts:CreateCodexImageChannelOptions)=>createCodexImageChannel(opts,host.codexLogger);
const registeredCodexImageAccounts = new Set<string>();
const registeredByokImageAccounts = new Set<string>();
const registeredCustomImageAccounts = new Set<string>();
let imageChannelRegistrySingleton: ImageChannelRegistry | null = null;
function getImageChannelRegistry(): ImageChannelRegistry {
  if (!imageChannelRegistrySingleton) {
    const registry = new ImageChannelRegistry();
    registry.register('xd', {
      imageProtocol: 'openai',
      ready: () => getAppCapabilities().canUseCindyGateway,
      generateImage: (params) =>
        getCindyProxyMediaService().backend.generateImage({
          model: params.model,
          prompt: params.prompt,
          ...normalizeImageParameters('openai', params.model, params),
        }),
      editImage: (params) =>
        getCindyProxyMediaService().backend.editImage({
          model: params.model,
          prompt: params.prompt,
          imagePaths: params.imagePaths,
          ...normalizeImageParameters('openai', params.model, params),
        }),
    });
    const readXaiApiImageKey = (): string | null => {
      // 图片凭证只取路由命中官方 api.x.ai 端点的 runtime:代理 runtime 的密钥
      // 不得发往官方图片端点(避免 401/403 与凭证披露,见 PR #3875 review)。
      const provider = getActiveCatalog().providers.find(
        (candidate) => candidate.id === XAI_API_CUSTOM_PROVIDER_ID,
      );
      for (const agent of xaiApiOfficialRuntimeAgents(provider)) {
        const value = readCustomProviderKey(XAI_API_CUSTOM_PROVIDER_ID, agent)?.trim();
        if (value) return value;
      }
      return null;
    };
    const hasXaiApiImageKey = (): boolean =>
      getActiveCatalog().providers.some((provider) => provider.id === XAI_API_CUSTOM_PROVIDER_ID) &&
      readXaiApiImageKey() !== null;
    registry.register(
      'xai-api',
      createXaiImageChannel({
        hasApiKey: hasXaiApiImageKey,
        getApiKey: readXaiApiImageKey,
        hasOAuthLogin: () => false,
        getCredentialGeneration: () => 0,
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isGhostBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, 'xai-api'),
      }),
    );
    registry.register(
      'xai',
      createXaiImageChannel({
        hasOAuthLogin: () => hasGrokOAuthLogin(),
        getAccessToken: () => getGrokAccessToken(),
        getCredentialGeneration: () => getGrokOAuthCredentialGeneration(),
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isGhostBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
        onAuthRejected: (failure) => invalidateXaiBridgeAuth(failure),
      }),
    );
    // Gemini(BYO API key,generateContent wire):ready = key 已配置。停用轴
    // 派发前重查经 beforeDispatch 注入(与 xd 通道的 cindyProxyMedia beforeDispatch
    // 同语义 —— xd 的挂在网关客户端装配处,gemini 的挂在这里)。
    registry.register(
      'gemini',
      createGeminiImageChannel({
        getApiKey: () => getProviderSecretStore().get('gemini'),
        // googleapis 境外端点经 outboundFetch 吃系统代理:main 的裸 fetch 不读系统
        // 代理设置,代理软件非 TUN 模式下会直连失败(xd 网关域名境内直连,不注)。
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
      }),
    );
    // OpenAI public Images API(BYO 平台 key):与 xd 网关同 wire,整个客户端复用,
    // 只换 baseUrl/品牌话术/凭证读取。ChatGPT/Codex 订阅走下方独立的 hosted-tool
    // 通道;目录 id 带 openai/ 前缀,public API 适配层剥前缀。
    const openaiImagesClient = createGatewayImageClient({
      getApiKey: () => getProviderSecretStore().get('openai-images'),
      logger: log,
      // 境外端点吃系统代理(outboundFetch):main 的裸 fetch 不读系统代理设置,
      // 代理软件非 TUN 模式下会直连失败(2026-07 review;xd 网关通道不注 ——
      // 网关域名境内直连,与现状一致)。
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      proxy: {
        baseUrl: 'https://api.openai.com',
        generatePath: '/v1/images/generations',
        editPath: '/v1/images/edits',
      },
      brandLabel: 'OpenAI',
      missingKeyMessage: 'OpenAI 图像 API key 未配置,请到「设置 → 模型供应商 → OpenAI」填入后重试',
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', `openai/${model}`, 'openai'),
    });
    const stripOpenaiPrefix = (id: string) =>
      id.startsWith('openai/') ? id.slice('openai/'.length) : id;
    const hasOpenaiPlatformKey = () =>
      (getProviderSecretStore().get('openai-images')?.trim() ?? '') !== '';
    const codexImagesClient = createCodexChannel({
      hasOAuthLogin: hasCodexOAuthLoginReadOnly,
      getAuth: () => getCodexImageAuthBinding().getAuth(),
      onAuthFailure: async (failure) => {
        await getCodexImageAuthBinding().onAuthFailure(failure);
      },
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, 'openai'),
    });
    registry.register('openai', {
      imageProtocol: 'openai',
      // 用户明确配置 Platform key 时优先走确定性的 public Images API；否则复用
      // 已连接的 ChatGPT/Codex 订阅 OAuth hosted tool，不要求再付一份 API 费。
      ready: () => hasOpenaiPlatformKey() || codexImagesClient.ready(),
      generateImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.generateImage(
              {
                model: stripOpenaiPrefix(params.model),
                prompt: params.prompt,
                ...normalizeImageParameters('openai', params.model, params),
              },
              params.signal,
            )
          : codexImagesClient.generateImage(params),
      editImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.editImage(
              {
                model: stripOpenaiPrefix(params.model),
                prompt: params.prompt,
                imagePaths: params.imagePaths,
                ...normalizeImageParameters('openai', params.model, params),
              },
              params.signal,
            )
          : codexImagesClient.editImage(params),
    });
    imageChannelRegistrySingleton = registry;
  }
  const imageProviders = getActiveCatalog().providers;
  pruneDynamicImageChannels(
    imageChannelRegistrySingleton,
    imageProviders,
    registeredCodexImageAccounts,
    registeredByokImageAccounts,
    registeredCustomImageAccounts,
  );
  for (const provider of imageProviders) {
    if (
      isOrganizationManagedProvider(provider) ||
      provider.auth.native !== 'codex' ||
      registeredCodexImageAccounts.has(provider.id)
    )
      continue;
    const providerId = provider.id;
    imageChannelRegistrySingleton.register(
      providerId,
      createCodexChannel({
        providerId,
        hasOAuthLogin: () => getCodexImageAuthBinding().hasAuth?.(providerId) === true,
        getAuth: () => getCodexImageAuthBinding().getAuth(providerId),
        onAuthFailure: async (failure) => {
          await getCodexImageAuthBinding().onAuthFailure(failure, providerId);
        },
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, providerId),
      }),
    );
    registeredCodexImageAccounts.add(providerId);
  }
  // Organization BYOK image models get their own channel. Do not reuse xd /
  // openai / gemini / xai: those stay personal or gateway routes. Chat-only
  // BYOK is skipped until the catalog grows imageModels. Closures read the
  // live member key and inference origin so rotate/logout flip ready().
  registerByokImageChannels(
    imageChannelRegistrySingleton,
    imageProviders,
    registeredByokImageAccounts,
    (provider) => {
      const providerId = provider.id;
      return createByokImageChannel({
        brandLabel: provider.name,
        getApiKey: () => readByokCredential(providerId, 'image'),
        getBaseUrl: () => readByokInferenceBase(providerId),
        getSupportsEdit: () => {
          const current = getActiveCatalog().providers.find(
            (candidate) => candidate.id === providerId,
          );
          return (current?.imageModels ?? []).some(
            (model) => model.modalities?.input.includes('image') === true,
          );
        },
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, providerId),
        logger: log,
      });
    },
  );
  registerCustomImageChannels(
    imageChannelRegistrySingleton,
    imageProviders,
    registeredCustomImageAccounts,
    (providerId) => createCustomImageChannel({
      getProvider: () => getActiveCatalog().providers.find(provider => provider.id === providerId),
      readApiKey: agent => readCustomProviderKey(providerId, agent),
      getOwnerScopeKey: activeOwnerScopeKey,
      isOwnerBoundaryPending: isGhostBoundaryPending,
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      beforeDispatch: model => assertMediaModelStillEnabled('image', model, providerId),
      logger: log,
    }),
  );
  return imageChannelRegistrySingleton;
}

/**
 * 按解析出的模型定位归属来源并取执行通道。归属 = 白名单条目的 providerId
 * (cindyMediaCatalog first-wins 定格);白名单查无该模型时视同已停用
 * (assertMediaModelStillEnabled 同窗口语义)。
 */
function resolveImageChannelForModel(
  model: string,
  operation: 'generate' | 'edit' = 'generate',
  providerId?: string,
) {
  if (providerId) {
    const capability: MediaCapability = operation === 'edit' ? 'image.edit' : 'image.generate';
    const exact = getMediaPreferenceConfig(capability).models.find(
      (candidate) => candidate.providerId === providerId && candidate.modelId === model,
    );
    if (!exact) throw new Error('图像模型或来源不可用,本次生成已取消');
    if (operation === 'edit' && !exact.supportsEdit) {
      throw new Error(`图像来源 ${providerId} 不支持图像编辑,请在设置中选择支持编辑的来源`);
    }
    return getImageChannelRegistry().resolve(providerId, model);
  }
  const entry = getCatalogMediaConfig('image').models.find((m) => m.id === model);
  if (!entry) {
    const slash = model.indexOf('/');
    if (slash > 0) getImageChannelRegistry().resolve(model.slice(0, slash));
    throw new Error('图像模型不可用,本次生成已取消');
  }
  if (operation === 'edit' && !entry.supportsEdit) {
    throw new Error(`图像来源 ${entry.providerId} 不支持图像编辑,请在设置中选择支持编辑的来源`);
  }
  return getImageChannelRegistry().resolve(entry.providerId, model);
}

function listLocalProviderMediaModels(respectDisplaySwitch = false) {
  const access = readModelDisableOverrides();
  return getActiveCatalog().providers.flatMap((provider) => {
    if (
      provider.id === 'xd' ||
      isProviderDisabled(access, provider.id) ||
      !getImageChannelRegistry().isProviderReady(provider.id)
    ) {
      return [];
    }
    return (provider.imageModels ?? []).flatMap((model) => {
      if (
        !getImageChannelRegistry().isProviderReady(provider.id, model.id) ||
        isModelDisabled(access, provider.id, model.id) ||
        (respectDisplaySwitch &&
          !isCatalogMediaModelVisible(provider.id, model.id, model.defaultEnabled))
      ) {
        return [];
      }
      const supportsEdit = getImageChannelRegistry().isProviderEditReady(provider.id, model.id);
      // Legacy/provider catalogs may only carry id/name. The channel registry is
      // the executable capability source in that case: every registered image
      // channel accepts text generation, and editable channels additionally
      // accept an image input. Without this normalization, xAI's valid image
      // models are visible in Settings but disappear from Art's media catalog.
      const modalities = model.modalities ?? {
        input: supportsEdit ? ['text', 'image'] : ['text'],
        output: ['image'],
      };
      if (!modalities.output.includes('image')) return [];
      const input = supportsEdit
        ? [...modalities.input]
        : modalities.input.filter((modality) => modality !== 'image');
      return [
        {
          id: model.id,
          name: model.name,
          providerId: provider.id,
          mode: 'image_generation' as const,
          imageProtocol: getImageChannelRegistry().resolve(provider.id).imageProtocol,
          modalities: { input, output: [...modalities.output] },
          ...(model.officialDocs ? { officialDocs: model.officialDocs } : {}),
        },
      ];
    });
  });
}

/**
 * Video models are executed by the host video registry rather than the image
 * provider runtime. Keep their catalog projection beside the image projection
 * so Art can read the same provider-owned models that Settings displays.
 */
function listLocalProviderVideoModels(respectDisplaySwitch = false): ProviderMediaRuntimeModel[] {
  const access = readModelDisableOverrides();
  const registry = getVideoProviderRegistry();
  return getActiveCatalog().providers.flatMap((provider) => {
    if (
      provider.id === 'xd' ||
      isProviderDisabled(access, provider.id) ||
      (!isVideoCatalogProviderReady(provider.id) && !isCustomVideoProvider(provider))
    ) {
      return [];
    }
    return (provider.videoModels ?? []).flatMap((model) => {
      if (
        isModelDisabled(access, provider.id, model.id) ||
        (isCustomVideoProvider(provider)
          ? !resolveCustomVideoConnection(provider.id, model.id)
          : !registry?.hasAlias(model.id, provider.id)) ||
        (respectDisplaySwitch &&
          !isCatalogMediaModelVisible(provider.id, model.id, model.defaultEnabled))
      ) {
        return [];
      }
      const modalities = model.modalities ?? {
        input: ['text', 'image'],
        output: ['video'],
      };
      if (!modalities.output.includes('video')) return [];
      return [
        {
          id: model.id,
          name: model.name,
          providerId: provider.id,
          mode: 'video_generation' as const,
          ...(isCustomVideoProvider(provider) ? { videoProtocol: 'xai-videos' as const } : {}),
          modalities: { input: [...modalities.input], output: [...modalities.output] },
          ...(model.officialDocs ? { officialDocs: model.officialDocs } : {}),
        },
      ];
    });
  });
}

function resolveCustomVideoConnection(providerId: string, modelId: string): ProviderVideoConnection | null {
  const options = {
    getProvider: () => getActiveCatalog().providers.find(provider => provider.id === providerId),
    readApiKey: (agent: AgentKind) => readCustomProviderKey(providerId, agent),
    isOwnerBoundaryPending: () => isGhostBoundaryPending(),
  };
  const binding = resolveCustomMediaConnection(options, modelId, 'video');
  if (!binding) return null;
  const owner = activeOwnerScopeKey();
  const revision = videoConnectionRevision(providerId, modelId, binding);
  return {
    baseUrl: binding.baseUrl,
    headers: binding.headers,
    revision,
    assertCurrent: () => {
      const current = resolveCustomMediaConnection(options, modelId, 'video');
      if (isGhostBoundaryPending() || owner !== activeOwnerScopeKey() || !current ||
          revision !== videoConnectionRevision(providerId, modelId, current)) {
        throw new Error('视频连接或账号已改变，本次操作已停止；请恢复原连接后查询原任务');
      }
    },
  };
}

configureProviderMediaRuntime({
  resolveVideoConnection: resolveCustomVideoConnection,
  listModels: () => listLocalProviderMediaModels(true),
  listVideoModels: () => listLocalProviderVideoModels(true),
  listExecutableModels: () => listLocalProviderMediaModels(false),
  listExecutableVideoModels: () => listLocalProviderVideoModels(false),
  invoke: async (request) => {
    if (request.capability !== 'image.generate' && request.capability !== 'image.edit') {
      throw new Error('当前第三方 Provider 执行通道不支持该媒体能力');
    }
    const operation = request.capability === 'image.edit' ? 'edit' : 'generate';
    const channel = resolveImageChannelForModel(request.modelId, operation, request.providerId);
    if (
      operation === 'edit' &&
      channel.maxEditImages !== undefined &&
      request.imagePaths.length > channel.maxEditImages
    ) {
      throw new Error(`当前图像来源最多支持 ${channel.maxEditImages} 张参考图`);
    }
    const response =
      operation === 'edit'
        ? await channel.editImage({
            model: request.modelId,
            prompt: request.prompt,
            imagePaths: request.imagePaths,
            ...normalizeImageParameters(channel.imageProtocol, request.modelId, request),
            signal: request.signal,
          })
        : await channel.generateImage({
            model: request.modelId,
            prompt: request.prompt,
            ...normalizeImageParameters(channel.imageProtocol, request.modelId, request),
            signal: request.signal,
          });
    const first = response.data[0];
    if (!first?.b64_json && first?.url) return { url: first.url };
    return decodeImageResponse(response);
  },
});

return {getImageChannelRegistry,resolveImageChannelForModel,listLocalProviderMediaModels,listLocalProviderVideoModels,resolveCustomVideoConnection};
}

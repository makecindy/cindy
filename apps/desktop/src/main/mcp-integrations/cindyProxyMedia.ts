import { AsyncLocalStorage } from 'node:async_hooks';
import { createCindyProxyMediaService } from '../cindy-proxy-media/service.js';
import type { CindyProxyMediaService } from '../cindy-proxy-media/types.js';
import {
  createSeedance25Provider,
  createSeedanceProvider,
} from '../cindy-proxy-media/video/providers/seedance.js';
import { createHappyhorseProvider } from '../cindy-proxy-media/video/providers/happyhorse.js';
import { resolveSafe as resolveXdtImage } from '../imageCacheStore.js';
import { createBlobImageStorage, createBlobVideoStorage } from '../cindy-media/generatedMedia.js';
import { VideoProviderRegistry } from '../cindy-proxy-media/video/registry.js';
import { createLogger } from '../logger.js';
import { mediaErrorForLog } from '../cindy-media/mediaRequestLog.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { withCindyGatewayKeyRejectionReport } from '../model-access/gatewayKeyRejection.js';
import { getAppCapabilities } from '../appCapabilities.js';

const log = createLogger('art');
const billingSession = new AsyncLocalStorage<string | undefined>();

/** The session comes from the Host's active same-plugin call, never plugin arguments. */
export function withCindyMediaBillingSession<T>(sessionId: string | undefined, run: () => T): T {
  return billingSession.run(sessionId, run);
}

let artService: CindyProxyMediaService | null = null;
/** 构建单例时捕获的 baseUrl;model-access 下发切换 endpoint 后据此重建。 */
let artServiceBaseUrl: string | null = null;

function readApiKey(): string | null {
  // 本地 only:经统一的 providerSecretStore 读 XD 网关 key。
  if (!getAppCapabilities().canUseCindyGateway) return null;
  return getProviderSecretStore().get('xd');
}

function getGatewayBaseUrl(): string {
  // 与 key 同源的生效 endpoint(model-access 下发值优先,回落端点清单)。
  return effectiveXdGatewayBaseUrl();
}

/**
 * Only Gateway creates are billable. Polling and CDN downloads bypass accounting.
 * Keep Gateway 401 key-rejection reporting for all requests carrying Authorization.
 */
const gatewayMediaFetch = withCindyGatewayKeyRejectionReport(async (input, init) => {
  if (init?.method?.toUpperCase() !== 'POST') return fetch(input, init);
  let model = 'unknown';
  if (typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as { model?: unknown };
      if (typeof body?.model === 'string') model = body.model;
    } catch { /* The response header remains the authoritative model. */ }
  } else if (init.body instanceof FormData) {
    const value = init.body.get('model');
    if (typeof value === 'string') model = value;
  }
  const { prepareGatewayMediaBilling } = await import('../usage/gatewayMediaBilling.js');
  const recordBilling = await prepareGatewayMediaBilling({ model, sessionId: billingSession.getStore() });
  try {
    const response = await fetch(input, init);
    await recordBilling(response);
    return response;
  } finally {
    recordBilling.finish();
  }
});

/**
 * XD Gateway 图像/视频后端单例。lizi_art MCP 工具层已退役(2026-07-12),
 * 本服务不再对 agent 暴露工具,只作为 host 侧链路的后端:
 * - cindy 槽(意识代办 gen/edit image + video,见 cindy-brain/index.ts)。
 * (mivo 装配已随 lizi_mivo MCP 退役移除,2026-07-13,能力在意识 xd-mivo。)
 */
export function getCindyProxyMediaService(): CindyProxyMediaService {
  // provider 装配在构造期捕获 baseUrl 字符串;endpoint 变化(登录后 model-access
  // 下发 / 手填回落)时重建单例,构造无 IO 成本可忽略。
  if (artService && artServiceBaseUrl !== getGatewayBaseUrl()) {
    artService = null;
  }
  if (!artService) {
    artServiceBaseUrl = getGatewayBaseUrl();
    // 产物存储走 cindy-media 媒体总仓(规则 25;内容寻址 blob,
    // URL = cindy-media://blobs/<hash>.<ext>)。老 lizi-art-media 目录冻结只读,
    // 历史 xdt-image:// 地址由 resolveLegacyImageRef 继续服务(改历史图场景)。
    const mediaStore = createBlobImageStorage({
      resolveLegacyImageRef: (ref) => resolveXdtImage(ref),
    });
    const videoStore = createBlobVideoStorage();
    const videoProviders = createGatewayVideoProviders(artServiceBaseUrl);
    artService = createCindyProxyMediaService({
      imageApi: {
        getApiKey: readApiKey,
        fetchImplementation: gatewayMediaFetch,
        proxy: {
          baseUrl: getGatewayBaseUrl(),
          generatePath: '/v1/images/generations',
          editPath: '/v1/images/edits',
        },
      },
      storage: {
        saveImage: mediaStore.saveImage,
        resolveImageRef: mediaStore.resolveImageRef,
      },
      videoProviders,
      videoStorage: {
        saveVideo: videoStore.saveVideo,
      },
      logger: log,
    });
  }
  return artService;
}

/** Shared factory: execution keeps the same aliases and ordering as discovery. */
function createGatewayVideoProviders(baseUrl: string) {
  return [
    createSeedanceProvider({
      baseUrl,
      getApiKey: readApiKey,
      fetchImplementation: gatewayMediaFetch,
      logger: log,
    }),
    // Seedance 2.5 是独立 provider(值域与 2.0 差太远,capabilities 是
    // per-provider 的,详见 seedance.ts 文件头)。同样是 opt-in:排在
    // seedance-fast 之后,不抢出厂默认。
    createSeedance25Provider({
      baseUrl,
      getApiKey: readApiKey,
      fetchImplementation: gatewayMediaFetch,
      logger: log,
    }),
    createHappyhorseProvider({
      baseUrl,
      getApiKey: readApiKey,
      fetchImplementation: gatewayMediaFetch,
      logger: log,
    }),
  ];
}

let videoRegistry: VideoProviderRegistry | null = null;
let videoRegistryBaseUrl: string | null = null;

/** Video discovery must work without constructing the Gateway image client or media storage. */
export function getCindyVideoProviderRegistry(): VideoProviderRegistry {
  const baseUrl = getGatewayBaseUrl();
  if (!videoRegistry || videoRegistryBaseUrl !== baseUrl) {
    const next = new VideoProviderRegistry();
    if (baseUrl.trim()) {
      try {
        for (const provider of createGatewayVideoProviders(baseUrl)) next.register(provider);
      } catch (error) {
        // A broken optional Gateway must not prevent independent providers from registering.
        log.warn('Gateway video providers unavailable during registry initialization', {
          error: mediaErrorForLog(error),
        });
      }
    }
    videoRegistry = next;
    videoRegistryBaseUrl = baseUrl;
  }
  return videoRegistry;
}

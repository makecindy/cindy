import { createCindyProxyMediaService } from '../cindy-proxy-media/service.js';
import type { CindyProxyMediaService } from '../cindy-proxy-media/types.js';
import {
  createSeedance25Provider,
  createSeedanceProvider,
} from '../cindy-proxy-media/video/providers/seedance.js';
import { createHappyhorseProvider } from '../cindy-proxy-media/video/providers/happyhorse.js';
import { resolveSafe as resolveXdtImage } from '../imageCacheStore.js';
import {
  createBlobImageStorage,
  createBlobVideoStorage,
} from '../cindy-media/generatedMedia.js';
import { createLogger } from '../logger.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { getAppCapabilities } from '../appCapabilities.js';

const log = createLogger('art');

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
    // 视频 provider 装配点 — 加新模型(kling/luma/wan)就在这个数组追加一行,
    // cindy 槽 handler / 渲染层 / 协议层零改动。
    //
    // 顺序敏感:数组首个 alias 就是出厂默认(GATEWAY_VIDEO_MODELS 首项同源
    // 守卫锁定),seedance-fast 必须永远排第一个。happyhorse 是 opt-in,
    // 只有用户显式点名才切。
    const videoProviders = [
      createSeedanceProvider({
        baseUrl: getGatewayBaseUrl(),
        getApiKey: readApiKey,
        logger: log,
      }),
      // Seedance 2.5 是独立 provider(值域与 2.0 差太远,capabilities 是
      // per-provider 的,详见 seedance.ts 文件头)。同样是 opt-in:排在
      // seedance-fast 之后,不抢出厂默认。
      createSeedance25Provider({
        baseUrl: getGatewayBaseUrl(),
        getApiKey: readApiKey,
        logger: log,
      }),
      createHappyhorseProvider({
        baseUrl: getGatewayBaseUrl(),
        getApiKey: readApiKey,
        logger: log,
      }),
    ];
    artService = createCindyProxyMediaService({
      imageApi: {
        getApiKey: readApiKey,
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

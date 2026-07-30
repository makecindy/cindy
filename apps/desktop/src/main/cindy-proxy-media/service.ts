import type { CindyProxyMediaBackendDeps } from './types.js';
import type { CindyProxyMediaService, CindyProxyMediaServiceOptions } from './types.js';
import { createGatewayImageClient } from './api/gatewayImageClient.js';
import { isProviderModelRouteDisabled } from '../utility-model/oneShotCandidates.js';
import { VideoProviderRegistry } from './video/registry.js';

/**
 * 装配 XD Gateway 图像/视频后端(纯后端,无 MCP 工具面)。消费方:
 * - desktop cindy 槽(意识代办的 gen/edit image + video);
 * - desktop mivo 装配(复用 saveImage/resolveImageRef/saveVideo 存储适配)。
 */
export function createCindyProxyMediaService(opts: CindyProxyMediaServiceOptions): CindyProxyMediaService {
  const imageClient = createGatewayImageClient({
    getApiKey: opts.imageApi.getApiKey,
    proxy: opts.imageApi.proxy,
    fetchImplementation: opts.imageApi.fetchImplementation,
    logger: opts.logger,
    // 停用轴:XD 图像通道的提交紧前重查(凭证/读图 await 窗口内被停用即拒,
    // PR #744 review 第二十一轮)。
    beforeDispatch: (model) => {
      if (isProviderModelRouteDisabled('xd', model)) {
        throw new Error('图像模型已在设置中停用,本次生成已取消');
      }
    },
  });

  // Build the video provider registry only when we actually have providers
  // — an absent registry tells the host that video capability is unavailable.
  let videoRegistry: VideoProviderRegistry | undefined;
  if (opts.videoProviders && opts.videoProviders.length > 0) {
    if (!opts.videoStorage) {
      throw new Error(
        'art: videoStorage is required when videoProviders is non-empty',
      );
    }
    videoRegistry = new VideoProviderRegistry();
    for (const p of opts.videoProviders) {
      videoRegistry.register(p);
    }
  }

  const backend: CindyProxyMediaBackendDeps = {
    generateImage: imageClient.generateImage,
    editImage: imageClient.editImage,
    saveImage: opts.storage.saveImage,
    resolveImageRef: opts.storage.resolveImageRef,
    videoRegistry,
    saveVideo: opts.videoStorage?.saveVideo,
    logger: opts.logger,
  };

  return { backend };
}

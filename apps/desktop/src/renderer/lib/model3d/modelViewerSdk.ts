/**
 * modelViewerSdk — `mivo-model-viewer` 的懒加载入口。
 * ---------------------------------------------------------------------------
 * 库体积约 600KB（含 Three.js 各格式加载器），只在聊天里真的出现 3D 模型、或用户
 * 打开 3D 查看器时才动态加载；加载失败会清掉缓存，下次可重试。
 *
 * 加载后一次性做两件事：
 *   - 限定可处理的格式为 maker-shared 的 3D 识别范围——ZIP 资源包、实验性的
 *     VRML / STEP 都不在其中，库自身也会拒绝它们；
 *   - 把随应用打包的 Draco 解码器按文件名交给 SDK（见 dracoDecoder.ts），Draco 压缩的
 *     GLB 不再依赖 gstatic CDN，离线可用。必须在首次加载 Draco 模型之前设置。
 */

import { MODEL3D_FORMATS } from '@cindy/maker-shared/model3d';

type ModelViewerSdk = typeof import('mivo-model-viewer');

interface ModelViewerSdkDeps {
  importSdk: () => Promise<ModelViewerSdk>;
  createDracoFiles: () => Promise<Parameters<ModelViewerSdk['setDracoDecoderFiles']>[0]>;
}

/**
 * SDK 加载器：每个加载器只配置一次并把同一个 SDK 交给所有调用方；配置失败（比如 Draco
 * 解码器不可用）整体拒绝并清掉缓存，下次可重试，绝不把没配置好的 SDK 交出去。
 * 依赖作为参数注入，便于测试时不必重载模块。
 */
export function createModelViewerSdkLoader(deps: ModelViewerSdkDeps): () => Promise<ModelViewerSdk> {
  let sdkPromise: Promise<ModelViewerSdk> | null = null;
  return () => {
    if (!sdkPromise) {
      sdkPromise = Promise.all([deps.importSdk(), deps.createDracoFiles()])
        .then(([sdk, dracoFiles]) => {
          sdk.setEnabledFormats([...MODEL3D_FORMATS]);
          sdk.setDracoDecoderFiles(dracoFiles);
          return sdk;
        })
        .catch((error: unknown) => {
          sdkPromise = null;
          throw error;
        });
    }
    return sdkPromise;
  };
}

export const loadModelViewerSdk = createModelViewerSdkLoader({
  importSdk: () => import('mivo-model-viewer'),
  createDracoFiles: () => import('./dracoDecoder').then((draco) => draco.createDracoDecoderFiles()),
});

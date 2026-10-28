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

let sdkPromise: Promise<ModelViewerSdk> | null = null;

export function loadModelViewerSdk(): Promise<ModelViewerSdk> {
  if (!sdkPromise) {
    sdkPromise = Promise.all([import('mivo-model-viewer'), import('./dracoDecoder')])
      .then(async ([sdk, draco]) => {
        sdk.setEnabledFormats([...MODEL3D_FORMATS]);
        sdk.setDracoDecoderFiles(await draco.createDracoDecoderFiles());
        return sdk;
      })
      .catch((error: unknown) => {
        sdkPromise = null;
        throw error;
      });
  }
  return sdkPromise;
}

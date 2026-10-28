/**
 * modelViewerSdk — `mivo-model-viewer` 的懒加载入口。
 * ---------------------------------------------------------------------------
 * 库体积约 600KB（含 Three.js 各格式加载器），只在聊天里真的出现 3D 模型、或用户
 * 打开 3D 查看器时才动态加载；加载失败会清掉缓存，下次可重试。
 *
 * 加载后一次性限定可处理的格式为 maker-shared 的 3D 识别范围——ZIP 资源包、
 * 实验性的 VRML / STEP 都不在其中，库自身也会拒绝它们。
 */

import { MODEL3D_FORMATS } from '@cindy/maker-shared/model3d';

type ModelViewerSdk = typeof import('mivo-model-viewer');

let sdkPromise: Promise<ModelViewerSdk> | null = null;

export function loadModelViewerSdk(): Promise<ModelViewerSdk> {
  if (!sdkPromise) {
    sdkPromise = import('mivo-model-viewer')
      .then((sdk) => {
        sdk.setEnabledFormats([...MODEL3D_FORMATS]);
        return sdk;
      })
      .catch((error: unknown) => {
        sdkPromise = null;
        throw error;
      });
  }
  return sdkPromise;
}

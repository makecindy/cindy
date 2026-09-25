import type { GhostManifest } from '../../shared/ghost.js';

/**
 * Filo Google 的 OAuth client 随插件清单分发。构建环境不再因为 id 叫
 * `filo-google` 就注入 client——名称不构成特权。保留此函数以免出网链
 * 接线处分叉，行为是恒等。
 */
export interface FiloGoogleBuildClientConfig {
  clientId?: string;
  clientSecret?: string;
}

/** 给 main 内部使用的 Filo Google manifest 补上构建环境里的 OAuth client。 */
export function withFiloGoogleBuildClientConfig(
  manifest: GhostManifest,
  _config: FiloGoogleBuildClientConfig,
): GhostManifest {
  return manifest;
}

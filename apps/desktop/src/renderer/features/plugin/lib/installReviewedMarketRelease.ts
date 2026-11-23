import type { PluginMarketDetail } from '../../../../shared/pluginMarket';

/** Install the displayed release through Main's permission flow, preserving source identity. */
export function installReviewedMarketRelease(detail: PluginMarketDetail) {
  return window.electronAPI.pluginMarket.install(detail.pluginId, {
    expectedReleaseId: detail.releaseId,
    expectedManifest: detail.manifest,
    allowSourceReplacement: false,
  });
}

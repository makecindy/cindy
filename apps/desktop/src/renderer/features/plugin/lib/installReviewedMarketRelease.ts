import type { PluginMarketDetail } from '../../../../shared/pluginMarket';

/** Install the displayed release through Main's permission flow, preserving source identity. */
export function installReviewedMarketRelease(detail: PluginMarketDetail, expectedInstalledApproval?: string) {
  return window.electronAPI.pluginMarket.install(detail.pluginId, {
    expectedReleaseId: detail.releaseId,
    expectedManifest: detail.manifest,
    ...(expectedInstalledApproval ? { expectedInstalledApproval } : {}),
    allowSourceReplacement: false,
  });
}

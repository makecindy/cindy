import type { PluginMarketPackageReview } from '../../shared/pluginMarket.js';

/** 安装包权限与市场展示不一致时，交给 PluginMarketService 转成可恢复结果。 */
export class GhostPackagePermissionReviewRequiredError extends Error {
  constructor(readonly review: PluginMarketPackageReview) {
    super('The downloaded Plugin package requires permission review');
  }
}

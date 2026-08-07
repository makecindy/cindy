import type { PluginMarketPackageReviewFacts } from '../../shared/pluginMarket.js';

/** 真实安装包需要用户复核时，交给 PluginMarketService 转成可恢复结果。 */
export class GhostPackagePermissionReviewRequiredError extends Error {
  constructor(readonly review: PluginMarketPackageReviewFacts) {
    super('The downloaded Plugin package requires permission review');
  }
}

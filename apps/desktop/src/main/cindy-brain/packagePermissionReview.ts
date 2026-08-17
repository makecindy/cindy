import type { PluginMarketPackageReviewFacts } from '../../shared/pluginMarket.js';

/** 真实安装包需要用户复核时，交给 PluginMarketService 转成可恢复结果。 */
export class GhostPackagePermissionReviewRequiredError extends Error {
  constructor(readonly review: PluginMarketPackageReviewFacts) {
    super('The downloaded Plugin package requires permission review');
  }
}

/**
 * 下载后是否还要弹窗口级 Host 权限卡。
 * 用户已经确认过的清单(reviewed)当作上限:真实包没有超出部分就不再弹;
 * 没有这份上限时,手动首装仍审真实包,更新只在相对已装基线扩权时审。
 */
export function marketPackageNeedsHostReview(input: {
  mode: 'manual' | 'cap';
  builtinOauthClientChanged: boolean;
  /** null = 没有已装批准基线。 */
  addedCount: number | null;
  unreviewedCount: number;
  /** null = 调用方没有把用户已确认的清单传来。 */
  extrasVersusReviewedCount: number | null;
}): boolean {
  if (input.builtinOauthClientChanged) return true;
  if (input.extrasVersusReviewedCount !== null) {
    return input.extrasVersusReviewedCount > 0;
  }
  if (input.mode === 'manual') {
    return input.addedCount === null || input.addedCount > 0;
  }
  return input.unreviewedCount > 0;
}

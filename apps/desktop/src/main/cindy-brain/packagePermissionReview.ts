import {
  type GhostManifest,
  type GhostSecretDecl,
  type GhostPermissionDiff,
} from '../../shared/ghost.js';
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
  /** 已审预览与真实包的随包手册摘要不一致。 */
  manualSummaryChanged?: boolean;
  /** null = 没有已装批准基线。 */
  addedCount: number | null;
  unreviewedCount: number;
  /** null = 调用方没有把用户已确认的清单传来。 */
  extrasVersusReviewedCount: number | null;
}): boolean {
  if (input.builtinOauthClientChanged) return true;
  if (input.manualSummaryChanged) return true;
  if (input.extrasVersusReviewedCount !== null) {
    return input.extrasVersusReviewedCount > 0;
  }
  if (input.mode === 'manual') {
    return input.addedCount === null || input.addedCount > 0;
  }
  return input.unreviewedCount > 0;
}

/**
 * 内置 OAuth clientId 是否相对用户已确认的清单或已装基线发生了变化。
 * 权限投影不含 clientId,必须单独比;已装基线与预览清单都要比真实包。
 */
export function marketPackageOauthIdentityChanged(
  reviewed: GhostManifest | undefined,
  installedBaseline: GhostManifest | null,
  actual: GhostManifest,
): boolean {
  // 已装基线空 clientId→默认值不算迁移(令牌仍有效)。已审预览则相反。
  if (
    installedBaseline &&
    oauthIdentitiesChanged(installedBaseline, actual, { emptyDirectToConcreteCounts: false })
  ) {
    return true;
  }
  if (!reviewed) return false;
  return oauthIdentitiesChanged(reviewed, actual, { emptyDirectToConcreteCounts: true });
}

/**
 * Host 卡要展示触发复核的全部事实。没有已装基线、真实包相对已审清单多了权限、
 * 或手册摘要变了时,回 null,让界面改走完整真实包清单,不要合成「权限无变化」。
 */
export function marketPackageHostReviewDiff(input: {
  permissionDiff: GhostPermissionDiff | null;
  extrasVersusReviewedCount: number | null;
  builtinOauthClientChanged: boolean;
  manualSummaryChanged: boolean;
}): GhostPermissionDiff | null {
  const extrasExist = (input.extrasVersusReviewedCount ?? 0) > 0;
  if (input.permissionDiff === null || extrasExist || input.manualSummaryChanged) {
    return null;
  }
  return {
    ...input.permissionDiff,
    builtinOauthClientChanged:
      input.permissionDiff.builtinOauthClientChanged || input.builtinOauthClientChanged,
  };
}

/**
 * 已审预览与真实包的随包手册是否不一致。
 * 页面确认只展示手册条数与条目身份;真实包改了这些事实就必须再审。
 */
export function marketPackageManualSummaryChanged(
  reviewed: GhostManifest | undefined,
  actual: GhostManifest,
): boolean {
  if (!reviewed) return false;
  return manualSummaryKey(reviewed) !== manualSummaryKey(actual);
}

function manualSummaryKey(manifest: GhostManifest): string {
  const items = (manifest.manual?.items ?? []).map((item) => ({
    name: item.name,
    dir: item.dir,
    description: item.description,
  }));
  items.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    if (left.dir !== right.dir) return left.dir < right.dir ? -1 : 1;
    return 0;
  });
  return JSON.stringify(items);
}

function oauthIdentityKey(secret: GhostSecretDecl): string | null {
  if (secret.source !== 'oauth' || !secret.oauth) return null;
  if (secret.oauth.tokenBroker) return `broker:${secret.oauth.tokenBroker}`;
  return `direct:${secret.oauth.clientId?.trim() || ''}`;
}

function oauthIdentitiesChanged(
  previousManifest: GhostManifest,
  actual: GhostManifest,
  options: { emptyDirectToConcreteCounts: boolean },
): boolean {
  if (previousManifest.id !== actual.id) return false;
  const previousByKey = new Map(
    (previousManifest.network?.secrets ?? []).map((secret) => [secret.key, secret]),
  );
  for (const current of actual.network?.secrets ?? []) {
    const currentIdentity = oauthIdentityKey(current);
    if (!currentIdentity) continue;
    const previous = previousByKey.get(current.key);
    if (!previous) continue;
    const previousIdentity = oauthIdentityKey(previous);
    if (!previousIdentity || previousIdentity === currentIdentity) continue;
    if (
      !options.emptyDirectToConcreteCounts &&
      previousIdentity === 'direct:' &&
      currentIdentity.startsWith('direct:')
    ) {
      continue;
    }
    return true;
  }
  return false;
}

import {
  changedBuiltinOauthClientSecretKeys,
  type GhostManifest,
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
  if (
    installedBaseline &&
    changedBuiltinOauthClientSecretKeys(installedBaseline, actual).length > 0
  ) {
    return true;
  }
  if (!reviewed) return false;
  if (changedBuiltinOauthClientSecretKeys(reviewed, actual).length > 0) return true;
  // 已装基线的空 clientId→默认值不算迁移(令牌仍有效)。已审预览清单则相反:
  // 用户没见过的具体 clientId 必须再确认。
  return reviewedOauthClientBecameConcrete(reviewed, actual);
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
  return (manifest.manual?.items ?? [])
    .map((item) => `${item.name}\0${item.dir}\0${item.description}`)
    .sort()
    .join('\n');
}

function reviewedOauthClientBecameConcrete(
  reviewed: GhostManifest,
  actual: GhostManifest,
): boolean {
  if (reviewed.id !== actual.id) return false;
  const reviewedSecrets = new Map(
    (reviewed.network?.secrets ?? []).map((secret) => [secret.key, secret]),
  );
  for (const current of actual.network?.secrets ?? []) {
    if (current.source !== 'oauth' || !current.oauth) continue;
    if (current.oauth.tokenBroker) continue;
    const currentClientId = current.oauth.clientId?.trim() || null;
    if (!currentClientId) continue;
    const previous = reviewedSecrets.get(current.key);
    if (previous?.source !== 'oauth' || !previous.oauth || previous.oauth.tokenBroker) {
      continue;
    }
    if (!(previous.oauth.clientId?.trim() || null)) return true;
  }
  return false;
}

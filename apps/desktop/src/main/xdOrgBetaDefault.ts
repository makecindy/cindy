/**
 * xdOrgBetaDefault — 心动 / xd 组织的 beta 测试渠道默认打开策略。
 *
 * beta 本身是设备级本地开关(update-channel-settings.json,登出不清)。
 * 这里只在 cloud 登录态落地后补一次默认值:
 *   - 仅 xd 组织账号;
 *   - 用户从没改过这个开关(isCustomized === false);
 *   - 当前仍是关的;
 *   - CDN 上 beta manifest 可达。
 *
 * 用户手动关掉后 isCustomized 为 true,重启 / 重登都不再打开。
 * 真正的发布通道切换仍留给下次 fetchManifest / 用户自行重启,这里不 relaunch。
 */

export const XD_ORG_SLUG = 'xd';

const XD_ORG_NAME_FALLBACKS = new Set(['xd', '心动网络']);

export interface XdOrgBetaUser {
  membershipKind: 'personal' | 'org';
  orgSlug: string | null;
  orgName: string | null;
}

export interface XdOrgBetaChannelState {
  enableBeta: boolean;
  /** 用户是否显式拨过开关。组织默认写入不算。 */
  isCustomized: boolean;
}

export interface XdOrgBetaDefaultRequest {
  expectedAuthEpoch: number;
  expectedUserId: string;
  user: XdOrgBetaUser;
}

export interface XdOrgBetaDefaultDeps {
  readCurrentAuthIdentity(): { authEpoch: number; userId: string | null };
  readChannelState(): XdOrgBetaChannelState;
  probeBetaManifest(): Promise<boolean>;
  enableBeta(): boolean | Promise<boolean>;
}

export type XdOrgBetaDefaultOutcome =
  | { kind: 'enabled' }
  | {
      kind: 'skipped';
      reason:
        | 'not-xd-org'
        | 'already-enabled'
        | 'user-customized'
        | 'beta-unavailable'
        | 'stale-auth';
    };

/** 当前登录用户是否是 xd 组织。orgSlug 优先,旧 token 才回退显示名。 */
export function isXdOrgUser(user: XdOrgBetaUser | null | undefined): boolean {
  if (!user || user.membershipKind !== 'org') return false;
  if (user.orgSlug !== null) return user.orgSlug === XD_ORG_SLUG;
  const name = user.orgName?.trim().toLocaleLowerCase();
  return name !== undefined && XD_ORG_NAME_FALLBACKS.has(name);
}

function isCurrentAuth(request: XdOrgBetaDefaultRequest, deps: XdOrgBetaDefaultDeps): boolean {
  const current = deps.readCurrentAuthIdentity();
  return current.authEpoch === request.expectedAuthEpoch && current.userId === request.expectedUserId;
}

/**
 * 登录态落地后尝试为 xd 组织打开设备级 beta。
 * 任何「不应改用户选择 / 身份已变 / CDN 不可达」的情况都 skip,不写盘。
 */
export async function maybeEnableXdOrgBetaDefault(
  request: XdOrgBetaDefaultRequest,
  deps: XdOrgBetaDefaultDeps,
): Promise<XdOrgBetaDefaultOutcome> {
  if (!isXdOrgUser(request.user)) {
    return { kind: 'skipped', reason: 'not-xd-org' };
  }
  if (!isCurrentAuth(request, deps)) {
    return { kind: 'skipped', reason: 'stale-auth' };
  }

  const state = deps.readChannelState();
  if (state.enableBeta) {
    return { kind: 'skipped', reason: 'already-enabled' };
  }
  if (state.isCustomized) {
    return { kind: 'skipped', reason: 'user-customized' };
  }

  let available = false;
  try {
    available = await deps.probeBetaManifest();
  } catch {
    return { kind: 'skipped', reason: 'beta-unavailable' };
  }
  if (!available) {
    return { kind: 'skipped', reason: 'beta-unavailable' };
  }
  if (!isCurrentAuth(request, deps)) {
    return { kind: 'skipped', reason: 'stale-auth' };
  }

  const wrote = await deps.enableBeta();
  if (!wrote) {
    const latest = deps.readChannelState();
    if (latest.enableBeta) return { kind: 'skipped', reason: 'already-enabled' };
    return { kind: 'skipped', reason: 'user-customized' };
  }
  return { kind: 'enabled' };
}

/** Mobile 登录后为 xd 组织补设备级 beta 默认值的纯策略。 */

const XD_ORG_SLUG = 'xd';
const XD_ORG_NAME_FALLBACKS = new Set(['xd', '心动网络']);

export interface XdOrgBetaUser {
  membershipKind: 'personal' | 'org';
  orgSlug: string | null;
  orgName: string | null;
}

export interface XdOrgBetaDefaultRequest {
  expectedAuthGeneration: number;
  expectedUserId: string;
  user: XdOrgBetaUser;
}

export type OrgBetaDefaultDecision = 'xd-legacy' | 'flag-enable' | 'skip';

export interface XdOrgBetaDefaultDeps {
  readCurrentAuthIdentity(): { authGeneration: number; userId: string | null };
  readChannelState(): { enableBeta: boolean; isCustomized: boolean };
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

export function isXdOrgUser(user: XdOrgBetaUser | null | undefined): boolean {
  if (!user || user.membershipKind !== 'org') return false;
  if (user.orgSlug !== null) return user.orgSlug === XD_ORG_SLUG;
  const name = user.orgName?.trim().toLocaleLowerCase();
  return name !== undefined && XD_ORG_NAME_FALLBACKS.has(name);
}

/** 先按 xd 身份判定，只有非 xd 才允许 feature flag 打开设备默认值。 */
export function shouldAttemptOrgBetaDefault(input: {
  user: XdOrgBetaUser | null | undefined;
  defaultEnableBeta?: boolean;
}): OrgBetaDefaultDecision {
  if (isXdOrgUser(input.user)) return 'xd-legacy';
  if (input.user?.membershipKind !== 'org' || input.defaultEnableBeta !== true) {
    return 'skip';
  }
  return 'flag-enable';
}

function isCurrentAuth(
  request: XdOrgBetaDefaultRequest,
  deps: XdOrgBetaDefaultDeps,
): boolean {
  const current = deps.readCurrentAuthIdentity();
  return (
    current.authGeneration === request.expectedAuthGeneration &&
    current.userId === request.expectedUserId
  );
}

export async function maybeEnableXdOrgBetaDefault(
  request: XdOrgBetaDefaultRequest,
  deps: XdOrgBetaDefaultDeps,
): Promise<XdOrgBetaDefaultOutcome> {
  if (!isXdOrgUser(request.user)) {
    return { kind: 'skipped', reason: 'not-xd-org' };
  }
  return maybeEnableBetaDefaultForEligibleUser(request, deps);
}

/** 为非 xd 组织复用同一套设备默认写盘保护，仅由 feature flag 显式开启。 */
export async function maybeEnableNonXdOrgBetaDefault(
  request: XdOrgBetaDefaultRequest,
  deps: XdOrgBetaDefaultDeps,
): Promise<XdOrgBetaDefaultOutcome> {
  if (isXdOrgUser(request.user)) {
    return { kind: 'skipped', reason: 'not-xd-org' };
  }
  return maybeEnableBetaDefaultForEligibleUser(request, deps);
}

async function maybeEnableBetaDefaultForEligibleUser(
  request: XdOrgBetaDefaultRequest,
  deps: XdOrgBetaDefaultDeps,
): Promise<XdOrgBetaDefaultOutcome> {
  if (!isCurrentAuth(request, deps)) {
    return { kind: 'skipped', reason: 'stale-auth' };
  }

  const state = deps.readChannelState();
  if (state.enableBeta) return { kind: 'skipped', reason: 'already-enabled' };
  if (state.isCustomized) return { kind: 'skipped', reason: 'user-customized' };

  let available = false;
  try {
    available = await deps.probeBetaManifest();
  } catch {
    return { kind: 'skipped', reason: 'beta-unavailable' };
  }
  if (!available) return { kind: 'skipped', reason: 'beta-unavailable' };
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

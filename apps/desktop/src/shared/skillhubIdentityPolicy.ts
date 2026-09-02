export type SkillhubPublishVisibility = 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE';

export interface SkillhubIdentity {
  membershipKind: 'personal' | 'org';
  orgSlug: string | null;
  orgName?: string | null;
}
export interface SkillhubIdentityPolicy {
  canWrite: boolean;
  ownerType: 'personal' | 'organization' | null;
  allowedVisibilities: readonly SkillhubPublishVisibility[];
  readOnlyReason: 'legacy-xd' | 'signed-out' | null;
}

const XD_ORG_NAMES = new Set(['xd', '心动网络']);

/**
 * UI-only legacy identity projection. Authorization remains server-owned; the
 * display-name fallback only covers older XD tokens that predate orgSlug.
 */
export function isLegacyXdSkillhubIdentity(
  identity: SkillhubIdentity | null | undefined,
): boolean {
  if (!identity || identity.membershipKind !== 'org') return false;
  if (identity.orgSlug !== null) return identity.orgSlug === 'xd';
  const name = identity.orgName?.trim().toLocaleLowerCase();
  return name !== undefined && XD_ORG_NAMES.has(name);
}

export function deriveSkillhubIdentityPolicy(
  identity: SkillhubIdentity | null | undefined,
): SkillhubIdentityPolicy {
  if (!identity) {
    return {
      canWrite: false,
      ownerType: null,
      allowedVisibilities: [],
      readOnlyReason: 'signed-out',
    };
  }
  if (isLegacyXdSkillhubIdentity(identity)) {
    return {
      canWrite: false,
      ownerType: 'organization',
      allowedVisibilities: [],
      readOnlyReason: 'legacy-xd',
    };
  }
  if (identity.membershipKind === 'org') {
    return {
      canWrite: true,
      ownerType: 'organization',
      allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'],
      readOnlyReason: null,
    };
  }
  return {
    canWrite: true,
    ownerType: 'personal',
    allowedVisibilities: ['PUBLIC', 'PRIVATE'],
    readOnlyReason: null,
  };
}

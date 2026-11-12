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
  readOnlyReason: 'signed-out' | null;
}

/** UI projection only; authorization and organization-specific policy remain server-owned. */
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

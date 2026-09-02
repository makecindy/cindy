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
  readOnlyReason: 'organization-catalog-read-only' | 'organization-routing-unavailable' | 'signed-out' | null;
}

export interface SkillhubServerCapabilities {
  canWrite: boolean;
  ownerType: 'personal' | 'organization' | null;
  allowedVisibilities: Array<'private' | 'shared' | 'public'>;
  readOnlyReason: SkillhubIdentityPolicy['readOnlyReason'];
}

/** Local projection used until the server capability response arrives. */
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

/** Converts the server-owned policy into the existing UI visibility vocabulary. */
export function skillhubIdentityPolicyFromServer(
  capabilities: SkillhubServerCapabilities,
): SkillhubIdentityPolicy {
  return {
    canWrite: capabilities.canWrite,
    ownerType: capabilities.ownerType,
    allowedVisibilities: capabilities.allowedVisibilities.map((visibility) => (
      visibility === 'shared' ? 'DEPARTMENT_SCOPED' : visibility.toUpperCase()
    )) as SkillhubPublishVisibility[],
    readOnlyReason: capabilities.readOnlyReason,
  };
}

import { describe, expect, it } from 'vitest';

import {
  deriveSkillhubIdentityPolicy,
  skillhubIdentityPolicyFromServer,
} from '../skillhubIdentityPolicy';

describe('skillhub identity policy', () => {
  it('keeps personal publishing personal and excludes shared visibility', () => {
    expect(deriveSkillhubIdentityPolicy({ membershipKind: 'personal', orgSlug: null }))
      .toMatchObject({
        canWrite: true,
        ownerType: 'personal',
        allowedVisibilities: ['PUBLIC', 'PRIVATE'],
      });
  });

  it('fixes organization ownership and excludes private visibility', () => {
    expect(deriveSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'acme' }))
      .toMatchObject({
        canWrite: true,
        ownerType: 'organization',
        allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'],
      });
  });

  it('does not infer backing catalog behavior from an organization slug', () => {
    expect(deriveSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'example-org' }))
      .toEqual(deriveSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'another-org' }));
  });

  it('uses the generic server capability response as the write-policy authority', () => {
    expect(skillhubIdentityPolicyFromServer({
      canWrite: false,
      ownerType: 'organization',
      allowedVisibilities: [],
      readOnlyReason: 'organization-catalog-read-only',
    })).toEqual({
      canWrite: false,
      ownerType: 'organization',
      allowedVisibilities: [],
      readOnlyReason: 'organization-catalog-read-only',
    });
  });
});

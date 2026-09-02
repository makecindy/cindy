import { describe, expect, it } from 'vitest';

import {
  deriveSkillhubIdentityPolicy,
  isLegacyXdSkillhubIdentity,
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

  it('marks XD organization identities read-only without affecting personal users', () => {
    expect(isLegacyXdSkillhubIdentity({ membershipKind: 'org', orgSlug: 'xd' })).toBe(true);
    expect(isLegacyXdSkillhubIdentity({ membershipKind: 'personal', orgSlug: 'xd' })).toBe(false);
    expect(deriveSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'xd' }))
      .toMatchObject({ canWrite: false, readOnlyReason: 'legacy-xd' });
  });
});

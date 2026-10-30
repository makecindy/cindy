import { useMemo } from 'react';

import { deriveSkillhubIdentityPolicy, type SkillhubIdentity, type SkillhubIdentityPolicy } from '../../../../shared/skillhubIdentityPolicy';

/**
 * This only projects signed-in identity into generic UI choices. The server
 * remains authoritative for ownership, routing, and organization write policy.
 */
export function useSkillhubIdentityPolicy(
  identity: SkillhubIdentity | null | undefined,
): SkillhubIdentityPolicy {
  return useMemo(
    () => deriveSkillhubIdentityPolicy(identity),
    [identity?.membershipKind, identity?.orgSlug],
  );
}

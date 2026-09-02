import { useEffect, useMemo, useState } from 'react';

import {
  deriveSkillhubIdentityPolicy,
  skillhubIdentityPolicyFromServer,
  type SkillhubIdentity,
  type SkillhubIdentityPolicy,
} from '../../../../shared/skillhubIdentityPolicy';

/**
 * The server owns catalog routing and write policy. The renderer only consumes
 * the generic capability result and never infers a backing Skill Hub source.
 */
export function useSkillhubIdentityPolicy(
  identity: SkillhubIdentity | null | undefined,
): SkillhubIdentityPolicy {
  const localPolicy = useMemo(
    () => deriveSkillhubIdentityPolicy(identity),
    [identity?.membershipKind, identity?.orgSlug],
  );
  const pendingPolicy = useMemo(
    () => identity?.membershipKind === 'org'
      ? { ...localPolicy, canWrite: false, allowedVisibilities: [] }
      : localPolicy,
    [identity?.membershipKind, localPolicy],
  );
  const [policy, setPolicy] = useState<SkillhubIdentityPolicy>(pendingPolicy);

  useEffect(() => {
    let cancelled = false;
    setPolicy(pendingPolicy);

    const loadCapabilities = window.electronAPI?.skillhub?.capabilities;
    if (typeof loadCapabilities !== 'function') return undefined;

    void loadCapabilities().then((result) => {
      if (cancelled) return;
      if (result.success && result.capabilities) {
        setPolicy(skillhubIdentityPolicyFromServer(result.capabilities));
      } else {
        setPolicy(pendingPolicy);
      }
    }).catch(() => {
      if (!cancelled) {
        setPolicy(pendingPolicy);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [pendingPolicy]);

  return policy;
}

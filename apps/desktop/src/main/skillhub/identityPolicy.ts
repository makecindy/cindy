import {
  deriveSkillhubIdentityPolicy,
  skillhubIdentityPolicyFromServer,
  type SkillhubServerCapabilities,
} from '../../shared/skillhubIdentityPolicy';
import { getAuthState } from '../authManager';
import { ServerApiError } from '../serverApiClient';
import type { SkillhubPublishVisibility } from '../../shared/skillhubIdentityPolicy';
import { skillhubApiFetch } from './hubApi';

export async function currentSkillhubIdentityPolicy() {
  const fallback = deriveSkillhubIdentityPolicy(getAuthState().user);
  try {
    const capabilities = await skillhubApiFetch<SkillhubServerCapabilities>(
      '/api/skills-hub/capabilities',
    );
    return skillhubIdentityPolicyFromServer(capabilities);
  } catch {
    return { ...fallback, canWrite: false, allowedVisibilities: [] };
  }
}

function skillhubWritePolicyError(
  policy: Awaited<ReturnType<typeof currentSkillhubIdentityPolicy>>,
): ServerApiError {
  if (policy.readOnlyReason === 'organization-catalog-read-only') {
    return new ServerApiError(
      'SKILL_HUB_READ_ONLY',
      403,
      'Organization Skill Hub access is read-only',
    );
  }
  if (policy.readOnlyReason === 'signed-out') {
    return new ServerApiError('UNAUTHORIZED', 401, 'Skill Hub write access requires sign-in');
  }
  return new ServerApiError('SKILL_HUB_UNAVAILABLE', 503, 'Skill Hub write policy is unavailable');
}

export async function assertSkillhubWriteAllowed(): Promise<void> {
  const policy = await currentSkillhubIdentityPolicy();
  if (policy.canWrite) return;
  throw skillhubWritePolicyError(policy);
}

export async function assertSkillhubVisibilityAllowed(
  visibility: 'private' | 'shared' | 'public',
): Promise<void> {
  const policy = await currentSkillhubIdentityPolicy();
  if (!policy.canWrite) throw skillhubWritePolicyError(policy);
  const clientVisibility: SkillhubPublishVisibility = visibility === 'shared'
    ? 'DEPARTMENT_SCOPED'
    : visibility.toUpperCase() as SkillhubPublishVisibility;
  if (policy.allowedVisibilities.includes(clientVisibility)) return;
  throw new ServerApiError(
    'INVALID_VISIBILITY',
    400,
    policy.ownerType === 'organization'
      ? 'Organization skills only support public or organization visibility'
      : 'Personal skills only support public or private visibility',
  );
}

import { deriveSkillhubIdentityPolicy } from '../../shared/skillhubIdentityPolicy';
import { getAuthState } from '../authManager';
import { ServerApiError } from '../serverApiClient';
import type { SkillhubPublishVisibility } from '../../shared/skillhubIdentityPolicy';

export function currentSkillhubIdentityPolicy() {
  return deriveSkillhubIdentityPolicy(getAuthState().user);
}

function skillhubWritePolicyError(): ServerApiError {
  return new ServerApiError('UNAUTHORIZED', 401, 'Skill Hub write access requires sign-in');
}

export function assertSkillhubWriteAllowed(): void {
  const policy = currentSkillhubIdentityPolicy();
  if (policy.canWrite) return;
  throw skillhubWritePolicyError();
}

export function assertSkillhubVisibilityAllowed(
  visibility: 'private' | 'shared' | 'public',
): void {
  const policy = currentSkillhubIdentityPolicy();
  if (!policy.canWrite) throw skillhubWritePolicyError();
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

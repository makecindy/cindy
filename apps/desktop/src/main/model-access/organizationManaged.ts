import { isXdOrgUser, type XdOrgBetaUser } from '../xdOrgBetaDefault.js';

/** Client BYOK is scoped to signed-in external organizations with a stable organization id. */
export function isExternalOrganizationByokUser(
  user: (XdOrgBetaUser & { orgId: string | null }) | null | undefined,
): user is XdOrgBetaUser & { orgId: string } {
  return Boolean(
    user?.membershipKind === 'org' &&
    typeof user.orgId === 'string' &&
    user.orgId.trim().length > 0 &&
    !isXdOrgUser(user),
  );
}

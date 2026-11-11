/** Stable identity check for the XD organization membership. */

export const XD_ORG_SLUG = 'xd';

const XD_ORG_NAME_FALLBACKS = new Set(['xd', '心动网络']);

export interface XdOrgIdentity {
  membershipKind: 'personal' | 'org';
  orgSlug: string | null;
  orgName: string | null;
}

/**
 * The slug is authoritative. The display-name fallback only supports older
 * access tokens that predate the orgSlug claim.
 */
export function isXdOrgUser(user: XdOrgIdentity | null | undefined): boolean {
  if (!user || user.membershipKind !== 'org') return false;
  if (user.orgSlug !== null) return user.orgSlug === XD_ORG_SLUG;
  const name = user.orgName?.trim().toLocaleLowerCase();
  return name !== undefined && XD_ORG_NAME_FALLBACKS.has(name);
}

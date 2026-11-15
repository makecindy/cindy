import { isXdOrgUser, type XdOrgIdentity } from './xdOrg.js';

/** Temporary XD exception; organization avatars are not model icons. */
export function cindyAiAccountLogoKind(user: XdOrgIdentity | null | undefined): 'xd' | 'cindy' {
  return isXdOrgUser(user) ? 'xd' : 'cindy';
}

/** Presentation only: membership determines the name, never the gateway backend. */
export function cindyAiAccountName(
  user: XdOrgIdentity | null | undefined,
  t: (key: string) => string,
): string {
  const brand = t('settings.providers.xd.title');
  if (!user) return brand;
  if (user.membershipKind === 'personal') {
    return `${brand} · ${t('settings.providers.xd.personal')}`;
  }
  const organization = isXdOrgUser(user)
    ? t('settings.providers.xd.xdOrganization')
    : user.orgName?.trim() || user.orgSlug?.trim() || t('settings.providers.xd.organization');
  return `${brand} · ${organization}`;
}

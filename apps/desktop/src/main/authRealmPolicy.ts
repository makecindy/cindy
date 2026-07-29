import type { AuthMembership, AuthRegion } from '@cindy/auth-client';

/**
 * Organization sessions may follow their server-side realm, while personal
 * accounts remain scoped to the installed build region.
 */
export function canRestoreAuthSessionForMembership(
  buildRegion: AuthRegion,
  sessionRealm: AuthRegion,
  membershipKind: AuthMembership['kind'],
): boolean {
  return membershipKind === 'org' || sessionRealm === buildRegion;
}

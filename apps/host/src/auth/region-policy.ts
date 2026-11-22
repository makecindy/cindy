/**
 * Cross-region sign-in rule for the Host, the same as the Desktop's (user decision 2026-11-17,
 * release table: “和桌面版一致”). A personal account signs in only to a package of its own
 * region; an organization account may sign in across regions. The rule is the Desktop's own
 * function (`authRealmPolicy.ts`), applied to the package region, the session realm and the
 * account kind, at `cindy-host login` (H-1) and whenever the Host adopts a stored session (H-2).
 */
import { canRestoreAuthSessionForMembership } from '../../../desktop/src/main/authRealmPolicy.ts';
import { resolveHostRegion } from '../profile-path.mjs';

export type HostRegion = 'cn' | 'global';

/**
 * The region of this Host package: the region unit's edition (release table 甲 20). A release answers
 * the region it was built for (`release.json`, `scripts/build.mjs --region`), and refuses a
 * `CINDY_HOST_REGION` naming the other edition; from source it is `CINDY_HOST_REGION`, global when
 * unset (development only). The one place the sign-in rule reads it.
 */
export function hostPackageRegion(): HostRegion {
  return resolveHostRegion() as HostRegion;
}

/** A personal session from another region: refused, never adopted. Carries regions, no ids. */
export class HostCrossRegionPersonalAccountError extends Error {
  readonly code = 'HOST_CROSS_REGION_PERSONAL_ACCOUNT';
  constructor(readonly sessionRealm: string, readonly packageRegion: HostRegion) {
    super(`This personal account belongs to the "${sessionRealm}" region, and this Cindy Host is for the `
      + `"${packageRegion}" region. Personal accounts sign in only to a Host of their own region; `
      + 'organization accounts can sign in across regions.');
    this.name = 'HostCrossRegionPersonalAccountError';
  }
}

/** Throws unless the Desktop's rule admits this session on this package. */
export function assertHostSessionRegion(input: {
  packageRegion: HostRegion;
  sessionRealm: HostRegion;
  membershipKind: unknown;
}): void {
  const kind = input.membershipKind === 'org' ? 'org' : 'personal';
  if (!canRestoreAuthSessionForMembership(input.packageRegion, input.sessionRealm, kind)) {
    throw new HostCrossRegionPersonalAccountError(input.sessionRealm, input.packageRegion);
  }
}

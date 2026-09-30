import type { CindyVersionsState } from '../../../shared/cindyVersions';
import { isXdOrgUser, type XdOrgIdentity } from '../../../shared/xdOrg';

export function canAccessCindyMakeSettings(
  isDevelopmentBuild: boolean,
  versions?: CindyVersionsState,
  isBetaBuild = false,
  user?: XdOrgIdentity | null,
): boolean {
  // Main resolves the current executable identity. A missing/corrupt catalog entry
  // must not hide the escape route back to the original application.
  if (isDevelopmentBuild || (!!versions?.currentId && versions.currentId !== 'original')) {
    return true;
  }
  // Only a running packaged beta exposes Cindy Make to the XD organization.
  // Do not use the device's selected-channel preference here: it can be
  // written before the release process restarts into the beta build.
  return isBetaBuild && isXdOrgUser(user);
}

import type { CindyVersionsState } from '../../../shared/cindyVersions';
import { isXdOrgUser, type XdOrgIdentity } from '../../../shared/xdOrg';
import { CINDY_MAKE_ENABLED } from '@cindy/maker-shared/cindy-make-feature';

export function canAccessCindyMakeSettings(
  isDevelopmentBuild: boolean,
  versions?: CindyVersionsState,
  isBetaBuild = false,
  user?: XdOrgIdentity | null,
): boolean {
  if (!CINDY_MAKE_ENABLED) return false;
  if (isDevelopmentBuild || (!!versions?.currentId && versions.currentId !== 'original')) {
    return true;
  }
  return isBetaBuild && isXdOrgUser(user);
}

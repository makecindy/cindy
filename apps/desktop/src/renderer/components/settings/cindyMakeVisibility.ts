import type { CindyVersionsState } from '../../../shared/cindyVersions';

export function canAccessCindyMakeSettings(
  isDevelopmentBuild: boolean,
  versions?: CindyVersionsState,
): boolean {
  // Main resolves the current executable identity. A missing/corrupt catalog entry
  // must not hide the escape route back to the original application.
  return isDevelopmentBuild || (!!versions?.currentId && versions.currentId !== 'original');
}

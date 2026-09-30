import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';

/** Both build surfaces name the same live stage, including preparation and check details. */
export function cindyMakeBuildStatusKey(
  build: CindyMakePersonalBuildState,
  stopping = build.stopping,
): string {
  if (stopping) return 'cindyMake.history.stopping';
  if (build.status === 'merging' && build.mergeStep)
    return 'cindyMake.personal.mergeStep.' + build.mergeStep;
  if (build.status === 'waiting' && build.preparationStep)
    return 'cindyMake.personal.preparationStep.' + build.preparationStep;
  if (build.status === 'checking' && build.checkStep)
    return 'cindyMake.personal.checkStep.' + build.checkStep;
  return 'cindyMake.personal.status.' + build.status;
}

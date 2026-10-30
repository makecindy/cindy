import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { throwIpcError } from '../utils/ipcValidate.js';

export function assertCindyMakeEnabled(): void {
  if (!CINDY_MAKE_ENABLED) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make is currently unavailable');
  }
}

/** Check persisted purpose, including historical upstream-merge tasks. */
export function assertCindyMakeSessionAvailable(source: string | null | undefined): void {
  if (isCindyMakeSource(source)) assertCindyMakeEnabled();
}

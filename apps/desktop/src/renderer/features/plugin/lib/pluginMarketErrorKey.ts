import { extractIpcError } from '@/utils/ipcError';

/** Stable Plugin Market IPC error codes → localized renderer copy keys. */
export function pluginMarketErrorKey(error: unknown): string {
  switch (extractIpcError(error)?.code) {
    case 'INVALID_PARAMS':
      return 'settings.ghosts.market.errors.invalidRequest';
    case 'NOT_FOUND':
      return 'settings.ghosts.market.errors.notFound';
    case 'ALREADY_EXISTS':
      return 'settings.ghosts.market.errors.conflict';
    case 'PRECONDITION_FAILED':
      return 'settings.ghosts.market.errors.stateChanged';
    case 'PERMISSION_DENIED':
      return 'settings.ghosts.market.errors.accessDenied';
    case 'UNSUPPORTED_CAPABILITY':
      return 'settings.ghosts.market.errors.notConfigured';
    case 'GHOST_FILE_INVALID':
      return 'settings.ghosts.market.errors.invalidPackage';
    default:
      return 'settings.ghosts.market.errors.generic';
  }
}

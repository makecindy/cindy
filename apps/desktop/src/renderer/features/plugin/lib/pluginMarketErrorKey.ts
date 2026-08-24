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
    case 'GHOST_ID_RESERVED':
      return 'settings.ghosts.errors.idReserved';
    case 'GHOST_BROKER_REDIRECT_PORT_REQUIRED':
      return 'settings.ghosts.market.errors.brokerRedirectPortRequired';
    default:
      return 'settings.ghosts.market.errors.generic';
  }
}

/** 自定义市场源管理（添加 / 刷新 / 移除）的 IPC 错误码 → 本地化文案 key。 */
export function marketplaceSourceErrorKey(error: unknown): string {
  switch (extractIpcError(error)?.code) {
    case 'MARKET_SOURCE_INVALID':
      // addSource 把 parse 的子码放进 detail 透传；内嵌凭证有独立引导文案。
      if (extractIpcError(error)?.message === 'CREDENTIALS_NOT_ALLOWED') {
        return 'settings.ghosts.market.sources.errors.credentialsNotAllowed';
      }
      return 'settings.ghosts.market.sources.errors.invalidSource';
    case 'MARKET_GIT_UNAVAILABLE':
      return 'settings.ghosts.market.sources.errors.gitUnavailable';
    case 'MARKET_CLONE_AUTH_FAILED':
      return 'settings.ghosts.market.sources.errors.cloneAuthFailed';
    case 'MARKET_CLONE_FAILED':
      return 'settings.ghosts.market.sources.errors.cloneFailed';
    case 'MARKET_REF_NOT_FOUND':
      return 'settings.ghosts.market.sources.errors.refNotFound';
    case 'MARKET_MANIFEST_MISSING':
      return 'settings.ghosts.market.sources.errors.manifestMissing';
    case 'ALREADY_EXISTS':
      return 'settings.ghosts.market.sources.errors.duplicate';
    case 'NOT_FOUND':
      return 'settings.ghosts.market.sources.errors.notFound';
    default:
      return pluginMarketErrorKey(error);
  }
}

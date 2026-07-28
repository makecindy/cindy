import type { GhostSetupErrorCode } from '../../shared/ghost.js';
import type { GhostOauthConnectResult } from './ghostOauthAccounts.js';

type GhostOauthConnectError = Exclude<GhostOauthConnectResult, { ok: true }>['error'];

/**
 * 把 Main 内部 OAuth 失败分类收窄成可跨进程传输的稳定 UI 错误码。
 * 不传 detail：服务端响应、路径和登录诊断只留在 Main 日志，Renderer 只拿
 * 可本地化且可操作的错误类别。
 */
export function mapGhostOauthConnectError(error: GhostOauthConnectError): GhostSetupErrorCode {
  switch (error) {
    case 'CANCELLED':
      return 'AUTH_CANCELLED';
    case 'NETWORK':
      return 'AUTH_NETWORK';
    case 'SERVICE_UNAVAILABLE':
      return 'AUTH_SERVICE_UNAVAILABLE';
    default:
      return 'AUTH_FAILED';
  }
}

import type { IpcErrorCode } from '../../shared/ipc-errors.js';

export interface GhostTokenBrokerInstallError {
  code: Extract<
    IpcErrorCode,
    'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED'
  >;
  reason: string;
}

/** Copy classification only; authorization remains owned by the caller. */
export function ghostTokenBrokerInstallError(): GhostTokenBrokerInstallError {
  return {
    code: 'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
    reason: '本地装入的 .cindy 不能使用授权 broker；请改从组织插件市场安装',
  };
}

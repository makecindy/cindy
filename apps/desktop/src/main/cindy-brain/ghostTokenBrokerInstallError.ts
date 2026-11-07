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
    reason:
      '本地开发副本 local 与手动装入的 .cindy 不能使用企业授权 broker；请改从组织插件市场安装，或由企业作者使用 ghost_forge_install 显式传入 namespace: "<当前组织>" 安装自测',
  };
}

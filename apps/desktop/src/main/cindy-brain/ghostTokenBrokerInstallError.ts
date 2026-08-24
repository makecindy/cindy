import type { IpcErrorCode } from '../../shared/ipc-errors.js';

export interface GhostTokenBrokerInstallError {
  code: Extract<
    IpcErrorCode,
    'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED' | 'GHOST_BROKER_NOT_AUTHORIZED'
  >;
  reason: string;
}

/** Copy classification only; authorization remains owned by the caller. */
export function ghostTokenBrokerInstallError(
  installOrigin?: 'manual' | 'agent-forge',
): GhostTokenBrokerInstallError {
  return installOrigin === 'manual'
    ? {
        code: 'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
        reason:
          '手动装入的 .cindy 不能使用授权 broker；请改从组织插件市场安装，或让插件作者在组织身份下使用 ghost_forge_pack 构建',
      }
    : {
        code: 'GHOST_BROKER_NOT_AUTHORIZED',
        reason: '当前安装来源或组织身份无权使用授权 broker',
      };
}

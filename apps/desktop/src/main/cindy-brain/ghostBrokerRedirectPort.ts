import type { GhostManifest } from '../../shared/ghost.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';

export const BROKER_REDIRECT_PORT_REQUIRED_REASON =
  '声明 oauth.tokenBroker 时必须在同一项 oauth 中声明 redirectPort，确保授权最后一跳能回到本机监听端口';

/**
 * 新包准入检查：broker 的最终回跳必须有清单声明的本机监听端口。
 *
 * 不要把它并回 validateGhostManifest。后者还承担批准 receipt 与已装目录的
 * 兼容读取；旧包缺少该字段时仍须可读，只在新包进入 Forge / 安装通道时拒绝。
 */
export function brokerRedirectPortDeclarationIssue(manifest: GhostManifest): string | null {
  const missing = (manifest.network?.secrets ?? []).some(
    (secret) => secret.oauth?.tokenBroker !== undefined && secret.oauth.redirectPort === undefined,
  );
  return missing ? BROKER_REDIRECT_PORT_REQUIRED_REASON : null;
}

export interface GhostBrokerRedirectPortInstallError {
  code: Extract<IpcErrorCode, 'GHOST_BROKER_REDIRECT_PORT_REQUIRED'>;
  reason: string;
}

/** IPC 装入通道的结构化错误；Renderer 只按 code 选择本地化文案。 */
export function ghostBrokerRedirectPortInstallError(
  manifest: GhostManifest,
): GhostBrokerRedirectPortInstallError | null {
  const reason = brokerRedirectPortDeclarationIssue(manifest);
  return reason ? { code: 'GHOST_BROKER_REDIRECT_PORT_REQUIRED', reason } : null;
}

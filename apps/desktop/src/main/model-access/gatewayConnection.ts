import { getAppCapabilities } from '../appCapabilities.js';
import { effectiveXdGatewayBaseUrl } from './effectiveEndpoint.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { reportCindyGatewayKeyRejected } from './gatewayKeyRejection.js';
export class GatewayConnectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function resolveGatewayConnection(providerId: string) {
  if (providerId !== 'xd') {
    throw new GatewayConnectionError(
      'CONNECTION_NOT_SUPPORTED',
      `当前 Cindy 版本没有注册媒体连接 ${JSON.stringify(providerId)}`,
    );
  }
  if (!getAppCapabilities().canUseCindyGateway) {
    throw new GatewayConnectionError('CONNECTION_UNAVAILABLE', '当前账号不能使用 Cindy AI 网关');
  }
  const baseUrl = effectiveXdGatewayBaseUrl().trim();
  const apiKey = getProviderSecretStore().get('xd')?.trim() ?? '';
  if (!baseUrl || !apiKey) {
    throw new GatewayConnectionError('CONNECTION_UNAVAILABLE', 'Cindy AI 连接尚未就绪，请先完成登录');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new GatewayConnectionError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new GatewayConnectionError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  return { baseUrl, apiKey, onUnauthorized: () => reportCindyGatewayKeyRejected(apiKey) };
}

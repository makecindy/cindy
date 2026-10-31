/**
 * device-link 中转的 REST 入口:按当前选择发往 Cindy 官方中转或自建中转。
 *
 * - 官方中转:原样走 serverApiFetch(Bearer 账号 token、401 刷新)。
 * - 自建中转:`Authorization: CindyRelay <设备凭证>`,绝不携带账号 token;跳过刷新与会话失效,
 *   自建中转的 401 只表示中转凭证失效,不能把 Cindy 账号登出。
 */
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';

/** 当前中转的 REST 基础地址(WebSocket 地址由它推出)。 */
export function resolveDeviceLinkApiBase(): string {
  return activeSelfHostedRelay()?.baseUrl ?? officialDeviceLinkApiBase();
}

/** 官方中转的 REST 基础地址:跨账号连接不随中转选择切换。 */
export function officialDeviceLinkApiBase(): string {
  return getClientEndpoint('deviceLinkApiBaseUrl');
}

/** 官方服务的 REST 入口。共享任务附件只存在于官方存储,不随中转选择切换。 */
export function officialDeviceLinkApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl' | 'token' | 'authorization'> = {},
): Promise<T> {
  return serverApiFetch<T>(apiPath, {
    ...opts,
    // 401 重试可随账号区域更新官方端点，不能随中转选择跨到自建地址。
    baseUrl: () => getClientEndpoint('deviceLinkApiBaseUrl'),
  });
}

export function deviceLinkApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl' | 'token' | 'authorization'> = {},
): Promise<T> {
  const relay = activeSelfHostedRelay();
  if (!relay) return officialDeviceLinkApiFetch<T>(apiPath, opts);
  return serverApiFetch<T>(apiPath, {
    ...opts,
    baseUrl: relay.baseUrl,
    authorization: `CindyRelay ${relay.credential}`,
    skipAutoRefresh: true,
    skipSessionInvalidation: true,
  });
}

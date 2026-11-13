/**
 * device-link 中转的 REST 入口:按当前选择发往 Cindy 官方中转或自建中转。
 *
 * - 官方中转:原样走 serverApiFetch(Bearer 账号 token、401 刷新)。
 * - 自建中转:`Authorization: CindyRelay <设备凭证>`,绝不携带账号 token;跳过刷新与会话失效,
 *   自建中转的 401 只表示中转凭证失效,不能把 Cindy 账号登出。
 * - 只走 V2 的网络(别人分享的中转,§5.5):设备目录、改名、移除走 V2 的签名请求;没有旧版 REST。
 */
import type { ApiFetchOptions } from '../serverApiClient.js';
import { isAgentNetOnlyRelay, type ActiveSelfHostedRelay } from './selfHostedRelayRouting.js';

export interface DeviceLinkApiPorts {
  getClientEndpoint(key: 'deviceLinkApiBaseUrl'): string;
  serverApiFetch: ReturnType<typeof import('../serverApiClient.js').createServerApiClient>;
  activeSelfHostedRelay(): ActiveSelfHostedRelay | null;
  readCurrentDeviceDirectory: typeof import('./agentNetDeviceDirectory.js').readCurrentDeviceDirectory;
  legacyDeviceView: typeof import('./agentNetDeviceDirectory.js').projectAgentNetDevice;
  // Keep preparation as an await boundary; route/owner checks must run after it.
  prepareAgentNetRuntime(): Promise<Pick<typeof import('./agentNetRuntime.js'), 'agentNetClientForRelay'>>;
  prepareOwnerScope(): Promise<Pick<typeof import('../appSessionState.js'), 'activeOwnerScopeKey' | 'isAppSessionBoundaryPending'>>;
  prepareRelayConfig(): Promise<Pick<typeof import('./selfHostedRelayConfig.js'), 'readRelaySecrets'>>;
}

/** Shared routing and credential contract; each launcher supplies its live scope. */
export function createDeviceLinkApi(ports: DeviceLinkApiPorts) {
const { getClientEndpoint, serverApiFetch, activeSelfHostedRelay, readCurrentDeviceDirectory, legacyDeviceView } = ports;

async function agentNetOnlyFetch<T>(relay: ActiveSelfHostedRelay, apiPath: string, method: string, body: unknown, assertRoute: () => void): Promise<T> {
  const { agentNetClientForRelay } = await ports.prepareAgentNetRuntime();
  const { activeOwnerScopeKey, isAppSessionBoundaryPending } = await ports.prepareOwnerScope();
  assertRoute();
  const scope = activeOwnerScopeKey();
  const assertCurrent = () => { assertRoute(); if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('DEVICE_LINK_SCOPE_CHANGED'); };
  const api = agentNetClientForRelay(relay.relayId, relay.baseUrl);
  if (api.rootPublicKey !== relay.ownerPublicKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  if (apiPath === '/api/device-link/devices' && method === 'GET') {
    const directory = await api.directory();
    assertCurrent();
    return { devices: directory.map((device) => legacyDeviceView(device, relay.deviceId)) } as T;
  }
  const device = /^\/api\/device-link\/devices\/([^/?#]+)$/.exec(apiPath);
  if (device && (method === 'PATCH' || method === 'DELETE')) {
    const result = await api.request(method, '/devices/' + device[1], method === 'PATCH' ? body : undefined);
    assertCurrent();
    return result as T;
  }
  // 其余旧版接口(媒体签名地址、ICE 等)在这里没有;调用方按不可用处理,V2 有自己的媒体通道。
  throw new Error('DEVICE_LINK_API_UNAVAILABLE_ON_AGENT_NET');
}

/** 当前中转的 REST 基础地址(WebSocket 地址由它推出)。 */
function resolveDeviceLinkApiBase(): string {
  return activeSelfHostedRelay()?.baseUrl ?? officialDeviceLinkApiBase();
}

/** 官方中转的 REST 基础地址:跨账号连接不随中转选择切换。 */
function officialDeviceLinkApiBase(): string {
  return getClientEndpoint('deviceLinkApiBaseUrl');
}

/** 官方服务的 REST 入口。共享任务附件只存在于官方存储,不随中转选择切换。 */
function officialDeviceLinkApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl' | 'token' | 'authorization'> = {},
): Promise<T> {
  return serverApiFetch<T>(apiPath, {
    ...opts,
    // 401 重试可随账号区域更新官方端点，不能随中转选择跨到自建地址。
    baseUrl: () => getClientEndpoint('deviceLinkApiBaseUrl'),
  });
}

async function deviceLinkApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl' | 'token' | 'authorization'> = {},
): Promise<T> {
  const relay = activeSelfHostedRelay();
  if (!relay) {
    if (apiPath === '/api/device-link/devices' && (opts.method ?? 'GET') === 'GET') {
      const base = officialDeviceLinkApiBase();
      return readCurrentDeviceDirectory(() => officialDeviceLinkApiFetch(apiPath, opts), () => {
        if (activeSelfHostedRelay() || officialDeviceLinkApiBase() !== base) throw new Error('DEVICE_LINK_SCOPE_CHANGED');
      }) as Promise<T>;
    }
    return officialDeviceLinkApiFetch<T>(apiPath, opts);
  }
  const routeKey = (value: typeof relay | null) => value && JSON.stringify([value.relayId, value.baseUrl, value.deviceId, value.credential, value.scopeKey]);
  const selected = routeKey(relay);
  const assertRoute = () => { if (selected !== routeKey(activeSelfHostedRelay())) throw new Error('DEVICE_LINK_SCOPE_CHANGED'); };
  if (isAgentNetOnlyRelay(relay)) return agentNetOnlyFetch<T>(relay, apiPath, opts.method ?? 'GET', opts.body, assertRoute);
  if (apiPath === '/api/device-link/devices' && (opts.method ?? 'GET') === 'GET') {
    return readCurrentDeviceDirectory(() => serverApiFetch(apiPath, {
      ...opts, baseUrl: relay.baseUrl, authorization: `CindyRelay ${relay.credential}`,
      skipAutoRefresh: true, skipSessionInvalidation: true,
    }), assertRoute) as Promise<T>;
  }
  const device = /^\/api\/device-link\/devices\/([^/?#]+)$/.exec(apiPath);
  if (device && ['DELETE', 'PATCH'].includes(opts.method ?? 'GET')) {
    const { readRelaySecrets } = await ports.prepareRelayConfig();
    assertRoute();
    if (readRelaySecrets(relay.relayId)?.agentNet) {
    const { agentNetClientForRelay } = await ports.prepareAgentNetRuntime();
    const { activeOwnerScopeKey, isAppSessionBoundaryPending } = await ports.prepareOwnerScope();
    assertRoute();
    const scope = activeOwnerScopeKey();
    const assertCurrent = () => { assertRoute(); if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('DEVICE_LINK_SCOPE_CHANGED'); };
    assertCurrent();
    const api = agentNetClientForRelay(relay.relayId, relay.baseUrl);
    if (api.rootPublicKey !== relay.ownerPublicKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
    const target = decodeURIComponent(device[1]);
    const directory = await api.directory();
    assertCurrent();
    if (directory.some((d) => d.certificate.deviceId === target)) {
      await api.request(opts.method!, '/devices/' + encodeURIComponent(target), opts.method === 'PATCH' ? opts.body : undefined);
      assertCurrent();
    }
    }
  }
  assertRoute();
  return serverApiFetch<T>(apiPath, {
    ...opts,
    baseUrl: relay.baseUrl,
    authorization: `CindyRelay ${relay.credential}`,
    skipAutoRefresh: true,
    skipSessionInvalidation: true,
  });
}

return { resolveDeviceLinkApiBase, officialDeviceLinkApiBase, officialDeviceLinkApiFetch, deviceLinkApiFetch };
}

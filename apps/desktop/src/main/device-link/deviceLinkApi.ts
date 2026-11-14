/**
 * device-link 中转的 REST 入口:按当前选择发往 Cindy 官方中转或自建中转。
 *
 * - 官方中转:原样走 serverApiFetch(Bearer 账号 token、401 刷新)。
 * - 自建中转:`Authorization: CindyRelay <设备凭证>`,绝不携带账号 token;跳过刷新与会话失效,
 *   自建中转的 401 只表示中转凭证失效,不能把 Cindy 账号登出。
 * - 只走 V2 的网络(别人分享的中转,§5.5):设备目录、改名、移除走 V2 的签名请求;没有旧版 REST。
 */
import { ServerApiError, type ApiFetchOptions } from '../serverApiClient.js';
import { isAgentNetOnlyRelay, type ActiveSelfHostedRelay } from './selfHostedRelayRouting.js';
import {
  currentDirectoryThrottleOwner,
  directoryRetryDeadline,
  recordDirectoryRetryDeadline,
} from './directoryThrottle.js';

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

async function agentNetOnlyFetch<T>(relay: ActiveSelfHostedRelay, apiPath: string, method: string, body: unknown, assertRoute: () => void, signal?: AbortSignal): Promise<T> {
  const { agentNetClientForRelay } = await ports.prepareAgentNetRuntime();
  const { activeOwnerScopeKey, isAppSessionBoundaryPending } = await ports.prepareOwnerScope();
  assertRoute();
  const scope = activeOwnerScopeKey();
  const assertCurrent = () => { assertRoute(); if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('DEVICE_LINK_SCOPE_CHANGED'); };
  const api = agentNetClientForRelay(relay.relayId, relay.baseUrl);
  if (api.rootPublicKey !== relay.ownerPublicKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  if (apiPath === '/api/device-link/devices' && method === 'GET') {
    const directory = await api.directory(signal);
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

/**
 * 设备目录端点。它的限流(429)期限由 `directoryThrottle` 统一记账,读 `/devices` 的
 * 每一条路径在发请求前都先看账本:限流窗口内**不发物理读**,直接回一个带期限的 429;
 * 并且**每一跳**(含 401 刷新把请求换到另一个端点之后的重试)都按那一跳自己的桶再查一次。
 *
 * 这条路径要覆盖所有读 `/devices` 的调用方 —— `handleListDevices`(IPC)、
 * `runControllerDisplayNamesFromDirectory`(relay 上线补展示名)与
 * `remoteLocalAgentModels`(远程模型目录)。只在 IPC 那条路上记账时,另外两条既看不到
 * 冷却也记不下 429,共享的限流窗口照样被推后(Codex review #9360)。
 */
const DEVICE_DIRECTORY_PATH = '/api/device-link/devices';

/**
 * 给一次**旧版 REST 目录读**套上限流闸门。
 *
 * 闸门只管旧版 REST 那一腿:V2(agent-net)有自己的一套协议与限流,不受旧版 REST 的
 * 限流窗口约束 —— 把整条目录读一起拦住会把 V2 的可用性也搭进去。闸门拒绝时给的是
 * 429(暂时性失败),`readCurrentDeviceDirectory` 因此仍能用 V2 的结果兜底。
 *
 * - 窗口内不发物理读:发起这条读的那个端点已经在窗口里就直接回带期限的 429;
 * - 每一跳各查一次:401 之后的共享刷新可能把官方请求换到另一个区域端点,那一跳的桶
 *   可能已在窗口里(Codex review #9360「Recheck cooldown after refresh changes
 *   endpoints」);
 * - 收到的 429 把 `Retry-After` 记进共享账本:谁收到都算数,否则这条路径收到的限流
 *   无人记账,下一次读(可能来自另一个调用方)直接撞进同一个窗口。
 */
function throttledDirectoryRead<T>(
  baseUrl: string,
  read: (extra: { beforeHop: (hopBaseUrl: string) => void }) => Promise<T>,
): Promise<T> {
  const owner = currentDirectoryThrottleOwner();
  /**
   * 某个端点正在限流窗口里就给出该拒的那一次。
   *
   * 按**这一跳发出时的当前账号**查桶,而不是发起这条读时的账号:401 之后的刷新重试会
   * 重新解析 token 与端点,中途换了账号,那一跳带的就是新账号的 token —— 放行等于用新
   * 账号的请求去撞新账号自己还没过期的限流窗口(Codex review #9360)。发起时的 owner
   * 只用于下面的记账(换了账号的结果不属于旧账本)。
   */
  const throttleError = (scope: string): ServerApiError | null => {
    const throttledUntil = directoryRetryDeadline(currentDirectoryThrottleOwner(), scope);
    if (throttledUntil <= Date.now()) return null;
    return new ServerApiError('UNAVAILABLE', 429, '设备目录限流退避中', throttledUntil, scope);
  };
  // 外层先查一次:限流窗口内不发物理读,连请求都不启(每次追问都会让服务端把窗口
  // 重新推后,越问越久)。下面每一跳再按**这一跳真正解析出的**端点各查一次。
  const early = throttleError(baseUrl);
  if (early) return Promise.reject(early);
  return read({
    beforeHop: (hopBaseUrl: string): void => {
      const throttled = throttleError(hopBaseUrl);
      if (throttled) throw throttled;
    },
  }).catch((error: unknown) => {
    // 429 的 Retry-After 记进共享账本:谁收到都算数,否则这条路径收到的限流无人记账,
    // 下一次读(可能来自另一个调用方)直接撞进同一个窗口。
    const retryAt = (error as { retryAt?: unknown } | null | undefined)?.retryAt;
    if (typeof retryAt === 'number' && Number.isFinite(retryAt) && currentDirectoryThrottleOwner() === owner) {
      const servedBaseUrl = (error as { servedBaseUrl?: unknown } | null | undefined)?.servedBaseUrl;
      const scope = typeof servedBaseUrl === 'string' && servedBaseUrl !== '' ? servedBaseUrl : baseUrl;
      recordDirectoryRetryDeadline(owner, scope, retryAt);
    }
    throw error;
  });
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
    if (apiPath === DEVICE_DIRECTORY_PATH && (opts.method ?? 'GET') === 'GET') {
      const base = officialDeviceLinkApiBase();
      return readCurrentDeviceDirectory(
        () => throttledDirectoryRead(base, (extra) => officialDeviceLinkApiFetch(apiPath, { ...opts, ...extra })),
        () => {
          if (activeSelfHostedRelay() || officialDeviceLinkApiBase() !== base) throw new Error('DEVICE_LINK_SCOPE_CHANGED');
        },
        opts.signal,
      ) as Promise<T>;
    }
    return officialDeviceLinkApiFetch<T>(apiPath, opts);
  }
  const routeKey = (value: typeof relay | null) => value && JSON.stringify([value.relayId, value.baseUrl, value.deviceId, value.credential, value.scopeKey]);
  const selected = routeKey(relay);
  const assertRoute = () => { if (selected !== routeKey(activeSelfHostedRelay())) throw new Error('DEVICE_LINK_SCOPE_CHANGED'); };
  if (isAgentNetOnlyRelay(relay)) return agentNetOnlyFetch<T>(relay, apiPath, opts.method ?? 'GET', opts.body, assertRoute, opts.signal);
  if (apiPath === DEVICE_DIRECTORY_PATH && (opts.method ?? 'GET') === 'GET') {
    return readCurrentDeviceDirectory(
      () => throttledDirectoryRead(relay.baseUrl, (extra) => serverApiFetch(apiPath, {
        ...opts, ...extra, baseUrl: relay.baseUrl, authorization: `CindyRelay ${relay.credential}`,
        skipAutoRefresh: true, skipSessionInvalidation: true,
      })),
      assertRoute,
      opts.signal,
    ) as Promise<T>;
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

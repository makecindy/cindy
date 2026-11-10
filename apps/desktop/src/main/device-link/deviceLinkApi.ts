/**
 * device-link 中转的 REST 入口:按当前选择发往 Cindy 官方中转或自建中转。
 *
 * - 官方中转:原样走 serverApiFetch(Bearer 账号 token、401 刷新)。
 * - 自建中转:`Authorization: CindyRelay <设备凭证>`,绝不携带账号 token;跳过刷新与会话失效,
 *   自建中转的 401 只表示中转凭证失效,不能把 Cindy 账号登出。
 */
import { getClientEndpoint } from '../clientEndpointsService.js';
import { ServerApiError, serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';
import {
  currentDirectoryThrottleOwner,
  directoryRetryDeadline,
  recordDirectoryRetryDeadline,
} from './directoryThrottle.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';

/**
 * 设备目录端点。它的限流(429)期限由 `directoryThrottle` 统一记账,`deviceLinkApiFetch`
 * 在发请求前先看账本:限流窗口内**不发物理读**,直接回一个带期限的 429;并且**每一跳**
 * (含 401 刷新把请求换到另一个端点之后的重试)都按那一跳自己的桶再查一次。
 *
 * 这条路径要覆盖所有读 `/devices` 的调用方 —— `handleListDevices`(IPC)、
 * `runControllerDisplayNamesFromDirectory`(relay 上线补展示名)与
 * `remoteLocalAgentModels`(远程模型目录)。只在 IPC 那条路上记账时,另外两条既看不到
 * 冷却也记不下 429,共享的限流窗口照样被推后(Codex review #9360)。
 */
const DEVICE_DIRECTORY_PATH = '/api/device-link/devices';

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
  // 桶的身份 = 请求要发往的地址,与 ipc 侧 `directoryRelayScope()` 同源。
  const baseUrl = relay ? relay.baseUrl : officialDeviceLinkApiBase();
  const owner = currentDirectoryThrottleOwner();
  const isDirectory = apiPath === DEVICE_DIRECTORY_PATH;
  /** 某个端点正在限流窗口里就给出该拒的那一次;账号已换则不拦(旧桶不代表这次读)。 */
  const directoryThrottleError = (hopBaseUrl: string): ServerApiError | null => {
    if (currentDirectoryThrottleOwner() !== owner) return null;
    const throttledUntil = directoryRetryDeadline(owner, hopBaseUrl);
    if (throttledUntil <= Date.now()) return null;
    return new ServerApiError('UNAVAILABLE', 429, '设备目录限流退避中', throttledUntil, hopBaseUrl);
  };
  if (isDirectory) {
    // 外层先查一次:限流窗口内不发物理读,连请求都不启(每次追问都会让服务端把窗口
    // 重新推后,越问越久)。下面的 beforeHop 再按**每一跳真正解析出的**端点各查一次 ——
    // 401 之后的共享刷新可能把官方请求换到另一个区域端点,那一跳的桶可能已在限流窗口里,
    // 只查发起时的桶拦不住它(Codex review #9360「Recheck cooldown after refresh
    // changes endpoints」)。
    const early = directoryThrottleError(baseUrl);
    if (early) return Promise.reject(early);
  }
  const perHop = isDirectory
    ? { beforeHop: (hopBaseUrl: string): void => {
      const throttled = directoryThrottleError(hopBaseUrl);
      if (throttled) throw throttled;
    } }
    : {};
  const pending = relay
    ? serverApiFetch<T>(apiPath, {
      ...opts,
      ...perHop,
      baseUrl: relay.baseUrl,
      authorization: `CindyRelay ${relay.credential}`,
      skipAutoRefresh: true,
      skipSessionInvalidation: true,
    })
    : officialDeviceLinkApiFetch<T>(apiPath, { ...opts, ...perHop });
  if (!isDirectory) return pending;
  return pending.catch((error: unknown) => {
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

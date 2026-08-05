import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ClientEndpointRegion } from '@cindy/maker-shared/client-endpoints';
import type { ApiFetchOptions } from '@/api/client';
import {
  AUTH_REGION,
  BUILD_AUTH_REGION,
  getActiveMobileSessionRealm,
  getMobileEndpointForRealm,
  loadMobileEndpointsForRealm,
} from '@/config/env';
import Notifications from './nativeNotifications';
import { buildPushTokenRegistrationBody } from './pushRegistrationModel';

/**
 * 移动推送(任务完成通知)的 expo-notifications 接线层。
 *
 * - 开关持久化在本机(AsyncStorage),默认关闭;打开时才请求系统通知权限。
 * - 注册目标是 device-link server 的 PUT /push-token(Bearer 鉴权与 WS 同源);
 *   关闭开关 / 登出 / 换账号或区域时注销(DELETE,幂等)。
 * - 仅 iOS(APNs):Android 需 FCM / 国内厂商通道,二期接入(server 侧已预留
 *   provider='fcm' 字段)。原生模块只在 iOS 存在,所有调用一律经
 *   `./nativeNotifications`(Android 由平台扩展顶成空实现,原因见该文件)。
 * - App 在前台时压掉系统横幅(WS 活着,会话本来就在实时刷新)。
 */

const PUSH_ENABLED_KEY = 'cindy.push.enabled';
/** 成功或可能成功注册过 token 的区域集合，避免把注销请求发到错误区域。 */
const PUSH_REGISTERED_KEY = 'cindy.push.registered';
/**
 * 注销失败的区域集合。只允许在以后重新持有同一区域登录态时补偿，
 * 不会用 CN token 请求 Global，也不会用 Global token 请求 CN。
 */
const PUSH_PENDING_UNREGISTER_KEY = 'cindy.push.pendingUnregister';
const PUSH_TOKEN_PATH = '/api/device-link/push-token';
const PUSH_REALM_STATE_VERSION = 1;
const PUSH_DEVICE_TOKEN_MAX_LENGTH = 512;
const PUSH_UNREGISTER_TIMEOUT_MS = 3_000;

interface PushRealmState {
  version: typeof PUSH_REALM_STATE_VERSION;
  realms: ClientEndpointRegion[];
}

/** React effects / token listener / 设置页可能同时触发，串行化避免注册与撤销倒序。 */
let pushMutationTail: Promise<void> = Promise.resolve();
/**
 * 终止登录不能排在 apiFetch 后面等待，否则 apiFetch 的 terminal handler 正在
 * await 注销时会形成环。注销递增 generation，使旧生命周期的排队操作失效。
 */
let pushLifecycleGeneration = 0;

function runPushMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pushMutationTail.then(operation, operation);
  pushMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isClientEndpointRegion(value: unknown): value is ClientEndpointRegion {
  return value === 'cn' || value === 'global';
}

/**
 * v1 以前两个 key 都是 '0'/'1'。旧版没有区域字段：由仍持有登录上下文的
 * 调用方提供迁移区域，避免把历史状态错误归到安装包区域。
 */
async function readPushRealms(
  key: string,
  legacyRealm: ClientEndpointRegion = BUILD_AUTH_REGION,
): Promise<Set<ClientEndpointRegion>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw || raw === '0') return new Set();
    if (raw === '1') return new Set([legacyRealm]);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== PUSH_REALM_STATE_VERSION ||
      !Array.isArray((parsed as { realms?: unknown }).realms)
    ) {
      return new Set();
    }
    return new Set(
      (parsed as PushRealmState).realms.filter(isClientEndpointRegion),
    );
  } catch {
    return new Set();
  }
}

async function writePushRealms(
  key: string,
  realms: ReadonlySet<ClientEndpointRegion>,
): Promise<void> {
  if (realms.size === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }
  const state: PushRealmState = {
    version: PUSH_REALM_STATE_VERSION,
    realms: (['cn', 'global'] as const).filter((realm) => realms.has(realm)),
  };
  await AsyncStorage.setItem(key, JSON.stringify(state));
}

async function addPushRealm(
  key: string,
  realm: ClientEndpointRegion,
  legacyRealm: ClientEndpointRegion = realm,
): Promise<void> {
  const realms = await readPushRealms(key, legacyRealm);
  realms.add(realm);
  await writePushRealms(key, realms);
}

async function removePushRealm(
  key: string,
  realm: ClientEndpointRegion,
  legacyRealm: ClientEndpointRegion = realm,
): Promise<void> {
  const realms = await readPushRealms(key, legacyRealm);
  realms.delete(realm);
  await writePushRealms(key, realms);
}

function normalizeDeviceToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (token.length === 0 || token.length > PUSH_DEVICE_TOKEN_MAX_LENGTH) {
    return null;
  }
  return token;
}

async function getNativeDeviceTokenBestEffort(): Promise<string | null> {
  try {
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    return normalizeDeviceToken(deviceToken.data);
  } catch {
    return null;
  }
}

function deviceLinkBaseForRealm(realm: ClientEndpointRegion): string {
  return getMobileEndpointForRealm(realm, 'deviceLinkApiBaseUrl');
}

function pushDeleteBody(token: string | null): { token: string } | undefined {
  return token ? { token } : undefined;
}

/**
 * 清理登录态时不能走 apiFetch：401 terminal handler 可能正在等待当前清理，
 * 形成自等待。调用方必须在切换 realm / 清空旧 access token 前进入此函数。
 */
async function deletePushTokenWithAccessToken(
  realm: ClientEndpointRegion,
  accessToken: string,
): Promise<void> {
  await loadMobileEndpointsForRealm(realm);
  const deviceToken = await getNativeDeviceTokenBestEffort();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    PUSH_UNREGISTER_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      deviceLinkBaseForRealm(realm) + PUSH_TOKEN_PATH,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(deviceToken ? { 'content-type': 'application/json' } : {}),
        },
        ...(deviceToken
          ? { body: JSON.stringify({ token: deviceToken }) }
          : {}),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`unregister failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function isPushSupported(): boolean {
  return Platform.OS === 'ios';
}

export async function readPushEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PUSH_ENABLED_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function writePushEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(PUSH_ENABLED_KEY, enabled ? '1' : '0');
}

/**
 * 前台通知行为:横幅/声音全部压掉(人在 App 里,会话流本来就在实时刷新;
 * 系统推送只服务后台/杀进程场景)。
 */
export function configureForegroundNotificationBehavior(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export type PushSyncResult =
  | 'registered'
  | 'unregistered'
  | 'permission-denied'
  | 'unsupported'
  | 'skipped';

/** AuthContext.apiFetch 的最小形状(带 Bearer + 401 自动 refresh)。 */
export type AuthedApiFetch = <T>(
  path: string,
  opts: Omit<ApiFetchOptions, 'token'>,
) => Promise<T>;

/**
 * 把本机开关状态同步到当前会话区域的 server 注册表。开 → 请求权限 + 拿 APNs
 * token + PUT；关 → 曾在当前区域注册过才 DELETE。
 */
async function syncPushRegistrationInternal(
  opts: {
    enabled: boolean;
    apiFetch: AuthedApiFetch;
  },
  lifecycleGeneration: number,
): Promise<PushSyncResult> {
  if (!isPushSupported()) return 'unsupported';
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  const realm = getActiveMobileSessionRealm();
  const baseUrl = deviceLinkBaseForRealm(realm);

  if (!opts.enabled) {
    const registeredRealms = await readPushRealms(PUSH_REGISTERED_KEY, realm);
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
    if (!registeredRealms.has(realm)) return 'skipped';
    const token = await getNativeDeviceTokenBestEffort();
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
    try {
      await opts.apiFetch(PUSH_TOKEN_PATH, {
        baseUrl,
        method: 'DELETE',
        ...(token ? { body: pushDeleteBody(token) } : {}),
      });
    } catch (error) {
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm).catch(
        () => undefined,
      );
      throw error;
    }
    await removePushRealm(PUSH_REGISTERED_KEY, realm);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    return 'unregistered';
  }

  let permission = await Notifications.getPermissionsAsync();
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  if (permission.status !== 'granted' && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  }
  if (permission.status !== 'granted') return 'permission-denied';

  const deviceToken = await Notifications.getDevicePushTokenAsync();
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  const body = buildPushTokenRegistrationBody({
    token: typeof deviceToken.data === 'string' ? deviceToken.data : '',
    region: AUTH_REGION,
    isDevBuild: __DEV__,
  });
  if (!body) return 'skipped';

  // PUT 响应丢失时无法判断服务端是否提交，发出前即标记“可能已注册”；
  // 后续只能在该区域持有有效会话时做幂等 DELETE。
  await addPushRealm(PUSH_REGISTERED_KEY, realm);
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    return 'skipped';
  }
  try {
    await opts.apiFetch(PUSH_TOKEN_PATH, {
      baseUrl,
      method: 'PUT',
      body,
    });
  } catch (error) {
    if (lifecycleGeneration !== pushLifecycleGeneration) {
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm).catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    return 'skipped';
  }
  await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  return 'registered';
}

export function syncPushRegistration(opts: {
  enabled: boolean;
  apiFetch: AuthedApiFetch;
}): Promise<PushSyncResult> {
  const lifecycleGeneration = pushLifecycleGeneration;
  return runPushMutation(() =>
    syncPushRegistrationInternal(opts, lifecycleGeneration),
  );
}

/**
 * 登出、终止或换账号/区域前的 best-effort 注销。realm 与 access token 都在
 * 调用开始时冻结，因此后续端点切换不会把旧 token 发到新区域。
 */
async function unregisterPushTokenBestEffortInternal(
  realm: ClientEndpointRegion,
  accessToken: string | null,
): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const registeredRealms = await readPushRealms(PUSH_REGISTERED_KEY, realm);
    if (!registeredRealms.has(realm)) return;

    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    if (!accessToken) return;

    await deletePushTokenWithAccessToken(realm, accessToken);
    await removePushRealm(PUSH_REGISTERED_KEY, realm);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  } catch {
    // 离线/超时/旧 token 失效不能阻断退出或切换。标记只在以后登录同一区域时
    // 重试，绝不引入服务端互信或客户端跨区 token 发送。
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm).catch(
      () => undefined,
    );
  }
}

export function unregisterPushTokenBestEffort(
  accessToken: string | null,
  realm: ClientEndpointRegion = getActiveMobileSessionRealm(),
): Promise<void> {
  pushLifecycleGeneration += 1;
  // 不进入 pushMutationTail：当前 tail 可能正在 apiFetch → terminal handler →
  // clearLocalSession → 本函数。等待 tail 会形成自等待死锁。
  return unregisterPushTokenBestEffortInternal(realm, accessToken);
}

/**
 * 只补偿“当前会话区域”的注销。历史上另一区域的标记保持不动，直到用户再次
 * 登录该区域；当前 token 永远不会被发送给 peer endpoint。
 */
async function retryPendingUnregisterInternal(
  apiFetch: AuthedApiFetch,
): Promise<void> {
  if (!isPushSupported()) return;
  const realm = getActiveMobileSessionRealm();
  const pendingRealms = await readPushRealms(
    PUSH_PENDING_UNREGISTER_KEY,
    realm,
  );
  if (!pendingRealms.has(realm)) return;

  try {
    const token = await getNativeDeviceTokenBestEffort();
    await apiFetch(PUSH_TOKEN_PATH, {
      baseUrl: deviceLinkBaseForRealm(realm),
      method: 'DELETE',
      ...(token ? { body: pushDeleteBody(token) } : {}),
    });
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    await removePushRealm(PUSH_REGISTERED_KEY, realm);
  } catch {
    // 仍失败：保留当前区域标记，下次同区登录继续补偿。
  }
}

export function retryPendingUnregister(
  apiFetch: AuthedApiFetch,
): Promise<void> {
  return runPushMutation(() => retryPendingUnregisterInternal(apiFetch));
}

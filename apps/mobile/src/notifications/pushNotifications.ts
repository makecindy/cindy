import { i18n } from '@/i18n';
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
import {
  getDevServerEnvironment,
  type DevServerEnvironment,
} from '@/config/devServerEnvironment';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import Notifications from './nativeNotifications';
import { buildPushTokenRegistrationBody, parseNotificationResponseDeepLink } from './pushRegistrationModel';

/** APNs / FCM registration, scoped to the current account realm and lifecycle. */
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

interface PushStateScope {
  environment: DevServerEnvironment;
  legacyRealm: ClientEndpointRegion;
}

/** 一次 mutation 内冻结存储 namespace，不能在异步读写之间重新取当前环境。 */
function capturePushStateScope(
  legacyRealm: ClientEndpointRegion = BUILD_AUTH_REGION,
): PushStateScope {
  return { environment: getDevServerEnvironment(), legacyRealm };
}

function pushStateStorageKeys(
  baseKey: string,
  environment: DevServerEnvironment,
): {
  primary: string;
  migrationFallback: string | null;
} {
  if (AUTH_REGION !== 'dev') {
    return { primary: baseKey, migrationFallback: null };
  }
  return {
    primary: `${baseKey}.${environment}`,
    // 旧 CindyDev 只连接 Dev；无环境后缀的存量状态只能归到 Dev，绝不能
    // 在首次切到 Release 时误迁移过去。
    migrationFallback: environment === 'dev' ? baseKey : null,
  };
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
  scope: PushStateScope,
): Promise<Set<ClientEndpointRegion>> {
  try {
    const storageKeys = pushStateStorageKeys(key, scope.environment);
    const primaryRaw = await AsyncStorage.getItem(storageKeys.primary);
    const raw =
      primaryRaw ??
      (storageKeys.migrationFallback
        ? await AsyncStorage.getItem(storageKeys.migrationFallback)
        : null);
    if (!raw || raw === '0') return new Set();
    if (raw === '1') return new Set([scope.legacyRealm]);
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
  scope: PushStateScope,
): Promise<void> {
  const storageKeys = pushStateStorageKeys(key, scope.environment);
  if (realms.size === 0) {
    await AsyncStorage.removeItem(storageKeys.primary);
    if (storageKeys.migrationFallback) {
      await AsyncStorage.removeItem(storageKeys.migrationFallback).catch(
        () => undefined,
      );
    }
    return;
  }
  const state: PushRealmState = {
    version: PUSH_REALM_STATE_VERSION,
    realms: (['cn', 'global'] as const).filter((realm) => realms.has(realm)),
  };
  await AsyncStorage.setItem(storageKeys.primary, JSON.stringify(state));
  if (storageKeys.migrationFallback) {
    await AsyncStorage.removeItem(storageKeys.migrationFallback).catch(
      () => undefined,
    );
  }
}

async function addPushRealm(
  key: string,
  realm: ClientEndpointRegion,
  scope: PushStateScope,
): Promise<void> {
  const realms = await readPushRealms(key, scope);
  realms.add(realm);
  await writePushRealms(key, realms, scope);
}

async function removePushRealm(
  key: string,
  realm: ClientEndpointRegion,
  scope: PushStateScope,
): Promise<void> {
  const realms = await readPushRealms(key, scope);
  realms.delete(realm);
  await writePushRealms(key, realms, scope);
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

function pushTargets(realm: ClientEndpointRegion, method: 'PUT' | 'DELETE' = 'DELETE') {
  // 自建中转不转发系统推送(docs/self-hosted-relay-plan.md §5.3、§7):这时不在官方 device-link
  // 登记 token;注销仍发往官方地址(realm 缓存,不受中转覆盖),清掉以前的登记。
  const skipDeviceLink = method === 'PUT' && getActiveSelfHostedRelay() !== null;
  const targets = skipDeviceLink
    ? []
    : [{ baseUrl: deviceLinkBaseForRealm(realm), path: PUSH_TOKEN_PATH, optional: false }];
  try {
    const baseUrl = getMobileEndpointForRealm(realm, 'chatApiBaseUrl');
    if (baseUrl) targets.push({ baseUrl, path: '/v1/push-token', optional: true });
  } catch { /* Older endpoint snapshots do not advertise chat. */ }
  return targets;
}
async function mutatePushTokens(apiFetch: AuthedApiFetch, realm: ClientEndpointRegion, method: 'PUT' | 'DELETE', body?: unknown) {
  const results = await Promise.allSettled(pushTargets(realm, method).map(async target => {
    try { await apiFetch(target.path, { baseUrl: target.baseUrl, method, headers: { 'Accept-Language': i18n.language || 'en' }, ...(body ? { body } : {}) }); }
    catch (error) {
      // An older chat server can roll forward independently of existing task pushes.
      if (target.optional && [404, 405].includes((error as { status?: number }).status ?? 0)) return;
      throw error;
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
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
    const results = await Promise.allSettled(pushTargets(realm).map(async target => {
    const response = await fetch(
      target.baseUrl + target.path,
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
    if (!response.ok && !(target.optional && [404,405].includes(response.status))) {
      throw new Error(`unregister failed: ${response.status}`);
    }
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    clearTimeout(timer);
  }
}

export function isPushSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

const pushPreferenceListeners = new Set<(signedOut?: boolean) => void>();
export function subscribePushPreferences(listener: (signedOut?: boolean) => void) {
  pushPreferenceListeners.add(listener); return () => { pushPreferenceListeners.delete(listener); };
}
export async function readPushPreviewEnabled() { return (await AsyncStorage.getItem('cindy.push.preview')) !== '0'; }
export async function writePushPreviewEnabled(enabled: boolean) {
  await AsyncStorage.setItem('cindy.push.preview', enabled ? '1' : '0');
  for (const listener of pushPreferenceListeners) listener();
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
  for (const listener of pushPreferenceListeners) listener();
}

/** Suppress a foreground banner only while its conversation and thread are visible. */
export function configureForegroundNotificationBehavior(isReading: (path: string) => boolean = () => false): void {
  Notifications.setNotificationHandler({
    handleNotification: async notification => {
      const route = parseNotificationResponseDeepLink({ notification });
      const show = !!route?.startsWith('/companions/groups/') && !isReading(route);
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
}

export type PushSyncResult =
  | 'registered'
  | 'unregistered'
  | 'permission-denied'
  | 'unsupported'
  | 'local-only'
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
  const stateScope = capturePushStateScope(realm);

  if (!opts.enabled) {
    const registeredRealms = await readPushRealms(
      PUSH_REGISTERED_KEY,
      stateScope,
    );
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
    if (!registeredRealms.has(realm)) return 'skipped';
    const token = await getNativeDeviceTokenBestEffort();
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
    try {
      await mutatePushTokens(opts.apiFetch, realm, 'DELETE', pushDeleteBody(token));
    } catch (error) {
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope).catch(
        () => undefined,
      );
      throw error;
    }
    await removePushRealm(PUSH_REGISTERED_KEY, realm, stateScope);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
    return 'unregistered';
  }

  let permission = await Notifications.getPermissionsAsync();
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  if (permission.status !== 'granted' && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  }
  if (permission.status !== 'granted') return 'permission-denied';

  let deviceToken;
  try { deviceToken = await Notifications.getDevicePushTokenAsync(); }
  catch (error) {
    if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
    if (Platform.OS === 'android') return 'local-only';
    throw error;
  }
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
  const body = buildPushTokenRegistrationBody({
    token: typeof deviceToken.data === 'string' ? deviceToken.data : '',
    region: AUTH_REGION,
    isDevBuild: __DEV__,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
  });
  if (!body) return 'skipped';

  // PUT 响应丢失时无法判断服务端是否提交，发出前即标记“可能已注册”；
  // 后续只能在该区域持有有效会话时做幂等 DELETE。
  await addPushRealm(PUSH_REGISTERED_KEY, realm, stateScope);
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
    return 'skipped';
  }
  try {
    await mutatePushTokens(opts.apiFetch, realm, 'PUT', { ...body, preview: await readPushPreviewEnabled() });
  } catch (error) {
    if (lifecycleGeneration !== pushLifecycleGeneration) {
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope).catch(
        () => undefined,
      );
    } else if (!await readPushEnabled()) {
      // A failed first enable must not leave either endpoint subscribed while
      // Settings still shows off. DELETE both: a lost PUT response is ambiguous.
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
      try {
        if (lifecycleGeneration !== pushLifecycleGeneration) throw error;
        await mutatePushTokens(opts.apiFetch, realm, 'DELETE', { token: body.token });
        await removePushRealm(PUSH_REGISTERED_KEY, realm, stateScope);
        await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
      } catch { /* Keep the existing same-realm compensation marker for reconnect. */ }
    }
    throw error;
  }
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
    return 'skipped';
  }
  await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
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
  const stateScope = capturePushStateScope(realm);
  try {
    const registeredRealms = await readPushRealms(
      PUSH_REGISTERED_KEY,
      stateScope,
    );
    if (!registeredRealms.has(realm)) return;

    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
    if (!accessToken) return;

    await deletePushTokenWithAccessToken(realm, accessToken);
    await removePushRealm(PUSH_REGISTERED_KEY, realm, stateScope);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
  } catch {
    // 离线/超时/旧 token 失效不能阻断退出或切换。标记只在以后登录同一区域时
    // 重试，绝不引入服务端互信或客户端跨区 token 发送。
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope).catch(
      () => undefined,
    );
  }
}

export function unregisterPushTokenBestEffort(
  accessToken: string | null,
  realm: ClientEndpointRegion = getActiveMobileSessionRealm(),
): Promise<void> {
  pushLifecycleGeneration += 1;
  for (const listener of pushPreferenceListeners) listener(true);
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
  const stateScope = capturePushStateScope(realm);
  const pendingRealms = await readPushRealms(
    PUSH_PENDING_UNREGISTER_KEY,
    stateScope,
  );
  if (!pendingRealms.has(realm)) return;

  try {
    const token = await getNativeDeviceTokenBestEffort();
    await mutatePushTokens(apiFetch, realm, 'DELETE', pushDeleteBody(token));
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm, stateScope);
    await removePushRealm(PUSH_REGISTERED_KEY, realm, stateScope);
  } catch {
    // 仍失败：保留当前区域标记，下次同区登录继续补偿。
  }
}

export function retryPendingUnregister(
  apiFetch: AuthedApiFetch,
): Promise<void> {
  return runPushMutation(() => retryPendingUnregisterInternal(apiFetch));
}

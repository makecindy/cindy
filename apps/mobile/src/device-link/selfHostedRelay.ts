/**
 * 手机的自建中转设置(docs/self-hosted-relay-plan.md §5.2、§5.3)。
 *
 * 按 Cindy 账号保存:
 * - 非秘密设置在 AsyncStorage `cindy.mobile.self-hosted-relay.v2.<账号 key>`:没有这条 = 官方中转;
 *   有 = `{ mode: 'self-hosted', relayId, name, baseUrl, role, deviceId, ownerPublicKey }`。
 * - 中转设备凭证与本机签名密钥种子(§16)作为一个 JSON `{ credential, seed }` 存在安全存储
 *   `cindy.selfHostedRelay.credential.v2.<账号 key 的 SHA-256 前 32 位>`,`WHEN_UNLOCKED_THIS_DEVICE_ONLY`:
 *   不随备份迁到别的手机,也不进日志与诊断。
 * - v1(设备签名之前)的条目没有签名密钥,电脑不再接受这台手机发出的未签名消息:读到时按官方中转处理,
 *   并尽力删除,用户需要重新加入。
 *
 * 账号切换时(authOwnerGeneration 同步发布)先清空内存路由,再读新账号的设置;读完之前
 * device-link 不建连(selfHostedRelayRouting.waitForSelfHostedRelayRoute)。退出登录只清内存路由,
 * 本机设置留给同一账号下次登录:中转成员资格属于「这台手机 + 这个账号」,重新加入要主人再同意一次。
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { isRelayPublicKey, normalizeRelayBaseUrl, type RelayFetch } from '@cindy/device-link';

import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';
import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

import {
  getActiveSelfHostedRelay,
  getSelfHostedRelayRouteGeneration,
  setActiveSelfHostedRelay,
  setSelfHostedRelayLoading,
  subscribeSelfHostedRelayRoute,
  type SelfHostedRelayRoute,
} from './selfHostedRelayRouting';

const CONFIG_PREFIX = 'cindy.mobile.self-hosted-relay.v2.';
// SecureStore 的 key 只允许 [A-Za-z0-9._-];账号 key 是 JSON,取哈希。
const SECRETS_PREFIX = 'cindy.selfHostedRelay.credential.v2.';
const LEGACY_CONFIG_PREFIX = 'cindy.mobile.self-hosted-relay.v1.';
const LEGACY_CREDENTIAL_PREFIX = 'cindy.selfHostedRelay.credential.v1.';
const SEED_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEAVE_TIMEOUT_MS = 5_000;

interface StoredRelayConfig {
  version: 2;
  mode: 'self-hosted';
  relayId: string;
  name: string;
  baseUrl: string;
  /** 手机只能作为成员加入;主人设备只在电脑上。 */
  role: 'member';
  /** 加入时上报、证书里的设备 ID(= 官方登录的设备 ID),签名与退出中转时用。 */
  deviceId: string;
  /** 加入链接里的主人公钥。 */
  ownerPublicKey: string;
}

/** 安全存储里的一条:凭证与签名种子同存同删,不会只剩一半。 */
interface StoredRelaySecrets {
  credential: string;
  seed: string;
}

function accountHash(accountKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(accountKey))).slice(0, 32);
}

function configKey(accountKey: string): string {
  return CONFIG_PREFIX + accountKey;
}

function secretsKey(accountKey: string): string {
  return SECRETS_PREFIX + accountHash(accountKey);
}

function parseStoredConfig(raw: string | null): StoredRelayConfig | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRelayConfig>;
    const baseUrl = typeof value.baseUrl === 'string' ? normalizeRelayBaseUrl(value.baseUrl) : null;
    if (
      value.version !== 2 ||
      value.mode !== 'self-hosted' ||
      typeof value.relayId !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.deviceId !== 'string' ||
      !isRelayPublicKey(value.ownerPublicKey) ||
      !baseUrl
    ) {
      return null;
    }
    return {
      version: 2,
      mode: 'self-hosted',
      relayId: value.relayId,
      name: value.name,
      baseUrl,
      role: 'member',
      deviceId: value.deviceId,
      ownerPublicKey: value.ownerPublicKey,
    };
  } catch {
    return null;
  }
}

function parseStoredSecrets(raw: string | null): StoredRelaySecrets | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRelaySecrets>;
    if (typeof value.credential !== 'string' || !value.credential) return null;
    if (typeof value.seed !== 'string' || !SEED_PATTERN.test(value.seed)) return null;
    return { credential: value.credential, seed: value.seed };
  } catch {
    return null;
  }
}

/**
 * v1(设备签名之前)的设置与凭证:没有签名密钥,用不了了(电脑会丢弃未签名的消息)。
 * 尽力删除;删不掉也只是留一条不再读取的旧数据。
 */
async function discardLegacyRelay(accountKey: string): Promise<void> {
  try {
    if ((await AsyncStorage.getItem(LEGACY_CONFIG_PREFIX + accountKey)) === null) return;
    await deleteSecureItem(LEGACY_CREDENTIAL_PREFIX + accountHash(accountKey));
    await AsyncStorage.removeItem(LEGACY_CONFIG_PREFIX + accountKey);
    mobileDebugLog('info', 'device-link', 'discarded self-hosted relay settings from before device signatures');
  } catch (error) {
    mobileDebugLog('warn', 'device-link', 'legacy self-hosted relay cleanup failed',
      error instanceof Error ? error.name : 'unknown');
  }
}

/** 当前账号的设置;只在内存,与路由同步更新。退出中转时要用其中的 deviceId。 */
let currentConfig: StoredRelayConfig | null = null;
let loadedAccountKey = '';
let loadSequence = 0;

function syncOwner(): void {
  const owner = getMobileAuthOwner();
  if (owner.switching || !owner.accountKey) {
    loadSequence += 1;
    loadedAccountKey = '';
    currentConfig = null;
    setActiveSelfHostedRelay(null);
    setSelfHostedRelayLoading(false);
    return;
  }
  if (owner.accountKey === loadedAccountKey) return;
  loadedAccountKey = owner.accountKey;
  const sequence = ++loadSequence;
  // 上一个账号的中转不能被新账号沿用,哪怕只是读设置的这一小段时间。
  currentConfig = null;
  setActiveSelfHostedRelay(null);
  setSelfHostedRelayLoading(true);
  void discardLegacyRelay(owner.accountKey);
  void (async () => {
    let config: StoredRelayConfig | null = null;
    let secrets: StoredRelaySecrets | null = null;
    try {
      config = parseStoredConfig(await AsyncStorage.getItem(configKey(owner.accountKey)));
      if (config) secrets = parseStoredSecrets(await getSecureItem(secretsKey(owner.accountKey)));
    } catch (error) {
      // 读不到设置时按官方中转处理;读不到凭证时保留自建设置,由设置页提示重新加入或切回。
      mobileDebugLog('warn', 'device-link', 'self-hosted relay settings unavailable',
        error instanceof Error ? error.name : 'unknown');
    }
    if (sequence !== loadSequence) return;
    currentConfig = config;
    setActiveSelfHostedRelay(config ? routeFromConfig(config, secrets) : null);
    setSelfHostedRelayLoading(false);
  })();
}

function routeFromConfig(config: StoredRelayConfig, secrets: StoredRelaySecrets | null): SelfHostedRelayRoute {
  return {
    relayId: config.relayId,
    name: config.name,
    baseUrl: config.baseUrl,
    credential: secrets?.credential ?? null,
    signing: secrets
      ? { deviceId: config.deviceId, ownerPublicKey: config.ownerPublicKey, seed: secrets.seed }
      : null,
  };
}

subscribeMobileAuthOwner(syncOwner);
syncOwner();

function assertOwnerCurrent(owner: MobileAuthOwnerGeneration): void {
  if (!owner.accountKey || owner.switching || !isMobileAuthOwnerCurrent(owner)) {
    throw new Error('ACCOUNT_CHANGED');
  }
}

/**
 * 加入成功(且证书已核对)后保存并切换到这个中转。凭证只返回一次,先写安全存储再写设置;
 * 设置写失败时把安全存储恢复成原来的,避免设置与凭证、签名密钥对不上。
 */
export async function saveSelfHostedRelay(input: {
  owner: MobileAuthOwnerGeneration;
  relayId: string;
  name: string;
  baseUrl: string;
  deviceId: string;
  ownerPublicKey: string;
  credential: string;
  /** 本机签名私钥种子(base64url),见 `createRelayJoinIdentity`。 */
  seed: string;
}): Promise<void> {
  assertOwnerCurrent(input.owner);
  const baseUrl = normalizeRelayBaseUrl(input.baseUrl);
  if (!baseUrl || !input.credential || !SEED_PATTERN.test(input.seed) || !isRelayPublicKey(input.ownerPublicKey)) {
    throw new Error('INVALID_RELAY');
  }
  const accountKey = input.owner.accountKey;
  const previousConfig = currentConfig;
  const previousRoute = getActiveSelfHostedRelay();
  const config: StoredRelayConfig = {
    version: 2,
    mode: 'self-hosted',
    relayId: input.relayId,
    name: input.name,
    baseUrl,
    role: 'member',
    deviceId: input.deviceId,
    ownerPublicKey: input.ownerPublicKey,
  };
  const secrets: StoredRelaySecrets = { credential: input.credential, seed: input.seed };
  await setSecureItem(secretsKey(accountKey), JSON.stringify(secrets), { thisDeviceOnly: true });
  try {
    await AsyncStorage.setItem(configKey(accountKey), JSON.stringify(config));
  } catch (error) {
    const previousSecrets: StoredRelaySecrets | null = previousRoute?.credential && previousRoute.signing
      ? { credential: previousRoute.credential, seed: previousRoute.signing.seed }
      : null;
    const restore = previousSecrets
      ? setSecureItem(secretsKey(accountKey), JSON.stringify(previousSecrets), { thisDeviceOnly: true })
      : deleteSecureItem(secretsKey(accountKey));
    await restore.catch(() => undefined);
    throw error;
  }
  // 保存属于发起加入的账号;账号已经切走就不切换当前路由(切回该账号时会读到它)。
  if (!isMobileAuthOwnerCurrent(input.owner)) return;
  currentConfig = config;
  setActiveSelfHostedRelay(routeFromConfig(config, secrets));
  // 从另一个自建中转换过来:顺手退出旧中转(尽力而为,失败只是在旧中转上留一条设备记录)。
  if (previousConfig && previousRoute?.credential && previousConfig.baseUrl !== baseUrl) {
    void leaveRelayBestEffort(previousConfig, previousRoute.credential);
  }
}

/** 切回官方中转:删掉设置与凭证,立即恢复官方路由;再尽力让中转删掉这台手机。 */
export async function clearSelfHostedRelay(): Promise<void> {
  const owner = getMobileAuthOwner();
  assertOwnerCurrent(owner);
  const leavingConfig = currentConfig;
  const leavingCredential = getActiveSelfHostedRelay()?.credential ?? null;
  // 设置删不掉就不切:否则下次启动又回到这个中转,和用户看到的不一致。
  await AsyncStorage.removeItem(configKey(owner.accountKey));
  await deleteSecureItem(secretsKey(owner.accountKey)).catch((error: unknown) => {
    mobileDebugLog('warn', 'device-link', 'self-hosted relay credential cleanup failed',
      error instanceof Error ? error.name : 'unknown');
  });
  if (isMobileAuthOwnerCurrent(owner)) {
    currentConfig = null;
    setActiveSelfHostedRelay(null);
  }
  if (leavingConfig && leavingCredential) void leaveRelayBestEffort(leavingConfig, leavingCredential);
}

/** 成员可以让自己退出中转(DELETE /devices/<自己>);这里拿的是刚移除的凭证,不经 apiFetch。 */
async function leaveRelayBestEffort(config: StoredRelayConfig, credential: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEAVE_TIMEOUT_MS);
  try {
    await fetch(`${config.baseUrl}/api/device-link/devices/${encodeURIComponent(config.deviceId)}`, {
      method: 'DELETE',
      headers: { Authorization: `CindyRelay ${credential}` },
      signal: controller.signal,
    });
  } catch {
    // 中转已停用或连不上:主人在电脑上仍能移除这台手机。
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 加入流程用的 fetch:每个请求有自己的超时;调用方的取消信号照常生效
 * (共享流程据此区分「用户取消」与「连不上」)。
 */
export function createRelayJoinFetch(timeoutMs: number): RelayFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  };
}

/** 界面用:当前账号的中转(null = 官方中转)。credential 为 null 表示本机凭证缺失。 */
export function useSelfHostedRelay(): SelfHostedRelayRoute | null {
  return useSyncExternalStore(subscribeSelfHostedRelayRoute, getActiveSelfHostedRelay, getActiveSelfHostedRelay);
}

/** DeviceLinkProvider 用:路由代次变化时按账号切换同一条路径重建连接。 */
export function useSelfHostedRelayRouteGeneration(): number {
  return useSyncExternalStore(
    subscribeSelfHostedRelayRoute,
    getSelfHostedRelayRouteGeneration,
    getSelfHostedRelayRouteGeneration,
  );
}

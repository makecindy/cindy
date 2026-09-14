/**
 * Mobile 自建更新通道的本地快照。
 *
 * OTA 检查发生在 AuthProvider 挂载之前，因此不能临时等登录接口；沿用 desktop
 * 的策略，把服务端 isCanary 结果持久化到本机，下一次冷启动在任何更新请求前恢复。
 * 标记不敏感（只选择两个公开 CDN 指针），使用 AsyncStorage 即可。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { resolveUpdateChannel, type UpdateChannel } from '@cindy/maker-shared/update-channel';

import { isBetaChannel } from './betaChannelStore';

export const CANARY_UPDATE_HEADER = 'x-cindy-update-channel';
const STORAGE_KEY = 'cindy.mobile.update.canary';

let canary = false;
let hydrated = false;
let hydratePromise: Promise<boolean> | null = null;
let mutationEpoch = 0;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  // 订阅者只负责触发 React 重渲染；单个监听器异常不能阻断其它监听器或
  // 登录态持久化队列。React 的 setState 正常不会抛，但这里仍做隔离以免
  // 测试/宿主注入的监听器破坏 channel store 的确定性。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

/** 冷启动时调用一次；损坏/不可读一律 fail-safe 到 stable。 */
export function hydrateCanaryChannel(): Promise<boolean> {
  if (hydrated) return Promise.resolve(canary);
  if (hydratePromise) return hydratePromise;
  const epoch = mutationEpoch;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (epoch === mutationEpoch) {
        const next = raw === 'true';
        if (canary !== next || !hydrated) {
          canary = next;
          notifyListeners();
        }
      }
      hydrated = true;
      return canary;
    })
    .catch(() => {
      if (epoch === mutationEpoch) {
        if (canary || !hydrated) {
          canary = false;
          notifyListeners();
        }
      }
      hydrated = true;
      return canary;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** 启动 gate 完成后可同步读取。未 hydrate 时按 stable。 */
export function isCanaryChannel(): boolean {
  return hydrated && canary;
}

/** 订阅登录态切换后的 channel 变化；返回取消订阅函数。 */
export function subscribeCanaryChannel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** feature-flags 成功返回后同步；请求失败时调用方应保留旧值，不调用本函数。 */
export function syncCanaryChannel(next: boolean): Promise<void> {
  const value = next === true;
  mutationEpoch += 1;
  hydrated = true;
  canary = value;
  notifyListeners();
  return enqueueMutation(() => (
    value
      ? AsyncStorage.setItem(STORAGE_KEY, 'true')
      : AsyncStorage.removeItem(STORAGE_KEY)
  ));
}

/** 登出/身份失效时清除，避免下一账号继承当前账号的灰度通道。 */
export function clearCanaryChannel(): Promise<void> {
  mutationEpoch += 1;
  hydrated = true;
  canary = false;
  notifyListeners();
  return enqueueMutation(() => AsyncStorage.removeItem(STORAGE_KEY));
}

export function updateChannelRequestHeaders(channel: UpdateChannel): Record<string, string> {
  return channel === 'release' ? {} : { [CANARY_UPDATE_HEADER]: channel };
}

/**
 * 设备级发布通道收敛:账号 canary 快照 + 设备 beta 开关。
 * 优先级 canary > beta > release(canary 命中时忽略 beta)。
 * 未 hydrate 时两个 store 都返回 stable,结果即 release(与启动 gate 一致)。
 */
export function resolveUpdateChannelForDevice(): UpdateChannel {
  return resolveUpdateChannel(isCanaryChannel(), isBetaChannel());
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationQueue.catch(() => undefined);
    canary = false;
    hydrated = false;
    hydratePromise = null;
    mutationEpoch = 0;
    mutationQueue = Promise.resolve();
    listeners.clear();
  },
};

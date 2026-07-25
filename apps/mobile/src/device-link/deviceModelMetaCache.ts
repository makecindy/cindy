/**
 * deviceModelMetaCache —— 模型选择列表元信息(单价表 / 网关 key presence)的 deviceId-aware
 * 缓存核心(**纯逻辑,零 react-native**)。
 *
 * 语义对齐 deviceProvidersCache:按 deviceId 隔离 + inflight 去重 + 代际驱逐(evict 时自增
 * 代际,作废在途 fetch 的回写,防设备切换 / 重连后串旧数据)。两份数据共用同一套小工厂,
 * 各自独立命名空间。React hook 在 `./useDeviceModelMeta.ts` 里消费本模块。
 *
 * 与 providers 缓存的关键差异:**失败即降级值、不进缓存、不抛错**——
 *   - 单价表失败(典型:旧被控端 CHANNEL_NOT_ALLOWED)→ null,UI 隐藏价格(对齐桌面
 *     useModelPricing「无价不显示」口径);
 *   - key presence 失败 → 'unknown',折扣版不置灰(宁可放行到被控端请求期报错,也不误伤)。
 */
import type { MobileModelPricingMap } from './mobileMakerTransport';

export type DeviceApiKeyStatus = 'present' | 'absent' | 'unknown';

interface DeviceCache<T> {
  get(deviceId: string): T | undefined;
  fetch(deviceId: string, fetcher: () => Promise<T>): Promise<T | undefined>;
  evict(deviceId: string): void;
  clearAll(): void;
}

function createDeviceCache<T>(): DeviceCache<T> {
  const cache = new Map<string, T>();
  const inflight = new Map<string, Promise<T | undefined>>();
  const deviceGen = new Map<string, number>();

  return {
    get: (deviceId) => cache.get(deviceId),
    fetch(deviceId, fetcher) {
      const cached = cache.get(deviceId);
      if (cached !== undefined) return Promise.resolve(cached);
      const ip = inflight.get(deviceId);
      if (ip) return ip;

      const startGen = deviceGen.get(deviceId) ?? 0;
      const isCurrent = (): boolean => (deviceGen.get(deviceId) ?? 0) === startGen;

      const p = fetcher()
        .then((res) => {
          if (isCurrent()) {
            cache.set(deviceId, res);
            inflight.delete(deviceId);
          }
          return res;
        })
        .catch(() => {
          // 失败不缓存、不抛出:调用方拿 undefined 走降级值;下次进入面板可自然重试。
          if (isCurrent()) inflight.delete(deviceId);
          return undefined;
        });
      inflight.set(deviceId, p);
      return p;
    },
    evict(deviceId) {
      cache.delete(deviceId);
      inflight.delete(deviceId);
      deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
    },
    clearAll() {
      const ids = new Set<string>([...cache.keys(), ...inflight.keys(), ...deviceGen.keys()]);
      for (const id of ids) {
        deviceGen.set(id, (deviceGen.get(id) ?? 0) + 1);
      }
      cache.clear();
      inflight.clear();
    },
  };
}

const pricingCache = createDeviceCache<MobileModelPricingMap | null>();
const keyStatusCache = createDeviceCache<DeviceApiKeyStatus>();

/** 读单价表缓存命中(同步),供 hook 初始化 state 用。undefined = 未拉过。 */
export function getCachedDeviceModelPricing(
  deviceId: string,
): MobileModelPricingMap | null | undefined {
  return pricingCache.get(deviceId);
}

/** 取某被控设备的单价表;失败 → undefined(调用方按 null 隐藏价格,不缓存失败)。 */
export function fetchDeviceModelPricing(
  deviceId: string,
  fetcher: () => Promise<MobileModelPricingMap | null>,
): Promise<MobileModelPricingMap | null | undefined> {
  return pricingCache.fetch(deviceId, async () => {
    const res = await fetcher();
    // 空表与非法形状统一收敛成 null(= 无价格可示),避免下游逐键判空。
    if (!res || typeof res !== 'object' || Array.isArray(res) || Object.keys(res).length === 0) {
      return null;
    }
    return res;
  });
}

/** 读 key presence 缓存命中(同步)。undefined = 未拉过。 */
export function getCachedDeviceApiKeyStatus(deviceId: string): DeviceApiKeyStatus | undefined {
  return keyStatusCache.get(deviceId);
}

/** 取某被控设备的网关 key presence;失败 → undefined(调用方按 'unknown' 不置灰)。 */
export function fetchDeviceApiKeyStatus(
  deviceId: string,
  fetcher: () => Promise<{ present: boolean }>,
): Promise<DeviceApiKeyStatus | undefined> {
  return keyStatusCache.fetch(deviceId, async () => {
    const res = await fetcher();
    return res?.present === true ? 'present' : 'absent';
  });
}

/** device-link:被控设备切换 / 下线时驱逐其模型元信息缓存(与 evictDeviceProviders 同时机)。 */
export function evictDeviceModelMeta(deviceId: string): void {
  pricingCache.evict(deviceId);
  keyStatusCache.evict(deviceId);
}

/** 账号登出 / 切号时清空全部(与 clearAllDeviceProviders 同时机,防跨账号串数据)。 */
export function clearAllDeviceModelMeta(): void {
  pricingCache.clearAll();
  keyStatusCache.clearAll();
}

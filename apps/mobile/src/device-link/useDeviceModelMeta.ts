/**
 * useDeviceModelMeta —— 模型选择列表元信息的 React 接线(单价表 + 网关 key presence)。
 *
 * 缓存 / 去重 / 代际驱逐核心在 `./deviceModelMetaCache`(纯逻辑、node 可测)。两个 hook 都
 * 优雅降级:旧被控端不识别通道 / 拉取失败 → 单价 null(隐藏价格)、key 状态 'unknown'
 * (折扣版不置灰),与桌面「无价不显示」「宁可放行不误伤」的口径一致,不出 loading 态
 * (数据未到时界面不变化,符合设计规范 7)。
 */
import { useEffect, useState } from 'react';

import type { MobileModelPricingMap } from './mobileMakerTransport';
import {
  fetchDeviceApiKeyStatus,
  fetchDeviceModelPricing,
  getCachedDeviceApiKeyStatus,
  getCachedDeviceModelPricing,
  getDeviceApiKeyStatusFetchEpoch,
  getDeviceApiKeyStatusGen,
  getDeviceModelPricingFetchEpoch,
  getDeviceModelPricingGen,
  markDeviceApiKeyStatusFetchEpoch,
  markDeviceModelPricingFetchEpoch,
  refreshDeviceApiKeyStatus,
  refreshDeviceModelPricing,
  subscribeDeviceApiKeyStatusGen,
  subscribeDeviceModelPricingGen,
  type DeviceApiKeyStatus,
} from './deviceModelMetaCache';
import { useDeviceLink } from './DeviceLinkContext';
import { useMobileMakerTransport } from './useMobileMakerTransport';

export type { DeviceApiKeyStatus } from './deviceModelMetaCache';

/** 被控端视角的模型单价表;null = 还没拿到 / 拉不到(消费方隐藏价格)。 */
export function useDeviceModelPricing(deviceId?: string): MobileModelPricingMap | null {
  const maker = useMobileMakerTransport(deviceId ?? '');
  // 连接代际:被控端重连/恢复时 +1,而 maker.invoke 跨重连稳定,仅依赖 [deviceId, maker]
  // 的 effect 不会因重连重跑;纳入依赖后,离线驱逐产生的 cache-miss 在重连时自然重拉
  // (对齐 useDeviceProviders 的 connectionEpoch 接线)。
  const { connectionEpoch } = useDeviceLink();
  const [pricing, setPricing] = useState<MobileModelPricingMap | null>(
    deviceId ? getCachedDeviceModelPricing(deviceId) ?? null : null,
  );

  useEffect(() => {
    if (!deviceId) {
      setPricing(null);
      return;
    }
    let cancelled = false;
    // cache-miss 拉取:以发起时的缓存代际为凭,仅当代际未变(未被 evict/clearAll 作废)
    // 才采纳结果——evict 后更早出发的在途请求仍会 resolve 旧值,不得覆盖新拉取。
    const pull = (): void => {
      const cached = getCachedDeviceModelPricing(deviceId);
      const prevEpoch = getDeviceModelPricingFetchEpoch(deviceId);
      const reconnected = prevEpoch !== undefined && prevEpoch !== connectionEpoch;
      if (cached !== undefined && !reconnected) {
        // 干净命中:缓存属当前连接代次(无记录 = 首次标记,语义同 useDeviceProviders)。
        setPricing(cached);
        markDeviceModelPricingFetchEpoch(deviceId, connectionEpoch);
        return;
      }
      // cache-miss;或重连后命中旧代次缓存(离线宽限期内恢复会取消驱逐,缓存未清,
      // greptile P1):保留可展示的旧值(miss 为 null 降级),强制刷新拿被控端当前真相。
      setPricing(cached ?? null);
      const startGen = getDeviceModelPricingGen(deviceId);
      void (reconnected
        ? refreshDeviceModelPricing(deviceId, () => maker.getModelPricing())
        : fetchDeviceModelPricing(deviceId, () => maker.getModelPricing())
      ).then((res) => {
        if (!cancelled && getDeviceModelPricingGen(deviceId) === startGen) {
          setPricing(res ?? null);
          // 只在采信成功路径记录代次;失败保持旧代次,下次 effect 重跑仍判定
          // reconnected → 重试(对齐 providers 的 markDeviceFetchEpoch)。
          if (res !== undefined) markDeviceModelPricingFetchEpoch(deviceId, connectionEpoch);
        }
      });
    };
    pull();
    // 失效订阅:离线驱逐 / 登出切号清空缓存而页面仍挂载时,清展示并按 cache-miss
    // 重拉;重拉在离线中失败维持降级值(null,不缓存),重连由 connectionEpoch 依赖再触发。
    const unsubscribeGen = subscribeDeviceModelPricingGen(deviceId, () => {
      if (cancelled) return;
      pull();
    });
    return () => {
      cancelled = true;
      unsubscribeGen();
    };
  }, [connectionEpoch, deviceId, maker]);

  return pricing;
}

/** 被控端网关 API key presence;'unknown' = 还没拿到 / 拉不到(消费方不置灰折扣版)。 */
export function useDeviceApiKeyStatus(deviceId?: string): DeviceApiKeyStatus {
  const maker = useMobileMakerTransport(deviceId ?? '');
  // 连接代际:maker.invoke 跨重连稳定,仅依赖 [deviceId, maker] 的 effect 不会因重连
  // 重跑;纳入依赖后,离线驱逐产生的 cache-miss 在重连时自然重拉(对齐同文件
  // useDeviceModelPricing 与 useDeviceProviders 的接线)。
  const { connectionEpoch } = useDeviceLink();
  const [status, setStatus] = useState<DeviceApiKeyStatus>(
    deviceId ? getCachedDeviceApiKeyStatus(deviceId) ?? 'unknown' : 'unknown',
  );

  useEffect(() => {
    if (!deviceId) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    // cache-miss 拉取:以发起时的缓存代际为凭,仅当代际未变(未被 evict/clearAll 作废)
    // 才采纳结果——evict 后更早出发的在途请求仍会 resolve 旧值,不得覆盖新拉取。
    const pull = (): void => {
      const cached = getCachedDeviceApiKeyStatus(deviceId);
      const prevEpoch = getDeviceApiKeyStatusFetchEpoch(deviceId);
      const reconnected = prevEpoch !== undefined && prevEpoch !== connectionEpoch;
      if (cached !== undefined && !reconnected) {
        // 干净命中:缓存属当前连接代次(无记录 = 首次标记,语义同 useDeviceProviders)。
        setStatus(cached);
        markDeviceApiKeyStatusFetchEpoch(deviceId, connectionEpoch);
        return;
      }
      // cache-miss;或重连后命中旧代次缓存(离线宽限期内恢复会取消驱逐,缓存未清):
      // 保留可展示的旧值(miss 为 unknown 降级),强制刷新拿被控端当前真相。
      setStatus(cached ?? 'unknown');
      const startGen = getDeviceApiKeyStatusGen(deviceId);
      void (reconnected
        ? refreshDeviceApiKeyStatus(deviceId, () => maker.getApiKeyPresent())
        : fetchDeviceApiKeyStatus(deviceId, () => maker.getApiKeyPresent())
      ).then((res) => {
        if (!cancelled && getDeviceApiKeyStatusGen(deviceId) === startGen) {
          setStatus(res ?? 'unknown');
          // 只在采信成功路径记录代次;失败保持旧代次,下次 effect 重跑仍判定
          // reconnected → 重试(对齐 providers 的 markDeviceFetchEpoch)。
          if (res !== undefined) markDeviceApiKeyStatusFetchEpoch(deviceId, connectionEpoch);
        }
      });
    };
    pull();
    // 失效订阅:离线驱逐 / 登出切号清空缓存而页面仍挂载时,清展示并按 cache-miss
    // 重拉;重拉在离线中失败维持降级值('unknown',不缓存),重连由 connectionEpoch 依赖再触发。
    const unsubscribeGen = subscribeDeviceApiKeyStatusGen(deviceId, () => {
      if (cancelled) return;
      pull();
    });
    return () => {
      cancelled = true;
      unsubscribeGen();
    };
  }, [connectionEpoch, deviceId, maker]);

  return status;
}

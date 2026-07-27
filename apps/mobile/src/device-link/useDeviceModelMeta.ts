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
  type DeviceApiKeyStatus,
} from './deviceModelMetaCache';
import { useMobileMakerTransport } from './useMobileMakerTransport';

export type { DeviceApiKeyStatus } from './deviceModelMetaCache';

/** 被控端视角的模型单价表;null = 还没拿到 / 拉不到(消费方隐藏价格)。 */
export function useDeviceModelPricing(deviceId?: string): MobileModelPricingMap | null {
  const maker = useMobileMakerTransport(deviceId ?? '');
  const [pricing, setPricing] = useState<MobileModelPricingMap | null>(
    deviceId ? getCachedDeviceModelPricing(deviceId) ?? null : null,
  );

  useEffect(() => {
    if (!deviceId) {
      setPricing(null);
      return;
    }
    const cached = getCachedDeviceModelPricing(deviceId);
    if (cached !== undefined) {
      setPricing(cached);
      return;
    }
    let cancelled = false;
    setPricing(null);
    void fetchDeviceModelPricing(deviceId, () => maker.getModelPricing()).then((res) => {
      if (!cancelled) setPricing(res ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, maker]);

  return pricing;
}

/** 被控端网关 API key presence;'unknown' = 还没拿到 / 拉不到(消费方不置灰折扣版)。 */
export function useDeviceApiKeyStatus(deviceId?: string): DeviceApiKeyStatus {
  const maker = useMobileMakerTransport(deviceId ?? '');
  const [status, setStatus] = useState<DeviceApiKeyStatus>(
    deviceId ? getCachedDeviceApiKeyStatus(deviceId) ?? 'unknown' : 'unknown',
  );

  useEffect(() => {
    if (!deviceId) {
      setStatus('unknown');
      return;
    }
    const cached = getCachedDeviceApiKeyStatus(deviceId);
    if (cached !== undefined) {
      setStatus(cached);
      return;
    }
    let cancelled = false;
    setStatus('unknown');
    void fetchDeviceApiKeyStatus(deviceId, () => maker.getApiKeyPresent()).then((res) => {
      if (!cancelled) setStatus(res ?? 'unknown');
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, maker]);

  return status;
}

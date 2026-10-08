/**
 * useDevicesProviders — 同时订阅多台电脑的供应商目录(只读快照)。
 *
 * 模型选择器的左侧栏要把「其他电脑上的供应商」与本机供应商并排列出(远程 Agent),台数
 * 不定,不能按台数调用 useDeviceProviders。这里复用 useDeviceProviders 的同一份缓存、
 * 代际驱逐与推送:未命中缓存的设备在这里发起预取,之后靠订阅事件刷新。
 *
 * 没有设备时什么都不读 —— 绝大多数选择器入口都走这条空路径。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import {
  getCachedDeviceProviders,
  prefetchDeviceProviders,
  subscribeDeviceProviders,
} from './useDeviceProviders';

export interface DeviceProvidersSnapshot {
  providers: ProviderView[];
  /** 那台电脑的「模型显示 / 隐藏」override 快照;undefined = 旧版,不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
  loading: boolean;
  error: string | null;
}

export function useDevicesProviders(
  deviceIds: readonly string[],
): ReadonlyMap<string, DeviceProvidersSnapshot> {
  const idsKey = deviceIds.join('\n');
  const [version, setVersion] = useState(0);
  const errorsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split('\n');
    let cancelled = false;
    const bump = () => {
      if (!cancelled) setVersion((value) => value + 1);
    };
    const unsubscribes = ids.map((deviceId) =>
      subscribeDeviceProviders(deviceId, (event) => {
        if (event.status === 'error') errorsRef.current.set(deviceId, event.error);
        else errorsRef.current.delete(deviceId);
        bump();
      }),
    );
    for (const deviceId of ids) {
      if (getCachedDeviceProviders(deviceId)) continue;
      // 结果(含失败)经上面的订阅事件回来;这里只负责发起。
      void prefetchDeviceProviders(deviceId).finally(bump);
    }
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [idsKey]);

  // 快照随订阅事件(version)与设备集合(idsKey)重建,两者不变时引用稳定。
  return useMemo(() => {
    void version;
    const result = new Map<string, DeviceProvidersSnapshot>();
    if (!idsKey) return result;
    for (const deviceId of idsKey.split('\n')) {
      const cached = getCachedDeviceProviders(deviceId);
      const error = cached ? null : (errorsRef.current.get(deviceId) ?? null);
      result.set(deviceId, {
        providers: cached?.providers ?? [],
        ...(cached?.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: cached.modelVisibilityOverrides }
          : {}),
        loading: !cached && error === null,
        error,
      });
    }
    return result;
  }, [idsKey, version]);
}

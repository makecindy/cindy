/**
 * useDeviceProviders(mobile)—— 拉取**被控端**(device-link)的模型供应商目录,用于
 * provider-aware 模型下拉(同一 model 可挂多家来源)。手机版始终是 device-link 控制端,
 * 故没有「本机供应商」分支:deviceId 非空就隧道 `maker:provider:list` 取被控端结构,
 * 被控端 dispatch 已剥离 routing 等执行字段、仅回显示用字段。
 *
 * 缓存 / 去重 / 代际驱逐核心在 `./deviceProvidersCache`(纯逻辑、node 可测);本文件只做
 * React 接线。优雅回退:被控端为旧版(allowlist 无 `maker:provider:list`)→ listProviders
 * reject → 暴露 error,调用方回退到基于 capabilities 的扁平模型列表。
 */
import { useEffect, useState } from 'react';

import type { ProviderView } from '@cindy/model-providers/registry';

import {
  fetchDeviceProviders,
  getCachedDeviceProviders,
  getDeviceProvidersGen,
  subscribeDeviceProviders,
  type DeviceProvidersPayload,
} from './deviceProvidersCache';
import { useMobileMakerTransport } from './useMobileMakerTransport';

export { evictDeviceProviders } from './deviceProvidersCache';

export interface UseDeviceProvidersResult {
  providers: ProviderView[];
  /** 被控端「模型显示/隐藏」override 快照;undefined = 旧被控端(列表不过滤)。 */
  modelVisibilityOverrides?: Record<string, boolean>;
  loading: boolean;
  /** 非 null = 拉取失败(典型:旧版被控端不识别通道);调用方据此回退扁平列表。 */
  error: string | null;
  /**
   * 「当前目录确为所选设备的就绪目录」——仅当 payload 来自该设备的缓存命中或拉取完成
   * (经订阅回调确认)才为 true。`loading === false` 不能替代本信号:loading 初始值就是
   * false(挂载 effect 尚未开拉)、切设备瞬间还会短暂保留上一设备的 payload
   * (codex review P1)。消费方做「目录就绪后」的判定(如来源终检)必须用 ready。
   */
  ready: boolean;
}

const EMPTY_PAYLOAD: DeviceProvidersPayload = { providers: [] };

/** 取被控设备的供应商目录;deviceId 省略 = 不拉取(返回空,调用方回退扁平列表)。 */
export function useDeviceProviders(deviceId?: string): UseDeviceProvidersResult {
  // hooks 规则:无条件取 transport(deviceId 空时其 call 会 reject,但本 hook 不会在空时调用)。
  const maker = useMobileMakerTransport(deviceId ?? '');
  const [payload, setPayload] = useState<DeviceProvidersPayload>(
    deviceId ? getCachedDeviceProviders(deviceId) ?? EMPTY_PAYLOAD : EMPTY_PAYLOAD,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ready 的判定载体:payload 已确认属于哪个设备 + 置位时的缓存代际。仅在缓存命中 /
  // 拉取完成(订阅回调)时置位;切设备 cache-miss 立即清 null。首渲染即按
  // `readyFor === deviceId` 计算,不依赖 effect 先跑,故无「loading 初值 false」窗口;
  // 代际比对兜住「同设备 evict 后重拉中/重拉失败」——旧 payload 在重拉窗口期不再
  // 被当作就绪目录(codex review P2)。
  const [readyFor, setReadyFor] = useState<string | null>(
    deviceId && getCachedDeviceProviders(deviceId) ? deviceId : null,
  );
  const [readyGen, setReadyGen] = useState<number>(() =>
    deviceId ? getDeviceProvidersGen(deviceId) : 0,
  );

  useEffect(() => {
    if (!deviceId) {
      setPayload(EMPTY_PAYLOAD);
      setError(null);
      setLoading(false);
      setReadyFor(null);
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeDeviceProviders(deviceId, (next) => {
      if (cancelled) return;
      setPayload(next);
      setError(null);
      setLoading(false);
      setReadyFor(deviceId);
      setReadyGen(getDeviceProvidersGen(deviceId));
    });
    const cached = getCachedDeviceProviders(deviceId);
    if (cached) {
      setPayload(cached);
      setError(null);
      // Reset loading on the cache-hit path too: if a prior device's fetch is still in flight
      // (loading=true) when we switch to a cached device, its cancelled `finally` won't clear it,
      // so the cache-hit return must, or the UI stays stuck "loading" over fully-populated data.
      setLoading(false);
      setReadyFor(deviceId);
      setReadyGen(getDeviceProvidersGen(deviceId));
      return unsubscribe;
    }
    // cache miss:先清空,避免 fetch 解析前(失败则永远)残留上一设备的供应商。
    setPayload(EMPTY_PAYLOAD);
    setLoading(true);
    setError(null);
    setReadyFor(null);
    fetchDeviceProviders(deviceId, () => maker.listProviders())
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [deviceId, maker]);

  return {
    providers: payload.providers,
    ...(payload.modelVisibilityOverrides !== undefined
      ? { modelVisibilityOverrides: payload.modelVisibilityOverrides }
      : {}),
    loading,
    error,
    ready: deviceId !== undefined
      && readyFor === deviceId
      && readyGen === getDeviceProvidersGen(deviceId),
  };
}

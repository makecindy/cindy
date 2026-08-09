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

import { useDeviceLink } from './DeviceLinkContext';
import {
  fetchDeviceProviders,
  fetchDeviceProvidersFresh,
  getCachedDeviceProviders,
  getDeviceFetchEpoch,
  getDeviceProvidersGen,
  markDeviceFetchEpoch,
  subscribeDeviceProviders,
  subscribeDeviceProvidersGen,
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
  // 连接代际:重连/恢复时 +1。离线驱逐(evict)后重拉失败时,依赖 [deviceId, maker]
  // 的 effect 不会因连接恢复重跑(maker.invoke 跨重连稳定,codex review P2)——把
  // connectionEpoch 纳入 effect 依赖,连接恢复即重跑 effect、经 cache-miss 重新
  // 拉取,不再永久停在 ready=false 的空目录。
  const { connectionEpoch } = useDeviceLink();
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
  const [readyFor, setReadyFor] = useState<string | null>(() => {
    if (!deviceId) return null;
    if (!getCachedDeviceProviders(deviceId)) return null;
    const cachedAtEpoch = getDeviceFetchEpoch(deviceId);
    // 缓存属旧连接代际(重连后 hook 重挂载)→ 首帧保持未就绪(codex review P2):
    // 否则消费者先看到一次 ready:true,外层 auto-default effect 可能按旧目录首行
    // 写草稿并设置 autoDefaultDeviceRef,fresh 目录到达后不再重新选默认项;由 effect
    // 判 reconnected 强制 fresh。无记录 = 该设备首次标记(缓存命中快路径语义)。
    if (cachedAtEpoch !== undefined && cachedAtEpoch !== connectionEpoch) return null;
    return deviceId;
  });
  const [readyGen, setReadyGen] = useState<number>(() =>
    deviceId ? getDeviceProvidersGen(deviceId) : 0,
  );
  // 各设备缓存写入时的连接代际存在模块级(deviceProvidersCache):重连(epoch
  // 变化)后缓存命中分支必须强制刷新(codex review P1)——relay 断线期间被控端
  // 可能已改供应商且无 provider push,缓存命中短路会让模型选择器无限期展示旧
  // 来源。模块级 Map 跨组件卸载存活:重连时 hook 未挂载 / 正查看其它设备,旧设备
  // 再打开仍能读到断线前代际 → reconnected → 强制 fresh(组件本地 ref 会随卸载
  // 丢失,把旧设备误判为首次挂载、采信断线前缓存,codex review P1)。无记录 =
  // 该设备首次标记(正常缓存命中快路径,与原 null 语义一致)。

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
      // payload 被采纳(拉取成功)才更新该设备缓存所属连接代际(codex review P1):
      // 若在 refresh 前就 mark 新 epoch,刷新失败后同 epoch 重挂载会把断线前旧
      // 缓存判为「未重连」直接标记就绪,且永不重试;只在成功路径更新,失败保持
      // 旧代际 → 下次 effect 重跑仍判定 reconnected → 重试 fresh。
      markDeviceFetchEpoch(deviceId, connectionEpoch);
    });
    // 代际变更(evict/clearAll/fresh 作废)主动推送:模块级 Map 变化不触发渲染,
    // 光靠渲染期代际比对,ready 失效要等下一次碰巧渲染(codex review P2)——收到
    // 通知立即失效,重拉完成经上面的 payload 订阅恢复。
    // 区分失效原因(greptile/codex review P1/P2):
    // - 'evict'(evict/clearAll 外部驱逐/登出切号):必须**清空展示但保持未就绪**——
    //   否则 payload 残留旧账号 + readyFor 被误置,暴露为 ready:true 的 loaded-empty;
    //   且 [deviceId, maker] effect 不因重新登录重跑,需显式重拉新账号目录;
    // - 'fresh-invalidate'(fresh 内部作废普通在途):**不得**启动替代普通请求——
    //   fresh 自身会写缓存并经 payload 订阅恢复;hook 重拉会与 fresh 竞争,普通
    //   响应较晚返回仍通过 isCurrent() 把 fresh 的新目录覆盖回旧目录。
    const unsubscribeGen = subscribeDeviceProvidersGen(deviceId, (reason) => {
      if (cancelled) return;
      setReadyFor(null);
      if (reason === 'fresh-invalidate') return;
      setPayload(EMPTY_PAYLOAD);
      void fetchDeviceProviders(deviceId, () => maker.listProviders())
        .catch((e: unknown) => {
          if (cancelled) return;
          // 暴露错误(codex review P2:在在线目录刷新失败后安排重试/暴露错误):
          // 静默吞掉失败会让模型选择器停在空目录且连接保持在线时 effect 不重跑
          // ——设置 error,调用方据此回退扁平模型列表;后续 provider 事件/重连/
          // 重挂载会再次触发刷新。失败保持未就绪(readyFor 已清)。
          setError(e instanceof Error ? e.message : String(e));
        });
    });
    const cached = getCachedDeviceProviders(deviceId);
    // 重连(connectionEpoch 变化)后缓存命中也要强制刷新(codex review P1):
    // relay 断线期间被控端可能已改供应商且无 provider push,直接短路会无限期
    // 展示旧来源。该设备无代际记录(首次标记)走正常缓存命中快路径。
    // 注:此处**不** mark 当前 epoch——mark 只发生在成功路径(payload 订阅回调 /
    // 缓存命中快路径),refresh 失败时保持旧代际,同 epoch 重挂载仍会重试 fresh。
    const prevEpoch = getDeviceFetchEpoch(deviceId);
    const reconnected = prevEpoch !== undefined && prevEpoch !== connectionEpoch;
    if (cached && !reconnected) {
      setPayload(cached);
      setError(null);
      // Reset loading on the cache-hit path too: if a prior device's fetch is still in flight
      // (loading=true) when we switch to a cached device, its cancelled `finally` won't clear it,
      // so the cache-hit return must, or the UI stays stuck "loading" over fully-populated data.
      setLoading(false);
      setReadyFor(deviceId);
      setReadyGen(getDeviceProvidersGen(deviceId));
      // 缓存命中快路径:当前缓存即当前 epoch 获取的,确认标记(不依赖订阅回调)。
      markDeviceFetchEpoch(deviceId, connectionEpoch);
      // 缓存命中分支也必须返回统一 cleanup(codex review P2):只退 payload 订阅会让
      // 代际订阅漏订存活——切走后旧设备的 evict 通知仍会 setReadyFor(null),误伤新设备。
      return () => {
        cancelled = true;
        unsubscribe();
        unsubscribeGen();
      };
    }
    if (cached && reconnected) {
      // 重连 + 缓存命中:旧目录先展示,但保持未就绪并强制 fresh 刷新拿工作站
      // 当前真相;成功经 payload 订阅恢复 ready(与 cache-miss 分支同恢复路径)。
      setPayload(cached);
      setLoading(true);
      setReadyFor(null);
      fetchDeviceProvidersFresh(deviceId, () => maker.listProviders())
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
        unsubscribeGen();
      };
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
      unsubscribeGen();
    };
  }, [connectionEpoch, deviceId, maker]);

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

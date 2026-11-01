/**
 * useProviderAccountUsage —— API Key 供应商余额/配额数据 hook。
 *
 * 与订阅卡的 useProviderSubscriptionCard 互补：那边读 OAuth 订阅配额，这边经
 * PROVIDER_ACCOUNT_USAGE 读供应商自己的账户接口。挂载时拉一次，之后每 60s 静默
 * 刷新一次（main 侧缓存优先 + 节流），失败同样在后续轮询重试。
 * 结果绑定连接、引擎和接入地址；切换身份或停用查询时不返回旧快照。
 *
 * `agent` 用于会话场景（输入框 chip）：同一供应商各引擎可用不同账户的独立密钥，
 * 传入会话所在引擎才能对准当前会话实际消耗的账户；设置页供应商级视图不传。
 * 组成员卡可用 live/active 暂停观察而保留在途结果，并用 refreshEpoch 排一次
 * 可取消的恢复补读；组实时卡每 15s 读取，默认调用保持一分钟与取消语义。
 */

import { isDeviceLinkRemotePushCurrent } from '../lib/remoteDataOwnerPushFence';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../contexts/dataOwnerGeneration';
import { isKimiCodingProviderView } from '../../shared/kimiCodingUsage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import {
  PROVIDER_ACCOUNT_USAGE_AGENTS,
  parseKimiAccountUsageResult,
  type ProviderAccountUsageResult,
} from '../../shared/providerAccountUsage';
import {
  hasDeepSeekOfficialRouteView,
  isZhipuCodingPlanProviderView,
} from '../lib/providerAccountUsageView';

export interface ProviderAccountUsageState {
  /** false = 该供应商没有可读的账户接口，调用方不应渲染模块。 */
  supported: boolean;
  result: ProviderAccountUsageResult | null;
  busy: boolean;
  refresh: () => void;
}

const REFRESH_INTERVAL_MS = 60_000;

export function useProviderAccountUsage(
  provider: ProviderView | undefined,
  agent?: AgentKind,
  deviceId: string | null = null,
  options: { live?: boolean; active?: boolean; refreshEpoch?: number } = {},
): ProviderAccountUsageState {
  const live = options.live === true;
  const active = !live || options.active !== false;
  const refreshEpoch = live ? options.refreshEpoch : undefined;
  const owner = getDataOwnerGeneration();
  const [revision, setRevision] = useState(0);
  const kimi = isKimiCodingProviderView(provider, agent);
  const supported =
    !!provider && !provider.removed && !provider.suspended && (!kimi || provider.connected) &&
    (!deviceId?.startsWith('share:')) &&
    (isKimiCodingProviderView(provider, agent)
      || (!deviceId && provider.auth?.method !== 'oauth' && (hasDeepSeekOfficialRouteView(provider) || isZhipuCodingPlanProviderView(provider))));
  const identity = JSON.stringify([
    owner,
    revision,
    deviceId,
    provider?.id,
    provider?.connected,
    agent,
    provider?.auth,
    (agent ? [agent] : PROVIDER_ACCOUNT_USAGE_AGENTS).map(
      (runtime) => provider?.routing[runtime],
    ),
  ]);
  const [state, setState] = useState<{
    identity: string;
    result: ProviderAccountUsageResult | null;
    busy: boolean;
  }>({ identity, result: null, busy: false });
  const requestId = useRef(0);
  // Visibility pauses observation, not this account identity. A live recovery
  // owns its trailing read until hidden/closed again; ordinary readers retain
  // their existing cancellation and newer-request-wins behavior.
  const lifecycle = useMemo(() => ({
    mounted: false,
    pending: 0,
    observed: false,
    liveRefreshes: new Set<object>(),
  }), [identity, supported, live]);

  const load = useCallback(
    async (forceRefresh: boolean, scheduling?: { background?: boolean }): Promise<void> => {
      if (!supported || !provider?.id) return;
      if (live && !forceRefresh && lifecycle.pending > 0) return;
      if (forceRefresh) lifecycle.liveRefreshes.clear();
      const id = ++requestId.current;
      lifecycle.pending++;
      setState((previous) => ({
        identity,
        result: previous.identity === identity ? previous.result : null,
        busy: true,
      }));
      try {
        const input = {
          providerId: provider.id,
          // Live polling must bypass the ordinary five-minute host cache;
          // the existing host throttle and Retry-After still apply.
          forceRefresh: forceRefresh || live,
          ...(agent ? { agent } : {}),
        };
        const next = deviceId
          ? parseKimiAccountUsageResult(await (scheduling
              ? window.electronAPI.deviceLink.invoke(deviceId, 'maker:usage:kimi-coding', [input], scheduling)
              : window.electronAPI.deviceLink.invoke(deviceId, 'maker:usage:kimi-coding', [input])))
          : await window.electronAPI.maker.fetchProviderAccountUsage(input);
        if (id === requestId.current && isDataOwnerGenerationCurrent(owner)) setState({ identity, result: next, busy: false });
      } catch {
        // IPC 异常也结束等待；只保留同一查询身份的已有快照。
        if (id === requestId.current && isDataOwnerGenerationCurrent(owner))
          setState((previous) => ({
            identity,
            result:
              previous.identity === identity && previous.result?.status === 'ready'
                ? { ...previous.result, stale: true, error: 'unknown' }
                : { status: 'unavailable', error: 'unknown' },
            busy: false,
          }));
      } finally {
        lifecycle.pending--;
        if (live && lifecycle.pending === 0 && lifecycle.liveRefreshes.size > 0) {
          lifecycle.liveRefreshes.clear();
          // The new observation owns recovery even if StrictMode replay has
          // invalidated the original request. A departed identity is unmounted.
          if (lifecycle.mounted && isDataOwnerGenerationCurrent(owner)) void load(false);
        }
      }
    },
    [provider?.id, agent, identity, supported, deviceId, owner, live, lifecycle],
  );

  useEffect(() => {
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.liveRefreshes.clear();
      // Identity changes and unmount still invalidate every late reply.
      requestId.current += 1;
    };
  }, [lifecycle]);

  useEffect(() => {
    if (!kimi) return;
    const changed = () => {
      lifecycle.liveRefreshes.clear();
      requestId.current += 1;
      setRevision(value => value + 1);
    };
    if (deviceId) return window.electronAPI.deviceLink.onRemotePush?.((push, stamp) => {
      if (push.deviceId === deviceId && push.channel === 'maker:provider:changed'
        && isDeviceLinkRemotePushCurrent(push, stamp)) changed();
    });
    return window.electronAPI.maker.onProvidersChanged?.(changed);
  }, [kimi, deviceId, lifecycle]);

  useEffect(() => {
    if (!supported || !active) return;
    const recovery = {};
    if (live && lifecycle.observed && lifecycle.pending > 0) lifecycle.liveRefreshes.add(recovery);
    lifecycle.observed = true;
    void load(false);
    // Expanded group cards use the 15s cadence; ordinary readers keep one minute.
    // Pending live reads are coalesced by load, and hidden cards have no timer.
    const timer = window.setInterval(() => void load(false, { background: true }), live ? 15_000 : REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      lifecycle.liveRefreshes.delete(recovery);
      if (!live) requestId.current += 1;
    };
  }, [supported, provider?.id, load, live, active, refreshEpoch, lifecycle]);

  return {
    supported: supported && active,
    result: supported && active && state.identity === identity ? state.result : null,
    busy: supported && active && state.identity === identity && state.busy,
    refresh: () => { if (active) void load(true); },
  };
}

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
import { isOpenCodeGoProviderView } from '../../shared/opencodeGoUsage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import {
  PROVIDER_ACCOUNT_USAGE_AGENTS,
  parseKimiAccountUsageResult,
  parseOpenCodeGoAccountUsageResult,
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

interface PendingOpenCodeRead {
  promise: Promise<ProviderAccountUsageResult>;
  observers: Set<object>;
  invalidated: boolean;
  invalidate: () => void;
}
let pendingOpenCodeOwner: ReturnType<typeof getDataOwnerGeneration> | undefined;
const pendingOpenCodeReads = new Map<string, PendingOpenCodeRead>();

/** Only share live automatic reads while pending, including an unmounted row.
 * No settled cache or retry loop: the reopened observer owns its trailing read.
 * Keep credential invalidation subscribed during the gap, then release it.
 */
function observePendingOpenCodeRead(
  owner: ReturnType<typeof getDataOwnerGeneration>,
  key: string,
  observer: object,
  read: () => Promise<ProviderAccountUsageResult>,
  subscribe: (invalidate: () => void) => (() => void) | undefined,
) {
  if (pendingOpenCodeOwner !== owner) {
    for (const pending of pendingOpenCodeReads.values()) pending.invalidate();
    pendingOpenCodeOwner = owner;
  }
  let pending = pendingOpenCodeReads.get(key);
  const resumed = !!pending && pending.observers.size === 0;
  if (!pending) {
    let unsubscribe: (() => void) | undefined;
    const release = () => { unsubscribe?.(); unsubscribe = undefined; };
    const entry: PendingOpenCodeRead = {
      observers: new Set(),
      invalidated: false,
      invalidate: () => {
        entry.invalidated = true;
        if (pendingOpenCodeReads.get(key) === entry) pendingOpenCodeReads.delete(key);
        release();
      },
      promise: Promise.resolve().then(read),
    };
    entry.promise = entry.promise.finally(() => {
      if (pendingOpenCodeReads.get(key) === entry) pendingOpenCodeReads.delete(key);
      release();
    });
    pendingOpenCodeReads.set(key, entry);
    unsubscribe = subscribe(entry.invalidate);
    pending = entry;
  }
  pending.observers.add(observer);
  return { pending, resumed };
}

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
  const opencodeGo = isOpenCodeGoProviderView(provider, agent);
  const structuredQuota = kimi || opencodeGo;
  const supported =
    !!provider && !provider.removed && !provider.suspended && (!structuredQuota || provider.connected) &&
    (!deviceId?.startsWith('share:')) &&
    (structuredQuota
      || (!deviceId && provider.auth?.method !== 'oauth' && (hasDeepSeekOfficialRouteView(provider) || isZhipuCodingPlanProviderView(provider))));
  const queryIdentity = JSON.stringify([
    owner,
    deviceId,
    provider?.id,
    provider?.connected,
    agent,
    provider?.auth,
    (agent ? [agent] : PROVIDER_ACCOUNT_USAGE_AGENTS).map(
      (runtime) => provider?.routing[runtime],
    ),
  ]);
  // Revision is hook-local; it must not prevent a newly mounted observer from
  // sharing a current query whose credential-change fence already advanced.
  const identity = JSON.stringify([queryIdentity, revision]);
  const currentQuery = useRef({ queryIdentity, supported, live });
  currentQuery.current = { queryIdentity, supported, live };
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
    recovery: null as object | null,
    sharedRead: null as PendingOpenCodeRead | null,
  }), [identity, supported, live]);

  const load = useCallback(
    async (forceRefresh: boolean, scheduling?: { background?: boolean }): Promise<void> => {
      if (!supported || !provider?.id || !isDataOwnerGenerationCurrent(owner)) return;
      if (live && !forceRefresh && lifecycle.pending > 0) return;
      if (forceRefresh) lifecycle.liveRefreshes.clear();
      const id = ++requestId.current;
      lifecycle.pending++;
      let sharedRead: PendingOpenCodeRead | null = null;
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
        const parseResult = opencodeGo ? parseOpenCodeGoAccountUsageResult : parseKimiAccountUsageResult;
        const channel = opencodeGo ? 'maker:usage:opencode-go' : 'maker:usage:kimi-coding';
        const read = async () => deviceId
          ? parseResult(await (scheduling
              ? window.electronAPI.deviceLink.invoke(deviceId, channel, [input], scheduling)
              : window.electronAPI.deviceLink.invoke(deviceId, channel, [input])))
          : await window.electronAPI.maker.fetchProviderAccountUsage(input);
        let next: ProviderAccountUsageResult;
        if (live && opencodeGo && !forceRefresh) {
          const observed = observePendingOpenCodeRead(owner, queryIdentity, lifecycle, read, invalidate => {
            if (deviceId) return window.electronAPI.deviceLink.onRemotePush?.((push, stamp) => {
              if (push.deviceId === deviceId && push.channel === 'maker:provider:changed'
                && isDeviceLinkRemotePushCurrent(push, stamp)) invalidate();
            });
            return window.electronAPI.maker.onProvidersChanged?.(invalidate);
          });
          sharedRead = observed.pending;
          lifecycle.sharedRead = sharedRead;
          if (observed.resumed && lifecycle.recovery) lifecycle.liveRefreshes.add(lifecycle.recovery);
          next = await sharedRead.promise;
        } else next = await read();
        if (!sharedRead?.invalidated && id === requestId.current && isDataOwnerGenerationCurrent(owner)) setState({ identity, result: next, busy: false });
      } catch {
        // IPC 异常也结束等待；只保留同一查询身份的已有快照。
        if (!sharedRead?.invalidated && id === requestId.current && isDataOwnerGenerationCurrent(owner))
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
    [provider?.id, agent, identity, queryIdentity, supported, deviceId, owner, opencodeGo, live, lifecycle],
  );

  useEffect(() => {
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.liveRefreshes.clear();
      const shared = lifecycle.sharedRead;
      if (shared?.observers.size === 1 && (currentQuery.current.queryIdentity !== queryIdentity ||
        !currentQuery.current.supported || !currentQuery.current.live)) shared.invalidate();
      shared?.observers.delete(lifecycle);
      // Identity changes and unmount still invalidate every late reply.
      requestId.current += 1;
    };
  }, [lifecycle, queryIdentity]);

  useEffect(() => {
    if (!structuredQuota) return;
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
  }, [structuredQuota, deviceId, lifecycle]);

  useEffect(() => {
    if (!supported || !active) return;
    const recovery = {};
    lifecycle.recovery = recovery;
    if (live && lifecycle.observed && lifecycle.pending > 0) lifecycle.liveRefreshes.add(recovery);
    lifecycle.observed = true;
    void load(false);
    // Expanded group cards use the 15s cadence; ordinary readers keep one minute.
    // Pending live reads are coalesced by load, and hidden cards have no timer.
    const timer = window.setInterval(() => void load(false, { background: true }), live ? 15_000 : REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      lifecycle.liveRefreshes.delete(recovery);
      if (lifecycle.recovery === recovery) lifecycle.recovery = null;
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

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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import {
  PROVIDER_ACCOUNT_USAGE_AGENTS,
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
): ProviderAccountUsageState {
  const supported =
    !!provider &&
    provider.auth?.method !== 'oauth' &&
    (hasDeepSeekOfficialRouteView(provider) || isZhipuCodingPlanProviderView(provider));
  const identity = JSON.stringify([
    provider?.id,
    agent,
    provider?.auth?.method,
    (agent ? [agent] : PROVIDER_ACCOUNT_USAGE_AGENTS).map(
      (runtime) => provider?.routing[runtime]?.upstream,
    ),
  ]);
  const [state, setState] = useState<{
    identity: string;
    result: ProviderAccountUsageResult | null;
    busy: boolean;
  }>({ identity, result: null, busy: false });
  const requestId = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!supported || !provider?.id) return;
      const id = ++requestId.current;
      setState((previous) => ({
        identity,
        result: previous.identity === identity ? previous.result : null,
        busy: true,
      }));
      try {
        const next = await window.electronAPI.maker.fetchProviderAccountUsage({
          providerId: provider.id,
          forceRefresh,
          ...(agent ? { agent } : {}),
        });
        if (id === requestId.current) setState({ identity, result: next, busy: false });
      } catch {
        // IPC 异常也结束等待；只保留同一查询身份的已有快照。
        if (id === requestId.current)
          setState((previous) => ({
            identity,
            result:
              previous.identity === identity && previous.result?.status === 'ready'
                ? { ...previous.result, stale: true, error: 'unknown' }
                : { status: 'unavailable', error: 'unknown' },
            busy: false,
          }));
      }
    },
    [provider?.id, agent, identity, supported],
  );

  useEffect(() => {
    if (!supported) return;
    void load(false);
    // 余额/窗口会随使用变化，挂载期间低频静默刷新（main 缓存优先，不会放大上游请求）。
    const timer = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      // 停用、切换或卸载后，迟到响应不得再提交。
      requestId.current += 1;
    };
  }, [supported, provider?.id, load]);

  return {
    supported,
    result: supported && state.identity === identity ? state.result : null,
    busy: supported && state.identity === identity && state.busy,
    refresh: () => void load(true),
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentKind } from '@cindy/model-providers';
import type { ProviderAccountUsageResult } from '../../shared/providerAccountUsage';

export interface ProviderAccountUsageRuntimeState {
  result: ProviderAccountUsageResult | null;
  refreshing: boolean;
}

export function useProviderAccountUsage(
  providerId: string,
  agents: readonly AgentKind[],
  catalogRevision: unknown,
): {
  states: Partial<Record<AgentKind, ProviderAccountUsageRuntimeState>>;
  refresh(agent: AgentKind): void;
} {
  const agentsKey = agents.join('\0');
  const activeAgents = useMemo(
    () => (agentsKey ? (agentsKey.split('\0') as AgentKind[]) : []),
    [agentsKey],
  );
  // 身份只跟「换供应商 / 换 runtime 集合」走。catalogRevision 变化只触发重新请求
  // （保留旧快照、置 refreshing，对齐手动 refresh），不换身份——否则每次 PROVIDER_CHANGED
  // 重建 ProviderView 都会把已显示的余额清空成「正在更新…」（PR #3472 review）。
  const identity = useMemo(
    () => Symbol('provider-account-usage-identity'),
    [agentsKey, providerId],
  );
  const [scopedStates, setScopedStates] = useState<{
    identity: symbol;
    states: Partial<Record<AgentKind, ProviderAccountUsageRuntimeState>>;
  }>({ identity, states: {} });
  const sequence = useRef(new Map<AgentKind, number>());

  const request = useCallback((agent: AgentKind, forceRefresh: boolean) => {
    const token = (sequence.current.get(agent) ?? 0) + 1;
    sequence.current.set(agent, token);
    setScopedStates((current) => {
      const states = current.identity === identity ? current.states : {};
      return {
        identity,
        states: {
          ...states,
          [agent]: {
            result: states[agent]?.result ?? null,
            refreshing: true,
          },
        },
      };
    });
    void window.electronAPI.maker
      .getProviderAccountUsage({
        providerId,
        agent,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      })
      .catch((): ProviderAccountUsageResult => ({ status: 'unavailable', error: 'network' }))
      .then((result) => {
        if (sequence.current.get(agent) !== token) return;
        setScopedStates((current) => {
          if (current.identity !== identity) return current;
          return {
            identity,
            states: {
              ...current.states,
              [agent]: { result, refreshing: false },
            },
          };
        });
      });
  }, [identity, providerId]);

  useEffect(() => {
    const configured = new Set(activeAgents);
    for (const agent of activeAgents) request(agent, false);
    return () => {
      for (const agent of configured) {
        sequence.current.set(agent, (sequence.current.get(agent) ?? 0) + 1);
      }
    };
  }, [activeAgents, catalogRevision, providerId, request]);

  const refresh = useCallback((agent: AgentKind) => request(agent, true), [request]);
  const states = useMemo(
    () => scopedStates.identity === identity
      ? scopedStates.states
      : Object.fromEntries(
        activeAgents.map((agent) => [agent, { result: null, refreshing: true }]),
      ) as Partial<Record<AgentKind, ProviderAccountUsageRuntimeState>>,
    [activeAgents, identity, scopedStates],
  );
  return { states, refresh };
}

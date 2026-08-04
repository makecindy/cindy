/**
 * useConnectedSource —— 单一判定：某 `(agent, model?)`「有没有已连接（link 上）的可选来源」。
 *
 * 这是整个产品「是否进入『连接来源』空態」的**唯一真相**，与 agent 类型无关（agent 只是入参）：
 *   传 modelId 时必须进一步确认来源真的提供该模型；不传时只按 agent 判断（旧入口兼容）。
 *
 * 所有渲染期消费方都从这一处取值，避免各自重算导致漂移：
 *   - ModelSelector trigger：无来源 → 化成「连接来源」CTA
 *   - ChatInput Send 按钮：无来源 → 禁用
 *   - （send 门禁 useVendorReadiness 走同一条 `connectedProvidersForAgent` 规则，只是在发送
 *     时刻现拉一次连接态以避免 stale，不依赖渲染期快照——判定逻辑同源、取数时机不同。）
 *
 * 数据来自 useProviders 的本地快照（模块级缓存，鉴权态变更自动刷新）。`loading` 期间
 * `hasConnectedSource` 不可信，调用方应据 `loading` 决定是否先不进空態（有缓存的老用户不闪）。
 */

import { useMemo } from 'react';

import { chatEligibleSourcesForModel, connectedProvidersForAgent, type AgentKind } from '@cindy/model-providers';

import { useProviders } from './useProviders';

export interface UseConnectedSourceReturn {
  /** 该 agent 是否至少有一个已连接的可选来源（agent 为 null 时恒 false）。 */
  hasConnectedSource: boolean;
  /** 供应商连接态首帧加载中（true 时 hasConnectedSource 尚不可信）。 */
  loading: boolean;
}

export function useConnectedSource(agent: AgentKind | null, modelId?: string): UseConnectedSourceReturn {
  const { providers, loading } = useProviders();
  const hasConnectedSource = useMemo(
    () => {
      if (!agent) return false;
      // chatEligibleSourcesForModel(不是裸 sourcesForModel):非聊天模型不该被判定为
      // "有可用来源"(issue #882 第 3 点,2026-07 review)——本 hook 是整个产品"要不要
      // 进连接来源空态"的唯一真相,漏这个过滤会让 ModelSelector CTA 和 Send 按钮对
      // 一个非聊天模型显示"已连接、可以发"。
      return modelId
        ? chatEligibleSourcesForModel(providers, modelId, agent).length > 0
        : connectedProvidersForAgent(providers, agent).length > 0;
    },
    [providers, agent, modelId],
  );
  return { hasConnectedSource, loading };
}

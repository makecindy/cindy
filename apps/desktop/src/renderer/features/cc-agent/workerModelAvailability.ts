import {
  visibleModelUnion,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { filterChatBridgedCodexProviders } from '@/lib/providerModels';
import { isSubscriptionDirectModel } from '../../../shared/subscriptionModels';

export interface SelectWorkerModelsOptions {
  agent: AgentKind;
  capabilities: AgentCapabilities | null;
  deviceId?: string;
  providers: ProviderView[];
  providersLoading: boolean;
  providersError: string | null;
  /** 仅结构化确认旧端没有 provider:list 时允许 capabilities-only 回退。 */
  providersUnsupported?: boolean;
  /** Local-only provider model visibility. Device-link peers own their own visibility choices. */
  isVisible?: (providerId: string, model: CatalogModel) => boolean;
  /**
   * 过滤订阅直连模型(chatgpt/ / xai/)。SSH 远程 Lead(remoteHostId)必须传 true:
   * bridge 只挂在本地 compat-proxy,远程走 remoteEndpoint 不经翻译,选了必失败
   * (与 ChatInput 的同名开关同口径;main 侧 orcaWorkerCreationService 会拒绝,
   * 这里在提交前就把不可路由的选项藏起来)。
   */
  excludeSubscriptionDirect?: boolean;
  /**
   * 过滤 `wireProtocol: 'openai-chat'` 的 Codex 供应商:Responses→Chat 桥只挂在本地
   * codex-proxy,SSH 远程走 daemon transport 不经它。SSH 远程 Lead 必须传 true。
   */
  excludeChatBridgedCodex?: boolean;
}

/**
 * Resolve the models that the Worker creation form may submit.
 *
 * Capabilities define what the agent can understand, while the connected provider snapshot defines
 * what it can actually execute. Local creation also applies the user's per-provider visibility
 * choices, so a remembered hidden model cannot bypass the picker and be submitted directly.
 * Older device-link peers that do not implement `maker:provider:list` fall back to that same
 * device's capabilities, never to the controller's provider catalog or visibility choices.
 */
export function selectWorkerModels({
  agent,
  capabilities,
  deviceId,
  providers,
  providersLoading,
  providersError,
  providersUnsupported,
  isVisible,
  excludeSubscriptionDirect,
  excludeChatBridgedCodex,
}: SelectWorkerModelsOptions): ModelDescriptor[] {
  const models = capabilities?.availableModels ?? [];

  if (!deviceId) {
    // SSH 远程 Lead 与本地共用这份 provider 清单(worker 继承 remoteHostId 在远端
    // spawn,但目录快照来自本机) — 先按 SSH 口径剔除仅本地可桥接的来源,再取并集,
    // 与 selectVisibleModels 的 excludeProvider 语义一致(同 id 另有可路由来源仍补上)。
    const routedProviders = filterChatBridgedCodexProviders(
      providers,
      agent,
      excludeChatBridgedCodex === true,
    );
    const selectableIds = new Set(
      visibleModelUnion(routedProviders, agent, isVisible ?? (() => true)).map(
        (model) => model.id,
      ),
    );
    const selectable = models.filter((model) => selectableIds.has(model.id));
    return excludeSubscriptionDirect
      ? selectable.filter((model) => !isSubscriptionDirectModel(model.id))
      : selectable;
  }

  if (providersError) return providersUnsupported ? models : [];
  if (providersLoading) return [];

  const executableIds = new Set(
    visibleModelUnion(providers, agent, () => true).map((model) => model.id),
  );
  return models.filter((model) => executableIds.has(model.id));
}

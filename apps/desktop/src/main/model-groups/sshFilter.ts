/**
 * SSH 远程主机智能路由候选过滤(纯 Node，Desktop 与 Node Host 共用)：
 * - 禁止跨 agentDeviceId(SSH 与远程 Agent / 分享供应商互斥)
 * - 禁止订阅直连前缀模型(chatgpt/、xai/ 等本机代理桥接模型)
 * - Codex 仅允许目标 SSH 主机原生 `openai` 订阅目录中存在的模型
 * - Claude Code / Pi 剔除 `isLocalOnlyProviderForAgent` 标为仅本机可用的来源
 */
import {
  isLocalOnlyProviderForAgent,
  isSubscriptionDirectModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import type { ModelGroupCandidate } from '../../shared/modelGroups.js';

const SSH_CODEX_CACHE_TTL_MS = 15_000;

export function createSshModelGroupFilter(ports: {
  listSshCodexProviders?: (hostId: string) => Promise<ProviderView[]>;
  now?: () => number;
}) {
  const codexCache = new Map<string, { at: number; models: Set<string> | null }>();
  const now = ports.now ?? Date.now;

  async function sshCodexModels(hostId: string): Promise<Set<string> | null> {
    if (!ports.listSshCodexProviders) return null;
    const cached = codexCache.get(hostId);
    if (cached && now() - cached.at < SSH_CODEX_CACHE_TTL_MS) return cached.models;
    try {
      const views = await ports.listSshCodexProviders(hostId);
      const ids = new Set((views[0]?.models.codex ?? []).map((item) => item.id));
      codexCache.set(hostId, { at: now(), models: ids });
      return ids;
    } catch {
      codexCache.set(hostId, { at: now(), models: null });
      return null;
    }
  }

  return async function sshFilter(
    sshHostId: string,
    candidate: ModelGroupCandidate,
    view: ProviderView | undefined,
  ): Promise<boolean> {
    if (candidate.agentDeviceId) return false;
    if (isSubscriptionDirectModel(candidate.model)) return false;
    if (candidate.agentKind === 'codex') {
      if (candidate.providerId !== 'openai') return false;
      const remoteModels = await sshCodexModels(sshHostId);
      // 读不到远端 Codex 目录时拒绝，不把本机 Codex 错路由过去。
      return !!remoteModels && remoteModels.has(candidate.model);
    }
    const agent: AgentKind = candidate.agentKind === 'cc' ? 'claude-code' : 'pi';
    if (!view) return false;
    return !isLocalOnlyProviderForAgent(view, agent);
  };
}

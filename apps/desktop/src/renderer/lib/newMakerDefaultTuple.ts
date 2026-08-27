import {
  isModelSelectableForNewRoute,
  type AgentKind,
  type Effort,
  type ProviderView,
} from '@cindy/model-providers';

import type { MakerVendor } from '@/lib/ccAgent.types';

export interface NewMakerDefaultTuple {
  vendor: Extract<MakerVendor, 'cc' | 'codex' | 'pi'>;
  providerId: string;
  model: string;
  effort: Effort | null;
}

interface ProviderDefaultPolicy {
  providerId: 'openai' | 'anthropic' | 'xai' | 'xd';
  accessKind: 'subscription' | 'managed';
  agents: readonly AgentKind[];
  modelIds: readonly string[];
  requireNewSessionDefault?: boolean;
  requireImageInput?: boolean;
}

/**
 * 新用户的产品默认顺序。
 *
 * 订阅永远先于 Gateway；多订阅又没有“最近连接时间”可用时，固定按
 * OpenAI → Anthropic → xAI，避免依赖目录下发顺序造成升级后随机换默认。
 * 每个来源的首个 agent 是推荐 Harness，其余只在本机没有安装首选 Harness 时降级。
 */
const DEFAULT_POLICIES: readonly ProviderDefaultPolicy[] = [
  {
    providerId: 'openai',
    accessKind: 'subscription',
    agents: ['codex', 'claude-code', 'pi'],
    modelIds: ['chatgpt/gpt-5.6-sol', 'gpt-5.6-sol'],
  },
  {
    providerId: 'anthropic',
    accessKind: 'subscription',
    agents: ['claude-code', 'codex', 'pi'],
    modelIds: ['claude-opus-5', 'anthropic/claude-opus-5'],
  },
  {
    providerId: 'xai',
    accessKind: 'subscription',
    agents: ['pi', 'codex', 'claude-code'],
    modelIds: ['grok-4.6', 'xai/grok-4.6'],
  },
  {
    providerId: 'xd',
    accessKind: 'managed',
    agents: ['pi'],
    modelIds: ['z-ai/glm-5.3-flash', 'glm-5.3-flash'],
    requireNewSessionDefault: true,
    requireImageInput: true,
  },
];

function vendorForAgent(agent: AgentKind): NewMakerDefaultTuple['vendor'] {
  return agent === 'claude-code' ? 'cc' : agent;
}

/**
 * 仅供旧草稿迁移辨认“产品曾自动写入的 tuple 身份”。这里不判断账号实时可用性，
 * 也不产生默认值；真正下放仍只能走 resolveNewMakerDefaultTuple 的实时能力门控。
 */
export function isKnownProductDefaultTupleIdentity(args: {
  vendor: MakerVendor;
  providerId: string;
  model: string;
}): boolean {
  return DEFAULT_POLICIES.some(
    (policy) =>
      policy.providerId === args.providerId &&
      policy.modelIds.includes(args.model) &&
      policy.agents.some((agent) => vendorForAgent(agent) === args.vendor),
  );
}

function supportsImageInput(model: NonNullable<ProviderView['models'][AgentKind]>[number]): boolean {
  return (
    model.supportsImageInput === true || model.modalities?.input.includes('image') === true
  );
}

function matchingModel(
  provider: ProviderView,
  agent: AgentKind,
  modelIds: readonly string[],
  requireNewSessionDefault = false,
  requireImageInput = false,
) {
  const models = provider.models[agent] ?? [];
  return modelIds
    .map((id) => models.find((model) => model.id === id))
    .find(
      (model) =>
        model !== undefined &&
        model.defaultEnabled !== false &&
        model.efforts.includes('high') &&
        (!requireNewSessionDefault || model.newSessionDefault?.includes(agent) === true) &&
        (!requireImageInput || supportsImageInput(model)) &&
        isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
    );
}

/**
 * 为“尚未自定义”的本地新任务挑一份完整默认组合。
 *
 * 返回 null 表示没有足够证据给默认值：供应商仍在加载、没有可用来源，或推荐模型不在
 * 当前账号目录里。调用方此时保留连接引导/既有空态，绝不编造一个看似可发送的组合。
 */
export function resolveNewMakerDefaultTuple(args: {
  providers: readonly ProviderView[];
  providersLoading: boolean;
  availableAgents: ReadonlySet<MakerVendor>;
  availableAgentsLoaded: boolean;
}): NewMakerDefaultTuple | null {
  const { providers, providersLoading, availableAgents, availableAgentsLoaded } = args;
  if (providersLoading || !availableAgentsLoaded) return null;

  for (const policy of DEFAULT_POLICIES) {
    const provider = providers.find(
      (candidate) =>
        candidate.id === policy.providerId &&
        candidate.connected &&
        !candidate.suspended &&
        !candidate.modelDiscoveryFailure &&
        candidate.access?.kind === policy.accessKind,
    );
    if (!provider) continue;

    for (const agent of policy.agents) {
      const vendor = vendorForAgent(agent);
      if (!availableAgents.has(vendor)) continue;
      const model = matchingModel(
        provider,
        agent,
        policy.modelIds,
        policy.requireNewSessionDefault,
        policy.requireImageInput,
      );
      if (!model) continue;
      return {
        vendor,
        providerId: provider.id,
        model: model.id,
        effort: 'high',
      };
    }
  }
  return null;
}

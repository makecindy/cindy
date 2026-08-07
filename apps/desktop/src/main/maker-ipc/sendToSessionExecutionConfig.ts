import type { AgentKind, Effort } from '@cindy/maker-core';

import {
  budgetModelRequiresApiKey,
  budgetModelRequiresApiKeyMessage,
  type OrcaWorkerProviderRoutingContext,
  type OrcaWorkerProviderSnapshot,
} from './orcaWorkerCreationService.js';

interface ModelCapabilities {
  id: string;
  efforts?: readonly string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
}

export interface SendToSessionExecutionConfig {
  agentKind: AgentKind;
  model: string;
  effort?: Effort;
  fastMode: boolean;
  providerId?: string | null;
}

export interface SendToSessionExecutionOverrides {
  agentKind?: AgentKind;
  model?: string;
  effort?: Effort;
  fastMode?: boolean;
}

export type SendToSessionExecutionConfigResult =
  | { ok: true; config: SendToSessionExecutionConfig }
  | {
      ok: false;
      errorCode:
        | 'INVALID_ARGS'
        | 'BUDGET_MODEL_REQUIRES_API_MODE'
        | 'PROVIDER_ROUTE_UNAVAILABLE';
      message: string;
    };

function normalizeEffort(params: {
  model: ModelCapabilities;
  effort: Effort | undefined;
  explicit: boolean;
}): { ok: true; effort?: Effort } | { ok: false; message: string } {
  const { model, effort, explicit } = params;
  const validEfforts = model.efforts ?? [];
  const defaultEffort = model.defaultEffort ?? undefined;
  if (effort === undefined) {
    return {
      ok: true,
      effort: defaultEffort && validEfforts.includes(defaultEffort)
        ? defaultEffort as Effort
        : undefined,
    };
  }
  if (validEfforts.includes(effort)) return { ok: true, effort };
  if (!explicit) {
    if (effort === 'minimal' && validEfforts.includes('low')) return { ok: true, effort: 'low' };
    if (effort === 'ultra' && validEfforts.includes('max')) return { ok: true, effort: 'max' };
    if (effort === 'ultra' && validEfforts.includes('xhigh')) return { ok: true, effort: 'xhigh' };
    if (effort === 'max' && validEfforts.includes('xhigh')) return { ok: true, effort: 'xhigh' };
    if (effort === 'xhigh' && validEfforts.includes('max')) return { ok: true, effort: 'max' };
    return {
      ok: true,
      effort: defaultEffort && validEfforts.includes(defaultEffort)
        ? defaultEffort as Effort
        : undefined,
    };
  }
  return {
    ok: false,
    message:
      `effort "${effort}" not supported by model "${model.id}". `
      + `valid: ${validEfforts.join(', ') || 'none'}`,
  };
}

function providerRouteUnavailableMessage(agent: AgentKind, model: string): string {
  return (
    `${agent} 当前没有已连接的供应商提供模型 "${model}"，`
    + '请调整模型或在「设置 → 模型供应商」连接对应供应商后重试。'
  );
}

function routeProviderFor(params: {
  agentKind: AgentKind;
  model: string;
  sourceProviderId?: string | null;
  routeChanged: boolean;
  providerRouting: OrcaWorkerProviderRoutingContext;
}):
  | {
      ok: true;
      provider: OrcaWorkerProviderSnapshot;
      providerId?: string | null;
    }
  | { ok: false; message: string } {
  const {
    agentKind,
    model,
    sourceProviderId,
    routeChanged,
    providerRouting,
  } = params;
  const providers = providerRouting.availability[agentKind] ?? [];
  const offering = providers.filter((provider) => provider.models.includes(model));
  if (offering.length === 0) {
    return { ok: false, message: providerRouteUnavailableMessage(agentKind, model) };
  }

  if (!routeChanged && sourceProviderId) {
    const inherited = offering.find((provider) => provider.id === sourceProviderId);
    if (!inherited) {
      return {
        ok: false,
        message:
          `供应商 "${sourceProviderId}" 当前未连接，或不再为 ${agentKind} 提供模型 "${model}"。`
          + '请在「设置 → 模型供应商」检查连接与模型配置后重试。',
      };
    }
    return { ok: true, provider: inherited, providerId: sourceProviderId };
  }

  const defaultProviderId = providerRouting.resolveDefaultProviderIdForModel(agentKind, model);
  const provider = defaultProviderId
    ? offering.find((candidate) => candidate.id === defaultProviderId)
    : undefined;
  if (!provider) {
    return { ok: false, message: providerRouteUnavailableMessage(agentKind, model) };
  }
  return {
    ok: true,
    provider,
    providerId: routeChanged
      ? (provider.requiresExplicitRoute ? provider.id : null)
      : sourceProviderId,
  };
}

/**
 * 解析普通 session create 的显式执行配置。模型身份来自 Maker 能力目录，来源与
 * effort/Fast 能力来自和 Orca worker 共用的已连接 provider 快照；不猜默认模型、
 * 不静默换模型。跨 Agent/model 时不携带来源会话的 provider，按现有默认路由落点
 * 重新解析；唯一且必须显式写入来源的 provider 会保留其 id 供凭证注入。
 */
export function resolveSendToSessionExecutionConfig(params: {
  source: SendToSessionExecutionConfig;
  overrides: SendToSessionExecutionOverrides;
  availableModels: readonly ModelCapabilities[];
  providerRouting: OrcaWorkerProviderRoutingContext;
  hasCindyAiApiKey: boolean;
}): SendToSessionExecutionConfigResult {
  const { source, overrides } = params;
  const agentKind = overrides.agentKind ?? source.agentKind;
  const model = overrides.model ?? source.model;
  const modelCapabilities = params.availableModels.find((candidate) => candidate.id === model);
  if (!modelCapabilities) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message:
        `model "${model}" not available for ${agentKind}. `
        + `valid: ${params.availableModels.map((candidate) => candidate.id).join(', ') || 'none'}`,
    };
  }

  const routeChanged = agentKind !== source.agentKind || model !== source.model;
  const budgetRouteProviderId = !routeChanged && source.providerId
    ? source.providerId
    : params.providerRouting.resolveDefaultProviderIdForModel(agentKind, model);
  if (
    budgetModelRequiresApiKey(agentKind, model, params.hasCindyAiApiKey)
    && (budgetRouteProviderId === null || budgetRouteProviderId === 'xd')
  ) {
    return {
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: budgetModelRequiresApiKeyMessage(model),
    };
  }

  const route = routeProviderFor({
    agentKind,
    model,
    sourceProviderId: source.providerId,
    routeChanged,
    providerRouting: params.providerRouting,
  });
  if (!route.ok) {
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: route.message,
    };
  }

  const routeEffortMeta = route.provider.effortMetaByModel?.[model];
  const effortCapabilities = routeEffortMeta
    ? {
        id: model,
        efforts: routeEffortMeta.efforts,
        defaultEffort: routeEffortMeta.defaultEffort,
      }
    : modelCapabilities;
  const normalizedEffort = normalizeEffort({
    model: effortCapabilities,
    effort: overrides.effort ?? source.effort,
    explicit: overrides.effort !== undefined,
  });
  if (!normalizedEffort.ok) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: normalizedEffort.message,
    };
  }

  const supportsFast = route.provider.fastModels
    ? route.provider.fastModels.includes(model)
    : modelCapabilities.supportsFastMode === true;
  if (overrides.fastMode === true && !supportsFast) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: `fast mode is not supported by ${agentKind} model "${model}"`,
    };
  }
  const fastMode = overrides.fastMode
    ?? (routeChanged ? source.fastMode && supportsFast : source.fastMode);
  const effort = overrides.effort !== undefined || routeChanged
    ? normalizedEffort.effort
    : source.effort;

  return {
    ok: true,
    config: {
      agentKind,
      model,
      effort,
      fastMode,
      providerId: route.providerId,
    },
  };
}

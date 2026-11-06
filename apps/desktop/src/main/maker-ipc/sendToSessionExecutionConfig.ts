import type { AgentKind, Effort } from '@cindy/maker-core';

import {
  budgetModelRequiresApiKey,
  budgetModelRequiresApiKeyMessage,
  resolveRequestedAgentDeviceId,
  type OrcaWorkerProviderRoutingContext,
  type OrcaWorkerProviderSnapshot,
} from './orcaWorkerCreationService.js';

interface ModelCapabilities {
  id: string;
  efforts?: readonly string[];
  defaultEffort?: string | null;
  /** true = 没有任何来源声明过档位,efforts 只是占位;显式档位交给引擎裁决而不是拒绝(#5535)。 */
  effortsUnknown?: boolean;
  supportsFastMode?: boolean;
  supportsUltrafastMode?: boolean;
}

export interface SendToSessionExecutionConfig {
  agentKind: AgentKind;
  model: string;
  effort?: Effort;
  fastMode: boolean | 'ultrafast';
  providerId?: string | null;
}

export interface SendToSessionExecutionOverrides {
  agentKind?: AgentKind;
  model?: string;
  effort?: Effort;
  fastMode?: boolean | 'ultrafast';
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
  // 未声明档位(#5535):自定义来源的模型只填了 id/name 时,目录与路由快照都没有档位声明,
  // 这里的 [] 只是占位而不是「valid: none」。显式档位原样放行交给引擎/供应商裁决;
  // 明确无档位(reasoning:false / 已声明空表)与已声明列表仍按下面的规则校验。
  if (explicit && model.effortsUnknown === true) return { ok: true, effort };
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
  /** 新任务的 Agent 换了电脑：来源的 provider 不在那台，按目标电脑重新解析；缺模型算没有路由。 */
  locationChanged?: boolean;
}): SendToSessionExecutionConfigResult {
  const { source, overrides } = params;
  const agentKind = overrides.agentKind ?? source.agentKind;
  const model = overrides.model ?? source.model;
  const modelCapabilities = params.availableModels.find((candidate) => candidate.id === model);
  if (!modelCapabilities) {
    return {
      ok: false,
      errorCode: params.locationChanged ? 'PROVIDER_ROUTE_UNAVAILABLE' : 'INVALID_ARGS',
      message:
        `model "${model}" not available for ${agentKind}`
        + `${params.locationChanged ? ' on the selected agent_device_id' : ''}. `
        + `valid: ${params.availableModels.map((candidate) => candidate.id).join(', ') || 'none'}`,
    };
  }

  const routeChanged = params.locationChanged === true
    || agentKind !== source.agentKind
    || model !== source.model;
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
        effortsUnknown: routeEffortMeta.effortsUnknown,
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
  const supportsUltrafast = agentKind === 'codex'
    && route.provider.ultrafastModels?.includes(model) === true;
  if (overrides.fastMode && (!supportsFast || (overrides.fastMode === 'ultrafast' && !supportsUltrafast))) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: `fast mode is not supported by ${agentKind} model "${model}"`,
    };
  }
  const fastMode = overrides.fastMode
    ?? (source.fastMode === 'ultrafast'
      ? (supportsFast && supportsUltrafast ? source.fastMode : false)
      : routeChanged ? (supportsFast ? source.fastMode : false) : source.fastMode);
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

export interface SendToSessionRoutingSnapshot {
  availableModels: readonly ModelCapabilities[];
  providerRouting: OrcaWorkerProviderRoutingContext;
  hasCindyAiApiKey: boolean;
}

export type SendToSessionCreateRouteResult =
  | { ok: true; agentDeviceId: string | null; config: SendToSessionExecutionConfig }
  | Extract<SendToSessionExecutionConfigResult, { ok: false }>;

/**
 * send_to_session create 的 Agent 位置与执行配置。不指定位置时继承来源(`inherited`)；
 * 指定的位置与来源不同时，按那台电脑(或本机)的供应商重新解析模型与来源，继承来源的模型 id，
 * 那里没有就返回 PROVIDER_ROUTE_UNAVAILABLE，不换模型。位置和执行配置都没变时原样返回来源配置。
 */
export async function resolveSendToSessionCreateRoute(
  params: {
    source: SendToSessionExecutionConfig;
    /** 来源任务的 Agent 所在电脑；null = 本机。SSH 来源也传 null。 */
    sourceAgentDeviceId: string | null;
    sourceIsSsh: boolean;
    /** undefined = 继承来源；null = 本机；字符串 = 那台电脑或分享。SSH 来源不接受显式位置。 */
    requestedAgentDeviceId?: string | null;
    overrides?: SendToSessionExecutionOverrides;
  },
  deps: {
    isSelfDeviceId: (deviceId: string) => boolean;
    readLocalRouting: (agentKind: AgentKind) => Promise<SendToSessionRoutingSnapshot>;
    readDeviceRouting: (deviceId: string, agentKind: AgentKind) => Promise<SendToSessionRoutingSnapshot>;
  },
): Promise<SendToSessionCreateRouteResult> {
  const location = resolveRequestedAgentDeviceId({
    requested: params.requestedAgentDeviceId,
    inherited: params.sourceAgentDeviceId,
    sourceIsSsh: params.sourceIsSsh,
    isSelfDeviceId: deps.isSelfDeviceId,
  });
  if (!location.ok) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: location.reason === 'invalid_format'
        ? 'agent_device_id must be "local", a device id or a shared provider id'
        : 'the source task runs its Agent on an SSH host; agent_device_id is not supported',
    };
  }
  const agentDeviceId = location.agentDeviceId;
  // SSH 来源的 Agent 在 SSH 主机上，显式位置(含 "local" 与本机设备 id)一律不支持。
  // resolveRequestedAgentDeviceId 先按 Worker 语义接受本机位置，若放行，SSH 来源的位置会被
  // 当成未变(locationChanged=false)，随后沿用 SSH 来源的模型与供应商在本机建任务。
  if (params.sourceIsSsh && params.requestedAgentDeviceId !== undefined) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: 'the source task runs its Agent on an SSH host; agent_device_id is not supported',
    };
  }
  const locationChanged = agentDeviceId !== params.sourceAgentDeviceId;
  const overrides = params.overrides ?? {};
  const hasOverrides = overrides.agentKind !== undefined
    || overrides.model !== undefined
    || overrides.effort !== undefined
    || overrides.fastMode !== undefined;
  if (!locationChanged && !hasOverrides) return { ok: true, agentDeviceId, config: params.source };

  const agentKind = overrides.agentKind ?? params.source.agentKind;
  let routing: SendToSessionRoutingSnapshot;
  if (agentDeviceId === null) {
    routing = await deps.readLocalRouting(agentKind);
  } else {
    try {
      routing = await deps.readDeviceRouting(agentDeviceId, agentKind);
    } catch (err) {
      // 继承来的位置保持原有失败语义(由调用方按 Agent 未就绪处理)；显式换的位置让调用方换下一台。
      if (!locationChanged) throw err;
      return {
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message:
          `cannot read providers of agent_device_id "${agentDeviceId}" `
          + `(offline, remote control off, or share unavailable): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const resolved = resolveSendToSessionExecutionConfig({
    source: params.source,
    overrides,
    ...routing,
    locationChanged,
  });
  return resolved.ok ? { ok: true, agentDeviceId, config: resolved.config } : resolved;
}

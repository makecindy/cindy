import type { AgentKind, Effort, EngineKind } from '@cindy/maker-core';
import { isSharedTaskPeer, parseProviderSharePeer } from '@cindy/device-link';
import { resolvePermissionModeForOptions } from '@cindy/maker-shared/permission-mode';

import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineEffort,
  pluginEngineKeyFromProviderId,
  type PluginEnginePermissionModeId,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';
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

export interface SendToSessionCreateConfig {
  agentKind: EngineKind;
  model: string;
  effort?: Effort;
  fastMode: boolean | 'ultrafast';
  providerId?: string | null;
  permissionMode?: PluginEnginePermissionModeId;
}

export interface SendToSessionExecutionOverrides {
  providerId?: string;
  agentKind?: EngineKind;
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

export type SendToSessionCreateConfigResult =
  | { ok: true; config: SendToSessionCreateConfig }
  | Extract<SendToSessionExecutionConfigResult, { ok: false }>;

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
  requestedProviderId?: string;
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

  const selectedId = params.requestedProviderId ?? (routeChanged ? undefined : sourceProviderId);
  if (selectedId) {
    const selected = offering.find((provider) => provider.id === selectedId);
    if (!selected) {
      return {
        ok: false,
        message:
          `供应商 "${selectedId}" 当前未连接，或不再为 ${agentKind} 提供模型 "${model}"。`
          + '请在「设置 → 模型供应商」检查连接与模型配置后重试。',
      };
    }
    return { ok: true, provider: selected, providerId: selectedId };
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
  overrides: Omit<SendToSessionExecutionOverrides, 'agentKind'> & { agentKind?: AgentKind };
  availableModels: readonly ModelCapabilities[];
  providerRouting: OrcaWorkerProviderRoutingContext;
  hasCindyAiApiKey: boolean;
  /** 新任务的 Agent 换了电脑：来源的 provider 不在那台，按目标电脑重新解析；缺模型算没有路由。 */
  locationChanged?: boolean;
  /** 来源是插件引擎、目标切回内置引擎：强制按新路由解析，不沿用旧来源 providerId。 */
  forceRouteChanged?: boolean;
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
    || params.forceRouteChanged === true
    || agentKind !== source.agentKind
    || model !== source.model
    || (overrides.providerId !== undefined && overrides.providerId !== source.providerId);
  const budgetRouteProviderId = overrides.providerId ?? (!routeChanged && source.providerId
    ? source.providerId
    : params.providerRouting.resolveDefaultProviderIdForModel(agentKind, model));
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
    requestedProviderId: overrides.providerId,
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
  | { ok: true; agentDeviceId: string | null; config: SendToSessionCreateConfig }
  | Extract<SendToSessionExecutionConfigResult, { ok: false }>;

/**
 * 解析普通任务(send_to_session create)选择插件引擎(agent_kind="acp")时的执行配置。
 * 校验引擎是否可用/未停用、模型未被关闭且与目录匹配、显式 effort 在该模型可选档位内、
 * 不允许开启 Fast，并把权限档收窄到目标引擎支持的档位。不静默换模型或降级档位。
 */
export function resolveSendToSessionPluginEngineConfig(params: {
  source: {
    agentKind: EngineKind;
    model: string;
    effort?: Effort;
    providerId?: string | null;
    permissionMode?: string | null;
  };
  overrides: SendToSessionExecutionOverrides;
  engines: readonly PluginEngineView[];
  agentDeviceId: string | null;
  locationChanged: boolean;
}): SendToSessionCreateConfigResult {
  const { source, overrides, engines, agentDeviceId, locationChanged } = params;
  if (overrides.fastMode) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: 'fast mode is not supported by plugin engine (acp)',
    };
  }

  let providerId: string;
  if (overrides.providerId !== undefined) {
    const trimmed = overrides.providerId.trim();
    if (!pluginEngineKeyFromProviderId(trimmed)) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message:
          `provider_id "${overrides.providerId}" is not a valid plugin engine id; `
          + 'pass plugin_engines[].provider_id (acp-plugin:...) from list_available_models',
      };
    }
    providerId = trimmed;
  } else if (source.agentKind === 'acp' && pluginEngineKeyFromProviderId(source.providerId)) {
    providerId = source.providerId!.trim();
  } else {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message:
        'agent_kind "acp" requires provider_id (acp-plugin:...) from list_available_models plugin_engines',
    };
  }

  const key = pluginEngineKeyFromProviderId(providerId)!;
  const engine = engines.find((item) => item.key === key);
  if (!engine) {
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: agentDeviceId
        ? `目标位置 "${agentDeviceId}" 当前未开放插件引擎 "${providerId}"。如要使用本机插件引擎，请传 provider_device_id="local"。`
        : `插件引擎 "${providerId}" 不可用（对应插件未安装、已停用或已卸载）。`,
    };
  }
  if (engine.suspended) {
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: `${engine.name} 已在「设置 → 模型供应商」中停用。启用后才能用它运行任务。`,
    };
  }
  if (engine.availability.state === 'unavailable') {
    const hint = engine.availability.message?.trim();
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: hint ? `${engine.name} 当前不可用：${hint}` : `${engine.name} 当前不可用。`,
    };
  }

  // 只换 provider_device_id 不换引擎时仍继承原模型与（目标支持的）原 effort，
  // 再按目标位置的目录校验，与内置引擎的「只换位置保留模型」契约一致。
  const samePluginEngine = source.agentKind === 'acp' && source.providerId?.trim() === providerId;
  let model: string;
  if (overrides.model !== undefined) {
    if (!overrides.model.trim()) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: 'model must not be empty',
      };
    }
    model = overrides.model;
  } else {
    model = samePluginEngine && source.model.trim() ? source.model : PLUGIN_ENGINE_DEFAULT_MODEL;
  }

  if (engine.disabledModels?.some((item) => item.id === model)) {
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: `${engine.name} 的这个模型已在「设置 → 模型供应商」中关闭。请重新选择模型。`,
    };
  }
  const validModels = [
    ...(engine.defaultModelAllowed === false ? [] : [PLUGIN_ENGINE_DEFAULT_MODEL]),
    ...engine.models.map((item) => item.id),
  ];
  if (model === PLUGIN_ENGINE_DEFAULT_MODEL && engine.defaultModelAllowed === false) {
    return {
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message:
        `${engine.name} 当前没有开放默认模型（有模型已关闭或受限），请明确指定可用模型。`
        + `valid: ${validModels.join(', ') || 'none'}`,
    };
  }
  const listedModel = engine.models.find((item) => item.id === model);
  if (model !== PLUGIN_ENGINE_DEFAULT_MODEL && !listedModel) {
    if (engine.defaultModelAllowed === false) {
      return {
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: `${engine.name} 当前没有开放这个模型。valid: ${validModels.join(', ') || 'none'}`,
      };
    }
    if (engine.models.length > 0 || overrides.model !== undefined || locationChanged) {
      return {
        ok: false,
        errorCode: locationChanged ? 'PROVIDER_ROUTE_UNAVAILABLE' : 'INVALID_ARGS',
        message:
          `model "${model}" not available for plugin engine "${engine.name}" (${providerId})`
          + `${locationChanged ? (agentDeviceId ? ` on provider_device_id "${agentDeviceId}"` : ' on the local computer') : ''}. `
          + `valid: ${validModels.join(', ') || 'none'}`,
      };
    }
  }

  const offered = listedModel?.efforts ?? [];
  const saved = engine.modelEfforts?.[model];
  let effort: Effort | undefined;
  if (overrides.effort !== undefined) {
    if (!isPluginEngineEffort(overrides.effort) || !offered.includes(overrides.effort)) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message:
          `effort "${overrides.effort}" not supported by model "${model}". `
          + `valid: ${offered.join(', ') || 'none'}`,
      };
    }
    effort = overrides.effort;
  } else {
    const sameModel = samePluginEngine && model === source.model;
    if (sameModel && isPluginEngineEffort(source.effort) && offered.includes(source.effort)) {
      effort = source.effort;
    } else if (saved && offered.includes(saved)) {
      effort = saved;
    }
  }

  let permissionMode: PluginEnginePermissionModeId | undefined;
  if (source.permissionMode) {
    permissionMode = engine.permissionModes.length > 0
      ? (resolvePermissionModeForOptions(
          source.permissionMode,
          engine.permissionModes.map((mode) => mode.id),
          engine.defaultPermissionMode,
        ) as PluginEnginePermissionModeId)
      : (source.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'ask');
  }

  return {
    ok: true,
    config: {
      agentKind: 'acp',
      model,
      effort,
      fastMode: false,
      providerId,
      ...(permissionMode ? { permissionMode } : {}),
    },
  };
}

/**
 * send_to_session create 的 Agent 位置与执行配置。不指定位置时继承来源(`inherited`)；
 * 指定的位置与来源不同时，按那台电脑(或本机)的供应商重新解析模型与来源，继承来源的模型 id，
 * 那里没有就返回 PROVIDER_ROUTE_UNAVAILABLE，不换模型。位置和执行配置都没变时原样返回来源配置。
 * 支持内置引擎(claude-code / codex / pi)与插件引擎(acp，本机或远程/分享)。
 */
export async function resolveSendToSessionCreateRoute(
  params: {
    source: SendToSessionCreateConfig;
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
    readLocalPluginEngines?: () => readonly PluginEngineView[];
    readDevicePluginEngines?: (deviceId: string) => Promise<readonly PluginEngineView[]>;
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
    || overrides.providerId !== undefined
    || overrides.effort !== undefined
    || overrides.fastMode !== undefined;
  const targetAgentKind: EngineKind = overrides.agentKind ?? params.source.agentKind;

  if (targetAgentKind === 'acp') {
    if (params.sourceIsSsh) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: '插件引擎不能在 SSH 工作区里运行。',
      };
    }
    if (agentDeviceId && (isSharedTaskPeer(agentDeviceId) || Boolean(parseProviderSharePeer(agentDeviceId)))) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: '无效的插件引擎运行位置。',
      };
    }
    // 继承远程插件引擎来源且未修改任何配置时，不额外发网络探测，沿用既有打开路径。
    if (!locationChanged && !hasOverrides && agentDeviceId !== null) {
      return { ok: true, agentDeviceId, config: { ...params.source, fastMode: false } };
    }
    let engines: readonly PluginEngineView[];
    if (agentDeviceId === null) {
      if (!deps.readLocalPluginEngines) {
        if (!locationChanged && !hasOverrides) {
          return { ok: true, agentDeviceId, config: { ...params.source, fastMode: false } };
        }
        return {
          ok: false,
          errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
          message: 'plugin engines are unavailable in this host',
        };
      }
      engines = deps.readLocalPluginEngines();
    } else {
      if (!deps.readDevicePluginEngines) {
        return {
          ok: false,
          errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
          message: `cannot read plugin engines of agent_device_id "${agentDeviceId}"`,
        };
      }
      try {
        engines = await deps.readDevicePluginEngines(agentDeviceId);
      } catch (err) {
        if (!locationChanged && params.source.agentKind === 'acp') throw err;
        return {
          ok: false,
          errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
          message:
            `cannot read plugin engines of agent_device_id "${agentDeviceId}" `
            + `(offline, remote control off, or share unavailable): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const resolved = resolveSendToSessionPluginEngineConfig({
      source: params.source,
      overrides,
      engines,
      agentDeviceId,
      locationChanged,
    });
    return resolved.ok ? { ok: true, agentDeviceId, config: resolved.config } : resolved;
  }

  if (overrides.providerId !== undefined && pluginEngineKeyFromProviderId(overrides.providerId)) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      message: `provider_id "${overrides.providerId}" 是插件引擎，使用它时请同时传 agent_kind="acp"。`,
    };
  }
  if (overrides.providerId !== undefined && (agentDeviceId !== null || params.sourceIsSsh)) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'provider_id 仅支持本机供应商连接。' };
  }
  if (!locationChanged && !hasOverrides) return { ok: true, agentDeviceId, config: params.source };

  const agentKind: AgentKind = targetAgentKind;
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
  const fromPluginEngine = params.source.agentKind === 'acp';
  const builtInSource: SendToSessionExecutionConfig = fromPluginEngine
    ? {
        agentKind,
        model: overrides.model ?? '',
        effort: undefined,
        fastMode: false,
        providerId: undefined,
      }
    : {
        agentKind: params.source.agentKind as AgentKind,
        model: params.source.model,
        effort: params.source.effort,
        fastMode: params.source.fastMode,
        providerId: params.source.providerId,
      };
  const resolved = resolveSendToSessionExecutionConfig({
    source: builtInSource,
    overrides: { ...overrides, agentKind },
    ...routing,
    locationChanged,
    forceRouteChanged: fromPluginEngine,
  });
  return resolved.ok ? { ok: true, agentDeviceId, config: resolved.config } : resolved;
}

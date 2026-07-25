/**
 * IM 新会话默认值解析。
 *
 * 这里是唯一把「系统默认 + 用户 override + 当前模型目录」合成 session 初始
 * agent/model/effort/provider 的入口。每个渠道传入自己的 scope，Feishu、
 * Slack、Discord 和 `/new` 都走这里，避免渠道之间借用同一份用户选择。
 */

import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  getModel,
  nativeDefaultSourceId,
  providerOffersModel,
  sourcesForModel,
  type ProviderView,
} from '@cindy/model-providers';

import {
  IM_DEFAULT_EFFORT_OVERRIDES,
  IM_DEFAULT_SETTINGS,
  type ImDefaultAgentSettings,
  type ImDefaultSettingsChannel,
} from '../../shared/imDefaultSettings.js';
import { createLogger } from '../logger';
import { getMaker } from '../maker-host';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService';
import { readImDefaultSettings } from './defaultSettingsStore';
import type { ImOrchestratorConfig } from './shared/types';

const log = createLogger('im:defaults');

export interface ResolvedImSessionDefaults {
  agentKind: AgentKind;
  model: string;
  effort: Effort;
  providerId: string | null;
  permissionMode: PermissionMode;
  fastMode: boolean;
}

export function getImDefaultEffortFor(
  agentKind: AgentKind,
  modelId: string,
  overrides: Readonly<Partial<Record<string, Effort>>> = IM_DEFAULT_EFFORT_OVERRIDES,
): Effort {
  const model = getMaker()
    .getCapabilities(agentKind)
    .availableModels.find((m) => m.id === modelId);
  const override = overrides[modelId];
  if (override && (!model?.efforts.length || model.efforts.includes(override))) {
    return override;
  }
  return model?.defaultEffort ?? model?.efforts[0] ?? 'high';
}

export async function resolveImSessionDefaults(
  config: ImOrchestratorConfig,
  providerSnapshot?: ProviderView[] | null,
  channel?: ImDefaultSettingsChannel,
): Promise<ResolvedImSessionDefaults> {
  const raw = readImDefaultSettings(channel);
  const providers =
    providerSnapshot === undefined ? await listProvidersForDefaults() : providerSnapshot;
  const requestedAgent = raw.agentKind;
  const requestedSettings = raw.agents[requestedAgent];
  const model = pickModel(requestedAgent, requestedSettings, config, providers);
  const agentKind = model.agentKind;
  const agentSettings = raw.agents[agentKind] ?? requestedSettings;
  const effort = resolveEffort(
    agentKind,
    model.modelId,
    agentSettings.effort,
    config.effortOverrides,
    providers,
  );
  const providerId = resolveProviderId(
    providers,
    agentKind,
    model.modelId,
    agentSettings.providerId,
  );

  return {
    agentKind,
    model: model.modelId,
    effort,
    providerId,
    permissionMode: config.defaultPermissionMode,
    fastMode: false,
  };
}

/**
 * 校验「默认设置里选的来源」对某个最终模型是否可用, 不可用回落 null(默认路由)。
 *
 * 与 resolveImSessionDefaults 内部的 providerId 校验同一实现 —— 供 hook 等
 * 「模型取值链自有一套、但来源语义要与 IM/桌面端新会话一致」的无人值守
 * 建会话入口复用: 来源必须是已连接供应商且真实提供该模型, 否则宁可回落
 * 默认路由也不落一个路由层解析不了的 id。目录读取失败(providers=null)时
 * 放行原值, 与 IM 同款降级(路由层仍有兜底)。
 */
export async function resolveDefaultProviderIdForModel(
  agentKind: AgentKind,
  modelId: string,
  providerId: string | null,
): Promise<string | null> {
  if (!providerId) return null;
  const providers = await listProvidersForDefaults();
  return resolveProviderId(providers, agentKind, modelId, providerId);
}

function pickModel(
  requestedAgent: AgentKind,
  settings: ImDefaultAgentSettings,
  config: ImOrchestratorConfig,
  providers: ProviderView[] | null,
): { agentKind: AgentKind; modelId: string } {
  if (hasModel(requestedAgent, settings.model, providers)) {
    return { agentKind: requestedAgent, modelId: settings.model };
  }

  const systemModel = IM_DEFAULT_SETTINGS.agents[requestedAgent]?.model;
  if (systemModel && hasModel(requestedAgent, systemModel, providers)) {
    log.warn('im default model unavailable; falling back to system model for agent', {
      agentKind: requestedAgent,
      requestedModel: settings.model,
      fallbackModel: systemModel,
    });
    return { agentKind: requestedAgent, modelId: systemModel };
  }

  const firstForRequestedAgent = firstModel(requestedAgent, providers);
  if (firstForRequestedAgent) {
    log.warn('im default model unavailable; falling back to first model for agent', {
      agentKind: requestedAgent,
      requestedModel: settings.model,
      fallbackModel: firstForRequestedAgent,
    });
    return { agentKind: requestedAgent, modelId: firstForRequestedAgent };
  }

  if (hasModel(config.agentKind, config.defaultModel, providers)) {
    log.warn('im default agent has no models; falling back to channel config', {
      requestedAgent,
      fallbackAgent: config.agentKind,
      fallbackModel: config.defaultModel,
    });
    return { agentKind: config.agentKind, modelId: config.defaultModel };
  }

  log.warn('im default: all model sources exhausted; using hardcoded system default', {
    requestedAgent,
    channelAgent: config.agentKind,
    channelModel: config.defaultModel,
  });
  return {
    agentKind: IM_DEFAULT_SETTINGS.agentKind,
    modelId: IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
  };
}

function hasModel(
  agentKind: AgentKind,
  modelId: string,
  providers: ProviderView[] | null,
): boolean {
  if (providers) {
    return sourcesForModel(providers, modelId, agentKind).length > 0;
  }
  return getMaker()
    .getCapabilities(agentKind)
    .availableModels.some((m) => m.id === modelId);
}

function firstModel(agentKind: AgentKind, providers: ProviderView[] | null): string | null {
  if (providers) {
    const connected = connectedProvidersForAgent(providers, agentKind);
    const nativeId = nativeDefaultSourceId(connected, agentKind);
    const native = nativeId ? connected.find((p) => p.id === nativeId) : undefined;
    const nativeModel = native?.models[agentKind]?.[0]?.id;
    if (nativeModel) return nativeModel;
    return connected.flatMap((p) => p.models[agentKind] ?? [])[0]?.id ?? null;
  }
  return getMaker().getCapabilities(agentKind).availableModels[0]?.id ?? null;
}

function resolveEffort(
  agentKind: AgentKind,
  modelId: string,
  requested: Effort,
  overrides?: Readonly<Partial<Record<string, Effort>>>,
  providers?: ProviderView[] | null,
): Effort {
  const model = findModel(agentKind, modelId, providers);
  if (!model || model.efforts.length === 0) {
    return requested || 'high';
  }
  if (model.efforts.includes(requested)) {
    return requested;
  }
  const override = overrides?.[modelId] ?? IM_DEFAULT_EFFORT_OVERRIDES[modelId];
  if (override && model.efforts.includes(override)) {
    return override;
  }
  return model.defaultEffort && model.efforts.includes(model.defaultEffort)
    ? model.defaultEffort
    : model.efforts[0];
}

function resolveProviderId(
  providers: ProviderView[] | null,
  agentKind: AgentKind,
  modelId: string,
  providerId: string | null,
): string | null {
  if (!providerId) return null;
  if (!providers) return providerId;
  const provider = connectedProvidersForAgent(providers, agentKind).find(
    (p) => p.id === providerId,
  );
  if (!provider || !providerOffersModel(provider, modelId, agentKind)) {
    log.warn('im default provider unavailable; falling back to default routing', {
      agentKind,
      modelId,
      providerId,
    });
    return null;
  }
  return providerId;
}

async function listProvidersForDefaults(): Promise<ProviderView[] | null> {
  try {
    return await getDesktopProviderService().listProviders();
  } catch (err) {
    log.warn('im default provider catalog unavailable; falling back to maker capabilities', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function findModel(
  agentKind: AgentKind,
  modelId: string,
  providers: ProviderView[] | null | undefined,
) {
  if (providers) {
    for (const provider of connectedProvidersForAgent(providers, agentKind)) {
      const model = getModel(provider, modelId, agentKind);
      if (model) return model;
    }
  }
  return getMaker()
    .getCapabilities(agentKind)
    .availableModels.find((m) => m.id === modelId);
}

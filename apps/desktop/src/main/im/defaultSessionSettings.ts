/**
 * IM 新会话默认值解析。
 *
 * 这里是唯一把「系统默认 + 用户 override + 当前模型目录」合成 session 初始
 * agent/model/effort/provider 的入口。每个渠道传入自己的 scope，Feishu、
 * Slack、Discord 和 `/new` 都走这里，避免渠道之间借用同一份用户选择。
 */

import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import {
  chatEligibleSourcesForModel,
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isAgentSelectableModel,
  type ProviderView,
} from '@cindy/model-providers';

import {
  checkModelRoute,
  pickEnabledFallbackModel,
  resolveLenientRoute,
} from '../maker-host/model-route-guard';

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
  // 先定来源再定 effort:effort 支持是 per-(来源, 模型) 的,保存的来源被停用改道后,
  // 必须按**最终落地来源**的拷贝 reconcile —— 按第一份 connected 拷贝(可能正是那份
  // 停用拷贝)算出的档位,启用替代来源未必支持,直建会话会被上游拒
  // (PR #744 review 第二十五轮)。
  const providerId = resolveProviderId(
    providers,
    agentKind,
    model.modelId,
    agentSettings.providerId,
  );
  const effort = resolveEffort(
    agentKind,
    model.modelId,
    agentSettings.effort,
    config.effortOverrides,
    providers,
    providerId,
  );

  return {
    agentKind,
    model: model.modelId,
    effort,
    providerId,
    permissionMode: raw.permissionMode ?? config.defaultPermissionMode,
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

  // 硬编码系统兜底同样过准入(PR #744 review 第十五轮):走到这里时该 agent 的
  // 启用来源已全部耗尽,目录可用而硬编码模型也被停用 ⇒ 抛错走 IM 既有失败路径,
  // 绝不让 turnRunner 拿停用模型直建付费会话;目录不可用保持旧兜底(降级窗口)。
  const systemAgent = IM_DEFAULT_SETTINGS.agentKind;
  const systemFallbackModel = IM_DEFAULT_SETTINGS.agents[systemAgent].model;
  if (providers) {
    const lenient = resolveLenientRoute(providers, systemAgent, systemFallbackModel, null);
    if (!lenient.model) {
      throw new Error(
        'im default session has no enabled chat model (all models disabled in settings)',
      );
    }
    log.warn('im default: all model sources exhausted; using admitted system fallback', {
      requestedAgent,
      channelAgent: config.agentKind,
      channelModel: config.defaultModel,
      fallbackModel: lenient.model,
    });
    return { agentKind: systemAgent, modelId: lenient.model };
  }
  log.warn('im default: all model sources exhausted; using hardcoded system default', {
    requestedAgent,
    channelAgent: config.agentKind,
    channelModel: config.defaultModel,
  });
  return { agentKind: systemAgent, modelId: systemFallbackModel };
}

function hasModel(
  agentKind: AgentKind,
  modelId: string,
  providers: ProviderView[] | null,
): boolean {
  if (providers) {
    // chatEligibleSourcesForModel(不是裸 sourcesForModel):否则一个已下架/从未是
    // 聊天模型的 id(image/embedding/...)会被判定为可用默认值(issue #882 第 3 点,
    // 2026-07 review)。
    return chatEligibleSourcesForModel(providers, modelId, agentKind).length > 0;
  }
  return getMaker()
    .getCapabilities(agentKind)
    .availableModels.some((m) => m.id === modelId);
}

function firstModel(agentKind: AgentKind, providers: ProviderView[] | null): string | null {
  if (providers) {
    // 兜底选模型与宽松降级同口径(pickEnabledFallbackModel):跳过停用条目与非聊天
    // 模型(图像/视频/TTS/STT/实时/Embedding/压缩等,issue #882 第 3 点),否则
    // 「保存的默认模型失效 → 取目录第一个」可能落在一份被停用或根本不是聊天模型
    // 的条目上(PR #744 review 第十轮)。
    return pickEnabledFallbackModel(providers, agentKind)?.model ?? null;
  }
  return getMaker().getCapabilities(agentKind).availableModels[0]?.id ?? null;
}

function resolveEffort(
  agentKind: AgentKind,
  modelId: string,
  requested: Effort,
  overrides?: Readonly<Partial<Record<string, Effort>>>,
  providers?: ProviderView[] | null,
  providerId?: string | null,
): Effort {
  const model = findModel(agentKind, modelId, providers, providerId);
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
  if (!providerId) {
    if (!providers) return null;
    // 隐式默认(未选来源)同样过裁决:原生默认落点的拷贝被停用而有启用替代时,
    // 必须显式改道 —— turnRunner 直建会话不过路由守卫,返回 null 会让 provider-route
    // 照旧落到停用的原生默认拷贝(PR #744 review 第十六轮)。pass(隐式安全)保持
    // null;reject 不应到达(pickModel 已按启用口径选模)兜底也保持 null。
    const verdict = checkModelRoute(providers, agentKind, modelId, null);
    if (verdict.kind === 'reroute') {
      log.warn('im default implicit route disabled; rerouting to enabled source', {
        agentKind,
        modelId,
        fallback: verdict.providerId,
      });
      return verdict.providerId;
    }
    return null;
  }
  if (!providers) return providerId;
  const provider = connectedProvidersForAgent(providers, agentKind).find(
    (p) => p.id === providerId,
  );
  const model = provider ? getModel(provider, modelId, agentKind) : undefined;
  if (!provider || !model || model.disabled === true) {
    // 不存在,或该 (来源, 模型) 拷贝被停用:经**启用 rail** 解析替代来源并显式
    // 落地,而不是返回 null 走隐式默认 —— turnRunner 直建会话不过路由守卫,隐式
    // 默认落点可能恰是被停用的那份拷贝(provider-route 不查停用标志)。零启用
    // 来源 ⇒ null,交给既有失败路径(PR #744 review 第十轮)。
    const fallback = effectiveSourceIdForModel(providers, null, modelId, agentKind);
    log.warn('im default provider unavailable; rerouting to enabled source', {
      agentKind,
      modelId,
      providerId,
      fallback,
    });
    return fallback;
  }
  if (!isAgentSelectableModel(model, { userProvider: provider.source === 'user' })) {
    // hasModel() 只证明"这个 id 在某个来源上是聊天模型"(any-source),不代表**这个**被
    // 保存的 providerId 本身也是——同一 id 若在不同来源上 mode 不一致(如 A 是
    // image_generation、B 是 chat),model 存在性校验会因 B 通过,但这里若只查
    // providerOffersModel(仅看 id 是否存在,不看 mode),仍会把会话钉死在 A 上
    // (2026-07 review:fresh evidence,与 hasModel 校验的是两件不同的事)。
    // 必须**显式**解析聊天可用的替代来源,不能返回 null 了事:null 的语义是隐式
    // 默认路由,运行时会落回原生默认来源——保存的 providerId 若恰好就是原生默认
    // (如 XD),null 等于原路发回那份非聊天拷贝,什么也没挡住(2026-07 review 第
    // 25 轮)。effectiveSourceIdForModel 走 chat 准入 rail,零可用 ⇒ null 交给既有
    // 失败路径;数据异常本身留 warn 供排查。
    const fallback = effectiveSourceIdForModel(providers, null, modelId, agentKind);
    log.warn('im default provider is non-chat for this model; rerouting to chat-eligible source', {
      agentKind,
      modelId,
      providerId,
      fallback,
    });
    return fallback;
  }
  return providerId;
}

async function listProvidersForDefaults(): Promise<ProviderView[] | null> {
  try {
    return await getDesktopProviderService().listProviders({ allowSideEffects: true });
  } catch (err) {
    log.warn('im default provider catalog unavailable; falling back to maker capabilities', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 取 effort reconcile 用的模型条目:显式来源给定时取**该来源**的拷贝(effort 支持
 * per-(来源, 模型),改道后必须按落地拷贝算);隐式(null)取启用 rail 里第一份
 * **未停用**拷贝 —— 第一份 connected 拷贝可能正是被停用的那份,按它算档位会把
 * 停用拷贝的 effort 钉给启用替代来源(PR #744 review 第二十五轮)。
 */
function findModel(
  agentKind: AgentKind,
  modelId: string,
  providers: ProviderView[] | null | undefined,
  providerId?: string | null,
) {
  if (providers) {
    // 显式来源由调用方(resolveProviderId)已经裁决过存在性/停用/chat 准入,这里
    // 直接取该来源自己的拷贝,不重复校验。
    if (providerId) {
      const provider = providers.find((p) => p.id === providerId);
      const model = provider ? getModel(provider, modelId, agentKind) : undefined;
      if (model) return model;
    }
    // 隐式(无显式来源):跳过被停用的拷贝(PR #744 review 第二十五轮)与非聊天
    // 来源的同 id 条目(2026-07 review,fresh evidence)——同一 id 若在排序更靠前
    // 的来源上是停用或非聊天(efforts 元数据可能完全不同),这里不挡的话
    // resolveEffort 会拿着错的 efforts/defaultEffort 去校验,即便 resolveProviderId
    // 已经把会话正确路由到了后面那个启用的聊天来源。
    for (const provider of connectedProvidersForAgent(providers, agentKind)) {
      const model = getModel(provider, modelId, agentKind);
      if (
        model &&
        model.disabled !== true &&
        isAgentSelectableModel(model, { userProvider: provider.source === 'user' })
      )
        return model;
    }
  }
  return getMaker()
    .getCapabilities(agentKind)
    .availableModels.find((m) => m.id === modelId);
}

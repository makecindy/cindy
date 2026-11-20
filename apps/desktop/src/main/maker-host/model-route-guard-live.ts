/**
 * model-route-guard-live —— 停用轴裁决的**桌面接线壳**:现读 provider 视图后调
 * model-route-guard 的纯判定。判定逻辑本体在 model-route-guard.ts(可单测);本壳
 * 依赖 getDesktopProviderService(Electron),消费方按需选择:
 *   - register.ts(create / set-model / agent-switch)直接调;
 *   - scheduler runner 经 deps 注入(测试最小 harness 不接线 = 不裁决);
 *   - help / sessionTaskSummary 的 agent one-shot 兜底用 isAgentOneShotRouteDisabled。
 * 目录读取失败降级为 override-only 保守裁决(见 overrideOnlyVerdict)——不把目录
 * 故障升级成全体用户的功能不可用,也不给配置过停用的用户开绕过口。普通裁决纯读
 * (allowSideEffects 缺省 false)；scheduler 默认来源解析是可信主进程业务入口，
 * 会显式允许认领已有原生订阅凭证。
 */

import {
  getModel,
  effectiveSourceIdForModel,
  modelSupportsFastMode,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

import { resolveNewTaskDefaultRoute } from '../../shared/draftModelCalibration.js';
import { checkDeviceRoute } from '../remote-agent/controller/deviceRouteCheck.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { resolveScheduledModelSelection, type ScheduledModelSelection } from '../maker-ipc/scheduledModelSelection';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import { getActiveCatalog } from './active-catalog.js';
import { createOneShotRouteGuard } from './oneShotRouteGuardCore.js';
import {
  pinExclusiveSessionProviderWithProviders,
  resolveLenientSessionRouteWithProviders,
  verdictForModelRouteWithProviders,
} from './model-route-guard-catalog.js';
import { getNewTaskDraftSelection } from './newMakerDefaultsCache.js';
import type { ModelRouteVerdict } from './model-route-guard.js';

/**
 * Route admission must retain capability entries that selectable build-region
 * projections intentionally hide. Otherwise an old controller can name a
 * hidden media model and make checkModelRoute treat it as catalog-unknown.
 */
async function listRouteGuardProviders(
  catalog = getActiveCatalog(),
): Promise<ProviderView[]> {
  return getDesktopProviderService().listProviders({ catalog });
}

// tombstoneGuardOptions, staticNativeDefaults and overrideOnlyVerdict moved to model-route-guard-catalog.ts.

/**
 * Headless defaults are trusted main-process operations, not untrusted status projections.
 * Allow the provider service to claim an existing native subscription before materializing
 * the route; otherwise legacy/local owners can look disconnected until another UI read heals it.
 */
function listTrustedDefaultRouteProviders(): Promise<ProviderView[]> {
  return getDesktopProviderService().listProviders({
    allowSideEffects: true,
    waitForDiscovery: true,
    getCatalog: getActiveCatalog,
  });
}

/**
 * Headless 调度的实时来源快照：
 * - 给定 modelId 时按模型选择器同一 rail 物化实际 provider；
 * - 未给 modelId 时按新建任务口径(resolveNewTaskDefaultRoute)挑默认模型，并把
 *   providerId/model 成对返回；一个可用来源都没有 → null。
 * 这样 spawn 凭证、proxy endpoint 与会话持久化不会各自重新猜一次默认来源。
 */
export async function resolveDefaultScheduleRoute(
  agent: AgentKind,
  preferredProviderId?: string | null,
  modelId?: string,
): Promise<{ model: string; providerId: string | null; catalogKnown?: boolean } | null> {
  const views = await listTrustedDefaultRouteProviders();
  const preferredModelId = modelId?.trim();
  if (preferredModelId) {
    const providerId = effectiveSourceIdForModel(
      views,
      preferredProviderId,
      preferredModelId,
      agent,
    );
    if (providerId) return { model: preferredModelId, providerId };

    // A schedule may intentionally name a model newer than the current catalog. Keep
    // the legacy null-provider/native-default path for that case; a catalog-known
    // model with no connected source must still fail closed in the scheduler.
    const catalogKnown = views.some((provider) =>
      (provider.models[agent] ?? []).some((model) => model.id === preferredModelId),
    );
    if (!catalogKnown && agent === 'claude-code') {
      return { model: preferredModelId, providerId: null, catalogKnown: false };
    }
    return null;
  }
  return resolveNewTaskDefaultRoute({
    providers: views,
    agent,
    draft: getNewTaskDraftSelection(activeOwnerScopeKey(), agent),
    requiredProviderId: preferredProviderId,
  });
}

/**
 * 没指定模型的无人值守入口(/learn、IM 新建任务等)按新建任务口径解析 (模型, 来源);
 * 一个可用来源都没有 → null,调用方明确失败。
 */
export async function resolveNewTaskDefaultModelRoute(
  agent: AgentKind,
  requiredProviderId?: string | null,
): Promise<{ model: string; providerId: string } | null> {
  return resolveNewTaskDefaultRoute({
    providers: await listTrustedDefaultRouteProviders(),
    agent,
    draft: getNewTaskDraftSelection(activeOwnerScopeKey(), agent),
    requiredProviderId,
  });
}

export async function verdictForModelRoute(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<ModelRouteVerdict> {
  return verdictForModelRouteWithProviders(listRouteGuardProviders, agent, model, providerId);
}

/** Resume 旧会话:只钉死独占来源,不把停用轴 reject 套到已在跑的会话上。 */
export async function pinExclusiveSessionProvider(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<string | undefined> {
  return pinExclusiveSessionProviderWithProviders(listRouteGuardProviders, agent, model, providerId);
}

// Moved to model-route-guard-catalog.ts, which does not load Electron (the Node Host imports it).
export { shouldApplyExclusiveProviderRerouteLive } from './model-route-guard-catalog.js';

/**
 * resolveLenientRoute 的桌面接线壳(语义见 model-route-guard.ts 头注):IM control:new /
 * learn 蒸馏等自动化直建会话入口用。目录读取失败按「原样放行」处理。
 */
export async function resolveLenientSessionRoute(
  agent: AgentKind,
  model: string | undefined,
  providerId: string | null,
  opts: { fallbackModel?: string; desiredEffort?: string; desiredFastMode?: boolean | 'ultrafast' } = {},
): Promise<{
  model?: string;
  providerId: string | null;
  degraded: boolean;
  effort?: string;
  /** 仅 desiredFastMode=true 且路由被本解析改动时给出:落地拷贝不支持 Fast ⇒ false。 */
  fastMode?: boolean | 'ultrafast';
}> {
  return resolveLenientSessionRouteWithProviders(listRouteGuardProviders, agent, model, providerId, opts);
}

/**
 * Resolve one provider-specific snapshot after route admission for fresh and bound sends.
 * An Agent on another computer resolves against that computer's authorized catalog and
 * never falls back to a local provider with the same id.
 */
export async function resolveScheduledModelSelectionLive(
  selection: ScheduledModelSelection,
  readRemoteProviders?: (agentDeviceId: string) => Promise<ProviderView[]>,
): Promise<ScheduledModelSelection> {
  if (selection.agentDeviceId) {
    if (!readRemoteProviders) throw new Error('Scheduled remote model resolution is not available');
    let views: ProviderView[] = [];
    const rejection = await checkDeviceRoute(async () => {
      views = await readRemoteProviders(selection.agentDeviceId!);
      return views;
    }, selection.agentKind, selection.providerId, selection.model);
    if (rejection) throw new Error(`Scheduled remote model route unavailable: ${rejection}`);
    return resolveScheduledModelSelection(selection, views);
  }
  const providers = await getDesktopProviderService().listProviders({
    allowSideEffects: false, catalog: getActiveCatalog(),
  });
  return resolveScheduledModelSelection(selection, providers);
}

/**
 * 某 (来源, 模型, agent) 拷贝的能力快照(efforts / Fast)。scheduler runner 在停用轴
 * 隐式改道后按落地拷贝 reconcile effort/fastMode 用(merged capability 分辨不出来源
 * 差异,PR #744 review 第二十七轮)。查不到 / 目录故障返回 null = 调用方保持既有
 * merged 口径,不阻断 headless 运行。
 */
export async function resolveRouteCopyCapabilities(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): Promise<{
  efforts: readonly string[];
  defaultEffort: string | null;
  supportsFastMode: boolean;
  supportsUltrafastMode?: boolean;
} | null> {
  let views: ProviderView[];
  try {
    views = await listRouteGuardProviders();
  } catch {
    return null;
  }
  const provider = views.find((p) => p.id === providerId);
  const copy = provider ? getModel(provider, modelId, agent) : undefined;
  if (!provider || !copy) return null;
  return {
    efforts: copy.efforts,
    defaultEffort: copy.defaultEffort ?? null,
    supportsFastMode: modelSupportsFastMode(provider, modelId, agent),
    supportsUltrafastMode: agent === 'codex' && copy.supportsUltrafastMode === true,
  };
}

const oneShotRouteDisabled = createOneShotRouteGuard({ listRouteGuardProviders, verdictForModelRoute });

export function isAgentOneShotRouteDisabled(
  ...args: Parameters<typeof oneShotRouteDisabled>
): ReturnType<typeof oneShotRouteDisabled> {
  return oneShotRouteDisabled(...args);
}

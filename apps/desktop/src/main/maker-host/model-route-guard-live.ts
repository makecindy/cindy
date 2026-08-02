/**
 * model-route-guard-live —— 停用轴裁决的**桌面接线壳**:现读 provider 视图后调
 * model-route-guard 的纯判定。判定逻辑本体在 model-route-guard.ts(可单测);本壳
 * 依赖 getDesktopProviderService(Electron),消费方按需选择:
 *   - register.ts(create / set-model / agent-switch)直接调;
 *   - scheduler runner 经 deps 注入(测试最小 harness 不接线 = 不裁决);
 *   - help / sessionTaskSummary 的 agent one-shot 兜底用 isAgentOneShotRouteDisabled。
 * 目录读取失败降级为 override-only 保守裁决(见 overrideOnlyVerdict)——不把目录
 * 故障升级成全体用户的功能不可用,也不给配置过停用的用户开绕过口。纯读
 * (allowSideEffects 缺省 false),自愈另有主进程业务入口负责。
 */

import {
  getModel,
  connectedProvidersForAgent,
  isAgentSelectableModel,
  isModelDisabled,
  isProviderDisabled,
  modelSupportsFastMode,
  nativeDefaultSourceId,
  sourcesForModel,
  type AgentKind,
  type ModelDisableOverrides,
  type ProviderView,
} from '@cindy/model-providers';

import { getDesktopProviderService } from './createDesktopProviderService.js';
import { getActiveCatalog } from './active-catalog.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import {
  checkModelRoute,
  resolveLenientRoute,
  type ModelRouteVerdict,
} from './model-route-guard.js';

/**
 * Route admission must retain capability entries that selectable build-region
 * projections intentionally hide. Otherwise an old controller can name a
 * hidden media model and make checkModelRoute treat it as catalog-unknown.
 */
async function listRouteGuardProviders(): Promise<ProviderView[]> {
  return getDesktopProviderService().listProviders({ catalog: getActiveCatalog() });
}

/**
 * 无模型的 headless 调度不能给 Pi 硬塞 Claude 型号：Pi 的可用面由实时连接来源
 * 决定。按模型选择器同一 rail（已连接、runtime 可用、未停用）取首个可聊天模型，
 * 并把 providerId 与 model 成对返回，避免 BYOM 同名模型落到 Cindy 默认路由。
 */
export async function resolveDefaultScheduleRoute(
  agent: AgentKind,
  preferredProviderId?: string | null,
): Promise<{ model: string; providerId: string } | null> {
  const views = await listRouteGuardProviders();
  const connected = connectedProvidersForAgent(views, agent);
  const candidates = preferredProviderId
    ? connected.filter((provider) => provider.id === preferredProviderId)
    : connected;
  for (const provider of candidates) {
    for (const model of provider.models[agent] ?? []) {
      if (model.disabled === true) continue;
      if (!isAgentSelectableModel(model, { userProvider: provider.source === 'user' })) continue;
      return { model: model.id, providerId: provider.id };
    }
  }
  return null;
}

/** 该 agent 的静态原生默认来源偏好(nativeDefaultSourceId 的无 rail 近似)。 */
function staticNativeDefaults(agent: AgentKind): readonly string[] {
  return agent === 'codex' ? ['openai', 'xd'] : ['xd'];
}

/**
 * 目录读取失败时的保守降级裁决:只凭本地 override 文件判(它不依赖钥匙串 / OAuth /
 * 网络,readModelDisableOverrides 是纯文件读)。原则:没配置过任何停用的用户
 * (绝大多数)不受目录故障影响照常放行;配置过的用户按「无法证明落点安全即拒」——
 * 目录故障时不能把停用当没发生(PR #744 review 第七轮):
 *   - 显式来源:override 直接命中(供应商级 / 该 (来源, 模型) 条目)⇒ reject;
 *   - 隐式来源:该模型在**任何**来源被停用、或该 agent 的静态原生默认来源被停用
 *     ⇒ 无法用真实 rail 证明实际落点是启用拷贝,保守 reject。
 * 近似性说明:rail 不可得,rail[0] 兜底落点无从判断 —— 宁可对配置过停用的用户在
 * 目录故障窗口内多拦,不漏放。
 */
function overrideOnlyVerdict(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): ModelRouteVerdict {
  let overrides: ModelDisableOverrides;
  try {
    overrides = readModelDisableOverrides();
  } catch {
    // override 文件都读不了:没有任何停用证据,放行(与「从未配置」不可区分)。
    return { kind: 'pass' };
  }
  if (providerId) {
    return isProviderDisabled(overrides, providerId) ||
      isModelDisabled(overrides, providerId, model)
      ? { kind: 'reject', reason: 'explicit-source-disabled' }
      : { kind: 'pass' };
  }
  const modelMentioned = Object.keys(overrides.disabledModels ?? {}).some((key) =>
    key.endsWith(`:${model}`),
  );
  const defaultSuspended = staticNativeDefaults(agent).some((id) =>
    isProviderDisabled(overrides, id),
  );
  return modelMentioned || defaultSuspended
    ? { kind: 'reject', reason: 'model-disabled' }
    : { kind: 'pass' };
}

export async function verdictForModelRoute(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<ModelRouteVerdict> {
  let views: ProviderView[];
  try {
    views = await listRouteGuardProviders();
  } catch {
    return overrideOnlyVerdict(agent, model, providerId);
  }
  return checkModelRoute(views, agent, model, providerId);
}

/**
 * resolveLenientRoute 的桌面接线壳(语义见 model-route-guard.ts 头注):IM control:new /
 * learn 蒸馏等自动化直建会话入口用。目录读取失败按「原样放行」处理。
 */
export async function resolveLenientSessionRoute(
  agent: AgentKind,
  model: string | undefined,
  providerId: string | null,
  opts: { fallbackModel?: string; desiredEffort?: string; desiredFastMode?: boolean } = {},
): Promise<{
  model?: string;
  providerId: string | null;
  degraded: boolean;
  effort?: string;
  /** 仅 desiredFastMode=true 且路由被本解析改动时给出:落地拷贝不支持 Fast ⇒ false。 */
  fastMode?: boolean;
}> {
  let views: ProviderView[];
  try {
    views = await listRouteGuardProviders();
  } catch {
    // 目录故障降级:override-only 保守裁决(同 overrideOnlyVerdict 语义)。命中即
    // 逐级丢弃;目录不可得时没有 pick 兜底可用,model 置空由调用方失败收口。
    if (!model) return { model, providerId, degraded: false };
    if (overrideOnlyVerdict(agent, model, providerId).kind === 'pass') {
      return { model, providerId, degraded: false };
    }
    if (providerId && overrideOnlyVerdict(agent, model, null).kind === 'pass') {
      return { model, providerId: null, degraded: true };
    }
    return { model: undefined, providerId: null, degraded: true };
  }
  const route: {
    model?: string;
    providerId: string | null;
    degraded: boolean;
    effort?: string;
    fastMode?: boolean;
  } = resolveLenientRoute(views, agent, model, providerId, opts);
  // Fast reconcile(PR #744 review 第十七轮):Fast 能力是 per-(来源, 模型) 的
  // (modelSupportsFastMode)。保存的 fast=true 是对**原路由**的选择,解析改了模型
  // 或来源时按落地那份拷贝重查,不支持则清掉 —— 否则不支持 Fast 的兜底路由会带着
  // fast 标志被上游拒。路由原样时不产出(调用方保持自己的保存值)。
  if (opts.desiredFastMode === true && route.model) {
    const routeChanged = route.model !== model || route.providerId !== providerId;
    if (routeChanged) {
      const provider = route.providerId
        ? views.find((p) => p.id === route.providerId)
        : sourcesForModel([...views], route.model, agent)[0];
      route.fastMode = !!provider && modelSupportsFastMode(provider, route.model, agent);
    }
  }
  return route;
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
  };
}

/**
 * agent one-shot 不带 model 时各 agent 的内部默认模型(与 maker-core base-agent
 * OneShotOptions 文档口径一致:Claude → haiku,Codex → mini)。裁决要落到具体
 * 默认模型上:只查来源级 suspended 会漏掉「恰好停用了这一个模型」的 override
 * (PR #744 review 第十五轮)。
 */
const DEFAULT_ONESHOT_MODEL: Record<AgentKind, string> = {
  'claude-code': 'claude-haiku-4-5',
  codex: 'gpt-5.4-mini',
  // pi oneShot 未实现(BaseAgent 默认抛 NotSupported);占位与 claude 同款网关小模型。
  pi: 'claude-haiku-4-5',
};

/**
 * agent one-shot 兜底(help / 会话摘要 / 快照标签)是否被停用轴挡住。
 * 带具体模型时走完整裁决;不带模型(agent 默认一击)按**该 agent 的内部默认模型**
 * 走同一裁决,再叠加原生默认来源 suspended 检查(默认模型不在目录时裁决 pass,
 * 来源级停用仍要拦)。
 */
export async function isAgentOneShotRouteDisabled(
  agent: AgentKind,
  model?: string,
): Promise<boolean> {
  if (model) {
    // reroute 同样视为不可发:one-shot 无法携带显式 providerId,实际派发仍会落在
    // 被停用的隐式默认来源上 —— 只有 pass 才允许(PR #744 review 第五轮)。
    return (await verdictForModelRoute(agent, model, null)).kind !== 'pass';
  }
  if ((await verdictForModelRoute(agent, DEFAULT_ONESHOT_MODEL[agent], null)).kind !== 'pass') {
    return true;
  }
  let views: ProviderView[];
  try {
    views = await listRouteGuardProviders();
  } catch {
    // 目录故障降级:静态原生默认来源被 override 停用即视为不可发(同
    // overrideOnlyVerdict 的隐式近似;override 也读不了则按无停用证据放行)。
    try {
      const overrides = readModelDisableOverrides();
      return staticNativeDefaults(agent).some((id) => isProviderDisabled(overrides, id));
    } catch {
      return false;
    }
  }
  const rail = views.filter((p) => p.connected && p.agents.includes(agent));
  const defaultId = nativeDefaultSourceId(rail, agent);
  if (!defaultId) return false;
  return rail.find((p) => p.id === defaultId)?.suspended === true;
}

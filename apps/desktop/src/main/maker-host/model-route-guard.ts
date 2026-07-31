/**
 * model-route-guard —— 「停用轴」在 main 会话路由边界的准入判定(纯逻辑,规则 14)。
 *
 * 背景(PR #744 review):停用标志烘焙进 ProviderView 后,renderer 选择器不会再列出
 * 停用模型,但 `maker:create-session` / `maker:set-model` / `maker:switch-session-agent`
 * 都在 device-link allowlist 内,老控制端(旧手机版)可以直接点名一个停用模型 ——
 * main 必须在边界上自己裁决,不能依赖各端 UI 的过滤。
 *
 * 三态裁决(与整体停用语义一致,见 disableOverrides.ts):
 *   - `pass`:不涉停用,照常放行。含「目录不认识该模型」与「零已连接来源」——
 *     那是连接/目录域的问题,交给既有错误路径,本守卫只执行停用语义。
 *   - `reroute`:未显式点名来源、且**不考虑停用时会路由到的原生默认来源**恰好被
 *     停用,但仍有其它启用且已连接的来源提供该模型 ⇒ 把会话显式改路由到那份启用
 *     拷贝。不能只放行:实际路由层(provider-route)对隐式来源走原生默认,不查
 *     停用标志,放行等于继续用停用拷贝付费(PR #744 review 第三轮)。
 *   - `reject`:显式点名的来源被停用(点名 = 花谁的钱的明确表达,不静默换源),
 *     或该模型所有已连接拷贝都被停用。
 *
 * 判定只对**新的路由选择**执行(新建会话 / 切模型 / 跨引擎切换);resume 与运行中
 * 的会话不打断 —— 调用方负责场景收口。
 *
 * 严格度口径(产品取舍,Dash 2026-07-29 拍板):停用是 **best-effort** 的产品开关,
 * 先可用最重要。裁决发生在路由选择/派发编排时点,「检查后、真正扣费前」的毫秒级
 * 竞态窗口可接受(最坏多发一次调用),不再为收窄此类 TOCTOU 追加持锁/终检/复查的
 * 复杂度;真正的裁决漏洞(查错记账主体、口径用错、整条付费链路未接入)照常修。
 * review 中的纯竞态收窄类反馈按本口径回复说明,不再加码。
 */

import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isAgentSelectableModel,
  nativeDefaultSourceId,
  providerOffersModel,
  sourcesForModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

export type ModelRouteVerdict =
  | { kind: 'pass' }
  | { kind: 'reroute'; providerId: string }
  | {
      kind: 'reject';
      reason: 'model-disabled' | 'explicit-source-disabled' | 'capability-model';
    };

/** 该来源下这份 (model, agent) 拷贝是否被停用(含供应商级)。 */
function copyDisabled(p: ProviderView, modelId: string, agent: AgentKind): boolean {
  return p.suspended === true || getModel(p, modelId, agent)?.disabled === true;
}

/** 该来源下这份 (model, agent) 拷贝是否是 agent 可选的对话模型条目。 */
function copyAgentSelectable(p: ProviderView, modelId: string, agent: AgentKind): boolean {
  const copy = getModel(p, modelId, agent);
  return !!copy && isAgentSelectableModel(copy, { userProvider: p.source === 'user' });
}

export function checkModelRoute(
  views: readonly ProviderView[],
  agent: AgentKind,
  modelId: string,
  providerId: string | null,
): ModelRouteVerdict {
  const offering = views.filter(
    (p) => p.agents.includes(agent) && providerOffersModel(p, modelId, agent),
  );
  if (offering.length === 0) return { kind: 'pass' };

  // 能力模型(图像/音频/视频/向量)不能当 agent 对话模型 —— 选择器已硬排除,但
  // create/set-model/switch 这些 allowlisted 通道可被老控制端直接点名,必须在同一
  // 边界拦。分类按**将要路由到的那份拷贝**判,不是「任一供应商的拷贝可选即放行」:
  // 同 id 在 A 家是能力模型、在用户自定义 B 家是对话模型时,点名 A / 隐式落 A 都
  // 必须拒,只有显式选 B 才放行;未连接来源的拷贝也不构成豁免(实际路由永远不会
  // 落到它,PR #744 review 第五、六轮)。

  if (providerId) {
    const explicit = offering.find((p) => p.id === providerId);
    if (explicit) {
      if (!copyAgentSelectable(explicit, modelId, agent)) {
        return { kind: 'reject', reason: 'capability-model' };
      }
      if (copyDisabled(explicit, modelId, agent)) {
        return { kind: 'reject', reason: 'explicit-source-disabled' };
      }
      // 显式来源存在且未停用:放行。
      return { kind: 'pass' };
    }
    // 未知/陈旧的显式来源(不在目录、或不提供该模型):实际路由层(provider-route)
    // 查不到该 provider 的 routing 描述会回退**原生默认**落点 —— 效果等同隐式路由。
    // 不能 pass-through:原生默认拷贝被停用时,带着陈旧 id 放行 = 照旧经停用拷贝
    // 付费(PR #744 review 第二十三轮)。落到下方隐式口径继续裁决(reroute 会把
    // 陈旧 id 替换成启用替代来源)。
  }

  // 隐式来源:推演「不考虑停用时会路由到谁」(原生默认口径,与 provider-route 的
  // 实际落点一致;rail 只含已连接来源,零已连接 ⇒ pass 交给既有错误路径)。
  const preDisableRail = [...sourcesForModel([...views], modelId, agent, { includeDisabled: true })];
  const wouldRouteId = nativeDefaultSourceId(preDisableRail, agent);
  if (!wouldRouteId) return { kind: 'pass' };
  const wouldRoute = preDisableRail.find((p) => p.id === wouldRouteId);
  if (!wouldRoute) return { kind: 'pass' };
  if (!copyAgentSelectable(wouldRoute, modelId, agent)) {
    // 原生默认落点是能力模型拷贝:与停用轴同构,先解析聊天可用的替代来源
    // (effectiveSourceIdForModel 走 chat 准入 rail,已排除停用),有 ⇒ 显式改道;
    // 无 ⇒ reject。不能直接 reject 了事:UI 的发送检查(chatEligibleSourcesForModel)
    // 会因他源的聊天拷贝判定"能发",创建却被这里拒掉,两个口径打架;也不能 pass ——
    // 实际路由层对隐式来源走原生默认,不查 mode,放行等于把请求发进 image/audio
    // 端点(2026-07 review 第 26 轮)。显式点名非聊天拷贝仍 reject(上方):点名是
    // 明确表达,不静默换源。
    const chatAlternative = effectiveSourceIdForModel([...views], null, modelId, agent);
    const chatAlternativeProvider = chatAlternative
      ? views.find((p) => p.id === chatAlternative)
      : undefined;
    return chatAlternative &&
      chatAlternativeProvider &&
      copyAgentSelectable(chatAlternativeProvider, modelId, agent) &&
      !copyDisabled(chatAlternativeProvider, modelId, agent)
      ? { kind: 'reroute', providerId: chatAlternative }
      : { kind: 'reject', reason: 'capability-model' };
  }
  if (!copyDisabled(wouldRoute, modelId, agent)) return { kind: 'pass' };

  // 原生默认落点被停用:解析一份启用且已连接的替代拷贝(effectiveSourceIdForModel
  // 走过滤后的 rail),且那份拷贝也必须是对话模型条目,有 ⇒ 显式改路由;
  // 无 ⇒ 该模型在停用语义下不可用。
  const alternative = effectiveSourceIdForModel([...views], null, modelId, agent);
  const alternativeProvider = alternative ? views.find((p) => p.id === alternative) : undefined;
  return alternative && alternativeProvider && copyAgentSelectable(alternativeProvider, modelId, agent)
    ? { kind: 'reroute', providerId: alternative }
    : { kind: 'reject', reason: 'model-disabled' };
}

/**
 * 目录里第一份「已连接、启用、agent 可选」的对话模型拷贝(宽松降级的最终兜底;
 * IM 默认设置的 firstModel 亦复用,避免两处「兜底选模型」口径漂移)。
 * 顺序:原生默认来源优先,其余按 rail 序;来源与模型一起返回(显式 providerId,
 * 免得同 id 的隐式默认落点又是一份停用/能力拷贝)。零候选 ⇒ null。
 */
export function pickEnabledFallbackModel(
  views: readonly ProviderView[],
  agent: AgentKind,
): { model: string; providerId: string } | null {
  const rail = connectedProvidersForAgent([...views], agent);
  const defaultId = nativeDefaultSourceId(rail, agent);
  const ordered = defaultId
    ? [...rail.filter((p) => p.id === defaultId), ...rail.filter((p) => p.id !== defaultId)]
    : rail;
  for (const p of ordered) {
    const m = (p.models[agent] ?? []).find(
      (candidate) =>
        candidate.disabled !== true &&
        isAgentSelectableModel(candidate, { userProvider: p.source === 'user' }),
    );
    if (m) return { model: m.id, providerId: p.id };
  }
  return null;
}

/**
 * 「宽松降级」口径的路由解析(纯逻辑),给 main 侧自动化直建会话用(IM control:new /
 * learn 蒸馏):这些入口不是用户即时交互,reject 不该让整个流程失败,而是逐级退让
 * (PR #744 review 第五、六轮):
 *   ① 原样可用 ⇒ 原样;
 *   ② 隐式默认落点被停用但有启用替代 ⇒ 显式落替代来源;
 *   ③ 显式来源被停用但模型本身仍可路由 ⇒ 丢弃来源保模型(隐式默认 / 替代);
 *   ④ 模型所有拷贝被停用 / 能力模型 ⇒ 换模型:先试调用方入口默认
 *     (`opts.fallbackModel`,同走本阶梯 —— 兜底模型自己也可能被停用,不能裸用),
 *     再退到目录第一份启用可路由的对话模型(pickEnabledFallbackModel);
 *   ⑤ 目录里一个启用的对话模型都没有 ⇒ `model: undefined`,由调用方失败收口
 *     (**不得**再用任何未经裁决的模型直接创建会话)。
 * `degraded` = 有任何用户保存值被丢弃(调用方据此 warn 留痕)。
 */
export function resolveLenientRoute(
  views: readonly ProviderView[],
  agent: AgentKind,
  model: string | undefined,
  providerId: string | null,
  opts: { fallbackModel?: string; desiredEffort?: string } = {},
): { model?: string; providerId: string | null; degraded: boolean; effort?: string } {
  if (!model) return { model, providerId, degraded: false };
  // effort reconcile 的**唯一**出口(PR #744 review 第十一/二十三轮):调用方保存的
  // effort 是对**原路由那份拷贝**的选择,而 effort 支持是 per-(来源, 模型) 的 ——
  // 不止换模型,仅换来源(reroute / 丢弃停用显式来源)时落地拷贝也可能不支持原档
  // (如 max 换到只到 xhigh 的拷贝,原样透传会被上游拒)。所有改动路由的返回都走
  // 这里:仍支持则保留,否则取该条目默认档;条目不带 effort 概念 / 找不到时缺席
  // (调用方不携带 effort,交给 agent 默认)。
  const withEffort = (
    resolvedModel: string,
    resolvedProviderId: string | null,
    degraded: boolean,
  ): { model: string; providerId: string | null; degraded: boolean; effort?: string } => {
    const provider = resolvedProviderId
      ? views.find((p) => p.id === resolvedProviderId)
      : sourcesForModel([...views], resolvedModel, agent)[0];
    const copy = provider ? getModel(provider, resolvedModel, agent) : undefined;
    let effort: string | undefined;
    if (copy && copy.efforts.length > 0) {
      effort =
        opts.desiredEffort && copy.efforts.includes(opts.desiredEffort as never)
          ? opts.desiredEffort
          : copy.defaultEffort && copy.efforts.includes(copy.defaultEffort)
            ? copy.defaultEffort
            : copy.efforts[copy.efforts.length - 1];
    }
    return { model: resolvedModel, providerId: resolvedProviderId, degraded, effort };
  };
  let verdict = checkModelRoute(views, agent, model, providerId);
  if (verdict.kind === 'pass') return { model, providerId, degraded: false };
  if (verdict.kind === 'reroute') return withEffort(model, verdict.providerId, false);
  if (providerId) {
    verdict = checkModelRoute(views, agent, model, null);
    if (verdict.kind === 'pass') return withEffort(model, null, true);
    if (verdict.kind === 'reroute') {
      return withEffort(model, verdict.providerId, true);
    }
  }
  if (opts.fallbackModel && opts.fallbackModel !== model) {
    const fallback = resolveLenientRoute(views, agent, opts.fallbackModel, null);
    if (fallback.model) {
      return withEffort(fallback.model, fallback.providerId, true);
    }
  }
  const pick = pickEnabledFallbackModel(views, agent);
  return pick
    ? withEffort(pick.model, pick.providerId, true)
    : { model: undefined, providerId: null, degraded: true };
}

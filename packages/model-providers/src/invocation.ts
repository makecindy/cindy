/**
 * invocation —— 「无人值守派发的调用请求合成」标准(纯逻辑,跨端共享)。
 *
 * 背景(2026-07 全仓盘点): 「按 (显式偏好, 场景默认, 目录可用性) 合成新会话的
 * agent/model/effort/providerId/permissionMode/fastMode」这件事在 desktop main 里被独立实现
 * 了 6+ 份(IM defaultSessionSettings / hook-control defaults / scheduler runner / orca
 * workerCreation / IM cardActionHandler / newMakerDraft),每份回落链略有差异、硬编码默认
 * 互不一致,并且已经产生过真实事故(hook 权限档回落方向写反 → 显示最严实际最宽)。
 *
 * 本模块收口回落链本体;**场景默认全部由调用方传入**(ScenarioDefaults),共享包内零模型 id
 * 字面量 —— scheduler 想默认 Sonnet、IM 想默认 Opus,那是场景决策,不是标准的一部分。
 *
 * 安全语义(适用于一切无人值守入口):
 *   - permissionMode: 显式档不被该 agent 支持时回落该 agent 的**最严**档(permissionModes
 *     按从严到宽声明,取 [0]),绝不回落场景默认(场景默认往往是 bypass)。用户填过显式档
 *     = 表达过「不要默认的完全访问」,不支持时只能更严不能更宽。
 *     注意这对 upstream/main 的 hook 现行实现(defaults.ts: 非法档回落 bypass)是**刻意
 *     收紧**,与 PR #403(32b8edf)的修正同语义;P3 把 hook 迁到本函数时,若 #403 未先合并,
 *     迁移 PR 必须把该收紧作为行为变更显式声明,不许当"无行为变化"混过。
 *   - providerId: 必须收敛到「已连接且真实提供最终模型」的来源,否则回 null(默认路由),
 *     不落一个路由层解析不了、或与 model 错配的 id。
 */

import type { AgentKind, CatalogModel } from './types.js';
import {
  connectedProvidersForAgent,
  nativeDefaultSourceId,
  providerOffersModel,
  type ProviderView,
} from './registry.js';
import { reconcileInvocationEffort } from './effortResolution.js';

/** 显式偏好(用户设置 / 协议 override),全可空;null/undefined = 该字段无显式意图。 */
export interface InvocationPreferences {
  agentKind?: string | null;
  model?: string | null;
  effort?: string | null;
  providerId?: string | null;
  permissionMode?: string | null;
  fastMode?: boolean | null;
}

/** 场景默认 —— 每个派发面自己的产品决策,作为参数传入,不散落硬编码。 */
export interface ScenarioDefaults {
  agentKind: AgentKind;
  /** 场景默认模型(scheduler=Sonnet、IM=渠道草稿…)。返回值仍要过可用性校验。 */
  modelFor: (agent: AgentKind) => string;
  /** 场景默认 effort(如 IM 渠道草稿档);缺省 = 直接走模型默认档。 */
  effortFor?: (agent: AgentKind, modelId: string) => string | null;
  /** per-model effort 运营 override(如 IM_DEFAULT_EFFORT_OVERRIDES)。 */
  effortOverrides?: Readonly<Partial<Record<string, string>>>;
  /** 模型无 effort 档时的返回值 —— 各面 wire 契约的一部分(IM='high'、hook=undefined)。 */
  noEffortFallback: string | null | undefined;
  /** 模型未知/无档时对 requested/override 的取舍(三种历史语义,见 reconcileInvocationEffort)。 */
  noEffortsBehavior?: 'fallback-only' | 'requested-first' | 'override-first';
  /** 场景默认权限档(hook='bypassPermissions'、card='acceptEdits'…),仅在无显式档时使用。 */
  permissionMode: string;
  /** 场景默认来源(如 IM 草稿的 providerId);与显式值同样要过收敛校验。 */
  providerIdFor?: (agent: AgentKind, modelId: string) => string | null;
  fastMode?: boolean;
  /**
   * 显式模型经目录/caps 校验确认不可用时的策略:
   *   - 'fallback'(默认)= 落场景默认链继续派发 —— IM/hook 无人值守历史语义(宁可换模型
   *     也要把会话建起来);
   *   - 'reject' = 在返回值标记 `rejected`,调用方**不得**用合成结果开工 —— Orca
   *     resolveWorkerConfig 语义(用户点名模型跑 worker,静默换模型 = 花错钱,必须拒绝)。
   * 仅在目录/caps 可用且显式模型确实不在清单时生效;目录全不可用时显式值未经校验直接
   * 采纳('model:explicit-unverified'),不触发 reject。
   */
  explicitModelPolicy?: 'fallback' | 'reject';
}

/** 目录上下文。providers=null = 目录不可用 → capabilities 兜底 + providerId 透传降级。 */
export interface InvocationCatalogContext {
  providers: readonly ProviderView[] | null;
  /** 目录不可用时的模型清单兜底(agent capabilities 冻结快照)。 */
  getCapabilityModels?: (
    agent: AgentKind,
  ) => readonly { id: string; efforts: readonly string[]; defaultEffort: string | null }[];
  /** 该 agent 支持的权限档(**从严到宽**声明;permissionMode 校验与最严档回落依赖此序)。 */
  getPermissionModes?: (agent: AgentKind) => readonly string[];
  /** 可见性过滤(决定「可用模型」是否剔除用户隐藏项);缺省 = 不过滤。 */
  isVisible?: (providerId: string, model: CatalogModel) => boolean;
}

export interface ResolvedInvocation {
  agentKind: AgentKind;
  model: string;
  effort: string | null | undefined;
  providerId: string | null;
  permissionMode: string;
  fastMode: boolean;
  /**
   * 诊断轨迹: 各字段命中了哪级回落(如 'model:scenario-default'、
   * 'permission:strictest-fallback')。调用方打日志用,不参与任何逻辑。
   */
  fallbacksApplied: readonly string[];
  /**
   * `explicitModelPolicy: 'reject'` 且显式模型经校验不可用时置位。置位时其余字段仍按
   * 回落链合成(纯诊断价值,便于日志说明"本来会跑什么"),但调用方**不得**据此开工。
   */
  rejected?: { field: 'model'; value: string; reason: 'explicit-model-unavailable' };
}

interface AvailableModel {
  id: string;
  efforts: readonly string[];
  defaultEffort: string | null;
}

function availableModelsFor(
  agent: AgentKind,
  ctx: InvocationCatalogContext,
): AvailableModel[] | null {
  if (ctx.providers !== null) {
    const seen = new Set<string>();
    const out: AvailableModel[] = [];
    for (const provider of connectedProvidersForAgent([...ctx.providers], agent)) {
      for (const m of provider.models[agent] ?? []) {
        if (seen.has(m.id)) continue;
        if (ctx.isVisible && !ctx.isVisible(provider.id, m)) continue;
        seen.add(m.id);
        out.push({ id: m.id, efforts: m.efforts, defaultEffort: m.defaultEffort });
      }
    }
    return out;
  }
  const caps = ctx.getCapabilityModels?.(agent);
  return caps ? [...caps] : null;
}

function isKnownAgent(v: string | null | undefined): v is AgentKind {
  return v === 'claude-code' || v === 'codex';
}

/**
 * 标准调用合成。回落链每一级都要求候选值可用;`fallbacksApplied` 记录实际命中级。
 *
 * model 链: 显式∈可用 > 场景默认∈可用 > 该 agent 首个可用 > 场景默认裸值(目录/caps 全
 * 不可用时的兼容兜底 —— 与 IM/hook 历史行为一致,宁可发一个可能非法的 id 也不发空串)。
 */
export function resolveModelInvocation(
  prefs: InvocationPreferences,
  scenario: ScenarioDefaults,
  ctx: InvocationCatalogContext,
): ResolvedInvocation {
  const fallbacks: string[] = [];

  // 1. agentKind: 显式合法 > 场景默认。
  let agentKind: AgentKind;
  if (isKnownAgent(prefs.agentKind)) {
    agentKind = prefs.agentKind;
  } else {
    agentKind = scenario.agentKind;
    if (prefs.agentKind != null) fallbacks.push('agent:scenario-default');
  }

  // 1b. 显式 agent 合法但目录/caps 证实它**一个可用模型都没有**,而场景默认 agent 有 →
  //     回落到能跑的 agent。这是 IM resolveImSessionDefaults.pickModel 的现行语义(codex
  //     review):不回落的话会合成一个「无可执行来源」的会话,比换 agent 更糟。
  //     清单为 null(能力数据不可用)时不猜,维持显式选择。
  let available = availableModelsFor(agentKind, ctx);
  // model/effort/providerId 显式偏好经局部变量参与后续链:agent 回落时置空(见下),不改 prefs 入参。
  let modelPref = prefs.model ?? null;
  let effortPref = prefs.effort ?? null;
  let providerPref = prefs.providerId ?? null;
  if (
    isKnownAgent(prefs.agentKind) &&
    agentKind !== scenario.agentKind &&
    available !== null &&
    available.length === 0
  ) {
    const scenarioAvailable = availableModelsFor(scenario.agentKind, ctx);
    if (scenarioAvailable !== null && scenarioAvailable.length > 0) {
      agentKind = scenario.agentKind;
      available = scenarioAvailable;
      fallbacks.push('agent:model-less-fallback');
      // 显式 model/effort/providerId 是与**原 agent 配对**的偏好,跨 agent 全部作废
      // (IM 换 agent 后读 raw.agents[新agent] 的整组配置,defaultSessionSettings.ts)。
      // model/effort 不作废会让恰好同 id 的模型(gpt-5.5 双 agent 目录都有)被当作新
      // agent 的显式选择采纳,还会绕过 explicitModelPolicy: 'reject';providerId 不作废
      // 会把原 agent 的路由/计费选择(如 xd)强加给回落 agent,压掉场景为新 agent 配置
      // 的 providerIdFor(codex review 两轮)。
      modelPref = null;
      effortPref = null;
      providerPref = null;
    }
  }

  // 2. model。
  const has = (id: string | null | undefined): id is string =>
    !!id && (available === null || available.some((m) => m.id === id));
  const scenarioModel = scenario.modelFor(agentKind);
  let model: string;
  let rejected: ResolvedInvocation['rejected'];
  if (has(modelPref)) {
    model = modelPref;
    // 目录与 caps 全不可用时 has() 放行一切 —— 值被采纳但未经校验,记入诊断轨迹。
    if (available === null) fallbacks.push('model:explicit-unverified');
  } else {
    // 显式模型经校验确认不可用(available 必非 null,否则上分支已放行):按策略标记拒绝。
    // 其余字段照常合成 —— rejected 是给调用方的硬信号,不是让链条中断。
    if (modelPref != null && scenario.explicitModelPolicy === 'reject') {
      rejected = { field: 'model', value: modelPref, reason: 'explicit-model-unavailable' };
      fallbacks.push('model:explicit-rejected');
    }
    if (has(scenarioModel)) {
      model = scenarioModel;
      if (modelPref != null) fallbacks.push('model:scenario-default');
      if (available === null) fallbacks.push('model:scenario-default-unverified');
    } else if (available !== null && available.length > 0) {
      // 「首个可用」的口径与 IM 现行兜底一致:优先 **native 默认源**(claude-code 优先
      // 'xd'、codex 优先 'openai')上的首个可见模型,该源无可选才退 rail 序首个 ——
      // raw 目录序首个会把兜底模型换到不同来源/计费路由(codex review)。
      let fromNative: string | null = null;
      if (ctx.providers !== null) {
        const rail = connectedProvidersForAgent([...ctx.providers], agentKind);
        const nativeId = nativeDefaultSourceId(rail, agentKind);
        const native = rail.find((p) => p.id === nativeId);
        const availableIds = new Set(available.map((m) => m.id));
        // 可见性按 **native 源上的那一行**判,不能只看联合清单:某 id 在 native 源被隐藏、
        // 他源可见时,选它会让 provider 步骤路由去他源 —— 跳过了 native 源后面还有的
        // 可见模型,订阅/计费路由被悄悄换掉(codex review 五轮)。
        fromNative =
          native?.models[agentKind]?.find(
            (m) => availableIds.has(m.id) && (!ctx.isVisible || ctx.isVisible(native.id, m)),
          )?.id ?? null;
      }
      model = fromNative ?? available[0].id;
      fallbacks.push('model:first-available');
    } else {
      model = scenarioModel;
      // 诊断标记区分两种「硬发场景默认裸值」:available === null 是数据不可用未经校验;
      // 空数组是数据可用但**确认零可选**(Copilot review:混用 unverified 会误导排查)。
      fallbacks.push(
        available === null
          ? 'model:scenario-default-unverified'
          : 'model:no-available-models',
      );
    }
  }

  // 3. effort。requested 槽位是**两级候选**: 显式档非法时先试场景默认档(hook 的
  //    「显式 > 草稿 > 模型默认」历史链;初版 `prefs.effort ?? scenarioEffort` 会在显式档
  //    非法时直接跳过草稿档,2026-07 对抗审查修正),再交给统一回落链。
  const descriptor = available?.find((m) => m.id === model);
  const scenarioEffort = scenario.effortFor?.(agentKind, model) ?? null;
  let requestedEffort: string | null | undefined;
  if (descriptor && descriptor.efforts.length > 0) {
    requestedEffort =
      [effortPref, scenarioEffort].find((c) => !!c && descriptor.efforts.includes(c)) ??
      effortPref;
  } else {
    requestedEffort = effortPref ?? scenarioEffort;
  }
  const effort = reconcileInvocationEffort({
    requested: requestedEffort,
    model: descriptor,
    overrides: scenario.effortOverrides,
    modelId: model,
    noEffortFallback: scenario.noEffortFallback,
    ...(scenario.noEffortsBehavior !== undefined
      ? { noEffortsBehavior: scenario.noEffortsBehavior }
      : {}),
  });
  if (effortPref != null && effort !== effortPref) fallbacks.push('effort:reconciled');

  // 4. providerId: 显式 / 场景值收敛到「已连接且真实提供最终模型」的来源,失败回 null。
  //    目录不可用时透传原值(路由层仍有兜底)—— 与 IM/hook 历史降级一致。
  const requestedProvider = providerPref ?? scenario.providerIdFor?.(agentKind, model) ?? null;
  let providerId: string | null = null;
  if (ctx.providers === null) {
    if (requestedProvider) {
      providerId = requestedProvider;
      fallbacks.push('provider:unverified-passthrough');
    }
  } else if (requestedProvider || ctx.isVisible) {
    // 「真实提供」必须含 per-provider 可见性:同一模型在 B 可见、在 A 被用户隐藏时,
    // 显式点名 A 不能只靠「已连接 + 目录含该模型」就放行 —— 那会绕过 isVisible 的
    // 来源级契约,路由到用户明确排除的来源(codex review)。
    const rail = connectedProvidersForAgent([...ctx.providers], agentKind);
    const visiblyOffers = (p: (typeof rail)[number]): boolean => {
      if (!providerOffersModel(p, model, agentKind)) return false;
      if (!ctx.isVisible) return true;
      const cm = p.models[agentKind]?.find((m) => m.id === model);
      return cm !== undefined && ctx.isVisible(p.id, cm);
    };
    const named = requestedProvider ? rail.find((p) => p.id === requestedProvider) : undefined;
    if (requestedProvider && named !== undefined && visiblyOffers(named)) {
      providerId = requestedProvider;
    } else if (requestedProvider) {
      // 点名源不可用(断开/不提供/被隐藏)。回 null 不足以执行可见性决定 —— 下游默认
      // 路由(nativeDefaultSourceId)不看可见性,可能又选回同一个被隐藏的源:这里直接
      // 收敛到 native 优先的**可见**替代源;完全没有可见源才回 null 默认路由
      // (codex review, 2026-07)。
      const alternatives = rail.filter(visiblyOffers);
      if (alternatives.length > 0) {
        providerId = nativeDefaultSourceId(alternatives, agentKind) ?? alternatives[0].id;
        fallbacks.push('provider:visible-fallback');
      } else {
        providerId = null;
        fallbacks.push('provider:default-route');
      }
    } else {
      // 无点名但可见性过滤激活:下游把 null 解析成 nativeDefaultSourceId 时**不看可见性**
      // (registry.ts effectiveSourceIdForModel),若 native 源上该模型恰被隐藏、他源可见,
      // null 会路由进被隐藏的源 —— 仅在这种「下游默认落点不可见」的情况下显式收敛到
      // 可见源;默认落点本就可见(绝大多数)时维持 null,不改「null=默认路由」契约
      // (codex review 三轮补全)。
      const offering = rail.filter((p) => providerOffersModel(p, model, agentKind));
      const downstream = offering.find((p) => p.id === nativeDefaultSourceId(offering, agentKind));
      if (downstream !== undefined && !visiblyOffers(downstream)) {
        const alternatives = rail.filter(visiblyOffers);
        if (alternatives.length > 0) {
          providerId = nativeDefaultSourceId(alternatives, agentKind) ?? alternatives[0].id;
          fallbacks.push('provider:visible-fallback');
        }
      }
    }
  }

  // 5. permissionMode: 显式且支持 > 显式但不支持时回落该 agent **最严**档 > 场景默认。
  //    (安全方向硬要求,见文件头;permissionModes 未注入时无从校验,显式值原样放行。)
  //    **空档位表 = 能力数据异常,同「未注入」处理,显式值原样保留** —— 此前空表会落
  //    scenario.permissionMode(常为 bypass),把显式限制静默放宽,与本函数的安全保证
  //    正相反(Greptile + codex review 同点)。
  const supportedModes = ctx.getPermissionModes?.(agentKind);
  let permissionMode: string;
  if (prefs.permissionMode != null) {
    if (!supportedModes || supportedModes.length === 0) {
      permissionMode = prefs.permissionMode;
      if (supportedModes) fallbacks.push('permission:modes-unavailable');
    } else if (supportedModes.includes(prefs.permissionMode)) {
      permissionMode = prefs.permissionMode;
    } else {
      permissionMode = supportedModes[0];
      fallbacks.push('permission:strictest-fallback');
    }
  } else {
    permissionMode = scenario.permissionMode;
    // 场景默认档同样要对**最终 agent** 校验:Claude 场景默认 acceptEdits + 显式 Codex
    // agent 会合成 Codex 不支持的档,无人值守派发直接被运行时拒绝或误解 —— 不支持时
    // 与显式分支同方向回落该 agent 最严档(codex review);空表/未注入 = 数据缺失,原样。
    if (
      supportedModes !== undefined &&
      supportedModes.length > 0 &&
      !supportedModes.includes(permissionMode)
    ) {
      permissionMode = supportedModes[0];
      fallbacks.push('permission:scenario-strictest-fallback');
    }
  }

  // 6. fastMode: 请求值直传(per-provider 的 supportsFastMode 门控需要来源上下文,
  //    由派发端在确定最终 (providerId, model) 后另行叠加 —— 本函数不越权猜)。
  const fastMode = prefs.fastMode ?? scenario.fastMode ?? false;

  return {
    agentKind,
    model,
    effort,
    providerId,
    permissionMode,
    fastMode,
    fallbacksApplied: fallbacks,
    ...(rejected !== undefined ? { rejected } : {}),
  };
}

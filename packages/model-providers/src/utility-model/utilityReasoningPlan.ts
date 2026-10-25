/**
 * 辅助模型直连请求的思考参数取值规则。
 *
 * 目标是「使用该模型允许的最少思考」:
 * - 用哪一档由模型目录决定(声明档位里的最低档);
 * - 能不能关掉思考由请求协议决定(Messages / Chat 先试关掉,Responses 没有关掉的写法);
 * - 各厂商写法差异交给 model-compat(调用方在组装好 Chat / Responses 请求体后归一一次);
 * - 只有参数类错误(400 / 422,以及 Cindy AI 原生接口的 404)才沿着计划往下退,
 *   成功的那一步按「供应商 + 模型 + 请求格式」记在内存里,下次直接从它开始。
 *
 * 这里只看状态码,不解析报错文案;也只记成功,不记失败。
 */
import {
  profileModelListed,
  profileModelValue,
  resolveProviderCompatibilityProfile,
  type CompatibilityHarness,
} from '@cindy/model-compat';
import {
  effortRank,
  type CatalogModel,
  type Effort,
} from '@cindy/model-providers';
import { createHash } from 'node:crypto';

export type UtilityProviderWire =
  'chat-completions' | 'anthropic-messages' | 'responses';

/** 一次请求要带的思考参数:关掉 / 某一档 / 完全不带。 */
export type UtilityReasoningRung =
  { kind: 'off' } | { kind: 'effort'; effort: string } | { kind: 'omit' };

/**
 * 目录对该模型思考档位的说法:
 * - declared:声明了档位(按强弱升序);
 * - undeclared:没有档位——空列表与 `effortsUnknown` 一并按此处理。目录(尤其 Cindy AI
 *   网关的下发)不表达「能不能关掉思考」,空列表不能当成「不思考」;
 * - no-reasoning:明确已知不收思考参数(厂商档案 noReasoningModels、
 *   `supportsReasoning === false`、目录显式 `reasoning: false`)。
 */
export type UtilityReasoningDeclaration =
  | { kind: 'declared'; efforts: readonly string[] }
  | { kind: 'undeclared' }
  | { kind: 'no-reasoning' };

export type UtilityRequestStep = {
  wire: UtilityProviderWire;
  rung: UtilityReasoningRung;
  /** 去掉所有可选字段的兜底请求体(仅自定义供应商沿用的旧行为)。 */
  minimalBody?: boolean;
  /** Cindy AI 原生接口:404 视为「该格式不可用」,直接退回 Chat。 */
  gatewayNative?: boolean;
};

/** 写死的档位兜底只用于目录没有档位的模型,与改动前 Responses 的取值一致。 */
const UNKNOWN_MODEL_EFFORT = 'low';

/** 每次辅助请求因参数类错误而发出的请求总数上限(不含 #6098 的预算重试)。 */
export const MAX_REASONING_REQUESTS = 4;

export function utilityReasoningDeclaration(
  model:
    Pick<CatalogModel, 'efforts' | 'reasoning' | 'userModelConfig'> | undefined,
): UtilityReasoningDeclaration {
  // 自定义供应商投影成目录模型时,用户填的 reasoning 只保留在 userModelConfig 里
  // (model-providers user-provider.ts),不会写到 CatalogModel.reasoning。
  if (
    model?.reasoning === false ||
    model?.userModelConfig?.reasoning === false
  ) {
    return { kind: 'no-reasoning' };
  }
  if (!model || !Array.isArray(model.efforts) || model.efforts.length === 0)
    return { kind: 'undeclared' };
  const efforts = [...new Set(model.efforts)].sort(
    (a, b) => effortRank(a as Effort) - effortRank(b as Effort),
  );
  return { kind: 'declared', efforts };
}

/** 厂商档案把该模型标成不思考时,一开始就不带思考参数。只对 Chat / Responses 生效。 */
export function compatMarksNoReasoning(input: {
  wire: UtilityProviderWire;
  harness: CompatibilityHarness;
  upstreamBase: string;
  model: string;
}): boolean {
  if (input.wire === 'anthropic-messages') return false;
  const profile = resolveProviderCompatibilityProfile({
    harness: input.harness,
    protocol: input.wire === 'responses' ? 'openai-responses' : 'openai-chat',
    upstreamBase: input.upstreamBase,
    model: input.model,
  });
  return Boolean(
    profile && profileModelListed(profile.noReasoningModels, input.model),
  );
}

/**
 * 厂商档案是否给出了「关掉思考」的专门写法(网关对象格式,或档位映射里有 `none`)。
 * 有时 Chat 的「关掉」交给 model-compat 翻译 `reasoning_effort: 'none'`;没有时保持
 * 原来的 `thinking: disabled` + `reasoning_effort: 'minimal'` 且不经档位映射——
 * 否则 `minimal` 会被当成「要一档思考」映射成 low / 思考预算 / enabled。
 */
export function compatHasReasoningOff(input: {
  harness: CompatibilityHarness;
  upstreamBase: string;
  model: string;
}): boolean {
  const profile = resolveProviderCompatibilityProfile({
    harness: input.harness,
    protocol: 'openai-chat',
    upstreamBase: input.upstreamBase,
    model: input.model,
  });
  if (!profile) return false;
  if (profile.reasoningWireFormat === 'gateway-object') return true;
  const wireMap =
    profileModelValue(profile.modelReasoningEffortMap, input.model) ??
    profile.reasoningEffortMap;
  return (
    typeof wireMap === 'object' &&
    wireMap !== null &&
    Object.hasOwn(wireMap, 'none')
  );
}

/**
 * 同一声明在某个请求格式上的退让顺序。「关掉」由协议决定,与目录写了什么无关:
 * - 声明了档位:关掉(Chat / Messages)→ 最低档 → 高一档;
 * - 没有档位:关掉(Chat / Messages)→ low → 不带思考参数;
 * - 明确不收思考参数:一开始就不带。
 */
export function utilityReasoningRungs(
  wire: UtilityProviderWire,
  declaration: UtilityReasoningDeclaration,
): UtilityReasoningRung[] {
  if (declaration.kind === 'no-reasoning') return [{ kind: 'omit' }];
  const off: UtilityReasoningRung[] =
    wire === 'responses' ? [] : [{ kind: 'off' }];
  if (declaration.kind === 'declared') {
    return [
      ...off,
      ...declaration.efforts
        .slice(0, 2)
        .map((effort) => ({ kind: 'effort' as const, effort })),
    ];
  }
  return [
    ...off,
    { kind: 'effort', effort: UNKNOWN_MODEL_EFFORT },
    { kind: 'omit' },
  ];
}

export function utilityReasoningRungKey(rung: UtilityReasoningRung): string {
  return rung.kind === 'effort' ? `effort:${rung.effort}` : rung.kind;
}

export function utilityRequestStepKey(step: UtilityRequestStep): string {
  return `${step.wire}|${utilityReasoningRungKey(step.rung)}${step.minimalBody ? '|minimal' : ''}`;
}

export type UtilityReasoningMode =
  /** 默认:按目录声明逐级退让。 */
  | { kind: 'ladder'; declaration: UtilityReasoningDeclaration }
  /** 调用方显式要求的单一取值(重新打开思考、或指定档位),不做档位退让。 */
  | { kind: 'fixed'; rung: UtilityReasoningRung };

/**
 * 生成一次请求的完整计划。
 *
 * - `chatFallback`:Cindy AI 按模型原生格式发,原生格式出参数 / 格式类错误时退回 Chat,
 *   Chat 从原生格式起步的那一档接着往下退(思考档位照常带上,不会丢)。
 * - `minimalBodyFallback`:自定义供应商沿用的「去掉所有可选参数」兜底,内容与触发条件
 *   (400 / 422)和改动前一致,不论有没有声明档位都作为最后一步;它是旧保底,
 *   「声明了档位就不退到不带思考参数」只约束上面新增的几步。
 */
export function buildUtilityRequestPlan(input: {
  wire: UtilityProviderWire;
  mode: UtilityReasoningMode;
  chatFallback?: boolean;
  minimalBodyFallback?: boolean;
}): UtilityRequestStep[] {
  const { wire, mode } = input;
  const withChatFallback =
    input.chatFallback === true && wire !== 'chat-completions';
  const steps: UtilityRequestStep[] = [];
  if (mode.kind === 'fixed') {
    // Messages 从未表达过调用方指定的档位,保持原样;退回 Chat 时照常带上。
    const nativeRung: UtilityReasoningRung =
      wire === 'anthropic-messages' && mode.rung.kind === 'effort'
        ? { kind: 'omit' }
        : mode.rung;
    steps.push({
      wire,
      rung: nativeRung,
      ...(withChatFallback ? { gatewayNative: true } : {}),
    });
    if (withChatFallback)
      steps.push({ wire: 'chat-completions', rung: mode.rung });
  } else {
    const nativeRungs = utilityReasoningRungs(wire, mode.declaration);
    for (const rung of nativeRungs) {
      steps.push({
        wire,
        rung,
        ...(withChatFallback ? { gatewayNative: true } : {}),
      });
    }
    if (withChatFallback) {
      const chatRungs = utilityReasoningRungs(
        'chat-completions',
        mode.declaration,
      );
      const startKey = utilityReasoningRungKey(nativeRungs[0]!);
      const start = Math.max(
        0,
        chatRungs.findIndex(
          (rung) => utilityReasoningRungKey(rung) === startKey,
        ),
      );
      for (const rung of chatRungs.slice(start))
        steps.push({ wire: 'chat-completions', rung });
    }
  }
  if (input.minimalBodyFallback && wire !== 'anthropic-messages') {
    steps.push({ wire, rung: { kind: 'omit' }, minimalBody: true });
  }
  return steps;
}

/**
 * 参数类错误时计划的下一步;返回 null 表示不再退让。
 * 401 / 403 / 429 / 5xx 一律不退让:换写法解决不了鉴权、限流和服务端故障。
 */
export function nextUtilityRequestStep(
  steps: readonly UtilityRequestStep[],
  index: number,
  status: number,
): number | null {
  const step = steps[index];
  if (!step) return null;
  if (status === 404) {
    if (!step.gatewayNative) return null;
    // 原生接口不存在:原生格式的其它档位同样不可用,带着当前档位直接退回 Chat。
    const chat = steps.findIndex(
      (candidate, i) => i > index && candidate.wire === 'chat-completions',
    );
    if (chat < 0) return null;
    const sameRung = steps.findIndex(
      (candidate, i) =>
        i >= chat &&
        candidate.wire === 'chat-completions' &&
        utilityReasoningRungKey(candidate.rung) ===
          utilityReasoningRungKey(step.rung),
    );
    return sameRung >= 0 ? sameRung : chat;
  }
  if (status !== 400 && status !== 422) return null;
  return index + 1 < steps.length ? index + 1 : null;
}

/** 参数类拒绝:400 / 422,以及 Cindy AI 原生接口的 404。只有它们才换写法重试。 */
export function isUtilityParameterRejection(
  step: UtilityRequestStep | undefined,
  status: number,
): boolean {
  return (
    status === 400 ||
    status === 422 ||
    (status === 404 && step?.gatewayNative === true)
  );
}

/** 只记成功的写法,进程内有效;重启后清空。 */
const rememberedSteps = new Map<string, string>();
const REMEMBERED_STEP_LIMIT = 256;

export function utilityReasoningMemoryKey(parts: {
  providerId: string;
  agentKind: string;
  model: string;
  wire: UtilityProviderWire;
  mode: UtilityReasoningMode;
  /**
   * 供应商路由代次(provider-route 的非敏感整数),覆盖请求头、凭证、能力的修改与
   * 同 id 删除重建:这些变化不体现在地址和档位上,但旧路由记住的写法不该沿用。
   */
  routeRevision: number;
  /**
   * 当前账号作用域:自定义供应商的密钥按账号分别保存,切换账号不经过路由代次,
   * 另一个账号同 id、同地址的路由不能沿用这里记住的写法。
   */
  ownerScope: string;
}): string {
  const mode =
    parts.mode.kind === 'ladder'
      ? 'ladder'
      : `fixed:${utilityReasoningRungKey(parts.mode.rung)}`;
  return JSON.stringify([
    parts.providerId,
    parts.agentKind,
    parts.model,
    parts.wire,
    mode,
    parts.routeRevision,
    parts.ownerScope,
  ]);
}

/**
 * 把记忆限定到当前路由:本次计划用到的各请求格式的有效地址,加上计划签名(各步骤
 * 的 key)。地址或目录档位一变,旧端点记住的写法就不再沿用。地址取完整 URL(含查询
 * 参数、不含片段)的 sha256 摘要,不以明文保存;请求头也不进键。
 */
export function scopeUtilityMemoryKey(
  memoryKey: string,
  steps: readonly UtilityRequestStep[],
  endpoints: Partial<Record<UtilityProviderWire, string>>,
): string {
  const wires = [...new Set(steps.map((step) => step.wire))].sort();
  const routes = wires.map((wire) => {
    const endpoint = endpoints[wire];
    if (!endpoint) return [wire, ''];
    // 查询参数可能是路由的一部分(appendProviderRequestPath 会保留它),所以取完整
    // URL;只去掉片段。用摘要而不是原文,URL 里可能带的凭证不会明文进键。
    const withoutFragment = endpoint.split('#', 1)[0]!;
    return [wire, createHash('sha256').update(withoutFragment).digest('hex')];
  });
  return JSON.stringify([memoryKey, routes, steps.map(utilityRequestStepKey)]);
}

/**
 * 记住的写法若仍在本次计划里,就从它开始。它后来被参数类错误拒绝时,调用方清掉这条
 * 记忆,从这一步所在请求格式的第一步重走(见 forgetUtilityStep),上游变了也能自动修正。
 */
export function rememberedUtilityStepIndex(
  memoryKey: string | undefined,
  steps: readonly UtilityRequestStep[],
): number {
  if (!memoryKey) return 0;
  const remembered = rememberedSteps.get(memoryKey);
  if (!remembered) return 0;
  return Math.max(
    0,
    steps.findIndex((step) => utilityRequestStepKey(step) === remembered),
  );
}

export function rememberUtilityStep(
  memoryKey: string | undefined,
  step: UtilityRequestStep,
): void {
  // 最小请求体同时丢掉了输出上限和思考参数;记住它会让之后所有调用方
  // (不同的 maxTokens)都从这里起步、再也回不到带参数的写法。
  if (!memoryKey || step.minimalBody) return;
  rememberedSteps.delete(memoryKey);
  if (rememberedSteps.size >= REMEMBERED_STEP_LIMIT) {
    const oldest = rememberedSteps.keys().next().value;
    if (oldest !== undefined) rememberedSteps.delete(oldest);
  }
  rememberedSteps.set(memoryKey, utilityRequestStepKey(step));
}

export function forgetUtilityStep(memoryKey: string | undefined): void {
  if (memoryKey) rememberedSteps.delete(memoryKey);
}

/** 测试用:清空进程内记住的写法。 */
export function resetUtilityReasoningMemory(): void {
  rememberedSteps.clear();
}

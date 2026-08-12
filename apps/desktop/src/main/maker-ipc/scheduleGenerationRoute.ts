import {
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  isAgentSelectableModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

/** 最小会话字段，绑定任务生成时只依赖会话自己的运行时和模型。 */
export type BoundSessionGenerationMeta = {
  agentKind: AgentKind;
  model: string;
};

export type ScheduleGenerationRoute = {
  providerId: string;
  agentKind: AgentKind;
  model: string;
};

/** Session metadata should fill missing route dimensions only for bound-session requests. */
export function shouldResolveBoundSessionGenerationRoute(input: {
  targetSessionId: string | undefined;
  resolveBoundSessionRoute?: boolean;
}): boolean {
  return Boolean(input.targetSessionId && input.resolveBoundSessionRoute);
}

/**
 * 将绑定会话解析为一次性生成请求的显式路由。
 *
 * 会话表没有 providerId：有显式会话来源时由调用方传入；否则按当前目录中
 * 真正提供该 runtime/model 的来源计算默认值。解析失败返回 null，调用方必须
 * fail closed，不能把绑定会话的提示词送入旧的 XD fallback chain。
 */
export function resolveBoundSessionGenerationRoute(input: {
  session: BoundSessionGenerationMeta | null | undefined;
  sessionProviderId: string | null | undefined;
  requestedProviderId?: string | null;
  requestedModel?: string | null;
  providers: ProviderView[];
}): ScheduleGenerationRoute | null {
  const model = input.requestedModel?.trim() || input.session?.model.trim() || '';
  const agentKind = input.session?.agentKind;
  if (!agentKind || !model) return null;

  // An explicit task provider overrides the bound session provider. When the
  // task leaves providerId empty, preserve the session's route for inherited
  // models, but resolve an explicit task model as a new route so retired or
  // disabled copies do not pin generation to the stale session source.
  const explicitProviderId = input.requestedProviderId?.trim()
    || input.sessionProviderId?.trim()
    || null;
  const explicitProvider = explicitProviderId
    ? input.providers.find((provider) =>
      provider.id === explicitProviderId
      && provider.agents.includes(agentKind)
      // 这是 follow-session 的 resume 路径，不是新选择：保留已绑定会话的 retired 模型，
      // 但只按 id 匹配仍会漏检 mode。同一 id 在该来源下若是非聊天类型模型的具体条目,
      // 请求会被 fail-open 送进 image/audio/embedding 端点(2026-07 review 第 17 轮)。
      && (provider.models[agentKind] ?? []).some(
        (candidate) =>
          candidate.id === model
          && isAgentSelectableModel(candidate, { userProvider: provider.source === 'user' }),
      ),
    )
    : undefined;
  // A session's explicit source is part of its identity. If that source no
  // longer serves the persisted model, fail closed instead of silently moving
  // the generation request to another gateway.
  const providerId = explicitProviderId
    ? explicitProvider?.id ?? null
    : input.requestedModel?.trim()
      ? effectiveSourceIdForModel(input.providers, null, model, agentKind)
      : actualSourceIdForModel(input.providers, null, model, agentKind);
  if (!providerId) return null;
  return { providerId, agentKind, model };
}

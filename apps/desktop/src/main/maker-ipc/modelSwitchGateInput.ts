import { lookupVerifiedContextWindow } from './contextOverflowRollover.js';

/**
 * The verified target and current windows a model change is judged by (register.ts,
 * applySessionRuntimeSelection), shared with the Node Host's model-change gate.
 */
export function resolveModelSwitchWindows(input: {
  runtimeAgentKind: string;
  resolveRouteWindow: (agentKind: string, modelId: string, pid: string | null) => number | null;
  model: string;
  targetRouteProviderId: string | null | undefined;
  currentRuntimeModel: string | null | undefined;
  currentProviderId: string | null | undefined;
  piPreview: { windowVerified?: boolean; targetContextWindow?: number | null } | null | undefined;
  /** The running runtime's reported window, read where the caller reads it. */
  liveCurrentWindow: number | undefined;
}): { verifiedTargetWindow: number | null; verifiedCurrentWindow: number | undefined } {
  const {
    runtimeAgentKind, resolveRouteWindow, model, targetRouteProviderId,
    currentRuntimeModel, currentProviderId, piPreview, liveCurrentWindow,
  } = input;
  const catalogTargetWindow = lookupVerifiedContextWindow(
    resolveRouteWindow,
    model,
    targetRouteProviderId,
    runtimeAgentKind,
  );
  const verifiedTargetWindow =
    runtimeAgentKind === 'pi' && piPreview?.windowVerified === true &&
    typeof piPreview.targetContextWindow === 'number' && piPreview.targetContextWindow > 0
      ? catalogTargetWindow === null
        ? piPreview.targetContextWindow
        : Math.min(piPreview.targetContextWindow, catalogTargetWindow)
      : catalogTargetWindow;
  const catalogCurrentWindow =
    lookupVerifiedContextWindow(
      resolveRouteWindow,
      currentRuntimeModel,
      currentProviderId,
      runtimeAgentKind,
    ) ?? undefined;
  // Pi 的有效窗口只能相信运行时上报值；其它引擎的缩窗闸门只接受目录核实值。
  const verifiedCurrentWindow =
    runtimeAgentKind === 'pi'
      ? typeof liveCurrentWindow === 'number' &&
        Number.isFinite(liveCurrentWindow) &&
        liveCurrentWindow > 0
        ? liveCurrentWindow
        : undefined
      : catalogCurrentWindow;
  return { verifiedTargetWindow, verifiedCurrentWindow };
}

/**
 * The context usage a model change is judged by: the running runtime's reading when it is
 * authoritative, otherwise the task row's persisted reading (register.ts, as above).
 */
export function resolveModelSwitchContextTokens(
  runtimeStatus: { contextTokens?: number | null },
  /** The running runtime's reported usage, read where the caller reads it. */
  liveContextTokens: number | undefined,
): { contextTokensKnown: boolean; contextTokens: number } {
  const persistedContextTokens =
    typeof runtimeStatus.contextTokens === 'number' &&
    Number.isFinite(runtimeStatus.contextTokens) &&
    runtimeStatus.contextTokens >= 0
      ? runtimeStatus.contextTokens
      : null;
  const verifiedLiveContextTokens =
    typeof liveContextTokens === 'number' && Number.isFinite(liveContextTokens)
      ? liveContextTokens
      : null;
  const liveUsageIsAuthoritative =
    verifiedLiveContextTokens !== null &&
    (verifiedLiveContextTokens > 0 || persistedContextTokens === 0);
  const contextTokensKnown = liveUsageIsAuthoritative || persistedContextTokens !== null;
  const contextTokens = liveUsageIsAuthoritative
    ? verifiedLiveContextTokens
    : (persistedContextTokens ?? 0);
  return { contextTokensKnown, contextTokens };
}

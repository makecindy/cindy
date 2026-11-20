import {
  type RuntimeModelSwitchGateInput,
} from '../../../desktop/src/shared/runtimeModelSwitchGate.ts';
import { lookupVerifiedContextWindow } from '../../../desktop/src/main/maker-ipc/contextOverflowRollover.ts';

/** The desktop's refusal on this path (register.ts, applySessionRuntimeSelection, `reject`). */
export const MODEL_WINDOW_REBUILD_UNSUPPORTED =
  'remote model-window rebuild is unsupported; runtime selection was not changed';

/** What the gate reads from a running task, as the desktop does from its live session. */
export interface ModelSwitchLiveRuntime {
  model?: string;
  isTurnRunning?(): boolean;
  getUsageSnapshot?(): { contextTokens?: number; contextWindow?: number } | undefined;
  previewModelSwitch?(model: string, options: { providerId: string | null }): Promise<{
    action?: string;
    windowVerified?: boolean;
    targetContextWindow?: number;
  } | undefined>;
}

export interface ModelSwitchWindowInput {
  /** The task's engine, as Maker names it (claude-code, codex, pi). */
  agentKind: string;
  live: ModelSwitchLiveRuntime | null;
  /** The task row before the change. */
  stored: { model: string | null; providerId: string | null; contextTokens: number | null };
  target: { model: string; providerId: string | null };
  /** The configured window of a route with the task's window budget (model-context-settings.ts). */
  resolveRouteWindow?(agentKind: string, modelId: string, providerId: string | null): number | null;
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The window gate's input for a model change a client asks the Host for, computed as the desktop
 * does for a model change from a Device Link client (register.ts applySessionRuntimeSelection:
 * target and current windows and context usage). The legacy session update rejects verified
 * pressured shrinks. Owner Device Link intent is evaluated separately at actual dispatch.
 */
export async function modelSwitchGateInput(input: ModelSwitchWindowInput): Promise<RuntimeModelSwitchGateInput & { piCanVerifyLiveWindow: boolean }> {
  const { agentKind, live, stored, target } = input;
  const currentModel = live?.model ?? stored.model ?? undefined;
  const runtimeRouteChanged = currentModel !== undefined
    && (currentModel !== target.model || stored.providerId !== target.providerId);
  const resolve = input.resolveRouteWindow
    ? (kind: string, modelId: string, providerId: string | null) => input.resolveRouteWindow!(kind, modelId, providerId)
    : undefined;
  // A running Pi task previews the target route itself (pi-host previewModelSwitch). The desktop
  // also refuses a change whose preview is unavailable; the Host takes it as an unverified window.
  const piPreview = agentKind === 'pi' && runtimeRouteChanged && live?.previewModelSwitch
    ? await live.previewModelSwitch(target.model, { providerId: target.providerId }).catch(() => undefined)
    : undefined;
  const catalogTargetWindow = lookupVerifiedContextWindow(resolve, target.model, target.providerId, agentKind);
  const verifiedTargetWindow = agentKind === 'pi' && piPreview?.windowVerified === true && positive(piPreview.targetContextWindow)
    ? catalogTargetWindow === null ? piPreview.targetContextWindow : Math.min(piPreview.targetContextWindow, catalogTargetWindow)
    : catalogTargetWindow;
  const usage = live?.getUsageSnapshot?.();
  const verifiedCurrentWindow = agentKind === 'pi'
    ? (positive(usage?.contextWindow) ? usage.contextWindow : undefined)
    : lookupVerifiedContextWindow(resolve, currentModel, stored.providerId, agentKind) ?? undefined;
  const persistedContextTokens = typeof stored.contextTokens === 'number' && Number.isFinite(stored.contextTokens)
    && stored.contextTokens >= 0 ? stored.contextTokens : null;
  const liveContextTokens = typeof usage?.contextTokens === 'number' && Number.isFinite(usage.contextTokens)
    ? usage.contextTokens : null;
  const liveUsageIsAuthoritative = liveContextTokens !== null && (liveContextTokens > 0 || persistedContextTokens === 0);
  return {
    piCanVerifyLiveWindow: piPreview?.action === 'hot' || piPreview?.action === 'refresh',
    inTurn: false,
    isRemote: true,
    agentKind,
    runtimeRouteChanged,
    verifiedTargetWindow,
    verifiedCurrentWindow,
    contextTokensKnown: liveUsageIsAuthoritative || persistedContextTokens !== null,
    contextTokens: liveUsageIsAuthoritative ? liveContextTokens : (persistedContextTokens ?? 0),
  };
}

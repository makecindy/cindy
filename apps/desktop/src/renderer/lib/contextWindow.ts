export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
}

/**
 * Resolve the context window shown in the renderer.
 *
 * SDK/modelUsage values are normally runtime ground truth, but 200K is also
 * Claude Code's unknown-model default and can remain in session state after a
 * model switch. Maker capabilities are more accurate for provider-routed models.
 */
export function resolveDisplayContextWindow({
  sdkContextWindow,
  modelContextWindow,
}: ResolveDisplayContextWindowOptions): number {
  const configured =
    Number.isFinite(modelContextWindow) && (modelContextWindow ?? 0) > 0
      ? Math.floor(modelContextWindow!)
      : undefined;
  const sdk =
    Number.isFinite(sdkContextWindow) && sdkContextWindow > 0
      ? Math.floor(sdkContextWindow)
      : undefined;

  if (configured && (!sdk || (sdk <= DEFAULT_CONTEXT_WINDOW && configured > sdk))) {
    return configured;
  }

  return sdk ?? configured ?? DEFAULT_CONTEXT_WINDOW;
}

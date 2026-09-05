export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
  verifiedContextWindow?: number | null;
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
  verifiedContextWindow,
}: ResolveDisplayContextWindowOptions): number {
  // Restored snapshots and SDK values share this slot. Only route-verified
  // metadata may supersede it, matching the host's runtime normalization.
  if (Number.isFinite(verifiedContextWindow) && (verifiedContextWindow ?? 0) > 0) {
    return Math.floor(verifiedContextWindow!);
  }
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

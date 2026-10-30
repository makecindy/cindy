export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
  verifiedContextWindow?: number | null;
  /** Total capacity resolved from native CLI config/metadata, not its usable-window report. */
  nativeContextWindow?: number | null;
  nativeContextPending?: boolean;
  /** Codex must not use provider metadata or a usable-window snapshot as its total. */
  runtimeWindowAuthoritative?: boolean;
}

/** Runtime snapshots already contain the applied working budget. Catalogs only fill missing data. */
export function resolveDisplayContextWindow({
  sdkContextWindow,
  modelContextWindow,
  verifiedContextWindow,
  runtimeWindowAuthoritative = false,
  nativeContextWindow,
  nativeContextPending = false,
}: ResolveDisplayContextWindowOptions): number {
  if (runtimeWindowAuthoritative) {
    if (nativeContextPending) return 0;
    return Number.isFinite(nativeContextWindow) && (nativeContextWindow ?? 0) > 0
      ? Math.floor(nativeContextWindow!) : 0;
  }
  if (Number.isFinite(sdkContextWindow) && sdkContextWindow > 0) {
    return Math.floor(sdkContextWindow);
  }
  for (const fallback of [verifiedContextWindow, modelContextWindow]) {
    if (Number.isFinite(fallback) && (fallback ?? 0) > 0) return Math.floor(fallback!);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

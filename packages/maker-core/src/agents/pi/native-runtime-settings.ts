/** Official Pi settings are immutable until a native runtime reload. */
export interface PiNativeRuntimeSettings {
  version: string;
  compaction: {
    reserveTokens?: number;
    modelOverrides?: Record<string, { reserveTokens?: number }>;
  };
}

export function parsePiNativeRuntimeSettings(value: unknown): PiNativeRuntimeSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<PiNativeRuntimeSettings>;
  if (typeof state.version !== 'string' || !state.compaction || typeof state.compaction !== 'object' || Array.isArray(state.compaction)) return undefined;
  const valid = (tokens: unknown) => tokens === undefined ||
    (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0);
  if (!valid(state.compaction.reserveTokens)) return undefined;
  const overrides = state.compaction.modelOverrides;
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) return undefined;
  for (const entry of Object.values(overrides ?? {})) {
    if (!entry || typeof entry !== 'object' || !valid(entry.reserveTokens)) return undefined;
  }
  return state as PiNativeRuntimeSettings;
}

export function resolvePiNativeReserve(settings: PiNativeRuntimeSettings, provider: string, model: string): number {
  // Per-model compaction settings are an official Pi 1.0 feature. Older Pi
  // accepts unknown settings keys but does not apply them.
  const major = /^(\d+)\./.exec(settings.version)?.[1];
  const override = major && Number(major) >= 1
    ? settings.compaction.modelOverrides?.[`${provider}/${model}`]?.reserveTokens : undefined;
  return override ?? settings.compaction.reserveTokens ?? 16_384;
}

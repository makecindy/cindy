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
  if (typeof state.version !== 'string') return undefined;
  // compaction 段缺失 = 未配置压缩(生成侧 pct 未设时本就不写该段),不是结构损坏;视为空段继续解析,
  // 否则模型切换链路会把「未配置」当成「不可读」整体拒掉。
  const compaction = state.compaction && typeof state.compaction === 'object' && !Array.isArray(state.compaction)
    ? state.compaction
    : ({} as PiNativeRuntimeSettings['compaction']);
  const valid = (tokens: unknown) => tokens === undefined ||
    (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0);
  if (!valid(compaction.reserveTokens)) return undefined;
  const overrides = compaction.modelOverrides;
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) return undefined;
  for (const entry of Object.values(overrides ?? {})) {
    if (!entry || typeof entry !== 'object' || !valid(entry.reserveTokens)) return undefined;
  }
  return { ...state, version: state.version, compaction } as PiNativeRuntimeSettings;
}

export function resolvePiNativeReserve(settings: PiNativeRuntimeSettings, provider: string, model: string): number {
  // Per-model compaction settings are an official Pi 1.0 feature. Older Pi
  // accepts unknown settings keys but does not apply them.
  // 宽松提取首个整数段:版本串可能是 "v1.4.0" 或 "1",严格 ^\d+\. 会静默丢掉 modelOverrides。
  const major = /(\d+)/.exec(settings.version)?.[1];
  const override = major && Number(major) >= 1
    ? settings.compaction.modelOverrides?.[`${provider}/${model}`]?.reserveTokens : undefined;
  return override ?? settings.compaction.reserveTokens ?? 16_384;
}

export const USAGE_SCHEMA_VERSION = 2 as const;
export type UsageStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING';
export type UsageCompleteness = 'exact' | 'lower-bound' | 'incomplete';

export interface NormalizedUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageArtifact {
  schemaVersion: typeof USAGE_SCHEMA_VERSION;
  rawProviderUsage: Record<string, unknown> | null;
  normalizedUsage: NormalizedUsage;
  usageStatus: UsageStatus;
  usageCompleteness: UsageCompleteness;
  usageSource: string[];
  missingFields: string[];
  termination: string | null;
  observedTokenTotal: number | null;
  sessionSnapshot: {
    tokenUsage: number;
    contextTokens: number;
    contextWindow: number;
    costUsd: number;
  };
}

export function createUsageArtifact(input: {
  rawProviderUsage: Record<string, unknown> | null;
  normalizedUsage: NormalizedUsage;
  sessionSnapshot: UsageArtifact['sessionSnapshot'];
  usageStatus?: UsageStatus;
  usageCompleteness?: UsageCompleteness;
  usageSource?: string[];
  missingFields?: string[];
  termination?: string | null;
  observedTokenTotal?: number | null;
}): UsageArtifact {
  return {
    ...input,
    schemaVersion: USAGE_SCHEMA_VERSION,
    usageStatus: input.usageStatus ?? 'COMPLETE',
    usageCompleteness: input.usageCompleteness ?? (input.usageStatus === 'PARTIAL' ? 'lower-bound' : input.usageStatus === 'MISSING' ? 'incomplete' : 'exact'),
    usageSource: input.usageSource ?? ['provider'],
    missingFields: input.missingFields ?? [],
    termination: input.termination ?? null,
    observedTokenTotal: input.observedTokenTotal ?? null,
  };
}

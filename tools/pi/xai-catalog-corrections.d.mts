export const XAI_THINKING_CORRECTIONS: Record<
  string,
  {
    thinkingLevelMap: Record<string, string | null>;
    defaultEffort: string;
    supportsReasoningEffort: boolean;
  }
>;

export function applyKnownXaiCorrections<
  T extends { id: string; thinkingLevelMap?: unknown; compat?: Record<string, unknown> },
>(models: T[]): T[];

export function preferredDefaultEffort(
  modelId: string,
  efforts: string[],
  fallbackDefaultEffort: (efforts: string[]) => string,
): string;

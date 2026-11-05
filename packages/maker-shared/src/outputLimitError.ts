/** Usage of the final, output-limited model request, not the whole tool loop. */
export interface OutputLimitDetails {
  outputTokens: number;
  /** A subset of outputTokens; absent when the provider did not report it. */
  reasoningTokens?: number;
}

/** Whitelist numeric details at event, persistence and projection boundaries. */
export function parseOutputLimitDetails(value: unknown): OutputLimitDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { outputTokens?: unknown; reasoningTokens?: unknown };
  if (
    typeof raw.outputTokens !== 'number' ||
    !Number.isSafeInteger(raw.outputTokens) ||
    raw.outputTokens < 1
  ) {
    return undefined;
  }
  const reasoning = raw.reasoningTokens;
  return {
    outputTokens: raw.outputTokens,
    ...(typeof reasoning === 'number' &&
    Number.isSafeInteger(reasoning) &&
    reasoning >= 0 &&
    reasoning <= raw.outputTokens
      ? { reasoningTokens: reasoning }
      : {}),
  };
}

export function isReasoningDominatedOutputLimit(details: OutputLimitDetails): boolean {
  return (
    details.reasoningTokens !== undefined && details.reasoningTokens / details.outputTokens >= 0.9
  );
}

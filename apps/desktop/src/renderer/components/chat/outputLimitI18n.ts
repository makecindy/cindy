import { isReasoningDominatedOutputLimit, parseOutputLimitDetails } from '@cindy/maker-shared';
type OutputLimitCopyKey =
  | 'logic.errors.outputLimit'
  | 'logic.errors.outputLimitReasoning'
  | 'logic.errors.outputLimitUsage'
  | 'logic.errors.outputLimitOutputUsage';

type TranslateOutputLimit = (
  key: OutputLimitCopyKey,
  options?: { outputTokens: number; reasoningTokens?: number },
) => string;

/** Shared by the live banner and restored error cards. */
export function localizeOutputLimit(t: TranslateOutputLimit, value: unknown): string {
  const details = parseOutputLimitDetails(value);
  const guidance = t(
    details && isReasoningDominatedOutputLimit(details)
      ? 'logic.errors.outputLimitReasoning'
      : 'logic.errors.outputLimit',
  );
  if (!details) return guidance;
  const usage = t(
    details.reasoningTokens === undefined
      ? 'logic.errors.outputLimitOutputUsage'
      : 'logic.errors.outputLimitUsage',
    { ...details },
  );
  return `${usage} ${guidance}`;
}

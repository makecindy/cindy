export interface ModelWindowConfirmationResult {
  deferred: boolean;
  superseded?: boolean;
  contextWindowConfirmationRequired?: number;
  contextTokensForConfirmation?: number;
}

interface ConfirmedModelSwitchOptions {
  invoke(confirmedContextWindow?: number): Promise<ModelWindowConfirmationResult | undefined>;
  confirm(input: { contextWindow: number; contextTokens: number }): Promise<boolean>;
}

function confirmationFromResult(result: ModelWindowConfirmationResult | undefined): {
  contextWindow: number;
  contextTokens: number;
} | null {
  if (!result || result.deferred !== false || result.superseded !== false)
    throw new Error('model-window switch did not return an applied result');
  const contextWindow = result.contextWindowConfirmationRequired;
  const contextTokens = result.contextTokensForConfirmation;
  if (contextWindow === undefined && contextTokens === undefined) return null;
  const validWindow =
    typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0;
  const validTokens =
    typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0;
  if (!validWindow || !validTokens)
    throw new Error('verified model-window confirmation is invalid');
  return { contextWindow, contextTokens };
}

/** First call only discovers pressure; an exact-window retry may perform the rebuild. */
export async function setModelWithWindowConfirmation(
  options: ConfirmedModelSwitchOptions,
): Promise<'applied' | 'confirmed' | false> {
  const confirmation = confirmationFromResult(await options.invoke());
  if (!confirmation) return 'applied';
  if (!(await options.confirm(confirmation))) return false;
  return confirmationFromResult(await options.invoke(confirmation.contextWindow)) === null
    ? 'confirmed'
    : false;
}

export interface ModelWindowConfirmationResult {
  deferred: boolean;
  superseded?: boolean;
  pendingUntilSend?: boolean;
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

/** A staged selection is consumed by the recovery send; immediate routes retain window confirmation. */
export async function setModelWithWindowConfirmation(
  options: ConfirmedModelSwitchOptions,
): Promise<'applied' | 'confirmed' | 'pending' | false> {
  const result = await options.invoke();
  if (result?.deferred === true && result.superseded === false && result.pendingUntilSend === true) {
    return 'pending';
  }
  const confirmation = confirmationFromResult(result);
  if (!confirmation) return 'applied';
  if (!(await options.confirm(confirmation))) return false;
  return confirmationFromResult(await options.invoke(confirmation.contextWindow)) === null
    ? 'confirmed'
    : false;
}

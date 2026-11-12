/** Host checks the calling task before account data is accessed and returned. */
export type AccountDataAccess = <T>(sessionId: string | undefined, operation: (assertCurrent: () => Promise<void>) => Promise<T>) => Promise<T>;

export async function withAccountDataAccess<T>(
  access: AccountDataAccess | undefined,
  sessionId: string | undefined,
  operation: (assertCurrent: () => Promise<void>) => Promise<T>,
): Promise<T | { isError: true; content: Array<{ type: 'text'; text: string }> }> {
  if (!access) return operation(async () => {});
  try {
    return await access(sessionId, operation);
  } catch {
    // Do not return account data embedded in an error from a stale operation.
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: 'Account data is unavailable for this task.',
    }) }] };
  }
}

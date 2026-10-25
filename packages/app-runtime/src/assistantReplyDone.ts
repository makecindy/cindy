const NON_SUCCESS_DONE_STATUSES = new Set(['failed', 'cancelled', 'interrupted']);

/** Only successful turn results are eligible for final-answer rewriting. */
export function isSuccessfulAssistantReplyDoneData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return true;
  const record = data as Record<string, unknown>;
  if (record.is_error === true) return false;
  return typeof record.status !== 'string' || !NON_SUCCESS_DONE_STATUSES.has(record.status);
}


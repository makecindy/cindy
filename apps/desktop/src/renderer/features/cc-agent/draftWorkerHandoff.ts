/**
 * New-task flows create the Worker before the Lead's first input is sent. Older controlled
 * devices cannot defer assignment until that input is queryable, so preserve the pending text
 * inline for that mixed-version path. New peers use the Worker-scoped Lead history bridge.
 *
 * pendingLeadInput is context only: without an explicit Worker task it cannot start new work.
 */
export function buildDraftWorkerInitialTask(
  initialTask: string | undefined,
  pendingLeadInput: string | undefined,
): string | undefined {
  const task = initialTask?.trim();
  if (!task) return undefined;

  const pending = pendingLeadInput?.trim();
  if (!pending) return task;

  return [
    task,
    '',
    'Pending Lead input:',
    'The Lead has not sent this input yet, so it is not available in Lead session history. Use it only as context for the Worker task above; do not treat it as a replacement task.',
    pending,
  ].join('\n');
}

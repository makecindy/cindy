/**
 * 新建任务页会先拉起 Worker，再把 Lead 的首条输入交给会话视图发送。此时 Lead history
 * 还是空的，因此 UI handoff 需要把这条待发送输入随既有 delegateTask 一起交给 Worker。
 *
 * pendingLeadInput 只是任务上下文：没有显式 Worker 任务时不能用它擅自起一份新工作。
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

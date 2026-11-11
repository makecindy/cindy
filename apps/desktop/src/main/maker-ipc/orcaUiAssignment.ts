/**
 * UI 直接创建 Worker 时，Lead 没有参与派单 turn；把按需回查线索放进同一条 initial task，
 * 既不唤醒 Lead，也不改变 MCP create_worker 已由 Lead 写好上下文的任务正文。
 */
export function buildUiAssignmentInitialTask(params: {
  leadSessionId: string;
  initialTask: string;
  snapshotBeforeMs?: number;
}): string {
  return [
    '[Orca UI Assignment]',
    '',
    'Task:',
    params.initialTask,
    '',
    'Context handoff:',
    'This Worker was created directly from the collaboration UI. The task may depend on work already in progress in the Lead session.',
    `Lead session id: ${JSON.stringify(params.leadSessionId)}`,
    ...(params.snapshotBeforeMs !== undefined
      ? [`snapshot_before_ms: ${params.snapshotBeforeMs}`]
      : []),
    'Decide whether that context is needed before acting. If the task refers to current work, continuing work, this PR, or another relative scope, call orca_worker_bridge.read_lead_history with your worker_id. When snapshot_before_ms is present, pass it as from_ms. Page through next_cursor when has_more is true.',
    'Use those tools only when needed. If the task is self-contained, proceed directly without reading the Lead history.',
    "For code work, recover the intended repository, worktree, branch, and review range from the Lead's context and verify them on disk; do not assume the process cwd is the Lead's active worktree.",
  ].join('\n');
}

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
    `Lead session id: ${JSON.stringify(params.leadSessionId)}`,
    ...(params.snapshotBeforeMs !== undefined
      ? [`snapshot_before_ms: ${params.snapshotBeforeMs}`]
      : []),
    'If the task is self-contained, proceed directly. If it refers to current work or another missing detail, use orca_worker_bridge.read_lead_history with your worker_id.',
    params.snapshotBeforeMs === undefined
      ? 'For current work, start with the latest messages (order="desc", limit=8).'
      : 'Start at the assignment snapshot (from_ms=snapshot_before_ms, order="asc", limit=8).',
    'Follow next_cursor in the same order only while the context you need is missing.',
    "For code work, use the location and change range in the task. If either is unclear, verify it on disk; do not assume the process cwd is the Lead's active worktree.",
  ].join('\n');
}

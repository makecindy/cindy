import type { AgentTaskUpdate } from '@/lib/makerChatStore';

export interface BackgroundTaskProgress {
  completed: number;
  total: number;
}

export interface BackgroundTaskSummary {
  subagents: BackgroundTaskProgress;
  commands: BackgroundTaskProgress;
}

const EMPTY_PROGRESS: BackgroundTaskProgress = { completed: 0, total: 0 };

/**
 * Collapse the task-update map into user-facing progress counts.
 *
 * Updates are indexed by both taskId and parentToolUseId, so taskId is the
 * identity boundary. Workflows have their own composer status and are not
 * part of the Subagent/background-command summary.
 */
export function summarizeBackgroundTasks(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): BackgroundTaskSummary {
  if (!taskUpdates || taskUpdates.size === 0) {
    return { subagents: EMPTY_PROGRESS, commands: EMPTY_PROGRESS };
  }

  const subagents = new Map<string, AgentTaskUpdate>();
  const commands = new Map<string, AgentTaskUpdate>();
  for (const update of taskUpdates.values()) {
    const target =
      update.taskType === 'local_bash'
        ? commands
        : update.taskType === 'local_workflow'
          ? null
          : subagents;
    if (!target) continue;
    target.set(update.taskId, update);
  }

  const progress = (updates: ReadonlyMap<string, AgentTaskUpdate>): BackgroundTaskProgress => ({
    completed: [...updates.values()].filter((update) => update.status !== 'running').length,
    total: updates.size,
  });

  return { subagents: progress(subagents), commands: progress(commands) };
}

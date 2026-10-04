import { describe, expect, it } from 'vitest';

import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import { summarizeBackgroundTasks } from '../backgroundTaskSummary';

function update(input: Partial<AgentTaskUpdate> & Pick<AgentTaskUpdate, 'taskId'>): AgentTaskUpdate {
  return {
    provider: 'claude-code',
    status: 'running',
    ...input,
  };
}

describe('summarizeBackgroundTasks', () => {
  it('deduplicates aliases and separates Subagents from background commands', () => {
    const subagent = update({ taskId: 'agent-1', parentToolUseId: 'tool-1', status: 'completed' });
    const tasks = new Map<string, AgentTaskUpdate>([
      ['agent-1', subagent],
      ['tool-1', subagent],
      ['agent-2', update({ taskId: 'agent-2', provider: 'codex' })],
      ['bash-1', update({ taskId: 'bash-1', taskType: 'local_bash', status: 'failed' })],
      ['workflow-1', update({ taskId: 'workflow-1', taskType: 'local_workflow' })],
    ]);

    expect(summarizeBackgroundTasks(tasks)).toEqual({
      subagents: { completed: 1, total: 2 },
      commands: { completed: 1, total: 1 },
    });
  });

  it('treats failed and stopped work as terminal progress', () => {
    const tasks = new Map<string, AgentTaskUpdate>([
      ['failed', update({ taskId: 'failed', status: 'failed' })],
      ['stopped', update({ taskId: 'stopped', status: 'stopped' })],
      ['running', update({ taskId: 'running' })],
    ]);

    expect(summarizeBackgroundTasks(tasks).subagents).toEqual({ completed: 2, total: 3 });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

/**
 * 把一条 SDK system 消息喂给 translator,收集它产生的 AgentEvent。
 * 每个用例用独立 queue / ctx,互不污染。
 */
async function translateOne(msg: Record<string, unknown>): Promise<AgentEvent[]> {
  const queue = createAsyncQueue<AgentEvent>();
  const ctx = {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-sonnet-4-5',
    getEffort: () => 'high',
    getPermissionMode: () => 'auto',
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
  };
  translateSdkMessage(msg as never, queue, ctx as never);
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator — workflow / task_updated', () => {
  it('maps task_updated patch.status=completed → completed (merge by taskId, no parentToolUseId)', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'completed', end_time: 123 },
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    expect(events[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'wf-task-1',
      status: 'completed',
    });
    // task_updated 无 tool_use_id → 不带 parentToolUseId(靠下游按 taskId 合并)
    expect((events[0].data as Record<string, unknown>).parentToolUseId).toBeUndefined();
  });

  it('maps task_updated patch.status=killed → stopped', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'killed' },
    });
    expect(events[0]?.data).toMatchObject({ taskId: 'wf-task-1', status: 'stopped' });
  });

  it('maps task_updated patch.status=pending → running', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'pending' },
    });
    expect(events[0]?.data).toMatchObject({ taskId: 'wf-task-1', status: 'running' });
  });

  it('treats task_updated with error (no status) as failed and surfaces it as summary', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { error: 'boom' },
    });
    expect(events[0]?.data).toMatchObject({
      taskId: 'wf-task-1',
      status: 'failed',
      summary: 'boom',
    });
  });

  it('skips a description-only task_updated (no status / error) so it cannot reset a terminal status', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { description: 'still working', is_backgrounded: true },
    });
    expect(events).toEqual([]);
  });

  it('ignores task_updated without a patch', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
    });
    expect(events).toEqual([]);
  });

  it('passes through narrowed workflow_progress on task_progress', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf-task-1',
      tool_use_id: 'toolu-wf',
      task_type: 'local_workflow',
      workflow_progress: [
        { type: 'workflow_phase', index: 0, title: 'Scan', state: 'progress' },
        {
          type: 'workflow_agent',
          index: 0,
          phaseIndex: 0,
          label: 'scanner',
          state: 'start',
          startedAt: 1234,
        },
      ],
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    expect((events[0].data as Record<string, unknown>).workflowProgress).toEqual([
      { type: 'workflow_phase', index: 0, title: 'Scan', state: 'progress' },
      {
        type: 'workflow_agent',
        index: 0,
        phaseIndex: 0,
        label: 'scanner',
        state: 'start',
        startedAt: 1234,
      },
    ]);
  });

  it('omits workflowProgress when the CLI throttles the field away (heartbeat frame)', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf-task-1',
      task_type: 'local_workflow',
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    const data = events[0].data as Record<string, unknown>;
    // 缺失 = 沿用上一帧:payload 里连 key 都不能有,交给下游 merge 保留旧树
    expect('workflowProgress' in data).toBe(false);
  });

  it('drops invalid workflow_progress entries and truncates over-long strings', async () => {
    const longSummary = 'x'.repeat(500);
    const events = await translateOne({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf-task-1',
      workflow_progress: [
        { type: 'not_a_workflow_row', index: 0 }, // 非法 type → 跳过
        { type: 'workflow_agent' }, // 缺 index → 跳过
        { type: 'workflow_agent', index: Number.NaN }, // index 非有限数 → 跳过
        'garbage', // 非对象 → 跳过
        {
          type: 'workflow_agent',
          index: 1,
          label: 'ok',
          lastToolSummary: longSummary,
        },
      ],
    });
    const data = events[0].data as Record<string, unknown>;
    const progress = data.workflowProgress as Array<Record<string, unknown>>;
    expect(progress).toHaveLength(1);
    expect(progress[0].type).toBe('workflow_agent');
    expect(progress[0].index).toBe(1);
    expect(progress[0].label).toBe('ok');
    // lastToolSummary 收窄上限 160(截断后以 … 结尾)
    expect((progress[0].lastToolSummary as string).length).toBe(160);
    expect((progress[0].lastToolSummary as string).endsWith('…')).toBe(true);
  });

  it('omits workflowProgress entirely when no entry survives narrowing', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf-task-1',
      workflow_progress: [{ type: 'bogus', index: 0 }],
    });
    const data = events[0].data as Record<string, unknown>;
    expect('workflowProgress' in data).toBe(false);
  });

  it('passes through task_type=local_workflow and workflow_name on task_started', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf-task-1',
      tool_use_id: 'toolu-wf',
      task_type: 'local_workflow',
      workflow_name: 'parallel-news-scan',
      description: 'Scan news in parallel',
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    expect(events[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'wf-task-1',
      parentToolUseId: 'toolu-wf',
      status: 'running',
      taskType: 'local_workflow',
      workflowName: 'parallel-news-scan',
    });
  });
});

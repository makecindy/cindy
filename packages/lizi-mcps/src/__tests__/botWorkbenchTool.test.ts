import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotWorkbenchTools, type BotWorkbenchCallbacks } from '../xdt-helper/bot_workbench.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

const snapshot = {
  projects: [{ name: 'tapmon-art', path: '/w/tapmon-art', exists: true }],
  tasks: [
    {
      id: 'task-1',
      title: '导出 Android 图标',
      project: 'tapmon-art',
      state: 'stopped' as const,
      kind: 'existing' as const,
      summary: '只差导出',
      lastActiveAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  automations: [],
  counts: { running: 0, waiting: 0, queued: 0, stopped: 1, automation: 0, done: 0 },
  truncated: false,
  totalTasks: 1,
};

function setup(sessionId: string | null = 'bot-session') {
  const callbacks: BotWorkbenchCallbacks = {
    get: vi.fn(async () => ({ ok: true as const, workbench: snapshot })),
    continueTask: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      taskId,
      delivery: 'queued' as const,
      queuedMessageId: 'q-1',
    })),
    stopTask: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      taskId,
      status: 'requested' as const,
    })),
  };
  const reg = new XdtHelperToolRegistry();
  registerBotWorkbenchTools(reg, {
    getSessionContext: () => ({ sessionId: sessionId ?? undefined, agentKind: 'claude-code', workingDir: '/w' }),
    callbacks,
  });
  return { reg, callbacks };
}

describe('bot workbench tools', () => {
  it('reads the workbench through the caller Session only', async () => {
    const { reg, callbacks } = setup();
    const result = parse(await reg.call('get_workbench', {}));
    expect(result).toMatchObject({ ok: true, workbench: { totalTasks: 1 } });
    expect(callbacks.get).toHaveBeenCalledWith({ callerSessionId: 'bot-session' });
  });

  it('continues and stops a task by id, never by a caller-supplied Bot or project', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'task-1', message: '把剩下的导出做完' })))
      .toMatchObject({ ok: true, task_id: 'task-1', delivery: 'queued', queued_message_id: 'q-1' });
    expect(callbacks.continueTask).toHaveBeenCalledWith({
      callerSessionId: 'bot-session',
      taskId: 'task-1',
      message: '把剩下的导出做完',
    });
    expect(parse(await reg.call('stop_workbench_task', { task_id: 'task-1' })))
      .toMatchObject({ ok: true, task_id: 'task-1', status: 'requested' });
    expect(callbacks.stopTask).toHaveBeenCalledWith({ callerSessionId: 'bot-session', taskId: 'task-1' });
  });

  it('passes host denials through with their error code', async () => {
    const { reg, callbacks } = setup();
    vi.mocked(callbacks.continueTask).mockResolvedValueOnce({
      ok: false,
      errorCode: 'TASK_OUTSIDE_WORKBENCH',
      message: '这件任务不在主人交给你的项目里',
    });
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'other', message: 'hi' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUTSIDE_WORKBENCH' });
  });

  it('rejects blank messages before reaching the host', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'task-1', message: '   ' })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(callbacks.continueTask).not.toHaveBeenCalled();
  });

  it('requires a bound Bot session', async () => {
    const { reg, callbacks } = setup(null);
    expect(parse(await reg.call('get_workbench', {}))).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(parse(await reg.call('stop_workbench_task', { task_id: 'task-1' })))
      .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(callbacks.get).not.toHaveBeenCalled();
    expect(callbacks.stopTask).not.toHaveBeenCalled();
  });

  it('no longer offers the card-writing tool', () => {
    const { reg } = setup();
    expect(reg.has('update_workbench')).toBe(false);
    expect(reg.has('get_workbench')).toBe(true);
  });
});

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
      taskId: 'claude:abc',
      source: 'claude-code' as const,
      imported: false,
      title: '导出 Android 图标',
      project: 'tapmon-art',
      state: null,
      kind: 'existing' as const,
      summary: null,
      lastActiveAt: '2026-10-01T00:00:00.000Z',
      messageCount: null,
      judgment: null,
    },
  ],
  automations: [],
  counts: { unfinished: 0, idea: 0, done: 0, unjudged: 1 },
  truncated: false,
  totalTasks: 1,
};

function setup(sessionId: string | null = 'bot-session') {
  const callbacks: BotWorkbenchCallbacks = {
    get: vi.fn(async () => ({ ok: true as const, workbench: snapshot })),
    read: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      taskId,
      transcript: { items: [{ role: 'user' as const, text: '导出图标', at: 1 }], truncated: false },
    })),
    set: vi.fn(async ({ taskId, title, verdict, next }: { taskId: string; title: string; verdict: 'unfinished' | 'idea' | 'done'; next?: string | null }) => ({
      ok: true as const,
      taskId,
      judgment: { title, verdict, next: next ?? null, updatedAt: '2026-10-01T00:00:00.000Z' },
    })),
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

  it('reads a candidate and records a judgment for it', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('read_workbench_task', { task_id: 'claude:abc' })))
      .toMatchObject({ ok: true, task_id: 'claude:abc', transcript: { truncated: false } });
    expect(callbacks.read).toHaveBeenCalledWith({ callerSessionId: 'bot-session', taskId: 'claude:abc' });
    expect(
      parse(await reg.call('set_workbench_task', { task_id: 'claude:abc', title: '导出图标', verdict: 'unfinished', next: '补 xxhdpi' })),
    ).toMatchObject({ ok: true, judgment: { verdict: 'unfinished', next: '补 xxhdpi' } });
    expect(callbacks.set).toHaveBeenCalledWith({
      callerSessionId: 'bot-session',
      taskId: 'claude:abc',
      title: '导出图标',
      verdict: 'unfinished',
      next: '补 xxhdpi',
    });
  });

  it('rejects judgments outside the schema before reaching the host', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('set_workbench_task', { task_id: 't', title: 'x'.repeat(41), verdict: 'done' })).ok).toBe(false);
    expect(parse(await reg.call('set_workbench_task', { task_id: 't', title: '标题', verdict: 'maybe' })).ok).toBe(false);
    expect(callbacks.set).not.toHaveBeenCalled();
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
    for (const name of ['get_workbench', 'read_workbench_task', 'set_workbench_task', 'continue_workbench_task', 'stop_workbench_task']) {
      expect(reg.has(name)).toBe(true);
    }
  });
});

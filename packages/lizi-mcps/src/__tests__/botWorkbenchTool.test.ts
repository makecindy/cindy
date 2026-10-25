import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotWorkbenchTools, type BotWorkbenchCallbacks } from '../xdt-helper/bot_workbench.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

/**
 * 测试价值
 * - 生产入口与可观察结果:registerBotWorkbenchTools 注册的工具经 registry.call 返回给模型的 JSON。
 * - 规则依据:2026-10-17 放弃「项目」——工作台改为「一眼」(等你 / 在做),项目与判断工具删除;
 *   伙伴身份只从调用方 Session 派生,工具不收 botId / 目录。
 * - 现有覆盖缺口:旧用例覆盖的是项目增删、判断写入与候选快照,随功能删除;「一眼」投影给模型的
 *   形状(task_id 可直接交给 get_task_digest、只在需要时出现的字段)此前没有覆盖。
 * - 最小失败输入:离线电脑上的等待行、由别的伙伴在跟的行、撞上用量上限的在做行(phase 不能丢,兜底叫醒靠它找)、
 *   空白消息、未绑定 Session。
 * - tier:unit(纯工具层,宿主回调全部 mock)。
 */
const glance = {
  botId: 'cindy-default',
  scope: 'all' as const,
  waiting: [
    {
      sessionId: 'laptop::s-9',
      deviceId: 'laptop',
      deviceName: 'MacBook',
      online: false,
      title: '修登录',
      kind: 'waiting' as const,
      phase: 'waiting-answer',
      minutes: 7,
      question: '要不要删旧表?',
      waitingFor: 'answer' as const,
      followerBotId: 'writer',
    },
  ],
  working: [
    {
      sessionId: 's-1',
      deviceId: null,
      deviceName: null,
      online: true,
      title: '跑测试',
      kind: 'working' as const,
      phase: 'usage-limit',
      minutes: 3,
      question: null,
      waitingFor: null,
      followerBotId: 'cindy-default',
    },
  ],
  lastSweepAt: Date.UTC(2026, 9, 17, 5, 0, 0),
  doneToday: 2,
  offlineDevices: ['MacBook'],
};

function setup(sessionId: string | null = 'bot-session', todos?:BotWorkbenchCallbacks['todos']) {
  const callbacks: BotWorkbenchCallbacks = {
    ...(todos ? {todos} : {}),
    setResponsibility: vi.fn(async ({ taskId, responsible }) => ({ ok: true as const, taskId, responsible })),
    get: vi.fn(async () => ({ ok: true as const, workbench: glance })),
    read: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      taskId,
      transcript: { items: [{ role: 'user' as const, text: '修登录', at: 1 }], truncated: false },
    })),
    continueTask: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true as const,
      taskId,
      delivery: 'queued' as const,
      queuedMessageId: 'q-1',
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
  it('shows the glance to the model with task ids ready for get_task_digest', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('get_workbench', {}))).toEqual({
      ok: true,
      workbench: {
        scope: 'all',
        waiting: [{
          task_id: 'laptop::s-9', title: '修登录', phase: 'waiting-answer', minutes: 7, device: 'MacBook', online: false,
          waiting_for: 'answer', question: '要不要删旧表?', followed_by: 'writer',
        }],
        working: [{ task_id: 's-1', title: '跑测试', phase: 'usage-limit', minutes: 3 }],
        done_today: 2,
        last_sweep_at: '2026-10-17T05:00:00.000Z',
        offline_devices: ['MacBook'],
      },
    });
    expect(callbacks.get).toHaveBeenCalledWith({ callerSessionId: 'bot-session' });
  });

  it('reads and continues a task by id (local or deviceId::sessionId), never by a caller-supplied Bot', async () => {
    const { reg, callbacks } = setup();
    expect(parse(await reg.call('read_workbench_task', { task_id: 'laptop::s-9' })))
      .toMatchObject({ ok: true, task_id: 'laptop::s-9', transcript: { truncated: false } });
    expect(callbacks.read).toHaveBeenCalledWith({ callerSessionId: 'bot-session', taskId: 'laptop::s-9' });
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'task-1', message: '汇报当前进展并继续', bot_id: 'other' })).ok).toBe(false);
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'task-1', message: '汇报当前进展并继续' })))
      .toEqual({ ok: true, task_id: 'task-1', delivery: 'queued', queued_message_id: 'q-1' });
    expect(callbacks.continueTask).toHaveBeenCalledWith({
      callerSessionId: 'bot-session',
      taskId: 'task-1',
      message: '汇报当前进展并继续',
    });
  });

  it('passes host denials through with their error code', async () => {
    const { reg, callbacks } = setup();
    vi.mocked(callbacks.continueTask).mockResolvedValueOnce({
      ok: false,
      errorCode: 'TASK_NOT_RESPONSIBLE',
      message: '这件任务没有交给你跟进',
    });
    expect(parse(await reg.call('continue_workbench_task', { task_id: 'other', message: 'hi' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_NOT_RESPONSIBLE' });
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
    expect(callbacks.get).not.toHaveBeenCalled();
  });

  it('no longer offers project, judgment, card-writing or duplicate stop tools', () => {
    const { reg } = setup();
    for (const name of ['update_workbench', 'stop_workbench_task', 'set_workbench_task', 'set_workbench_tasks', 'add_workbench_project', 'remove_workbench_project']) {
      expect(reg.has(name)).toBe(false);
    }
    for (const name of ['get_workbench', 'read_workbench_task', 'continue_workbench_task']) {
      expect(reg.has(name)).toBe(true);
    }
  });
});

describe('teammate affair discovery tools',()=>{
  it('registers project-free APIs and binds writes to the canonical caller context',async()=>{
    const callback=vi.fn(async()=>({ok:true as const,todo:{id:'one'}}));const {reg}=setup('canonical',callback);
    expect(parse(await reg.call('update_teammate_todo',{patch:{key:'mail:quote',title:'Compare quote',outcome:'User accepts comparison',origin:'discovered'}}))).toMatchObject({ok:true,todo:{id:'one'}});
    expect(callback).toHaveBeenCalledWith('canonical','update',{key:'mail:quote',title:'Compare quote',outcome:'User accepts comparison',origin:'discovered'});
    await reg.call('preflight_teammate_todo_events',{events:[{source:'mail',sequence:4,key:'quote'}]});
    expect(callback).toHaveBeenLastCalledWith('canonical','preflight',[{source:'mail',sequence:4,key:'quote'}]);
  });
  it('rejects malformed action/evidence input before invoking the host',async()=>{
    const callback=vi.fn(async()=>({ok:true as const}));const {reg}=setup(null,callback);
    expect(parse(await reg.call('list_teammate_todos',{}))).toMatchObject({ok:false,errorCode:'NOT_A_BOT_SESSION'});
    expect(callback).not.toHaveBeenCalled();
    const live=setup('canonical',callback);const response=await live.reg.call('update_teammate_todo',{patch:{operation:'complete',completion:{summary:42}}});
    expect(response.isError).toBe(true);expect(callback).not.toHaveBeenCalled();
  });
});

it('takes/releases by exact task ID with caller-derived bot identity', async () => {
  const { reg, callbacks } = setup();
  for (const responsible of [true, false]) {
    expect(parse(await reg.call('set_workbench_task_responsibility', { task_id: 'one', responsible })))
      .toMatchObject({ ok: true, task_id: 'one', responsible });
    expect(callbacks.setResponsibility).toHaveBeenLastCalledWith({ callerSessionId: 'bot-session', taskId: 'one', responsible });
  }
  vi.mocked(callbacks.setResponsibility!).mockClear();
  expect(parse(await reg.call('set_workbench_task_responsibility', { task_id: 'one', responsible: true, bot_id: 'other' })).ok).toBe(false);
  expect(parse(await reg.call('set_workbench_task_responsibility', { task_id: 'one', responsible: 'yes' })).ok).toBe(false);
  expect(callbacks.setResponsibility).not.toHaveBeenCalled();
});


it('keeps older hosts usable without advertising an unavailable responsibility writer', () => {
  const { callbacks } = setup();
  delete callbacks.setResponsibility;
  const reg = new XdtHelperToolRegistry();
  registerBotWorkbenchTools(reg, { callbacks, getSessionContext: () => ({ sessionId: 'main', agentKind: 'claude-code', workingDir: '/w' }) });
  const names = reg.list('bots').map(tool => tool.name);
  expect(names).toContain('get_workbench');
  expect(names).not.toContain('set_workbench_task_responsibility');
});

// Restored links are independently discoverable; no task responsibility callback runs when linking.
// Minimal input: list + one project toggle with a caller session. Unit tool registry contract.
it('exposes project discovery and changes using caller identity without claiming any tasks', async () => {
  const { callbacks } = setup();
  callbacks.projects = vi.fn(async () => ({ ok: true as const, projects: [{ project_id: 'a'.repeat(64), working_dir: '/project', linked: true }] }));
  const registry = new XdtHelperToolRegistry();
  registerBotWorkbenchTools(registry, { callbacks, getSessionContext: () => ({ sessionId: 'main', agentKind: 'codex', workingDir: '/home' }) });
  expect(parse(await registry.call('list_teammate_projects', {}))).toMatchObject({ ok: true, projects: [{ linked: true }] });
  await registry.call('set_teammate_project', { project_id: 'a'.repeat(64), linked: false });
  expect(callbacks.projects).toHaveBeenLastCalledWith({ callerSessionId: 'main', projectId: 'a'.repeat(64), linked: false });
  expect(callbacks.setResponsibility).not.toHaveBeenCalled();
  const unbound = new XdtHelperToolRegistry();
  registerBotWorkbenchTools(unbound, { callbacks, getSessionContext: () => ({ agentKind: 'codex', workingDir: '/home' }) });
  expect(parse(await unbound.call('list_teammate_projects', {}))).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
});

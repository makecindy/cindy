/**
 * listSessionTasks 单测 —— 「后台任务」面板任务枚举纯函数。
 * 覆盖:配对 / 去重 / 孤儿 gating / 历史 completed 推导 / 后台 Bash 识别 /
 * 分区排序 / 未知 taskType。构造最小 Message / AgentTaskUpdate 字面量,
 * 不触碰 store / transport。
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '@/lib/ccAgent.types';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';

import { listSessionTasks } from '../listSessionTasks';

// ---------------------------------------------------------------------------
// 构造器:Message 必填字段(id/clientId/sessionId/role/content/toolUseId/
// agentMeta/createdAt)全给默认值,测试只声明差异部分。
// ---------------------------------------------------------------------------

function baseMessage(partial: Partial<Message> & Pick<Message, 'clientId' | 'role'>): Message {
  return {
    id: partial.clientId,
    sessionId: 's1',
    content: '',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    ...partial,
  } as Message;
}

/** tool_use 行:DB 形态,toolName/input 存 content 对象里。 */
function toolUse(
  clientId: string,
  toolUseId: string | null,
  toolName: string,
  input: unknown = {},
): Message {
  return baseMessage({
    clientId,
    role: 'tool_use',
    toolUseId,
    content: { toolName, input },
  });
}

function toolResult(clientId: string, toolUseId: string | null, content = 'ok'): Message {
  return baseMessage({ clientId, role: 'tool_result', toolUseId, content });
}

function assistant(clientId: string, content = 'text'): Message {
  return baseMessage({ clientId, role: 'assistant', content });
}

function makeUpdate(partial: Partial<AgentTaskUpdate> & Pick<AgentTaskUpdate, 'taskId'>): AgentTaskUpdate {
  return {
    provider: 'claude-code',
    status: 'running',
    ...partial,
  };
}

/** 模拟 store reducer 的多 key 别名:taskId 与 parentToolUseId 指向同一 update。 */
function aliasedMap(update: AgentTaskUpdate): Map<string, AgentTaskUpdate> {
  const map = new Map<string, AgentTaskUpdate>();
  map.set(update.taskId, update);
  if (update.parentToolUseId) map.set(update.parentToolUseId, update);
  return map;
}

// ---------------------------------------------------------------------------
// 配对
// ---------------------------------------------------------------------------

describe('listSessionTasks 配对', () => {
  it('Task toolCall 按 toolUseId 配上 update,一行,key = taskId', () => {
    const update = makeUpdate({
      taskId: 'task-1',
      parentToolUseId: 'toolu-1',
      title: 'Review auth flow',
    });
    const { running, completed } = listSessionTasks({
      messages: [toolUse('c1', 'toolu-1', 'Task', { description: 'fallback desc' })],
      taskUpdates: aliasedMap(update),
      isSessionStreaming: true,
    });
    expect(completed).toHaveLength(0);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      key: 'task-1',
      taskId: 'task-1',
      kind: 'agent',
      title: 'Review auth flow',
      status: 'running',
      provider: 'claude-code',
      toolCallClientId: 'c1',
      toolUseId: 'toolu-1',
    });
    expect(running[0].update).toBe(update);
  });

  it('toolUseId 查不到时回退 clientId 配对(findTaskUpdate 同口径)', () => {
    const update = makeUpdate({ taskId: 'task-2', title: 'By clientId' });
    const map = new Map<string, AgentTaskUpdate>([['c2', update]]);
    const { running } = listSessionTasks({
      messages: [toolUse('c2', 'toolu-2', 'Task')],
      taskUpdates: map,
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(1);
    expect(running[0].update).toBe(update);
    expect(running[0].title).toBe('By clientId');
  });

  it('collab:* toolCall 无 update 时 provider = codex', () => {
    const { running } = listSessionTasks({
      messages: [toolUse('c3', 'toolu-3', 'collab:reviewer', { description: 'review it' })],
      taskUpdates: undefined,
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ kind: 'agent', provider: 'codex', title: 'review it' });
  });

  it('uses the shared result status derivation and keeps V1 running receipts running', () => {
    const runningUpdate = makeUpdate({ taskId: 'task-running', parentToolUseId: 'toolu-running' });
    const completedUpdate = makeUpdate({ taskId: 'task-completed', parentToolUseId: 'toolu-completed' });
    const failedUpdate = makeUpdate({
      taskId: 'task-failed',
      parentToolUseId: 'toolu-failed',
      status: 'failed',
    });
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-running', 'collab:spawnAgent'),
        toolResult('r1', 'toolu-running', 'child-thread: running'),
        toolUse('c2', 'toolu-completed', 'collab:spawnAgent'),
        toolResult('r2', 'toolu-completed', 'child-thread: completed'),
        toolUse('c3', 'toolu-failed', 'collab:spawnAgent'),
        toolResult('r3', 'toolu-failed', 'child-thread: failed'),
      ],
      taskUpdates: new Map([
        ...aliasedMap(runningUpdate),
        ...aliasedMap(completedUpdate),
        ...aliasedMap(failedUpdate),
      ]),
      isSessionStreaming: false,
    });

    expect(running).toMatchObject([{ taskId: 'task-running', status: 'running' }]);
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-completed', status: 'completed' }),
      expect.objectContaining({ taskId: 'task-failed', status: 'failed' }),
    ]));
  });

  it('历史 workflow(无 update):从结果文本「Task ID: xxx」提取 taskId(详情读 wf 文件用)', () => {
    const { completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-wf', 'Workflow'),
        toolResult(
          'r1',
          'toolu-wf',
          'Workflow launched in background. Task ID: w9gvjxzk1\nSummary: 回归 review',
        ),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ kind: 'workflow', taskId: 'w9gvjxzk1' });
  });

  it('历史 workflow:JSON 化结果里的 "taskId" 同样可提取;提不到时 taskId 缺省不误伤', () => {
    const { completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'tu-json', 'Workflow'),
        toolResult('r1', 'tu-json', '{"status":"async_launched","taskId":"abc123xyz"}'),
        toolUse('c2', 'tu-none', 'Workflow'),
        toolResult('r2', 'tu-none', '完成了,没有任何 id 线索。'),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    const byToolUseId = (id: string) => completed.find((it) => it.toolUseId === id)!;
    expect(byToolUseId('tu-json').taskId).toBe('abc123xyz');
    expect(byToolUseId('tu-none').taskId).toBeUndefined();
  });

  it('无 toolUseId 的旧 Workflow:adjacency 命中的结果文本同样恢复 taskId(与 settled 判定同口径)', () => {
    const { completed } = listSessionTasks({
      messages: [
        toolUse('c1', null, 'Workflow'),
        toolResult('r1', null, 'Workflow launched in background. Task ID: wf_legacy7'),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      kind: 'workflow',
      status: 'completed',
      taskId: 'wf_legacy7',
    });
  });

  it('workflow 条目携带 resultPreview(保留换行、截断);非 workflow 不带', () => {
    // 详情视图降级兜底(事件树与 wf 文件都拿不到时)的数据来源。
    const longTail = 'x'.repeat(3000);
    const { completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'tu-wf', 'Workflow'),
        toolResult('r1', 'tu-wf', `第一行结论\n第二行明细\n${longTail}`),
        toolUse('c2', 'tu-task', 'Task', { description: 'agent task' }),
        toolResult('r2', 'tu-task', 'agent result'),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    const wf = completed.find((it) => it.toolUseId === 'tu-wf')!;
    expect(wf.resultPreview).toContain('第一行结论\n第二行明细');
    expect(wf.resultPreview!.length).toBeLessThanOrEqual(2000);
    expect(wf.resultPreview!.endsWith('…')).toBe(true);
    expect(completed.find((it) => it.toolUseId === 'tu-task')!.resultPreview).toBeUndefined();
  });

  it('提取出的 taskId 进去重别名:同 taskId 的孤儿 update 不再重复出行', () => {
    const orphan = makeUpdate({ taskId: 'w9gvjxzk1', taskType: 'local_workflow' });
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-wf', 'Workflow'),
        toolResult('r1', 'toolu-wf', 'Workflow launched in background. Task ID: w9gvjxzk1'),
      ],
      // update 只按 taskId 建 key(配对查不到 → 本会走孤儿通道)
      taskUpdates: new Map([['w9gvjxzk1', orphan]]),
      isSessionStreaming: true,
    });
    expect(running.length + completed.length).toBe(1);
  });

  it('Workflow toolCall → kind workflow,标题优先 update.workflowName', () => {
    const update = makeUpdate({
      taskId: 'wf-1',
      parentToolUseId: 'toolu-wf',
      taskType: 'local_workflow',
      workflowName: 'nightly-release',
      title: 'should not win',
    });
    const { running } = listSessionTasks({
      messages: [toolUse('c4', 'toolu-wf', 'Workflow')],
      taskUpdates: aliasedMap(update),
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ kind: 'workflow', title: 'nightly-release' });
  });
});

// ---------------------------------------------------------------------------
// 去重
// ---------------------------------------------------------------------------

describe('listSessionTasks 去重', () => {
  it('同一任务的 toolCall 与多 key 别名 update 只出一行(不再当孤儿补渲染)', () => {
    const update = makeUpdate({ taskId: 'task-1', parentToolUseId: 'toolu-1' });
    const { running, completed } = listSessionTasks({
      messages: [toolUse('c1', 'toolu-1', 'Task', { description: 'd' })],
      taskUpdates: aliasedMap(update), // 两个 key 指向同一 update
      isSessionStreaming: true, // 孤儿通道开着也不得重复
    });
    expect(running.length + completed.length).toBe(1);
  });

  it('重复 toolUseId 的 toolCall 只出一行(首行为准)', () => {
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-dup', 'Task', { description: 'first' }),
        toolUse('c2', 'toolu-dup', 'Task', { description: 'second' }),
      ],
      taskUpdates: undefined,
      isSessionStreaming: true,
    });
    expect(running.length + completed.length).toBe(1);
    expect(running[0]?.title).toBe('first');
  });

  it('孤儿区内同一任务的多 key 别名只出一行', () => {
    const update = makeUpdate({ taskId: 'task-x', parentToolUseId: 'toolu-x' });
    const { running } = listSessionTasks({
      messages: [],
      taskUpdates: aliasedMap(update),
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(1);
    expect(running[0].taskId).toBe('task-x');
  });
});

// ---------------------------------------------------------------------------
// 孤儿 gating
// ---------------------------------------------------------------------------

describe('listSessionTasks 孤儿 gating', () => {
  const orphan = makeUpdate({ taskId: 'orphan-1', title: 'Codex collab', provider: 'codex' });

  it('isSessionStreaming=true:孤儿 update 列出,orderIndex 排在消息之后', () => {
    const { running } = listSessionTasks({
      messages: [toolUse('c1', 'toolu-1', 'Task', { description: 'inline' })],
      taskUpdates: new Map([['orphan-1', orphan]]),
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(2);
    const orphanItem = running.find((it) => it.taskId === 'orphan-1');
    expect(orphanItem).toMatchObject({
      key: 'orphan-1',
      kind: 'agent', // 无 taskType 的孤儿默认 agent(codex collab 典型形态)
      provider: 'codex',
      title: 'Codex collab',
    });
    // 孤儿排最后:orderIndex 大于消息窗口内条目
    expect(orphanItem!.orderIndex).toBeGreaterThan(running.find((it) => it.taskId !== 'orphan-1')!.orderIndex);
  });

  it('isSessionStreaming=false:终态孤儿是陈旧残留,不列出', () => {
    const doneOrphan = makeUpdate({ taskId: 'orphan-done', status: 'completed' });
    const { running, completed } = listSessionTasks({
      messages: [],
      taskUpdates: new Map([['orphan-done', doneOrphan]]),
      isSessionStreaming: false,
    });
    expect(running).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  it('isSessionStreaming=false:running 孤儿仍列出(workflow 内部长命后台命令跨 turn 存活)', () => {
    const liveBash = makeUpdate({
      taskId: 'orphan-bash',
      taskType: 'local_bash',
      title: 'pnpm dev',
    });
    const { running } = listSessionTasks({
      messages: [],
      taskUpdates: new Map([['orphan-bash', liveBash]]),
      isSessionStreaming: false,
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ taskId: 'orphan-bash', kind: 'bash' });
  });
});

// ---------------------------------------------------------------------------
// 历史 completed 推导(无 update)
// ---------------------------------------------------------------------------

describe('listSessionTasks 历史条目状态推导', () => {
  it('有 tool_result(toolUseId 命中)→ completed;没有且非流式 → stopped(死任务不转圈)', () => {
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-done', 'Task', { description: 'done task' }),
        assistant('a1'),
        toolUse('c2', 'toolu-open', 'Task', { description: 'open task' }),
        // 结果行不紧邻(orphan tool_result append 到末尾),toolUseId 查表仍要配上
        toolResult('r1', 'toolu-done'),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    expect(running).toHaveLength(0);
    expect(completed).toHaveLength(2);
    expect(completed.find((it) => it.title === 'done task')).toMatchObject({ status: 'completed' });
    // 强杀/崩溃留下的 tool_use(无结果、无 update、会话非流式):同步 Task 永远
    // 不会再有结果,断言 running 会永久转圈 —— 按 stopped(被中断)呈现。
    expect(completed.find((it) => it.title === 'open task')).toMatchObject({ status: 'stopped' });
  });

  it('流式中无结果的行仍为 running(事件可能尚未到达)', () => {
    const { running } = listSessionTasks({
      messages: [toolUse('c1', 'toolu-open', 'Task', { description: 'open task' })],
      taskUpdates: undefined,
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ title: 'open task', status: 'running' });
  });

  it('旧数据 toolUseId 缺失:紧邻 tool_result 的 adjacency 兜底 → completed', () => {
    const { completed } = listSessionTasks({
      messages: [toolUse('c1', null, 'Task', { description: 'legacy' }), toolResult('r1', null)],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ title: 'legacy', status: 'completed', key: 'c1' });
  });

  it('标题链:无 update 时 description 优先,缺 description 回退 prompt 并截断', () => {
    const longPrompt = 'p'.repeat(200);
    const { running } = listSessionTasks({
      messages: [toolUse('c1', 'toolu-1', 'Task', { prompt: longPrompt })],
      taskUpdates: undefined,
      isSessionStreaming: true,
    });
    expect(running[0].title).toHaveLength(96);
    expect(running[0].title.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 后台 Bash 识别
// ---------------------------------------------------------------------------

describe('listSessionTasks 后台 Bash', () => {
  it('run_in_background=true 的 Bash 进列表,kind=bash,标题 description ?? command', () => {
    const { running } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-1', 'Bash', { run_in_background: true, command: 'pnpm dev' }),
        toolUse('c2', 'toolu-2', 'Bash', {
          run_in_background: true,
          command: 'pnpm test:unit',
          description: 'Run unit tests',
        }),
      ],
      taskUpdates: undefined,
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(2);
    expect(running[0]).toMatchObject({ kind: 'bash', title: 'pnpm dev', provider: 'claude-code' });
    expect(running[1]).toMatchObject({ kind: 'bash', title: 'Run unit tests' });
  });

  it('前台 Bash 与其他普通工具不进列表', () => {
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'toolu-1', 'Bash', { command: 'ls' }),
        toolUse('c2', 'toolu-2', 'Bash', { command: 'ls', run_in_background: false }),
        toolUse('c3', 'toolu-3', 'Read', { file_path: '/tmp/x' }),
      ],
      taskUpdates: undefined,
      isSessionStreaming: false,
    });
    expect(running).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 分区排序
// ---------------------------------------------------------------------------

describe('listSessionTasks 分区排序', () => {
  it('running 按出现顺序升序;failed/stopped/completed 全进 completed 区', () => {
    const failed = makeUpdate({ taskId: 't-f', parentToolUseId: 'tu-f', status: 'failed' });
    const stopped = makeUpdate({ taskId: 't-s', parentToolUseId: 'tu-s', status: 'stopped' });
    const map = new Map<string, AgentTaskUpdate>([
      ...aliasedMap(failed),
      ...aliasedMap(stopped),
    ]);
    const { running, completed } = listSessionTasks({
      messages: [
        toolUse('c1', 'tu-a', 'Task', { description: 'first running' }),
        toolUse('c2', 'tu-f', 'Task', { description: 'failed one' }),
        toolUse('c3', 'tu-s', 'Task', { description: 'stopped one' }),
        toolUse('c4', 'tu-b', 'Task', { description: 'second running' }),
      ],
      taskUpdates: map,
      isSessionStreaming: true,
    });
    expect(running.map((it) => it.title)).toEqual(['first running', 'second running']);
    expect(completed.map((it) => it.status).sort()).toEqual(['failed', 'stopped']);
  });

  it('completed 按 update.updatedAt 倒序;缺 updatedAt 的历史条目排后、组内 orderIndex 倒序', () => {
    const older = makeUpdate({
      taskId: 't-old',
      parentToolUseId: 'tu-old',
      status: 'completed',
      updatedAt: '2026-07-27T01:00:00.000Z',
    });
    const newer = makeUpdate({
      taskId: 't-new',
      parentToolUseId: 'tu-new',
      status: 'completed',
      updatedAt: '2026-07-27T02:00:00.000Z',
    });
    const map = new Map<string, AgentTaskUpdate>([
      ...aliasedMap(older),
      ...aliasedMap(newer),
    ]);
    const { completed } = listSessionTasks({
      messages: [
        // 两条无 update 的历史条目(有结果 → completed,无时间戳)
        toolUse('h1', 'tu-h1', 'Task', { description: 'history early' }),
        toolResult('r1', 'tu-h1'),
        toolUse('h2', 'tu-h2', 'Task', { description: 'history late' }),
        toolResult('r2', 'tu-h2'),
        toolUse('c1', 'tu-old', 'Task', { description: 'older live' }),
        toolUse('c2', 'tu-new', 'Task', { description: 'newer live' }),
      ],
      taskUpdates: map,
      isSessionStreaming: false,
    });
    expect(completed.map((it) => it.taskId ?? it.toolUseId)).toEqual([
      't-new', // updatedAt 最新
      't-old',
      'tu-h2', // 无时间戳:orderIndex 倒序
      'tu-h1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 未知 taskType
// ---------------------------------------------------------------------------

describe('listSessionTasks 未知 taskType', () => {
  it("词表外 taskType → kind 'other',不隐藏(toolCall 配对与孤儿两条路径)", () => {
    const paired = makeUpdate({
      taskId: 't-1',
      parentToolUseId: 'tu-1',
      taskType: 'local_mystery',
      title: 'paired mystery',
    });
    const orphan = makeUpdate({ taskId: 't-2', taskType: 'local_mystery', title: 'orphan mystery' });
    const map = new Map<string, AgentTaskUpdate>([...aliasedMap(paired), ['t-2', orphan]]);
    const { running } = listSessionTasks({
      messages: [toolUse('c1', 'tu-1', 'Task')],
      taskUpdates: map,
      isSessionStreaming: true,
    });
    expect(running).toHaveLength(2);
    expect(running.map((it) => it.kind)).toEqual(['other', 'other']);
    expect(running.map((it) => it.title)).toEqual(['paired mystery', 'orphan mystery']);
  });

  it("既知 taskType 词表:local_agent/local_workflow/local_bash 映射 agent/workflow/bash", () => {
    const agent = makeUpdate({ taskId: 'a1', taskType: 'local_agent' });
    const wf = makeUpdate({ taskId: 'w1', taskType: 'local_workflow' });
    const bash = makeUpdate({ taskId: 'b1', taskType: 'local_bash' });
    const map = new Map<string, AgentTaskUpdate>([
      ['a1', agent],
      ['w1', wf],
      ['b1', bash],
    ]);
    const { running } = listSessionTasks({
      messages: [],
      taskUpdates: map,
      isSessionStreaming: true,
    });
    expect(running.map((it) => [it.taskId, it.kind])).toEqual([
      ['a1', 'agent'],
      ['w1', 'workflow'],
      ['b1', 'bash'],
    ]);
  });
});

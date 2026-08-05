import { describe, expect, it } from 'vitest';
import {
  buildMobileMessageRenderItems,
  extractTodosFromMessage,
  formatDuration,
  insertMobileForkOriginItem,
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import { reconcileMobileMessageRenderItems } from '@/session/messageRenderReconcile';
import { buildAgentTaskCardModel, type AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import { CONTINUE_AFTER_ERROR_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import type { RemoteMessage, RemoteMessageRole } from '@/session/types';

function message(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

function toolUse(id: string, toolName: string, input: unknown, seconds: number): RemoteMessage {
  return message({
    id,
    role: 'tool_use',
    toolUseId: id,
    content: { toolUseId: id, toolName, input },
    createdAt: at(seconds),
  });
}

describe('messageRenderModel', () => {
  it('reuses unchanged history rows and attachment view models during a streaming tail update', () => {
    const user = message({
      id: 'user-1',
      role: 'user',
      content: {
        text: '带附件的请求',
        images: [{ url: 'https://example.com/image.png', name: 'image.png' }],
        files: [],
      },
      createdAt: at(1),
    });
    const firstAssistant = message({
      id: 'assistant-1',
      role: 'assistant',
      content: '第一段',
      agentMeta: { isStreaming: true },
      createdAt: at(2),
    });
    const first = buildMobileMessageRenderItems([user, firstAssistant], { isSessionStreaming: true });

    const nextAssistant = { ...firstAssistant, content: '第一段继续' };
    const next = buildMobileMessageRenderItems([user, nextAssistant], { isSessionStreaming: true });
    const reconciled = reconcileMobileMessageRenderItems(first, next);

    expect(reconciled[0]).toBe(first[0]);
    expect(reconciled[1]).not.toBe(first[1]);
    const previousUser = expectType(first[0], 'message');
    const nextUser = expectType(reconciled[0], 'message');
    expect(nextUser.message).toBe(previousUser.message);
    expect(nextUser.message.attachments).toBe(previousUser.message.attachments);
  });

  it('reuses rows after an equivalent history refresh with newly deserialized messages', () => {
    const messages = [
      message({
        id: 'user-1',
        role: 'user',
        content: { text: '历史请求', images: [], files: [] },
        createdAt: at(1),
      }),
      message({ id: 'assistant-1', role: 'assistant', content: '历史回答', createdAt: at(2) }),
    ];
    const first = buildMobileMessageRenderItems(messages);
    const refreshed = buildMobileMessageRenderItems(
      JSON.parse(JSON.stringify(messages)) as RemoteMessage[],
    );
    const reconciled = reconcileMobileMessageRenderItems(first, refreshed);

    expect(reconciled).toBe(first);
    expect(reconciled[0]).toBe(first[0]);
    expect(reconciled[1]).toBe(first[1]);
  });

  it('groups consecutive tool calls and preserves matching tool_result previews', () => {
    const items = buildMobileMessageRenderItems([
      toolUse('read-1', 'Read', { file_path: '/repo/a.ts' }, 1),
      message({
        id: 'result-1',
        role: 'tool_result',
        toolUseId: 'read-1',
        content: 'file A',
        createdAt: at(2),
      }),
      toolUse('grep-1', 'Grep', { pattern: 'TODO' }, 3),
      message({
        id: 'answer',
        role: 'assistant',
        content: 'done',
        createdAt: at(10),
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['work_group', 'message']);
    const group = expectType(items[0], 'work_group');
    expect(group.children).toHaveLength(1);
    const tools = expectType(group.children[0], 'tool_group');
    expect(tools.key).toBe('tools-read-1');
    expect(tools.tools.map((tool) => [tool.label, tool.body, tool.secondaryBody])).toEqual([
      ['Read', 'Read(/repo/a.ts)', 'file A'],
      ['Grep', 'Grep(TODO)', undefined],
    ]);
  });

  it('extracts TodoWrite updates into one stable todo card instead of a tool row', () => {
    const todo1 = toolUse('todo-1', 'TodoWrite', {
      todos: [
        { content: 'Inspect desktop flow', status: 'in_progress' },
        { content: 'Patch mobile UI', status: 'pending' },
      ],
    }, 1);
    const todo2 = toolUse('todo-2', 'TodoWrite', {
      todos: [
        { content: 'Inspect desktop flow', status: 'completed' },
        { content: 'Patch mobile UI', status: 'in_progress' },
      ],
    }, 2);

    expect(extractTodosFromMessage(todo1)).toEqual([
      { content: 'Inspect desktop flow', status: 'in_progress', activeForm: undefined },
      { content: 'Patch mobile UI', status: 'pending', activeForm: undefined },
    ]);

    const items = buildMobileMessageRenderItems([
      todo1,
      todo2,
      message({ id: 'answer', role: 'assistant', content: 'patched', createdAt: at(5) }),
    ]);

    // 桌面共享实现下 todo 卡作为顶层独立项渲染,不再折叠进 work_group。
    expect(items.map((item) => item.type)).toEqual(['todo', 'message']);
    const todo = expectType(items[0], 'todo');
    expect(todo.key).toBe('todo-todo-1');
    expect(todo.todos).toEqual([
      { content: 'Inspect desktop flow', status: 'completed', activeForm: undefined },
      { content: 'Patch mobile UI', status: 'in_progress', activeForm: undefined },
    ]);
  });

  it('keeps interrupted historical plans frozen while the current plan is live', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'user-old', role: 'user', content: 'old turn', createdAt: at(1) }),
      toolUse('plan-old', 'update_plan', {
        plan: [{ step: 'Old task', status: 'in_progress' }],
      }, 2),
      message({ id: 'user-current', role: 'user', content: 'new turn', createdAt: at(3) }),
      toolUse('todo-current', 'TodoWrite', {
        todos: [{ content: 'Current task', status: 'in_progress' }],
      }, 4),
    ], { isSessionStreaming: true });

    const todos = items.filter((item) => item.type === 'todo');
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({ key: 'todo-plan-old', isStreaming: false });
    expect(todos[1]).toMatchObject({ key: 'todo-todo-current', isStreaming: true });
  });

  it('folds thinking, tools, todo, and intermediate assistant text before the final answer', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'user', role: 'user', content: 'start', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: 'checking',
          durationMs: 1200,
          isRedacted: false,
          finishedAt: '2026-01-01T00:00:03.200Z',
        },
        createdAt: '2026-01-01T00:00:03.200Z',
      }),
      toolUse('read-1', 'Read', { file_path: '/repo/a.ts' }, 4),
      message({ id: 'mid', role: 'assistant', content: 'I found the file.', createdAt: at(5) }),
      toolUse('todo-1', 'TodoWrite', {
        todos: [{ content: 'Implement', status: 'completed' }],
      }, 6),
      message({ id: 'final', role: 'assistant', content: 'Final answer', createdAt: at(8) }),
    ]);

    // todo 卡在桌面共享实现里是 work_group 的边界(不计入 children),折叠组到 todo 处收口,
    // todo 作为顶层项紧随其后。work_group 时长由专门的「counts restored thinking duration」用例覆盖。
    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'todo', 'message']);
    const group = expectType(items[1], 'work_group');
    expect(group.key).toBe('work-summary-thinking');
    expect(group.children.map((child) => child.type)).toEqual([
      'work_group',
      'message',
    ]);
    const actions = expectType(group.children[0], 'work_group');
    expect(actions.key).toBe('work-thinking');
    expect(actions.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    const todo = expectType(items[2], 'todo');
    expect(todo.todos).toEqual([{ content: 'Implement', status: 'completed', activeForm: undefined }]);
  });

  it('counts restored thinking duration in completed work groups', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'user', role: 'user', content: 'start', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking', durationMs: 15_000, isRedacted: false },
        createdAt: at(17),
      }),
      message({ id: 'final', role: 'assistant', content: 'Final answer', createdAt: at(25) }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    const group = expectType(items[1], 'work_group');
    expect(group.durationMs).toBe(23_000);
  });

  it('keeps unfinished trailing work visible when no final assistant answer exists yet', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'user', role: 'user', content: 'start', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking', durationMs: 0, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test' }, 3),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group']);
    const group = expectType(items[1], 'work_group');
    expect(group.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    expect(group.isStreaming).toBe(false);
  });

  it('keeps active streaming turn work visible until the turn ends', () => {
    const messages = [
      message({ id: 'user', role: 'user', content: 'start', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking', durationMs: 0, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test' }, 3),
      message({
        id: 'answer',
        role: 'assistant',
        content: 'partial answer',
        agentMeta: { isStreaming: true },
        createdAt: at(4),
      }),
    ];

    const streamingItems = buildMobileMessageRenderItems(messages, { isSessionStreaming: true });
    expect(streamingItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    const activeGroup = expectType(streamingItems[1], 'work_group');
    expect(activeGroup.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    expect(activeGroup.isStreaming).toBe(false);

    const completedItems = buildMobileMessageRenderItems(
      messages.map((item) => item.id === 'answer'
        ? { ...item, agentMeta: { isStreaming: false } }
        : item),
      { isSessionStreaming: false },
    );
    expect(completedItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
  });

  it('keeps active remote turn visible when only session running state is known', () => {
    const messages = [
      message({ id: 'user', role: 'user', content: 'start', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: { kind: 'thinking', text: 'checking', durationMs: 0, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test' }, 3),
      message({
        id: 'answer',
        role: 'assistant',
        content: 'partial answer without message streaming metadata',
        createdAt: at(4),
      }),
    ];

    const runningItems = buildMobileMessageRenderItems(messages, { isSessionStreaming: true });
    expect(runningItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    expect(expectType(runningItems[1], 'work_group').isStreaming).toBe(false);

    const idleItems = buildMobileMessageRenderItems(messages, { isSessionStreaming: false });
    expect(idleItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
  });

  it('keeps answered ask_user, plan_review, and system messages as visible stream messages', () => {
    const systemRole = 'system' as RemoteMessageRole;
    const items = buildMobileMessageRenderItems([
      message({
        id: 'ask',
        role: 'ask_user',
        content: {
          status: 'answered',
          questions: [{ question: 'Deploy?' }],
          answers: { 'Deploy?': 'yes' },
        },
        createdAt: at(1),
      }),
      message({
        id: 'plan',
        role: 'plan_review',
        content: { status: 'approved', plan: '1. Do it' },
        createdAt: at(2),
      }),
      message({
        id: 'system',
        role: systemRole,
        content: 'Session restored',
        createdAt: at(3),
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'message', 'message']);
    expect(items.map((item) => expectType(item, 'message').message.kind)).toEqual([
      'ask_user',
      'plan_review',
      'system',
    ]);
  });

  it('renders a Task tool-call as an agent_task card linked to its live update by toolUseId', () => {
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['task-tool', {
        provider: 'claude-code',
        taskId: 'sub-1',
        parentToolUseId: 'task-tool',
        status: 'completed',
        summary: 'Audited 3 files',
        usage: { totalTokens: 800, toolUses: 4 },
      }],
    ]);

    const items = buildMobileMessageRenderItems(
      [
        toolUse('task-tool', 'Task', { description: 'Audit parity', prompt: 'go' }, 1),
        message({ id: 'answer', role: 'assistant', content: 'done', createdAt: at(10) }),
      ],
      {},
      taskUpdates,
    );

    expect(items.map((item) => item.type)).toEqual(['work_group', 'message']);
    const group = expectType(items[0], 'work_group');
    const task = expectType(group.children[0], 'agent_task');
    expect(task.toolCall?.label).toBe('Task');
    expect(task.update?.status).toBe('completed');
    expect(task.update?.summary).toBe('Audited 3 files');
  });

  // 回归:断开重连后 agent_task_update(live-only)为空,但已完成子任务的工具结果已持久化进
  // secondaryBody。整条链路(归一化 → render item → 卡片 model)必须仍判为 completed 且显示结果,
  // 而不是退回「运行中」。守住 MessageRenderer.AgentTaskCard 把 result 喂给 buildAgentTaskCardModel
  // 这条 P1 修复(此前漏传导致重连显示运行中、无摘要)。
  it('reconstructs a completed sub-agent task from the persisted tool result on reconnect (no live update)', () => {
    const items = buildMobileMessageRenderItems(
      [
        toolUse('task-reconnect', 'Task', { description: 'Audit parity', prompt: 'go' }, 1),
        message({
          id: 'task-result',
          role: 'tool_result',
          toolUseId: 'task-reconnect',
          content: 'Audited 3 files, all good',
          createdAt: at(2),
        }),
      ],
      {},
      undefined, // 重连:无 live taskUpdates
    );

    expect(items.map((item) => item.type)).toEqual(['work_group']);
    const task = expectType(expectType(items[0], 'work_group').children[0], 'agent_task');
    expect(task.update).toBeUndefined();
    // render item 必须携带持久化结果,卡片才有完成信号可用。
    expect(task.toolCall?.secondaryBody).toBe('Audited 3 files, all good');

    // 复刻 MessageRenderer.AgentTaskCard 的 model 构建调用(含 result),锁住 P1 修复。
    const content = task.toolCall?.source.content;
    const toolInput = content && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, unknown>).input
      : undefined;
    const model = buildAgentTaskCardModel({
      toolName: task.toolCall?.label,
      toolInput,
      update: task.update,
      result: task.toolCall?.secondaryBody,
    });
    expect(model.status).toBe('completed');
    expect(model.summary).toBe('Audited 3 files, all good');
    expect(model.title).toBe('Audit parity');
  });

  it('formats work durations with the desktop convention', () => {
    expect(formatDuration(400)).toBe('1s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
  });

  it('inserts the fork origin marker at the fork creation boundary', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'u1', role: 'user', content: 'parent context', createdAt: at(1) }),
      message({ id: 'a1', role: 'assistant', content: 'copied answer', createdAt: at(2) }),
      message({ id: 'u2', role: 'user', content: 'fork branch starts', createdAt: at(8) }),
    ]);

    expect(insertMobileForkOriginItem(items, {
      parentSessionId: 'parent',
      forkedAtMessageId: 'u1',
      forkedSessionCreatedAt: at(5),
    }).map((item) => item.key)).toEqual([
      'message-u1',
      'message-a1',
      'fork-origin-parent-u1',
      'message-u2',
    ]);

    const tailOnly = items.slice(2);
    expect(insertMobileForkOriginItem(tailOnly, {
      parentSessionId: 'parent',
      forkedAtMessageId: 'u1',
      forkedSessionCreatedAt: at(5),
    })).toBe(tailOnly);
  });

  // 操作行只挂每轮收尾正文(对齐桌面 #456):标注逻辑见 markTurnFinalAssistants。
  describe('turn-final assistant marking', () => {
    function turnFinalKeys(items: readonly MobileMessageRenderItem[]): string[] {
      const keys: string[] = [];
      const visit = (item: MobileMessageRenderItem) => {
        if (item.type === 'message' && item.message.isTurnFinalAssistant === true) {
          keys.push(item.message.key);
        }
        if (item.type === 'work_group') item.children.forEach(visit);
        if (item.type === 'subagent_group') item.childItems.forEach(visit);
      };
      items.forEach(visit);
      return keys;
    }

    it('marks only the last non-empty assistant body of each turn', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q1' }, createdAt: at(1) }),
        message({ id: 'a1-mid', role: 'assistant', content: '先看看代码', createdAt: at(2) }),
        toolUse('read-1', 'Read', { file_path: '/repo/a.ts' }, 3),
        message({ id: 'a1-final', role: 'assistant', content: '第一轮结论', createdAt: at(4) }),
        message({ id: 'u2', role: 'user', content: { text: 'q2' }, createdAt: at(5) }),
        message({ id: 'a2-final', role: 'assistant', content: '第二轮结论', createdAt: at(6) }),
      ]);

      expect(turnFinalKeys(items)).toEqual(['a1-final', 'a2-final']);
    });

    it('marks every sealed SDK turn when a background task auto-continues the user request', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        toolUse('main-work', 'Read', { file_path: '/repo/a.ts' }, 2),
        message({
          id: 'main-summary',
          role: 'assistant',
          content: '正式总结',
          agentMeta: { turnCompleted: true },
          createdAt: at(3),
        }),
        toolUse('gate', 'Bash', { command: 'check gate' }, 4),
        message({
          id: 'gate-followup',
          role: 'assistant',
          content: '后台门禁已通过',
          agentMeta: { turnCompleted: true },
          createdAt: at(5),
        }),
      ]);

      expect(turnFinalKeys(items)).toEqual(['main-summary', 'gate-followup']);
      expect(items.map((item) => item.type)).toEqual([
        'message',
        'work_group',
        'message',
        'work_group',
        'message',
      ]);
    });

    it('does not mark the tail turn when the loaded tail is actively streaming', () => {
      const messages = [
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({
          id: 'a1',
          role: 'assistant',
          content: '执行中的中间句',
          agentMeta: { isStreaming: true },
          createdAt: at(2),
        }),
      ];

      expect(turnFinalKeys(buildMobileMessageRenderItems(messages, { isSessionStreaming: true }))).toEqual([]);
      expect(turnFinalKeys(buildMobileMessageRenderItems(messages, { isSessionStreaming: false }))).toEqual(['a1']);
    });

    it('keeps completed tail actions visible while the next send starts before new user row loads', () => {
      const messages = [
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({ id: 'a1', role: 'assistant', content: '上一轮已完成回答', createdAt: at(2) }),
      ];

      expect(turnFinalKeys(buildMobileMessageRenderItems(messages, { isSessionStreaming: true }))).toEqual(['a1']);
    });

    it('keeps completed tail actions visible when a local system card trails the answer (PR #495 review)', () => {
      // 已完成回答后追加本地 system card(/pwd、/context、compact 等):tail 末尾是
      // kind:'system',不得被当成 active turn 而抑制上一条回答的操作行。
      const messages = [
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({ id: 'a1', role: 'assistant', content: '上一轮已完成回答', createdAt: at(2) }),
        message({ id: 'card-pwd', role: 'system', content: '', systemCardType: 'pwd', createdAt: at(3) }),
      ];

      expect(turnFinalKeys(buildMobileMessageRenderItems(messages, { isSessionStreaming: true }))).toEqual(['a1']);
    });

    it('keeps answered tail actions visible when a stale tool appears before the final assistant', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        toolUse('stale-tail-tool', 'Bash', { command: 'sleep 999' }, 2),
        message({ id: 'a1', role: 'assistant', content: '上一轮已完成回答', createdAt: at(3) }),
      ], { isSessionStreaming: true });

      expect(turnFinalKeys(items)).toEqual(['a1']);
      const tools = expectType(expectType(items[1], 'work_group').children[0], 'tool_group');
      expect(tools.tools[0].toolSettled).toBe(true);
    });

    it('scopes unsettled tools to the active tail so historical turns never spin (PR #495 review)', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q1' }, createdAt: at(1) }),
        // 历史 turn 被中断:tool_result 永久缺失。
        toolUse('stale-tool', 'Bash', { command: 'sleep 999' }, 2),
        message({ id: 'a1', role: 'assistant', content: '第一轮结论', createdAt: at(3) }),
        message({ id: 'u2', role: 'user', content: { text: 'q2' }, createdAt: at(4) }),
        // active tail 的 pending 工具:允许 running。
        toolUse('live-tool', 'Bash', { command: 'pnpm test' }, 5),
      ], { isSessionStreaming: true });

      const tools = new Map<string, boolean | undefined>();
      const visit = (item: MobileMessageRenderItem) => {
        if (item.type === 'tool_group') {
          for (const tool of item.tools) tools.set(tool.key, tool.toolSettled);
        }
        if (item.type === 'work_group') item.children.forEach(visit);
      };
      items.forEach(visit);

      // 历史 turn 缺 result 的工具被收敛为已完成,后续流式不再转圈。
      expect(tools.get('stale-tool')).toBe(true);
      // 尾部 turn 的 pending 工具保留未完成信号(流式中显示 running)。
      expect(tools.get('live-tool')).toBe(false);
    });

    it('ignores orca worker reports as turn boundaries and skips subagent children', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({ id: 'a1', role: 'assistant', content: '汇报前的句子', createdAt: at(2) }),
        // orca worker 回报(kind=user 但 label=orca:report):不是真实用户消息,不切 turn。
        message({
          id: 'report',
          role: 'user',
          content: JSON.stringify({ orcaSource: 'worker', content: 'worker done' }),
          createdAt: at(3),
        }),
        message({ id: 'a2', role: 'assistant', content: '真正的收尾', createdAt: at(4) }),
      ]);

      expect(turnFinalKeys(items)).toEqual(['a2']);

      const subagentItems = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({ id: 'outer-mid', role: 'assistant', content: '主线过程输出', createdAt: at(2) }),
        message({
          id: 'agent-1',
          role: 'tool_use',
          toolUseId: 'agent-1',
          content: { toolUseId: 'agent-1', toolName: 'Agent', input: { description: '子任务' } },
          createdAt: at(3),
        }),
        // 子 agent 内层 user(parentUuid 指向 Agent 调用):不是顶层 turn 边界,不能把 outer-mid 标 final。
        message({
          id: 'inner-u',
          role: 'user',
          content: { text: '子任务输入' },
          agentMeta: { parentUuid: 'agent-1' },
          createdAt: at(4),
        }),
        // 子 agent 内层正文(parentUuid 指向 Agent 调用):过程内容,不标收尾。
        message({
          id: 'inner-a',
          role: 'assistant',
          content: '子 agent 内层输出',
          agentMeta: { parentUuid: 'agent-1' },
          createdAt: at(5),
        }),
        message({ id: 'outer-a', role: 'assistant', content: '主线收尾', createdAt: at(6) }),
      ]);

      expect(turnFinalKeys(subagentItems)).toEqual(['outer-a']);
    });

    it('keeps streaming subagent children from closing the outer active tail', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'u1', role: 'user', content: { text: 'q' }, createdAt: at(1) }),
        message({ id: 'outer-mid', role: 'assistant', content: '主线过程输出', createdAt: at(2) }),
        message({
          id: 'agent-1',
          role: 'tool_use',
          toolUseId: 'agent-1',
          content: { toolUseId: 'agent-1', toolName: 'Agent', input: { description: '子任务' } },
          createdAt: at(3),
        }),
        message({
          id: 'inner-u',
          role: 'user',
          content: { text: '子任务输入' },
          agentMeta: { parentUuid: 'agent-1' },
          createdAt: at(4),
        }),
        message({
          id: 'inner-a',
          role: 'assistant',
          content: '子 agent 内层输出',
          agentMeta: { parentUuid: 'agent-1' },
          createdAt: at(5),
        }),
      ], { isSessionStreaming: true });

      expect(turnFinalKeys(items)).toEqual([]);
      const subagent = expectType(items[2], 'subagent_group');
      expect(subagent.status).toBe('running');
    });

    it('treats a userless loaded window with active work as the active tail', () => {
      const items = buildMobileMessageRenderItems([
        message({ id: 'mid', role: 'assistant', content: '加载窗口里的过程句', createdAt: at(2) }),
        toolUse('live-tool', 'Bash', { command: 'pnpm test' }, 3),
        message({ id: 'inner-progress', role: 'assistant', content: '还在继续', createdAt: at(4) }),
      ], { isSessionStreaming: true });

      expect(turnFinalKeys(items)).toEqual([]);
      const tools = expectType(expectType(items[1], 'work_group').children[0], 'tool_group');
      expect(tools.tools[0].toolSettled).toBe(false);
    });
  });

  describe('合成续跑行(隐藏 UI 指令)', () => {
    it('drops synthetic trigger rows from render items while keeping them as turn boundaries', () => {
      // 场景:上一轮失败(工具永久缺 tool_result),桌面「继续」发出隐藏续跑 prompt,
      // 新一轮工作进行中。要求:(a) 续跑行不渲染;(b) 它仍是 turn 边界——上一轮的
      // 未完成工具收敛为 done,只有续跑之后的新工具算 active tail 转圈。
      const items = buildMobileMessageRenderItems([
        message({ id: 'ask', role: 'user', content: { text: '帮我跑一下任务' }, createdAt: at(1) }),
        toolUse('stale-tool', 'Bash', { command: 'pnpm build' }, 2),
        message({
          id: 'synthetic-continue',
          role: 'user',
          content: { text: CONTINUE_AFTER_ERROR_PROMPT, images: [], files: [] },
          createdAt: at(3),
        }),
        toolUse('live-tool', 'Bash', { command: 'pnpm build --retry' }, 4),
      ], { isSessionStreaming: true });

      // 续跑行被剔除:render items 里没有任何 message item 带隐藏 prompt 文本
      const messageBodies = items
        .filter((item): item is Extract<MobileMessageRenderItem, { type: 'message' }> => item.type === 'message')
        .map((item) => item.message.body);
      expect(messageBodies).toEqual(['帮我跑一下任务']);
      expect(JSON.stringify(items)).not.toContain('[UI_ACTION_TRIGGER]');

      // turn 边界仍生效:续跑前的旧工具收敛 done,续跑后的新工具保持 running
      const staleGroup = expectType(expectType(items[1], 'work_group').children[0], 'tool_group');
      expect(staleGroup.tools[0].toolSettled).toBe(true);
      const liveGroup = expectType(expectType(items[2], 'work_group').children[0], 'tool_group');
      expect(liveGroup.tools[0].toolSettled).toBe(false);
    });
  });
});

function expectType<TType extends MobileMessageRenderItem['type']>(
  item: MobileMessageRenderItem,
  type: TType,
): Extract<MobileMessageRenderItem, { type: TType }> {
  expect(item.type).toBe(type);
  return item as Extract<MobileMessageRenderItem, { type: TType }>;
}

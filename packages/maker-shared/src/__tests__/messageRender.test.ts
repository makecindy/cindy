import { describe, expect, it } from 'vitest';
import {
  buildMessageRenderItems,
  dedupeToolMediaByUrl,
  extractPlanTodos,
  extractTodosFromSourceMessage,
  findLatestMessageTodoInsertion,
  findMessageTodoInsertions,
  formatDuration,
  getLatestMessageTodoState,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
  type MessageRenderSourceMessageLike,
} from '../messageRender.js';
import type { AgentTaskUpdate } from '../agentTask.js';

type FixtureSource = MessageRenderSourceMessageLike & {
  id: string;
  clientId: string;
  content: unknown;
  createdAt: string;
};

type FixtureMessage = MessageRenderNormalizedMessage<FixtureSource>;

function source(
  id: string,
  content: unknown,
  seconds: number,
): FixtureSource {
  return {
    id,
    clientId: id,
    content,
    createdAt: at(seconds),
  };
}

function message(
  patch: Partial<FixtureMessage> & Pick<FixtureMessage, 'kind' | 'source'>,
): FixtureMessage {
  return {
    key: patch.source.clientId,
    label: patch.kind,
    body: '',
    createdAt: patch.source.createdAt,
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

describe('message render shared model', () => {
  it('groups consecutive normalized tools before the final answer', () => {
    const items = buildMessageRenderItems([
      message({
        kind: 'tool',
        source: source('read-1', { toolName: 'Read', input: { file_path: '/repo/a.ts' } }, 1),
        label: 'Read',
        body: 'Read(/repo/a.ts)',
      }),
      message({
        kind: 'tool',
        source: source('grep-1', { toolName: 'Grep', input: { pattern: 'TODO' } }, 2),
        label: 'Grep',
        body: 'Grep(TODO)',
      }),
      message({
        kind: 'assistant',
        source: source('answer', 'done', 10),
        label: 'assistant',
        body: 'done',
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['work_group', 'message']);
    const group = expectType(items[0], 'work_group');
    expect(group.children).toHaveLength(1);
    const tools = expectType(group.children[0], 'tool_group');
    expect(tools.key).toBe('tools-read-1');
    expect(tools.tools.map((tool) => [tool.label, tool.body])).toEqual([
      ['Read', 'Read(/repo/a.ts)'],
      ['Grep', 'Grep(TODO)'],
    ]);
  });

  it('extracts TodoWrite updates into one stable todo card', () => {
    const todo1 = source('todo-1', {
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: 'Inspect desktop flow', status: 'in_progress' },
          { content: 'Patch mobile UI', status: 'pending' },
        ],
      },
    }, 1);
    const todo2 = source('todo-2', {
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: 'Inspect desktop flow', status: 'completed' },
          { content: 'Patch mobile UI', status: 'in_progress' },
        ],
      },
    }, 2);

    expect(extractTodosFromSourceMessage(todo1)).toEqual([
      { content: 'Inspect desktop flow', status: 'in_progress', activeForm: undefined },
      { content: 'Patch mobile UI', status: 'pending', activeForm: undefined },
    ]);

    const items = buildMessageRenderItems([
      message({ kind: 'tool', source: todo1, label: 'TodoWrite', body: 'TodoWrite()' }),
      message({ kind: 'tool', source: todo2, label: 'TodoWrite', body: 'TodoWrite()' }),
      message({ kind: 'assistant', source: source('answer', 'patched', 5), body: 'patched', label: 'assistant' }),
    ]);

    // 采用桌面共享实现后,plan 工具(TodoWrite)合并出的 todo 卡作为顶层独立项渲染,不再被折叠进
    // work_group(与桌面 MessageStream 的「todo 卡常驻可见」语义一致;移动端 MessageRenderer 的 switch
    // 同时处理顶层 'todo' 与 'work_group',渲染结果等价)。
    expect(items.map((item) => item.type)).toEqual(['todo', 'message']);
    const todo = expectType(items[0], 'todo');
    expect(todo.key).toBe('todo-todo-1');
    expect(todo.todos).toEqual([
      { content: 'Inspect desktop flow', status: 'completed', activeForm: undefined },
      { content: 'Patch mobile UI', status: 'in_progress', activeForm: undefined },
    ]);
  });

  it('folds thinking, tools, todo, and intermediate assistant text before the final answer', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('thinking', { text: 'checking', durationMs: 1200, isRedacted: false }, 2),
        body: 'checking',
        label: 'thinking',
      }),
      message({
        kind: 'tool',
        source: source('read-1', { toolName: 'Read', input: { file_path: '/repo/a.ts' } }, 3),
        label: 'Read',
        body: 'Read(/repo/a.ts)',
      }),
      message({
        kind: 'assistant',
        source: source('mid', 'I found the file.', 4),
        body: 'I found the file.',
        label: 'assistant',
      }),
      message({
        kind: 'tool',
        source: source('todo-1', {
          toolName: 'TodoWrite',
          input: { todos: [{ content: 'Implement', status: 'completed' }] },
        }, 5),
        label: 'TodoWrite',
        body: 'TodoWrite()',
      }),
      message({
        kind: 'assistant',
        source: source('final', 'Final answer', 8),
        body: 'Final answer',
        label: 'assistant',
      }),
    ]);

    // todo 卡在桌面共享实现里是 work_group 的边界(不计入 children),折叠组到 todo 处收口,
    // todo 作为顶层项紧随其后。
    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'todo', 'message']);
    const group = expectType(items[1], 'work_group');
    expect(group.key).toBe('work-summary-thinking');
    expect(group.durationMs).toBe(3000);
    expect(group.children.map((child) => child.type)).toEqual([
      'work_group',
      'message',
    ]);
    const activityGroup = expectType(group.children[0], 'work_group');
    expect(activityGroup.key).toBe('work-thinking');
    expect(activityGroup.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    const todo = expectType(items[2], 'todo');
    expect(todo.todos).toEqual([{ content: 'Implement', status: 'completed', activeForm: undefined }]);
  });

  it('keeps every sealed SDK-turn summary visible across a background auto-continuation', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('main-thinking', { text: 'working', durationMs: 1000 }, 2),
        body: 'working',
        label: 'thinking',
      }),
      message({
        kind: 'assistant',
        source: source('main-summary', 'formal summary', 4),
        body: 'formal summary',
        label: 'assistant',
        turnCompleted: true,
      }),
      message({
        kind: 'tool',
        source: source('gate', { toolName: 'Bash', input: { command: 'check gate' } }, 5),
        label: 'Bash',
        body: 'Bash(check gate)',
      }),
      message({
        kind: 'assistant',
        source: source('gate-followup', 'gate passed', 8),
        body: 'gate passed',
        label: 'assistant',
        turnCompleted: true,
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'message',
      'work_group',
      'message',
    ]);
    expect(expectType(items[2], 'message').message.key).toBe('main-summary');
    expect(expectType(items[4], 'message').message.key).toBe('gate-followup');
  });

  it('keeps consecutive final-answer blocks before a sealed SDK turn outside the work fold', () => {
    const items = buildMessageRenderItems([
      message({
        kind: 'tool',
        source: source('work', { toolName: 'Read', input: {} }, 1),
        body: 'Read()',
        label: 'Read',
      }),
      message({
        kind: 'assistant',
        source: source('summary-1', 'part 1', 2),
        body: 'part 1',
        label: 'assistant',
      }),
      message({
        kind: 'assistant',
        source: source('summary-2', 'part 2', 3),
        body: 'part 2',
        label: 'assistant',
        turnCompleted: true,
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['work_group', 'message', 'message']);
  });

  // 交付正文与位置无关地留在折叠组外。原始形状(2026-07-31 定时巡检):agent 先输出
  // 长篇简报,再调 notify 发通知,最后说一句「已触发通知」——SDK seal 只盖最后那句,
  // 「最终答复」回溯又遇工具即停,简报会被整段折进「工作过程」。
  it('keeps delivery prose outside the work fold even before a trailing side-effect tool', () => {
    const brief = `本轮 7 条有活动。${'逐条核对了改动落在哪些产品面。'.repeat(50)}`;
    expect(brief.length).toBeGreaterThanOrEqual(600);

    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'brief me', 1), body: 'brief me', label: 'user' }),
      message({
        kind: 'tool',
        source: source('diff', { toolName: 'Bash', input: { command: 'gh pr diff' } }, 2),
        body: 'Bash(gh pr diff)',
        label: 'Bash',
      }),
      message({ kind: 'assistant', source: source('brief', brief, 3), body: brief, label: 'assistant' }),
      message({
        kind: 'tool',
        source: source('notify', { toolName: 'schedule_notify_current_run', input: {} }, 4),
        body: 'schedule_notify_current_run()',
        label: 'schedule_notify_current_run',
      }),
      message({
        kind: 'assistant',
        source: source('wrap', 'notified', 5),
        body: '本轮有 3 条需要你决策,已触发通知。',
        label: 'assistant',
        turnCompleted: true,
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'message',
      'work_group',
      'message',
    ]);
    expect(expectType(items[2], 'message').message.key).toBe('brief');
    expect(expectType(items[4], 'message').message.key).toBe('wrap');
  });

  it('still folds short progress narration that precedes a trailing side-effect tool', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'brief me', 1), body: 'brief me', label: 'user' }),
      message({
        kind: 'tool',
        source: source('diff', { toolName: 'Bash', input: { command: 'gh pr diff' } }, 2),
        body: 'Bash(gh pr diff)',
        label: 'Bash',
      }),
      message({
        kind: 'assistant',
        source: source('narration', 'reading', 3),
        body: '读完了,现在写简报。',
        label: 'assistant',
      }),
      message({
        kind: 'tool',
        source: source('notify', { toolName: 'schedule_notify_current_run', input: {} }, 4),
        body: 'schedule_notify_current_run()',
        label: 'schedule_notify_current_run',
      }),
      message({
        kind: 'assistant',
        source: source('wrap', 'notified', 5),
        body: '本轮有 3 条需要你决策,已触发通知。',
        label: 'assistant',
        turnCompleted: true,
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    expect(expectType(items[2], 'message').message.key).toBe('wrap');
  });

  it('surfaces tool result media as a standalone tool_media item that stays outside the work fold', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'draw it', 1), body: 'draw it', label: 'user' }),
      message({
        kind: 'tool',
        source: source('gen-1', { toolName: 'image_generate', input: { prompt: 'cat' } }, 2),
        label: 'image_generate',
        body: 'image_generate(cat)',
        media: [{ kind: 'image', url: 'xdt-image://lizi-art-media-images/a.png' }],
      }),
      message({
        kind: 'tool',
        source: source('gen-2', { toolName: 'image_edit', input: {} }, 3),
        label: 'image_edit',
        body: 'image_edit()',
        media: [
          // 与 gen-1 同 url:发射判定与渲染端 dedupeToolMediaByUrl 同口径去重。
          { kind: 'image', url: 'xdt-image://lizi-art-media-images/a.png' },
          { kind: 'video', url: 'xdt-video://lizi-art-media-videos/v.mp4' },
        ],
      }),
      message({
        kind: 'assistant',
        source: source('final', 'done', 8),
        body: 'done',
        label: 'assistant',
      }),
    ]);

    // 媒体项紧跟所属 tool_group;turn 收口折叠后 tool_group 进 work_group,
    // tool_media 留在折叠块外可见(对齐桌面「产物不折叠」语义)。
    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'tool_media', 'message']);
    const media = expectType(items[2], 'tool_media');
    // key 派生自组首 tool 的 clientId(与 tool_group 同源、prefix 不同)。
    expect(media.key).toBe('media-gen-1');
    expect(media.tools.map((tool) => tool.source.clientId)).toEqual(['gen-1', 'gen-2']);
  });

  it('does not emit tool_media when tools carry no media or only empty urls', () => {
    const items = buildMessageRenderItems([
      message({
        kind: 'tool',
        source: source('read-1', { toolName: 'Read', input: { file_path: '/repo/a.ts' } }, 1),
        label: 'Read',
        body: 'Read(/repo/a.ts)',
        media: [],
      }),
      message({
        kind: 'tool',
        source: source('gen-1', { toolName: 'image_generate', input: {} }, 2),
        label: 'image_generate',
        body: 'image_generate()',
        media: [{ kind: 'image', url: '' }],
      }),
      message({
        kind: 'assistant',
        source: source('final', 'done', 5),
        body: 'done',
        label: 'assistant',
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['work_group', 'message']);
  });

  it('dedupes tool media by url preserving order and dropping empty urls', () => {
    expect(dedupeToolMediaByUrl([
      { kind: 'image', url: 'xdt-image://a.png', title: 'first' },
      { kind: 'image', url: '' },
      { kind: 'image', url: 'xdt-image://a.png', title: 'dup' },
      { kind: 'video', url: 'xdt-video://v.mp4' },
    ])).toEqual([
      { kind: 'image', url: 'xdt-image://a.png', title: 'first' },
      { kind: 'video', url: 'xdt-video://v.mp4' },
    ]);
  });

  it('keeps unfinished trailing work visible before the final answer exists', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('thinking', { text: 'checking', durationMs: 0, isRedacted: false }, 2),
        body: 'checking',
        label: 'thinking',
      }),
      message({
        kind: 'tool',
        source: source('bash-1', { toolName: 'Bash', input: { command: 'pnpm test' } }, 3),
        label: 'Bash',
        body: 'Bash(pnpm test)',
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group']);
    const group = expectType(items[1], 'work_group');
    expect(group.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    expect(group.isStreaming).toBe(false);
  });

  it('keeps active streaming turn work visible until the turn ends', () => {
    const messages = [
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('thinking', { text: 'checking', durationMs: 0, isRedacted: false }, 2),
        body: 'checking',
        label: 'thinking',
      }),
      message({
        kind: 'tool',
        source: source('bash-1', { toolName: 'Bash', input: { command: 'pnpm test' } }, 3),
        label: 'Bash',
        body: 'Bash(pnpm test)',
      }),
      message({
        kind: 'assistant',
        source: source('answer', 'partial answer', 4),
        body: 'partial answer',
        label: 'assistant',
        isStreaming: true,
      }),
    ];

    const streamingItems = buildMessageRenderItems(messages, { isSessionStreaming: true });
    expect(streamingItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    const activeGroup = expectType(streamingItems[1], 'work_group');
    expect(activeGroup.children.map((child) => child.type)).toEqual(['thinking', 'tool_group']);
    // Assistant progress text closes the preceding activity segment, while the text itself stays visible.
    expect(activeGroup.isStreaming).toBe(false);

    const completedItems = buildMessageRenderItems(
      messages.map((item) => item.kind === 'assistant' ? { ...item, isStreaming: false } : item),
      { isSessionStreaming: false },
    );
    expect(completedItems.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
  });

  it('renders a Task tool-call as an agent_task card linked to its live update by toolUseId', () => {
    const toolCall = source('task-tool', { toolName: 'Task', input: { description: 'Audit mobile parity', prompt: 'go' } }, 1);
    toolCall.toolUseId = 'tu-1';
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-1', {
        provider: 'claude-code',
        taskId: 'task-xyz',
        parentToolUseId: 'tu-1',
        status: 'completed',
        summary: 'Done auditing',
        usage: { totalTokens: 1200, toolUses: 3 },
      }],
    ]);

    const items = buildMessageRenderItems(
      [message({ kind: 'tool', source: toolCall, label: 'Task', body: 'Task(...)' })],
      {},
      taskUpdates,
    );

    // Exactly one card inside the completed work group (no duplicate from the orphan sweep).
    expect(items.map((item) => item.type)).toEqual(['work_group']);
    const task = expectType(expectType(items[0], 'work_group').children[0], 'agent_task');
    expect(task.toolCall?.source.id).toBe('task-tool');
    expect(task.update?.status).toBe('completed');
    expect(task.update?.summary).toBe('Done auditing');
  });

  it('renders an orphan agent_task update only while the session is streaming', () => {
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['orphan-task', {
        provider: 'codex',
        taskId: 'orphan-task',
        status: 'running',
        title: 'Background collab agent',
      }],
    ]);

    const items = buildMessageRenderItems([], { isSessionStreaming: true }, taskUpdates);

    expect(items.map((item) => item.type)).toEqual(['agent_task']);
    const task = expectType(items[0], 'agent_task');
    expect(task.toolCall).toBeUndefined();
    expect(task.update?.title).toBe('Background collab agent');
  });

  it('suppresses orphan agent_task updates when the session is idle (stale leftovers)', () => {
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['orphan-task', {
        provider: 'codex',
        taskId: 'orphan-task',
        status: 'running',
        title: 'Background collab agent',
      }],
    ]);

    // Idle session: an unmatched update means its tool-call slid out of the message
    // window (or belongs to a finished turn) — replaying it would resurface old cards.
    expect(buildMessageRenderItems([], {}, taskUpdates)).toEqual([]);
    expect(buildMessageRenderItems([], { isSessionStreaming: false }, taskUpdates)).toEqual([]);
  });

  it('gates the orphan sweep on renderOrphanTaskUpdates when it is narrower than isSessionStreaming', () => {
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['orphan-task', {
        provider: 'codex',
        taskId: 'orphan-task',
        status: 'running',
        title: 'Background collab agent',
      }],
    ]);

    // Mobile sets isSessionStreaming during local sending, before the remote turn starts —
    // the narrow remote-turn signal must win, or stale leftovers flash in the send→status gap.
    expect(buildMessageRenderItems(
      [],
      { isSessionStreaming: true, renderOrphanTaskUpdates: false },
      taskUpdates,
    )).toEqual([]);
    expect(buildMessageRenderItems(
      [],
      { isSessionStreaming: false, renderOrphanTaskUpdates: true },
      taskUpdates,
    ).map((item) => item.type)).toEqual(['agent_task']);
  });

  it('still links a live update to its inline Task card when the session is idle', () => {
    const toolCall = source('task-tool-idle', { toolName: 'Task', input: { description: 'Audit', prompt: 'go' } }, 1);
    toolCall.toolUseId = 'tu-idle';
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-idle', {
        provider: 'claude-code',
        taskId: 'task-idle',
        parentToolUseId: 'tu-idle',
        status: 'completed',
        usage: { totalTokens: 500 },
      }],
    ]);

    const items = buildMessageRenderItems(
      [message({ kind: 'tool', source: toolCall, label: 'Task', body: 'Task(...)' })],
      { isSessionStreaming: false },
      taskUpdates,
    );

    expect(items.map((item) => item.type)).toEqual(['work_group']);
    const task = expectType(expectType(items[0], 'work_group').children[0], 'agent_task');
    expect(task.update?.usage?.totalTokens).toBe(500);
  });

  it('keeps progress text visible between folded action segments, then nests those segments at completion', () => {
    const messages = [
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('thinking-1', { text: 'first thought' }, 2),
        body: 'first thought',
        label: 'thinking',
      }),
      message({
        kind: 'tool',
        source: source('read-1', { toolName: 'Read', input: { file_path: '/repo/a.ts' } }, 3),
        body: 'Read(/repo/a.ts)',
        label: 'Read',
      }),
      message({ kind: 'assistant', source: source('progress-1', 'Found A.', 4), body: 'Found A.', label: 'assistant' }),
      message({
        kind: 'tool',
        source: source('grep-1', { toolName: 'Grep', input: { pattern: 'TODO' } }, 5),
        body: 'Grep(TODO)',
        label: 'Grep',
      }),
      message({ kind: 'assistant', source: source('progress-2', 'Checking tests.', 6), body: 'Checking tests.', label: 'assistant' }),
      message({
        kind: 'tool',
        source: source('bash-1', { toolName: 'Bash', input: { command: 'pnpm test' } }, 7),
        body: 'Bash(pnpm test)',
        label: 'Bash',
      }),
    ];

    const active = buildMessageRenderItems(messages, { isSessionStreaming: true });
    expect(active.map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'message',
      'work_group',
      'message',
      'work_group',
    ]);
    expect(expectType(active[1], 'work_group').isStreaming).toBe(false);
    expect(expectType(active[3], 'work_group').isStreaming).toBe(false);
    expect(expectType(active[5], 'work_group').isStreaming).toBe(true);

    const completed = buildMessageRenderItems([
      ...messages,
      message({ kind: 'assistant', source: source('final', 'Done.', 9), body: 'Done.', label: 'assistant' }),
    ]);
    expect(completed.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    const summary = expectType(completed[1], 'work_group');
    expect(summary.key).toBe('work-summary-thinking-1');
    expect(summary.children.map((child) => child.type)).toEqual([
      'work_group',
      'message',
      'work_group',
      'message',
      'work_group',
    ]);
    expect(summary.children.filter((child) => child.type === 'work_group')).toHaveLength(3);
  });

  it('uses a compact system card as an idempotent activity boundary inside a running turn', () => {
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('before-compact', { text: 'before compact' }, 2),
        body: 'before compact',
        label: 'thinking',
      }),
      message({
        kind: 'system',
        source: source('compact-boundary', { boundaryId: 'boundary-1' }, 3),
        body: '',
        label: 'system:compact',
      }),
      message({
        kind: 'thinking',
        source: source('after-compact', { text: 'after compact' }, 4),
        body: 'after compact',
        label: 'thinking',
      }),
    ], { isSessionStreaming: true });

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'message', 'work_group']);
    expect(expectType(items[1], 'work_group').isStreaming).toBe(false);
    expect(expectType(items[3], 'work_group').isStreaming).toBe(true);
  });

  it('keeps a running agent_task flat as a visible anchor instead of folding it into the work group', () => {
    const toolCall = source('task-running', { toolName: 'Task', input: { description: 'Long audit', prompt: 'go' } }, 3);
    toolCall.toolUseId = 'tu-running';
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-running', {
        provider: 'claude-code',
        taskId: 'task-running',
        parentToolUseId: 'tu-running',
        status: 'running',
      }],
    ]);

    // 后台子 agent 仍在跑,父 turn 已产出最终正文:任务卡必须平铺可见,不折进「工作过程」。
    const items = buildMessageRenderItems([
      message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
      message({
        kind: 'thinking',
        source: source('thinking', { text: 'planning', durationMs: 800, isRedacted: false }, 2),
        body: 'planning',
        label: 'thinking',
      }),
      message({ kind: 'tool', source: toolCall, label: 'Task', body: 'Task(...)' }),
      message({ kind: 'assistant', source: source('final', 'kicked off', 5), body: 'kicked off', label: 'assistant' }),
    ], {}, taskUpdates);

    expect(items.map((item) => item.type)).toEqual(['message', 'work_group', 'agent_task', 'message']);
    expect(expectType(items[1], 'work_group').children.map((child) => child.type)).toEqual(['thinking']);
  });

  it('folds a finished agent_task into the work group (update status or paired result both count)', () => {
    const build = (patch: {
      update?: AgentTaskUpdate;
      secondaryBody?: string;
    }) => {
      const toolCall = source('task-done', { toolName: 'Task', input: { description: 'Audit', prompt: 'go' } }, 3);
      toolCall.toolUseId = 'tu-done';
      const taskUpdates = patch.update
        ? new Map<string, AgentTaskUpdate>([['tu-done', patch.update]])
        : undefined;
      return buildMessageRenderItems([
        message({ kind: 'user', source: source('user', 'start', 1), body: 'start', label: 'user' }),
        message({
          kind: 'tool',
          source: toolCall,
          label: 'Task',
          body: 'Task(...)',
          secondaryBody: patch.secondaryBody,
        }),
        message({ kind: 'assistant', source: source('final', 'done', 5), body: 'done', label: 'assistant' }),
      ], {}, taskUpdates);
    };

    // 终态 update(completed)→ 折叠进组。
    const byUpdate = build({
      update: {
        provider: 'claude-code',
        taskId: 'task-done',
        parentToolUseId: 'tu-done',
        status: 'completed',
      },
    });
    expect(byUpdate.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);
    expect(expectType(byUpdate[1], 'work_group').children.map((child) => child.type)).toEqual(['agent_task']);

    // 无 live update 但有配对工具结果(重连后的历史会话)→ 同样视为完成、折叠进组。
    const byResult = build({ secondaryBody: 'sub agent final report' });
    expect(byResult.map((item) => item.type)).toEqual(['message', 'work_group', 'message']);

    // 无 update 且无配对结果 → 与卡片显示口径一致视为 running,保持平铺。
    const stillRunning = build({});
    expect(stillRunning.map((item) => item.type)).toEqual(['message', 'agent_task', 'message']);
  });

  it('formats work durations with the desktop convention', () => {
    expect(formatDuration(400)).toBe('1s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});

function expectType<TType extends MessageRenderItem<FixtureMessage>['type']>(
  item: MessageRenderItem<FixtureMessage>,
  type: TType,
): Extract<MessageRenderItem<FixtureMessage>, { type: TType }> {
  expect(item.type).toBe(type);
  return item as Extract<MessageRenderItem<FixtureMessage>, { type: TType }>;
}

function tool(
  clientId: string,
  toolName: string,
  toolInput: unknown,
  toolUseId = clientId,
): MessageRenderSourceMessageLike {
  return {
    role: 'tool_use',
    clientId,
    toolName,
    toolInput,
    toolUseId,
    createdAt: `2026-01-01T00:00:0${clientId.length % 10}.000Z`,
  };
}

function result(toolUseId: string, content: string): MessageRenderSourceMessageLike {
  return {
    role: 'tool_result',
    clientId: `result-${toolUseId}`,
    toolUseId,
    content,
    createdAt: '2026-01-01T00:00:09.000Z',
  };
}

function normalized(
  source: MessageRenderSourceMessageLike,
  kind: MessageRenderNormalizedMessage['kind'] = 'tool',
): MessageRenderNormalizedMessage {
  return {
    key: source.clientId ?? 'unknown',
    source,
    kind,
    label: '',
    body: typeof source.content === 'string' ? source.content : '',
    createdAt: source.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('message render todo grouping', () => {
  it('groups TodoWrite updates into one visible todo card until all items complete', () => {
    const first = tool('todo1', 'TodoWrite', {
      todos: [
        { content: 'Read code', status: 'in_progress' },
        { content: 'Patch renderer', status: 'pending' },
      ],
    });
    const second = tool('todo2', 'TodoWrite', {
      todos: [
        { content: 'Read code', status: 'completed' },
        { content: 'Patch renderer', status: 'completed' },
      ],
    });

    const insertions = findMessageTodoInsertions([first, second]);

    expect([...insertions.keys()]).toEqual([1]);
    expect(insertions.get(1)).toMatchObject({
      key: 'todo-todo1',
      source: 'todo',
      todos: [
        { content: 'Read code', status: 'completed' },
        { content: 'Patch renderer', status: 'completed' },
      ],
    });
  });

  it('starts a new TodoWrite card after the previous batch is completed', () => {
    const done = tool('todo1', 'TodoWrite', {
      todos: [{ content: 'Old task', status: 'completed' }],
    });
    const next = tool('todo2', 'TodoWrite', {
      todos: [{ content: 'New task', status: 'pending' }],
    });

    const insertions = findMessageTodoInsertions([done, next]);

    expect([...insertions.values()].map((item) => item.key)).toEqual(['todo-todo1', 'todo-todo2']);
  });

  // findLatestMessageTodoInsertion:桌面钉住式计划面板(PinnedPlanPanel)的数据源 ——
  // 面板只展示"当前计划"一份,跨 source 取最近一次更新的 session 快照。

  it('findLatestMessageTodoInsertion picks the most recently updated plan session across sources', () => {
    const codex = tool('plan1', 'update_plan', {
      plan: [{ step: 'Check desktop', status: 'in_progress' }],
    });
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');

    const latest = findLatestMessageTodoInsertion([
      codex,
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
    ]);

    expect(latest).toMatchObject({ key: 'todo-task1', source: 'task' });
  });

  it('findLatestMessageTodoInsertion returns the merged session snapshot with the FIRST call key', () => {
    const first = tool('todo1', 'TodoWrite', {
      todos: [{ content: 'Read code', status: 'in_progress' }],
    });
    const second = tool('todo2', 'TodoWrite', {
      todos: [{ content: 'Read code', status: 'completed' }],
    });

    expect(findLatestMessageTodoInsertion([first, second])).toMatchObject({
      key: 'todo-todo1',
      todos: [{ content: 'Read code', status: 'completed' }],
    });
  });

  it('findLatestMessageTodoInsertion returns null when the conversation has no plan calls', () => {
    expect(findLatestMessageTodoInsertion([tool('t1', 'Bash', {})])).toBeNull();
  });

  it('a terminal seal ends the plan session even when steps were left open', () => {
    // 成功收尾常留未勾完的步骤。章之后的下一 turn 计划必须开新 session:
    // 否则新计划把上一轮吞成续写,历史里上一轮的卡消失、面板复用旧 key。
    const sealedOpen = {
      ...tool('plan1', 'update_plan', {
        plan: [{ step: 'Ship', status: 'in_progress' }],
      }),
      terminalPlanSnapshot: true,
      terminalPlanAtMs: 1_700_000_000_000,
    };
    const nextTurnPlan = tool('plan2', 'update_plan', {
      plan: [{ step: 'New task', status: 'in_progress' }],
    });

    expect(findLatestMessageTodoInsertion([sealedOpen, nextTurnPlan])).toMatchObject({
      key: 'todo-plan2',
      todos: [{ content: 'New task', status: 'in_progress' }],
    });
    // 章在持久化 content 里(mobile 渲染 main 广播行的形态)同样算边界。
    const sealedInContent = {
      ...tool('plan3', 'update_plan', { plan: [{ step: 'Ship', status: 'in_progress' }] }),
      content: {
        toolUseId: 'plan3',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'in_progress' }] },
        terminalPlanSnapshot: true,
        terminalPlanAtMs: 1_700_000_000_000,
      },
    };
    const latest = findLatestMessageTodoInsertion([sealedInContent, nextTurnPlan]);
    expect(latest).toMatchObject({ key: 'todo-plan2' });
    expect(
      findLatestMessageTodoInsertion([sealedInContent]),
    ).toMatchObject({ sealed: true, sealedAtMs: 1_700_000_000_000 });
  });

  it('findLatestMessageTodoInsertion marks a plan whose turn failed as turnFailed', () => {
    // persistCodexPlanOnDone 在中断/失败终态给计划行盖 turnCompleted:false。
    // 面板据此不走"全勾完"兜底退场:任务还活着,计划必须留在屏幕上。
    const failedPlan = {
      ...tool('plan1', 'update_plan', {
        plan: [{ step: 'Ship it', status: 'completed' }],
      }),
      turnCompleted: false,
    };

    expect(findLatestMessageTodoInsertion([failedPlan])).toMatchObject({
      source: 'codex',
      turnFailed: true,
    });
    // 正常行没有印记,不应引入该字段。
    expect(
      findLatestMessageTodoInsertion([
        tool('plan2', 'update_plan', { plan: [{ step: 'Ship it', status: 'completed' }] }),
      ]),
    ).not.toHaveProperty('turnFailed');
  });

  /**
   * 计划归属(ownership)。三个历史病根,都源于"同 source 的上一份计划没勾完
   * 就无条件当续期":
   *  1. 跨普通 user turn 串号——用户换了话题,新计划仍复用旧 session/key;
   *  2. 子代理的计划工具调用与主线程平权,子计划能顶掉主计划;
   *  3. Codex 不同 turn 的 update_plan 被并成同一 session。
   */
  describe('plan ownership boundaries', () => {
    it('treats a bare legacy transcript parentUuid as top-level, not subagent', () => {
      // 旧 Claude 导入把普通 transcript 链边也存在 agentMeta.parentUuid(裸 uuid
      // 形态)。一律当子代理会让旧会话的顶层计划被面板与对账整段过滤掉;只认
      // SDK tool-use id 形态(toolu_/call_ 前缀),与 latestMessageText 同判据。
      const legacyTopLevelPlan: MessageRenderSourceMessageLike = {
        ...tool('todo-legacy', 'TodoWrite', {
          todos: [
            { content: 'Legacy step', status: 'in_progress' },
            { content: 'Legacy follow-up', status: 'pending' },
          ],
        }),
        agentMeta: { parentUuid: '4f1c9a7e-3b2d-4c8a-9e5f-1a2b3c4d5e6f' },
      };

      expect(findLatestMessageTodoInsertion([legacyTopLevelPlan])).toMatchObject({
        key: 'todo-todo-legacy',
        todos: [
          { content: 'Legacy step', status: 'in_progress' },
          { content: 'Legacy follow-up', status: 'pending' },
        ],
      });

      // 真正的 SDK tool 父级(toolu_ 前缀)仍然按子代理排除。
      const realSubagentPlan: MessageRenderSourceMessageLike = {
        ...tool('todo-sub2', 'TodoWrite', {
          todos: [
            { content: 'Subagent step', status: 'in_progress' },
            { content: 'Subagent follow-up', status: 'pending' },
          ],
        }),
        agentMeta: { parentUuid: 'toolu_01ABCDEF' },
      };
      expect(findLatestMessageTodoInsertion([realSubagentPlan])).toBeNull();
    });

    it('starts a new session when an ordinary user turn intervenes', () => {
      const staleTodo = tool('todo-old', 'TodoWrite', {
        todos: [
          { content: 'Old work', status: 'in_progress' },
          { content: 'Old follow-up', status: 'pending' },
        ],
      });
      const newUserTurn: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'user-2',
        content: '换个话题:帮我做另一件事',
        createdAt: at(5),
      };
      const freshTodo = tool('todo-new', 'TodoWrite', {
        todos: [{ content: 'New work', status: 'in_progress' }, { content: 'New follow-up', status: 'pending' }],
      });

      const latest = findLatestMessageTodoInsertion([staleTodo, newUserTurn, freshTodo]);
      // 新 user turn 之后的计划是新 session:key 必须锚在新调用上,不复用旧 key。
      expect(latest).toMatchObject({
        key: 'todo-todo-new',
        todos: [
          { content: 'New work', status: 'in_progress' },
          { content: 'New follow-up', status: 'pending' },
        ],
      });
    });

    it('does not cut a session at synthetic user rows (auto-resume / scheduler)', () => {
      const staleTodo = tool('todo-live', 'TodoWrite', {
        todos: [
          { content: 'Long work', status: 'in_progress' },
          { content: 'Long follow-up', status: 'pending' },
        ],
      });
      const autoResumeRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'auto-resume-1',
        content: '继续',
        createdAt: at(5),
        agentMeta: { autoResume: true },
      };
      const schedulerRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'sched-1',
        content: '定时任务触发',
        createdAt: at(6),
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 's1', scheduleName: 'n' } },
      };
      // desktop 渲染层投影后 agentMeta 被丢弃,只剩这两个字段——同样不得切边界。
      const projectedSyntheticRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'projected-1',
        content: '',
        createdAt: at(7),
        isSyntheticTrigger: true,
      };
      const projectedSchedulerRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'projected-2',
        content: '定时活',
        createdAt: at(8),
        automationOrigin: { kind: 'scheduler', scheduleId: 's1' },
      };
      // 子代理内部的 user 行(agentMeta.parentUuid)同样不是用户开新话题。
      const subagentUserRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'sub-user-1',
        content: '子任务内部输入',
        createdAt: at(9),
        agentMeta: { parentUuid: 'toolu_parent_1' },
      };
      // 同轮 steer 插话(desktop 投影 delivery='steer')也不是新话题边界。
      const steerUserRow: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'steer-1',
        content: '顺便把日志也看下',
        createdAt: at(10),
        delivery: 'steer',
      };
      const progress = tool('todo-live-2', 'TodoWrite', {
        todos: [
          { content: 'Long work', status: 'completed' },
          { content: 'Long follow-up', status: 'in_progress' },
        ],
      });

      // 自动续跑/scheduler 落的 user 行不是"用户开新话题":同计划的后续更新
      // 仍并入原 session,key 不变,不产生重复计划卡。
      expect(
        findLatestMessageTodoInsertion([
          staleTodo,
          autoResumeRow,
          schedulerRow,
          projectedSyntheticRow,
          projectedSchedulerRow,
          subagentUserRow,
          steerUserRow,
          progress,
        ]),
      ).toMatchObject({
        key: 'todo-todo-live',
        todos: [
          { content: 'Long work', status: 'completed' },
          { content: 'Long follow-up', status: 'in_progress' },
        ],
      });
    });

    it('keeps in-turn progress updates merged into one session (no user turn between)', () => {
      const first = tool('todo-a', 'TodoWrite', {
        todos: [{ content: 'Step', status: 'in_progress' }],
      });
      const second = tool('todo-b', 'TodoWrite', {
        todos: [{ content: 'Step', status: 'completed' }],
      });

      // 同一 turn 内的进度更新仍是续期:key 锚定首次调用(现状契约,不能破坏)。
      expect(findLatestMessageTodoInsertion([first, second])).toMatchObject({
        key: 'todo-todo-a',
        todos: [{ content: 'Step', status: 'completed' }],
      });
    });

    it('ignores subagent plan calls for the top-level pinned panel', () => {
      const mainPlan = tool('plan-main', 'update_plan', {
        plan: [
          { step: 'Main step', status: 'in_progress' },
          { step: 'Main follow-up', status: 'pending' },
        ],
      });
      const subagentTodo: MessageRenderSourceMessageLike = {
        ...tool('todo-sub', 'TodoWrite', {
          todos: [
            { content: 'Subagent internal', status: 'in_progress' },
            { content: 'Subagent extra', status: 'pending' },
          ],
        }),
        parentToolUseId: 'agent-task-1',
      };

      // 子代理自己的清单不得顶掉主线程计划。
      expect(findLatestMessageTodoInsertion([mainPlan, subagentTodo])).toMatchObject({
        key: 'todo-plan-main',
        todos: [
          { content: 'Main step', status: 'in_progress' },
          { content: 'Main follow-up', status: 'pending' },
        ],
      });
    });

    it('does not merge Codex plans from different turns into one session', () => {
      const turn1Plan = tool('plan-t1', 'update_plan', {
        plan: [
          { step: 'Turn one work', status: 'in_progress' },
          { step: 'Turn one rest', status: 'pending' },
        ],
      }, 'plan:turn-1');
      const newUserTurn: MessageRenderSourceMessageLike = {
        role: 'user',
        clientId: 'user-3',
        content: '下一个任务',
        createdAt: at(6),
      };
      const turn2Plan = tool('plan-t2', 'update_plan', {
        plan: [
          { step: 'Turn two work', status: 'in_progress' },
          { step: 'Turn two rest', status: 'pending' },
        ],
      }, 'plan:turn-2');

      const latest = findLatestMessageTodoInsertion([turn1Plan, newUserTurn, turn2Plan]);
      expect(latest).toMatchObject({
        key: 'todo-plan-t2',
        todos: [
          { content: 'Turn two work', status: 'in_progress' },
          { content: 'Turn two rest', status: 'pending' },
        ],
      });
    });
  });

  it('does not infer completion from an ambiguous legacy Codex turn seal', () => {
    const plan = {
      ...tool('plan1', 'update_plan', {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Start dev', status: 'in_progress' },
        ],
      }),
      createdAt: at(1),
    };
    const completedBoundary: MessageRenderSourceMessageLike = {
      role: 'assistant',
      clientId: 'answer-1',
      content: 'Dev server is running.',
      createdAt: at(8),
      turnCompleted: true,
    };

    expect(findLatestMessageTodoInsertion([plan, completedBoundary])).toMatchObject({
      source: 'codex',
      createdAt: at(1),
      todos: [
        { content: 'Inspect', status: 'completed' },
        { content: 'Start dev', status: 'in_progress' },
      ],
    });
  });

  it('does not infer completion when an ambiguous legacy seal precedes the final plan update', () => {
    const completedBoundary: MessageRenderSourceMessageLike = {
      role: 'assistant',
      clientId: 'answer-1',
      content: 'The work is complete.',
      createdAt: at(7),
      turnCompleted: true,
    };
    const plan = {
      ...tool('plan1', 'update_plan', {
        plan: [{ step: 'Record the final state', status: 'in_progress' }],
      }),
      createdAt: at(8),
    };

    expect(findLatestMessageTodoInsertion([completedBoundary, plan])).toMatchObject({
      source: 'codex',
      createdAt: at(8),
      todos: [{ content: 'Record the final state', status: 'in_progress' }],
    });
  });

  it('findLatestMessageTodoInsertion treats empty plan updates as clearing the pinned plan', () => {
    const first = tool('todo1', 'TodoWrite', {
      todos: [{ content: 'Read code', status: 'in_progress' }],
    });
    const clearTodo = tool('todo2', 'TodoWrite', { todos: [] });
    const codex = tool('plan1', 'update_plan', {
      plan: [{ step: 'Run tests', status: 'in_progress' }],
    });
    const clearCodex = tool('plan2', 'update_plan', { plan: [] });
    const clearCodexObject = tool('plan3', 'update_plan', {});
    const clearCodexText = tool('plan4', 'update_plan', { text: '  \n  ' });

    expect(findLatestMessageTodoInsertion([first, clearTodo])).toBeNull();
    expect(findLatestMessageTodoInsertion([codex, clearCodex])).toBeNull();
    expect(findLatestMessageTodoInsertion([codex, clearCodexObject])).toBeNull();
    expect(findLatestMessageTodoInsertion([codex, clearCodexText])).toBeNull();
  });

  it('findLatestMessageTodoInsertion does not fall back to an older source when the latest Task update is unresolved', () => {
    const todo = tool('todo1', 'TodoWrite', {
      todos: [{ content: 'Old todo source', status: 'in_progress' }],
    });
    const update = tool('task2', 'TaskUpdate', { taskId: 'abc', status: 'completed' }, 'update-1');

    expect(findLatestMessageTodoInsertion([todo, update])).toBeNull();
  });

  it('keeps a Task update unresolved when the loaded window only contains a different task', () => {
    const visibleCreate = tool(
      'task4',
      'TaskCreate',
      { subject: 'Fix existing tests' },
      'create-4',
    );
    const olderTaskUpdate = tool(
      'task3-update',
      'TaskUpdate',
      { taskId: '3', status: 'completed' },
      'update-3',
    );

    expect(findLatestMessageTodoInsertion([
      visibleCreate,
      result('create-4', 'Task #4 created successfully: Fix existing tests'),
      olderTaskUpdate,
    ])).toBeNull();
  });

  it('keeps the Task window unresolved until every earlier updated task is reconstructed', () => {
    const missingOlderUpdate = tool(
      'task1-update',
      'TaskUpdate',
      { taskId: '1', status: 'completed' },
      'update-1',
    );
    const visibleTarget = tool(
      'task3',
      'TaskCreate',
      { subject: 'Run stress tests' },
      'create-3',
    );
    const visiblePending = tool(
      'task4',
      'TaskCreate',
      { subject: 'Fix existing tests' },
      'create-4',
    );
    const latestUpdate = tool(
      'task3-update',
      'TaskUpdate',
      { taskId: '3', status: 'completed' },
      'update-3',
    );

    expect(findLatestMessageTodoInsertion([
      visibleTarget,
      result('create-3', 'Task #3 created successfully: Run stress tests'),
      missingOlderUpdate,
      visiblePending,
      result('create-4', 'Task #4 created successfully: Fix existing tests'),
      latestUpdate,
    ])).toBeNull();
  });

  it('keeps a partial Task session unresolved while older messages may contain earlier creates', () => {
    const create = tool('task2', 'TaskCreate', { subject: 'Fix renderer' }, 'create-2');
    const update = tool(
      'task2-update',
      'TaskUpdate',
      { taskId: '2', status: 'in_progress' },
      'update-2',
    );
    const messages = [
      create,
      result('create-2', 'Task #2 created successfully: Fix renderer'),
      update,
    ];

    expect(getLatestMessageTodoState(messages, { taskHistoryMayBeIncomplete: true })).toMatchObject({
      insertion: null,
      isResolved: false,
    });
    expect(getLatestMessageTodoState(messages, { taskHistoryMayBeIncomplete: false })).toMatchObject({
      isResolved: true,
      insertion: {
        todos: [{ content: 'Fix renderer', status: 'in_progress' }],
      },
    });
  });

  it('keeps a titleless TaskList unresolved until the missing task title is reconstructed', () => {
    const list = tool('task-list', 'TaskList', {}, 'list-1');
    const listResult = result('list-1', JSON.stringify({
      tasks: [
        { id: 'abc', status: 'completed' },
        { id: 'def', subject: 'Write summary', status: 'pending' },
      ],
    }));

    expect(getLatestMessageTodoState([list, listResult])).toMatchObject({
      insertion: null,
      isResolved: false,
    });

    const create = tool('task-create', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    expect(getLatestMessageTodoState([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      list,
      listResult,
    ])).toMatchObject({
      isResolved: true,
      insertion: {
        todos: [
          { content: 'Collect logs', status: 'completed' },
          { content: 'Write summary', status: 'pending' },
        ],
      },
    });
  });

  it('preserves a completed task title when a later TaskList repeats the same id', () => {
    const create = tool('task-create', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const complete = tool(
      'task-complete',
      'TaskUpdate',
      { taskId: 'abc', status: 'completed' },
      'update-1',
    );
    const list = tool('task-list', 'TaskList', {}, 'list-1');

    expect(findLatestMessageTodoInsertion([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      complete,
      list,
      result('list-1', JSON.stringify({ tasks: [{ id: 'abc', status: 'completed' }] })),
    ])).toMatchObject({
      todos: [{ content: 'Collect logs', status: 'completed' }],
    });
  });

  it('does not let an orphan completed update block a later complete task session', () => {
    const orphanUpdate = tool(
      'old-task-update',
      'TaskUpdate',
      { taskId: 'old', status: 'completed' },
      'update-old',
    );
    const first = tool('new-task-1', 'TaskCreate', { subject: 'Inspect logs' }, 'create-new-1');
    const second = tool('new-task-2', 'TaskCreate', { subject: 'Fix renderer' }, 'create-new-2');

    expect(findLatestMessageTodoInsertion([
      orphanUpdate,
      first,
      result('create-new-1', 'Task #new-1 created successfully: Inspect logs'),
      second,
      result('create-new-2', 'Task #new-2 created successfully: Fix renderer'),
    ])).toMatchObject({
      key: 'todo-new-task-1',
      todos: [
        { content: 'Inspect logs', status: 'pending' },
        { content: 'Fix renderer', status: 'pending' },
      ],
    });
  });

  it('findLatestMessageTodoInsertion clears the pinned plan when the latest Task update deletes the last task', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const remove = tool('task2', 'TaskUpdate', { taskId: 'abc', status: 'deleted' }, 'update-1');

    expect(findLatestMessageTodoInsertion([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      remove,
    ])).toBeNull();
  });

  it('findLatestMessageTodoInsertion keeps remaining tasks when the latest Task update deletes one task', () => {
    const first = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const second = tool('task2', 'TaskCreate', { subject: 'Write summary' }, 'create-2');
    const remove = tool('task3', 'TaskUpdate', { taskId: 'abc', status: 'deleted' }, 'update-1');

    expect(findLatestMessageTodoInsertion([
      first,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      second,
      result('create-2', 'Task #def created successfully: Write summary'),
      remove,
    ])).toMatchObject({
      key: 'todo-task1',
      source: 'task',
      todos: [{ content: 'Write summary', status: 'pending' }],
    });
  });

  it('keeps other completed tasks when the latest Task update deletes one completed task', () => {
    const first = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const second = tool('task2', 'TaskCreate', { subject: 'Write summary' }, 'create-2');
    const completeFirst = tool('task3', 'TaskUpdate', { taskId: 'abc', status: 'completed' }, 'update-1');
    const completeSecond = tool('task4', 'TaskUpdate', { taskId: 'def', status: 'completed' }, 'update-2');
    const removeFirst = tool('task5', 'TaskUpdate', { taskId: 'abc', status: 'deleted' }, 'update-3');

    expect(findLatestMessageTodoInsertion([
      first,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      second,
      result('create-2', 'Task #def created successfully: Write summary'),
      completeFirst,
      completeSecond,
      removeFirst,
    ])).toMatchObject({
      key: 'todo-task1',
      source: 'task',
      todos: [{ content: 'Write summary', status: 'completed' }],
    });
  });

  it('treats TaskGet deleted results as clearing the latest task plan', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const getDeleted = tool('task2', 'TaskGet', { taskId: 'abc' }, 'get-1');

    expect(findLatestMessageTodoInsertion([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      getDeleted,
      result('get-1', JSON.stringify({
        task: { id: 'abc', subject: 'Collect logs', status: 'deleted' },
      })),
    ])).toBeNull();
  });

  it('treats explicit empty TaskList snapshots as clearing the latest task plan', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const listEmpty = tool('task2', 'TaskList', {}, 'list-1');

    expect(findLatestMessageTodoInsertion([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      listEmpty,
      result('list-1', JSON.stringify({ tasks: [] })),
    ])).toBeNull();
  });

  it('treats deleted-only TaskList snapshots as clearing the latest task plan', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const listDeleted = tool('task2', 'TaskList', {}, 'list-1');

    expect(findLatestMessageTodoInsertion([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      listDeleted,
      result('list-1', JSON.stringify({
        tasks: [{ id: 'abc', status: 'deleted' }],
      })),
    ])).toBeNull();
  });

  it('parses Codex update_plan text and structured plan statuses', () => {
    expect(extractPlanTodos('update_plan', { text: '1. Read code\n2. Run tests' })).toEqual([
      { content: 'Read code', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ]);

    expect(extractPlanTodos('update_plan', {
      plan: [
        { step: 'Inspect logs', status: 'completed' },
        { step: 'Patch shared layer', status: 'inProgress' },
      ],
    })).toEqual([
      { content: 'Inspect logs', status: 'completed' },
      { content: 'Patch shared layer', status: 'in_progress' },
    ]);
  });

  it('keeps Codex update_plan and Claude Task* batches in separate cards', () => {
    const codex = tool('plan1', 'update_plan', {
      plan: [{ step: 'Check desktop', status: 'in_progress' }],
    });
    const taskCreate = tool('task1', 'TaskCreate', { subject: 'Check mobile' }, 'task-use-1');

    const insertions = findMessageTodoInsertions([
      codex,
      taskCreate,
      result('task-use-1', 'Task #abc created successfully: Check mobile'),
    ]);

    expect([...insertions.values()].map((item) => [item.key, item.source, item.todos[0]?.content])).toEqual([
      ['todo-plan1', 'codex', 'Check desktop'],
      ['todo-task1', 'task', 'Check mobile'],
    ]);
  });

  it('preserves task state when Codex plan updates appear between Task calls', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const codex = tool('plan1', 'update_plan', {
      plan: [{ step: 'Check desktop', status: 'in_progress' }],
    });
    const update = tool('task2', 'TaskUpdate', { taskId: 'abc', status: 'completed' }, 'update-1');

    const insertions = findMessageTodoInsertions([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      codex,
      update,
    ]);

    expect(insertions.get(2)?.todos).toEqual([
      { content: 'Check desktop', status: 'in_progress' },
    ]);
    expect(insertions.get(3)?.todos).toEqual([
      { content: 'Collect logs', status: 'completed' },
    ]);
  });

  it('groups Claude TaskCreate/TaskUpdate/TaskList/TaskGet into task todo cards', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const update = tool('task2', 'TaskUpdate', { taskId: 'abc', status: 'running' }, 'update-1');
    const list = tool('task3', 'TaskList', {}, 'list-1');
    const get = tool('task4', 'TaskGet', { taskId: 'def' }, 'get-1');

    const insertions = findMessageTodoInsertions([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      update,
      list,
      result('list-1', JSON.stringify({
        tasks: [
          { id: 'abc', subject: 'Collect logs', status: 'completed' },
          { id: 'def', subject: 'Write summary', status: 'running' },
        ],
      })),
      get,
      result('get-1', JSON.stringify({
        task: { id: 'def', subject: 'Write summary', status: 'completed' },
      })),
    ]);

    expect([...insertions.keys()]).toEqual([5]);
    expect(insertions.get(5)?.todos).toEqual([
      { content: 'Collect logs', status: 'completed' },
      { content: 'Write summary', status: 'completed' },
    ]);
  });

  it('preserves existing task titles when TaskList snapshots only include id and status', () => {
    const create = tool('task1', 'TaskCreate', { subject: 'Collect logs' }, 'create-1');
    const list = tool('task2', 'TaskList', {}, 'list-1');

    const insertions = findMessageTodoInsertions([
      create,
      result('create-1', 'Task #abc created successfully: Collect logs'),
      list,
      result('list-1', JSON.stringify({
        tasks: [
          { id: 'abc', status: 'completed' },
        ],
      })),
    ]);

    expect([...insertions.keys()]).toEqual([2]);
    expect(insertions.get(2)?.todos).toEqual([
      { content: 'Collect logs', status: 'completed' },
    ]);
  });

  it('ignores orphan Claude TaskUpdate rows without task content', () => {
    const update = tool('task-update-15', 'TaskUpdate', { taskId: '15', status: 'completed' }, 'update-15');

    const insertions = findMessageTodoInsertions([
      update,
      result('update-15', 'Updated task #15 status'),
    ]);

    expect([...insertions.values()]).toEqual([]);
  });

  it('does not render id-only task todo cards from partial history', () => {
    const update = tool('task-update-15', 'TaskUpdate', { taskId: '15', status: 'completed' }, 'update-15');
    const messages = [
      normalized(update),
      normalized(result('update-15', 'Updated task #15 status')),
    ];

    const items = buildMessageRenderItems(messages, { isSessionStreaming: false });

    expect(items).toEqual([]);
  });

  it('buildMessageRenderItems emits a shared todo card instead of raw plan tool rows', () => {
    const messages = [
      normalized({
        clientId: 'user1',
        role: 'user',
        content: 'start',
        createdAt: '2026-01-01T00:00:00.000Z',
      }, 'user'),
      normalized(tool('plan1', 'update_plan', { text: '1. Inspect\n2. Patch' })),
      normalized({
        clientId: 'answer1',
        role: 'assistant',
        content: 'Done',
        createdAt: '2026-01-01T00:00:02.000Z',
      }, 'assistant'),
    ];

    const items = buildMessageRenderItems(messages, { isSessionStreaming: true });

    expect(items.map((item) => item.type)).toEqual(['message', 'todo', 'message']);
    expect(items[1]).toMatchObject({
      type: 'todo',
      key: 'todo-plan1',
      isStreaming: false,
      todos: [
        { content: 'Inspect', status: 'in_progress' },
        { content: 'Patch', status: 'pending' },
      ],
    });
  });

  it('marks only the plan card in the active tail work segment as live', () => {
    const items = buildMessageRenderItems([
      normalized(tool('plan-before-answer', 'update_plan', {
        plan: [{ step: 'Old task', status: 'completed' }],
      })),
      normalized({
        clientId: 'progress-boundary',
        role: 'assistant',
        content: 'Finished that step.',
        createdAt: '2026-01-01T00:00:07.000Z',
      }, 'assistant'),
      normalized(tool('plan-after-answer', 'update_plan', {
        plan: [{ step: 'Current task', status: 'in_progress' }],
      })),
    ], { isSessionStreaming: true });

    const todos = items.filter((item) => item.type === 'todo');
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({ key: 'todo-plan-before-answer', isStreaming: false });
    expect(todos[1]).toMatchObject({ key: 'todo-plan-after-answer', isStreaming: true });
  });

  it('buildMessageRenderItems hides plan tool results after rendering the todo card', () => {
    const messages = [
      normalized(tool('plan1', 'update_plan', { text: '1. Inspect\n2. Patch' }, 'plan-use-1')),
      normalized(result('plan-use-1', 'plan updated')),
    ];

    const items = buildMessageRenderItems(messages, { isSessionStreaming: true });

    expect(items.map((item) => item.type)).toEqual(['todo']);
  });

  it('buildMessageRenderItems keeps completed todo cards visible outside work groups', () => {
    const messages = [
      normalized({
        clientId: 'user1',
        role: 'user',
        content: 'start',
        createdAt: '2026-01-01T00:00:00.000Z',
      }, 'user'),
      normalized(tool('plan1', 'update_plan', { text: '1. Inspect\n2. Patch' })),
      normalized({
        clientId: 'answer1',
        role: 'assistant',
        content: 'Done',
        createdAt: '2026-01-01T00:00:02.000Z',
      }, 'assistant'),
    ];

    const items = buildMessageRenderItems(messages, { isSessionStreaming: false });

    expect(items.map((item) => item.type)).toEqual(['message', 'todo', 'message']);
  });
});

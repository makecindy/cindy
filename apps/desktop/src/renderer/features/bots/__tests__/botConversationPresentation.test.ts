import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';
import { groupWorkRuns, type MessageRenderItem, type ToolSegmentRenderItem, type RenderItem } from '@/components/chat/messageWorkGroups';
import { botProcessItems, simplifyBotRenderItems } from '../botConversationPresentation';

const message = (id: string, role: ChatMessage['role'], content = id,
  extra: Partial<ChatMessage> = {}): MessageRenderItem => ({
  type: 'message', key: `msg-${id}`, message: { clientId: id, role, content, ...extra },
});
const tool = (id: string): ToolSegmentRenderItem => ({ type: 'tool_segment', key: `tools-${id}`,
  toolCalls: [{ clientId: id, role: 'tool_use', toolUseId: id, toolName: 'exec', content: '' }],
  resultMap: new Map([[id, 'error evidence']]), settledIds: new Set([id]), resultTsMap: new Map(),
});
const proseIds = (items: RenderItem[]) => items.flatMap((item) =>
  item.type === 'message' && item.message.role === 'assistant' ? [item.message.clientId] : []);
const allKeys = (items: readonly RenderItem[]): string[] => items.flatMap((item) =>
  item.type === 'work_group' ? allKeys(item.children) : [item.key]);
/** Top-level shape: groups render as key[children], `*` marks a live tail group. */
const shape = (items: readonly RenderItem[]): string => items.map((item) => item.type === 'work_group'
  ? `${item.key}${item.isStreaming ? '*' : ''}[${shape(item.children)}]` : item.key).join(', ');
const project = (items: RenderItem[], streaming: boolean) =>
  simplifyBotRenderItems(groupWorkRuns(items, streaming), streaming);

// Unit regression: same production grouping and projection as MessageStream.
// Existing tests expected progress to disappear; exercise the metadata handoff.
it('keeps working prose through streaming metadata and tools, folding only after the answer', () => {
  const user = message('u', 'user');
  const progress = message('progress', 'assistant', 'Checking the refresh', { isStreaming: true });
  const marked = message('progress', 'assistant', 'Checking the refresh', { assistantPhase: 'commentary' });
  for (const source of [[user, progress], [user, marked], [user, marked, tool('read')]]) {
    expect(proseIds(project(source, true))).toContain('progress');
  }
  const completed = project([user, marked, tool('read'), message('final', 'assistant', 'Done', { turnCompleted: true })], false);
  expect(proseIds(completed)).toEqual(['final']);
  expect(allKeys(completed)).toContain('msg-progress');
  expect(completed.some(item => item.type === 'work_group' && !item.isStreaming)).toBe(true);
});

describe('teammate final-result presentation', () => {
  // Runtime regression: persisted private prose was lifted back into the owner chat on reload.
  it.each([true, false])('keeps private prose out of the owner chat, including folded history (streaming=%s)', streaming => {
    const trace = message('trace', 'assistant', '', { systemCardType: 'bot-direct-message' });
    const internal = message('internal', 'assistant', 'Internal answer', {
      botPrivateReply: true, assistantPhase: 'final_answer', turnCompleted: true,
    });
    const rows = [trace, internal, tool('audit'), message('owner', 'assistant', 'Owner answer', {
      botPrivateReply: false, turnCompleted: true,
    }), message('error', 'error', 'Action required')];
    const result = botProcessItems(groupWorkRuns(rows, streaming), streaming);
    expect(allKeys(result)).not.toContain('msg-internal');
    expect(allKeys(result)).toEqual(expect.arrayContaining(['msg-trace', 'msg-owner', 'msg-error', 'tools-audit']));
    expect(internal.message.content).toBe('Internal answer');
  });
  // #6351: provider final_answer only closes a message, not a successful sample.
  // Failed output remains in the expandable work history rather than being lifted
  // beside the real answer; normal commentary is governed by the existing rules.
  it.each(['retrying', 'completed', 'exhausted', 'stopped'] as const)(
    'retains failed sampling output in work history when the retry is %s', (ending) => {
      const result = project([
        message('u', 'user'),
        message('failed', 'assistant', 'Opening from failed attempt', {
          assistantPhase: 'final_answer', failedSamplingAttempt: true, turnCostUsd: 0.1,
        }),
        message('failed-commentary', 'assistant', 'Preparing another opening', {
          assistantPhase: 'commentary', failedSamplingAttempt: true,
        }),
        ...(ending === 'completed'
          ? [message('intro', 'assistant', 'Accepted intro'),
            message('success', 'assistant', 'Successful opening', { assistantPhase: 'final_answer', turnCompleted: true })]
          : ending === 'retrying' ? [] : [message('error', 'error', 'Reply interrupted')]),
      ], ending === 'retrying');
      expect(proseIds(result)).toEqual(ending === 'completed' ? ['intro', 'success'] : []);
      // Failed output remains reachable only inside the work history.
      expect(allKeys(result)).toContain('msg-failed');
      expect(allKeys(result)).toContain('msg-failed-commentary');
    });
  it('keeps coordination input hidden while process, explicit inputs, results and errors remain visible', () => {
    const rows = [message('coordination', 'user', '[UI_ACTION_TRIGGER]File agreement', { isSyntheticTrigger: true }),
      tool('audit'), message('visible-input', 'user', 'Requested status'),
      message('result', 'assistant', 'Final result', { turnCompleted: true }), message('error', 'error', 'Action required')];
    expect(shape(project(rows, false))).toBe('work-audit[tools-audit], msg-visible-input, msg-result, msg-error');
  });

  it('folds process rows into the normal work summary and keeps final answers without mutating history', () => {
    const input = [message('u', 'user'), message('a', 'assistant'), tool('t1'),
      message('b', 'assistant'), tool('t2'), message('final', 'assistant', 'Result', { turnCompleted: true })];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['final']);
    // Same shape as a normal session: one outer summary with intermediate prose and inner groups.
    expect(shape(result)).toBe('msg-u, work-summary-t1[msg-a, work-t1[tools-t1], msg-b, work-t2[tools-t2]], msg-final');
    expect(input[1]).toEqual(message('a', 'assistant'));
  });

  it('keeps every unsealed segment visible from its first delta until the final answer', () => {
    const start = [message('u', 'user'), message('a', 'assistant', 'A', { isStreaming: true })];
    expect(proseIds(project(start, true))).toEqual(['a']);
    const work = [...start, tool('t1')];
    expect(proseIds(project(work, true))).toEqual(['a']);
    expect(shape(project(work, true))).toBe('msg-u, msg-a, work-t1*[tools-t1]');
    const continued = project([...work, message('b', 'assistant', 'B', { isStreaming: true })], true);
    expect(proseIds(continued)).toEqual(['a', 'b']);
    expect(shape(continued)).toBe('msg-u, msg-a, work-t1[tools-t1], msg-b');
    const done = project([...work, message('b', 'assistant', 'B', { turnCompleted: true })], false);
    expect(proseIds(done)).toEqual(['b']);
    expect(shape(done)).toBe('msg-u, work-summary-t1[msg-a, work-t1[tools-t1]], msg-b');
  });

  it.each(['stopped', 'failed', 'history'])('retains useful progress with no final: %s', () => {
    const input = [message('u', 'user'), message('a', 'assistant'), tool('t1'),
      message('last', 'assistant'), tool('t2'), message('err', 'error')];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['a', 'last']);
    expect(shape(result)).toBe('msg-u, msg-a, work-t1[tools-t1], msg-last, work-t2[tools-t2], msg-err');
  });

  it('keeps all blocks of sealed replies across continuation tools and history reloads', () => {
    const input = [message('u', 'user'), message('progress', 'assistant'), tool('t1'),
      message('first', 'assistant'), message('second', 'assistant', 'Second', { turnCompleted: true }),
      tool('t2'), message('third', 'assistant'),
      message('fourth', 'assistant', 'Fourth', { turnCompleted: true })];
    for (const streaming of [true, false]) {
      const result = project(input, streaming);
      expect(proseIds(result)).toEqual(['first', 'second', 'third', 'fourth']);
      // Earlier addressed replies stay outside the preserved work history.
      expect(shape(result)).toBe('msg-u, work-summary-t1[msg-progress, work-t1[tools-t1]], msg-first, msg-second, work-t2[tools-t2], msg-third, msg-fourth');
    }
  });

  it('does not extend a seal across thinking removed from public execution', () => {
    const result = simplifyBotRenderItems([message('progress', 'assistant'),
      message('private', 'thinking'), message('first', 'assistant'),
      message('second', 'assistant', 'Second', { turnCompleted: true })], true);
    expect(proseIds(result)).toEqual(['progress', 'first', 'second']);
    expect(allKeys(result)).not.toContain('msg-private');
  });

  it.each<RenderItem>([
    message('file', 'assistant', '', { files: [{ name: 'report.pdf', path: '/report.pdf' }], turnCompleted: true }),
    message('image', 'assistant', '', {
      images: [{ url: '/picture.png', mimeType: 'image/png', originalName: 'picture.png' }], turnCompleted: true,
    }),
    { type: 'tool_media', key: 'media', items: [{ kind: 'image', url: '/picture.png' }] },
    { type: 'ghost_card', key: 'card', callId: 'call', ghostId: 'plugin', tool: 'render',
      toolCall: { clientId: 'call', role: 'tool_use', content: '' }, settled: true },
  ])('preserves progress history when an attachment or card arrives: $key', (delivery) => {
    const input = [message('u', 'user'), message('progress', 'assistant', '正在生成'), tool('t'), delivery];
    for (const streaming of [true, false]) {
      const result = project(input, streaming);
      expect(proseIds(result)).toContain('progress');
      expect(result.some((item) => item.key === delivery.key)).toBe(true);
      expect(allKeys(result)).toContain('msg-progress');
    }
  });

  it('keeps a persisted task result receipt visible next to the work fold', () => {
    const receipt = message('receipt', 'assistant', '', {
      systemCardType: 'bot-session-task-result',
      systemCardData: { botCollaboration: { role: 'delegation-result' } },
    });
    const input = [message('u', 'user'), message('progress', 'assistant'), tool('t'), receipt];
    expect(shape(project(input, true))).toBe('msg-u, msg-progress, work-t*[tools-t], msg-receipt');
    expect(shape(project(input, false))).toBe('msg-u, msg-progress, work-t[tools-t], msg-receipt');
  });

  it('retains a later explanation after partial delivery and ignores unverified file candidates', () => {
    const result = project([message('u', 'user'),
      message('file', 'assistant', '', { files: [{ name: 'partial.pdf', path: '/partial.pdf' }] }),
      message('explanation', 'assistant', 'Only part of the export completed'), tool('failed'),
      { type: 'generated_files', key: 'candidates', files: [
        { name: 'missing.pdf', path: '/missing.pdf', source: 'command' },
      ], turnStartMs: null, turnEndMs: null }, message('error', 'error')], false);
    expect(proseIds(result)).toEqual(['file', 'explanation']);
    expect(allKeys(result)).toContain('msg-error');
  });

  it('confirmed generated output preserves sealed answers and does not suppress a later turn fallback', () => {
    const input: RenderItem[] = [message('u', 'user'), message('progress', 'assistant'), tool('t'),
      message('final', 'assistant', 'Finished', { turnCompleted: true }),
      { type: 'generated_files', key: 'files', files: [{ name: 'report.pdf', path: '/report.pdf', source: 'tool' }],
        turnStartMs: 1000, turnEndMs: 5000 },
      message('u2', 'user'), message('explanation', 'assistant'), tool('failed')];
    const result = simplifyBotRenderItems(groupWorkRuns(input, false), false, new Set(['files']));
    expect(proseIds(result)).toEqual(['final', 'explanation']);
    expect(shape(result)).toBe('msg-u, work-summary-t[msg-progress, work-t[tools-t]], msg-final, files, msg-u2, msg-explanation, work-failed[tools-failed]');
  });

  it('does not extend a final seal or delivery fallback across a history gap without tools', () => {
    const first = message('legacy', 'assistant', 'Earlier answer', { createdAt: '2026-07-23T16:31:00Z' });
    const last = message('sealed', 'assistant', 'Latest answer', {
      createdAt: '2026-07-25T15:29:33Z', turnCompleted: true,
    });
    expect(proseIds(project([first, last], true))).toEqual(['legacy', 'sealed']);
    const file = message('file', 'assistant', '', {
      createdAt: '2026-07-25T15:29:33Z', files: [{ name: 'report.pdf', path: '/report.pdf' }],
    });
    expect(proseIds(project([first, file], false))).toEqual(['legacy', 'file']);
  });

  it('does not infer commentary from words, paragraph length or markdown shape', () => {
    const text = '# Report\n' + '先查市场 final result '.repeat(100);
    const input = [message('u', 'user'), message('long', 'assistant', text), tool('t'),
      message('answer', 'assistant', '先安装')];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['long', 'answer']);
    expect(allKeys(result)).toContain('msg-long');
  });

  it('keeps completed answers across continuation tools, synthetic triggers and real user turns', () => {
    const input = [message('u', 'user'), message('sealed', 'assistant', 'Done', { turnCompleted: true }),
      tool('t'), message('trigger', 'user', '', { isSyntheticTrigger: true }),
      message('continuing', 'assistant'), tool('t2'), message('u2', 'user'), message('new', 'assistant')];
    const result = project(input, true);
    expect(proseIds(result)).toEqual(['sealed', 'continuing', 'new']);
    expect(allKeys(result)).not.toContain('msg-trigger');
  });

  it('keeps authorization, questions, errors, attachments and tool deliveries while running', () => {
    const cards: RenderItem[] = [
      message('auth', 'assistant', '', { systemCardType: 'bot-authorization' }),
      message('ask', 'ask_user', 'Which?', { askUserStatus: 'answered' }),
      message('err', 'error'),
      message('file', 'assistant', '', { files: [{ name: 'report.pdf', path: '/report.pdf' }] }),
      message('picture', 'assistant', '![Image](/picture.png)'),
      { type: 'tool_media', key: 'media', items: [{ kind: 'image', url: '/generated.png' }] },
      { type: 'generated_files', key: 'files', files: [], turnStartMs: null, turnEndMs: null },
    ];
    const result = project([message('u', 'user'), ...cards, tool('later')], true);
    for (const card of cards) expect(result.some((item) => item.key === card.key)).toBe(true);
  });

  it('drops empty avatar rows but keeps thinking inside the work fold without changing stored content', () => {
    const thinking = message('private', 'thinking', 'Not public execution');
    const input: RenderItem[] = [message('u', 'user'), message('empty', 'assistant', '  '),
      { type: 'work_group', key: 'work-nested', isStreaming: false, children: [thinking, tool('t')] },
      message('answer', 'assistant')];
    expect(shape(project(input, false))).toBe('msg-u, work-nested[msg-private, tools-t], msg-answer');
    expect(thinking).toEqual(message('private', 'thinking', 'Not public execution'));
  });

  it('preserves a finished turn\'s lazy history without eagerly calling expansion or retry', () => {
    const deferred = { owner: {}, key: 'range', expanded: false, loading: false, failed: false,
      toggle: vi.fn(), retry: vi.fn(), setVisible: vi.fn() };
    const group: RenderItem = { type: 'work_group', key: 'work-history', isStreaming: false,
      children: [], deferred };
    const input = [message('u', 'user'), group, message('final', 'assistant')];
    const unloaded = simplifyBotRenderItems(input, false);
    expect(shape(unloaded)).toBe('msg-u, work-history[], msg-final');
    expect(unloaded).toContain(group);
    const loaded = { ...group, children: [message('thinking', 'thinking'), message('public', 'assistant'), tool('t')] };
    const result = simplifyBotRenderItems([input[0], loaded as RenderItem, input[2]], false);
    expect(shape(result)).toBe('msg-u, work-history[msg-thinking, msg-public, tools-t], msg-final');
    expect(deferred.toggle).not.toHaveBeenCalled();
    expect(deferred.retry).not.toHaveBeenCalled();
    expect(group.deferred).toBe(deferred);
  });

  it('keeps deferred history controls while the turn runs when lifting a reply after one nested work group', () => {
    const deferred = { owner: {}, key: 'range', expanded: false, loading: false, failed: true,
      previewComplete: false, toggle: vi.fn(), retry: vi.fn(), setVisible: vi.fn() };
    const nested: RenderItem = { type: 'work_group', key: 'work-inner', isStreaming: false, children: [tool('t')] };
    const reply = message('delivered', 'assistant', 'Here is the result', { explicitDelivery: true });
    const history: RenderItem = { type: 'work_group', key: 'work-history', isStreaming: false, children: [nested, reply], deferred };
    const result = simplifyBotRenderItems([history], true);
    expect(shape(result)).toBe('work-history[work-inner[tools-t]], msg-delivered');
    const retained = result[0];
    expect(retained.type === 'work_group' && retained.deferred).toBe(deferred);
    expect(result[1]).toBe(reply);
    expect(deferred.setVisible).not.toHaveBeenCalled();
    expect(deferred.retry).not.toHaveBeenCalled();
    expect(history.children).toEqual([nested, reply]);
    // Ordinary complete groups still unwrap the single inner group with its stable key.
    const complete = simplifyBotRenderItems([{ ...history, deferred: undefined }], true);
    expect(complete).toEqual([nested, reply]);
  });

  it('shows a running turn as a live work group and preserves its fold beside the finished answer', () => {
    const at = (offset: number) => new Date(Date.parse('2026-10-15T08:00:00Z') + offset).toISOString();
    const running = [message('u', 'user', 'Fix it', { createdAt: at(0) }),
      message('think', 'thinking', 'Looking at refresh', { createdAt: at(1000) }),
      { ...tool('read'), toolCalls: [{ ...tool('read').toolCalls[0], createdAt: at(2000) }] }];
    const live = project(running, true);
    expect(shape(live)).toBe('msg-u, work-think*[msg-think, tools-read]');
    const liveGroup = live[1];
    expect(liveGroup.type === 'work_group' && liveGroup.startedAtMs).toBe(Date.parse(at(0)));

    const finished = project([...running,
      message('answer', 'assistant', 'Done', { createdAt: at(9000), turnCompleted: true })], false);
    expect(shape(finished)).toBe('msg-u, work-think[msg-think, tools-read], msg-answer');
    expect(proseIds(finished)).toEqual(['answer']);
  });

  it('splits a folded summary around an explicitly delivered reply and keeps the original key first', () => {
    const at = (offset: number) => new Date(Date.parse('2026-10-15T08:00:00Z') + offset).toISOString();
    const summary: RenderItem = { type: 'work_group', key: 'work-summary-x', isStreaming: false,
      startedAtMs: Date.parse(at(0)), durationMs: 10_000, children: [
        message('note', 'assistant', 'Checking', { createdAt: at(1000) }),
        { type: 'work_group', key: 'work-a', isStreaming: false, children: [tool('a')] },
        message('told', 'assistant', 'Sent to the group', { createdAt: at(4000), explicitDelivery: true }),
        message('after', 'assistant', 'Continuing', { createdAt: at(6000) }),
        { type: 'work_group', key: 'work-b', isStreaming: false, children: [tool('b')] },
      ] };
    // While the turn still runs its work stays visible, split around the delivered reply.
    const result = simplifyBotRenderItems([message('u', 'user'), summary,
      message('final', 'assistant', 'Final', { turnCompleted: true })], true);
    expect(shape(result)).toBe('msg-u, work-summary-x[msg-note, work-a[tools-a]], msg-told, '
      + 'work-summary-x~msg-after[msg-after, work-b[tools-b]], msg-final');
    const [first, , second] = result.slice(1);
    expect(first.type === 'work_group' && [first.startedAtMs, first.durationMs]).toEqual([Date.parse(at(0)), 4000]);
    expect(second.type === 'work_group' && [second.startedAtMs, second.durationMs]).toEqual([Date.parse(at(4000)), 6000]);
  });
});

it('keeps appended result receipts visible while the teammate is busy, across hidden wakeups', () => {
  const input = [message('old-card', 'assistant', '', { systemCardType: 'bot-session-task' }),
    message('new-input', 'user'),
    message('result-1', 'assistant', '', { systemCardType: 'bot-session-task-result' }),
    message('wake', 'user', '', { isSyntheticTrigger: true }),
    message('result-2', 'assistant', '', { systemCardType: 'bot-session-task-result' }),
    message('working', 'assistant')];
  const result = project(input, true);
  expect(result.filter(item => item.type === 'message' && item.message.systemCardType === 'bot-session-task-result').map(item => item.key))
    .toEqual(['msg-result-1', 'msg-result-2']);
});

it('nests only explicitly bound results, preserving original anchor and human message order', () => {
  const card = { v: 1 as const, role: 'delegation-result' as const, delegationId: 'job', fromBotId: 'bot',
    fromBotName: 'Cindy', toBotId: null, toBotName: '', parentSessionId: 'chat', childSessionId: 'child', objective: 'Report',
    result: { runSequence: 1, status: 'completed' as const, text: 'Report contents', artifacts: [] } };
  const receipt = message('receipt', 'assistant', '', { systemCardType: 'bot-session-task-result', systemCardData: card });
  const anchor = message('anchor', 'assistant', '', { systemCardType: 'bot-session-task' });
  const final = message('final', 'assistant', 'Summary', { turnCompleted: true, botTaskResults: [card] });
  const input = [anchor, receipt, message('human', 'user'), message('progress', 'assistant'), tool('t'), final];
  expect(shape(project(input, false))).toBe('msg-anchor, msg-human, work-summary-t[msg-progress, work-t[tools-t]], msg-final');
  expect(final.message.botTaskResults).toEqual([card]);
  expect(allKeys(project(input.slice(0, -1), false))).toContain('msg-receipt');
  expect(allKeys(project([receipt, message('unrelated', 'assistant', 'Other', { turnCompleted: true })], false))).toContain('msg-receipt');
  expect(input[1]).toBe(receipt);
});

it('keeps explicitly delivered group private messages while the private model is working and after another reply', () => {
  const input = [message('u', 'user'), message('group', 'assistant', 'Group reply', { sourceGroup: { groupId: 'g-1' } }),
    message('progress', 'assistant', 'Working'), tool('running')];
  expect(proseIds(project(input, true))).toEqual(['group', 'progress']);
  expect(proseIds(project([...input, message('final', 'assistant', 'Result', { turnCompleted: true })], false))).toEqual(['group', 'final']);
});


describe('provider final streaming', () => {
  it('keeps incremental final text and its contiguous prose visible like ordinary tasks', () => {
    const prefix = [message('u', 'user'), message('process', 'assistant', 'Internal', { assistantPhase: 'commentary' })];
    for (const text of ['A', 'Answer', 'Answer with a reference']) {
      const final = message('answer', 'assistant', text, { assistantPhase: 'final_answer', isStreaming: true });
      expect(proseIds(project([...prefix, final], true))).toEqual(['process', 'answer']);
      expect(proseIds(project([...prefix, { ...final, message: { ...final.message, isStreaming: false } }], true))).toEqual(['process', 'answer']);
    }
    for (const streaming of [false, true]) {
      const completed = project([...prefix, message('answer', 'assistant', 'Answer', { assistantPhase: 'final_answer', turnCompleted: true })], streaming);
      expect(proseIds(completed)).toEqual(['answer']);
      expect(allKeys(completed)).toContain('msg-process');
      expect(completed.find(item => item.type === 'work_group')).toMatchObject({ isStreaming: false });
    }
  });
});

it('does not insert interleaved valid receipts ahead of live final prose and preserves exact host bindings', () => {
  const card = (id: string) => ({ v: 1 as const, role: 'delegation-result' as const, delegationId: id, fromBotId: 'bot',
    fromBotName: 'Cindy', toBotId: null, toBotName: '', parentSessionId: 'chat', childSessionId: id, objective: id,
    result: { runSequence: 1, status: 'completed' as const, text: 'Report', artifacts: [] } });
  const a = card('a'), b = card('b');
  const receipt = (id: string, data: ReturnType<typeof card>) => message(id, 'assistant', '', { systemCardType: 'bot-session-task-result', systemCardData: data });
  const streaming = message('answer', 'assistant', 'First words', { assistantPhase: 'final_answer', isStreaming: true });
  const input = [message('u', 'user'), streaming, receipt('b-result', b), receipt('a-result', a)];
  expect(allKeys(project(input, true))).toEqual(['msg-u', 'msg-answer']);
  const ended = { ...streaming, message: { ...streaming.message, isStreaming: false, turnCompleted: true, botTaskResults: [a] } };
  const visible = project([input[0], ended, ...input.slice(2)], false);
  expect(allKeys(visible)).toEqual(['msg-u', 'msg-answer', 'msg-b-result']);
  expect(ended.message.botTaskResults.map(value => value.childSessionId)).toEqual(['a']);
  // No final reply: every frozen result has a lightweight fallback once execution settles.
  expect(allKeys(project(input.slice(2), false))).toEqual(['msg-b-result', 'msg-a-result']);
});

it('keeps an unanswered historical receipt visible while the next user turn streams', () => {
  const data = { v: 1, role: 'delegation-result', delegationId: 'd', fromBotId: 'b',
    fromBotName: 'Cindy', toBotId: null, toBotName: '', parentSessionId: 'chat', childSessionId: 'child', objective: 'Task',
    result: { runSequence: 1, status: 'completed', text: 'Report', artifacts: [] } };
  const receipt = message('receipt', 'assistant', '', { systemCardType: 'bot-session-task-result', systemCardData: data });
  const history = [message('old-user', 'user'), receipt];
  expect(allKeys(project(history, false))).toContain('msg-receipt');
  const next = [...history, message('next-user', 'user'),
    message('next-answer', 'assistant', 'First words', { assistantPhase: 'final_answer', isStreaming: true })];
  expect(allKeys(project(next, true))).toEqual(['msg-old-user', 'msg-receipt', 'msg-next-user', 'msg-next-answer']);
});

it('keeps streaming component answers visible through commentary and later tools', () => {
  const body = '```cindy-ui\n' + JSON.stringify({ seq: 1, op: 'create', id: 'heading', kind: 'heading', props: { text: 'Result' } }) + '\n';
  const rows = [message('u', 'user'), message('rich', 'assistant', body, { assistantPhase: 'commentary', isStreaming: true }), tool('later')];
  expect(proseIds(project(rows, true))).toContain('rich');
  expect(rows[1].type === 'message' && rows[1].message.content).toBe(body);
});

// User-approved journal: the production entry must retain its identity through the
// first tool, commentary, engine switch and final seal; ordinary task grouping is unchanged.
describe('continuous teammate process', () => {
  it('keeps the journal openable when an opaque history group loads before its user row', () => {
    const empty: Extract<RenderItem, { type: 'work_group' }> = { type: 'work_group', key: 'work-summary-older', children: [], isStreaming: false,
      deferred: { key: 'older', owner: 'lane', expanded: false, loading: false, failed: false, toggle() {}, retry() {} } as never };
    const loaded: RenderItem = { ...empty, children: [tool('older')] };
    expect(botProcessItems([empty], false)[0]?.key).toBe(botProcessItems([loaded], false)[0]?.key);
  });
  it('keeps one stable disclosure and leaves the final reply outside', async () => {
    const user = message('journal-user', 'user');
    const first = tool('first');
    const note = message('note', 'assistant', 'Found the cause', { assistantPhase: 'commentary' });
    const switched = message('switch', 'assistant', '', { systemCardType: 'agent-switch' });
    const stages = [[user, first], [user, first, note], [user, first, note, switched, tool('verify')]];
    const keys = stages.map(rows => {
      const result = botProcessItems(groupWorkRuns(rows, true), true);
      const groups = result.filter(item => item.type === 'work_group');
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ teammateJournal: true, isStreaming: true });
      return groups[0]!.key;
    });
    const done = botProcessItems(groupWorkRuns([...stages[2]!, message('final', 'assistant', 'Fixed and verified', { turnCompleted: true })], false), false);
    expect(done[1]?.key).toBe(keys[0]);
    expect(new Set(keys).size).toBe(1);
    expect(proseIds(done)).toEqual(['final']);
    expect(allKeys(done)).toEqual(expect.arrayContaining(['tools-first', 'msg-note', 'msg-switch', 'tools-verify']));
  });
  it('does not swallow an addressed answer or merge two user turns', async () => {
    const rows = [message('u1', 'user'), tool('one'), message('intro', 'assistant', 'Introduction'),
      message('final1', 'assistant', 'Answer', { turnCompleted: true }), message('u2', 'user'), tool('two')];
    const result = botProcessItems(groupWorkRuns(rows, true), true);
    expect(proseIds(result)).toEqual(['intro', 'final1']);
    expect(result.filter(item => item.type === 'work_group')).toHaveLength(2);
  });
});

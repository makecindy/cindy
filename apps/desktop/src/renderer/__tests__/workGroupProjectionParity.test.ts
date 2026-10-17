import { describe, expect, it } from 'vitest';
import {
  buildMessageRenderItems,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
} from '@cindy/maker-shared/message-render';
import { groupWorkRuns, type RenderItem } from '../components/chat/messageWorkGroups';
import { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';
import { CONTINUE_AFTER_APP_EXIT_PROMPT, CONTINUE_AFTER_ERROR_PROMPT, syntheticTriggerKind } from '@cindy/maker-shared/synthetic-trigger';

/** One event fixture feeds both projections; only platform item representations differ. */
interface Event {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'compact' | 'agent' | 'error';
  at: number;
  body?: string;
  end?: number;
  sealed?: boolean;
  autoResume?: boolean;
  delivery?: 'steer' | 'turn';
}

const iso = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const user = (id = 'u', at = 0): Event => ({ id, at, kind: 'user', body: 'Run' });
const answer = (id: string, at: number, sealed = false, body = 'Reply'): Event => ({
  id,
  at,
  kind: 'assistant',
  body,
  sealed,
});
const tool = (id: string, at: number, end = at): Event => ({ id, at, end, kind: 'tool' });
const thinking = (id: string, at: number, end = at): Event => ({ id, at, end, kind: 'thinking' });

function desktopItems(events: readonly Event[]): RenderItem[] {
  return events.map((event): RenderItem => {
    if (event.kind === 'agent')
      return {
        type: 'agent_task',
        key: event.id,
        toolCall: {
          clientId: event.id,
          role: 'tool_use',
          content: '',
          createdAt: iso(event.at),
          toolName: 'Agent',
        },
      };
    if (event.kind === 'tool') {
      return {
        type: 'tool_segment',
        key: event.id,
        toolCalls: [
          {
            clientId: event.id,
            role: 'tool_use',
            content: '',
            createdAt: iso(event.at),
            toolName: 'Read',
          },
        ],
        resultMap: new Map([[event.id, 'ok']]),
        settledIds: new Set([event.id]),
        resultTsMap: new Map([[event.id, Date.UTC(2026, 0, 1) + (event.end ?? event.at) * 1000]]),
      };
    }
    return {
      type: 'message',
      key: event.id,
      message: {
        clientId: event.id,
        role: event.kind === 'compact' ? 'assistant' : event.kind,
        content: event.body ?? (event.kind === 'thinking' ? 'Thinking' : ''),
        ...(event.kind === 'user' && syntheticTriggerKind(event.body ?? '') !== null
          ? { content: '', isSyntheticTrigger: true, isContinuationTrigger: syntheticTriggerKind(event.body ?? '') === 'continue' }
          : {}),
        createdAt: iso(event.at),
        turnCompleted: event.sealed,
        delivery: event.delivery,
        ...(event.autoResume ? { systemCardType: 'auto-resume' as const } : {}),
        ...(event.kind === 'compact' ? { systemCardType: 'compact' as const } : {}),
        ...(event.kind === 'thinking'
          ? { thinkingDurationMs: ((event.end ?? event.at) - event.at) * 1000 }
          : {}),
      },
    };
  });
}

function normalized(events: readonly Event[]): MessageRenderNormalizedMessage[] {
  return events.map((event) => ({
    key: event.id,
    kind: event.kind === 'compact' || event.kind === 'error' ? 'system' : event.kind === 'agent' ? 'tool' : event.kind,
    label: event.kind === 'compact' ? 'system:compact' : event.kind,
    body: event.body ?? (event.kind === 'thinking' ? 'Thinking' : ''),
    createdAt: iso(event.at),
    turnCompleted: event.sealed,
    settledAt: event.end === undefined ? undefined : iso(event.end),
    source: {
      clientId: event.id,
      role: event.kind,
      agentMeta: { autoResume: event.autoResume, delivery: event.delivery },
      createdAt: iso(event.at),
      content:
        event.kind === 'thinking'
          ? { thinking: 'Thinking', durationMs: ((event.end ?? event.at) - event.at) * 1000 }
          : event.kind === 'tool' || event.kind === 'agent'
            ? { toolName: event.kind === 'agent' ? 'Agent' : 'Read', input: {} }
            : event.body,
    },
  }));
}

interface Projection {
  key?: string;
  durationMs?: number;
  startedAtMs?: number;
  streaming?: boolean;
  children?: Projection[];
  ids?: string[];
}

function desktopProjection(items: readonly RenderItem[]): Projection[] {
  return items.map((item) => {
    if (item.type === 'work_group')
      return {
        key: item.key,
        durationMs: item.durationMs,
        startedAtMs: item.startedAtMs,
        streaming: item.isStreaming,
        children: desktopProjection(item.children),
      };
    if (item.type === 'tool_segment') return { ids: item.toolCalls.map((call) => call.clientId) };
    if (item.type === 'message') return { ids: [item.message.clientId] };
    if (item.type === 'agent_task') return { ids: [item.toolCall!.clientId] };
    throw new Error(`Unexpected fixture item: ${item.type}`);
  });
}

function sharedProjection(items: readonly MessageRenderItem[]): Projection[] {
  return items.map((item) => {
    if (item.type === 'work_group')
      return {
        key: item.key,
        durationMs: item.durationMs,
        startedAtMs: item.startedAtMs,
        streaming: item.isStreaming,
        children: sharedProjection(item.children),
      };
    if (item.type === 'tool_group') return { ids: item.tools.map((call) => call.source.clientId!) };
    if (item.type === 'message' || item.type === 'thinking')
      return { ids: [item.message.source.clientId!] };
    if (item.type === 'agent_task') return { ids: [item.toolCall!.source.clientId!] };
    throw new Error(`Unexpected fixture item: ${item.type}`);
  });
}

/** Compact expectations pin grouping independently of agreement between two consumers. */
function tree(items: readonly Projection[]): unknown[] {
  return items.map((item) => (item.children ? [item.key, tree(item.children)] : item.ids));
}

const cases: Array<{ name: string; events: Event[]; streaming?: boolean; expected: unknown[] }> = [
  {
    name: 'running subagent remains visible between completed work groups',
    events: [
      user(),
      thinking('before', 1),
      { id: 'agent', kind: 'agent', at: 2 },
      thinking('after', 3),
      answer('final', 4, true),
    ],
    expected: [
      ['u'],
      ['work-before', [['before']]],
      ['agent'],
      ['work-after', [['after']]],
      ['final'],
    ],
  },
  {
    name: 'completed work nests progress but retains the final answer',
    events: [
      user(),
      thinking('think', 1, 2),
      answer('progress', 3),
      tool('read', 4, 5),
      answer('final', 6),
    ],
    expected: [
      ['u'],
      [
        'work-summary-think',
        [['work-think', [['think']]], ['progress'], ['work-read', [['read']]]],
      ],
      ['final'],
    ],
  },
  {
    name: 'active text closes a group and only the trailing activity stays live',
    streaming: true,
    events: [user(), thinking('think', 1, 2), answer('progress', 3), tool('read', 4, 5)],
    expected: [['u'], ['work-think', [['think']]], ['progress'], ['work-read', [['read']]]],
  },
  {
    name: 'compact closes the preceding live activity',
    streaming: true,
    events: [
      user(),
      tool('read', 1, 2),
      { id: 'compact', kind: 'compact', at: 3 },
      thinking('think', 4),
    ],
    expected: [['u'], ['work-read', [['read']]], ['compact'], ['work-think', [['think']]]],
  },
  {
    name: 'only the last seal stays final; earlier short seals fold through continuation',
    events: [
      user(),
      tool('read', 1, 2),
      answer('part1', 3),
      answer('part2', 4, true),
      thinking('next', 5),
      answer('final', 6, true),
    ],
    expected: [
      ['u'],
      [
        'work-summary-read',
        [['work-read', [['read']]], ['part1'], ['part2'], ['work-next', [['next']]]],
      ],
      ['final'],
    ],
  },
  {
    name: 'an earlier seal keeps its intro together with the delivery report',
    events: [
      user(),
      tool('read', 1, 2),
      answer('intro', 3),
      answer('report', 4, true, '# Report\nThe result'),
      thinking('next', 5),
      answer('final', 6, true),
    ],
    expected: [
      ['u'],
      ['work-read', [['read']]],
      ['intro'],
      ['report'],
      ['work-next', [['next']]],
      ['final'],
    ],
  },
  {
    name: 'an earlier delivery-prose seal stays visible through continuation',
    events: [
      user(),
      tool('read', 1, 2),
      answer('report', 3, true, '# Report\nThe result'),
      thinking('next', 4),
      answer('final', 5, true),
    ],
    expected: [['u'], ['work-read', [['read']]], ['report'], ['work-next', [['next']]], ['final']],
  },
  {
    name: 'legacy text followed by more work remains a visible boundary',
    events: [user(), tool('read', 1, 2), answer('progress', 3), thinking('next', 4)],
    expected: [['u'], ['work-read', [['read']]], ['progress'], ['work-next', [['next']]]],
  },
  {
    name: 'delivery prose remains visible before cleanup work',
    events: [
      user(),
      thinking('think', 1),
      answer('report', 2, false, '# Report\nThe result'),
      tool('cleanup', 3),
      answer('final', 4),
    ],
    expected: [
      ['u'],
      ['work-think', [['think']]],
      ['report'],
      ['work-cleanup', [['cleanup']]],
      ['final'],
    ],
  },
  {
    name: 'unloaded history splits groups and discards the old user duration anchor',
    events: [user(), tool('head', 1, 2), thinking('tail', 4000, 4001), answer('final', 4002)],
    expected: [['u'], ['work-head', [['head']]], ['work-tail', [['tail']]], ['final']],
  },
  {
    name: 'long tool result prevents a false history gap',
    events: [user(), answer('progress', 1), tool('build', 2, 4000), answer('final', 4001)],
    expected: [
      ['u'],
      ['work-summary-build', [['progress'], ['work-build', [['build']]]]],
      ['final'],
    ],
  },
  {
    name: 'parallel completion does not move the end anchor backwards',
    events: [user(), thinking('long', 1, 4000), thinking('short', 2, 3), answer('final', 4001)],
    expected: [['u'], ['work-long', [['long'], ['short']]], ['final']],
  },
  {
    name: 'truncated history uses the first activity as its duration anchor',
    events: [thinking('think', 1, 2), answer('progress', 3), tool('read', 4), answer('final', 5)],
    expected: [
      [
        'work-summary-think',
        [['work-think', [['think']]], ['progress'], ['work-read', [['read']]]],
      ],
      ['final'],
    ],
  },
  {
    name: 'new user boundary seals previous work even while the last turn is streaming',
    streaming: true,
    events: [user(), thinking('old', 1), user('u2', 2), thinking('new', 3)],
    expected: [['u'], ['work-old', [['old']]], ['u2'], ['work-new', [['new']]]],
  },
];

describe('desktop and shared/mobile work grouping projection', () => {
  it.each([false, true])('applies the history gap before recovery boundaries (streaming=%s)', (streaming) => {
    const threshold = HISTORY_GAP_SPLIT_MS / 1000;
    for (const autoResume of [false, true]) {
      for (const gap of [threshold - 1, threshold, threshold + 1]) {
        const events = [user(), tool('read', 1), answer('reply', 2, true),
          { ...user('resume', 2 + gap), body: CONTINUE_AFTER_ERROR_PROMPT, autoResume }, answer('active', 3 + gap)];
        const desktop = desktopProjection(groupWorkRuns(desktopItems(events), streaming));
        expect(sharedProjection(buildMessageRenderItems(normalized(events), { isSessionStreaming: streaming }))).toEqual(desktop);
        expect(tree(desktop)).toEqual(gap > threshold
          ? [['u'], ['work-read', [['read']]], ['reply'], ['resume'], ['active']]
          : [['u'], ['work-summary-read', [['work-read', [['read']]], ['reply']]], ['resume'], ['active']]);
      }
    }
    // A long-running tool's result is the anchor, not its start time.
    const events = [user(), answer('progress', 1), tool('long', 2, threshold * 2),
      { ...user('resume', threshold * 2 + 1), body: CONTINUE_AFTER_ERROR_PROMPT }];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), streaming));
    expect(sharedProjection(buildMessageRenderItems(normalized(events), { isSessionStreaming: streaming }))).toEqual(desktop);
    expect(tree(desktop)).toEqual([
      ['u'], ['work-summary-long', [['progress'], ['work-long', [['long']]]]], ['resume'],
    ]);
  });

  it.each([false, true])('folds the whole recovered turn across visible steer rows (streaming=%s)', (streaming) => {
    const events: Event[] = [user(), answer('before', 1), tool('first', 2),
      { ...user('steer1', 3), delivery: 'steer' }, answer('middle', 4),
      { ...user('steer2', 5), delivery: 'steer' }, tool('last', 6),
      { ...user('resume', 7), body: CONTINUE_AFTER_ERROR_PROMPT }, answer('active', 8)];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), streaming));
    expect(sharedProjection(buildMessageRenderItems(normalized(events), { isSessionStreaming: streaming }))).toEqual(desktop);
    expect(tree(desktop)).toEqual([
      ['u'], ['work-summary-first', [['before'], ['work-first', [['first']]]]],
      ['steer1'], ['work-summary-middle', [['middle']]], ['steer2'], ['work-last', [['last']]],
      ['resume'], ['active'],
    ]);
    const ordinary = events.map(event => event.id === 'steer1' ? { ...event, delivery: 'turn' as const } : event);
    const split = desktopProjection(groupWorkRuns(desktopItems(ordinary), streaming));
    expect(sharedProjection(buildMessageRenderItems(normalized(ordinary), { isSessionStreaming: streaming }))).toEqual(split);
    expect(tree(split).slice(0, 4)).toEqual([['u'], ['before'], ['work-first', [['first']]], ['steer1']]);
  });

  it.each([false, true])('folds short seals before recovery but preserves delivery runs (streaming=%s)', (streaming) => {
    const events = [user(), tool('read', 1), answer('intro', 2),
      answer('report', 3, true, '# Report\nThe result'), thinking('next', 4),
      answer('waiting', 5, true), tool('retry', 6),
      { ...user('resume', 7), body: CONTINUE_AFTER_ERROR_PROMPT }];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), streaming));
    expect(sharedProjection(buildMessageRenderItems(normalized(events), { isSessionStreaming: streaming }))).toEqual(desktop);
    expect(tree(desktop)).toEqual([
      ['u'], ['work-read', [['read']]], ['intro'], ['report'],
      ['work-summary-next', [['work-next', [['next']]], ['waiting'], ['work-retry', [['retry']]]]], ['resume'],
    ]);
    const lastSealIsDelivery = [...events.slice(0, 4), events.at(-1)!];
    const delivery = desktopProjection(groupWorkRuns(desktopItems(lastSealIsDelivery), streaming));
    expect(sharedProjection(buildMessageRenderItems(normalized(lastSealIsDelivery), { isSessionStreaming: streaming }))).toEqual(delivery);
    expect(tree(delivery)).toEqual([['u'], ['work-read', [['read']]], ['intro'], ['report'], ['resume']]);
  });

  it.each([
    { body: CONTINUE_AFTER_ERROR_PROMPT },
    { body: CONTINUE_AFTER_APP_EXIT_PROMPT },
    { body: `${CONTINUE_AFTER_ERROR_PROMPT}\n\n[CINDY_RECOVERY_CHECKPOINT v1]\nattempt 2` },
    { body: 'Continue', autoResume: true },
  ])('folds interrupted progress across recovery: %j', (continuation) => {
    const events: Event[] = [
      user(), answer('progress', 1), tool('read', 2, 3),
      { id: 'error', kind: 'error', at: 4, body: 'Usage limit reached' },
      { ...user('resume', 5), ...continuation },
      answer('resuming', 6), thinking('next', 7), answer('final', 8, true),
    ];
    for (const streaming of [true, false]) {
      const input = streaming ? events.slice(0, -1) : events;
      const desktop = desktopProjection(groupWorkRuns(desktopItems(input), streaming));
      const shared = sharedProjection(buildMessageRenderItems(normalized(input), { isSessionStreaming: streaming }));
      expect(shared).toEqual(desktop);
      expect(tree(desktop).slice(0, 4)).toEqual([
        ['u'], ['work-summary-read', [['progress'], ['work-read', [['read']]]]],
        ['error'], ['resume'],
      ]);
      expect(desktop[1].streaming).toBe(false);
      expect(tree(desktop).slice(4)).toEqual(streaming
        ? [['resuming'], ['work-next', [['next']]]]
        : [['work-summary-next', [['resuming'], ['work-next', [['next']]]]], ['final']]);
    }
  });

  it('folds a prose-only interrupted attempt without mistaking it for a final answer', () => {
    const events: Event[] = [user(), answer('progress', 1),
      { ...user('resume', 2), body: CONTINUE_AFTER_ERROR_PROMPT }, answer('final', 3, true)];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), false));
    expect(sharedProjection(buildMessageRenderItems(normalized(events)))).toEqual(desktop);
    expect(tree(desktop)).toEqual([
      ['u'], ['work-summary-progress', [['progress']]], ['resume'], ['final'],
    ]);
  });

  it.each(['Another task', '[UI_ACTION_TRIGGER] regenerate the image'])('keeps ordinary boundaries unchanged: %s', (body) => {
    const events: Event[] = [user(), answer('progress', 1), tool('read', 2),
      { ...user('other', 3), body }, answer('final', 4, true)];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), false));
    expect(sharedProjection(buildMessageRenderItems(normalized(events)))).toEqual(desktop);
    expect(tree(desktop)).toEqual([
      ['u'], ['progress'], ['work-read', [['read']]], ['other'], ['final'],
    ]);
  });

  it.each(cases)('$name', ({ events, streaming = false, expected }) => {
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), streaming));
    const shared = sharedProjection(
      buildMessageRenderItems(normalized(events), { isSessionStreaming: streaming }),
    );
    expect(tree(desktop)).toEqual(expected);
    expect(shared).toEqual(desktop);
  });

  it('keeps inner group keys when an active timeline is completed or history is prepended', () => {
    const events = [
      user(),
      thinking('think', 1, 2),
      answer('progress', 3),
      tool('read', 4, 5),
      answer('final', 6),
    ];
    for (const project of [
      (input: Event[], active: boolean) =>
        desktopProjection(groupWorkRuns(desktopItems(input), active)),
      (input: Event[], active: boolean) =>
        sharedProjection(
          buildMessageRenderItems(normalized(input), { isSessionStreaming: active }),
        ),
    ]) {
      const keys = (items: Projection[]): string[] =>
        items.flatMap((item) => (item.children ? [item.key!, ...keys(item.children)] : []));
      const activeKeys = keys(project(events.slice(0, -1), true));
      const completedKeys = keys(project(events, false));
      expect(completedKeys).toEqual(expect.arrayContaining(activeKeys));
      expect(
        keys(project([user('older', -10), answer('older-reply', -9), ...events], false)),
      ).toEqual(completedKeys);
    }
  });

  it('preserves the existing platform policies for a user timestamp behind earlier activity', () => {
    const events = [
      thinking('old', 1, 4000),
      user('reordered', 2),
      thinking('next', 2000, 2001),
      answer('final', 2002),
    ];
    const desktop = desktopProjection(groupWorkRuns(desktopItems(events), false));
    const shared = sharedProjection(buildMessageRenderItems(normalized(events)));
    expect(desktop.find((item) => item.key === 'work-next')?.durationMs).toBe(2000);
    expect(shared.find((item) => item.key === 'work-next')?.durationMs).toBe(2000000);
  });
});

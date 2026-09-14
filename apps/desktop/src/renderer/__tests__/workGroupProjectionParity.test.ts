import { describe, expect, it } from 'vitest';
import {
  buildMessageRenderItems,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
} from '@cindy/maker-shared/message-render';
import { groupWorkRuns, type RenderItem } from '../components/chat/messageWorkGroups';

/** One event fixture feeds both projections; only platform item representations differ. */
interface Event {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'compact' | 'agent';
  at: number;
  body?: string;
  end?: number;
  sealed?: boolean;
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
        createdAt: iso(event.at),
        turnCompleted: event.sealed,
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
    kind: event.kind === 'compact' ? 'system' : event.kind === 'agent' ? 'tool' : event.kind,
    label: event.kind === 'compact' ? 'system:compact' : event.kind,
    body: event.body ?? (event.kind === 'thinking' ? 'Thinking' : ''),
    createdAt: iso(event.at),
    turnCompleted: event.sealed,
    settledAt: event.end === undefined ? undefined : iso(event.end),
    source: {
      clientId: event.id,
      role: event.kind,
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
    name: 'each seal retains its contiguous final prose through continuation',
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
      ['work-read', [['read']]],
      ['part1'],
      ['part2'],
      ['work-next', [['next']]],
      ['final'],
    ],
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

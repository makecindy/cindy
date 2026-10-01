import { describe, expect, it, vi } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '@/components/chat/MessageStream';
import {
  createMessageMetadataProjection,
  createStreamingMessageProjection,
  createWorkGroupProjection,
  createStreamingWorkGroupProjection,
} from '@/components/chat/streamingMessageProjection';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { RenderItem } from '@/components/chat/messageWorkGroups';

function fixture(): ChatMessage[] {
  return [
    { clientId: 'u1', role: 'user', content: 'Inspect' },
    {
      clientId: 't1',
      role: 'tool_use',
      content: '',
      toolName: 'Read',
      toolUseId: 'tool-1',
      toolInput: { file_path: '/src/app.ts' },
    },
    { clientId: 'r1', role: 'tool_result', content: 'original result', toolUseId: 'tool-1' },
    { clientId: 'a1', role: 'assistant', content: 'Finished.', turnCompleted: true },
    { clientId: 'u2', role: 'user', content: 'Continue' },
    { clientId: 'a2', role: 'assistant', content: 'Starting', isStreaming: true },
  ];
}

function replaceTail(messages: ChatMessage[], change: Partial<ChatMessage>): ChatMessage[] {
  return [...messages.slice(0, -1), { ...messages[messages.length - 1], ...change }];
}

describe('streaming history projection', () => {
  it('matches the full builder while retaining completed history during text-only updates', () => {
    const project = createStreamingMessageProjection();
    const groups = createWorkGroupProjection();
    let messages = fixture();
    const build = vi.fn(() => buildRenderItems(messages));
    const first = project(messages, [], build);
    const firstGroups = groups(groupWorkRuns(first.items, true));
    for (const content of [
      'Starting now',
      '# A heading\n\nA table | value',
      '![image](https://example.com/a.png)',
      'Replaced rather than appended',
    ]) {
      messages = replaceTail(messages, { content });
      const actual = project(messages, [], build);
      expect(actual).toEqual(buildRenderItems(messages));
      expect(actual.singleResultMap).toBe(first.singleResultMap);
      expect(actual.items[0]).toBe(first.items[0]);
      const grouped = groups(groupWorkRuns(actual.items, true));
      expect(grouped).toEqual(groupWorkRuns(buildRenderItems(messages).items, true));
      expect(grouped.find((item) => item.type === 'work_group')).toBe(
        firstGroups.find((item) => item.type === 'work_group'),
      );
      expect(
        grouped.some((item) => item.type === 'message' && item.message.content === content),
      ).toBe(true);
    }
    expect(build).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'stream end',
      (rows: ChatMessage[]) =>
        replaceTail(rows, { content: 'Final', isStreaming: false, turnCompleted: true }),
    ],
    ['empty text', (rows: ChatMessage[]) => replaceTail(rows, { content: '  ' })],
    [
      'tool arrival',
      (rows: ChatMessage[]) => [
        ...rows,
        { clientId: 'new-tool', role: 'tool_use', content: '', toolName: 'Read' } as ChatMessage,
      ],
    ],
    [
      'late result correction',
      (rows: ChatMessage[]) =>
        rows.map((row) => (row.clientId === 'r1' ? { ...row, content: 'corrected' } : row)),
    ],
    [
      'prepend',
      (rows: ChatMessage[]) => [
        { clientId: 'older', role: 'user', content: 'Older' } as ChatMessage,
        ...rows,
      ],
    ],
    ['delete', (rows: ChatMessage[]) => rows.slice(1)],
    ['clear', () => [] as ChatMessage[]],
    ['metadata', (rows: ChatMessage[]) => replaceTail(rows, { model: 'different-model' })],
    ['identity', (rows: ChatMessage[]) => replaceTail(rows, { clientId: 'other' })],
    ['system card', (rows: ChatMessage[]) => replaceTail(rows, { systemCardType: 'compact' })],
  ] as const)('rebuilds on %s', (_name, change) => {
    const project = createStreamingMessageProjection();
    let messages = fixture();
    const build = vi.fn(() => buildRenderItems(messages));
    project(messages, [], build);
    messages = change(messages);
    expect(project(messages, [], build)).toEqual(buildRenderItems(messages));
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when external dependencies change or the caller uses a remote/bot history projection', () => {
    for (const allowTextReuse of [true, false]) {
      const project = createStreamingMessageProjection();
      let messages = fixture();
      const build = vi.fn(() => buildRenderItems(messages));
      const dependency = {};
      project(messages, [dependency], build, allowTextReuse);
      messages = replaceTail(messages, { content: 'Next' });
      project(messages, [allowTextReuse ? {} : dependency], build, allowTextReuse);
      expect(build).toHaveBeenCalledTimes(2);
    }
  });

  it('rebuilds when the tail was hidden instead of synthesizing a visible row', () => {
    const project = createStreamingMessageProjection();
    let messages = replaceTail(fixture(), { parentToolUseId: 'toolu_parent' });
    const build = vi.fn(() => buildRenderItems(messages));
    expect(
      project(messages, [], build).items.some(
        (item) => item.type === 'message' && item.message.clientId === 'a2',
      ),
    ).toBe(false);
    messages = replaceTail(messages, { content: 'Hidden update' });
    expect(project(messages, [], build)).toEqual(buildRenderItems(messages));
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('retains tool pairing and refreshes media suppression when the answer finishes', () => {
    const project = createStreamingMessageProjection();
    let messages = fixture();
    messages.splice(
      -1,
      0,
      {
        clientId: 'image-call',
        role: 'tool_use',
        content: '',
        toolName: 'make_image',
        toolUseId: 'image-tool',
      },
      {
        clientId: 'image-result',
        role: 'tool_result',
        content: '{"xdt_image_url":"https://example.com/a.png"}',
        toolUseId: 'image-tool',
      },
    );
    const build = () => buildRenderItems(messages);
    project(messages, [], build);
    messages = replaceTail(messages, { content: '![image](https://example.com/a.png)' });
    expect(project(messages, [], build)).toEqual(build());
    messages = replaceTail(messages, { isStreaming: false, turnCompleted: true });
    expect(project(messages, [], build)).toEqual(build());
  });
});

describe('metadata and work-group identity', () => {
  it('holds metadata steady only during plain text updates and releases it at completion', () => {
    const select = createMessageMetadataProjection();
    const rows = fixture();
    expect(select(rows)).toBe(rows);
    expect(select(replaceTail(rows, { content: 'Next' }))).toBe(rows);
    const done = replaceTail(rows, { content: 'Final', isStreaming: false });
    expect(select(done)).toBe(done);
    const withCost = replaceTail(done, { turnCostUsd: 1 });
    expect(select(withCost)).toBe(withCost);
  });

  it('keeps nested groups stable but updates changed duration, rows and removed groups', () => {
    const project = createWorkGroupProjection();
    const child: Extract<RenderItem, { type: 'work_group' }> = {
      type: 'work_group',
      key: 'inner',
      isStreaming: false,
      children: [],
      durationMs: 1,
    };
    const group: Extract<RenderItem, { type: 'work_group' }> = {
      type: 'work_group',
      key: 'outer',
      isStreaming: false,
      children: [child],
      durationMs: 2,
    };
    const [first] = project([group]);
    expect(project([{ ...group, children: [{ ...child, children: [] }] }])[0]).toBe(first);
    const changed = { ...group, children: [{ ...child, durationMs: 5 }] };
    expect(project([changed])[0]).toEqual(changed);
    expect(project([{ ...changed, durationMs: 8 }])[0]).not.toBe(first);
    project([]);
    expect(project([group])[0]).not.toBe(first);
  });
});

describe('incremental work-run grouping', () => {
  it.each(['new turn', 'resumed turn', 'active tools', 'history gap'])(
    '%s matches full grouping through delivery-prose changes',
    (scenario) => {
      const project = createStreamingMessageProjection();
      const fullGroup = vi.fn(groupWorkRuns);
      const group = createStreamingWorkGroupProjection(fullGroup);
      let messages = fixture();
      if (scenario === 'resumed turn') messages = messages.filter((row) => row.clientId !== 'u2');
      if (scenario === 'active tools' || scenario === 'history gap') {
        messages.splice(
          -1,
          0,
          { clientId: 'thinking', role: 'thinking', content: 'Checking', thinkingDurationMs: 1000 },
          {
            clientId: 'active-tool',
            role: 'tool_use',
            content: '',
            toolName: 'Read',
            toolUseId: 'call_active',
          },
          {
            clientId: 'active-result',
            role: 'tool_result',
            content: 'read result',
            toolUseId: 'call_active',
          },
        );
      }
      messages = messages.map((row, index) => ({
        ...row,
        createdAt: new Date(
          1_700_000_000_000 +
            index * 1000 +
            (scenario === 'history gap' && index === messages.length - 1 ? 3_600_000 : 0),
        ).toISOString(),
      }));
      const build = () => buildRenderItems(messages);
      const first = group(project(messages, [], build).items, true);
      for (const content of [
        'More text',
        '# Delivery\n\n' + 'Report. '.repeat(400),
        '![image](https://example.com/a.png)',
        'Short again',
      ]) {
        messages = replaceTail(messages, { content });
        const actual = group(project(messages, [], build).items, true);
        expect(actual).toEqual(groupWorkRuns(build().items, true));
        expect(actual.slice(0, -1).every((item, index) => item === first[index])).toBe(true);
        expect(actual.at(-1)).toMatchObject({ message: { content } });
      }
      expect(fullGroup).toHaveBeenCalledTimes(1);
      messages = replaceTail(messages, { isStreaming: false, turnCompleted: true });
      expect(group(project(messages, [], build).items, false)).toEqual(
        groupWorkRuns(build().items, false),
      );
      expect(fullGroup).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['empty text', { content: ' ' }],
    ['completion seal', { turnCompleted: true }],
    ['late timestamp', { createdAt: '2026-09-30T12:00:00Z' }],
    ['stream end', { isStreaming: false }],
    ['compaction card', { systemCardType: 'compact' }],
  ] as const)('regroups when the tail changes %s', (_name, change) => {
    const fullGroup = vi.fn(groupWorkRuns);
    const group = createStreamingWorkGroupProjection(fullGroup);
    const items = buildRenderItems(fixture()).items;
    const tail = items.at(-1);
    if (tail?.type !== 'message') throw new Error('Expected answer');
    group(items, true);
    const next = [...items.slice(0, -1), { ...tail, message: { ...tail.message, ...change } }];
    expect(group(next, true)).toEqual(groupWorkRuns(next, true));
    expect(fullGroup).toHaveBeenCalledTimes(2);
  });

  it('regroups on paging, earlier changes, mode changes and clearing', () => {
    const fullGroup = vi.fn(groupWorkRuns);
    const group = createStreamingWorkGroupProjection(fullGroup);
    let items = buildRenderItems(fixture()).items;
    group(items, true);
    expect(group(items, true)).toBe(group(items, true));
    expect(fullGroup).toHaveBeenCalledTimes(1);
    for (const next of [
      [
        {
          type: 'message' as const,
          key: 'older',
          message: { clientId: 'older', role: 'user' as const, content: 'Earlier' },
        },
        ...items,
      ],
      [{ ...items[0] }, ...items.slice(1)],
      items.slice(1),
      [],
    ]) {
      expect(group(next, true)).toEqual(groupWorkRuns(next, true));
    }
    expect(fullGroup).toHaveBeenCalledTimes(5);
    const settled = group(items, false);
    expect(settled).toEqual(groupWorkRuns(items, false));
    expect(group(items, true)).toEqual(groupWorkRuns(items, true));
    // Remote snapshots already contain authoritative groups; do not regroup them.
    const remote = groupWorkRuns(items, false);
    expect(group(remote, true, true)).toEqual(remote);
    expect(fullGroup).toHaveBeenCalledTimes(7);
    expect(group(items, true)).toEqual(groupWorkRuns(items, true));
    expect(fullGroup).toHaveBeenCalledTimes(8);
  });

  it('does not shortcut an earlier or sealed answer whose delivery status can affect grouping', () => {
    const items = buildRenderItems(fixture()).items;
    const tail = items.at(-1);
    if (tail?.type !== 'message') throw new Error('Expected answer');
    for (const sealed of [false, true]) {
      const fullGroup = vi.fn(groupWorkRuns);
      const group = createStreamingWorkGroupProjection(fullGroup);
      const before = {
        ...tail,
        message: { ...tail.message, ...(sealed ? { turnCompleted: true } : {}) },
      };
      const suffix = sealed
        ? []
        : [
            {
              ...tail,
              key: 'later',
              message: {
                ...tail.message,
                clientId: 'later',
                content: 'Final',
                turnCompleted: true,
              },
            },
          ];
      group([...items.slice(0, -1), before, ...suffix], true);
      const next = [
        ...items.slice(0, -1),
        {
          ...before,
          message: { ...before.message, content: '# Long delivery\n\n' + 'text '.repeat(400) },
        },
        ...suffix,
      ];
      expect(group(next, true)).toEqual(groupWorkRuns(next, true));
      expect(fullGroup).toHaveBeenCalledTimes(2);
    }
  });
});

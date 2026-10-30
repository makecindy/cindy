import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';
import { deriveNavRailEntries } from '@/components/chat/messageNavRailModel';
import { createMessageNavigationProjection } from '@/components/chat/messageNavigationProjection';
import { createRenderItemMetadataProjection } from '@/components/chat/streamingMessageProjection';
import type { RenderItem } from '@/components/chat/messageWorkGroups';

const user = (clientId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  clientId,
  role: 'user',
  content: 'Question',
  ...extra,
});
const answer = (clientId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  clientId,
  role: 'assistant',
  content: 'Answer',
  ...extra,
});
const prefix = [user('u1'), answer('a1', { turnCompleted: true })];

describe('navigation projection', () => {
  it('does no excerpt work while disabled and rebuilds from current messages when enabled', () => {
    const derive = vi.fn(deriveNavRailEntries);
    const project = createMessageNavigationProjection(derive);
    const empty = project(prefix, false);
    expect(project([...prefix, user('u2')], false)).toBe(empty);
    expect(derive).not.toHaveBeenCalled();
    expect(project(prefix, true)).toEqual(deriveNavRailEntries(prefix));
    project(prefix, false);
    const next = [...prefix, user('u2'), answer('a2')];
    expect(project(next, true)).toEqual(deriveNavRailEntries(next));
  });

  it.each([
    ['ordinary', [user('u2')]],
    ['steer', [user('u2'), user('steer', { delivery: 'steer' })]],
    ['synthetic', [user('synthetic', { isSyntheticTrigger: true })]],
    ['system user', [user('system', { systemCardType: 'compact' })]],
    ['empty user', [user('empty', { content: '' })]],
    [
      'attachments only',
      [user('image', { content: '', images: [{ url: 'https://example.com/image.png', mimeType: 'image/png', originalName: '' }] })],
    ],
    ['sealed with resumed work', [user('u2'), answer('sealed', { turnCompleted: true })]],
    ['failed seal', [user('u2'), answer('failed', { turnCompleted: false, turnCostUsd: 1 })]],
  ] as const)(
    'matches the complete model for %s and only revisits the final boundary',
    (_name, suffix) => {
      const derive = vi.fn(deriveNavRailEntries);
      const project = createMessageNavigationProjection(derive);
      let messages = [
        ...prefix,
        ...suffix,
        answer('live', { content: 'Starting', isStreaming: true }),
      ];
      const first = project(messages, true);
      derive.mockClear();
      for (const content of [
        'New text',
        '# Report\n\n' + 'detail '.repeat(100),
        '<!-- hidden -->',
        'Replaced content',
        '  ',
      ]) {
        messages = [...messages.slice(0, -1), { ...messages.at(-1)!, content }];
        const actual = project(messages, true);
        expect(actual).toEqual(deriveNavRailEntries(messages));
        if (content.trim()) expect(actual[0]).toBe(first[0]);
      }
      // Nonempty updates use only the suffix. Empty transitions deliberately rebuild.
      for (const [rows] of derive.mock.calls.slice(0, 4))
        expect(rows.some((row) => row.clientId === 'u1')).toBe(false);
      messages = [
        ...messages.slice(0, -1),
        {
          ...messages.at(-1)!,
          content: 'Completed answer',
          isStreaming: false,
          turnCompleted: true,
        },
      ];
      expect(project(messages, true)).toEqual(deriveNavRailEntries(messages));
    },
  );

  it('keeps array identity when the visible excerpt is unchanged, including after a sealed answer', () => {
    for (const sealed of [false, true]) {
      const project = createMessageNavigationProjection();
      const rows = [
        ...prefix,
        user('u2'),
        ...(sealed ? [answer('seal', { turnCompleted: true })] : []),
        answer('live', { content: 'x'.repeat(220), isStreaming: true }),
      ];
      const first = project(rows, true);
      const next = [...rows.slice(0, -1), { ...rows.at(-1)!, content: 'x'.repeat(240) }];
      expect(project(next, true)).toBe(first);
      expect(project(next, true)).toEqual(deriveNavRailEntries(next));
    }
  });

  it('invalidates on earlier edits, prepend, reorder, deletion and clearing', () => {
    const project = createMessageNavigationProjection();
    let rows = [...prefix, user('u2'), answer('live', { isStreaming: true })];
    project(rows, true);
    for (const next of [
      rows.map((row) => (row.clientId === 'u1' ? { ...row, content: 'Edited question' } : row)),
      [user('older'), answer('older-answer'), ...rows],
      [rows[2], rows[3], ...prefix],
      rows.slice(2),
      [],
    ])
      expect(project(next, true)).toEqual(deriveNavRailEntries(next));
  });
});

describe('render metadata snapshot', () => {
  const items = (): RenderItem[] => [
    {
      type: 'message',
      key: 'user',
      message: user('u1', { images: [{ url: 'https://example.com/one.png', mimeType: 'image/png', originalName: '' }] }),
    },
    { type: 'message', key: 'answer', message: answer('a1', { isStreaming: true }) },
  ];
  it('reuses metadata across tail text updates and releases it for attachments, identity and finalization', () => {
    const project = createRenderItemMetadataProjection();
    const rows = items();
    const tail = rows[1];
    if (tail.type !== 'message') throw new Error('Expected answer');
    expect(project(rows)).toBe(rows);
    expect(
      project([rows[0], { ...tail, message: { ...tail.message, content: 'Continued' } }]),
    ).toBe(rows);
    for (const change of [
      { isStreaming: false },
      { clientId: 'other' },
      { images: [{ url: 'https://example.com/two.png', mimeType: 'image/png', originalName: '' }] },
    ]) {
      const next = [rows[0], { ...tail, message: { ...tail.message, ...change } }];
      expect(project(next)).toBe(next);
    }
    const editedUser = [
      { ...rows[0], message: user('u1', { content: 'Edited' }) } as RenderItem,
      tail,
    ];
    expect(project(editedUser)).toBe(editedUser);
    expect(project([])).toEqual([]);
  });

  it('invalidates for an earlier streaming row, whose growth can move later navigation targets', () => {
    const project = createRenderItemMetadataProjection();
    const rows = items().reverse();
    const first = rows[0];
    if (first.type !== 'message') throw new Error('Expected answer');
    project(rows);
    const next = [
      { ...first, message: { ...first.message, content: 'Growing above user' } },
      rows[1],
    ];
    expect(project(next)).toBe(next);
  });
});

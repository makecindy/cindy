import { describe, expect, it } from 'vitest';

import { boundSerializedMessageContent, extractMessagePreview, messageToCamel } from '../mapper.js';

const marker = '\uE200cite\uE202turn17search1\uE202turn17search2\uE201';

describe('message mapper internal citation compatibility', () => {
  it('hides persisted Web citation markers from message history', () => {
    const row = {
      id: 'message-1',
      clientId: 'client-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: JSON.stringify(`结论。${marker}`),
      toolUseId: null,
      agentMeta: null,
      agentKind: 'codex',
      createdAt: 1,
      rewindAt: null,
    } as Parameters<typeof messageToCamel>[0];

    expect(messageToCamel(row).content).toBe('结论。');
  });

  it('hides persisted markers from sidebar previews without touching user text', () => {
    expect(extractMessagePreview(JSON.stringify(`结论。${marker}`), 'assistant')).toBe('结论。');
    expect(extractMessagePreview(JSON.stringify(`用户引用 ${marker}`), 'user')).toBe(
      `用户引用 ${marker}`,
    );
  });

  it('hides a persisted Grok stop token from history and previews', () => {
    const row = {
      id: 'message-eos',
      clientId: 'client-eos',
      sessionId: 'session-1',
      role: 'assistant',
      content: JSON.stringify('<|eos|>'),
      toolUseId: null,
      agentMeta: null,
      agentKind: 'cc',
      createdAt: 1,
      rewindAt: null,
    } as Parameters<typeof messageToCamel>[0];

    expect(messageToCamel(row).content).toBe('');
    expect(extractMessagePreview(JSON.stringify('<|eos|>'), 'assistant')).toBeNull();
    expect(extractMessagePreview(JSON.stringify('The token is <|eos|>'), 'assistant')).toBe(
      'The token is <|eos|>',
    );
    expect(extractMessagePreview(JSON.stringify('用户说 <|eos|>'), 'user')).toBe('用户说 <|eos|>');
  });

  it('bounds oversized serialized content without cutting JSON in the middle', () => {
    const text = `hello ${'x'.repeat(5000)}`;
    const raw = JSON.stringify({ text, images: [], files: [] });
    const bounded = boundSerializedMessageContent(raw);
    expect(bounded).toBeDefined();
    const parsed = JSON.parse(bounded as string) as { text: string };
    expect(parsed.text.startsWith('hello ')).toBe(true);
    expect(parsed.text.length).toBe(4096);
    expect(extractMessagePreview(bounded, 'user')).toBe(parsed.text.slice(0, 140));
  });

  it('keeps short text valid when structured attachments make the payload oversized', () => {
    const raw = JSON.stringify({
      text: 'see this file',
      images: [],
      files: [{ path: '/tmp/notes.md', data: 'x'.repeat(5000) }],
    });
    const bounded = boundSerializedMessageContent(raw);
    const parsed = JSON.parse(bounded as string) as { text: string; files: unknown[] };
    expect(parsed.text).toBe('see this file');
    expect(extractMessagePreview(bounded, 'user')).toBe('see this file');
  });

  it('does not slice valid JSON that has no string text field', () => {
    const raw = JSON.stringify({ images: [{ data: 'x'.repeat(5000) }] });
    const bounded = boundSerializedMessageContent(raw);
    expect(bounded).toBe(raw);
    expect(extractMessagePreview(bounded, 'user')).toBeNull();
  });
});

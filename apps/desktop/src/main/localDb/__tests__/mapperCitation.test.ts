import { describe, expect, it } from 'vitest';

import { extractMessagePreview, messageToCamel } from '../mapper.js';

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
});

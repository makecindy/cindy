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
});

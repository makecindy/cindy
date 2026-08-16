import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { projectSessionQueueForInspection } from '../sessionQueueInspection.js';

function queuedItem(
  clientId: string,
  overrides: Partial<AgentInputQueuedMessage> = {},
): AgentInputQueuedMessage {
  return {
    clientId,
    text: `text-${clientId}`,
    persistedContent: `text-${clientId}`,
    model: 'gpt-5.6',
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    workingDir: '/repo',
    chatMessage: {
      clientId,
      role: 'user',
      content: `text-${clientId}`,
      createdAt: '2026-08-16T01:02:03.000Z',
    },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.6',
    },
    ...overrides,
  };
}

describe('projectSessionQueueForInspection', () => {
  it('projects user, Orca and scheduler entries without leaking unrelated queue fields', () => {
    const result = projectSessionQueueForInspection(
      [
        queuedItem('q-orca', {
          hostAcceptedAtMs: Date.parse('2026-08-16T01:02:04.000Z'),
          origin: { kind: 'orca', senderLabel: 'Worker', displayText: 'raw worker update' },
        }),
        queuedItem('q-user'),
        queuedItem('q-scheduler', {
          chatMessage: {
            clientId: 'q-scheduler',
            role: 'user',
            content: 'scheduled',
            createdAt: 'not-a-date',
          },
          origin: { kind: 'scheduler', scheduleId: 's-1', scheduleName: 'PR sweep' },
        }),
      ],
      ['q-user'],
    );

    expect(result).toEqual([
      {
        queuedMessageId: 'q-orca',
        position: 0,
        source: 'orca',
        sourceLabel: 'Worker',
        enqueuedAtMs: Date.parse('2026-08-16T01:02:04.000Z'),
        content: 'raw worker update',
        consuming: false,
      },
      {
        queuedMessageId: 'q-user',
        position: 1,
        source: 'user',
        sourceLabel: null,
        enqueuedAtMs: Date.parse('2026-08-16T01:02:03.000Z'),
        content: 'text-q-user',
        consuming: true,
      },
      {
        queuedMessageId: 'q-scheduler',
        position: 2,
        source: 'scheduler',
        sourceLabel: 'PR sweep',
        enqueuedAtMs: null,
        content: 'text-q-scheduler',
        consuming: false,
      },
    ]);
  });
});

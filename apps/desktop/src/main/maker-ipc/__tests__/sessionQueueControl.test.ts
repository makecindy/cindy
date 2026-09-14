import { describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { createSessionQueueControlService } from '../sessionQueueControl.js';

function queued(clientId = 'queued-1'): AgentInputQueuedMessage {
  return {
    clientId,
    text: 'before',
    persistedContent: 'before',
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId, role: 'user', content: 'before' },
    createOpts: {
      agentKind: 'pi',
      workingDir: '/repo',
      model: 'model',
      effort: 'medium',
      permissionMode: 'default',
    },
  };
}

describe('session queue control service', () => {
  it('shares authorization, content rebuild and atomic replace for update', async () => {
    const item = queued();
    const replaceQueuedMessage = vi.fn(() => true);
    const service = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({ pendingQueue: [item], consumingClientIds: [] })),
      replaceQueuedMessage,
      removeQueuedMessage: vi.fn(() => true),
    });

    await expect(
      service.update({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        message: 'after',
        authorize: () => ({ ok: true }),
        rebuild: (entry, message) => ({
          ...entry,
          text: message,
          persistedContent: message,
          chatMessage: { ...entry.chatMessage, content: message },
        }),
      }),
    ).resolves.toEqual({ ok: true, queuedMessageId: item.clientId });
    expect(replaceQueuedMessage).toHaveBeenCalledWith(
      'session-1',
      item.clientId,
      expect.objectContaining({ text: 'after', persistedContent: 'after' }),
    );
  });

  it('rejects consuming and unauthorized rows before mutation', async () => {
    const item = queued();
    const replaceQueuedMessage = vi.fn(() => true);
    const removeQueuedMessage = vi.fn(() => true);
    const consuming = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({
        pendingQueue: [item],
        consumingClientIds: [item.clientId],
      })),
      replaceQueuedMessage,
      removeQueuedMessage,
    });
    await expect(
      consuming.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });

    const unauthorized = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({ pendingQueue: [item], consumingClientIds: [] })),
      replaceQueuedMessage,
      removeQueuedMessage,
    });
    await expect(
      unauthorized.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: false, message: 'not yours' }),
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'NOT_AUTHORIZED', message: 'not yours' });
    expect(replaceQueuedMessage).not.toHaveBeenCalled();
    expect(removeQueuedMessage).not.toHaveBeenCalled();
  });

  it('reclassifies a replace/remove race as consuming when dispatch won', async () => {
    const item = queued();
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ pendingQueue: [item], consumingClientIds: [] })
      .mockResolvedValueOnce({ pendingQueue: [], consumingClientIds: [item.clientId] });
    const service = createSessionQueueControlService({
      getSnapshot,
      replaceQueuedMessage: vi.fn(() => false),
      removeQueuedMessage: vi.fn(() => false),
    });
    await expect(
      service.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });
  });
});

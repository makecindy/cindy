import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_MESSAGES_CHANNEL, DL_HISTORY_SESSION_TERMINAL_CHANNEL } from '@cindy/device-link';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerRemoteHistoryIpc, registerRemoteSessionTerminalIpc } from '../history';

const request = {
  sessionId: 'session-1',
  workdir: 'D:\\repo',
  fromMs: 100,
  toMs: 900,
  agentKind: 'codex' as const,
  roles: ['user', 'assistant'] as const,
  includeRewound: true,
  limit: 25,
  cursor: { createdAt: 700, id: 'message-7' },
  order: 'asc' as const,
};

describe('local-db:history:messages', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('validates and forwards the complete single-session history contract', async () => {
    const getMessages = vi.fn(async () => ({
      items: [],
      nextCursor: { createdAt: 800, id: 'message-8' },
      hasMore: true,
    }));
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, request);

    expect(page).toMatchObject({ hasMore: true });
    expect(getMessages).toHaveBeenCalledWith({
      sessionIds: ['session-1'],
      workdir: 'D:\\repo',
      fromMs: 100,
      toMs: 900,
      agentKind: 'codex',
      roles: ['user', 'assistant'],
      includeRewound: true,
      limit: 25,
      cursor: { createdAt: 700, id: 'message-7' },
      order: 'asc',
    });
  });

  it('distinguishes an existing empty session from a missing session', async () => {
    const getMessages = vi.fn();
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => false),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await expect(handler?.({}, request)).rejects.toThrow('[NOT_FOUND]');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects malformed cursors and out-of-range limits before reading', async () => {
    const getMessages = vi.fn();
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await expect(handler?.({}, { ...request, limit: 1001 })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler?.({}, {
      ...request,
      cursor: { createdAt: 'bad', id: 'message-7' },
    })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler?.({}, {
      ...request,
      cursor: { createdAt: 700, id: 'message-7', rowid: 0 },
    })).rejects.toThrow('[INVALID_PARAMS]');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('caps source content only when a session-reference caller requests it', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-1',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'assistant',
          content: '0123456789',
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 5 }) as {
      items: Array<{ content: string; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: '…6789',
      agentMeta: { remoteContentTruncated: true },
    });
  });

  it('strips structured content envelopes before relaying capped rows', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-structured',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: { text: 'short text', images: [{ base64: 'secret attachment' }] },
          toolUseId: null,
          agentMeta: { existing: true },
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'short text',
      agentMeta: { existing: true, remoteContentTruncated: true },
    });
  });

  it('does not mark plain persisted text envelopes as truncated', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-plain-envelope',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: { text: 'short text', images: [], files: [] },
          toolUseId: null,
          agentMeta: { existing: true },
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'short text',
      agentMeta: { existing: true },
    });
    expect(page.items[0].agentMeta.remoteContentTruncated).toBeUndefined();
  });

  it('caps plain rows while preserving structured rows in mixed-role reads', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-plain',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: '0123456789',
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }, {
          id: 'm-structured',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'ask_user',
          content: { type: 'ask_user', question: 'Choose one' },
          toolUseId: null,
          agentMeta: null,
          createdAt: 501,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, {
      ...request,
      roles: ['user', 'ask_user'],
      contentCharLimit: 5,
    }) as { items: Array<{ role: string; content: unknown; agentMeta?: Record<string, unknown> }> };

    expect(page.items[0]).toMatchObject({
      role: 'user',
      content: '…6789',
      agentMeta: { remoteContentTruncated: true },
    });
    expect(page.items[1]).toMatchObject({
      role: 'ask_user',
      content: { type: 'ask_user', question: 'Choose one' },
    });
    expect(page.items[1]?.agentMeta?.remoteContentTruncated).toBeUndefined();
  });

  it('marks omitted reference metadata as truncated after flattening an envelope', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-reference-envelope',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: {
            text: 'short text',
            images: [],
            files: [],
            sessionReferences: [{ sessionId: 'referenced-session' }],
            pastedTextRanges: [],
            slashCommandRanges: [],
          },
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ agentMeta: Record<string, unknown> }>;
    };

    expect(page.items[0]?.agentMeta).toMatchObject({ remoteContentTruncated: true });
  });

  it('drops non-text blocks when compacting structured history arrays', async () => {
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-array',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: [
            { type: 'text', text: 'visible text' },
            { type: 'image', source: { data: 'secret attachment' } },
          ],
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'visible text',
      agentMeta: { remoteContentTruncated: true },
    });
    expect(JSON.stringify(page.items[0])).not.toContain('secret attachment');
  });

  it('forwards a stable rowid history cursor', async () => {
    const getMessages = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
    registerRemoteHistoryIpc({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await handler?.({}, {
      ...request,
      cursor: { createdAt: 700, id: 'message-7', rowid: 42 },
    });
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { createdAt: 700, id: 'message-7', rowid: 42 },
    }));
  });
});

describe('local-db:history:session-terminal', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('returns the safe terminal marker for the requested session window', async () => {
    const readTerminal = vi.fn(async () => ({ status: 'error' as const, createdAt: 500 }));
    registerRemoteSessionTerminalIpc({
      sessionExists: vi.fn(async () => true),
      readTerminal,
    });

    const handler = handlers.get(DL_HISTORY_SESSION_TERMINAL_CHANNEL);
    const result = await handler?.({}, { sessionId: 'session-1', fromMs: 100 });

    expect(result).toEqual({ status: 'error', createdAt: 500 });
    expect(readTerminal).toHaveBeenCalledWith('session-1', 100);
  });

  it('normalizes a missing terminal to null and a missing fromMs to null', async () => {
    const readTerminal = vi.fn(async () => undefined);
    registerRemoteSessionTerminalIpc({
      sessionExists: vi.fn(async () => true),
      readTerminal,
    });

    const handler = handlers.get(DL_HISTORY_SESSION_TERMINAL_CHANNEL);
    const result = await handler?.({}, { sessionId: 'session-1' });

    expect(result).toBeNull();
    expect(readTerminal).toHaveBeenCalledWith('session-1', null);
  });

  it('rejects unknown sessions and malformed payloads before reading', async () => {
    const readTerminal = vi.fn();
    registerRemoteSessionTerminalIpc({
      sessionExists: vi.fn(async () => false),
      readTerminal,
    });

    const handler = handlers.get(DL_HISTORY_SESSION_TERMINAL_CHANNEL);
    await expect(handler?.({}, { sessionId: 'session-1', fromMs: null })).rejects.toThrow('[NOT_FOUND]');
    await expect(handler?.({}, { sessionId: 'session-1', fromMs: 'bad' })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler?.({}, { fromMs: null })).rejects.toThrow();
    expect(readTerminal).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  DeviceLinkError,
  DL_HISTORY_MESSAGES_CHANNEL,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type { GetMessagesArgs, HistoryMessage } from '@cindy/mcps';

import {
  classifyRemoteHistoryError,
  REMOTE_HISTORY_CONTENT_CHAR_LIMIT,
  readChatHistoryMessages,
} from '../remoteChatHistory';

const baseArgs: GetMessagesArgs = {
  sessionIds: ['session-local'],
  workdir: null,
  fromMs: null,
  toMs: null,
  agentKind: null,
  roles: ['user', 'assistant'],
  includeRewound: false,
  limit: 20,
  cursor: null,
  order: 'desc',
};

const remoteMessage: HistoryMessage = {
  id: 'message-1',
  sessionId: 'session-remote',
  sessionWorkingDir: 'D:\\remote',
  sessionAgentKind: 'codex',
  sessionTitle: 'Remote session',
  role: 'assistant',
  content: 'answer',
  toolUseId: null,
  agentMeta: null,
  createdAt: 500,
  rewindAt: null,
};

describe('readChatHistoryMessages', () => {
  it('keeps ordinary session ids on the local reader', async () => {
    const readLocal = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
    const invokeRemote = vi.fn();

    const result = await readChatHistoryMessages(baseArgs, { readLocal, invokeRemote });

    expect(result.ok).toBe(true);
    expect(readLocal).toHaveBeenCalledWith(baseArgs);
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('forwards every filter and preserves the qualified source identity', async () => {
    const invokeRemote = vi.fn(async (): Promise<InvokeResultPayload> => ({
      ok: true,
      result: {
        items: [remoteMessage],
        nextCursor: { createdAt: 500, id: 'message-1' },
        hasMore: true,
      },
    }));
    const args: GetMessagesArgs = {
      ...baseArgs,
      sessionIds: ['device-a::session-remote'],
      workdir: 'D:\\remote',
      fromMs: 100,
      toMs: 900,
      agentKind: 'codex',
      includeRewound: true,
      cursor: { createdAt: 700, id: 'message-7' },
      order: 'asc',
    };

    const result = await readChatHistoryMessages(args, {
      readLocal: vi.fn(),
      invokeRemote,
    });

    expect(invokeRemote).toHaveBeenCalledWith('device-a', DL_HISTORY_MESSAGES_CHANNEL, [{
      sessionId: 'session-remote',
      workdir: 'D:\\remote',
      fromMs: 100,
      toMs: 900,
      agentKind: 'codex',
      roles: ['user', 'assistant'],
      includeRewound: true,
      limit: 20,
      cursor: { createdAt: 700, id: 'message-7' },
      order: 'asc',
      contentCharLimit: REMOTE_HISTORY_CONTENT_CHAR_LIMIT,
    }]);
    expect(result).toMatchObject({
      ok: true,
      page: {
        items: [{ sessionId: 'device-a::session-remote' }],
        hasMore: true,
      },
    });
  });

  it('preserves structured role content by disabling the source-side text cap', async () => {
    const structuredContent = { type: 'ask_user', question: 'Choose one', options: ['a', 'b'] };
    const invokeRemote = vi.fn(async (): Promise<InvokeResultPayload> => ({
      ok: true,
      result: {
        items: [{ ...remoteMessage, role: 'ask_user', content: structuredContent }],
        nextCursor: null,
        hasMore: false,
      },
    }));

    const result = await readChatHistoryMessages({
      ...baseArgs,
      sessionIds: ['device-a::session-remote'],
      roles: ['ask_user'],
    }, {
      readLocal: vi.fn(),
      invokeRemote,
    });

    expect(invokeRemote).toHaveBeenCalledWith('device-a', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        roles: ['ask_user'],
        contentCharLimit: null,
      }),
    ]);
    expect(result).toMatchObject({
      ok: true,
      page: { items: [{ content: structuredContent, sessionId: 'device-a::session-remote' }] },
    });
  });

  it('keeps the cap for plain rows in mixed structured-role queries', async () => {
    const invokeRemote = vi.fn(async (): Promise<InvokeResultPayload> => ({
      ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    }));

    await readChatHistoryMessages({
      ...baseArgs,
      sessionIds: ['device-a::session-remote'],
      roles: ['user', 'assistant', 'ask_user'],
    }, {
      readLocal: vi.fn(),
      invokeRemote,
    });

    expect(invokeRemote).toHaveBeenCalledWith('device-a', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        roles: ['user', 'assistant', 'ask_user'],
        contentCharLimit: REMOTE_HISTORY_CONTENT_CHAR_LIMIT,
      }),
    ]);
  });

  it('keeps the cap for the tool default role set even though it includes structured roles', async () => {
    const invokeRemote = vi.fn(async (): Promise<InvokeResultPayload> => ({
      ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    }));

    await readChatHistoryMessages({
      ...baseArgs,
      sessionIds: ['device-a::session-remote'],
      roles: ['user', 'assistant', 'ask_user', 'plan_review'],
      rolesDefaulted: true,
    }, {
      readLocal: vi.fn(),
      invokeRemote,
    });

    expect(invokeRemote).toHaveBeenCalledWith('device-a', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        roles: ['user', 'assistant', 'ask_user', 'plan_review'],
        contentCharLimit: REMOTE_HISTORY_CONTENT_CHAR_LIMIT,
      }),
    ]);
  });

  it('rejects local/remote and multi-remote queries without touching either reader', async () => {
    const readLocal = vi.fn();
    const invokeRemote = vi.fn();
    for (const sessionIds of [
      ['session-local', 'device-a::session-remote'],
      ['device-a::one', 'device-a::two'],
      ['device-a::'],
    ]) {
      const result = await readChatHistoryMessages(
        { ...baseArgs, sessionIds },
        { readLocal, invokeRemote },
      );
      expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED_QUERY' });
    }
    expect(readLocal).not.toHaveBeenCalled();
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it.each([
    ['DEVICE_OFFLINE', 'REMOTE_DEVICE_OFFLINE'],
    ['LINK_NOT_OPEN', 'REMOTE_LINK_REQUIRED'],
    ['BACKPRESSURE', 'DEVICE_LINK_NOT_READY'],
    ['REMOTE_DISABLED', 'REMOTE_DISABLED'],
    ['ACCESS_REVOKED', 'REMOTE_ACCESS_REVOKED'],
    ['CHANNEL_NOT_ALLOWED', 'REMOTE_UNSUPPORTED'],
    ['INVOKE_TIMEOUT', 'REMOTE_TIMEOUT'],
    ['PAYLOAD_TOO_LARGE', 'REMOTE_PAYLOAD_TOO_LARGE'],
  ])('maps %s tunnel failures to %s', async (wireCode, expectedCode) => {
    const result = await readChatHistoryMessages(
      { ...baseArgs, sessionIds: ['device-a::session-remote'] },
      {
        readLocal: vi.fn(),
        invokeRemote: vi.fn(async () => ({
          ok: false,
          error: { code: wireCode, message: 'failed' },
        } as InvokeResultPayload)),
      },
    );
    expect(result).toMatchObject({ ok: false, errorCode: expectedCode });
  });

  it('preserves encoded remote IPC errors and thrown device-link errors', async () => {
    expect(classifyRemoteHistoryError('IPC_ERROR', '[NOT_FOUND] Session does not exist')).toEqual({
      errorCode: 'NOT_FOUND',
      message: 'Session does not exist',
    });

    const result = await readChatHistoryMessages(
      { ...baseArgs, sessionIds: ['device-a::session-remote'] },
      {
        readLocal: vi.fn(),
        invokeRemote: vi.fn(async () => {
          throw new DeviceLinkError('DEVICE_OFFLINE', 'offline');
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_DEVICE_OFFLINE' });
  });
});

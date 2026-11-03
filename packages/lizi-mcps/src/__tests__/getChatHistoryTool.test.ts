import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerGetChatHistoryTool } from '../xdt-helper/get_chat_history.js';
import type { XdtHelperHistoryDeps } from '../xdt-helper/_history_types.js';

function parseText(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected a text result');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('get_chat_history remote errors', () => {
  it('preserves stable host error codes instead of collapsing them to INTERNAL', async () => {
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'REMOTE_LINK_REQUIRED' as const,
        message: 'open the source device first',
      })),
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const result = await registry.call('get_chat_history', {
      session_ids: ['device-a::session-1'],
    });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toMatchObject({
      ok: false,
      errorCode: 'REMOTE_LINK_REQUIRED',
      data: { hint: 'open the source device first' },
    });
  });
});

describe('get_chat_history cursor pagination', () => {
  it('carries rowid through the public nextCursor round-trip', async () => {
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        page: {
          items: [],
          nextCursor: { createdAt: 1_000, id: 'message-1', rowid: 42 },
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [], nextCursor: null, hasMore: false },
      });
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const first = await registry.call('get_chat_history', { session_ids: ['session-1'] });
    const firstPayload = parseText(first) as { nextCursor: string };
    expect(firstPayload.nextCursor).toEqual(expect.any(String));

    await registry.call('get_chat_history', {
      session_ids: ['session-1'],
      cursor: firstPayload.nextCursor,
    });
    expect(getMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { createdAt: 1_000, id: 'message-1', rowid: 42 },
    }));
  });
});

describe('get_chat_history error role', () => {
  it('returns error rows when the caller lists the role explicitly', async () => {
    const getMessages = vi.fn(async () => ({
      ok: true as const,
      page: {
        items: [{
          id: 'm-error',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'error',
          content: { message: 'worker 派发成功后无输出就终止', sdkError: '[redacted]' },
          toolUseId: null,
          agentMeta: null,
          createdAt: 1_700_000_000_000,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      },
    }));
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const result = await registry.call('get_chat_history', {
      session_ids: ['session-1'],
      roles: ['error'],
    });

    expect(result.isError).toBeFalsy();
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['error'],
      rolesDefaulted: false,
    }));
    const payload = parseText(result) as {
      messages: Array<{ role: string }>;
      query: { roles: string[]; roles_defaulted: boolean };
    };
    expect(payload.query.roles).toEqual(['error']);
    expect(payload.query.roles_defaulted).toBe(false);
    expect(payload.messages.map((m) => m.role)).toEqual(['error']);
  });

  it('keeps error rows out of the unchanged default role set', async () => {
    const items = [
      {
        id: 'm-user',
        sessionId: 'session-1',
        sessionWorkingDir: null,
        sessionAgentKind: 'cc',
        sessionTitle: 'Session',
        role: 'user',
        content: 'hello',
        toolUseId: null,
        agentMeta: null,
        createdAt: 1_700_000_000_000,
        rewindAt: null,
      },
      {
        id: 'm-error',
        sessionId: 'session-1',
        sessionWorkingDir: null,
        sessionAgentKind: 'cc',
        sessionTitle: 'Session',
        role: 'error',
        content: { message: 'worker 派发成功后无输出就终止' },
        toolUseId: null,
        agentMeta: null,
        createdAt: 1_700_000_000_001,
        rewindAt: null,
      },
    ];
    const getMessages = vi.fn(async (args: { roles: readonly string[] | null }) => ({
      ok: true as const,
      page: {
        items: items.filter((m) => args.roles?.includes(m.role)),
        nextCursor: null,
        hasMore: false,
      },
    }));
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const payload = parseText(
      await registry.call('get_chat_history', { session_ids: ['session-1'] }),
    ) as { messages: Array<{ role: string }>; query: { roles: string[] } };

    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['user', 'assistant', 'ask_user', 'plan_review'],
      rolesDefaulted: true,
    }));
    expect(payload.query.roles).toEqual(['user', 'assistant', 'ask_user', 'plan_review']);
    expect(payload.query.roles).not.toContain('error');
    expect(payload.messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('get_chat_history role defaults', () => {
  it('marks omitted roles so remote adapters can keep their bounded default', async () => {
    const getMessages = vi.fn(async () => ({
      ok: true as const,
      page: { items: [], nextCursor: null, hasMore: false },
    }));
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    await registry.call('get_chat_history', { session_ids: ['device-a::session-1'] });
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['user', 'assistant', 'ask_user', 'plan_review'],
      rolesDefaulted: true,
    }));

    await registry.call('get_chat_history', {
      session_ids: ['device-a::session-1'],
      roles: ['ask_user'],
    });
    expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({
      roles: ['ask_user'],
      rolesDefaulted: false,
    }));
  });

  it('unwraps XML-style {item:[...]} folded session_ids and roles arrays', async () => {
    // glm 兼容层把数组参数序列化成 <item> 重复标签(同 #6369/images 病),不得报 INVALID_ARGS。
    const getMessages = vi.fn(async () => ({
      ok: true as const,
      page: { items: [], nextCursor: null, hasMore: false },
    }));
    const history = {
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const result = await registry.call('get_chat_history', {
      session_ids: { item: ['device-a::session-1'] },
      roles: { item: ['ask_user'] },
    });
    expect(result.isError).toBeUndefined();
    expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({
      roles: ['ask_user'],
      rolesDefaulted: false,
    }));
  });
});

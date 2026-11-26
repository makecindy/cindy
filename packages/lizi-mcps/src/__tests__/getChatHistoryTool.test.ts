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
  // 测试价值
  // - 生产入口与可观察结果：经 MCP registry 调用真实 get_chat_history，观察可选字段 image_view_hint。
  // - Bug／规则依据：历史里出现受管图片地址时，模型要先用 resolve_local_path 打开；两种地址各自都要能识别，
  //   而两种地址也都可能指向文档（例如缓存的 PDF），文档不能被提示成图片。
  // - 现有覆盖缺口：此前正例把两种地址放在同一条消息里，删掉任一种识别都测不出来。
  // - 最小失败输入：一条只含某一种地址的消息（图片后缀 / .pdf）。
  // - tier：unit；覆盖工具注册、历史读取和可选提示字段。
  const historyWithText = (text: string) => ({
    listWorkdirs: vi.fn(), listSessions: vi.fn(), searchChatHistory: vi.fn(),
    getMessages: vi.fn(async () => ({ ok: true as const, page: {
      items: [{ id: 'm1', sessionId: 'task', sessionWorkingDir: null, sessionAgentKind: 'cc', sessionTitle: 'Task',
        role: 'user', content: { text }, toolUseId: null,
        agentMeta: null, createdAt: 1000, rewindAt: null }], nextCursor: null, hasMore: false,
    } })),
  }) satisfies XdtHelperHistoryDeps;

  it.each([
    ['cindy-media', 'see cindy-media://blobs/' + 'a'.repeat(64) + '.png'],
    ['xdt-image', 'see xdt-image://task/cache-entry.png'],
  ])('adds one image viewing hint for a %s image address', async (_scheme, text) => {
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history: historyWithText(text) });
    const result = parseText(await registry.call('get_chat_history', { session_ids: ['task'] })) as Record<string, unknown>;
    expect(result.image_view_hint).toContain('resolve_local_path');
    expect(result.image_view_hint).toContain('重发');
  });

  it.each([
    ['cindy-media', 'see cindy-media://blobs/' + 'd'.repeat(64) + '.pdf'],
    ['xdt-image', 'see xdt-image://feishu-media-files/doc-token.pdf'],
  ])('does not add an image viewing hint for a %s PDF attachment', async (_scheme, text) => {
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history: historyWithText(text) });
    const result = parseText(await registry.call('get_chat_history', { session_ids: ['task'] }));
    expect(result).not.toHaveProperty('image_view_hint');
  });

  // Unit, lifecycle #15: the storage row id differs from the UI/native anchor.
  // Existing cursor cases never expose a message, so they cannot catch losing clientId.
  it.each([undefined, 'native-anchor'])('preserves optional message clientId %s for history operations', async clientId => {
    const row = { id: 'storage-row', clientId, sessionId: 'task', sessionWorkingDir: null, sessionAgentKind: 'cc', sessionTitle: 'Task',
      role: 'user', content: 'question', toolUseId: null, agentMeta: null, createdAt: 1000, rewindAt: null };
    const history = { listWorkdirs: vi.fn(), listSessions: vi.fn(), searchChatHistory: vi.fn(),
      getMessages: vi.fn(async () => ({ ok: true as const, page: { items: [row], nextCursor: null, hasMore: false } })) };
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });
    const result = parseText(await registry.call('get_chat_history', { session_ids: ['task'] })) as { messages: Array<{ id: string; clientId?: string }> };
    expect(result.messages[0]).toMatchObject({ id: 'storage-row', ...(clientId ? { clientId } : {}) });
    if (!clientId) expect(result.messages[0]).not.toHaveProperty('clientId');
  });

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

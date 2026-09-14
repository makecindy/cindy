import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerGetChatHistoryTool } from '../xdt-helper/get_chat_history.js';
import { registerListSessionsTool } from '../xdt-helper/list_sessions.js';
import type { XdtHelperHistoryDeps } from '../xdt-helper/_history_types.js';

function emptyPage() {
  return { items: [], nextCursor: null, hasMore: false };
}

function payload(result: Awaited<ReturnType<XdtHelperToolRegistry['call']>>) {
  const text = result.content.find((item) => item.type === 'text')?.text;
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
}

describe('Bot history tool scope', () => {
  it('intersects model-requested ids with the host-owned Bot scope', async () => {
    const getMessages = vi.fn(async () => ({ ok: true as const, page: emptyPage() }));
    const history = {
      resolveSessionScope: vi.fn(async () => ({
        ok: true as const,
        sessionIds: ['bot-main', 'bot-history'],
      })),
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, {
      history,
      getSessionContext: () => ({ agentKind: 'claude-code' as const, workingDir: '/w', sessionId: 'bot-main', memoryScopeKey: 'bot:bot-a' }),
    });

    const result = await registry.call('get_chat_history', {
      session_ids: ['ordinary-session', 'bot-history'],
    });

    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ['bot-history'] }),
    );
    expect(payload(result)).toMatchObject({
      ok: true,
      query: { scope_filtered_session_ids: ['ordinary-session'] },
    });
  });

  it('reports a privacy boundary instead of disguising it as empty history', async () => {
    const getMessages = vi.fn(async () => ({ ok: true as const, page: emptyPage() }));
    const history = {
      resolveSessionScope: vi.fn(async () => ({
        ok: true as const,
        sessionIds: ['bot-main'],
      })),
      listWorkdirs: vi.fn(),
      listSessions: vi.fn(),
      getMessages,
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history });

    const result = await registry.call('get_chat_history', {
      session_ids: ['other-bot-main'],
    });

    expect(payload(result)).toMatchObject({
      ok: false,
      errorCode: 'HISTORY_SCOPE_DENIED',
      data: { denied_session_ids: ['other-bot-main'] },
    });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('uses the full Bot-owned set when list_sessions has no model filter', async () => {
    const listSessions = vi.fn(async () => ({ ok: true as const, page: emptyPage() }));
    const history = {
      resolveSessionScope: vi.fn(async () => ({
        ok: true as const,
        sessionIds: ['bot-main', 'bot-route'],
      })),
      listWorkdirs: vi.fn(),
      listSessions,
      getMessages: vi.fn(),
      searchChatHistory: vi.fn(),
    } satisfies XdtHelperHistoryDeps;
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, {
      history,
      getSessionContext: () => ({ agentKind: 'claude-code' as const, workingDir: '/w', sessionId: 'bot-main', memoryScopeKey: 'bot:bot-a' }),
    });

    await registry.call('list_sessions', {});

    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ['bot-main', 'bot-route'] }),
    );
  });
});

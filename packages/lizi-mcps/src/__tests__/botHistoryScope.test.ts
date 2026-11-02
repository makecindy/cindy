import { registerTeammateGroupHistoryTool } from '../xdt-helper/teammate_group_history.js';
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

// Unit: group history has a different authority from task history. The registry
// must use the host-owned caller and preserve incomplete search/error semantics.
describe('companion group history tool', () => {
  it('discovers group history and preserves an incomplete empty search page', async () => {
    const registry = new XdtHelperToolRegistry();
    const read = vi.fn(async () => ({ ok: true as const, data: { messages: [], hasMore: true, nextCursor: '80' } }));
    registerTeammateGroupHistoryTool(registry, { read, getSessionContext: () => ({ sessionId: 'real-caller', agentKind: 'codex', workingDir: '/w' }) });
    expect(registry.list('history').some(tool => tool.name === 'get_teammate_group_history')).toBe(true);
    expect((await registry.call('get_teammate_group_history', { callerSessionId: 'spoofed' })).isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const result = payload(await registry.call('get_teammate_group_history', {
      group_id: '10000000-0000-4000-8000-000000000001', query: 'proposal', before: '100', limit: 5,
    }));
    expect(read).toHaveBeenCalledWith({ callerSessionId: 'real-caller', groupId: '10000000-0000-4000-8000-000000000001', query: 'proposal', before: '100', limit: 5 });
    expect(result).toMatchObject({ ok: true, untrustedHistory: true, messages: [], hasMore: true, nextCursor: '80' });
  });
  it.each([undefined, 'caller'])('reports missing caller or revoked membership as an error (%s)', async sessionId => {
    const registry = new XdtHelperToolRegistry();
    const read = vi.fn(async () => ({ ok: false as const, errorCode: 'PERMISSION_DENIED' }));
    registerTeammateGroupHistoryTool(registry, { read, getSessionContext: () => ({ sessionId, agentKind: 'codex', workingDir: '/w' }) });
    const result = await registry.call('get_teammate_group_history', {});
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ ok: false, errorCode: sessionId ? 'PERMISSION_DENIED' : 'CALLER_UNAVAILABLE' });
    if (!sessionId) expect(read).not.toHaveBeenCalled();
  });
});

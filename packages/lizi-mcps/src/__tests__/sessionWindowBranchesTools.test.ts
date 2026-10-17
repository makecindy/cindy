/**
 * open_session_in_new_window / get_session_branches 工具单测 —— 透传、payload 形状、失败码与会话上下文护栏。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerGetSessionBranchesTool,
  type GetSessionBranchesDeps,
} from '../xdt-helper/get_session_branches.js';
import {
  registerOpenSessionInNewWindowTool,
  type OpenSessionInNewWindowDeps,
} from '../xdt-helper/open_session_in_new_window.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

const getSessionContext = () => ({ sessionId: 'current-session', agentKind: 'claude-code', workingDir: '/tmp/p' });
const noContext = () => ({ sessionId: '', agentKind: 'claude-code', workingDir: '/tmp/p' });
const item = (id: string) => ({
  sessionId: id,
  title: `title-${id}`,
  workingDir: '/tmp/p',
  workspaceKind: 'project' as const,
  status: 'active',
});

describe('open_session_in_new_window tool', () => {
  it('passes the session id through and returns title', async () => {
    const open = vi.fn<OpenSessionInNewWindowDeps['openSessionInNewWindow']>(async ({ sessionId }) => ({
      ok: true as const,
      sessionId,
      title: 't',
    }));
    const registry = new XdtHelperToolRegistry();
    registerOpenSessionInNewWindowTool(registry, { getSessionContext, openSessionInNewWindow: open });
    const res = await registry.call('open_session_in_new_window', { session_id: 's1' });
    expect(open).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(parse(res)).toMatchObject({ ok: true, session_id: 's1', title: 't' });
  });

  it('requires session context and maps host failures', async () => {
    const registry = new XdtHelperToolRegistry();
    registerOpenSessionInNewWindowTool(registry, {
      getSessionContext: noContext,
      openSessionInNewWindow: async () => ({ ok: false as const, errorCode: 'NOT_FOUND' as const, message: 'x' }),
    });
    expect(parse(await registry.call('open_session_in_new_window', { session_id: 's1' }))).toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });
    const registry2 = new XdtHelperToolRegistry();
    registerOpenSessionInNewWindowTool(registry2, {
      getSessionContext,
      openSessionInNewWindow: async () => ({ ok: false as const, errorCode: 'PRECONDITION_FAILED' as const, message: 'deleted' }),
    });
    expect(parse(await registry2.call('open_session_in_new_window', { session_id: 's1' }))).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
  });
});

describe('get_session_branches tool', () => {
  it('returns the family with snake_case fields and ISO created_at', async () => {
    const branches = vi.fn<GetSessionBranchesDeps['getSessionBranches']>(async () => ({
      ok: true as const,
      rootSessionId: 'root',
      family: [
        { ...item('root'), parentSessionId: null, forkedAtMessageId: null, createdAt: 0 },
        { ...item('child'), parentSessionId: 'root', forkedAtMessageId: 'm1', createdAt: 1000 },
      ],
    }));
    const registry = new XdtHelperToolRegistry();
    registerGetSessionBranchesTool(registry, { getSessionContext, getSessionBranches: branches });
    const res = await registry.call('get_session_branches', { session_id: 'child' });
    expect(branches).toHaveBeenCalledWith({ sessionId: 'child' });
    expect(parse(res)).toMatchObject({
      ok: true,
      root_session_id: 'root',
      count: 2,
      family: [
        { session_id: 'root', parent_session_id: null },
        { session_id: 'child', parent_session_id: 'root', forked_at_message_id: 'm1', created_at: '1970-01-01T00:00:01.000Z' },
      ],
    });
  });

  it('maps NOT_FOUND and HOST_NOT_READY', async () => {
    for (const code of ['NOT_FOUND', 'HOST_NOT_READY'] as const) {
      const registry = new XdtHelperToolRegistry();
      registerGetSessionBranchesTool(registry, {
        getSessionContext,
        getSessionBranches: async () => ({ ok: false as const, errorCode: code, message: 'nope' }),
      });
      const res = await registry.call('get_session_branches', { session_id: 'x' });
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode: code });
    }
  });
});

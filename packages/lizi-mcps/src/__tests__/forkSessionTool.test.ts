/**
 * fork_session 工具单测 —— 参数透传、返回新会话、会话上下文护栏、host 失败码透传。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerForkSessionTool, type ForkSessionDeps } from '../xdt-helper/fork_session.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

const getSessionContext = () => ({
  sessionId: 'current-session',
  agentKind: 'claude-code',
  workingDir: '/tmp/p',
});
const noContext = () => ({ sessionId: '', agentKind: 'claude-code', workingDir: '/tmp/p' });

const forkedItem = {
  sessionId: 'new',
  title: 'title-new',
  workingDir: '/tmp/p',
  workspaceKind: 'project' as const,
  status: 'active',
};

function setup(ctx = getSessionContext, forkSession?: ForkSessionDeps['forkSession']) {
  const fork =
    forkSession ?? vi.fn<ForkSessionDeps['forkSession']>(async () => ({ ok: true as const, session: forkedItem }));
  const registry = new XdtHelperToolRegistry();
  registerForkSessionTool(registry, { getSessionContext: ctx, forkSession: fork });
  return { registry, fork };
}

describe('fork_session tool', () => {
  it('passes session and message ids to host and returns the new session', async () => {
    const { registry, fork } = setup();
    const res = await registry.call('fork_session', { session_id: 's1', message_id: 'm1' });
    expect(res.isError).toBeFalsy();
    expect(fork).toHaveBeenCalledWith({ sessionId: 's1', messageId: 'm1' });
    expect(parse(res)).toMatchObject({
      ok: true,
      source_session_id: 's1',
      forked_at_message_id: 'm1',
      session: { session_id: 'new', workspace_kind: 'project' },
    });
  });

  it('surfaces draft_text for user-message forks', async () => {
    const { registry } = setup(getSessionContext, async () => ({ ok: true as const, session: forkedItem, draftText: 'q' }));
    const res = await registry.call('fork_session', { session_id: 's1', message_id: 'm1' });
    expect(parse(res)).toMatchObject({ ok: true, draft_text: 'q' });
  });

  it('rejects malformed arguments before calling host', async () => {
    const { registry, fork } = setup();
    const res = await registry.call('fork_session', { session_id: 's1' });
    expect(res.isError).toBe(true);
    expect(fork).not.toHaveBeenCalled();
  });

  it('requires a bound session context', async () => {
    const { registry, fork } = setup(noContext);
    const res = await registry.call('fork_session', { session_id: 's1', message_id: 'm1' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    expect(fork).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['PRECONDITION_FAILED', 'PRECONDITION_FAILED'],
    ['UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_CAPABILITY'],
    ['HOST_NOT_READY', 'HOST_NOT_READY'],
  ] as const)('passes host failure code %s through', async (hostCode, expected) => {
    const { registry } = setup(getSessionContext, async () => ({
      ok: false as const,
      errorCode: hostCode,
      message: 'nope',
    }));
    const res = await registry.call('fork_session', { session_id: 's1', message_id: 'm1' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: expected });
  });
});

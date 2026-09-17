/**
 * pin_sessions / unpin_sessions 工具单测 —— pinned 标志透传、去重、会话上下文护栏、host 失败码透传。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerPinSessionsTool,
  registerUnpinSessionsTool,
  type PinSessionsDeps,
} from '../xdt-helper/pin_sessions.js';

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

function setup(ctx = getSessionContext, setSessionsPinned?: PinSessionsDeps['setSessionsPinned']) {
  const fn =
    setSessionsPinned ??
    vi.fn<PinSessionsDeps['setSessionsPinned']>(async ({ sessionIds }) => ({ ok: true as const, changed: sessionIds.map(item) }));
  const registry = new XdtHelperToolRegistry();
  registerPinSessionsTool(registry, { getSessionContext: ctx, setSessionsPinned: fn });
  registerUnpinSessionsTool(registry, { getSessionContext: ctx, setSessionsPinned: fn });
  return { registry, fn };
}

describe('pin_sessions / unpin_sessions tools', () => {
  it('passes the pinned flag to host and returns changed items', async () => {
    const { registry, fn } = setup();
    await registry.call('pin_sessions', { session_ids: ['s1'] });
    expect(fn).toHaveBeenLastCalledWith({ sessionIds: ['s1'], pinned: true });
    const res = await registry.call('unpin_sessions', { session_ids: ['s1', 's2'] });
    expect(fn).toHaveBeenLastCalledWith({ sessionIds: ['s1', 's2'], pinned: false });
    expect(parse(res)).toMatchObject({ ok: true, pinned: false, count: 2, changed: [{ session_id: 's1' }, { session_id: 's2' }] });
  });

  it('rejects duplicate ids before calling host', async () => {
    const { registry, fn } = setup();
    const res = await registry.call('pin_sessions', { session_ids: ['a', 'a'] });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('requires a bound session context', async () => {
    const { registry, fn } = setup(noContext);
    const res = await registry.call('pin_sessions', { session_ids: ['a'] });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes host failure codes through', async () => {
    for (const code of ['NOT_FOUND', 'PRECONDITION_FAILED', 'HOST_NOT_READY'] as const) {
      const { registry } = setup(getSessionContext, async () => ({ ok: false as const, errorCode: code, message: 'nope' }));
      const res = await registry.call('unpin_sessions', { session_ids: ['a'] });
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode: code });
    }
  });
});

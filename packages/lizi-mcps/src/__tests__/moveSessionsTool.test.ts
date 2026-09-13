/**
 * GUI 会话菜单对应的 control 工具单测 —— schema 护栏、当前会话保护、dry-run token、
 * host 失败码透传与参数校验。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerMoveSessionsTool, type MoveSessionsDeps } from '../xdt-helper/move_sessions.js';
function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

const CURRENT = 'current-session';
const getSessionContext = () => ({ sessionId: CURRENT, agentKind: 'claude-code', workingDir: '/tmp/p' });
const noContext = () => ({ sessionId: '', agentKind: 'claude-code', workingDir: '/tmp/p' });

const item = (id: string) => ({
  sessionId: id,
  title: `title-${id}`,
  workingDir: '/tmp/p',
  workspaceKind: 'project' as const,
  status: 'active',
});

describe('move_sessions', () => {
  function setup(ctx = getSessionContext) {
    const moveSessions = vi.fn<MoveSessionsDeps['moveSessions']>(async ({ sessionIds }) => ({
      ok: true as const,
      moved: sessionIds.map(item),
    }));
    const registry = new XdtHelperToolRegistry();
    registerMoveSessionsTool(registry, { getSessionContext: ctx, moveSessions });
    return { registry, moveSessions };
  }

  it('moves to a project and passes the target to host', async () => {
    const { registry, moveSessions } = setup();
    const res = await registry.call('move_sessions', {
      session_ids: ['s1', 's2'],
      target_kind: 'project',
      working_dir: '/tmp/proj',
    });
    expect(res.isError).toBeFalsy();
    expect(moveSessions).toHaveBeenCalledWith({
      sessionIds: ['s1', 's2'],
      target: { kind: 'project', workingDir: '/tmp/proj' },
    });
    expect(parse(res)).toMatchObject({ ok: true, target_kind: 'project', count: 2 });
  });

  it('moves to dialogue without working_dir', async () => {
    const { registry, moveSessions } = setup();
    const res = await registry.call('move_sessions', { session_ids: ['s1'], target_kind: 'dialogue' });
    expect(res.isError).toBeFalsy();
    expect(moveSessions).toHaveBeenCalledWith({ sessionIds: ['s1'], target: { kind: 'dialogue' } });
  });

  it('rejects project target without working_dir', async () => {
    const { registry, moveSessions } = setup();
    const res = await registry.call('move_sessions', { session_ids: ['s1'], target_kind: 'project' });
    expect(res.isError).toBe(true);
    expect(parse(res).errorCode).toBe('INVALID_ARGS');
    expect(moveSessions).not.toHaveBeenCalled();
  });

  it('rejects moving the current session and duplicates', async () => {
    const { registry, moveSessions } = setup();
    const self = await registry.call('move_sessions', { session_ids: [CURRENT], target_kind: 'dialogue' });
    expect(parse(self).errorCode).toBe('INVALID_ARGS');
    const dup = await registry.call('move_sessions', { session_ids: ['a', 'a'], target_kind: 'dialogue' });
    expect(parse(dup).errorCode).toBe('INVALID_ARGS');
    expect(moveSessions).not.toHaveBeenCalled();
  });

  it('requires session context', async () => {
    const { registry } = setup(noContext);
    const res = await registry.call('move_sessions', { session_ids: ['s1'], target_kind: 'dialogue' });
    expect(parse(res).errorCode).toBe('NO_SESSION_CONTEXT');
  });

  it('passes host failure codes through, including partial progress', async () => {
    const registry = new XdtHelperToolRegistry();
    registerMoveSessionsTool(registry, {
      getSessionContext,
      moveSessions: async () => ({
        ok: false,
        errorCode: 'INTERNAL',
        message: 's2: boom',
        moved: [item('s1')],
      }) as never,
    });
    const res = await registry.call('move_sessions', { session_ids: ['s1', 's2'], target_kind: 'dialogue' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(parse(res).data.moved).toHaveLength(1);
  });

  it('maps HOST_NOT_READY to a retry hint', async () => {
    const registry = new XdtHelperToolRegistry();
    registerMoveSessionsTool(registry, {
      getSessionContext,
      moveSessions: async () => ({ ok: false, errorCode: 'HOST_NOT_READY', message: 'x' }),
    });
    const res = await registry.call('move_sessions', { session_ids: ['s1'], target_kind: 'dialogue' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});


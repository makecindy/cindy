/**
 * delete_sessions 工具单测 —— dry-run token(绑定工具用途与预览 dirty 状态)、批次一致性、
 * 当前会话保护、host 失败码透传。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { encodeConfirmationToken } from '../xdt-helper/_confirmation_token.js';
import { registerDeleteSessionsTool, type DeleteSessionsDeps } from '../xdt-helper/delete_sessions.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

const CURRENT = 'current-session';
const getSessionContext = () => ({ sessionId: CURRENT, agentKind: 'claude-code', workingDir: '/tmp/p' });
const item = (id: string) => ({
  sessionId: id,
  title: `title-${id}`,
  workingDir: '/tmp/p',
  workspaceKind: 'project' as const,
  status: 'active',
  dirtyWorktree: id === 'dirty',
  dirtyWorktreeUnknown: false,
});

function setup() {
  const deleteSessions = vi.fn<DeleteSessionsDeps['deleteSessions']>(async ({ sessionIds }) => ({
    ok: true as const,
    items: sessionIds.map(item),
  }));
  const registry = new XdtHelperToolRegistry();
  registerDeleteSessionsTool(registry, { getSessionContext, deleteSessions });
  return { registry, deleteSessions };
}

describe('delete_sessions tool', () => {
  it('dry-runs by default and returns a confirmation token bound to the previewed dirty state', async () => {
    const { registry, deleteSessions } = setup();
    const res = await registry.call('delete_sessions', { session_ids: ['s1', 'dirty'] });
    expect(deleteSessions).toHaveBeenCalledWith({ sessionIds: ['s1', 'dirty'], dryRun: true, expectedDirty: undefined });
    const body = parse(res);
    expect(body).toMatchObject({ ok: true, dry_run: true, count: 2, dirty_worktree_count: 1 });
    expect(typeof body.confirmation_token).toBe('string');
    deleteSessions.mockClear();
    const real = await registry.call('delete_sessions', {
      session_ids: ['s1', 'dirty'],
      dry_run: false,
      confirmation_token: body.confirmation_token,
    });
    expect(deleteSessions).toHaveBeenLastCalledWith({
      sessionIds: ['s1', 'dirty'],
      dryRun: false,
      expectedDirty: { s1: false, dirty: true },
    });
    expect(parse(real)).toMatchObject({ ok: true, dry_run: false, count: 2 });
  });

  it('refuses real deletion without a matching token, a different batch, a tampered token, or another tool\'s token', async () => {
    const { registry, deleteSessions } = setup();
    const preview = parse(await registry.call('delete_sessions', { session_ids: ['s1'] }));
    deleteSessions.mockClear();
    const attempts = [
      { session_ids: ['s1'], dry_run: false },
      { session_ids: ['s1', 's2'], dry_run: false, confirmation_token: preview.confirmation_token },
      { session_ids: ['s1'], dry_run: false, confirmation_token: `${preview.confirmation_token}x` },
      {
        session_ids: ['s1'],
        dry_run: false,
        confirmation_token: encodeConfirmationToken('rename_sessions', { v: 1, items: [{ id: 's1', dirty: false }] }),
      },
    ];
    for (const args of attempts) {
      expect(parse(await registry.call('delete_sessions', args)).errorCode).toBe('INVALID_ARGS');
    }
    expect(deleteSessions).not.toHaveBeenCalled();
  });

  it('never deletes the current session and passes host failures through with partial items', async () => {
    const { registry, deleteSessions } = setup();
    expect(parse(await registry.call('delete_sessions', { session_ids: ['s1', CURRENT] })).errorCode).toBe('INVALID_ARGS');
    expect(deleteSessions).not.toHaveBeenCalled();
    const failing = new XdtHelperToolRegistry();
    registerDeleteSessionsTool(failing, {
      getSessionContext,
      deleteSessions: async () => ({ ok: false, errorCode: 'PRECONDITION_FAILED', message: 'changed', items: [item('s1')] }) as never,
    });
    const preview = parse(await registry.call('delete_sessions', { session_ids: ['s1'] }));
    const res = await failing.call('delete_sessions', { session_ids: ['s1'], dry_run: false, confirmation_token: preview.confirmation_token });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(parse(res).data.items).toHaveLength(1);
  });
});

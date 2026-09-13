/**
 * GUI 会话菜单对应的 control 工具单测 —— schema 护栏、当前会话保护、dry-run token、
 * host 失败码透传(move / pin / delete / export / open-in-new-window / fork / branches)。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerDeleteSessionsTool, type DeleteSessionsDeps } from '../xdt-helper/delete_sessions.js';
import { registerExportSessionTool, type ExportSessionDeps } from '../xdt-helper/export_session.js';
import { registerForkSessionTool, type ForkSessionDeps } from '../xdt-helper/fork_session.js';
import {
  registerGetSessionBranchesTool,
  type GetSessionBranchesDeps,
} from '../xdt-helper/get_session_branches.js';
import { registerMoveSessionsTool, type MoveSessionsDeps } from '../xdt-helper/move_sessions.js';
import {
  registerOpenSessionInNewWindowTool,
  type OpenSessionInNewWindowDeps,
} from '../xdt-helper/open_session_in_new_window.js';
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

describe('pin_sessions / unpin_sessions', () => {
  it('passes pinned flag to host', async () => {
    const setSessionsPinned = vi.fn<PinSessionsDeps['setSessionsPinned']>(async ({ sessionIds }) => ({
      ok: true as const,
      changed: sessionIds.map(item),
    }));
    const registry = new XdtHelperToolRegistry();
    registerPinSessionsTool(registry, { getSessionContext, setSessionsPinned });
    registerUnpinSessionsTool(registry, { getSessionContext, setSessionsPinned });
    await registry.call('pin_sessions', { session_ids: ['s1'] });
    expect(setSessionsPinned).toHaveBeenLastCalledWith({ sessionIds: ['s1'], pinned: true });
    const res = await registry.call('unpin_sessions', { session_ids: ['s1', 's2'] });
    expect(setSessionsPinned).toHaveBeenLastCalledWith({ sessionIds: ['s1', 's2'], pinned: false });
    expect(parse(res)).toMatchObject({ ok: true, pinned: false, count: 2 });
  });
});

describe('delete_sessions', () => {
  function setup() {
    const deleteSessions = vi.fn<DeleteSessionsDeps['deleteSessions']>(async ({ sessionIds }) => ({
      ok: true as const,
      items: sessionIds.map((id) => ({ ...item(id), dirtyWorktree: id === 'dirty' })),
    }));
    const registry = new XdtHelperToolRegistry();
    registerDeleteSessionsTool(registry, { getSessionContext, deleteSessions });
    return { registry, deleteSessions };
  }

  it('dry-runs by default and returns a confirmation token', async () => {
    const { registry, deleteSessions } = setup();
    const res = await registry.call('delete_sessions', { session_ids: ['s1', 'dirty'] });
    expect(deleteSessions).toHaveBeenCalledWith({ sessionIds: ['s1', 'dirty'], dryRun: true });
    const body = parse(res);
    expect(body).toMatchObject({ ok: true, dry_run: true, count: 2, dirty_worktree_count: 1 });
    expect(typeof body.confirmation_token).toBe('string');
  });

  it('refuses real deletion without a matching token', async () => {
    const { registry, deleteSessions } = setup();
    const preview = parse(await registry.call('delete_sessions', { session_ids: ['s1'] }));
    deleteSessions.mockClear();
    const noToken = await registry.call('delete_sessions', { session_ids: ['s1'], dry_run: false });
    expect(parse(noToken).errorCode).toBe('INVALID_ARGS');
    const wrongBatch = await registry.call('delete_sessions', {
      session_ids: ['s1', 's2'],
      dry_run: false,
      confirmation_token: preview.confirmation_token,
    });
    expect(parse(wrongBatch).errorCode).toBe('INVALID_ARGS');
    const tampered = await registry.call('delete_sessions', {
      session_ids: ['s1'],
      dry_run: false,
      confirmation_token: `${preview.confirmation_token}x`,
    });
    expect(parse(tampered).errorCode).toBe('INVALID_ARGS');
    expect(deleteSessions).not.toHaveBeenCalled();
  });

  it('deletes with the token from the same batch', async () => {
    const { registry, deleteSessions } = setup();
    const preview = parse(await registry.call('delete_sessions', { session_ids: ['s1', 's2'] }));
    const res = await registry.call('delete_sessions', {
      session_ids: ['s1', 's2'],
      dry_run: false,
      confirmation_token: preview.confirmation_token,
    });
    expect(deleteSessions).toHaveBeenLastCalledWith({ sessionIds: ['s1', 's2'], dryRun: false });
    expect(parse(res)).toMatchObject({ ok: true, dry_run: false, count: 2 });
  });

  it('never deletes the current session', async () => {
    const { registry, deleteSessions } = setup();
    const res = await registry.call('delete_sessions', { session_ids: ['s1', CURRENT] });
    expect(parse(res).errorCode).toBe('INVALID_ARGS');
    expect(deleteSessions).not.toHaveBeenCalled();
  });
});

describe('export_session', () => {
  it('passes args through and surfaces OVERSIZE data', async () => {
    const exportSession = vi.fn<ExportSessionDeps['exportSession']>(async ({ excludeMedia }) =>
      excludeMedia
        ? { ok: true as const, filePath: '/tmp/a.cshare', fidelity: 'full', missingTranscripts: [], mediaMissing: 0, orcaWorkers: 0 }
        : { ok: false as const, errorCode: 'OVERSIZE' as const, message: 'too big', data: { limit_bytes: 1 } },
    );
    const registry = new XdtHelperToolRegistry();
    registerExportSessionTool(registry, { getSessionContext, exportSession });
    const big = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(exportSession).toHaveBeenCalledWith({ sessionId: 's1', targetPath: '/tmp/a', password: null, excludeMedia: false });
    expect(parse(big)).toMatchObject({ ok: false, errorCode: 'OVERSIZE', data: { limit_bytes: 1 } });
    const ok = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a', exclude_media: true, password: 'pw' });
    expect(exportSession).toHaveBeenLastCalledWith({ sessionId: 's1', targetPath: '/tmp/a', password: 'pw', excludeMedia: true });
    expect(parse(ok)).toMatchObject({ ok: true, file_path: '/tmp/a.cshare', fidelity: 'full' });
  });
});

describe('open_session_in_new_window / fork_session / get_session_branches', () => {
  it('open passes through', async () => {
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

  it('fork passes message id and returns the new session', async () => {
    const fork = vi.fn<ForkSessionDeps['forkSession']>(async () => ({ ok: true as const, session: item('new') }));
    const registry = new XdtHelperToolRegistry();
    registerForkSessionTool(registry, { getSessionContext, forkSession: fork });
    const res = await registry.call('fork_session', { session_id: 's1', message_id: 'm1' });
    expect(fork).toHaveBeenCalledWith({ sessionId: 's1', messageId: 'm1' });
    expect(parse(res)).toMatchObject({ ok: true, source_session_id: 's1', session: { session_id: 'new' } });
  });

  it('branches returns family with ISO created_at', async () => {
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

  it('branches maps NOT_FOUND', async () => {
    const registry = new XdtHelperToolRegistry();
    registerGetSessionBranchesTool(registry, {
      getSessionContext,
      getSessionBranches: async () => ({ ok: false, errorCode: 'NOT_FOUND', message: 'nope' }),
    });
    const res = await registry.call('get_session_branches', { session_id: 'x' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });
});

/**
 * archive_sessions / unarchive_sessions 工具单测 —— schema 护栏 + host 透传 + 当前会话保护。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerSendToSessionTool } from '../xdt-helper/send_to_session.js';
import {
  registerArchiveSessionsTool,
  registerUnarchiveSessionsTool,
  type ArchiveSessionsDeps,
} from '../xdt-helper/archive_sessions.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function setup(opts?: { sessionId?: string; remote?: ArchiveSessionsDeps['setRemoteSessionsStatus'] }) {
  const sessionId = opts?.sessionId ?? 'current-session';
  const setSessionsStatus: ArchiveSessionsDeps['setSessionsStatus'] = vi.fn(
    async ({ sessionIds, status }: Parameters<ArchiveSessionsDeps['setSessionsStatus']>[0]) => ({
      ok: true as const,
      changed: sessionIds.map((id) => ({
        sessionId: id,
        title: `title-${id}`,
        workingDir: '/tmp/proj',
        status,
      })),
    }),
  );
  const deps: ArchiveSessionsDeps = {
    getSessionContext: () => ({
      sessionId,
      agentKind: 'claude-code',
      workingDir: '/tmp/proj',
    }),
    setSessionsStatus,
    setRemoteSessionsStatus: opts?.remote,
  };
  const registry = new XdtHelperToolRegistry();
  registerArchiveSessionsTool(registry, deps);
  registerUnarchiveSessionsTool(registry, deps);
  return { registry, setSessionsStatus, sessionId };
}

describe('archive_sessions tool', () => {
  it('archives a batch and passes status=archived to host', async () => {
    const { registry, setSessionsStatus } = setup();
    const res = await registry.call('archive_sessions', {
      session_ids: ['s1', 's2'],
    });
    expect(res.isError).toBeFalsy();
    expect(setSessionsStatus).toHaveBeenCalledWith({
      sessionIds: ['s1', 's2'],
      status: 'archived',
    });
    expect(parse(res)).toMatchObject({
      ok: true,
      status: 'archived',
      count: 2,
    });
  });

  it('refuses to archive the currently running session', async () => {
    const { registry, setSessionsStatus } = setup({ sessionId: 'current-session' });
    const res = await registry.call('archive_sessions', {
      session_ids: ['s1', 'current-session'],
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('rejects duplicate session_ids before calling host', async () => {
    const { registry, setSessionsStatus } = setup();
    const res = await registry.call('archive_sessions', {
      session_ids: ['s1', 's1'],
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('maps host NOT_FOUND through as-is', async () => {
    const { registry } = setup();
    const deps: ArchiveSessionsDeps = {
      getSessionContext: () => ({
        sessionId: 'current-session',
        agentKind: 'claude-code',
        workingDir: '/tmp/proj',
      }),
      setSessionsStatus: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'NOT_FOUND' as const,
        message: 'Session 不存在: ghost',
      })),
    };
    const reg = new XdtHelperToolRegistry();
    registerArchiveSessionsTool(reg, deps);
    const res = await reg.call('archive_sessions', { session_ids: ['ghost'] });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('explains that deleted sessions cannot be restored through status tools', async () => {
    const deps: ArchiveSessionsDeps = {
      getSessionContext: () => ({
        sessionId: 'current-session',
        agentKind: 'claude-code',
        workingDir: '/tmp/proj',
      }),
      setSessionsStatus: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'PRECONDITION_FAILED' as const,
        message: '已删除的任务不能恢复或归档: deleted-session',
      })),
    };
    const registry = new XdtHelperToolRegistry();
    registerUnarchiveSessionsTool(registry, deps);

    const res = await registry.call('unarchive_sessions', {
      session_ids: ['deleted-session'],
    });

    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  });

  it('rejects empty batch at schema boundary', async () => {
    const { registry } = setup();
    const res = await registry.call('archive_sessions', { session_ids: [] });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });
});

describe('unarchive_sessions tool', () => {
  it('normalizes the explicit local alias before self-protection and deduplication', async () => {
    const { registry, setSessionsStatus } = setup();
    expect(parse(await registry.call('archive_sessions', { session_ids: ['local::current-session'] })).errorCode).toBe('INVALID_ARGS');
    expect(parse(await registry.call('unarchive_sessions', { session_ids: ['s1', 'local::s1'] })).errorCode).toBe('INVALID_ARGS');
    expect(setSessionsStatus).not.toHaveBeenCalled();
    expect(parse(await registry.call('unarchive_sessions', { session_ids: ['local::s1'] })).ok).toBe(true);
    expect(setSessionsStatus).toHaveBeenCalledExactlyOnceWith({ sessionIds: ['s1'], status: 'active' });
  });

  it('returns an address the existing send tool can use, without sending during restoration', async () => {
    const { registry, setSessionsStatus } = setup({ remote: async () => ({ ok: true, changed: [
      { sessionId: 's1', title: null, workingDir: null, status: 'active' },
    ] }) });
    const sendToSession = vi.fn();
    const sendToRemoteSession = vi.fn(async () => ({ ok: true as const, agentKind: 'codex' as const,
      wakeKind: 'queued' as const, targetTitle: null, targetLastUserSendAt: null,
    }));
    registerSendToSessionTool(registry, { getSessionContext: () => ({ sessionId: 'caller', agentKind: 'codex', workingDir: '/tmp/proj' }), sendToSession, sendToRemoteSession });
    const restored = parse(await registry.call('unarchive_sessions', { session_ids: ['studio::s1'] }));
    expect(sendToRemoteSession).not.toHaveBeenCalled();
    expect(parse(await registry.call('send_to_session', { target_session_id: restored.changed[0].session_id, message: 'continue' }))).toMatchObject({ ok: true, wake_kind: 'queued' });
    expect(sendToRemoteSession).toHaveBeenCalledExactlyOnceWith({ deviceId: 'studio', sessionId: 's1', message: 'continue', dispatcherSessionId: 'caller' });
    expect(sendToSession).not.toHaveBeenCalled();
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('passes status=active to host and allows the current session', async () => {
    const { registry, setSessionsStatus } = setup({ sessionId: 'current-session' });
    const res = await registry.call('unarchive_sessions', {
      session_ids: ['current-session', 's2'],
    });
    expect(res.isError).toBeFalsy();
    expect(setSessionsStatus).toHaveBeenCalledWith({
      sessionIds: ['current-session', 's2'],
      status: 'active',
    });
    expect(parse(res)).toMatchObject({ ok: true, status: 'active', count: 2 });
  });

  it.each(['archive_sessions', 'unarchive_sessions'])('routes %s qualified ids exclusively to the remote host', async (name) => {
    const status = name === 'archive_sessions' ? 'archived' : 'active';
    const remote = vi.fn(async () => ({ ok: true as const, changed: [
      { sessionId: 'current-session', title: 'remote', workingDir: null, status: status as 'active' | 'archived' },
    ] }));
    const { registry, setSessionsStatus } = setup({ remote });
    const result = parse(await registry.call(name, { session_ids: ['studio::current-session'] }));
    expect(remote).toHaveBeenCalledExactlyOnceWith({ deviceId: 'studio', sessionIds: ['current-session'], status });
    expect(setSessionsStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, count: 1, changed: [{ session_id: 'studio::current-session', status }] });
  });

  it.each([
    ['local-task', 'studio::remote-task'],
    ['studio::s1', 'laptop::s2'],
    ['studio::'],
    ['::task'],
    ['local::studio::s1'],
  ])('rejects a mixed/malformed batch before any write: %j', async (...session_ids) => {
    const remote = vi.fn();
    const { registry, setSessionsStatus } = setup({ remote });
    expect(parse(await registry.call('unarchive_sessions', { session_ids })).errorCode).toBe('INVALID_ARGS');
    expect(remote).not.toHaveBeenCalled();
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('never sends a composite id to the local host when remote support is absent', async () => {
    const { registry, setSessionsStatus } = setup();
    expect(parse(await registry.call('unarchive_sessions', { session_ids: ['studio::s1'] })).errorCode).toBe('REMOTE_UNSUPPORTED');
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('preserves partial receipts and qualifies the failed and unattempted ids', async () => {
    const remote = vi.fn(async () => ({
      ok: false as const, errorCode: 'REMOTE_RESULT_UNKNOWN', message: 'check status first',
      changed: [{ sessionId: 's1', title: null, workingDir: null, status: 'active' as const }],
      failedSessionId: 's2', remainingSessionIds: ['s3'],
    }));
    const { registry, setSessionsStatus } = setup({ remote });
    const res = await registry.call('unarchive_sessions', { session_ids: ['studio::s1', 'studio::s2', 'studio::s3'] });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN', data: {
      partial: true, changed: [{ session_id: 'studio::s1' }], failed_session_id: 'studio::s2', remaining_session_ids: ['studio::s3'],
    } });
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });

  it('marks an unknown first write as partial even without a confirmed receipt', async () => {
    const remote = vi.fn(async () => ({
      ok: false as const, errorCode: 'REMOTE_RESULT_UNKNOWN', message: 'check status first',
      changed: [], failedSessionId: 's1', remainingSessionIds: ['s2'],
    }));
    const { registry, setSessionsStatus } = setup({ remote });
    const res = await registry.call('unarchive_sessions', { session_ids: ['studio::s1', 'studio::s2'] });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN', data: {
      partial: true, changed: [], failed_session_id: 'studio::s1', remaining_session_ids: ['studio::s2'],
    } });
    expect(setSessionsStatus).not.toHaveBeenCalled();
  });
});

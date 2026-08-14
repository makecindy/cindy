/**
 * archive_sessions / unarchive_sessions 工具单测 —— schema 护栏 + host 透传 + 当前会话保护。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
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

function setup(opts?: { sessionId?: string }) {
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
});

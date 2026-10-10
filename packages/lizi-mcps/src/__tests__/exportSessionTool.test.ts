/**
 * export_session 工具单测 —— 参数透传、OVERSIZE data 透传、ok 形状、会话上下文护栏。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerExportSessionTool, type ExportSessionDeps } from '../xdt-helper/export_session.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

const getSessionContext = () => ({ sessionId: 'current-session', agentKind: 'claude-code', workingDir: '/tmp/p' });
const noContext = () => ({ sessionId: '', agentKind: 'claude-code', workingDir: '/tmp/p' });

const okResult = {
  ok: true as const,
  filePath: '/tmp/a.cshare',
  fidelity: 'full',
  missingTranscripts: [],
  mediaMissing: 0,
  orcaWorkers: 0,
};

function setup(ctx = getSessionContext, exportSession?: ExportSessionDeps['exportSession']) {
  const fn = exportSession ?? vi.fn<ExportSessionDeps['exportSession']>(async () => okResult);
  const registry = new XdtHelperToolRegistry();
  registerExportSessionTool(registry, { getSessionContext: ctx, exportSession: fn });
  return { registry, fn };
}

describe('export_session tool', () => {
  it('passes arguments through with defaults and returns the ok shape', async () => {
    const { registry, fn } = setup();
    const res = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(fn).toHaveBeenCalledWith({ sessionId: 's1', targetPath: '/tmp/a', excludeMedia: false });
    expect(parse(res)).toMatchObject({ ok: true, session_id: 's1', file_path: '/tmp/a.cshare', fidelity: 'full' });

    await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a', exclude_media: true });
    expect(fn).toHaveBeenLastCalledWith({ sessionId: 's1', targetPath: '/tmp/a', excludeMedia: true });
    // 密码不再是 agent 可见入参:传了也会被 schema 拒绝。
    const withPassword = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a', password: 'pw' });
    expect(withPassword.isError).toBe(true);
  });

  it('surfaces OVERSIZE data from host', async () => {
    const { registry } = setup(getSessionContext, async () => ({
      ok: false as const,
      errorCode: 'OVERSIZE' as const,
      message: 'too big',
      data: { limit_bytes: 1, total_bytes: 9 },
    }));
    const res = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'OVERSIZE', data: { limit_bytes: 1, total_bytes: 9 } });
  });

  it('requires a bound session context and valid arguments', async () => {
    const { registry, fn } = setup(noContext);
    const res = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    const bad = await registry.call('export_session', { session_id: 's1' });
    expect(bad.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses SSH remote callers before touching the host', async () => {
    const remoteCtx = () => ({ sessionId: 's', agentKind: 'codex', workingDir: '/remote/p', remoteHostId: 'host-1' });
    const { registry, fn } = setup(remoteCtx);
    const res = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('maps HOST_NOT_READY to a retry hint', async () => {
    const { registry } = setup(getSessionContext, async () => ({ ok: false as const, errorCode: 'HOST_NOT_READY' as const, message: 'x' }));
    const res = await registry.call('export_session', { session_id: 's1', target_path: '/tmp/a' });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});

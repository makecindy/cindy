import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry, type XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerCancelSessionQueuedMessageTool,
  registerGetSessionRuntimeTool,
  registerSetSessionRuntimeTool,
  registerSteerSessionTool,
  registerStopSessionTurnTool,
  registerUpdateSessionQueuedMessageTool,
  type SessionControlDeps,
} from '../xdt-helper/session_control.js';

function parse(result: XdtHelperToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('missing text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function setup(opts?: { sessionId?: string | undefined }) {
  const sessionId = opts && 'sessionId' in opts ? opts.sessionId : 'caller-session';
  const deps: SessionControlDeps = {
    getSessionContext: () => ({
      sessionId,
      agentKind: 'codex',
      workingDir: '/repo',
    }),
    updateQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
      ok: true as const,
      queuedMessageId,
    })),
    cancelQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
      ok: true as const,
      queuedMessageId,
    })),
    steerSession: vi.fn(async () => ({ ok: true as const, queuedMessageId: 'steer-1' })),
    stopSessionTurn: vi.fn(async () => ({
      ok: true as const,
      status: 'waiting-for-safe-point' as const,
      turnGeneration: 7,
    })),
    getSessionRuntime: vi.fn(async () => ({
      ok: true as const,
      runtime: {
        sessionId: 'target-session',
        phase: 'running' as const,
        recordStatus: 'active' as const,
        attention: false,
        workflow: null,
        source: 'live' as const,
        turnGeneration: 7,
        startedAtMs: Date.parse('2026-08-16T01:00:00.000Z'),
        lastActivityAtMs: Date.parse('2026-08-16T01:00:05.000Z'),
        currentActionSummary: '正在运行工具 Bash',
        gracefulStopState: 'waiting-for-safe-point' as const,
      },
    })),
    setSessionRuntime: vi.fn(async ({ patch }) => ({
      ok: true as const,
      status: 'applied' as const,
      generation: 2,
      effectiveProfile: {
        agentKind: 'codex' as const,
        model: patch.model ?? 'gpt-5.6-sol',
        providerId: patch.providerId ?? 'openai',
        effort: patch.effort ?? 'high',
        fastMode: patch.fastMode ?? false,
      },
      pendingMutation: null,
    })),
  };
  const registry = new XdtHelperToolRegistry();
  registerUpdateSessionQueuedMessageTool(registry, deps);
  registerCancelSessionQueuedMessageTool(registry, deps);
  registerSteerSessionTool(registry, deps);
  registerStopSessionTurnTool(registry, deps);
  registerGetSessionRuntimeTool(registry, deps);
  registerSetSessionRuntimeTool(registry, deps);
  return { deps, registry };
}

describe('cindy_helper session control tools', () => {
  it('atomically changes the current session runtime with generation CAS', async () => {
    const { deps, registry } = setup();
    const result = parse(
      await registry.call('set_session_runtime', {
        model: 'gpt-5.6-sol',
        effort: 'high',
        fast: true,
        expected_generation: 1,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      session_id: 'caller-session',
      status: 'applied',
      generation: 2,
      effective_boundary: 'immediate',
      effective: {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        provider_id: 'openai',
        effort: 'high',
        fast: true,
      },
    });
    expect(deps.setSessionRuntime).toHaveBeenCalledWith({
      targetSessionId: 'caller-session',
      expectedGeneration: 1,
      patch: { model: 'gpt-5.6-sol', effort: 'high', fastMode: true },
    });
  });

  it('requires a bound current session when session_id is omitted', async () => {
    const { registry } = setup({ sessionId: undefined });
    expect(
      parse(await registry.call('set_session_runtime', { effort: 'high' })),
    ).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
  });

  it('requires a read-before-write generation token', async () => {
    const { registry } = setup();
    expect(
      parse(await registry.call('set_session_runtime', { effort: 'high' })),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('updates and cancels only through the caller-bound ownership context', async () => {
    const { deps, registry } = setup();

    expect(parse(await registry.call('update_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      message: 'revised',
    }))).toMatchObject({
      ok: true,
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      updated: true,
    });
    expect(deps.updateQueuedMessage).toHaveBeenCalledWith({
      callerSessionId: 'caller-session',
      targetSessionId: 'target-session',
      queuedMessageId: 'queued-1',
      message: 'revised',
    });

    expect(parse(await registry.call('cancel_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'queued-2',
    }))).toMatchObject({
      ok: true,
      queued_message_id: 'queued-2',
      cancelled: true,
    });
  });

  it('fails closed without a caller session for ownership-sensitive actions', async () => {
    const { deps, registry } = setup({ sessionId: undefined });

    for (const [name, args] of [
      ['update_session_queued_message', {
        session_id: 'target', queued_message_id: 'q', message: 'next',
      }],
      ['cancel_session_queued_message', { session_id: 'target', queued_message_id: 'q' }],
      ['steer_session', { session_id: 'target', message: 'urgent context' }],
    ] as const) {
      expect(parse(await registry.call(name, args))).toMatchObject({
        ok: false,
        errorCode: 'NO_SESSION_CONTEXT',
      });
    }
    expect(deps.updateQueuedMessage).not.toHaveBeenCalled();
    expect(deps.cancelQueuedMessage).not.toHaveBeenCalled();
    expect(deps.steerSession).not.toHaveBeenCalled();
  });

  it('steers, requests graceful stop and projects bounded runtime metadata', async () => {
    const { deps, registry } = setup();

    expect(parse(await registry.call('steer_session', {
      session_id: 'target-session',
      message: 'check this first',
    }))).toMatchObject({
      ok: true,
      queued_message_id: 'steer-1',
      steered: true,
    });
    expect(deps.steerSession).toHaveBeenCalledWith({
      callerSessionId: 'caller-session',
      targetSessionId: 'target-session',
      message: 'check this first',
    });

    expect(parse(await registry.call('stop_session_turn', {
      session_id: 'target-session',
    }))).toMatchObject({
      ok: true,
      status: 'waiting-for-safe-point',
      turn_generation: 7,
    });

    expect(parse(await registry.call('get_session_runtime', {
      session_id: 'target-session',
    }))).toEqual({
      ok: true,
      session_id: 'target-session',
      phase: 'running',
      active: true,
      record_status: 'active',
      source: 'live',
      attention: false,
      workflow: null,
      turn_generation: 7,
      started_at: '2026-08-16T01:00:00.000Z',
      last_activity_at: '2026-08-16T01:00:05.000Z',
      current_action_summary: '正在运行工具 Bash',
      graceful_stop_state: 'waiting-for-safe-point',
      generation: 0,
      baseline: null,
      effective: null,
      pending: null,
      fallback_enabled: false,
    });
  });

  it('preserves structured host failures', async () => {
    const { deps, registry } = setup();
    vi.mocked(deps.updateQueuedMessage).mockResolvedValueOnce({
      ok: false,
      errorCode: 'NOT_AUTHORIZED',
      message: 'not yours',
    });
    vi.mocked(deps.stopSessionTurn).mockResolvedValueOnce({
      ok: false,
      errorCode: 'UNSUPPORTED_CAPABILITY',
      message: 'soft stop unsupported',
    });

    expect(parse(await registry.call('update_session_queued_message', {
      session_id: 'target', queued_message_id: 'q', message: 'next',
    }))).toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
    expect(parse(await registry.call('stop_session_turn', {
      session_id: 'target',
    }))).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
  });
});

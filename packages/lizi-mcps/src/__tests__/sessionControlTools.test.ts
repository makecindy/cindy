import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry, type XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerControlSessionTool,
  registerCancelSessionQueuedMessageTool,
  registerGetSessionRuntimeTool,
  registerMoveSessionQueuedMessageTool,
  registerSetSessionRuntimeTool,
  registerSteerSessionQueuedMessageTool,
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
    steerQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
      ok: true as const,
      queuedMessageId,
      delivery: 'steered' as const,
    })),
    moveQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
      ok: true as const,
      queuedMessageId,
      position: 0,
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
  registerSteerSessionQueuedMessageTool(registry, deps);
  registerMoveSessionQueuedMessageTool(registry, deps);
  registerSteerSessionTool(registry, deps);
  registerStopSessionTurnTool(registry, deps);
  registerGetSessionRuntimeTool(registry, deps);
  registerSetSessionRuntimeTool(registry, deps);
  registerControlSessionTool(registry, deps);
  return { deps, registry };
}

describe('cindy_helper session control tools', () => {
  it('exposes shared execution actions only when the Host provides them', async () => {
    const { deps, registry } = setup();
    expect(parse(await registry.call('control_session', { session_id: 'target', action: 'pause' }))).toMatchObject({ ok: false });
    deps.controlSession = vi.fn(async () => ({ ok: true as const, result: { executionPaused: true } }));
    registerControlSessionTool(registry, deps);
    expect(parse(await registry.call('control_session', { session_id: 'target', action: 'pause' })))
      .toMatchObject({ ok: true, action: 'pause', result: { executionPaused: true } });
    expect(parse(await registry.call('control_session', { session_id: 'target', action: 'pause', instructions: 'summary' })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });
  // Unit / queue capability contract: an attested plugin has no task identity.
  // The old entry rejected every mutation with NO_SESSION_CONTEXT before reaching the queue owner.
  it.each(['update', 'cancel', 'steer', 'move'] as const)('allows plugin %s through the existing queue tool', async action => {
    const { deps, registry } = setup({ sessionId: undefined });
    deps.getSessionContext = () => ({ agentKind: 'codex', workingDir: '', hostCaller: {
      kind: 'plugin', pluginId: 'p', dataOwnerId: 'owner', ownerGeneration: 1,
    } });
    const result = await registry.call(`${action}_session_queued_message`, {
      session_id: 'target', queued_message_id: 'queued-1',
      ...(action === 'update' ? { message: 'edited' } : {}),
      ...(action === 'move' ? { position: 0 } : {}),
    });
    expect(parse(result)).toMatchObject({ ok: true, queued_message_id: 'queued-1' });
    const mutation = { update: deps.updateQueuedMessage, cancel: deps.cancelQueuedMessage,
      steer: deps.steerQueuedMessage, move: deps.moveQueuedMessage }[action]!;
    expect(mutation).toHaveBeenCalledWith(expect.objectContaining({
      callerSessionId: undefined, targetSessionId: 'target', queuedMessageId: 'queued-1',
    }));
  });

  // Unit #9801/uKm_: the production tool must retain partial-application facts
  // in its existing error payload; prior tests only covered successful runtime results.
  it('returns an error with the applied runtime and original permission failure', async () => {
    const { deps, registry } = setup();
    const data = { runtime: { status: 'applied', generation: 7, fields: ['model'] }, failed: 'permission_mode',
      original_error: { code: 'WRITE_FAILED', message: 'permission persistence failed' } };
    deps.setSessionRuntime = vi.fn(async () => ({ ok: false as const, errorCode: 'INTERNAL' as const,
      message: 'Model applied; permission update failed. Read get_session_runtime before retrying.', data }));
    const result = await registry.call('set_session_runtime', { session_id: 'target', expected_generation: 0, model: 'next', permission_mode: 'auto' });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INTERNAL', data });
  });

  // Unit parity #16: the schema previously discarded permission_mode, making a permission-only
  // request fail. Drive the production dispatcher, not a copied schema.
  it('accepts a permission profile through the existing runtime update', async () => {
    const { deps, registry } = setup();
    expect(parse(await registry.call('set_session_runtime', { session_id: 'target', expected_generation: 1, permission_mode: 'bypassPermissions' })))
      .toMatchObject({ ok: true });
    expect(deps.setSessionRuntime).toHaveBeenCalledWith({ targetSessionId: 'target', expectedGeneration: 1, patch: { permissionMode: 'bypassPermissions' } });
  });

  it('allows an attested plugin to steer an explicit target without a caller task', async () => {
    const { deps, registry } = setup({ sessionId: undefined });
    deps.getSessionContext = () => ({ agentKind: 'codex', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'p', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(parse(await registry.call('steer_session', { session_id: 'target', message: 'continue' }))).toMatchObject({ ok: true, steered: true });
    expect(deps.steerSession).toHaveBeenCalledWith({ callerSessionId: undefined, targetSessionId: 'target', message: 'continue' });
  });

  it('forwards a complete harness selection and reports the next-send boundary', async () => {
    const { deps, registry } = setup();
    const old = { agentKind: 'claude-code' as const, model: 'claude-fable-5', providerId: null, effort: 'high' as const, fastMode: false };
    vi.mocked(deps.setSessionRuntime).mockResolvedValueOnce({
      ok: true, status: 'deferred', effectiveBoundary: 'next_send', generation: 2,
      effectiveProfile: old,
      pendingMutation: { generation: 2, source: 'agent', profile: { ...old, agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' } },
    });
    expect(parse(await registry.call('set_session_runtime', {
      session_id: 'target', harness: 'codex', model: 'gpt-6-astra', provider_id: 'openai', expected_generation: 1,
    }))).toMatchObject({
      ok: true, effective_boundary: 'next_send', effective: { harness: 'claude-code' },
      pending: { profile: { harness: 'codex', model: 'gpt-6-astra' } },
    });
    expect(deps.setSessionRuntime).toHaveBeenCalledWith({ targetSessionId: 'target', expectedGeneration: 1,
      patch: { harness: 'codex', model: 'gpt-6-astra', providerId: 'openai' } });
  });

  it.each([{ harness: 'codex' }, { harness: 'unknown', model: 'gpt-6-astra' }])('rejects invalid complete selection %j', async (patch) => {
    const { deps, registry } = setup();
    expect(parse(await registry.call('set_session_runtime', { ...patch, expected_generation: 1 }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.setSessionRuntime).not.toHaveBeenCalled();
  });

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
    // expected_generation 已是 schema 必填(#3535):带上合法值,隔离验证
    // 会话上下文缺失的分支。
    const { registry } = setup({ sessionId: undefined });
    expect(
      parse(await registry.call('set_session_runtime', { effort: 'high', expected_generation: 1 })),
    ).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
  });

  it('requires a read-before-write generation token', async () => {
    // #3535:schema 曾标 optional 而 handler 强制必传 —— 契约矛盾让缺参调用
    // 只拿到裸 INVALID_ARGS。现在 schema 即必填:zod 层拒绝并回吐 schema 与
    // 校验明细,调用方一轮自纠。
    const { registry } = setup();
    const result = parse(await registry.call('set_session_runtime', { effort: 'high' }));
    const data = result.data as Record<string, unknown> | undefined;
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(JSON.stringify(data?.validation_errors ?? result)).toContain('expected_generation');
    expect(data?.schema).toBeTruthy();
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
      ['steer_session_queued_message', { session_id: 'target', queued_message_id: 'q' }],
      ['move_session_queued_message', { session_id: 'target', queued_message_id: 'q', position: 0 }],
      ['steer_session', { session_id: 'target', message: 'urgent context' }],
    ] as const) {
      expect(parse(await registry.call(name, args))).toMatchObject({
        ok: false,
        errorCode: 'NO_SESSION_CONTEXT',
      });
    }
    expect(deps.updateQueuedMessage).not.toHaveBeenCalled();
    expect(deps.cancelQueuedMessage).not.toHaveBeenCalled();
    expect(deps.steerQueuedMessage).not.toHaveBeenCalled();
    expect(deps.moveQueuedMessage).not.toHaveBeenCalled();
    expect(deps.steerSession).not.toHaveBeenCalled();
  });

  it('converts a queued message to a steer and reports a retained fallback reason', async () => {
    const { deps, registry } = setup();

    expect(parse(await registry.call('steer_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'queued-1',
    }))).toEqual({
      ok: true,
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      delivery: 'steered',
    });
    expect(deps.steerQueuedMessage).toHaveBeenCalledWith({
      callerSessionId: 'caller-session',
      targetSessionId: 'target-session',
      queuedMessageId: 'queued-1',
    });

    vi.mocked(deps.steerQueuedMessage).mockResolvedValueOnce({
      ok: true,
      queuedMessageId: 'queued-2',
      delivery: 'queued',
      reason: 'STEER_UNCERTAIN',
    });
    expect(parse(await registry.call('steer_session_queued_message', {
      session_id: 'caller-session',
      queued_message_id: 'queued-2',
    }))).toEqual({
      ok: true,
      session_id: 'caller-session',
      queued_message_id: 'queued-2',
      delivery: 'queued',
      reason: 'STEER_UNCERTAIN',
    });

    vi.mocked(deps.steerQueuedMessage).mockResolvedValueOnce({
      ok: false,
      errorCode: 'NOT_AUTHORIZED',
      message: 'user message',
    });
    expect(parse(await registry.call('steer_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'user-1',
    }))).toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
  });

  it('moves a queued message and returns the final position', async () => {
    const { deps, registry } = setup();
    vi.mocked(deps.moveQueuedMessage).mockResolvedValueOnce({
      ok: true,
      queuedMessageId: 'queued-1',
      position: 3,
    });

    expect(parse(await registry.call('move_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      position: 10,
    }))).toEqual({
      ok: true,
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      position: 3,
    });
    expect(deps.moveQueuedMessage).toHaveBeenCalledWith({
      callerSessionId: 'caller-session',
      targetSessionId: 'target-session',
      queuedMessageId: 'queued-1',
      position: 10,
    });

    expect(parse(await registry.call('move_session_queued_message', {
      session_id: 'target-session',
      queued_message_id: 'queued-1',
      position: -1,
    }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.moveQueuedMessage).toHaveBeenCalledTimes(1);
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

  // Value: production MCP contract for provider_device_id switching (plus agent_device_id alias),
  // privacy-safe route_source projection, and last_route_change attribution.
  // Gap: prior tests only exercised local model/harness switches without device or attribution fields.
  // Minimal input: location-only patch, local normalization, alias conflict, share source + route change.
  // Tier: unit.
  it('supports provider_device_id switching and projects route_source and last_route_change', async () => {
    const { deps, registry } = setup();
    const baseProfile = {
      agentDeviceId: null,
      agentKind: 'claude-code' as const,
      model: 'claude-opus-4-6',
      providerId: 'anthropic',
      effort: 'high' as const,
      fastMode: false,
    };
    const remoteProfile = {
      ...baseProfile,
      agentDeviceId: 'mac-studio',
      providerId: 'anthropic',
    };
    vi.mocked(deps.setSessionRuntime).mockResolvedValueOnce({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      generation: 3,
      effectiveProfile: baseProfile,
      pendingMutation: { generation: 3, source: 'agent', profile: remoteProfile },
    });

    const moved = parse(await registry.call('set_session_runtime', {
      session_id: 'target',
      provider_device_id: 'mac-studio',
      expected_generation: 2,
    }));
    expect(moved).toMatchObject({
      ok: true,
      effective_boundary: 'next_send',
      effective: { provider_device_id: 'local' },
      pending: { profile: { provider_device_id: 'mac-studio', harness: 'claude-code' } },
    });
    expect(deps.setSessionRuntime).toHaveBeenCalledWith({
      targetSessionId: 'target',
      expectedGeneration: 2,
      patch: { agentDeviceId: 'mac-studio' },
    });

    // Compat alias `agent_device_id: "local"` normalizes to null.
    vi.mocked(deps.setSessionRuntime).mockResolvedValueOnce({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      generation: 4,
      effectiveProfile: remoteProfile,
      pendingMutation: { generation: 4, source: 'agent', profile: baseProfile },
    });
    const backLocal = parse(await registry.call('set_session_runtime', {
      session_id: 'target',
      agent_device_id: 'local',
      expected_generation: 3,
    }));
    expect(backLocal).toMatchObject({
      ok: true,
      effective: { provider_device_id: 'mac-studio' },
      pending: { profile: { provider_device_id: 'local' } },
    });
    expect(deps.setSessionRuntime).toHaveBeenLastCalledWith({
      targetSessionId: 'target',
      expectedGeneration: 3,
      patch: { agentDeviceId: null },
    });

    // Conflicting aliases fail closed before reaching host.
    expect(parse(await registry.call('set_session_runtime', {
      session_id: 'target',
      provider_device_id: 'mac-studio',
      agent_device_id: 'mac-mini',
      expected_generation: 4,
    }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.setSessionRuntime).toHaveBeenCalledTimes(2);

    // get_session_runtime exposes provider_device_id, privacy-safe route_source, and last_route_change.
    vi.mocked(deps.getSessionRuntime).mockResolvedValueOnce({
      ok: true,
      runtime: {
        sessionId: 'target',
        phase: 'idle',
        recordStatus: 'active',
        attention: false,
        workflow: null,
        source: 'persisted',
        turnGeneration: null,
        startedAtMs: null,
        lastActivityAtMs: null,
        currentActionSummary: null,
        gracefulStopState: 'none',
        runtimeGeneration: 4,
        baselineProfile: remoteProfile,
        effectiveProfile: { ...baseProfile, agentDeviceId: 'share:team-1', agentKind: 'codex', model: 'gpt-5.6', providerId: 'openai' },
        pendingMutation: null,
        fallbackEnabled: true,
        routeSource: {
          kind: 'share',
          providerDeviceId: 'share:team-1',
          providerDeviceName: null,
          managedBy: 'model-group',
        },
        lastRouteChange: {
          at: '2026-11-28T10:00:00.000Z',
          by: 'model-group',
          reason: 'provider_safety_refusal',
          from: { agentKind: 'claude-code', model: 'claude-opus-4-6', providerId: 'anthropic', agentDeviceId: null },
          to: { agentKind: 'codex', model: 'gpt-5.6', providerId: 'openai', agentDeviceId: 'share:team-1' },
        },
      },
    });
    expect(parse(await registry.call('get_session_runtime', { session_id: 'target' }))).toMatchObject({
      ok: true,
      baseline: { provider_device_id: 'mac-studio' },
      effective: { harness: 'codex', model: 'gpt-5.6', provider_device_id: 'share:team-1' },
      route_source: {
        kind: 'share',
        provider_device_id: 'share:team-1',
        provider_device_name: null,
        managed_by: 'model-group',
      },
      last_route_change: {
        at: '2026-11-28T10:00:00.000Z',
        by: 'model-group',
        reason: 'provider_safety_refusal',
        from: { harness: 'claude-code', model: 'claude-opus-4-6', provider_id: 'anthropic', provider_device_id: 'local' },
        to: { harness: 'codex', model: 'gpt-5.6', provider_id: 'openai', provider_device_id: 'share:team-1' },
      },
    });
  });
});

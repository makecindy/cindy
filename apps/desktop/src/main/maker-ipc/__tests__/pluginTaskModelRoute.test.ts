/**
 * Regression coverage for plugin task `setModel` and `readSession` across plugin-engine (`acp`)
 * boundaries.
 *
 * Test value:
 * - Production entrypoints: `applyPluginTaskModelRoute` (called by `pluginTaskService.setModel`)
 *   and `resolvePluginTaskReadRoute` (called by `pluginTaskService.readSession`).
 * - Observable results: same-engine ACP model/effort changes apply directly instead of hitting
 *   `performSessionAgentSwitch`'s same-engine no-op; cross-engine ACP transitions stage via
 *   `performSessionAgentSwitch`; `readSession` projects agent-staged ACP pending intents so
 *   `setModel` and the first `tasks.send` agree on route and revision before and after landing.
 * - Minimal failure inputs: (1) ACP task changing model/effort within the same engine, (2)
 *   built-in <-> ACP cross-engine switch followed by read before and after send, (3) returning
 *   to a built-in harness while an ACP switch is staged.
 * - Tier: unit.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyPluginTaskModelRoute,
  resolvePluginTaskReadRoute,
  type PluginTaskModelRouteWriterDeps,
} from '../pluginTaskModelRoute.js';
import type { PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler.js';

const ACP_ENGINE_A = 'acp-plugin:antigravity:agy';
const ACP_ENGINE_B = 'acp-plugin:dsh-acp:dsh';

function makeWriterDeps(
  overrides: Partial<PluginTaskModelRouteWriterDeps> = {},
): PluginTaskModelRouteWriterDeps {
  return {
    readTaskRow: vi.fn(async () => ({
      agentKind: 'acp',
      providerId: ACP_ENGINE_A,
      agentDeviceId: null,
    })),
    readPendingSwitch: vi.fn(() => undefined),
    performAgentSwitch: vi.fn(async () => ({ deferred: true })),
    applySamePluginEngineModel: vi.fn(async () => ({ deferred: false, superseded: false })),
    commitPermissionMode: vi.fn(async () => {}),
    getBuiltinSessionRuntime: vi.fn(async () => ({
      ok: true as const,
      runtime: {
        runtimeGeneration: 1,
        effectiveProfile: {
          agentKind: 'codex' as const,
          model: 'gpt-5.4',
          providerId: 'openai',
          effort: 'medium' as const,
          fastMode: false,
          agentDeviceId: null,
        },
        pendingMutation: null,
      },
    })),
    setBuiltinSessionRuntime: vi.fn(async () => ({ ok: true as const, status: 'applied' as const })),
    setBuiltinPermissionMode: vi.fn(async () => ({ ok: true as const, status: 'applied' as const })),
    applyPendingSwitchIfIdle: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('applyPluginTaskModelRoute', () => {
  it('applies same-engine ACP model and effort changes directly instead of no-oping through performAgentSwitch', async () => {
    const deps = makeWriterDeps();
    const assertUnchanged = vi.fn(async () => {});

    const result = await applyPluginTaskModelRoute(
      deps,
      'task-1',
      {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: 'high',
        fastMode: false,
      },
      assertUnchanged,
      'auto',
    );

    expect(result).toEqual({ status: 'applied' });
    expect(deps.performAgentSwitch).not.toHaveBeenCalled();
    expect(deps.applySamePluginEngineModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'task-1',
      model: 'gemini-4-pro',
      providerId: ACP_ENGINE_A,
      effort: 'high',
      beforeMutation: assertUnchanged,
    });
    expect(deps.commitPermissionMode).toHaveBeenCalledExactlyOnceWith('task-1', 'auto', assertUnchanged);
  });

  it('clears a stale pending switch before applying a same-engine ACP model update', async () => {
    const pending: PendingAgentSwitchIntent = {
      targetAgentKind: 'codex',
      model: 'gpt-5.4',
      providerId: 'openai',
      runtimeSource: 'agent',
    };
    const deps = makeWriterDeps({
      readPendingSwitch: vi.fn(() => pending),
      performAgentSwitch: vi.fn(async () => ({ deferred: false })),
    });
    const assertUnchanged = vi.fn(async () => {});

    const result = await applyPluginTaskModelRoute(
      deps,
      'task-1',
      {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-flash',
        effort: 'low',
        fastMode: false,
      },
      assertUnchanged,
    );

    expect(result).toEqual({ status: 'applied' });
    expect(deps.performAgentSwitch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'task-1',
      targetAgentKind: 'acp',
      providerId: ACP_ENGINE_A,
      model: 'gemini-4-flash',
      effort: 'low',
      fastMode: false,
      agentDeviceId: null,
    }));
    expect(deps.applySamePluginEngineModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'task-1',
      model: 'gemini-4-flash',
      effort: 'low',
    }));
  });

  it.each([
    [
      'different ACP engine',
      { agentKind: 'acp', providerId: ACP_ENGINE_A, agentDeviceId: null },
      { agentKind: 'acp' as const, providerId: ACP_ENGINE_B, model: 'deepseek-v4', effort: 'high', fastMode: false },
      { targetAgentKind: 'acp', providerId: ACP_ENGINE_B, agentDeviceId: null },
    ],
    [
      'same ACP engine on another computer',
      { agentKind: 'acp', providerId: ACP_ENGINE_A, agentDeviceId: null },
      { agentKind: 'acp' as const, providerId: ACP_ENGINE_A, model: 'gemini-4-pro', effort: 'high', fastMode: false, agentDeviceId: 'mac-mini' },
      { targetAgentKind: 'acp', providerId: ACP_ENGINE_A, agentDeviceId: 'mac-mini' },
    ],
    [
      'built-in to ACP',
      { agentKind: 'codex', providerId: 'openai', agentDeviceId: null },
      { agentKind: 'acp' as const, providerId: ACP_ENGINE_A, model: 'gemini-4-pro', effort: 'high', fastMode: false },
      { targetAgentKind: 'acp', providerId: ACP_ENGINE_A, agentDeviceId: null },
    ],
    [
      'ACP to built-in',
      { agentKind: 'acp', providerId: ACP_ENGINE_A, agentDeviceId: 'mac-mini' },
      { agentKind: 'cc' as const, providerId: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', fastMode: true },
      { targetAgentKind: 'claude-code', providerId: 'anthropic', agentDeviceId: null },
    ],
  ])('stages cross-boundary switch (%s) via performAgentSwitch', async (_label, taskRow, route, expected) => {
    const deps = makeWriterDeps({ readTaskRow: vi.fn(async () => taskRow) });
    const assertUnchanged = vi.fn(async () => {});

    const result = await applyPluginTaskModelRoute(deps, 'task-1', route, assertUnchanged);

    expect(result).toEqual({ status: 'deferred' });
    expect(deps.applySamePluginEngineModel).not.toHaveBeenCalled();
    expect(deps.performAgentSwitch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'task-1',
      ...expected,
    }));
  });

  it('forces harness selection when superseding a staged ACP switch back to the current built-in harness', async () => {
    const deps = makeWriterDeps({
      readTaskRow: vi.fn(async () => ({ agentKind: 'codex', providerId: 'openai', agentDeviceId: null })),
      readPendingSwitch: vi.fn((): PendingAgentSwitchIntent => ({
        targetAgentKind: 'acp',
        model: 'gemini-4-pro',
        providerId: ACP_ENGINE_A,
        runtimeSource: 'agent',
      })),
    });
    const assertUnchanged = vi.fn(async () => {});

    await applyPluginTaskModelRoute(
      deps,
      'task-1',
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.4', effort: 'high', fastMode: false },
      assertUnchanged,
    );

    expect(deps.setBuiltinSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ harness: 'codex', model: 'gpt-5.4', effort: 'high' }),
    }));
  });
});

describe('resolvePluginTaskReadRoute', () => {
  it('projects a staged built-in -> ACP switch so readSession matches the route that lands on send', () => {
    const beforeSend = resolvePluginTaskReadRoute({
      row: {
        agentKind: 'codex',
        providerId: 'openai',
        model: 'gpt-5.4',
        effort: 'medium',
        fastMode: true,
        agentDeviceId: null,
      },
      runtime: {
        effective: {
          agentKind: 'codex',
          providerId: 'openai',
          model: 'gpt-5.4',
          effort: 'medium',
          fastMode: true,
          agentDeviceId: null,
        },
        pendingMutation: null,
      },
      pendingSwitch: {
        targetAgentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: 'high',
        fastMode: false,
        targetAgentDeviceId: 'mac-mini',
        runtimeSource: 'agent',
      },
    });

    const afterSendLands = resolvePluginTaskReadRoute({
      row: {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: 'high',
        fastMode: false,
        agentDeviceId: 'mac-mini',
      },
      runtime: null,
      pendingSwitch: undefined,
    });

    expect(beforeSend).toEqual({
      hasPendingRoute: true,
      resolvedConfig: {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: 'high',
        fastMode: false,
        agentDeviceId: 'mac-mini',
      },
    });
    expect(beforeSend.resolvedConfig).toEqual(afterSendLands.resolvedConfig);
  });

  it('projects a staged ACP -> built-in switch (including explicit local targetAgentDeviceId: null)', () => {
    const beforeSend = resolvePluginTaskReadRoute({
      row: {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: 'high',
        fastMode: false,
        agentDeviceId: 'mac-mini',
      },
      runtime: null,
      pendingSwitch: {
        targetAgentKind: 'claude-code',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        effort: 'medium',
        fastMode: true,
        targetAgentDeviceId: null,
        runtimeSource: 'agent',
      },
    });

    expect(beforeSend).toEqual({
      hasPendingRoute: true,
      resolvedConfig: {
        agentKind: 'cc',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        effort: 'medium',
        fastMode: true,
      },
    });
  });

  it('ignores internal resumeFallbackRecovery intents and keeps the current ACP row route', () => {
    const projected = resolvePluginTaskReadRoute({
      row: {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: '',
        fastMode: false,
        agentDeviceId: null,
      },
      runtime: null,
      pendingSwitch: {
        targetAgentKind: 'codex',
        providerId: 'openai',
        model: 'gpt-5.4',
        runtimeSource: 'agent',
        resumeFallbackRecovery: {
          boundaryClientId: null,
          boundaryContent: {
            fromAgentKind: 'acp',
            toAgentKind: 'codex',
            fromModel: 'gemini-4-pro',
            toModel: 'gpt-5.4',
            fromSdkSessionId: null,
            handoff: 'recovery',
          },
          handoff: 'recovery',
        },
      },
    });

    expect(projected).toEqual({
      hasPendingRoute: false,
      resolvedConfig: {
        agentKind: 'acp',
        providerId: ACP_ENGINE_A,
        model: 'gemini-4-pro',
        effort: '',
        fastMode: false,
      },
    });
  });
});

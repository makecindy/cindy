import { describe, expect, it, vi } from 'vitest';
import { createStagePendingUserRuntimeAxis } from '../sessionRuntimeAxisSettings.js';
import type { MakerSessionAgentSwitchHandlerDeps, PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler.js';

const ENGINE = 'acp-plugin:antigravity:agy';

// 2026-11-27 regression: adjusting effort on a pending switch to a plugin engine on another computer
// called local admitPluginEngineTarget and failed on computers without that plugin installed.
// Coverage gap: sessionRuntimeAxisSettings had no direct unit coverage for remote plugin engine
// pending intents. Minimal failing input: pending intent with targetAgentKind 'acp',
// targetAgentDeviceId 'studio', and no local admitPluginEngineTarget. Tier: unit.
describe('createStagePendingUserRuntimeAxis (plugin engine remote target)', () => {
  function setup(overrides: Partial<MakerSessionAgentSwitchHandlerDeps> = {}) {
    const pending = new Map<string, PendingAgentSwitchIntent>();
    const onPendingSwitchChanged = vi.fn();
    const wakeSessionInputAfterCredentialSwitch = vi.fn();
    const admitPluginEngineTarget = vi.fn();
    const admitRemotePluginEngineTarget = vi.fn(async (_deviceId: string, target: { model: string; effort?: string }) => ({
      model: target.model,
      effort: target.effort === 'high' || target.effort === 'max' ? target.effort : '',
      permissionMode: 'default' as const,
      engineName: 'Antigravity',
    }));
    const agentSwitchDeps = {
      getSessionRow: vi.fn(async () => ({
        id: 's1',
        status: 'active',
        agentKind: 'cc',
        model: 'claude-sonnet-4',
        providerId: null,
        agentDeviceId: null,
        remoteHostId: null,
        orcaRole: null,
        sdkSessionId: 'sdk-1',
        permissionMode: 'default',
      })),
      admitPluginEngineTarget,
      admitRemotePluginEngineTarget,
      onPendingSwitchChanged,
      ...overrides,
    } as unknown as MakerSessionAgentSwitchHandlerDeps;

    const stage = createStagePendingUserRuntimeAxis({
      agentSwitchDeps,
      readUsableAgentDeviceProviders: vi.fn(async () => []),
      agentSwitchPending: {
        set: (id: string, intent: PendingAgentSwitchIntent) => { pending.set(id, intent); },
      } as never,
      getDesktopProviderService: () => ({ listProviders: async () => [] }) as never,
      persistSessionFields: vi.fn(async () => {}),
      wakeSessionInputAfterCredentialSwitch,
    });
    return { stage, pending, admitPluginEngineTarget, admitRemotePluginEngineTarget, onPendingSwitchChanged };
  }

  const remoteIntent: PendingAgentSwitchIntent = {
    targetAgentKind: 'acp',
    model: 'gemini-4-neon',
    providerId: ENGINE,
    targetAgentDeviceId: 'studio',
    effort: 'high',
    fastMode: false,
  };

  it('admits effort changes against the remote device instead of the local plugin registry', async () => {
    const { stage, pending, admitPluginEngineTarget, admitRemotePluginEngineTarget, onPendingSwitchChanged } = setup({
      admitPluginEngineTarget: undefined,
    });

    const result = await stage('s1', remoteIntent, { effort: 'max' }, vi.fn());

    expect(result).toEqual({ deferred: true, pendingUntilSend: true });
    expect(admitPluginEngineTarget).not.toHaveBeenCalled();
    expect(admitRemotePluginEngineTarget).toHaveBeenCalledWith('studio', {
      providerId: ENGINE,
      model: 'gemini-4-neon',
      effort: 'max',
      permissionMode: 'default',
    });
    expect(pending.get('s1')).toMatchObject({ targetAgentKind: 'acp', targetAgentDeviceId: 'studio', effort: 'max', fastMode: false });
    expect(onPendingSwitchChanged).toHaveBeenCalledOnce();
  });

  it('rejects unsupported effort levels on the remote plugin engine with INVALID_PARAMS', async () => {
    const { stage, pending } = setup();

    await expect(stage('s1', remoteIntent, { effort: 'minimal' }, vi.fn()))
      .rejects.toThrow('[INVALID_PARAMS]');
    expect(pending.has('s1')).toBe(false);
  });

  it('fails closed with PRECONDITION_FAILED when remote plugin engine admission is unavailable', async () => {
    const { stage } = setup({ admitRemotePluginEngineTarget: undefined });

    await expect(stage('s1', remoteIntent, { effort: 'max' }, vi.fn()))
      .rejects.toThrow('[PRECONDITION_FAILED]');
  });
});

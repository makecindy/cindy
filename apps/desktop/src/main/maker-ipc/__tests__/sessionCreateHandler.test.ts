import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerMakerSessionCreateHandler } from '../sessionCreateHandler';
import { IpcHarness } from './helpers/ipcHarness';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';

function createSessionStub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    agentKind: 'codex',
    workDir: 'C:\\repo',
    capabilities: { sameTurnSteer: { supported: true } },
    ...overrides,
  };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    bootstrapSession: vi.fn().mockResolvedValue({
      session: createSessionStub(),
      didInjectOrcaInstructions: false,
      didInjectProjectContext: true,
    }),
    markOrcaRoleIfNeeded: vi.fn(),
    markKnownNonOrcaIfApplicable: vi.fn(),
    sendWorkerReadyMessage: vi.fn(),
    broadcastSessionCreated: vi.fn(),
    logCreateSession: vi.fn(),
    warnStderr: vi.fn(),
    ...overrides,
  };
}

describe('maker session CREATE_SESSION IPC handler', () => {
  it('bootstraps a session and returns the public create-session payload', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
        workspaceKind: 'dialogue',
      }),
    ).resolves.toEqual({
      sessionId: 'session-1',
      agentKind: 'codex',
      workDir: 'C:\\repo',
      capabilities: { sameTurnSteer: { supported: true } },
      usedProjectContext: true,
    });

    expect(deps.bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
        workspaceKind: 'dialogue',
        vendorOptions: expect.objectContaining({ onStderrLine: expect.any(Function) }),
      }),
    );
    expect(deps.logCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'gpt-5.4',
        workDir: 'C:\\repo',
        usedProjectContext: true,
      }),
    );
    expect(deps.markKnownNonOrcaIfApplicable).toHaveBeenCalled();
    expect(deps.broadcastSessionCreated).toHaveBeenCalledWith('session-1');
  });

  it('allocates a controlled dialogue workspace before bootstrapping folderless dialogue sessions', async () => {
    const harness = new IpcHarness();
    const allocateDialogueWorkspace = vi.fn(
      (sessionId: string, nowMs: number) => `/userData/dialogues/${nowMs}/${sessionId}`,
    );
    const bootstrapSession = vi.fn(async (opts: { id?: string; workingDir: string }) => ({
      session: createSessionStub({ id: opts.id, workDir: opts.workingDir }),
      didInjectOrcaInstructions: false,
      didInjectProjectContext: false,
    }));
    const deps = createDeps({
      allocateDialogueWorkspace,
      bootstrapSession,
      createSessionId: () => 'dialogue-session-1',
      now: () => 1710000000000,
    });
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'codex',
        workspaceKind: 'dialogue',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      sessionId: 'dialogue-session-1',
      agentKind: 'codex',
      workDir: '/userData/dialogues/1710000000000/dialogue-session-1',
      capabilities: { sameTurnSteer: { supported: true } },
      usedProjectContext: false,
    });

    expect(allocateDialogueWorkspace).toHaveBeenCalledWith('dialogue-session-1', 1710000000000);
    expect(bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'dialogue-session-1',
        workspaceKind: 'dialogue',
        workingDir: '/userData/dialogues/1710000000000/dialogue-session-1',
      }),
    );
  });

  it('rejects invalid create-session payloads before bootstrapping', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'codex',
        workingDir: 'C:\\repo',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('maps credential mode busy from bootstrap to CREDENTIAL_SWITCH_BUSY', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      bootstrapSession: vi
        .fn()
        .mockRejectedValue(new CredentialModeSwitchBusyError(['busy-session'])),
    });
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_SWITCH_BUSY' });

    expect(deps.broadcastSessionCreated).not.toHaveBeenCalled();
    expect(deps.sendWorkerReadyMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['[REMOTE_PROVIDER_UPDATING] provider "p" credentials are being updated; retry in a moment', 'REMOTE_PROVIDER_UPDATING'],
    ['[REMOTE_PROVIDER_UNSUPPORTED] provider "p" has no claude-code route on this desktop', 'REMOTE_PROVIDER_UNSUPPORTED'],
    ['[REMOTE_NATIVE_OAUTH_UNAVAILABLE] Anthropic subscription is not connected on this desktop', 'REMOTE_NATIVE_OAUTH_UNAVAILABLE'],
  ])('maps remote route error %s to %s', async (message, code) => {
    const harness = new IpcHarness();
    const deps = createDeps({
      bootstrapSession: vi.fn().mockRejectedValue(new Error(message)),
    });
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'claude-code',
        workingDir: 'C:\\repo',
        model: 'claude-opus-4-6',
      }),
    ).rejects.toMatchObject({ code });
  });

  it('rethrows non-remote errors unchanged', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      bootstrapSession: vi.fn().mockRejectedValue(new Error('some other failure')),
    });
    registerMakerSessionCreateHandler(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
        agentKind: 'claude-code',
        workingDir: 'C:\\repo',
        model: 'claude-opus-4-6',
      }),
    ).rejects.toThrow('some other failure');
  });

  it('preserves explicit providerId=null through create-session parsing', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerMakerSessionCreateHandler(harness, deps);

    await harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      providerId: null,
    });

    expect(deps.bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: null,
      }),
    );
  });

  it('marks lead role inside create-session', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerMakerSessionCreateHandler(harness, deps);

    await harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      orcaRole: 'lead',
    });
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledWith('session-1', 'lead');
  });

  it('does not mark worker role until addWorker creates the team link', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();

    registerMakerSessionCreateHandler(harness, deps);

    await harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      orcaRole: 'worker',
    });
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.sendWorkerReadyMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
    );
  });

  it('runs an explicit-id create transaction under the injected session lock', async () => {
    const harness = new IpcHarness();
    const order: string[] = [];
    const withSessionLock = vi.fn(async (sessionId: string, task: () => Promise<unknown>) => {
      order.push(`lock:${sessionId}:start`);
      const result = await task();
      order.push(`lock:${sessionId}:end`);
      return result;
    });
    const deps = createDeps({
      withSessionLock,
      bootstrapSession: vi.fn(async (opts: { id?: string }) => {
        order.push(`bootstrap:${opts.id}`);
        return {
          session: createSessionStub({ id: opts.id }),
          didInjectOrcaInstructions: false,
          didInjectProjectContext: false,
        };
      }),
    });
    registerMakerSessionCreateHandler(harness, deps);

    await harness.invoke(MAKER_INVOKE.CREATE_SESSION, {
      id: 'preset-session-1',
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
    });

    expect(withSessionLock).toHaveBeenCalledWith('preset-session-1', expect.any(Function));
    expect(order).toEqual([
      'lock:preset-session-1:start',
      'bootstrap:preset-session-1',
      'lock:preset-session-1:end',
    ]);
  });
});

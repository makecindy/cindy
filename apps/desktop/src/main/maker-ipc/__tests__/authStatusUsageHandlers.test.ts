import type { AuthState, Maker } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { parseCodexDeviceCodeProgress, registerMakerAuthHandlers } from '../authHandlers';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { registerMakerStatusHandlers } from '../statusHandlers';
import { registerMakerUsageHandlers } from '../usageHandlers';
import { CodexRateLimitResetRejectedError } from '../../usage/codexRateLimitReset';
import { IpcHarness } from './helpers/ipcHarness';
import { zeroUsageMoney } from '../../../shared/regionalMoney';

function createMakerStub(methods: Partial<Maker>): Maker {
  return methods as Maker;
}

describe('maker auth IPC handlers', () => {
  it('delegates auth state lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn().mockResolvedValue({ authenticated: true });

    registerMakerAuthHandlers(harness, createMakerStub({ getAgentAuthState }), vi.fn(), () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE, 'codex')).resolves.toEqual({
      authenticated: true,
    });
    expect(getAgentAuthState).toHaveBeenCalledWith('codex');
  });

  it('accepts Pi at the auth IPC boundary exposed by preload', async () => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn().mockResolvedValue({ authenticated: true });
    registerMakerAuthHandlers(harness, createMakerStub({ getAgentAuthState }), vi.fn(), () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE, 'pi')).resolves.toEqual({
      authenticated: true,
    });
    expect(getAgentAuthState).toHaveBeenCalledWith('pi');
  });

  it('normalizes login progress and broadcasts final auth state', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const refreshAgentLocalModels = vi.fn().mockResolvedValue(true);
    const triggerAgentLogin = vi
      .fn()
      .mockImplementation(
        async (_agentKind, options: { mode?: string; onProgress: (msg: string) => void }) => {
          options.onProgress('stdout:https://example.test/oauth');
          options.onProgress('stderr:waiting');
          options.onProgress('done');
          return {
            authenticated: true,
            authSource: 'oauth',
            identity: { email: 'dev@example.test' },
          };
        },
      );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(refreshAgentLocalModels).toHaveBeenCalledWith('codex');
    expect(onCodexAuthChange).toHaveBeenCalledWith(true, true, expect.any(Function));
    expect(broadcast).toHaveBeenNthCalledWith(1, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      mode: 'browser',
      detail: 'https://example.test/oauth',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      mode: 'browser',
      detail: 'waiting',
    });
    expect(broadcast).toHaveBeenNthCalledWith(3, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'done',
      mode: 'browser',
    });
    expect(broadcast).toHaveBeenNthCalledWith(4, MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
    expect(triggerAgentLogin).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ mode: 'browser' }),
    );
  });

  it('extracts a split ANSI-colored Codex device code and emits a structured progress event', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const triggerAgentLogin = vi
      .fn()
      .mockImplementation(
        async (_agentKind, options: { mode?: string; onProgress: (msg: string) => void }) => {
          options.onProgress('stdout:\u001b[1mhttps://auth.openai.com/codex/device\u001b[0m');
          options.onProgress('stderr:Enter code \u001b[32mRUH2-7E2VH\u001b[0m');
          return { authenticated: false, errorReason: 'login_cancelled' };
        },
      );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
    );

    await harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      mode: 'device-code',
    });

    expect(triggerAgentLogin).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ mode: 'device-code' }),
    );
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'device-code',
      mode: 'device-code',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'RUH2-7E2VH',
    });
  });

  it('replays the retained device code when another BrowserWindow joins the login', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    let emitProgress!: (msg: string) => void;
    let finishLogin!: (state: AuthState) => void;
    const triggerAgentLogin = vi.fn(
      (_agentKind, options: { onProgress: (msg: string) => void }) =>
        new Promise<AuthState>((resolve) => {
          emitProgress = options.onProgress;
          finishLogin = resolve;
        }),
    );
    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
    );

    const first = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      mode: 'device-code',
      ownerId: 'window-101-device-code',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    emitProgress('stdout:https://auth.openai.com/codex/device');
    emitProgress('stderr:Enter code ABCD-EFGH');
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
        agentKind: 'codex',
        phase: 'device-code',
        mode: 'device-code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      }),
    );

    broadcast.mockClear();
    const second = harness.invokeFrom(202, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      mode: 'device-code',
      ownerId: 'window-202-device-code',
    });
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
        agentKind: 'codex',
        phase: 'device-code',
        mode: 'device-code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      }),
    );
    expect(triggerAgentLogin).toHaveBeenCalledOnce();

    finishLogin({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(first).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(second).resolves.toMatchObject({ errorReason: 'login_cancelled' });
  });

  it('reassembles URL and code tokens split across arbitrary stdout chunks', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const triggerAgentLogin = vi
      .fn()
      .mockImplementation(
        async (_agentKind, options: { mode?: string; onProgress: (msg: string) => void }) => {
          options.onProgress('stdout:Open https://auth.openai.com/cod');
          options.onProgress('stdout:ex/device\nEnter code AB');
          options.onProgress('stdout:CD-EF');
          options.onProgress('stdout:GH\n');
          return { authenticated: false, errorReason: 'login_cancelled' };
        },
      );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
    );

    await harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      mode: 'device-code',
    });

    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'device-code',
      mode: 'device-code',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
  });

  it('rejects unsupported login modes and malformed owner options before invoking Maker', async () => {
    const harness = new IpcHarness();
    const triggerAgentLogin = vi.fn();
    registerMakerAuthHandlers(harness, createMakerStub({ triggerAgentLogin }), vi.fn(), () => null);

    await expect(
      harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', { mode: 'password' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'claude-code', {
        mode: 'device-code',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
        ownerId: 'contains whitespace',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(101, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
        releaseOwner: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(triggerAgentLogin).not.toHaveBeenCalled();
  });

  it('keeps login successful and requests disk fallback when live model refresh fails', async () => {
    const harness = new IpcHarness();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const triggerAgentLogin = vi
      .fn()
      .mockResolvedValue({ authenticated: true, authSource: 'oauth' });
    const refreshAgentLocalModels = vi.fn().mockRejectedValue(new Error('model/list unavailable'));

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels }),
      vi.fn(),
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toMatchObject({
      authenticated: true,
    });
    expect(onCodexAuthChange).toHaveBeenCalledWith(true, false, expect.any(Function));
  });

  it('drops a stale login refresh when a concurrent logout establishes a newer auth boundary', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    let resolveRefresh!: (value: boolean) => void;
    const refreshAgentLocalModels = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const triggerAgentLogin = vi
      .fn()
      .mockResolvedValue({ authenticated: true, authSource: 'oauth' });
    const logoutAgent = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels, logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(refreshAgentLocalModels).toHaveBeenCalledOnce());
    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).resolves.toBeUndefined();
    resolveRefresh(true);

    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'auth_mutation_superseded',
    });
    expect(onCodexAuthChange).toHaveBeenCalledTimes(1);
    expect(onCodexAuthChange).toHaveBeenCalledWith(false, false, expect.any(Function));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
    });
  });

  it('preserves cancellation while invalidating post-login refresh work', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);
    let finishRefresh!: (value: boolean) => void;
    const refreshAgentLocalModels = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'oauth',
    });
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(
      harness,
      createMakerStub({
        triggerAgentLogin,
        refreshAgentLocalModels,
        cancelAgentLogin,
        logoutAgent,
      }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(refreshAgentLocalModels).toHaveBeenCalledOnce());
    const cancel = harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex');
    finishRefresh(true);

    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(cancel).resolves.toBeUndefined();
    expect(cancelAgentLogin).toHaveBeenCalledWith('codex');
    expect(logoutAgent).toHaveBeenCalledWith('codex');
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(onCodexAuthChange).toHaveBeenCalledWith(false, false, expect.any(Function));
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('re-broadcasts authoritative auth and rejects cancel when durable cleanup fails', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn().mockRejectedValue(new Error('disconnect marker write failed'));
    const getAgentAuthState = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'oauth',
      identity: 'still-connected@example.test',
    });
    let finishRefresh!: (value: boolean) => void;
    const refreshAgentLocalModels = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'oauth',
    });
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(
      harness,
      createMakerStub({
        triggerAgentLogin,
        refreshAgentLocalModels,
        cancelAgentLogin,
        logoutAgent,
        getAgentAuthState,
      }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(refreshAgentLocalModels).toHaveBeenCalledOnce());
    const cancel = harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex');
    finishRefresh(true);

    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(cancel).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(getAgentAuthState).toHaveBeenCalledWith('codex');
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'oauth',
      identity: 'still-connected@example.test',
    });
  });

  it('reuses adapter-stage durable cancellation, then performs cache cleanup and one push', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    let finishLogin!: (state: { authenticated: false; errorReason: string }) => void;
    const triggerAgentLogin = vi.fn(
      () =>
        new Promise<{ authenticated: false; errorReason: string }>((resolve) => {
          finishLogin = resolve;
        }),
    );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, cancelAgentLogin, logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    const cancel = harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex');
    finishLogin({ authenticated: false, errorReason: 'login_cancelled' });

    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(cancel).resolves.toBeUndefined();
    expect(logoutAgent).not.toHaveBeenCalled();
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('treats Cancel with no in-flight login as a state-preserving no-op', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn();
    const onCodexAuthChange = vi.fn();

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ cancelAgentLogin, logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex')).resolves.toBeUndefined();
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    expect(logoutAgent).not.toHaveBeenCalled();
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps a shared login alive until the last BrowserWindow owner releases it', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    let finishLogin!: (state: AuthState) => void;
    const sharedLogin = new Promise<AuthState>((resolve) => {
      finishLogin = resolve;
    });
    const triggerAgentLogin = vi.fn(() => sharedLogin);

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, cancelAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const first = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-101-operation-1',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    const second = harness.invokeFrom(202, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-202-operation-1',
    });
    await Promise.resolve();
    expect(triggerAgentLogin).toHaveBeenCalledOnce();

    await expect(
      harness.invokeFrom(101, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
        releaseOwner: true,
        ownerId: 'window-101-operation-1',
      }),
    ).resolves.toBeUndefined();
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    await expect(
      harness.invokeFrom(101, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
        releaseOwner: true,
        ownerId: 'window-101-operation-1',
      }),
    ).resolves.toBeUndefined();
    expect(cancelAgentLogin).not.toHaveBeenCalled();

    const lastRelease = harness.invokeFrom(202, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
      releaseOwner: true,
      ownerId: 'window-202-operation-1',
    });
    await vi.waitFor(() => expect(cancelAgentLogin).toHaveBeenCalledOnce());
    expect(cancelAgentLogin).toHaveBeenCalledWith('codex');

    finishLogin({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(first).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(second).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(lastRelease).resolves.toBeUndefined();
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('coalesces same-mode BrowserWindow callers through one successful main finalization', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    let finishLogin!: (state: AuthState) => void;
    const triggerAgentLogin = vi.fn(
      () =>
        new Promise<AuthState>((resolve) => {
          finishLogin = resolve;
        }),
    );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
    );

    const first = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-101-success',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    const second = harness.invokeFrom(202, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-202-success',
    });
    finishLogin({ authenticated: true, authSource: 'api-key' });

    await expect(first).resolves.toEqual({ authenticated: true, authSource: 'api-key' });
    await expect(second).resolves.toEqual({ authenticated: true, authSource: 'api-key' });
    expect(triggerAgentLogin).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'api-key',
    });
  });

  it('releases login ownership when BrowserWindows are destroyed', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    let finishLogin!: (state: AuthState) => void;
    const triggerAgentLogin = vi.fn(
      () =>
        new Promise<AuthState>((resolve) => {
          finishLogin = resolve;
        }),
    );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, cancelAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const first = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-101-destroyed',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    const second = harness.invokeFrom(202, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-202-destroyed',
    });

    harness.destroySender(101);
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    harness.destroySender(202);
    expect(cancelAgentLogin).toHaveBeenCalledOnce();

    finishLogin({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(first).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(second).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await vi.waitFor(() => expect(onCodexAuthChange).toHaveBeenCalledOnce());
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('ignores a stale owner release from the same BrowserWindow', async () => {
    const harness = new IpcHarness();
    const cancelAgentLogin = vi.fn();
    let finishLogin!: (state: AuthState) => void;
    const triggerAgentLogin = vi.fn(
      () =>
        new Promise<AuthState>((resolve) => {
          finishLogin = resolve;
        }),
    );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, cancelAgentLogin }),
      vi.fn(),
      () => null,
      vi.fn().mockResolvedValue(undefined),
    );

    const login = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-101-new-operation',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    await expect(
      harness.invokeFrom(101, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
        releaseOwner: true,
        ownerId: 'window-101-old-operation',
      }),
    ).resolves.toBeUndefined();
    expect(cancelAgentLogin).not.toHaveBeenCalled();

    const release = harness.invokeFrom(101, MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex', {
      releaseOwner: true,
      ownerId: 'window-101-new-operation',
    });
    expect(cancelAgentLogin).toHaveBeenCalledOnce();
    finishLogin({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(login).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(release).resolves.toBeUndefined();
  });

  it('does not let an older Cancel cleanup disconnect a newer login', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    let finishFirst!: (state: AuthState) => void;
    let finishSecond!: (state: AuthState) => void;
    const triggerAgentLogin = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AuthState>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<AuthState>((resolve) => {
            finishSecond = resolve;
          }),
      );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, cancelAgentLogin, logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const first = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledTimes(1));
    const cancel = harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex');
    const second = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledTimes(2));

    finishFirst({ authenticated: false, errorReason: 'login_cancelled' });
    finishSecond({ authenticated: true, authSource: 'api-key' });

    await expect(first).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(cancel).resolves.toBeUndefined();
    await expect(second).resolves.toEqual({
      authenticated: true,
      authSource: 'api-key',
    });
    expect(logoutAgent).not.toHaveBeenCalled();
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'api-key',
    });
  });

  it('does not refresh Codex models when login fails', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('does not refresh Codex models for an authenticated gateway fallback', async () => {
    const harness = new IpcHarness();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'api-key',
      identity: 'API Key · Cindy AI',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      vi.fn(),
      () => 'sk-gateway',
      onCodexAuthChange,
    );

    await harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    expect(onCodexAuthChange).not.toHaveBeenCalled();
  });

  it('broadcasts logged-out state after logout', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'claude-code')).resolves.toBeUndefined();
    expect(logoutAgent).toHaveBeenCalledWith('claude-code');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'claude-code',
      authenticated: false,
    });
  });

  it('finalizes Codex auth changes before broadcasting logged-out state', async () => {
    const harness = new IpcHarness();
    const calls: string[] = [];
    const logoutAgent = vi.fn().mockImplementation(async () => {
      calls.push('logout');
    });
    const onCodexAuthChange = vi.fn().mockImplementation(async () => {
      calls.push('finalize');
    });
    const broadcast = vi.fn().mockImplementation(() => {
      calls.push('broadcast');
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).resolves.toBeUndefined();
    expect(calls).toEqual(['logout', 'finalize', 'broadcast']);
    expect(onCodexAuthChange).toHaveBeenCalledWith(false, false, expect.any(Function));
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
    });
  });

  it('finishes Codex logout cleanup before starting a login queued during logout', async () => {
    const harness = new IpcHarness();
    let finishLogout!: () => void;
    let finishFinalization!: () => void;
    const logoutAgent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    );
    const onCodexAuthChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFinalization = resolve;
        }),
    );
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent, triggerAgentLogin }),
      vi.fn(),
      () => null,
      onCodexAuthChange,
    );

    const logout = harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex');
    await vi.waitFor(() => expect(logoutAgent).toHaveBeenCalledOnce());
    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    expect(triggerAgentLogin).not.toHaveBeenCalled();

    finishLogout();
    await vi.waitFor(() => expect(onCodexAuthChange).toHaveBeenCalledOnce());
    expect(triggerAgentLogin).not.toHaveBeenCalled();

    finishFinalization();
    await expect(logout).resolves.toBeUndefined();
    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(triggerAgentLogin).toHaveBeenCalledOnce();
  });

  it('does not coalesce a new login into the operation being logged out', async () => {
    const harness = new IpcHarness();
    let finishFirstLogin!: (state: AuthState) => void;
    let finishLogout!: () => void;
    const triggerAgentLogin = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AuthState>((resolve) => {
            finishFirstLogin = resolve;
          }),
      )
      .mockResolvedValueOnce({ authenticated: true, authSource: 'api-key' });
    const logoutAgent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    );

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, logoutAgent }),
      vi.fn(),
      () => null,
      vi.fn().mockResolvedValue(undefined),
    );

    const first = harness.invokeFrom(101, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-101-before-logout',
    });
    await vi.waitFor(() => expect(triggerAgentLogin).toHaveBeenCalledOnce());
    const logout = harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex');
    await vi.waitFor(() => expect(logoutAgent).toHaveBeenCalledOnce());
    const second = harness.invokeFrom(202, MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex', {
      ownerId: 'window-202-after-logout',
    });
    expect(triggerAgentLogin).toHaveBeenCalledOnce();

    finishFirstLogin({ authenticated: false, errorReason: 'login_cancelled' });
    finishLogout();

    await expect(first).resolves.toEqual({
      authenticated: false,
      errorReason: 'auth_mutation_superseded',
    });
    await expect(logout).resolves.toBeUndefined();
    await expect(second).resolves.toEqual({ authenticated: true, authSource: 'api-key' });
    expect(triggerAgentLogin).toHaveBeenCalledTimes(2);
  });

  it('cancels a login request while it is queued behind logout finalization', async () => {
    const harness = new IpcHarness();
    let finishLogout!: () => void;
    const logoutAgent = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishLogout = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'oauth',
    });
    const cancelAgentLogin = vi.fn();

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent, triggerAgentLogin, cancelAgentLogin }),
      vi.fn(),
      () => null,
      vi.fn().mockResolvedValue(undefined),
    );

    const logout = harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex');
    await vi.waitFor(() => expect(logoutAgent).toHaveBeenCalledOnce());
    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    expect(triggerAgentLogin).not.toHaveBeenCalled();

    const cancel = harness.invoke(MAKER_INVOKE.AUTH_CANCEL_LOGIN, 'codex');
    finishLogout();

    await expect(logout).resolves.toBeUndefined();
    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    await expect(cancel).resolves.toBeUndefined();
    expect(cancelAgentLogin).toHaveBeenCalledWith('codex');
    expect(logoutAgent).toHaveBeenCalledOnce();
    expect(triggerAgentLogin).not.toHaveBeenCalled();
  });

  it('waits for a later logout that supersedes the finalization already being awaited', async () => {
    const harness = new IpcHarness();
    const logoutResolvers: Array<() => void> = [];
    const logoutAgent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          logoutResolvers.push(resolve);
        }),
    );
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent, triggerAgentLogin }),
      vi.fn(),
      () => null,
      vi.fn().mockResolvedValue(undefined),
    );

    const firstLogout = harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex');
    await vi.waitFor(() => expect(logoutAgent).toHaveBeenCalledTimes(1));
    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    const secondLogout = harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex');
    await vi.waitFor(() => expect(logoutAgent).toHaveBeenCalledTimes(2));

    logoutResolvers[0]();
    await Promise.resolve();
    expect(triggerAgentLogin).not.toHaveBeenCalled();

    logoutResolvers[1]();
    await expect(Promise.all([firstLogout, secondLogout])).resolves.toEqual([undefined, undefined]);
    await expect(login).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    expect(triggerAgentLogin).toHaveBeenCalledOnce();
  });

  it('encodes logout persistence failures as an IPC INTERNAL error without broadcasting success', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockRejectedValue(new Error('disconnect marker write failed'));
    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects missing agentKind with IPC error code', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it.each([
    MAKER_INVOKE.AUTH_GET_STATE,
    MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
    MAKER_INVOKE.AUTH_CANCEL_LOGIN,
    MAKER_INVOKE.AUTH_LOGOUT,
  ])('rejects an unknown agentKind for %s before calling Maker', async (channel) => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn();
    const triggerAgentLogin = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn();
    registerMakerAuthHandlers(
      harness,
      createMakerStub({
        getAgentAuthState,
        triggerAgentLogin,
        cancelAgentLogin,
        logoutAgent,
      }),
      vi.fn(),
      () => null,
    );

    await expect(harness.invoke(channel, 'not-an-agent')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(getAgentAuthState).not.toHaveBeenCalled();
    expect(triggerAgentLogin).not.toHaveBeenCalled();
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    expect(logoutAgent).not.toHaveBeenCalled();
  });

  it('reports api key presence without exposing the key material', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => 'sk-secret');

    await expect(harness.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: true });

    const absent = new IpcHarness();
    registerMakerAuthHandlers(absent, createMakerStub({}), vi.fn(), () => null);
    await expect(absent.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: false });
  });
});

describe('parseCodexDeviceCodeProgress', () => {
  it('returns null until both the official verification URL and code are present', () => {
    expect(parseCodexDeviceCodeProgress('https://auth.openai.com/codex/device')).toBeNull();
    expect(
      parseCodexDeviceCodeProgress(
        '\u001b[1mhttps://auth.openai.com/codex/device\u001b[0m\ncode: RUH2-7E2VH',
      ),
    ).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'RUH2-7E2VH',
    });
  });

  it('does not expose a verification URL from an untrusted host', () => {
    expect(
      parseCodexDeviceCodeProgress('https://auth.openai.com.evil.test/device\nRUH2-7E2VH'),
    ).toBeNull();
  });

  it('finds the official device page after unrelated URLs in cumulative CLI output', () => {
    expect(
      parseCodexDeviceCodeProgress(
        'Learn more at https://developers.openai.com/codex/auth\n' +
          'Open https://auth.openai.com/codex/device and enter ABCD-EFGH',
      ),
    ).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
  });

  it.each([
    ['period', 'Open https://auth.openai.com/codex/device. Code ABCD-EFGH'],
    ['comma', 'Open https://auth.openai.com/codex/device, then enter ABCD-EFGH'],
    ['closing parenthesis', '(https://auth.openai.com/codex/device) Code ABCD-EFGH'],
  ])('strips trailing prose punctuation from the verification URL (%s)', (_label, text) => {
    expect(parseCodexDeviceCodeProgress(text)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
  });

  it('keeps balanced parentheses that are part of the verification URL', () => {
    expect(
      parseCodexDeviceCodeProgress(
        'Open https://auth.openai.com/codex/device(test) and enter ABCD-EFGH',
      ),
    ).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device(test)',
      userCode: 'ABCD-EFGH',
    });
  });
});

describe('maker status IPC handlers', () => {
  it('delegates agent status lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentStatus = vi.fn().mockResolvedValue({ binaryReady: true, authReady: false });

    registerMakerStatusHandlers(harness, createMakerStub({ getAgentStatus }));

    await expect(harness.invoke(MAKER_INVOKE.AGENT_STATUS, 'codex')).resolves.toEqual({
      binaryReady: true,
      authReady: false,
    });
    expect(getAgentStatus).toHaveBeenCalledWith('codex');
  });
});

describe('maker usage IPC handlers', () => {
  const emptyHistory = {
    generatedAt: 0,
    todayKey: '2026-06-11',
    estimatesPending: false,
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: zeroUsageMoney(),
      last30Days: zeroUsageMoney(),
      last30DaysWithEstimatedValue: zeroUsageMoney(),
      last30DaysEstimatedValue: zeroUsageMoney('value-estimate'),
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };

  function makeUsageDeps(over: Record<string, unknown> = {}) {
    return {
      readAgentTodayUsage: vi.fn(),
      readCodexAccountUsageSnapshot: vi.fn(),
      readCodexRateLimits: vi.fn(),
      consumeCodexRateLimitReset: vi.fn(),
      readClaudeSubscriptionUsageSnapshot: vi.fn().mockResolvedValue(null),
      readClaudeAccountUsageSnapshot: vi.fn(),
      triggerClaudeAccountUsageRefresh: vi.fn(),
      readModelPricing: vi.fn(),
      readUsageHistory: vi.fn().mockResolvedValue(emptyHistory),
      emptyUsageHistory: vi.fn(() => emptyHistory),
      ...over,
    };
  }

  it('reads today usage through injected host dependency', async () => {
    const harness = new IpcHarness();
    const readAgentTodayUsage = vi.fn().mockResolvedValue({ day: '2026-06-10', totalTokens: 42 });

    registerMakerUsageHandlers(harness, makeUsageDeps({ readAgentTodayUsage }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_TODAY, 'codex')).resolves.toEqual({
      day: '2026-06-10',
      totalTokens: 42,
    });
    expect(readAgentTodayUsage).toHaveBeenCalledWith('codex');
  });

  it('warm-starts Claude account usage refresh when snapshot is empty', async () => {
    const harness = new IpcHarness();
    const triggerClaudeAccountUsageRefresh = vi.fn().mockResolvedValue(undefined);

    registerMakerUsageHandlers(
      harness,
      makeUsageDeps({
        readClaudeAccountUsageSnapshot: vi.fn(() => null),
        triggerClaudeAccountUsageRefresh,
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.USAGE_ACCOUNT, 'claude-code')).resolves.toBeNull();
    expect(triggerClaudeAccountUsageRefresh).toHaveBeenCalledWith(true);
  });

  it('keeps the legacy device-link pricing channel flat and USD-only', async () => {
    const harness = new IpcHarness();
    const pricing = {
      xd: {
        'claude-sonnet-4-6': {
          providerId: 'xd',
          modelId: 'claude-sonnet-4-6',
          currency: 'USD',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.3,
        },
        'claude-opus-4-6': {
          providerId: 'xd',
          modelId: 'claude-opus-4-6',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 5,
          outputPerMtok: 25,
        },
      },
    };
    const readModelPricing = vi.fn().mockResolvedValue(pricing);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readModelPricing }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_MODEL_PRICING)).resolves.toEqual({
      'claude-sonnet-4-6': {
        inputUsdPerMtok: 3,
        outputUsdPerMtok: 15,
        cacheReadUsdPerMtok: 0.3,
      },
    });
    await expect(harness.invoke(MAKER_INVOKE.USAGE_MODEL_PRICING_V2)).resolves.toEqual(pricing);
    expect(readModelPricing).toHaveBeenCalledTimes(2);
  });

  it('reads Codex reset credits and consumes only a UUID offer key', async () => {
    const harness = new IpcHarness();
    const snapshot = {
      account: { email: 'pe***@example.com', accountId: '…456789', planType: 'plus' },
      rateLimits: { planType: 'plus', primary: { usedPercent: 100 } },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
      resetOffer: {
        idempotencyKey: '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
        expiresAt: null,
        validUntil: 123,
      },
    };
    const readCodexRateLimits = vi.fn().mockResolvedValue(snapshot);
    const consumeCodexRateLimitReset = vi.fn().mockResolvedValue({
      outcome: 'reset',
      rateLimits: snapshot,
    });

    registerMakerUsageHandlers(
      harness,
      makeUsageDeps({
        readCodexRateLimits,
        consumeCodexRateLimitReset,
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS)).resolves.toEqual(snapshot);
    await expect(
      harness.invoke(
        MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
        '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
      ),
    ).resolves.toEqual({ outcome: 'reset', rateLimits: snapshot });
    expect(consumeCodexRateLimitReset).toHaveBeenCalledWith('018f4ec7-c6d8-7f10-8d43-9f8791d33000');
  });

  it('rejects arbitrary reset input before it reaches the mutation dependency', async () => {
    const harness = new IpcHarness();
    const consumeCodexRateLimitReset = vi.fn();
    registerMakerUsageHandlers(harness, makeUsageDeps({ consumeCodexRateLimitReset }));

    await expect(
      harness.invoke(MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET, 'credit-id-from-client'),
    ).rejects.toThrow(/idempotencyKey must be a UUID/);
    expect(consumeCodexRateLimitReset).not.toHaveBeenCalled();
  });

  it('encodes stale reset offers as a stable IPC precondition error', async () => {
    const harness = new IpcHarness();
    const consumeCodexRateLimitReset = vi
      .fn()
      .mockRejectedValue(new CodexRateLimitResetRejectedError('OFFER_EXPIRED', 'refresh usage'));
    registerMakerUsageHandlers(harness, makeUsageDeps({ consumeCodexRateLimitReset }));

    await expect(
      harness.invoke(
        MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
        '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('OFFER_EXPIRED'),
    });
  });

  it('encodes account changes during rate-limit reads as a stable IPC precondition error', async () => {
    const harness = new IpcHarness();
    const readCodexRateLimits = vi
      .fn()
      .mockRejectedValue(
        new CodexRateLimitResetRejectedError('ACCOUNT_CHANGED', 'retry after account settles'),
      );
    registerMakerUsageHandlers(harness, makeUsageDeps({ readCodexRateLimits }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('ACCOUNT_CHANGED'),
    });
  });

  it('passes numeric days through to readUsageHistory and drops invalid values', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockResolvedValue(emptyHistory);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140 });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140 });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 'lots' });
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140, forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140, forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY);
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to empty history payload when the read throws', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockRejectedValue(new Error('db gone'));

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_HISTORY)).resolves.toEqual(emptyHistory);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  IOS_SIMULATOR_INSTANCE_ERROR_CODES,
  IOSSimulatorInstanceError,
} from '@cindy/ios-simulator-runtime';

import { isIpcErrorCode } from '../../../shared/ipc-errors';
import { MAKER_INVOKE } from '../channels';
import {
  registerIOSSimulatorHandlers,
  type IOSSimulatorHandlerDeps,
} from '../iosSimulatorHandlers';
import { IpcHarness } from './helpers/ipcHarness';

describe('iOS Simulator IPC handlers', () => {
  function registerTrusted(harness: IpcHarness, deps: Partial<IOSSimulatorHandlerDeps> = {}): void {
    registerIOSSimulatorHandlers(harness, {
      assertTrustedSender: () => undefined,
      getPluginAccess: () => ({ allowed: true }),
      getSessionContext: async () => ({ workingDir: '/repo/session-a' }),
      getOwnerScopeKey: () => 'local:owner-a:1',
      isOwnerBoundaryPending: () => false,
      getSessionAccess: () => ({ sessionId: 'session-a', generation: 1 }),
      getViewerAccess: (_target, sessionId) =>
        sessionId === 'session-a' ? { sessionId, generation: 1 } : null,
      hasViewerAccess: (_target, sessionId) => sessionId === 'session-a',
      ...deps,
    });
  }

  it('registers every stable Simulator business code in the IPC decoder allowlist', () => {
    expect(IOS_SIMULATOR_INSTANCE_ERROR_CODES.every(isIpcErrorCode)).toBe(true);
  });

  it.each([
    MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS,
    MAKER_INVOKE.IOS_SIMULATOR_STATUS,
    MAKER_INVOKE.IOS_SIMULATOR_CALL,
    MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL,
    MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL,
    MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY,
    MAKER_INVOKE.IOS_SIMULATOR_RETRY_NATIVE_ROUTE,
    MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME,
    MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE,
    MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH,
  ])('checks the trusted sender before parsing %s', async (channel) => {
    const harness = new IpcHarness();
    const getStatus = vi.fn();
    const assertTrustedSender = vi.fn(() => {
      throw Object.assign(new Error('untrusted sender'), { code: 'PERMISSION_DENIED' });
    });
    registerIOSSimulatorHandlers(harness, { assertTrustedSender, getStatus });

    await expect(harness.invoke(channel, undefined)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(assertTrustedSender).toHaveBeenCalledOnce();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('rejects every Renderer entry before reaching the Host when the plugin is unavailable', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn();
    const requestSessionAccess = vi.fn();
    registerIOSSimulatorHandlers(harness, {
      assertTrustedSender: () => undefined,
      getPluginAccess: () => ({
        allowed: false,
        errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
        message: 'unavailable',
        data: { reason: 'session-unavailable' },
      }),
      getSessionContext: async () => ({ workingDir: '/repo/session-a' }),
      getViewerAccess: () => null,
      hasViewerAccess: () => false,
      getStatus,
      requestSessionAccess,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'IOS_SIMULATOR_PLUGIN_SESSION_UNAVAILABLE' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'IOS_SIMULATOR_PLUGIN_SESSION_UNAVAILABLE' });
    expect(requestSessionAccess).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('returns an existing Main-owned grant without opening confirmation', async () => {
    const harness = new IpcHarness();
    const requestSessionAccess = vi.fn(async () => false);
    registerTrusted(harness, { requestSessionAccess });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
        sessionId: ' session-a ',
      }),
    ).resolves.toEqual({ granted: true });
    expect(requestSessionAccess).not.toHaveBeenCalled();
  });

  it('does not treat retained Viewer access as an active access request grant', async () => {
    const harness = new IpcHarness();
    const requestSessionAccess = vi.fn(async () => false);
    registerTrusted(harness, {
      getSessionAccess: () => ({ sessionId: 'session-b', generation: 2 }),
      getViewerAccess: (_target, sessionId) =>
        sessionId === 'session-a' ? { sessionId, generation: 1 } : null,
      hasViewerAccess: (_target, sessionId) => sessionId === 'session-a',
      requestSessionAccess,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
        sessionId: 'session-a',
      }),
    ).resolves.toEqual({ granted: false });
    expect(requestSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17 }),
      'session-a',
    );
  });

  it('passes the authoritative session workdir to the plugin gate', async () => {
    const harness = new IpcHarness();
    const getPluginAccess = vi.fn(() => ({
      allowed: false as const,
      errorCode: 'IOS_SIMULATOR_DISABLED' as const,
      message: 'disabled',
      data: { reason: 'disabled-in-workdir' },
    }));
    const getStatus = vi.fn();
    registerTrusted(harness, {
      getPluginAccess,
      getSessionContext: async () => ({ workingDir: '/repo/disabled' }),
      getStatus,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'IOS_SIMULATOR_DISABLED' });
    expect(getPluginAccess).toHaveBeenCalledWith('/repo/disabled');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['not-installed', 'IOS_SIMULATOR_PLUGIN_REQUIRED'],
    ['disabled', 'IOS_SIMULATOR_PLUGIN_DISABLED'],
    ['disabled-in-workdir', 'IOS_SIMULATOR_DISABLED'],
    ['session-unavailable', 'IOS_SIMULATOR_PLUGIN_SESSION_UNAVAILABLE'],
  ] as const)('preserves the plugin access reason %s across IPC', async (reason, code) => {
    const harness = new IpcHarness();
    registerTrusted(harness, {
      getPluginAccess: () => ({
        allowed: false,
        errorCode:
          reason === 'not-installed'
            ? 'IOS_SIMULATOR_PLUGIN_REQUIRED'
            : reason === 'disabled-in-workdir'
              ? 'IOS_SIMULATOR_DISABLED'
              : 'IOS_SIMULATOR_PLUGIN_DISABLED',
        message: 'safe plugin gate message',
        data: { reason },
      }),
      getViewerAccess: () => null,
      hasViewerAccess: () => false,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code });
  });

  it('still requires Viewer access for status when the plugin is available', async () => {
    const harness = new IpcHarness();
    const getPluginAccess = vi.fn(() => ({ allowed: true as const }));
    const getStatus = vi.fn();
    registerTrusted(harness, {
      getPluginAccess,
      getViewerAccess: () => null,
      hasViewerAccess: () => false,
      getStatus,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(getPluginAccess).toHaveBeenCalledWith('/repo/session-a');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('does not expose plugin access for an unknown session', async () => {
    const harness = new IpcHarness();
    const getPluginAccess = vi.fn(() => ({
      allowed: false as const,
      errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED' as const,
      message: 'disabled',
      data: { reason: 'disabled' as const },
    }));
    const getStatus = vi.fn();
    registerTrusted(harness, {
      getSessionContext: async () => null,
      getPluginAccess,
      getViewerAccess: () => null,
      hasViewerAccess: () => false,
      getStatus,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'missing-session',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(getPluginAccess).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('returns the explicit native confirmation result for a manual access request', async () => {
    const harness = new IpcHarness();
    let granted = false;
    const requestSessionAccess = vi.fn(async () => {
      granted = true;
      return true;
    });
    registerTrusted(harness, {
      getSessionAccess: () => (granted ? { sessionId: 'session-a', generation: 1 } : null),
      hasViewerAccess: () => granted,
      requestSessionAccess,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
        sessionId: ' session-a ',
      }),
    ).resolves.toEqual({ granted: true });
    expect(requestSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17 }),
      'session-a',
    );
  });

  it('keeps a cancelled manual access request ungranted', async () => {
    const harness = new IpcHarness();
    const requestSessionAccess = vi.fn(async () => false);
    registerTrusted(harness, {
      getSessionAccess: () => null,
      hasViewerAccess: () => false,
      requestSessionAccess,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
        sessionId: 'session-a',
      }),
    ).resolves.toEqual({ granted: false });
  });

  it('keeps access-request internals in Main logs and returns a fixed IPC error', async () => {
    const harness = new IpcHarness();
    const internalError = new Error(
      'confirmation archive failed at /Users/alice/Library/Application Support/Cindy/private.json',
    );
    const reportError = vi.fn();
    registerTrusted(harness, {
      getSessionAccess: () => null,
      hasViewerAccess: () => false,
      requestSessionAccess: vi.fn(async () => {
        throw internalError;
      }),
      reportError,
    });

    const request = harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_REQUEST_ACCESS, {
      sessionId: 'session-a',
    });
    await expect(request).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] iOS Simulator access could not be requested.',
    });
    await expect(request).rejects.not.toThrow(/\/Users\/alice|private\.json/);
    expect(reportError).toHaveBeenCalledWith('request-access', internalError);
  });

  it('passes a validated session id to the host', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn(async (sessionId: string) => ({
      ok: false as const,
      sessionId,
      errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
      message: 'Remote session',
    }));
    registerTrusted(harness, { getStatus });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: ' session-a ',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-a' });
    expect(getStatus).toHaveBeenCalledWith('session-a');
  });

  it.each([
    ['active', { sessionId: 'session-a', generation: 1 }],
    ['paused', { sessionId: 'session-b', generation: 2 }],
  ] as const)('projects %s control access from the Main-owned grant', async (expected, grant) => {
    const harness = new IpcHarness();
    registerTrusted(harness, {
      getSessionAccess: () => grant,
      getStatus: async () => ({
        ok: true,
        sessionId: 'session-a',
        instances: [],
        deviceGrants: [],
        mutationStates: [],
        environment: {
          platform: 'darwin',
          supported: true,
          ready: true,
          xcodeVersion: 'Xcode 26.4',
          runtimes: [],
          devices: [],
          issue: null,
          error: null,
          setupSteps: [],
        },
      }),
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).resolves.toMatchObject({ controlAccess: expected });
  });

  it('rejects a request before calling the host while the owner boundary is pending', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn();
    const reportError = vi.fn();
    registerTrusted(harness, {
      isOwnerBoundaryPending: () => true,
      getStatus,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(getStatus).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('discards a host result when the owner scope changes while awaiting it', async () => {
    const harness = new IpcHarness();
    let ownerScopeKey = 'local:owner-a:1';
    const reportError = vi.fn();
    const getStatus = vi.fn(async () => {
      ownerScopeKey = 'local:owner-b:2';
      return {
        ok: false as const,
        sessionId: 'session-a',
        errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
        message: 'stale owner result',
      };
    });
    registerTrusted(harness, {
      getOwnerScopeKey: () => ownerScopeKey,
      getStatus,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('discards a frame when an owner boundary starts while awaiting it', async () => {
    const harness = new IpcHarness();
    let boundaryPending = false;
    const reportError = vi.fn();
    const getLatestFrame = vi.fn(async () => {
      boundaryPending = true;
      return { ok: true as const, data: { stream: null } };
    });
    registerTrusted(harness, {
      isOwnerBoundaryPending: () => boundaryPending,
      getLatestFrame,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 1,
        leaseId: 'lease-a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does not project an old host error after the owner scope changes', async () => {
    const harness = new IpcHarness();
    let ownerScopeKey = 'local:owner-a:1';
    const reportError = vi.fn();
    const getStatus = vi.fn(async () => {
      ownerScopeKey = 'local:owner-b:2';
      throw new IOSSimulatorInstanceError('DEVICE_BUSY', 'old owner registry path', true);
    });
    registerTrusted(harness, {
      getOwnerScopeKey: () => ownerScopeKey,
      getStatus,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('discards a host result when the renderer session grant is revoked while awaiting it', async () => {
    const harness = new IpcHarness();
    let hasAccess = true;
    const reportError = vi.fn();
    const getStatus = vi.fn(async () => {
      hasAccess = false;
      return {
        ok: false as const,
        sessionId: 'session-a',
        errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
        message: 'stale session result',
      };
    });
    registerTrusted(harness, {
      hasViewerAccess: () => hasAccess,
      getViewerAccess: () => (hasAccess ? { sessionId: 'session-a', generation: 1 } : null),
      getStatus,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('discards a host result after a same-session grant is revoked and reissued', async () => {
    const harness = new IpcHarness();
    let grantGeneration = 1;
    const reportError = vi.fn();
    const getStatus = vi.fn(async () => {
      grantGeneration = 2;
      return {
        ok: false as const,
        sessionId: 'session-a',
        errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
        message: 'stale grant result',
      };
    });
    registerTrusted(harness, {
      getViewerAccess: () => ({ sessionId: 'session-a', generation: grantGeneration }),
      getStatus,
      reportError,
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('preserves safe Simulator business codes without exposing status internals', async () => {
    const harness = new IpcHarness();
    const internalError = new IOSSimulatorInstanceError(
      'DEVICE_BUSY',
      'registry locked at /Users/alice/Library/Application Support/Cindy/ownership.json',
      true,
    );
    const reportError = vi.fn();
    registerTrusted(harness, {
      getStatus: vi.fn(async () => {
        throw internalError;
      }),
      reportError,
    });

    const request = harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
      sessionId: 'session-a',
    });
    await expect(request).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
      message: '[DEVICE_BUSY] iOS Simulator status is temporarily unavailable.',
    });
    await expect(request).rejects.not.toThrow(/\/Users\/alice|ownership\.json/);
    expect(reportError).toHaveBeenCalledWith('status', internalError);
  });

  it('rejects missing session ids', async () => {
    const harness = new IpcHarness();
    registerTrusted(harness, { getStatus: vi.fn() });

    await expect(harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_STATUS, {})).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('rejects cross-task status and lifecycle calls from another renderer window', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn();
    const callTool = vi.fn();
    registerIOSSimulatorHandlers(harness, {
      assertTrustedSender: () => undefined,
      getPluginAccess: () => ({ allowed: true }),
      getSessionContext: async () => ({ workingDir: '/repo/session-a' }),
      hasViewerAccess: () => false,
      getStatus,
      callTool,
    });

    await expect(
      harness.invokeFrom(18, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness.invokeFrom(18, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'stop_instance',
        args: { instanceId: 'instance-a', generation: 1, leaseId: 'lease-a' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(getStatus).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('restores retained Viewer access without lending the active mutation grant', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn(async () => ({
      ok: false as const,
      sessionId: 'session-a',
      errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
      message: 'viewer status',
    }));
    const setViewerVisibility = vi.fn(async () => ({ ok: true as const, data: {} }));
    const callTool = vi.fn();
    const updateViewerTouch = vi.fn();
    registerTrusted(harness, {
      getSessionAccess: () => ({ sessionId: 'session-b', generation: 2 }),
      getViewerAccess: (_target, sessionId) =>
        sessionId === 'session-a' ? { sessionId, generation: 1 } : null,
      hasViewerAccess: (_target, sessionId) => sessionId === 'session-a',
      getStatus,
      setViewerVisibility,
      callTool,
      updateViewerTouch,
    });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: 'session-a',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-a' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: false,
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'attach_device',
        args: {},
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
        ...route,
        gestureId: 'gesture-a',
        phase: 'begin',
        xRatio: 0.5,
        yRatio: 0.5,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_RETRY_NATIVE_ROUTE, {
        ...route,
        viewerToken: 'viewer-a',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect(getStatus).toHaveBeenCalledWith('session-a');
    expect(setViewerVisibility).toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(updateViewerTouch).not.toHaveBeenCalled();
  });

  it('validates and routes user lifecycle calls through the shared host', async () => {
    const harness = new IpcHarness();
    const callTool = vi.fn(async () => ({ ok: true as const, data: { instances: [] } }));
    registerTrusted(harness, { callTool });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'attach_device',
        args: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledWith('attach_device', {}, 'session-a');
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'delete_instance',
        args: { instanceId: 'instance-a', generation: 2, leaseId: 'lease-a' },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledWith(
      'delete_instance',
      { instanceId: 'instance-a', generation: 2, leaseId: 'lease-a' },
      'session-a',
    );
    for (const name of ['build_app', 'open_url', 'push_notification', 'delete_everything']) {
      await expect(
        harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
          sessionId: 'session-a',
          name,
          args: {},
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('folds tool-call internals behind the same safe Main-to-Renderer boundary', async () => {
    const harness = new IpcHarness();
    const internalError = new Error(
      'WDA archive missing at /Users/alice/Library/Application Support/Cindy/wda/private.zip',
    );
    const reportError = vi.fn();
    registerTrusted(harness, {
      callTool: vi.fn(async () => {
        throw internalError;
      }),
      reportError,
    });

    const request = harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
      sessionId: 'session-a',
      name: 'attach_device',
      args: {},
    });
    await expect(request).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] iOS Simulator operation failed.',
    });
    await expect(request).rejects.not.toThrow(/\/Users\/alice|private\.zip/);
    expect(reportError).toHaveBeenCalledWith('call-tool', internalError);
  });

  it('requires Main-owned confirmation for Agent-control elevation and allows direct revocation', async () => {
    const harness = new IpcHarness();
    const approval = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      grantGeneration: 1,
      lifecycleEpoch: 0,
      elevationEpoch: 0,
    };
    const setAgentControlGrant = vi.fn(
      async (
        _sessionId: string,
        _instanceId: string,
        _decision: 'allowed' | 'denied',
        assertElevationCurrent?: () => void,
      ) => {
        assertElevationCurrent?.();
        return { ok: true as const, data: {} };
      },
    );
    const confirmAgentControlElevation = vi.fn(async () => approval);
    const invalidateAgentControlElevation = vi.fn();
    const isAgentControlApprovalCurrent = vi.fn(() => true);
    registerTrusted(harness, {
      setAgentControlGrant,
      confirmAgentControlElevation,
      invalidateAgentControlElevation,
      isAgentControlApprovalCurrent,
    });

    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      action: 'request-allow',
    });
    expect(confirmAgentControlElevation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17 }),
      'session-a',
      'instance-a',
    );
    expect(setAgentControlGrant).toHaveBeenCalledWith(
      'session-a',
      'instance-a',
      'allowed',
      expect.any(Function),
    );
    expect(isAgentControlApprovalCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17 }),
      approval,
    );

    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      action: 'revoke',
    });
    expect(confirmAgentControlElevation).toHaveBeenCalledTimes(1);
    expect(invalidateAgentControlElevation).toHaveBeenCalledWith('session-a', 'instance-a');
    expect(setAgentControlGrant).toHaveBeenLastCalledWith('session-a', 'instance-a', 'denied');
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        action: 'allow',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('does not persist Agent control when native confirmation is cancelled', async () => {
    const harness = new IpcHarness();
    const setAgentControlGrant = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, {
      setAgentControlGrant,
      confirmAgentControlElevation: vi.fn(async () => null),
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        action: 'request-allow',
      }),
    ).resolves.toEqual({ ok: true, data: { confirmed: false } });
    expect(setAgentControlGrant).not.toHaveBeenCalled();
  });

  it('rechecks the exact Renderer grant after Agent-control confirmation', async () => {
    const harness = new IpcHarness();
    let generation = 1;
    const setAgentControlGrant = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, {
      getSessionAccess: () => ({ sessionId: 'session-a', generation }),
      setAgentControlGrant,
      isAgentControlApprovalCurrent: vi.fn(() => true),
      confirmAgentControlElevation: vi.fn(async () => {
        generation = 2;
        return {
          sessionId: 'session-a',
          instanceId: 'instance-a',
          grantGeneration: 1,
          lifecycleEpoch: 0,
          elevationEpoch: 0,
        };
      }),
    });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        action: 'request-allow',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(setAgentControlGrant).not.toHaveBeenCalled();
  });

  it('validates and routes explicit Agent mutation pause state', async () => {
    const harness = new IpcHarness();
    const setAgentMutationPaused = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, { setAgentMutationPaused });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };

    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, {
      ...route,
      paused: true,
    });
    expect(setAgentMutationPaused).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
    );
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, {
        ...route,
        paused: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('keeps mutation route validation outside the Host error boundary', async () => {
    const harness = new IpcHarness();
    const reportError = vi.fn();
    const setAgentMutationPaused = vi.fn();
    registerTrusted(harness, { reportError, setAgentMutationPaused });

    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 0,
        leaseId: 'lease-a',
        paused: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(setAgentMutationPaused).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('validates exact frame routes before forwarding visibility and frame reads', async () => {
    const harness = new IpcHarness();
    const setViewerVisibility = vi.fn(async () => ({ ok: true as const, data: {} }));
    const retryNativeRoute = vi.fn(async () => ({
      ok: true as const,
      data: { nativeRecovered: true },
    }));
    const getLatestFrame = vi.fn(async () => ({ ok: true as const, data: { stream: null } }));
    registerTrusted(harness, { setViewerVisibility, retryNativeRoute, getLatestFrame });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };

    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
      ...route,
      visible: true,
      viewerToken: 'viewer-a',
    });
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
      ...route,
      visible: true,
      preferredEncoding: 'h264',
    });
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
      ...route,
      visible: true,
      preferredEncoding: 'jpeg',
      fallbackReason: 'native-decoder-fallback',
    });
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, route);
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_RETRY_NATIVE_ROUTE, {
      ...route,
      viewerToken: 'viewer-a',
    });

    expect(setViewerVisibility).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
      undefined,
      undefined,
      17,
      'viewer-a',
    );
    expect(setViewerVisibility).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
      'h264',
      undefined,
      17,
      undefined,
    );
    expect(setViewerVisibility).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
      'jpeg',
      'native-decoder-fallback',
      17,
      undefined,
    );
    expect(getLatestFrame).toHaveBeenCalledWith(
      'session-a',
      {
        instanceId: 'instance-a',
        generation: 3,
        leaseId: 'lease-a',
      },
      17,
    );
    expect(retryNativeRoute).toHaveBeenCalledWith(
      'session-a',
      {
        instanceId: 'instance-a',
        generation: 3,
        leaseId: 'lease-a',
      },
      17,
      'viewer-a',
    );
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, route),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, {
        ...route,
        generation: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: true,
        preferredEncoding: 'hevc',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: true,
        preferredEncoding: 'jpeg',
        fallbackReason: 'renderer-error',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: true,
        viewerToken: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_RETRY_NATIVE_ROUTE, {
        ...route,
        viewerToken: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates and routes bounded stream profiles', async () => {
    const harness = new IpcHarness();
    const setViewerStreamProfile = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, { setViewerStreamProfile });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
      ...route,
      viewerToken: 'viewer-token',
      profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      nativeProfile: { framesPerSecond: 60, scalingPercent: 70 },
    });
    expect(setViewerStreamProfile).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      17,
      'viewer-token',
      { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      { framesPerSecond: 60, scalingPercent: 70 },
    );
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        viewerToken: 'viewer-token',
        profile: { framesPerSecond: '10', jpegQuality: 45, scalingPercent: 70 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        viewerToken: 'viewer-token',
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        nativeProfile: { framesPerSecond: '60', scalingPercent: 70 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates and routes host-owned live touch samples', async () => {
    const harness = new IpcHarness();
    const updateViewerTouch = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, { updateViewerTouch });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };
    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
      ...route,
      gestureId: 'viewer-7',
      phase: 'move',
      xRatio: 0.25,
      yRatio: 0.75,
    });
    expect(updateViewerTouch).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      17,
      {
        gestureId: 'viewer-7',
        phase: 'move',
        xRatio: 0.25,
        yRatio: 0.75,
      },
    );
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
        ...route,
        gestureId: 'viewer-7',
        phase: 'move',
        xRatio: 0.25,
        yRatio: 0.75,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
        ...route,
        gestureId: 'viewer-7',
        phase: 'move',
        xRatio: 1.1,
        yRatio: 0.5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

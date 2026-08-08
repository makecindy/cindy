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
      hasSessionAccess: (_target, sessionId) => sessionId === 'session-a',
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

  it('returns the explicit native confirmation result for a manual access request', async () => {
    const harness = new IpcHarness();
    const requestSessionAccess = vi.fn(async () => true);
    registerTrusted(harness, {
      hasSessionAccess: () => false,
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
      hasSessionAccess: () => false,
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
      hasSessionAccess: () => false,
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
      hasSessionAccess: () => false,
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
    for (const name of ['build_app', 'open_url', 'push_notification', 'delete_everything']) {
      await expect(
        harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_CALL, {
          sessionId: 'session-a',
          name,
          args: {},
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(callTool).toHaveBeenCalledTimes(1);
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

  it('allows only explicit agent-control grant decisions', async () => {
    const harness = new IpcHarness();
    const setAgentControlGrant = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerTrusted(harness, { setAgentControlGrant });

    await harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      decision: 'allowed',
    });
    expect(setAgentControlGrant).toHaveBeenCalledWith('session-a', 'instance-a', 'allowed');
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        decision: 'unknown',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
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
    const getLatestFrame = vi.fn(async () => ({ ok: true as const, data: { stream: null } }));
    registerTrusted(harness, { setViewerVisibility, getLatestFrame });
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
      profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      nativeProfile: { framesPerSecond: 60, scalingPercent: 70 },
    });
    expect(setViewerStreamProfile).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      { framesPerSecond: 60, scalingPercent: 70 },
    );
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        profile: { framesPerSecond: '10', jpegQuality: 45, scalingPercent: 70 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invokeFrom(17, MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        nativeProfile: { framesPerSecond: '60', scalingPercent: 70 },
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

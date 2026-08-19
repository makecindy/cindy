// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IOSSimulatorMutationState } from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorAccessRequest,
  IOSSimulatorAccessRequestResult,
  IOSSimulatorFocusRequest,
  IOSSimulatorH264FramePush,
  IOSSimulatorLiveTouchRequest,
  IOSSimulatorPublicInstance,
  IOSSimulatorRetryNativeRouteRequest,
  IOSSimulatorRouteStatusPush,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
  IOSSimulatorViewerVisibilityRequest,
} from '../../../../../../shared/iosSimulatorIpc';
import type { TabKindHostContext } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { IOSSimulatorTabBody, setupStepKeys } from '../IOSSimulatorTabBody';

const ctx: TabKindHostContext = {
  tabId: 'tab-a',
  sessionId: 'session-a',
  workdir: '/tmp/project',
  remoteHostId: null,
  patchState: vi.fn(),
  onVisibilityChange: vi.fn(),
  setCloseInterceptor: () => () => undefined,
};

function streamingJpegResult(generation = 2, sequence = 1): IOSSimulatorToolResponse {
  return {
    ok: true,
    data: {
      stream: {
        instanceId: 'instance-a',
        generation,
        state: 'streaming',
        reconnectAttempt: 0,
        latestFrame: {
          instanceId: 'instance-a',
          generation,
          sequence,
          encoding: 'jpeg',
          receivedAt: '2026-07-24T00:00:00.000Z',
          bytes: new Uint8Array([1, 2, 3]),
        },
      },
      viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
    },
  };
}

function readyInstance(generation = 2): IOSSimulatorPublicInstance {
  return {
    instanceId: 'instance-a',
    sessionId: 'session-a',
    sessionKind: 'local',
    sourceFingerprint: 'fingerprint-a',
    simulatorUdid: 'DEVICE-UDID-123',
    simulatorName: 'iPhone 17 Pro',
    runtimeIdentifier: 'runtime',
    deviceTypeIdentifier: 'type',
    creationProvenance: 'external',
    bootProvenance: 'preexisting',
    generation,
    lifecycleState: 'ready',
    viewerState: 'attached',
    healthState: 'healthy',
    lease: {
      id: `lease-${generation}`,
      issuedAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-07-23T00:10:00.000Z',
    },
    createdAt: '2026-07-23T00:00:00.000Z',
    lastActiveAt: '2026-07-23T00:00:00.000Z',
    stoppedAt: null,
    graceExpiresAt: null,
    errorCode: null,
  };
}

function readyStatus(instance = readyInstance()): IOSSimulatorSessionStatus {
  return {
    ok: true,
    sessionId: 'session-a',
    deviceGrants: [],
    mutationStates: [],
    instances: [instance],
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
  };
}

function multiReadyStatus(
  mutationStates: IOSSimulatorMutationState[] = [],
): IOSSimulatorSessionStatus {
  const instanceA: IOSSimulatorPublicInstance = {
    ...readyInstance(1),
    simulatorName: 'iPhone A',
    lease: { ...readyInstance(1).lease, id: 'lease-a' },
  };
  const instanceB: IOSSimulatorPublicInstance = {
    ...readyInstance(2),
    instanceId: 'instance-b',
    simulatorUdid: 'DEVICE-B',
    simulatorName: 'iPhone B',
    lease: { ...readyInstance(2).lease, id: 'lease-b' },
  };
  const status = readyStatus(instanceA);
  if (!status.ok) throw new Error('Expected a ready status fixture.');
  return { ...status, mutationStates, instances: [instanceA, instanceB] };
}

function installGridFrames(
  api: ReturnType<typeof installStatus>,
  mutationForInstance: (instanceId: string) => IOSSimulatorMutationState | null = () => null,
): void {
  api.latestFrame.mockImplementation(async (request?: unknown) => {
    const route = request as { instanceId: string; generation: number };
    const mutation = mutationForInstance(route.instanceId);
    return {
      ok: true,
      data: {
        stream: {
          instanceId: route.instanceId,
          generation: route.generation,
          state: 'streaming',
          reconnectAttempt: 0,
          latestFrame: {
            instanceId: route.instanceId,
            generation: route.generation,
            sequence: 1,
            encoding: 'jpeg',
            receivedAt: '2026-07-24T00:00:00.000Z',
            bytes: new Uint8Array([1, 2, 3]),
          },
        },
        ...(mutation ? { mutation } : {}),
      },
    };
  });
}

function preparePointerTarget(container: HTMLElement): HTMLImageElement {
  const image = container.querySelector('img') as HTMLImageElement | null;
  if (!image) throw new Error('Expected the simulator viewer image.');
  Object.defineProperties(image, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
    },
  });
  return image;
}

function expectDisabledIconButton(label: string, accessibleLabel: string): void {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
  ).find((candidate) => candidate.getAttribute('aria-label') === label);
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-hidden')).toBe('true');
  expect(button?.parentElement?.getAttribute('role')).toBe('button');
  expect(button?.parentElement?.getAttribute('aria-disabled')).toBe('true');
  expect(button?.parentElement?.getAttribute('aria-label')).toBe(accessibleLabel);
}

function installFakeH264DecoderRuntime(): void {
  class FakeVideoDecoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    constructor() {}
    configure() {}
    decode() {}
    close() {}
  }
  class FakeEncodedVideoChunk {
    constructor(readonly init: unknown) {}
  }
  Object.defineProperty(globalThis, 'VideoDecoder', {
    configurable: true,
    value: FakeVideoDecoder,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: FakeEncodedVideoChunk,
  });
}

function installStatus(statusValue: IOSSimulatorSessionStatus) {
  let currentStatusValue = statusValue;
  const status = vi.fn(async () => currentStatusValue);
  const requestAccess = vi.fn(
    async (_request: IOSSimulatorAccessRequest): Promise<IOSSimulatorAccessRequestResult> => ({
      granted: true,
    }),
  );
  const call = vi.fn(async (): Promise<IOSSimulatorToolResponse> => ({
    ok: true as const,
    data: {},
  }));
  const setAgentControl = vi.fn(async () => ({ ok: true as const, data: {} }));
  const setViewerVisibility = vi.fn(
    async (request: IOSSimulatorViewerVisibilityRequest): Promise<IOSSimulatorToolResponse> => {
      void request;
      return {
        ok: true,
        data: { stream: null },
      };
    },
  );
  const retryNativeRoute = vi.fn(
    async (request: IOSSimulatorRetryNativeRouteRequest): Promise<IOSSimulatorToolResponse> => {
      void request;
      return { ok: true, data: { nativeRecovered: true } };
    },
  );
  const setStreamProfile = vi.fn(async () => ({ ok: true as const, data: {} }));
  let h264FrameListener: ((payload: IOSSimulatorH264FramePush) => void) | null = null;
  let routeStatusListener: ((payload: IOSSimulatorRouteStatusPush) => void) | null = null;
  let focusRequestListener: ((payload: IOSSimulatorFocusRequest) => void) | null = null;
  const onH264Frame = vi.fn((callback: (payload: IOSSimulatorH264FramePush) => void) => {
    h264FrameListener = callback;
    return () => {
      if (h264FrameListener === callback) h264FrameListener = null;
    };
  });
  const onRouteStatus = vi.fn((callback: (payload: IOSSimulatorRouteStatusPush) => void) => {
    routeStatusListener = callback;
    return () => {
      if (routeStatusListener === callback) routeStatusListener = null;
    };
  });
  const onFocusRequest = vi.fn((callback: (payload: IOSSimulatorFocusRequest) => void) => {
    focusRequestListener = callback;
    return () => {
      if (focusRequestListener === callback) focusRequestListener = null;
    };
  });
  const liveTouch = vi.fn(
    async (request: IOSSimulatorLiveTouchRequest): Promise<IOSSimulatorToolResponse> => {
      void request;
      return {
        ok: true as const,
        data: {},
      };
    },
  );
  const latestFrame = vi.fn(async (_request?: unknown): Promise<IOSSimulatorToolResponse> => ({
    ok: true,
    data: { stream: null },
  }));
  (
    window as unknown as {
      electronAPI: {
        maker: {
          iosSimulator: {
            requestAccess: typeof requestAccess;
            status: typeof status;
            call: typeof call;
            setAgentControl: typeof setAgentControl;
            setViewerVisibility: typeof setViewerVisibility;
            retryNativeRoute: typeof retryNativeRoute;
            latestFrame: typeof latestFrame;
            setStreamProfile: typeof setStreamProfile;
            liveTouch: typeof liveTouch;
            onH264Frame: typeof onH264Frame;
            onRouteStatus: typeof onRouteStatus;
            onFocusRequest: typeof onFocusRequest;
          };
        };
      };
    }
  ).electronAPI = {
    maker: {
      iosSimulator: {
        requestAccess,
        status,
        call,
        setAgentControl,
        setViewerVisibility,
        retryNativeRoute,
        latestFrame,
        setStreamProfile,
        liveTouch,
        onH264Frame,
        onRouteStatus,
        onFocusRequest,
      },
    },
  };
  return {
    requestAccess,
    status,
    call,
    setAgentControl,
    setViewerVisibility,
    retryNativeRoute,
    latestFrame,
    setStreamProfile,
    liveTouch,
    onH264Frame,
    onRouteStatus,
    onFocusRequest,
    setStatusValue(value: IOSSimulatorSessionStatus) {
      currentStatusValue = value;
    },
    emitH264Frame(payload: IOSSimulatorH264FramePush) {
      h264FrameListener?.(payload);
    },
    emitRouteStatus(payload: IOSSimulatorRouteStatusPush) {
      routeStatusListener?.(payload);
    },
    emitFocusRequest(payload: IOSSimulatorFocusRequest) {
      focusRequestListener?.(payload);
    },
  };
}

beforeEach(() => {
  let objectUrlSequence = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => `blob:ios-simulator-${++objectUrlSequence}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    'Image',
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ clearRect: vi.fn(), drawImage: vi.fn() }) as never,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  delete (globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllGlobals();
});

describe('IOSSimulatorTabBody', () => {
  it('keeps Viewer status visible while control waits for renewed authorization', async () => {
    const pausedStatus = readyStatus();
    if (!pausedStatus.ok) throw new Error('Expected a ready simulator status.');
    pausedStatus.controlAccess = 'paused';
    const api = installStatus(pausedStatus);

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await screen.findByText('rightSidebar.iosSimulator.accessRequiredTitle');
    expect(screen.getByText('iPhone 17 Pro')).toBeTruthy();
    expect(
      (
        screen.getByRole('combobox', {
          name: 'rightSidebar.iosSimulator.streamProfile',
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    expect(api.requestAccess).not.toHaveBeenCalled();
    api.requestAccess.mockImplementationOnce(async () => {
      api.setStatusValue({ ...pausedStatus, controlAccess: 'active' });
      return { granted: true };
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.iosSimulator.allowTaskAccess' }),
    );
    await waitFor(() => {
      expect(api.requestAccess).toHaveBeenCalledWith({ sessionId: 'session-a' });
      expect(screen.queryByText('rightSidebar.iosSimulator.accessRequiredTitle')).toBeNull();
    });
  });

  it('requires a user gesture before requesting native access for a restored panel', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PERMISSION_DENIED] iOS Simulator access is limited to the current task',
      ),
    );

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.accessRequiredTitle')).toBeTruthy();
    });
    expect(api.requestAccess).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.iosSimulator.allowTaskAccess' }),
    );

    await waitFor(() => {
      expect(api.requestAccess).toHaveBeenCalledWith({ sessionId: 'session-a' });
      expect(api.status).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText('rightSidebar.iosSimulator.accessRequiredTitle')).toBeNull();
  });

  it('shows the exact plugin-session reason instead of reporting an environment probe failure', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [IOS_SIMULATOR_PLUGIN_SESSION_UNAVAILABLE] The iOS Simulator plugin is unavailable in the current Cindy session.',
      ),
    );

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.pluginSessionUnavailable')).toBeTruthy();
    });
    expect(screen.queryByText('rightSidebar.iosSimulator.connectionError')).toBeNull();
    expect(screen.queryByText('rightSidebar.iosSimulator.accessRequiredTitle')).toBeNull();
  });

  it('distinguishes an internal Host status failure from a simulator environment failure', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [INTERNAL] iOS Simulator status is temporarily unavailable.',
      ),
    );

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.statusInternalError')).toBeTruthy();
    });
    expect(screen.queryByText('rightSidebar.iosSimulator.connectionError')).toBeNull();
  });

  it('animates the access loader on an HTML wrapper instead of the SVG', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PERMISSION_DENIED] iOS Simulator access is limited to the current task',
      ),
    );
    api.requestAccess.mockImplementationOnce(
      () => new Promise<IOSSimulatorAccessRequestResult>(() => undefined),
    );

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'rightSidebar.iosSimulator.allowTaskAccess',
      }),
    );

    const button = await screen.findByRole('button', {
      name: 'rightSidebar.iosSimulator.requestingAccess',
    });
    const wrapper = button.querySelector('span.animate-spin');
    const icon = wrapper?.querySelector('svg');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.classList.contains('motion-reduce:animate-none')).toBe(true);
    expect(icon).toBeTruthy();
    expect(icon?.classList.contains('animate-spin')).toBe(false);
  });

  it('keeps the access action visible when native confirmation is cancelled', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PERMISSION_DENIED] iOS Simulator access is limited to the current task',
      ),
    );
    api.requestAccess.mockResolvedValueOnce({ granted: false });

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    const button = await screen.findByRole('button', {
      name: 'rightSidebar.iosSimulator.allowTaskAccess',
    });
    fireEvent.click(button);

    await waitFor(() => expect(api.requestAccess).toHaveBeenCalledOnce());
    expect(
      screen.getByRole('button', { name: 'rightSidebar.iosSimulator.allowTaskAccess' }),
    ).toBeTruthy();
    expect(api.status).toHaveBeenCalledOnce();
  });

  it('refreshes a restored access-required tab after an authoritative Host focus grant', async () => {
    const api = installStatus(readyStatus());
    api.status.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PERMISSION_DENIED] iOS Simulator access is limited to the current task',
      ),
    );

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await screen.findByText('rightSidebar.iosSimulator.accessRequiredTitle');
    act(() => {
      api.emitFocusRequest({
        sessionId: 'session-a',
        instanceId: 'instance-a',
        userInitiated: false,
      });
    });

    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('rightSidebar.iosSimulator.accessRequiredTitle')).toBeNull();
    expect(screen.getByText('iPhone 17 Pro')).toBeTruthy();
  });

  it('renders exact device identity from the main-owned status report', async () => {
    const api = installStatus({
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
        devices: [
          {
            udid: 'DEVICE-UDID-123',
            name: 'iPhone 17 Pro',
            state: 'Booted',
            isAvailable: true,
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
            runtimeName: 'iOS 26.4',
            runtimeVersion: '26.4',
            deviceTypeIdentifier: null,
            lastBootedAt: null,
          },
        ],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => expect(screen.getByText('iPhone 17 Pro')).toBeTruthy());
    expect(screen.getByText(/iOS 26\.4 · Booted/)).toBeTruthy();
    expect(screen.getByText('DEVICE-UDID-123')).toBeTruthy();
    expect(api.status).toHaveBeenCalledWith({ sessionId: 'session-a' });

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.attachDevice' }));
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'attach_device',
        args: { udid: 'DEVICE-UDID-123' },
      });
    });
  });

  it('explains task ownership and folds unavailable devices with a safe reason', async () => {
    installStatus({
      ok: true,
      sessionId: 'session-a',
      instances: [],
      deviceGrants: [],
      mutationStates: [],
      resource: {
        runningCount: 2,
        softLimit: 2,
        hardLimit: 4,
        maxInstancesPerTask: 4,
      },
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [
          {
            udid: 'DEVICE-UDID-123',
            name: 'iPhone 17 Pro',
            state: 'Booted',
            isAvailable: true,
            ownership: 'other-task',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
            runtimeName: 'iOS 26.4',
            runtimeVersion: '26.4',
            deviceTypeIdentifier: null,
            lastBootedAt: null,
          },
          {
            udid: 'UNAVAILABLE-DEVICE-UDID',
            name: 'iPhone 16',
            state: 'Shutdown',
            isAvailable: false,
            ownership: 'unowned',
            unavailableReason: { code: 'missing-runtime', runtimeName: 'iOS 18.4' },
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-4',
            runtimeName: 'iOS 18-4',
            runtimeVersion: null,
            deviceTypeIdentifier: null,
            lastBootedAt: null,
          },
        ],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => expect(screen.getByText('iPhone 17 Pro')).toBeTruthy());
    expect(screen.getByText('rightSidebar.iosSimulator.deviceInUseByOtherTask')).toBeTruthy();
    expect(screen.getByText('rightSidebar.iosSimulator.resourceSoftLimitTitle')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'rightSidebar.iosSimulator.attachDevice',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText('iPhone 16')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: /rightSidebar\.iosSimulator\.unavailableDevicesTitle/,
      }),
    );

    expect(screen.getByText('iPhone 16')).toBeTruthy();
    expect(screen.getByText('rightSidebar.iosSimulator.missingRuntime')).toBeTruthy();
    expect(screen.getByText('rightSidebar.iosSimulator.missingRuntimeHelp')).toBeTruthy();
  });

  it('maps an ownership race to an actionable localized error', async () => {
    const statusValue = readyStatus();
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.instances = [];
    statusValue.environment.devices = [
      {
        udid: 'DEVICE-UDID-123',
        name: 'iPhone 17 Pro',
        state: 'Shutdown',
        isAvailable: true,
        ownership: 'unowned',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
        runtimeName: 'iOS 26.4',
        runtimeVersion: '26.4',
        deviceTypeIdentifier: null,
        lastBootedAt: null,
      },
    ];
    const api = installStatus(statusValue);
    api.call.mockResolvedValueOnce({
      ok: false,
      errorCode: 'SIMULATOR_ATTACHED_ELSEWHERE',
      message: 'The simulator is attached to another Cindy session.',
    });

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);
    await waitFor(() => expect(screen.getByText('iPhone 17 Pro')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.attachDevice' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        'rightSidebar.iosSimulator.errors.attachedElsewhere',
      );
    });
    expect(screen.queryByText(/The simulator is attached/)).toBeNull();
  });

  it('shows a localized unsupported state for remote sessions', async () => {
    installStatus({
      ok: false,
      sessionId: 'session-a',
      errorCode: 'UNSUPPORTED_SESSION_KIND',
      message: 'Remote sessions cannot access local simulators.',
    });

    render(
      <IOSSimulatorTabBody
        state={{ instanceId: null }}
        ctx={{ ...ctx, remoteHostId: 'remote-a' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.remoteUnsupported')).toBeTruthy();
    });
  });

  it('shows H.264 and input routes independently and applies host route updates', async () => {
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    const initialRouteStatus: IOSSimulatorRouteStatusPush = {
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-05T00:00:00.000Z',
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'active',
        reasonCode: 'native-active',
      },
      input: {
        adapter: 'wda',
        state: 'fallback',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-capability-unavailable',
      },
    };
    statusValue.routeStatuses = [initialRouteStatus];
    const api = installStatus(statusValue);

    render(<IOSSimulatorTabBody state={{ instanceId: instance.instanceId }} ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.nativeH264')).toBeTruthy();
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaInput')).toBeTruthy();
      expect(screen.getByText('rightSidebar.iosSimulator.route.state.active')).toBeTruthy();
      expect(screen.getByText('rightSidebar.iosSimulator.route.state.fallback')).toBeTruthy();
    });
    expect(api.onRouteStatus).toHaveBeenCalledOnce();

    act(() => {
      api.emitRouteStatus({
        ...initialRouteStatus,
        updatedAt: '2026-08-05T00:00:01.000Z',
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-decoder-fallback',
        },
        input: {
          adapter: 'native-sidecar',
          state: 'active',
          continuous: true,
          multiTouch: false,
          reasonCode: 'native-active',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
      expect(screen.getByText('rightSidebar.iosSimulator.route.nativeHid')).toBeTruthy();
      expect(
        screen.getByText('rightSidebar.iosSimulator.route.multiTouchUnavailable'),
      ).toBeTruthy();
    });

    api.setStatusValue({
      ...statusValue,
      routeStatuses: [
        {
          ...initialRouteStatus,
          updatedAt: '2026-08-05T00:00:00.500Z',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.refresh' }));
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    expect(screen.getByText('rightSidebar.iosSimulator.route.nativeHid')).toBeTruthy();
  });

  it('offers 60 FPS only for active Native H.264 and keeps a 20 FPS WDA fallback', async () => {
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    const nativeRouteStatus: IOSSimulatorRouteStatusPush = {
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-06T00:00:00.000Z',
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'active',
        reasonCode: 'native-active',
      },
      input: {
        adapter: 'wda',
        state: 'fallback',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-capability-unavailable',
      },
    };
    statusValue.routeStatuses = [
      {
        ...nativeRouteStatus,
        updatedAt: '2026-08-05T23:59:59.000Z',
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-sidecar-unavailable',
        },
      },
    ];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());

    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    const profileSelect = await screen.findByRole('combobox');
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    expect(
      screen.queryByRole('option', {
        name: 'rightSidebar.iosSimulator.streamProfiles.experimental60',
      }),
    ).toBeNull();
    act(() => api.emitRouteStatus(nativeRouteStatus));
    await waitFor(() => {
      expect(
        screen.getByRole('option', {
          name: 'rightSidebar.iosSimulator.streamProfiles.highNative',
        }),
      ).toBeTruthy();
      expect(
        screen.getByRole('option', {
          name: 'rightSidebar.iosSimulator.streamProfiles.experimental60',
        }),
      ).toBeTruthy();
    });

    fireEvent.change(profileSelect, { target: { value: 'high' } });
    await waitFor(() => {
      expect(api.setStreamProfile).toHaveBeenCalledWith({
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
        viewerToken: expect.any(String),
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        nativeProfile: { framesPerSecond: 30, scalingPercent: 100 },
      });
    });

    fireEvent.change(profileSelect, { target: { value: 'experimental60' } });
    await waitFor(() => {
      expect(api.setStreamProfile).toHaveBeenCalledWith({
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
        viewerToken: expect.any(String),
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        nativeProfile: { framesPerSecond: 60, scalingPercent: 70 },
      });
    });

    api.setStreamProfile.mockClear();
    const image = rendered.container.querySelector('img') as HTMLImageElement;
    Object.defineProperties(image, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });
    fireEvent.pointerDown(image, { pointerId: 9, button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerUp(image, { pointerId: 9, clientX: 180, clientY: 360 });
    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual(['begin', 'end']);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    expect(api.setStreamProfile).not.toHaveBeenCalled();

    act(() => {
      api.emitRouteStatus({
        ...nativeRouteStatus,
        updatedAt: '2026-08-06T00:00:01.000Z',
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-stream-disconnected',
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('option', {
          name: 'rightSidebar.iosSimulator.streamProfiles.experimental60',
        }),
      ).toBeNull();
      expect((profileSelect as HTMLSelectElement).value).toBe('high');
      expect(api.setStreamProfile).toHaveBeenLastCalledWith({
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
        viewerToken: expect.any(String),
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      });
    });
  });

  it('waits for the exact viewer claim before applying its stream profile', async () => {
    const api = installStatus(readyStatus());
    let resolveViewerClaim!: (result: IOSSimulatorToolResponse) => void;
    const viewerClaim = new Promise<IOSSimulatorToolResponse>((resolve) => {
      resolveViewerClaim = resolve;
    });
    api.setViewerVisibility.mockImplementationOnce(async () => viewerClaim);

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => expect(api.setViewerVisibility).toHaveBeenCalledTimes(1));
    const viewerRequest = api.setViewerVisibility.mock.calls[0]![0];
    expect(viewerRequest.viewerToken).toEqual(expect.any(String));
    expect(api.setStreamProfile).not.toHaveBeenCalled();

    await act(async () => {
      resolveViewerClaim(streamingJpegResult());
      await viewerClaim;
    });

    await waitFor(() => {
      expect(api.setStreamProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-a',
          viewerToken: viewerRequest.viewerToken,
          profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
        }),
      );
    });
  });

  it('starts frame polling only while the pane is active and visible', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
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
    });
    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: 'instance-a' }}
        ctx={ctx}
        active={false}
        shellVisible
      />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-a',
          instanceId: 'instance-a',
          generation: 2,
          leaseId: 'lease-a',
          visible: false,
          preferredEncoding: 'jpeg',
          viewerToken: expect.any(String),
        }),
      );
    });
    expect(api.setStreamProfile).not.toHaveBeenCalled();
    expect(api.latestFrame).not.toHaveBeenCalled();

    rendered.rerender(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-a', visible: true }),
      );
      expect(api.setStreamProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-a',
          profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
        }),
      );
      expect(api.latestFrame).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
    await waitFor(() => {
      expect(api.setStreamProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-a',
          profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        }),
      );
    });

    rendered.rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: 'instance-a' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'instance-a', visible: false }),
      );
    });
  });

  it('re-arms a native fallback once on foreground and backs off repeated attempts', async () => {
    installFakeH264DecoderRuntime();
    let visibilityState: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    const nativeActive: IOSSimulatorRouteStatusPush = {
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-06T00:00:00.000Z',
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'active',
        reasonCode: 'native-active',
      },
      input: {
        adapter: 'native-sidecar',
        state: 'active',
        continuous: true,
        multiTouch: true,
        reasonCode: 'native-active',
      },
    };
    const nativeFallback: IOSSimulatorRouteStatusPush = {
      ...nativeActive,
      updatedAt: '2026-08-06T00:00:01.000Z',
      nativeRecoveryAvailable: true,
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'fallback',
        reasonCode: 'native-stream-disconnected',
      },
      input: {
        adapter: 'wda',
        state: 'fallback',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-sidecar-unavailable',
      },
    };
    statusValue.routeStatuses = [nativeActive];
    const api = installStatus(statusValue);
    const connectingH264: IOSSimulatorToolResponse = {
      ok: true,
      data: {
        stream: {
          instanceId: instance.instanceId,
          generation: instance.generation,
          state: 'connecting',
          reconnectAttempt: 0,
          latestFrame: null,
        },
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    };
    api.setViewerVisibility.mockResolvedValue(connectingH264);
    api.latestFrame.mockResolvedValue(connectingH264);

    render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      );
    });
    api.setViewerVisibility.mockClear();

    act(() => api.emitRouteStatus(nativeFallback));
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    });
    const foreground = () => {
      act(() => {
        visibilityState = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      act(() => {
        visibilityState = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    const nativeRecoveryRequests = () =>
      api.setViewerVisibility.mock.calls
        .map(([request]) => request)
        .filter((request) => request.visible && request.preferredEncoding === 'h264');

    foreground();
    await waitFor(() => expect(nativeRecoveryRequests()).toHaveLength(1));
    foreground();
    await act(async () => Promise.resolve());
    expect(nativeRecoveryRequests()).toHaveLength(1);

    now = 15_001;
    foreground();
    await waitFor(() => expect(nativeRecoveryRequests()).toHaveLength(2));

    act(() =>
      api.emitRouteStatus({
        ...nativeActive,
        updatedAt: '2026-08-06T00:00:02.000Z',
        nativeRecoveryAvailable: true,
        input: nativeFallback.input,
      }),
    );
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.nativeH264')).toBeTruthy();
    });
    act(() => api.emitRouteStatus({ ...nativeFallback, updatedAt: '2026-08-06T00:00:03.000Z' }));
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    });
    foreground();
    await act(async () => Promise.resolve());
    expect(nativeRecoveryRequests()).toHaveLength(2);

    act(() => api.emitRouteStatus({ ...nativeActive, updatedAt: '2026-08-06T00:00:04.000Z' }));
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.nativeH264')).toBeTruthy();
    });
    act(() => api.emitRouteStatus({ ...nativeFallback, updatedAt: '2026-08-06T00:00:05.000Z' }));
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    });
    foreground();
    await waitFor(() => expect(nativeRecoveryRequests()).toHaveLength(3));
  });

  it('recovers Native in the background while keeping a healthy WDA frame visible', async () => {
    installFakeH264DecoderRuntime();
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    const nativeActive: IOSSimulatorRouteStatusPush = {
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-06T00:00:00.000Z',
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'active',
        reasonCode: 'native-active',
      },
      input: {
        adapter: 'native-sidecar',
        state: 'active',
        continuous: true,
        multiTouch: true,
        reasonCode: 'native-active',
      },
    };
    statusValue.routeStatuses = [nativeActive];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockResolvedValue({
      ok: true,
      data: {
        stream: {
          instanceId: instance.instanceId,
          generation: instance.generation,
          state: 'connecting',
          reconnectAttempt: 0,
          latestFrame: null,
        },
      },
    });
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    api.setViewerVisibility.mockClear();
    act(() =>
      api.emitRouteStatus({
        ...nativeActive,
        updatedAt: '2026-08-06T00:00:01.000Z',
        nativeRecoveryAvailable: true,
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-stream-disconnected',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      }),
    );

    await waitFor(() =>
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      ),
    );
    expect(rendered.container.querySelector('img')).toBeTruthy();
  });

  it('does not retry an explicit H.264 decoder fallback when returning foreground', async () => {
    installFakeH264DecoderRuntime();
    let visibilityState: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    const nativeActive: IOSSimulatorRouteStatusPush = {
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-06T00:00:00.000Z',
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'active',
        reasonCode: 'native-active',
      },
      input: {
        adapter: 'native-sidecar',
        state: 'active',
        continuous: true,
        multiTouch: true,
        reasonCode: 'native-active',
      },
    };
    statusValue.routeStatuses = [nativeActive];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());

    render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );
    await waitFor(() => expect(api.setViewerVisibility).toHaveBeenCalled());
    api.setViewerVisibility.mockClear();
    act(() => {
      api.emitRouteStatus({
        ...nativeActive,
        updatedAt: '2026-08-06T00:00:01.000Z',
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-decoder-fallback',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    });
    expect(
      screen.queryByRole('button', {
        name: 'rightSidebar.iosSimulator.nativeRecovery.action',
      }),
    ).toBeNull();

    act(() => {
      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => Promise.resolve());
    expect(
      api.setViewerVisibility.mock.calls.some(
        ([request]) => request.visible && request.preferredEncoding === 'h264',
      ),
    ).toBe(false);
  });

  it('re-arms once when the simulator pane reopens and uses WDA during recovery backoff', async () => {
    installFakeH264DecoderRuntime();
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.routeStatuses = [
      {
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        updatedAt: '2026-08-06T00:00:00.000Z',
        nativeRecoveryAvailable: true,
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-stream-disconnected',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      },
    ];
    const api = installStatus(statusValue);
    const connectingH264: IOSSimulatorToolResponse = {
      ok: true,
      data: {
        stream: {
          instanceId: instance.instanceId,
          generation: instance.generation,
          state: 'connecting',
          reconnectAttempt: 0,
          latestFrame: null,
        },
      },
    };
    api.setViewerVisibility.mockResolvedValue(connectingH264);
    api.latestFrame.mockResolvedValue(connectingH264);
    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active={false}
        shellVisible
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: false }),
      );
    });
    api.setViewerVisibility.mockClear();

    rendered.rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      );
    });

    rendered.rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active={false}
        shellVisible
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: false }),
      );
    });
    api.setViewerVisibility.mockClear();
    rendered.rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'jpeg' }),
      );
    });
    expect(
      api.setViewerVisibility.mock.calls.some(
        ([request]) => request.visible && request.preferredEncoding === 'h264',
      ),
    ).toBe(false);
  });

  it('keeps the compatibility viewer active when pane re-arm rejects', async () => {
    installFakeH264DecoderRuntime();
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.routeStatuses = [
      {
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        updatedAt: '2026-08-06T00:00:00.000Z',
        nativeRecoveryAvailable: true,
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-stream-disconnected',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      },
    ];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockImplementation(async (request) => {
      if (request.visible && request.preferredEncoding === 'h264') {
        throw new Error('Native re-arm failed.');
      }
      return streamingJpegResult();
    });
    api.latestFrame.mockResolvedValue(streamingJpegResult());

    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      );
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'jpeg' }),
      );
      expect(rendered.container.querySelector('img')).toBeTruthy();
    });
  });

  it('hides Native recovery when the Host omits or denies recovery eligibility', async () => {
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.routeStatuses = [
      {
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        updatedAt: '2026-08-06T00:00:00.000Z',
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-sidecar-unavailable',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      },
    ];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());

    render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.route.wdaJpeg')).toBeTruthy();
    });
    expect(
      screen.queryByRole('button', {
        name: 'rightSidebar.iosSimulator.nativeRecovery.action',
      }),
    ).toBeNull();
    expect(api.retryNativeRoute).not.toHaveBeenCalled();

    act(() => {
      api.emitRouteStatus({
        ...statusValue.routeStatuses![0]!,
        updatedAt: '2026-08-06T00:00:01.000Z',
        nativeRecoveryAvailable: false,
      });
    });
    expect(
      screen.queryByRole('button', {
        name: 'rightSidebar.iosSimulator.nativeRecovery.action',
      }),
    ).toBeNull();
  });

  it('lets the current viewer explicitly re-arm Native without disabling WDA controls', async () => {
    installFakeH264DecoderRuntime();
    const instance = readyInstance();
    const statusValue = readyStatus(instance);
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.routeStatuses = [
      {
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        updatedAt: '2026-08-06T00:00:00.000Z',
        nativeRecoveryAvailable: true,
        stream: {
          adapter: 'wda',
          encoding: 'jpeg',
          state: 'fallback',
          reasonCode: 'native-sidecar-unavailable',
        },
        input: {
          adapter: 'wda',
          state: 'fallback',
          continuous: false,
          multiTouch: false,
          reasonCode: 'native-sidecar-unavailable',
        },
      },
    ];
    const api = installStatus(statusValue);
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    let resolveRecovery!: (value: IOSSimulatorToolResponse) => void;
    api.retryNativeRoute.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecovery = resolve;
        }),
    );

    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: instance.instanceId }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    const recoveryButton = await screen.findByRole('button', {
      name: 'rightSidebar.iosSimulator.nativeRecovery.action',
    });
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = rendered.container.querySelector('img');
    expect(image?.className).toContain('w-full');
    expect(image?.className).not.toContain('max-h-[520px]');
    const textInput = screen.getByLabelText(
      'rightSidebar.iosSimulator.textInputLabel',
    ) as HTMLInputElement;
    expect(textInput.disabled).toBe(false);

    fireEvent.click(recoveryButton);
    await waitFor(() => {
      expect(api.retryNativeRoute).toHaveBeenCalledWith({
        sessionId: 'session-a',
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
        viewerToken: expect.any(String),
      });
      expect(
        (
          screen.getByRole('button', {
            name: 'rightSidebar.iosSimulator.nativeRecovery.recoveringAction',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(textInput.disabled).toBe(false);

    resolveRecovery({ ok: true, data: { nativeRecovered: false } });
    await screen.findByText('rightSidebar.iosSimulator.nativeRecovery.failed');
    expect(rendered.container.querySelector('img')).toBeTruthy();
    expect(textInput.disabled).toBe(false);
  });

  it('ignores an explicit Native recovery result after the viewer switches devices', async () => {
    const statusValue = multiReadyStatus();
    if (!statusValue.ok) throw new Error('Expected a ready simulator status.');
    statusValue.routeStatuses = statusValue.instances.map((instance) => ({
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      generation: instance.generation,
      updatedAt: '2026-08-06T00:00:00.000Z',
      nativeRecoveryAvailable: true,
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'fallback',
        reasonCode: 'native-sidecar-unavailable',
      },
      input: {
        adapter: 'wda',
        state: 'fallback',
        continuous: false,
        multiTouch: false,
        reasonCode: 'native-sidecar-unavailable',
      },
    }));
    const api = installStatus(statusValue);
    const jpegResult = (
      request: IOSSimulatorViewerVisibilityRequest,
    ): IOSSimulatorToolResponse => ({
      ok: true,
      data: {
        stream: {
          instanceId: request.instanceId,
          generation: request.generation,
          state: 'streaming',
          reconnectAttempt: 0,
          latestFrame: {
            instanceId: request.instanceId,
            generation: request.generation,
            sequence: 1,
            encoding: 'jpeg',
            receivedAt: '2026-08-06T00:00:00.000Z',
            bytes: new Uint8Array([1, 2, 3]),
          },
        },
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    });
    api.setViewerVisibility.mockImplementation(async (request) => jpegResult(request));
    api.latestFrame.mockImplementation(async (request?: unknown) =>
      jpegResult({
        ...(request as IOSSimulatorViewerVisibilityRequest),
        viewerToken: 'poll',
        visible: true,
        preferredEncoding: 'jpeg',
      }),
    );
    let resolveA!: (value: IOSSimulatorToolResponse) => void;
    let resolveB!: (value: IOSSimulatorToolResponse) => void;
    api.retryNativeRoute.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          if (request.instanceId === 'instance-a') resolveA = resolve;
          else resolveB = resolve;
        }),
    );

    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    const recoveryButtonA = (await screen.findByRole('button', {
      name: 'rightSidebar.iosSimulator.nativeRecovery.action',
    })) as HTMLButtonElement;
    await waitFor(() => expect(recoveryButtonA.disabled).toBe(false));
    fireEvent.click(recoveryButtonA);
    await waitFor(() => expect(api.retryNativeRoute).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-b' }} ctx={ctx} active shellVisible />,
    );
    const recoveryButtonB = (await screen.findByRole('button', {
      name: 'rightSidebar.iosSimulator.nativeRecovery.action',
    })) as HTMLButtonElement;
    await waitFor(() => expect(recoveryButtonB.disabled).toBe(false));
    fireEvent.click(recoveryButtonB);
    await waitFor(() => {
      expect(api.retryNativeRoute).toHaveBeenCalledTimes(2);
      expect(api.retryNativeRoute).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'instance-b' }),
      );
    });

    await act(async () => {
      resolveA({ ok: true, data: { nativeRecovered: false } });
      await Promise.resolve();
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'rightSidebar.iosSimulator.nativeRecovery.recoveringAction',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText('rightSidebar.iosSimulator.nativeRecovery.failed')).toBeNull();

    await act(async () => {
      resolveB({ ok: true, data: { nativeRecovered: false } });
      await Promise.resolve();
    });
    await screen.findByText('rightSidebar.iosSimulator.nativeRecovery.failed');
  });

  it('streams pointer samples through native touch and temporarily boosts frame rate', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
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
    });
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = rendered.container.querySelector('img') as HTMLImageElement;
    Object.defineProperties(image, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });

    fireEvent.pointerDown(image, { pointerId: 7, button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerMove(image, { pointerId: 7, buttons: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(image, { pointerId: 7, clientX: 180, clientY: 360 });

    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual([
        'begin',
        'move',
        'end',
      ]);
    });
    expect(api.liveTouch.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 2,
      leaseId: 'lease-a',
      phase: 'begin',
      xRatio: 0.1,
      yRatio: 0.1,
    });
    expect(api.liveTouch.mock.calls[2]?.[0]).toMatchObject({
      phase: 'end',
      xRatio: 0.9,
      yRatio: 0.9,
    });
    expect(api.setStreamProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      }),
    );
    await waitFor(
      () => {
        expect(api.setStreamProfile).toHaveBeenLastCalledWith(
          expect.objectContaining({
            profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
          }),
        );
      },
      { timeout: 1_000 },
    );
    expect(api.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^(tap|swipe)$/) }),
    );
  });

  it('finishes a captured gesture when pointer movement reports that the button is released', async () => {
    const api = installStatus(readyStatus());
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = preparePointerTarget(rendered.container);

    fireEvent.pointerDown(image, {
      pointerId: 8,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 40,
    });
    fireEvent.pointerMove(image, {
      pointerId: 8,
      buttons: 0,
      clientX: 180,
      clientY: 360,
    });

    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual(['begin', 'end']);
    });
    fireEvent.pointerMove(image, {
      pointerId: 8,
      buttons: 0,
      clientX: 100,
      clientY: 200,
    });
    expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual(['begin', 'end']);
    expect(image.releasePointerCapture).toHaveBeenCalledWith(8);
    expect(api.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^(tap|swipe)$/) }),
    );
  });

  it('cancels native touch when pointer capture is lost', async () => {
    const api = installStatus(readyStatus());
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = preparePointerTarget(rendered.container);

    fireEvent.pointerDown(image, {
      pointerId: 9,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 40,
    });
    fireEvent.lostPointerCapture(image, { pointerId: 9 });

    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual([
        'begin',
        'cancel',
      ]);
    });
    expect(api.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^(tap|swipe)$/) }),
    );
  });

  it('releases a partially delivered native gesture without replaying the swipe', async () => {
    const api = installStatus(readyStatus());
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    api.liveTouch.mockImplementation(async (request): Promise<IOSSimulatorToolResponse> =>
      request.phase === 'move'
        ? {
            ok: false,
            errorCode: 'IOS_SIMULATOR_HOST_ERROR',
            message: 'The native move failed.',
          }
        : { ok: true, data: {} },
    );
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = preparePointerTarget(rendered.container);

    fireEvent.pointerDown(image, {
      pointerId: 10,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 40,
    });
    fireEvent.pointerMove(image, {
      pointerId: 10,
      buttons: 1,
      clientX: 100,
      clientY: 200,
    });

    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual([
        'begin',
        'move',
        'cancel',
      ]);
    });
    fireEvent.pointerUp(image, { pointerId: 10, clientX: 180, clientY: 360 });
    expect(api.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^(tap|swipe)$/) }),
    );

    fireEvent.pointerDown(image, {
      pointerId: 11,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 40,
    });
    fireEvent.pointerUp(image, { pointerId: 11, clientX: 20, clientY: 40 });
    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual([
        'begin',
        'move',
        'cancel',
        'begin',
        'end',
      ]);
    });
  });

  it('uses the discrete compatibility route only when native touch never began', async () => {
    const api = installStatus(readyStatus());
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame.mockResolvedValue(streamingJpegResult());
    api.liveTouch.mockResolvedValue({
      ok: false,
      errorCode: 'NATIVE_INPUT_UNAVAILABLE',
      message: 'Continuous native input is unavailable.',
    });
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const image = preparePointerTarget(rendered.container);

    fireEvent.pointerDown(image, {
      pointerId: 12,
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 40,
    });
    fireEvent.pointerUp(image, { pointerId: 12, clientX: 180, clientY: 360 });

    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'swipe',
        args: expect.objectContaining({
          instanceId: 'instance-a',
          startXRatio: 0.1,
          startYRatio: 0.1,
          endXRatio: 0.9,
          endYRatio: 0.9,
        }),
      });
    });
    expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual(['begin']);
  });

  it('rejects a frame that belongs to an obsolete simulator generation', async () => {
    const api = installStatus(readyStatus());
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult(1));
    api.latestFrame.mockResolvedValue(streamingJpegResult(1));

    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-a', generation: 2, visible: true }),
      );
    });
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'rightSidebar.iosSimulator.pressHome',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('disables simulator input when the presented frame stops refreshing', async () => {
    const api = installStatus(readyStatus());
    let resolveViewer!: (result: IOSSimulatorToolResponse) => void;
    api.setViewerVisibility.mockImplementationOnce(
      () =>
        new Promise<IOSSimulatorToolResponse>((resolve) => {
          resolveViewer = resolve;
        }),
    );
    api.latestFrame.mockImplementation(() => new Promise<IOSSimulatorToolResponse>(() => {}));
    let expireFreshness: (() => void) | null = null;
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 3_000 && typeof handler === 'function') {
        expireFreshness = () => handler(...args);
        return 30_001;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);

    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(api.setViewerVisibility).toHaveBeenCalledTimes(1));
    act(() => resolveViewer(streamingJpegResult()));
    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    const homeButton = screen.getByRole('button', {
      name: 'rightSidebar.iosSimulator.pressHome',
    }) as HTMLButtonElement;
    expect(homeButton.disabled).toBe(false);

    act(() => expireFreshness?.());

    expect(homeButton.disabled).toBe(true);
  });

  it('clears the last frame and keeps only recovery actions after an external shutdown', async () => {
    const readyInstance = {
      instanceId: 'instance-a',
      sessionId: 'session-a',
      sessionKind: 'local' as const,
      sourceFingerprint: 'fingerprint-a',
      simulatorUdid: 'DEVICE-UDID-123',
      simulatorName: 'iPhone 17 Pro',
      runtimeIdentifier: 'runtime',
      deviceTypeIdentifier: 'type',
      creationProvenance: 'external' as const,
      bootProvenance: 'preexisting' as const,
      generation: 2,
      lifecycleState: 'ready' as const,
      viewerState: 'attached' as const,
      healthState: 'healthy' as const,
      lease: {
        id: 'lease-a',
        issuedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-07-23T00:10:00.000Z',
      },
      createdAt: '2026-07-23T00:00:00.000Z',
      lastActiveAt: '2026-07-23T00:00:00.000Z',
      stoppedAt: null,
      graceExpiresAt: null,
      errorCode: null,
    };
    const stoppedInstance = {
      ...readyInstance,
      generation: 3,
      lifecycleState: 'stopped' as const,
      stoppedAt: '2026-08-04T09:00:00.000Z',
      lease: {
        id: 'lease-b',
        issuedAt: '2026-08-04T09:00:00.000Z',
        expiresAt: '2026-08-04T09:10:00.000Z',
      },
    };
    const environment = {
      platform: 'darwin' as const,
      supported: true,
      ready: true,
      xcodeVersion: 'Xcode 26.4',
      runtimes: [],
      devices: [],
      issue: null,
      error: null,
      setupSteps: [],
    };
    const readyStatus: IOSSimulatorSessionStatus = {
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [readyInstance],
      environment,
    };
    const stoppedStatus: IOSSimulatorSessionStatus = {
      ...readyStatus,
      instances: [stoppedInstance],
    };
    const api = installStatus(readyStatus);
    api.status.mockResolvedValueOnce(readyStatus).mockResolvedValue(stoppedStatus);
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    let resolveLatestFrame: ((result: IOSSimulatorToolResponse) => void) | null = null;
    api.latestFrame.mockImplementationOnce(
      () =>
        new Promise<IOSSimulatorToolResponse>((resolve) => {
          resolveLatestFrame = resolve;
        }),
    );

    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => expect(rendered.container.querySelector('img')).toBeTruthy());
    act(() => {
      resolveLatestFrame?.({
        ok: true,
        data: {
          instance: stoppedInstance,
          stream: null,
          viewport: null,
        },
      });
    });

    await waitFor(() => {
      expect(rendered.container.querySelector('img')).toBeNull();
      expect(screen.getByText('rightSidebar.iosSimulator.viewerStoppedTitle')).toBeTruthy();
      expect(screen.getByText('rightSidebar.iosSimulator.viewerStoppedDescription')).toBeTruthy();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:ios-simulator-1');
    expect(
      screen.getByRole('button', { name: 'rightSidebar.iosSimulator.startDevice' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.iosSimulator.detachDevice' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.iosSimulator.pressHome' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.iosSimulator.stopDevice' }),
    ).toBeNull();
    expect(screen.queryByText('rightSidebar.iosSimulator.agentControlTitle')).toBeNull();
  });

  it('maps host error codes to stable localized setup steps', () => {
    expect(setupStepKeys('XCODE_NOT_FOUND')).toEqual([
      'rightSidebar.iosSimulator.setup.installXcode',
      'rightSidebar.iosSimulator.setup.selectXcode',
    ]);
  });

  it('requests H.264 when WebCodecs is available and presents the first decoded canvas frame', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ clearRect: vi.fn(), drawImage }) as never,
    );
    class FakeVideoDecoder {
      static async isConfigSupported() {
        return { supported: true };
      }
      constructor(
        private readonly callbacks: {
          output(frame: { close(): void }): void;
          error(error: DOMException): void;
        },
      ) {}
      configure() {}
      decode() {
        this.callbacks.output({ close: vi.fn() });
      }
      close() {}
    }
    class FakeEncodedVideoChunk {
      constructor(readonly init: unknown) {}
    }
    Object.defineProperty(globalThis, 'VideoDecoder', {
      configurable: true,
      value: FakeVideoDecoder,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: FakeEncodedVideoChunk,
    });
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
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
    });
    const connectingH264: IOSSimulatorToolResponse = {
      ok: true,
      data: {
        stream: {
          instanceId: 'instance-a',
          generation: 2,
          state: 'connecting',
          reconnectAttempt: 0,
          latestFrame: null,
        },
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    };
    api.setViewerVisibility.mockResolvedValue(connectingH264);
    api.latestFrame.mockResolvedValue(connectingH264);
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      );
    });
    act(() => {
      api.emitH264Frame({
        frame: {
          instanceId: 'instance-a',
          generation: 2,
          sequence: 1,
          encoding: 'h264',
          format: 'annex-b',
          bytes: new Uint8Array([
            0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
            0x88,
          ]).buffer,
          receivedAt: '2026-07-24T00:00:00.000Z',
          width: 1206,
          height: 2622,
          orientation: 'PORTRAIT',
          scale: 3,
          colorSpace: 'srgb',
          timestampMicros: 0,
          keyFrame: true,
        },
      });
    });

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1206, 2622);
      expect(rendered.container.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('false');
    });
  });

  it('retries H.264 after a transient stream disconnect instead of silently selecting JPEG', async () => {
    class FakeVideoDecoder {
      static async isConfigSupported() {
        return { supported: true };
      }
      constructor() {}
      configure() {}
      decode() {}
      close() {}
    }
    class FakeEncodedVideoChunk {
      constructor(readonly init: unknown) {}
    }
    Object.defineProperty(globalThis, 'VideoDecoder', {
      configurable: true,
      value: FakeVideoDecoder,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: FakeEncodedVideoChunk,
    });
    const api = installStatus(readyStatus());
    const disconnectedH264: IOSSimulatorToolResponse = {
      ok: true,
      data: {
        stream: {
          instanceId: 'instance-a',
          generation: 2,
          state: 'disconnected',
          reconnectAttempt: 1,
          latestFrame: null,
        },
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    };
    const connectingH264: IOSSimulatorToolResponse = {
      ok: true,
      data: {
        stream: {
          instanceId: 'instance-a',
          generation: 2,
          state: 'connecting',
          reconnectAttempt: 1,
          latestFrame: null,
        },
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    };
    api.setViewerVisibility
      .mockResolvedValueOnce(disconnectedH264)
      .mockResolvedValue(connectingH264);
    api.latestFrame.mockResolvedValue(connectingH264);

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      const visibleRequests = api.setViewerVisibility.mock.calls
        .map(([request]) => request)
        .filter((request) => request.visible);
      expect(visibleRequests.length).toBeGreaterThanOrEqual(2);
      expect(visibleRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
        ]),
      );
      expect(visibleRequests).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ visible: true, preferredEncoding: 'jpeg' }),
        ]),
      );
    });
  });

  it('renews an expired viewer route and retries the user interaction once', async () => {
    const statusWithLease = (leaseId: string): IOSSimulatorSessionStatus => ({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: leaseId,
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
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
    });
    const api = installStatus(statusWithLease('lease-expired'));
    api.status
      .mockResolvedValueOnce(statusWithLease('lease-expired'))
      .mockResolvedValueOnce(statusWithLease('lease-renewed'))
      .mockResolvedValue(statusWithLease('lease-retried'));
    api.setViewerVisibility.mockResolvedValue(streamingJpegResult());
    api.latestFrame
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'LEASE_EXPIRED',
        message: 'The simulator control lease expired.',
      })
      .mockResolvedValue(streamingJpegResult(2, 2));
    api.call
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'LEASE_EXPIRED',
        message: 'The simulator control lease expired.',
      })
      .mockResolvedValue({ ok: true, data: {} });

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(api.status).toHaveBeenCalledTimes(2);
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: 'lease-renewed', visible: true }),
      );
      expect(
        (
          screen.getByRole('button', {
            name: 'rightSidebar.iosSimulator.pressHome',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.pressHome' }));

    await waitFor(() => {
      expect(api.call).toHaveBeenNthCalledWith(1, {
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-a',
          generation: 2,
          leaseId: 'lease-renewed',
        },
      });
      expect(api.call).toHaveBeenNthCalledWith(2, {
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-a',
          generation: 2,
          leaseId: 'lease-retried',
        },
      });
    });
  });

  it('shows a compact multi-instance overview and starts background streams for ready devices', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-A',
          simulatorName: 'iPhone A',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 1,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
        {
          instanceId: 'instance-b',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-b',
          simulatorUdid: 'DEVICE-B',
          simulatorName: 'iPhone B',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-b',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
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
    });

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.instancesOverview')).toBeTruthy();
      expect(screen.getAllByText('iPhone A').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('iPhone B').length).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-b', visible: true }),
      );
      expect(api.setStreamProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-b',
          profile: { framesPerSecond: 5, jpegQuality: 25, scalingPercent: 50 },
        }),
      );
    });
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.sendText',
      'iPhone B rightSidebar.iosSimulator.sendText — rightSidebar.iosSimulator.enterTextBeforeSending',
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.pressHome',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
        },
      });
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.rotateDevice',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'set_orientation',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
          orientation: 'LANDSCAPE',
        },
      });
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.lockScreen',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'lock_screen',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
        },
      });
    });

    const tileInput = screen.getByRole('textbox', {
      name: 'iPhone B rightSidebar.iosSimulator.textInputLabel',
    });
    fireEvent.change(tileInput, { target: { value: 'hello' } });
    fireEvent.keyDown(tileInput, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'type_text',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
          text: 'hello',
        },
      });
    });
  });

  it('does not apply a background stream profile after the grid is hidden', async () => {
    const api = installStatus(multiReadyStatus());
    let resolvePendingVisibility!: (result: IOSSimulatorToolResponse) => void;
    const pendingVisibility = new Promise<IOSSimulatorToolResponse>((resolve) => {
      resolvePendingVisibility = resolve;
    });
    api.setViewerVisibility.mockImplementation(async (request) => {
      if (request.instanceId === 'instance-b' && request.visible) return pendingVisibility;
      return { ok: true, data: { stream: null } };
    });

    const { rerender } = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-b', visible: true }),
      );
    });

    rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: 'instance-a' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-b', visible: false }),
      );
    });

    await act(async () => {
      resolvePendingVisibility({ ok: true, data: { stream: null } });
      await pendingVisibility;
    });

    expect(api.setStreamProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'instance-b' }),
    );
  });

  it('blocks grid gestures while an Agent owns or queues device input', async () => {
    const status = multiReadyStatus([
      {
        instanceId: 'instance-b',
        activeSource: 'agent',
        lastSource: 'agent',
        queuedAgentMutations: 0,
        agentPaused: false,
        takeoverPending: false,
      },
    ]);
    const api = installStatus(status);
    installGridFrames(api);

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    const image = (await screen.findByAltText('iPhone B')) as HTMLImageElement;
    Object.defineProperties(image, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.pressHome',
      'iPhone B rightSidebar.iosSimulator.pressHome — rightSidebar.iosSimulator.agentBusyDescription',
    );
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.rotateDevice',
      'iPhone B rightSidebar.iosSimulator.rotateDevice — rightSidebar.iosSimulator.agentBusyDescription',
    );
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.lockScreen',
      'iPhone B rightSidebar.iosSimulator.lockScreen — rightSidebar.iosSimulator.agentBusyDescription',
    );
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.unlockScreen',
      'iPhone B rightSidebar.iosSimulator.unlockScreen — rightSidebar.iosSimulator.agentBusyDescription',
    );
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.sendText',
      'iPhone B rightSidebar.iosSimulator.sendText — rightSidebar.iosSimulator.agentBusyDescription',
    );

    fireEvent.pointerDown(image, { pointerId: 41, button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerUp(image, { pointerId: 41, clientX: 180, clientY: 360 });

    expect(image.setPointerCapture).not.toHaveBeenCalled();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('releases a grid gesture without dispatching it when Agent input becomes busy', async () => {
    const initialStatus = multiReadyStatus();
    const api = installStatus(initialStatus);
    let liveMutation: IOSSimulatorMutationState | null = null;
    installGridFrames(api, (instanceId) => (instanceId === 'instance-b' ? liveMutation : null));

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    const image = (await screen.findByAltText('iPhone B')) as HTMLImageElement;
    Object.defineProperties(image, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });
    fireEvent.pointerDown(image, { pointerId: 42, button: 0, clientX: 20, clientY: 40 });
    expect(image.setPointerCapture).toHaveBeenCalledWith(42);

    liveMutation = {
      instanceId: 'instance-b',
      activeSource: null,
      lastSource: 'agent',
      queuedAgentMutations: 1,
      agentPaused: false,
      takeoverPending: false,
    };
    await waitFor(
      () =>
        expectDisabledIconButton(
          'iPhone B rightSidebar.iosSimulator.pressHome',
          'iPhone B rightSidebar.iosSimulator.pressHome — rightSidebar.iosSimulator.agentBusyDescription',
        ),
      { timeout: 2_000 },
    );
    expect(api.status).toHaveBeenCalledOnce();

    fireEvent.pointerUp(image, { pointerId: 42, clientX: 180, clientY: 360 });

    expect(image.releasePointerCapture).toHaveBeenCalledWith(42);
    expect(api.call).not.toHaveBeenCalled();
  });

  it('drops a stale grid route and retries when its refresh is superseded', async () => {
    const instanceA: IOSSimulatorPublicInstance = {
      ...readyInstance(1),
      simulatorName: 'iPhone A',
      lease: { ...readyInstance(1).lease, id: 'lease-a' },
    };
    const instanceB: IOSSimulatorPublicInstance = {
      ...readyInstance(2),
      instanceId: 'instance-b',
      simulatorUdid: 'DEVICE-B',
      simulatorName: 'iPhone B',
      lease: { ...readyInstance(2).lease, id: 'lease-b' },
    };
    const stoppedB: IOSSimulatorPublicInstance = {
      ...instanceB,
      generation: 3,
      lifecycleState: 'stopped',
      lease: { ...instanceB.lease, id: 'lease-b-renewed' },
      stoppedAt: '2026-07-24T00:00:00.000Z',
    };
    const readyBaseStatus = readyStatus(instanceA);
    if (!readyBaseStatus.ok) throw new Error('Expected a ready status fixture.');
    const initialStatus: IOSSimulatorSessionStatus = {
      ...readyBaseStatus,
      instances: [instanceA, instanceB],
    };
    const reconciledStatus: IOSSimulatorSessionStatus = {
      ...initialStatus,
      instances: [instanceA, stoppedB],
    };
    const api = installStatus(initialStatus);
    let resolveSupersededRefresh: (status: IOSSimulatorSessionStatus) => void = () => undefined;
    const supersededRefresh = new Promise<IOSSimulatorSessionStatus>((resolve) => {
      resolveSupersededRefresh = resolve;
    });
    api.status
      .mockResolvedValueOnce(initialStatus)
      .mockImplementationOnce(async () => supersededRefresh)
      .mockRejectedValueOnce(new Error('newer status request failed'))
      .mockResolvedValue(reconciledStatus);
    let instanceBPolls = 0;
    api.latestFrame.mockImplementation(async (request?: unknown) => {
      const route = request as { instanceId?: string } | undefined;
      if (route?.instanceId !== 'instance-b') {
        return { ok: true, data: { stream: null } };
      }
      instanceBPolls += 1;
      if (instanceBPolls === 1) {
        return {
          ok: true,
          data: {
            stream: {
              instanceId: 'instance-b',
              generation: 2,
              state: 'streaming',
              reconnectAttempt: 0,
              latestFrame: {
                instanceId: 'instance-b',
                generation: 2,
                sequence: 1,
                encoding: 'jpeg',
                receivedAt: '2026-07-24T00:00:00.000Z',
                bytes: new Uint8Array([1, 2, 3]),
              },
            },
          },
        };
      }
      return {
        ok: true,
        data: { instance: stoppedB, stream: null, viewport: null },
      };
    });

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    const staleImage = (await screen.findByAltText('iPhone B')) as HTMLImageElement;
    Object.defineProperties(staleImage, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });
    fireEvent.pointerDown(staleImage, {
      pointerId: 31,
      button: 0,
      clientX: 20,
      clientY: 40,
    });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await waitFor(() => expect(screen.queryByAltText('iPhone B')).toBeNull());
    expectDisabledIconButton(
      'iPhone B rightSidebar.iosSimulator.pressHome',
      'iPhone B rightSidebar.iosSimulator.pressHome — rightSidebar.iosSimulator.controlsUnavailable',
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:ios-simulator-1');
    fireEvent.pointerUp(staleImage, {
      pointerId: 31,
      clientX: 180,
      clientY: 360,
    });
    expect(api.call).not.toHaveBeenCalled();

    act(() => {
      api.emitFocusRequest({
        sessionId: 'session-a',
        instanceId: 'instance-b',
        userInitiated: false,
      });
    });
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(3), { timeout: 2_000 });
    await act(async () => {
      resolveSupersededRefresh(reconciledStatus);
      await Promise.resolve();
    });

    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(4), { timeout: 2_000 });
    await waitFor(() => expect(screen.queryByAltText('iPhone B')).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'iPhone B rightSidebar.iosSimulator.pressHome',
        }),
      ).toBeNull(),
    );

    const pollsAfterRefresh = api.latestFrame.mock.calls.filter(
      ([request]) => (request as { instanceId?: string } | undefined)?.instanceId === 'instance-b',
    ).length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(
      api.latestFrame.mock.calls.filter(
        ([request]) =>
          (request as { instanceId?: string } | undefined)?.instanceId === 'instance-b',
      ),
    ).toHaveLength(pollsAfterRefresh);
  });
});

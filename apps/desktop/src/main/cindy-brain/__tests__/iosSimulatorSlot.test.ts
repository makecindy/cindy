import { describe, expect, it, vi } from 'vitest';

import type { GhostIOSSimulatorStatusProbeResult, InstalledGhost } from '../../../shared/ghost';
import {
  GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS,
  GHOST_IOS_SIMULATOR_STATUS_CACHE_MS,
  GhostIOSSimulatorSlot,
  type IOSSimulatorSlotDeps,
  type IOSSimulatorSlotFocusContext,
} from '../iosSimulatorSlot';

function simulatorGhost(options: { enabled?: boolean; slots?: string[] } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'ios-simulator',
      name: 'iOS Simulator',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: options.slots ?? ['ios-simulator'],
    },
    dir: '/fake/ios-simulator',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function readyStatus(): GhostIOSSimulatorStatusProbeResult {
  return {
    ok: true,
    status: {
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: '26.0',
        availableDeviceCount: 2,
      },
      instances: [
        {
          instanceId: 'instance-a',
          simulatorName: 'iPhone 17 Pro',
          generation: 1,
          lifecycleState: 'ready',
          healthState: 'healthy',
        },
      ],
      routeStatuses: [
        {
          instanceId: 'instance-a',
          generation: 1,
          stream: { adapter: 'native-sidecar', encoding: 'h264', state: 'active' },
          input: { adapter: 'native-sidecar', state: 'active' },
        },
      ],
    },
  };
}

function sameContext(
  left: IOSSimulatorSlotFocusContext | null,
  right: IOSSimulatorSlotFocusContext,
): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.windowWebContentsId === right.windowWebContentsId &&
    left.revision === right.revision
  );
}

function makeSlot(overrides: Partial<IOSSimulatorSlotDeps> = {}) {
  let clock = 0;
  let revision = 1;
  let context: IOSSimulatorSlotFocusContext | null = {
    sessionId: 'session-a',
    windowWebContentsId: 101,
    revision,
  };
  const deps: IOSSimulatorSlotDeps = {
    getGhost: () => simulatorGhost(),
    focusedContext: () => context,
    authorizeFocusedContext: vi.fn(async () => context),
    isContextCurrent: (candidate) => sameContext(context, candidate),
    getStatus: vi.fn(async () => readyStatus()),
    focusViewer: vi.fn(() => true),
    now: () => clock,
    ...overrides,
  };
  return {
    slot: new GhostIOSSimulatorSlot(deps),
    deps,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    setContext: (sessionId: string | null, windowWebContentsId = 101) => {
      revision += 1;
      context = sessionId ? { sessionId, windowWebContentsId, revision } : null;
    },
    context: () => context,
  };
}

describe('GhostIOSSimulatorSlot', () => {
  it('requires the explicit slot and an enabled plugin', async () => {
    const noSlot = makeSlot({ getGhost: () => simulatorGhost({ slots: ['panel'] }) });
    await expect(
      noSlot.slot.handleRequest('ios-simulator', { kind: 'status' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });

    const disabled = makeSlot({ getGhost: () => simulatorGhost({ enabled: false }) });
    await expect(
      disabled.slot.handleRequest('ios-simulator', { kind: 'status' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('reports the fixed low-bandwidth capability contract without a focused task', async () => {
    const test = makeSlot();
    test.setContext(null);
    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'capabilities' }),
    ).resolves.toEqual({
      ok: true,
      apiVersion: 1,
      kind: 'capabilities',
      capabilities: {
        status: true,
        openHostPanel: true,
        pluginVideo: false,
        pluginInput: false,
      },
    });
  });

  it('derives task identity from Host focus and exposes only the redacted status DTO', async () => {
    const { slot, deps } = makeSlot();
    const result = await slot.handleRequest('ios-simulator', { kind: 'status' });
    expect(deps.getStatus).toHaveBeenCalledWith('session-a');
    expect(result).toEqual({
      ok: true,
      apiVersion: 1,
      kind: 'status',
      status: (readyStatus() as Extract<GhostIOSSimulatorStatusProbeResult, { ok: true }>).status,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('session-a');
    expect(serialized).not.toContain('simulatorUdid');
    expect(serialized).not.toContain('sourceFingerprint');
    expect(serialized).not.toContain('lease');
    expect(serialized).not.toContain('deviceGrants');
    expect(serialized).not.toContain('mutationStates');
  });

  it('rejects caller-supplied identity, unknown operations, and malformed instance IDs', async () => {
    const { slot, deps } = makeSlot();
    await expect(
      slot.handleRequest('ios-simulator', { kind: 'status', sessionId: 'forged-session' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    await expect(
      slot.handleRequest('ios-simulator', { kind: 'stream-frames' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    await expect(
      slot.handleRequest('ios-simulator', { kind: 'open-panel', instanceId: ' '.repeat(2) }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(deps.getStatus).not.toHaveBeenCalled();
  });

  it('opens only a current-task instance and can open an unbound Host panel', async () => {
    const test = makeSlot();
    const initialContext = test.context();
    await expect(
      test.slot.handleRequest('ios-simulator', {
        kind: 'open-panel',
        instanceId: 'instance-a',
      }),
    ).resolves.toEqual({
      ok: true,
      apiVersion: 1,
      kind: 'open-panel',
      instanceId: 'instance-a',
    });
    expect(test.deps.focusViewer).toHaveBeenCalledWith(initialContext, 'instance-a');

    test.advance(GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS);
    await expect(test.slot.handleRequest('ios-simulator', { kind: 'open-panel' })).resolves.toEqual(
      { ok: true, apiVersion: 1, kind: 'open-panel' },
    );
    expect(test.deps.focusViewer).toHaveBeenCalledWith(initialContext, undefined);

    test.advance(GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS);
    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'open-panel', instanceId: 'foreign' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INSTANCE_NOT_OWNED' });
  });

  it('explicitly authorizes a cold open-panel request without prompting for status', async () => {
    const grantedContext: IOSSimulatorSlotFocusContext = {
      sessionId: 'session-a',
      windowWebContentsId: 101,
      revision: 2,
    };
    let context: IOSSimulatorSlotFocusContext | null = null;
    const authorizeFocusedContext = vi.fn(async () => {
      context = grantedContext;
      return grantedContext;
    });
    const test = makeSlot({
      focusedContext: () => context,
      authorizeFocusedContext,
      isContextCurrent: (candidate) => sameContext(context, candidate),
    });

    await expect(test.slot.handleRequest('ios-simulator', { kind: 'open-panel' })).resolves.toEqual(
      { ok: true, apiVersion: 1, kind: 'open-panel' },
    );
    expect(authorizeFocusedContext).toHaveBeenCalledTimes(1);
    expect(test.deps.getStatus).toHaveBeenCalledWith('session-a');
    expect(test.deps.focusViewer).toHaveBeenCalledWith(grantedContext, undefined);

    context = null;
    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'status' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(authorizeFocusedContext).toHaveBeenCalledTimes(1);
  });

  it('rate-limits cold open attempts before requesting another authorization', async () => {
    const authorizeFocusedContext = vi.fn(async () => null);
    const test = makeSlot({
      focusedContext: () => null,
      authorizeFocusedContext,
    });

    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'open-panel' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(authorizeFocusedContext).toHaveBeenCalledTimes(1);

    test.advance(GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS - 1);
    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'open-panel' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    expect(authorizeFocusedContext).toHaveBeenCalledTimes(1);
  });

  it('rate-limits opening before doing another Host status probe', async () => {
    const test = makeSlot();
    expect((await test.slot.handleRequest('ios-simulator', { kind: 'open-panel' })).ok).toBe(true);
    const callsAfterFirstOpen = vi.mocked(test.deps.getStatus).mock.calls.length;
    test.advance(GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS - 1);
    await expect(
      test.slot.handleRequest('ios-simulator', { kind: 'open-panel' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    expect(test.deps.getStatus).toHaveBeenCalledTimes(callsAfterFirstOpen);
  });

  it('single-flights and briefly caches read-only status probes', async () => {
    let resolveStatus!: (value: GhostIOSSimulatorStatusProbeResult) => void;
    const deferred = new Promise<GhostIOSSimulatorStatusProbeResult>((resolve) => {
      resolveStatus = resolve;
    });
    const getStatus = vi.fn(() => deferred);
    const test = makeSlot({ getStatus });
    const first = test.slot.handleRequest('ios-simulator', { kind: 'status' });
    const second = test.slot.handleRequest('ios-simulator', { kind: 'status' });
    expect(getStatus).toHaveBeenCalledTimes(1);
    resolveStatus(readyStatus());
    await expect(first).resolves.toMatchObject({ ok: true, kind: 'status' });
    await expect(second).resolves.toMatchObject({ ok: true, kind: 'status' });

    await test.slot.handleRequest('ios-simulator', { kind: 'status' });
    expect(getStatus).toHaveBeenCalledTimes(1);
    test.advance(GHOST_IOS_SIMULATOR_STATUS_CACHE_MS);
    await test.slot.handleRequest('ios-simulator', { kind: 'status' });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('fails closed if task/window context changes while status is in flight', async () => {
    let resolveStatus!: (value: GhostIOSSimulatorStatusProbeResult) => void;
    const test = makeSlot({
      getStatus: vi.fn(
        () =>
          new Promise<GhostIOSSimulatorStatusProbeResult>((resolve) => {
            resolveStatus = resolve;
          }),
      ),
    });
    const pending = test.slot.handleRequest('ios-simulator', {
      kind: 'open-panel',
      instanceId: 'instance-a',
    });
    test.setContext('session-b', 202);
    test.setContext('session-a', 101);
    resolveStatus(readyStatus());
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(test.deps.focusViewer).not.toHaveBeenCalled();
  });

  it('fails closed for no active task, Host errors, and missing windows', async () => {
    const noTask = makeSlot();
    noTask.setContext(null);
    await expect(
      noTask.slot.handleRequest('ios-simulator', { kind: 'status' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });

    const statusError = makeSlot({
      getStatus: vi.fn(async (): Promise<GhostIOSSimulatorStatusProbeResult> => ({
        ok: false,
        errorCode: 'UNSUPPORTED_SESSION_KIND',
        message: 'Remote tasks are not supported.',
      })),
    });
    await expect(
      statusError.slot.handleRequest('ios-simulator', { kind: 'status' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_SESSION_KIND' });

    const noWindow = makeSlot({ focusViewer: vi.fn(() => false) });
    await expect(
      noWindow.slot.handleRequest('ios-simulator', { kind: 'open-panel' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});

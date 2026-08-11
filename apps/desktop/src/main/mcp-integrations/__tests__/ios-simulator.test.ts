import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  IOSSimulatorDeviceGrantStore,
  IOSSimulatorInstanceActor,
  IOSSimulatorInstanceError,
  IOSSimulatorOwnershipStore,
  IOSSimulatorOwnershipRegistryFile,
  IOSSimulatorProjectBuildError,
  IOSSimulatorResourceScheduler,
  WdaError,
  WdaProcessManager,
  type IOSSimulatorEnvironmentReport,
  type IOSSimulatorH264Frame,
  type IOSSimulatorNativeSidecarDriver,
  type IOSSimulatorSimctlLifecycle,
  type IOSSimulatorStreamStats,
  type IOSSimulatorStreamProfile,
  type IOSSimulatorTouchPoint,
  type WdaRunningInstance,
} from '@cindy/ios-simulator-runtime';
import { IOSSimulatorToolRegistry, registerIOSSimulatorTools } from '@cindy/mcps';
import type { IOSSimulatorPublicRouteStatus } from '../../../shared/iosSimulatorIpc';
import {
  cancelIOSSimulatorSessionOperations,
  cleanupIOSSimulatorRemovedSession,
  createIOSSimulatorHost,
  createRegistryBackedIOSSimulatorDeviceGrantStore,
  createRegistryBackedIOSSimulatorActor,
  disposeIOSSimulatorHost,
  flushIOSSimulatorOwnershipRegistry,
  getIOSSimulatorPluginStatus,
  getIOSSimulatorMcpDeps,
  reconcilePersistedIOSSimulatorOwnership,
  type IOSSimulatorAppLifecycleAdapter,
  type IOSSimulatorMediaCaptureAdapter,
  type IOSSimulatorProjectBuilderAdapter,
} from '../ios-simulator';

const READY_REPORT: IOSSimulatorEnvironmentReport = {
  platform: 'darwin',
  supported: true,
  ready: true,
  xcodeSelectPath: '/Applications/Xcode.app/Contents/Developer',
  xcodeVersion: 'Xcode 26.4\nBuild version 17E192',
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      name: 'iOS 26.4',
      version: '26.4',
      buildVersion: '23E244',
      isAvailable: true,
      availabilityError: null,
    },
  ],
  devices: [
    {
      udid: '1A9D41E0-E031-4AD0-A8B5-847480802E8E',
      name: 'iPhone 17 Pro',
      state: 'Booted',
      isAvailable: true,
      availabilityError: null,
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
};

const itMac = process.platform === 'darwin' ? it : it.skip;

describe('iOS Simulator host', () => {
  function testResourceScheduler() {
    return new IOSSimulatorResourceScheduler({ freeMemoryBytes: () => 100 * 1024 ** 3 });
  }

  function localSession(id: string) {
    return { id, workDir: `/tmp/${id}`, remoteHostId: null };
  }

  it('keeps the default ownership registry lazy for disabled MCP discovery and teardown', async () => {
    const getPath = vi.spyOn(app, 'getPath');
    try {
      const deps = getIOSSimulatorMcpDeps({ isIOSSimulatorEnabled: () => false });

      await expect(deps.describeTools?.({ sessionId: 'disabled-session' })).resolves.toMatchObject({
        ready: false,
      });
      await expect(
        deps.callTool('check_environment', {}, { sessionId: 'disabled-session' }),
      ).resolves.toMatchObject({ errorCode: 'IOS_SIMULATOR_DISABLED' });
      await cancelIOSSimulatorSessionOperations('ordinary-session');
      await flushIOSSimulatorOwnershipRegistry();
      expect(getPath).not.toHaveBeenCalled();
    } finally {
      getPath.mockRestore();
    }
  });

  it('keeps plugin-required discovery passive and returns installation guidance', async () => {
    const getPath = vi.spyOn(app, 'getPath');
    try {
      const deps = getIOSSimulatorMcpDeps({
        resolveAccess: () => ({
          allowed: false,
          errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
          message: 'Open Plugins → Marketplace and install iOS Simulator.',
          data: { action: 'install-plugin', pluginId: 'ios-simulator' },
        }),
      });

      await expect(
        deps.describeTools?.({ sessionId: 'plugin-required-session' }),
      ).resolves.toMatchObject({
        ready: false,
        notice: {
          errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
          data: { action: 'install-plugin', pluginId: 'ios-simulator' },
        },
      });
      await expect(
        deps.callTool('check_environment', {}, { sessionId: 'plugin-required-session' }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
        data: { action: 'install-plugin', pluginId: 'ios-simulator' },
      });
      expect(getPath).not.toHaveBeenCalled();
    } finally {
      getPath.mockRestore();
    }
  });

  it('keeps a cold plugin status probe passive and leaves the ownership writer available', async () => {
    const acquireWriter = vi.spyOn(
      IOSSimulatorOwnershipRegistryFile.prototype,
      'acquireWriterSync',
    );
    const inspectEnvironment = vi.fn(async () => READY_REPORT);
    try {
      await expect(
        getIOSSimulatorPluginStatus('passive-session', {
          getSession: vi.fn(async (id) => localSession(id)),
          inspectEnvironment,
        }),
      ).resolves.toEqual({
        ok: true,
        status: {
          environment: {
            platform: 'darwin',
            supported: true,
            ready: true,
            xcodeVersion: READY_REPORT.xcodeVersion,
            availableDeviceCount: 1,
          },
          instances: [],
          routeStatuses: [],
        },
      });
      expect(inspectEnvironment).toHaveBeenCalledOnce();
      expect(acquireWriter).not.toHaveBeenCalled();
    } finally {
      acquireWriter.mockRestore();
    }
  });

  it.each([
    ['missing', null, 'SESSION_NOT_FOUND'],
    ['archived', { ...localSession('archived'), status: 'archived' as const }, 'SESSION_NOT_FOUND'],
    [
      'remote',
      { ...localSession('remote'), remoteHostId: 'remote-host' },
      'UNSUPPORTED_SESSION_KIND',
    ],
  ])(
    'rejects a %s passive plugin task before inspecting the simulator environment',
    async (_case, session, errorCode) => {
      const inspectEnvironment = vi.fn(async () => READY_REPORT);

      await expect(
        getIOSSimulatorPluginStatus('passive-session', {
          getSession: vi.fn(async () => session),
          inspectEnvironment,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode });
      expect(inspectEnvironment).not.toHaveBeenCalled();
    },
  );

  it('fails a cold plugin status read closed when the account changes during task lookup', async () => {
    let ownerScopeKey = 'cloud:owner-a:1';
    const inspectEnvironment = vi.fn(async () => READY_REPORT);

    await expect(
      getIOSSimulatorPluginStatus('passive-session', {
        getSession: vi.fn(async (id) => {
          ownerScopeKey = 'cloud:owner-b:2';
          return localSession(id);
        }),
        inspectEnvironment,
        getOwnerScopeKey: () => ownerScopeKey,
        isOwnerBoundaryPending: () => false,
        isHostClosing: () => false,
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator status is temporarily unavailable.',
    });
    expect(inspectEnvironment).not.toHaveBeenCalled();
  });

  itMac('fences an ordinary removed task without retaining the default Host lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-lazy-cleanup-'));
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
    const registryPath = path.join(root, 'ios-simulator', 'ownership-registry.json');
    const competingRegistry = new IOSSimulatorOwnershipRegistryFile(registryPath);
    try {
      await expect(cleanupIOSSimulatorRemovedSession('ordinary-session')).resolves.toBeUndefined();

      expect(getPath).toHaveBeenCalledWith('userData');
      await expect(stat(registryPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(competingRegistry.acquireWriterSync()).toBe(true);
    } finally {
      competingRegistry.releaseWriterSync();
      getPath.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  itMac(
    'persists device grants in the active Cindy profile and restores them after restart',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-grants-'));
      const ownershipRegistry = new IOSSimulatorOwnershipRegistryFile(
        path.join(root, 'ios-simulator', 'ownership-registry.json'),
      );
      try {
        expect(ownershipRegistry.acquireWriterSync()).toBe(true);
        const firstStore = createRegistryBackedIOSSimulatorDeviceGrantStore(ownershipRegistry);
        firstStore.set(READY_REPORT.devices[0]!.udid, { agentControl: 'allowed' });

        const restoredStore = createRegistryBackedIOSSimulatorDeviceGrantStore(ownershipRegistry);
        expect(restoredStore.get(READY_REPORT.devices[0]!.udid)).toMatchObject({
          agentControl: 'allowed',
          policySource: 'user',
        });
        restoredStore.set(READY_REPORT.devices[0]!.udid, { agentControl: 'denied' });
        const deniedAfterRestart =
          createRegistryBackedIOSSimulatorDeviceGrantStore(ownershipRegistry);
        expect(deniedAfterRestart.get(READY_REPORT.devices[0]!.udid).agentControl).toBe('denied');
        expect(
          JSON.parse(
            await readFile(path.join(root, 'ios-simulator', 'device-grants.json'), 'utf8'),
          ),
        ).toMatchObject({
          version: 1,
          grants: [{ simulatorUdid: READY_REPORT.devices[0]!.udid }],
        });

        await writeFile(
          path.join(root, 'ios-simulator', 'device-grants.json'),
          '{"version":1,"grants":[',
        );
        const failClosedStore = createRegistryBackedIOSSimulatorDeviceGrantStore(ownershipRegistry);
        expect(failClosedStore.get(READY_REPORT.devices[0]!.udid).agentControl).toBe('unknown');
      } finally {
        ownershipRegistry.releaseWriterSync();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  itMac(
    'recovers pending creates with an empty registry before releasing its writer lease',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-lazy-reconcile-'));
      const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
      const registryPath = path.join(root, 'ios-simulator', 'ownership-registry.json');
      const competingRegistry = new IOSSimulatorOwnershipRegistryFile(registryPath);
      let finishRecovery: (value: readonly string[]) => void = () => undefined;
      const recoverPendingCreatesAtStartup = vi.fn(
        (_owned: readonly { udid: string; name: string }[], _signal?: AbortSignal) =>
          new Promise<readonly string[]>((resolve) => {
            finishRecovery = resolve;
          }),
      );
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        recoverPendingCreatesAtStartup,
        deleteExact: vi.fn(),
      };
      try {
        const recovering = reconcilePersistedIOSSimulatorOwnership({
          createLifecycle: () => lifecycle,
        });
        await vi.waitFor(() => expect(recoverPendingCreatesAtStartup).toHaveBeenCalledOnce());
        expect(recoverPendingCreatesAtStartup).toHaveBeenCalledWith([], expect.any(AbortSignal));
        expect(competingRegistry.acquireWriterSync()).toBe(false);

        finishRecovery([]);
        await expect(recovering).resolves.toBeUndefined();
        expect(competingRegistry.acquireWriterSync()).toBe(true);
      } finally {
        competingRegistry.releaseWriterSync();
        getPath.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  itMac(
    'does not inspect or delete pending markers when the ownership registry is invalid',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-invalid-reconcile-'));
      const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
      const registryPath = path.join(root, 'ios-simulator', 'ownership-registry.json');
      await mkdir(path.dirname(registryPath), { recursive: true });
      await writeFile(registryPath, '{"version":1,"instances":[');
      const createLifecycle = vi.fn();
      const competingRegistry = new IOSSimulatorOwnershipRegistryFile(registryPath);
      try {
        await expect(
          reconcilePersistedIOSSimulatorOwnership({ createLifecycle }),
        ).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
        expect(createLifecycle).not.toHaveBeenCalled();
        expect(competingRegistry.acquireWriterSync()).toBe(true);
      } finally {
        competingRegistry.releaseWriterSync();
        getPath.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('gates an already-created Host on one startup pending-create recovery', async () => {
    let finishRecovery: (value: readonly string[]) => void = () => undefined;
    const recoverPendingCreatesAtStartup = vi.fn(
      (_owned: readonly { udid: string; name: string }[], _signal?: AbortSignal) =>
        new Promise<readonly string[]>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      recoverPendingCreatesAtStartup,
      deleteExact: vi.fn(),
    };
    const inspect = vi.fn(async () => READY_REPORT);
    const host = createIOSSimulatorHost({
      lifecycle,
      runtime: { inspect },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    const firstCall = host.callTool('list_devices', {}, { sessionId: 'session-a' });
    await vi.waitFor(() => expect(recoverPendingCreatesAtStartup).toHaveBeenCalledOnce());
    expect(recoverPendingCreatesAtStartup).toHaveBeenCalledWith([], expect.any(AbortSignal));
    expect(inspect).not.toHaveBeenCalled();

    finishRecovery([]);
    await expect(firstCall).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool('list_devices', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true });
    expect(recoverPendingCreatesAtStartup).toHaveBeenCalledOnce();
  });

  it('retries startup pending-create recovery after the ownership gate becomes available', async () => {
    let recoveryAllowed = false;
    const recoverPendingCreatesAtStartup = vi.fn(async () => [] as readonly string[]);
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      recoverPendingCreatesAtStartup,
      deleteExact: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      canReconcilePendingCreates: () => recoveryAllowed,
    });

    await expect(
      host.callTool('list_devices', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true });
    expect(recoverPendingCreatesAtStartup).not.toHaveBeenCalled();

    recoveryAllowed = true;
    await expect(
      host.callTool('list_devices', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true });
    expect(recoverPendingCreatesAtStartup).toHaveBeenCalledOnce();
  });

  it('does not reconcile Simulator ownership during generic IPC bootstrap', () => {
    const source = readFileSync(new URL('../../maker-ipc/register.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('reconcileIOSSimulatorOwnership');
  });

  it('returns device discovery for a local session', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await expect(host.callTool('list_devices', {}, { sessionId: 'session-a' })).resolves.toEqual({
      ok: true,
      data: {
        devices: READY_REPORT.devices.map((device) => {
          const { availabilityError: _availabilityError, ...safeDevice } = device;
          void _availabilityError;
          return safeDevice;
        }),
        xcodeVersion: 'Xcode 26.4\nBuild version 17E192',
      },
    });
    const environment = await host.callTool('check_environment', {}, { sessionId: 'session-a' });
    expect(environment).not.toHaveProperty('data.xcodeSelectPath');
    expect(environment).not.toHaveProperty('data.devices.0.availabilityError');
  });

  it('keeps Desktop available while a malformed ownership registry fails Simulator closed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-registry-'));
    const registry = new IOSSimulatorOwnershipRegistryFile(path.join(root, 'registry.json'), {
      acquireWriterLease: () => {
        let held = true;
        return {
          isHeld: () => held,
          release: () => {
            held = false;
          },
        };
      },
    });
    await writeFile(registry.filePath, '{"version":1,"instances":[');
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      reconcilePendingCreates: vi.fn(),
      deleteExact: vi.fn(),
    };

    try {
      const persisted = createRegistryBackedIOSSimulatorActor(lifecycle, registry);
      await expect(
        persisted.actor.create({
          sessionId: 'session-a',
          worktreeRoot: '/tmp/session-a',
          sourceFingerprint: 'fingerprint-a',
          name: 'Must not be created',
          templateDevice: {
            ...READY_REPORT.devices[0]!,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          },
        }),
      ).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
      expect(lifecycle.createExact).not.toHaveBeenCalled();
      const host = createIOSSimulatorHost({
        actor: persisted.actor,
        lifecycle,
        canReconcilePendingCreates: persisted.canReconcilePendingCreates,
        runtime: { inspect: vi.fn(async () => READY_REPORT) },
        getSession: vi.fn(async (id) => localSession(id)),
        resolveWorktreeRoot: vi.fn(async () => '/tmp/session-a'),
      });

      await expect(
        host.callTool(
          'attach_device',
          { udid: READY_REPORT.devices[0]!.udid },
          { sessionId: 'session-a', origin: 'user' },
        ),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'DEVICE_BUSY',
        message: expect.stringContaining('ownership registry is invalid'),
      });
      expect(lifecycle.reconcilePendingCreates).not.toHaveBeenCalled();
      expect(registry.isWriter).toBe(true);
      await persisted.flush();
      persisted.release();
      await host.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects task ownership, resource limits, and safe unavailable-device reasons', async () => {
    const unavailableDevice = {
      ...READY_REPORT.devices[0]!,
      udid: 'E223400C-3148-4BE5-9538-A60FE457EF38',
      name: 'iPhone 16',
      state: 'Shutdown',
      isAvailable: false,
      availabilityError: 'runtime profile not found using "System" match policy',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-4',
      runtimeName: 'iOS 18-4',
      runtimeVersion: null,
    };
    const report: IOSSimulatorEnvironmentReport = {
      ...READY_REPORT,
      devices: [READY_REPORT.devices[0]!, unavailableDevice],
    };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-b',
      worktreeRoot: '/tmp/session-b',
      sourceFingerprint: 'fingerprint-b',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const resourceScheduler = testResourceScheduler();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => report) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    const status = await host.getStatus('session-a');

    expect(status).toMatchObject({
      ok: true,
      resource: {
        runningCount: 1,
        softLimit: 2,
        hardLimit: 4,
        maxInstancesPerTask: 4,
      },
      environment: {
        devices: [
          { udid: READY_REPORT.devices[0]!.udid, ownership: 'other-task' },
          {
            udid: unavailableDevice.udid,
            runtimeName: 'iOS 18.4',
            ownership: 'unowned',
            unavailableReason: { code: 'missing-runtime', runtimeName: 'iOS 18.4' },
          },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain('runtime profile not found');
    expect(JSON.stringify(status)).not.toContain('availabilityError');
    expect(JSON.stringify(status)).not.toContain('session-b');
    await expect(
      host.callTool(
        'attach_device',
        { udid: unavailableDevice.udid },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_NOT_FOUND' });
    await host.dispose();
  });

  it('projects cached plugin status without reconciling or renewing ownership', async () => {
    const runtimeInspect = vi.fn(async () => READY_REPORT);
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'private-fingerprint',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const before = actor.getOwned('session-a', attached.instanceId);
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: runtimeInspect },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    const first = await host.getPluginStatus('session-a');
    const second = await host.getPluginStatus('session-a');
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      status: {
        environment: {
          platform: 'darwin',
          ready: true,
          availableDeviceCount: 1,
        },
        instances: [
          {
            instanceId: attached.instanceId,
            simulatorName: 'iPhone 17 Pro',
            generation: attached.generation,
          },
        ],
      },
    });
    expect(runtimeInspect).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('session-a');
    expect(serialized).not.toContain('1A9D41E0-E031-4AD0-A8B5-847480802E8E');
    expect(serialized).not.toContain('private-fingerprint');
    expect(serialized).not.toContain('lease');
    expect(serialized).not.toContain('deviceGrants');
    expect(serialized).not.toContain('mutationStates');

    const after = actor.getOwned('session-a', attached.instanceId);
    expect(after.generation).toBe(before.generation);
    expect(after.lease).toEqual(before.lease);
    await host.dispose();
  });

  it('fails plugin status closed while the account boundary is pending', async () => {
    const getSession = vi.fn(async (id: string) => localSession(id));
    const inspect = vi.fn(async () => READY_REPORT);
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession,
      getOwnerScopeKey: () => 'cloud:owner-a:1',
      isOwnerBoundaryPending: () => true,
    });

    try {
      await expect(host.getPluginStatus('session-a')).resolves.toEqual({
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      });
      expect(getSession).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
    }
  });

  it('does not return an old-owner plugin snapshot when the account changes mid-inspection', async () => {
    let ownerScopeKey = 'cloud:owner-a:1';
    let markInspectionStarted: () => void = () => undefined;
    let releaseInspection: () => void = () => undefined;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'private-fingerprint',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const host = createIOSSimulatorHost({
      actor,
      runtime: {
        inspect: vi.fn(async () => {
          markInspectionStarted();
          await inspectionGate;
          return READY_REPORT;
        }),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      getOwnerScopeKey: () => ownerScopeKey,
      isOwnerBoundaryPending: () => false,
    });

    try {
      const statusPromise = host.getPluginStatus('session-a');
      await inspectionStarted;
      ownerScopeKey = 'cloud:owner-b:2';
      releaseInspection();

      const status = await statusPromise;
      expect(status).toEqual({
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator status is temporarily unavailable.',
      });
      expect(JSON.stringify(status)).not.toContain(attached.instanceId);
    } finally {
      releaseInspection();
      await host.dispose();
    }
  });

  it('keeps build diagnostics host-available without a running simulator instance', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await expect(host.describeTools('session-a')).resolves.toMatchObject({
      tools: {
        build_app: { state: 'requires-instance', backend: 'host' },
        read_build_diagnostics: { state: 'available', backend: 'host' },
      },
    });
  });

  it('reports availability under exactly the advertised simulator tool names', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const registry = new IOSSimulatorToolRegistry();
    registerIOSSimulatorTools(registry, { callTool: vi.fn() });
    const advertised = new Set(registry.list().map((tool) => tool.name));

    // The registry merges this map by advertised name, so a renamed tool that
    // kept its old availability key would silently report TOOL_NOT_REPORTED.
    const reported = Object.keys((await host.describeTools('session-a')).tools).sort();
    expect(reported).toEqual([...advertised].sort());

    // The rejected-session branch reports its own reduced map and must use the
    // same names, or the real rejection reason never reaches discovery.
    const rejectedHost = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });
    const rejected = await rejectedHost.describeTools('missing-session');
    expect(rejected.ready).toBe(false);
    expect(Object.keys(rejected.tools).length).toBeGreaterThan(0);
    for (const [name, availability] of Object.entries(rejected.tools)) {
      expect(advertised.has(name)).toBe(true);
      expect(availability).toBeDefined();
    }
    expect(rejected.tools.list_simulator_devices).toMatchObject({
      state: 'unavailable',
      reasonCode: 'SESSION_NOT_FOUND',
    });

    // Recommendations are model guidance too: naming a superseded tool sends the
    // model back to the ambiguous name this rename hides.
    const doctor = await host.callTool('doctor', {}, { sessionId: 'session-a' });
    const recommended = (doctor as { data: { recommendedActions: string[] } }).data
      .recommendedActions;
    expect(recommended).toContain('list_simulator_devices');
    for (const action of recommended) {
      expect(advertised.has(action) || action === 'create_instance_or_attach_device').toBe(
        true,
      );
    }
  });

  it('removes stale orphaned xcresult bundles during ownership reconciliation', async () => {
    const projectRoot = path.join(
      app.getPath('userData'),
      'ios-simulator',
      'projects',
      `orphan-reconcile-${crypto.randomUUID()}`,
    );
    const staleBundle = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    const freshBundle = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    await mkdir(staleBundle, { recursive: true });
    await mkdir(freshBundle, { recursive: true });
    const staleTime = new Date(Date.now() - 31 * 60_000);
    await utimes(staleBundle, staleTime, staleTime);
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    try {
      await host.reconcileOwnership();

      await expect(stat(staleBundle)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(freshBundle)).resolves.toBeDefined();
    } finally {
      await host.dispose();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reconciles a persisted binding with fresh generation and lease on startup', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const oldRoute = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const status = await host.getStatus('session-a');
    expect(status).toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          generation: attached.generation + 1,
          viewerState: 'detached',
          healthState: 'healthy',
        },
      ],
    });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(host.setViewerVisibility('session-a', oldRoute, true)).resolves.toMatchObject({
      ok: false,
      errorCode: 'STALE_GENERATION',
    });
  });

  it('reconciles ownership again for a new account generation and releases stale capacity', async () => {
    let ownerScopeKey = 'cloud:owner-a:1';
    let ownerBoundaryPending = false;
    let sessionExists = true;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'owner-a-session',
      worktreeRoot: '/tmp/owner-a-session',
      sourceFingerprint: 'owner-a-fingerprint',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'agent-booted',
    });
    const resourceScheduler = new IOSSimulatorResourceScheduler({
      softLimit: 1,
      hardLimit: 1,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });
    const inspect = vi.fn(async () => READY_REPORT);
    const getSession = vi.fn(async (id: string) => (sessionExists ? localSession(id) : null));
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      runtime: { inspect },
      getSession,
      getOwnerScopeKey: () => ownerScopeKey,
      isOwnerBoundaryPending: () => ownerBoundaryPending,
    });

    try {
      await host.reconcileOwnership();
      expect(actor.getOwned(attached.sessionId, attached.instanceId)).toBeDefined();
      expect(resourceScheduler.runningCount()).toBe(1);
      expect(inspect).toHaveBeenCalledTimes(1);

      await host.reconcileOwnership();
      expect(inspect).toHaveBeenCalledTimes(1);

      ownerScopeKey = 'cloud:owner-b:2';
      sessionExists = false;
      ownerBoundaryPending = true;
      await host.reconcileOwnership();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(resourceScheduler.runningCount()).toBe(1);

      ownerBoundaryPending = false;
      await host.reconcileOwnership();
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
        attached.simulatorUdid,
        expect.any(AbortSignal),
      );
      expect(actor.listAll()).toEqual([]);
      expect(resourceScheduler.runningCount()).toBe(0);
    } finally {
      await host.dispose();
    }
  });

  it.each(['success', 'failure'] as const)(
    'waits for an old-owner reconciliation (%s) and then reruns for the current owner',
    async (oldOwnerResult) => {
      let ownerScopeKey = 'cloud:owner-a:1';
      let resolveFirstInspectionStarted: (() => void) | undefined;
      let releaseFirstInspection: (() => void) | undefined;
      const firstInspectionStarted = new Promise<void>((resolve) => {
        resolveFirstInspectionStarted = resolve;
      });
      const firstInspectionGate = new Promise<void>((resolve) => {
        releaseFirstInspection = resolve;
      });
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      };
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
        lifecycle,
      });
      const attached = actor.attach({
        sessionId: 'owner-a-session',
        worktreeRoot: '/tmp/owner-a-session',
        sourceFingerprint: 'owner-a-fingerprint',
        device: READY_REPORT.devices[0]!,
        bootProvenance: 'agent-booted',
      });
      const resourceScheduler = new IOSSimulatorResourceScheduler({
        softLimit: 1,
        hardLimit: 1,
        freeMemoryBytes: () => 100 * 1024 ** 3,
      });
      let sessionReadCount = 0;
      const getSession = vi.fn(async (id: string) => {
        sessionReadCount += 1;
        if (oldOwnerResult === 'success' && sessionReadCount === 1) {
          return localSession(id);
        }
        return null;
      });
      let inspectionCount = 0;
      const inspect = vi.fn(async () => {
        inspectionCount += 1;
        if (inspectionCount === 1) {
          resolveFirstInspectionStarted?.();
          await firstInspectionGate;
          if (oldOwnerResult === 'failure') throw new Error('old owner DB closed');
        }
        return READY_REPORT;
      });
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        resourceScheduler,
        runtime: { inspect },
        getSession,
        getOwnerScopeKey: () => ownerScopeKey,
        isOwnerBoundaryPending: () => false,
      });

      try {
        const ownerAReconcile = host.reconcileOwnership();
        const ownerAOutcome = ownerAReconcile.then(
          () => ({ ok: true as const, error: null }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await firstInspectionStarted;
        ownerScopeKey = 'cloud:owner-b:2';
        const ownerBReconcile = host.reconcileOwnership();
        releaseFirstInspection?.();
        await ownerBReconcile;
        const ownerASettled = await ownerAOutcome;

        if (oldOwnerResult === 'failure') {
          expect(ownerASettled).toMatchObject({
            ok: false,
            error: expect.objectContaining({ message: 'old owner DB closed' }),
          });
        } else {
          expect(ownerASettled).toEqual({ ok: true, error: null });
        }

        expect(getSession).toHaveBeenCalledTimes(oldOwnerResult === 'failure' ? 1 : 2);
        expect(inspect).toHaveBeenCalledTimes(2);
        expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
          attached.simulatorUdid,
          expect.any(AbortSignal),
        );
        expect(actor.listAll()).toEqual([]);
        expect(resourceScheduler.runningCount()).toBe(0);
      } finally {
        releaseFirstInspection?.();
        await host.dispose();
      }
    },
  );

  it('restores persisted detach grace and releases scheduler capacity at its deadline', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const seedActor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({
        clock: { now: () => now },
        createId: () => crypto.randomUUID(),
      }),
      lifecycle,
      clock: { now: () => now },
      scheduler: { schedule: () => () => undefined },
    });
    const attached = seedActor.attach({
      sessionId: 'persisted-grace-session',
      worktreeRoot: '/tmp/persisted-grace-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'agent-booted',
    });
    const detached = await seedActor.detach({
      sessionId: attached.sessionId,
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    });
    now = 101_000;
    const scheduled: Array<{
      delayMs: number;
      task: () => void | Promise<void>;
      cancelled: boolean;
    }> = [];
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({
        clock: { now: () => now },
        createId: () => crypto.randomUUID(),
        initialInstances: [detached],
      }),
      lifecycle,
      clock: { now: () => now },
      scheduler: {
        schedule: (delayMs, task) => {
          const entry = { delayMs, task, cancelled: false };
          scheduled.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
      },
    });
    const resourceScheduler = new IOSSimulatorResourceScheduler({
      softLimit: 1,
      hardLimit: 1,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });
    const driverManager = {
      get: vi.fn(() => null),
      cleanupOrphaned: vi.fn(async () => undefined),
      start: vi.fn(async () => {
        throw new Error('not expected');
      }),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('persisted-grace-session')),
    });

    try {
      await host.reconcileOwnership();

      const reconciled = actor.getOwned(detached.sessionId, detached.instanceId);
      expect(reconciled).toMatchObject({
        generation: detached.generation + 1,
        graceExpiresAt: detached.graceExpiresAt,
      });
      expect(resourceScheduler.runningCount()).toBe(1);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({
        delayMs: Date.parse(detached.graceExpiresAt!) - now,
        cancelled: false,
      });

      await scheduled[0]!.task();
      expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
        detached.simulatorUdid,
        expect.any(AbortSignal),
      );
      expect(actor.listAll()).toEqual([]);
      expect(resourceScheduler.runningCount()).toBe(0);
    } finally {
      await host.dispose();
    }
  });

  it('recovers persisted WDA ownership before marking a booted binding healthy', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'persisted-wda-session',
      worktreeRoot: '/tmp/persisted-wda-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const cleanupOrphaned = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new WdaError('TERMINATION_FAILED', 'orphan still running'));
    const driverManager = {
      get: vi.fn(() => null),
      cleanupOrphaned,
      start: vi.fn(async () => {
        throw new Error('not expected');
      }),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('persisted-wda-session')),
    });

    await host.reconcileOwnership();
    expect(cleanupOrphaned).toHaveBeenCalledWith(attached.instanceId, attached.simulatorUdid);
    expect(actor.getOwned('persisted-wda-session', attached.instanceId)).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'degraded',
      errorCode: 'WDA_UNAVAILABLE',
    });

    await host.reconcileOwnership();
    expect(cleanupOrphaned).toHaveBeenCalledTimes(2);
    expect(actor.getOwned('persisted-wda-session', attached.instanceId)).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'healthy',
      errorCode: null,
    });
    expect(driverManager.stop).not.toHaveBeenCalled();
  });

  it.each(['Booted', 'Booting'] as const)(
    'restores scheduler occupancy for a persisted %s device',
    async (deviceState) => {
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      };
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
        lifecycle,
      });
      const instance = actor.attach({
        sessionId: 'persisted-capacity-session',
        worktreeRoot: '/tmp/persisted-capacity-session',
        sourceFingerprint: 'fingerprint-a',
        device: { ...READY_REPORT.devices[0]!, state: deviceState },
      });
      const resourceScheduler = new IOSSimulatorResourceScheduler({
        softLimit: 1,
        hardLimit: 1,
        freeMemoryBytes: () => 100 * 1024 ** 3,
      });
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        resourceScheduler,
        runtime: {
          inspect: vi.fn(async () => ({
            ...READY_REPORT,
            devices: [{ ...READY_REPORT.devices[0]!, state: deviceState }],
          })),
        },
        getSession: vi.fn(async () => localSession('persisted-capacity-session')),
      });

      await host.reconcileOwnership();

      expect(resourceScheduler.runningCount()).toBe(1);
      await expect(
        resourceScheduler.runStart('new-instance', async () => undefined),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_REACHED' });
      expect(actor.getOwned('persisted-capacity-session', instance.instanceId)).toMatchObject({
        lifecycleState: deviceState === 'Booted' ? 'ready' : 'booting',
      });
    },
  );

  it('keeps restored capacity reserved when persisted task lookup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    actor.attach({
      sessionId: 'unreadable-persisted-session',
      worktreeRoot: '/tmp/unreadable-persisted-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const resourceScheduler = new IOSSimulatorResourceScheduler({
      softLimit: 1,
      hardLimit: 1,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });

    await host.reconcileOwnership();

    expect(resourceScheduler.runningCount()).toBe(1);
    await expect(
      resourceScheduler.runStart('new-instance', async () => undefined),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_REACHED' });
  });

  it('cleans up missing-session ownership using the injected lifecycle only', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'deleted-session',
      worktreeRoot: '/tmp/deleted-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(actor.listAll()).toEqual([]);
  });

  it('shuts down a Cindy-created device before deleting it even if the user booted it', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'deleted-session',
      worktreeRoot: '/tmp/deleted-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'user-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(actor.listAll()).toEqual([]);
  });

  it('marks a persisted remote session binding degraded without touching its device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'remote-session',
      worktreeRoot: '/tmp/remote-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({ ...localSession('remote-session'), remoteHostId: 'mac-b' })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('remote-session', instance.instanceId)).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'degraded',
      errorCode: 'UNSUPPORTED_SESSION_KIND',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('fails closed when the MCP call has no session context', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(),
    });

    await expect(host.callTool('check_environment', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'SESSION_CONTEXT_REQUIRED',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects archived sessions before touching local Apple tooling', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async () => ({
        ...localSession('archived-session'),
        status: 'archived' as const,
      })),
    });

    await expect(host.getStatus('archived-session')).resolves.toMatchObject({
      ok: false,
      errorCode: 'SESSION_NOT_FOUND',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('releases archived external ownership without mutating a user device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-session',
      worktreeRoot: '/tmp/archived-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const discardInstance = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      mediaCapture: { discardInstance } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-session'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.listAll()).toEqual([]);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('keeps archived ownership when recording cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-recording-failure',
      worktreeRoot: '/tmp/archived-recording-failure',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'preexisting',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      mediaCapture: {
        discardInstance: vi.fn(async () => {
          throw new Error('recording process is still alive');
        }),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-recording-failure'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('archived-recording-failure', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it('cleans archived Cindy-created ownership using creation provenance', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-cindy',
      worktreeRoot: '/tmp/archived-cindy',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'user-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-cindy'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(actor.listAll()).toEqual([]);
  });

  it('rechecks archived status under the task route lock before destructive recovery', async () => {
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let status: 'active' | 'archived' = 'archived';
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'archived-then-restored',
      worktreeRoot: '/tmp/archived-then-restored',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const observeSessionLock = vi.fn();
    const withSessionLock = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
      observeSessionLock(sessionId, task);
      await lockGate;
      return task();
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      withSessionLock,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-then-restored'),
        status,
      })),
    });

    const reconcile = host.reconcileOwnership();
    await vi.waitFor(() => expect(observeSessionLock).toHaveBeenCalledOnce());
    status = 'active';
    releaseLock();
    await reconcile;

    expect(observeSessionLock).toHaveBeenCalledWith('archived-then-restored', expect.any(Function));
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    expect(actor.getOwned('archived-then-restored', instance.instanceId)).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'healthy',
    });
  });

  it('stops the driver runtime before shutting down and deleting a stale device', async () => {
    const order: string[] = [];
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => {
        order.push('shutdown');
      }),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => {
        order.push('delete');
      }),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'deleted-cindy',
      worktreeRoot: '/tmp/deleted-cindy',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const stopDriver = vi.fn(async () => {
      order.push('driver');
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('deleted-cindy'),
        status: 'deleted' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(order).toEqual(['driver', 'shutdown', 'delete']);
    expect(actor.listAll()).toEqual([]);
  });

  it('preserves stale ownership and the device when driver cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'archived-driver-failure',
      worktreeRoot: '/tmp/archived-driver-failure',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => {
          throw new Error('driver process group did not stop');
        }),
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-driver-failure'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('archived-driver-failure', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('aborts driver work before orphan recovery and still scans after stop fails', async () => {
    const order: string[] = [];
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => READY_REPORT.devices[0]),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'removed-during-driver-start',
      worktreeRoot: '/tmp/removed-during-driver-start',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => {
          order.push('stop');
          throw new Error('pending start cancellation failed');
        }),
        cleanupOrphaned: vi.fn(async () => {
          order.push('cleanup');
        }),
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });

    await expect(host.cleanupRemovedSession(instance.sessionId)).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
    });
    expect(order).toEqual(['stop', 'cleanup']);
    expect(actor.listAll()).toHaveLength(1);
  });

  it('stops the driver runtime when ownership reconcile observes a shut down device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'device-loss-session',
      worktreeRoot: '/tmp/device-loss-session',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const stopDriver = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' }],
        })),
      },
      getSession: vi.fn(async () => localSession('device-loss-session')),
    });

    await host.reconcileOwnership();

    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(actor.getOwned('device-loss-session', instance.instanceId)).toMatchObject({
      lifecycleState: 'stopped',
      healthState: 'healthy',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('shuts down but does not delete an archived external device booted by the Agent', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-agent-booted',
      worktreeRoot: '/tmp/archived-agent-booted',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-agent-booted'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    expect(actor.listAll()).toEqual([]);
  });

  it('aborts archived CoreSimulator cleanup before updater force-quit', async () => {
    let shutdownSignal: AbortSignal | undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(
        (_udid: string, signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            shutdownSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'archived-force-quit',
      worktreeRoot: '/tmp/archived-force-quit',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession(instance.sessionId),
        status: 'archived' as const,
      })),
    });

    const reconciling = host.reconcileOwnership();
    await vi.waitFor(() => expect(shutdownSignal).toBeDefined());
    host.abortOperationsForExit();

    expect(shutdownSignal?.aborted).toBe(true);
    await expect(reconciling).resolves.toBeUndefined();
    expect(actor.getOwned(instance.sessionId, instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    await host.dispose();
  });

  it.each(['abortOperationsForExit', 'dispose'] as const)(
    'aborts an active runtime inspection during %s',
    async (shutdownMode) => {
      let inspectSignal: AbortSignal | undefined;
      const inspect = vi.fn(
        (signal?: AbortSignal) =>
          new Promise<IOSSimulatorEnvironmentReport>((_resolve, reject) => {
            inspectSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const host = createIOSSimulatorHost({
        runtime: { inspect },
        getSession: vi.fn(async (id) => localSession(id)),
      });

      const inspection = host.getPluginStatus('runtime-inspection-exit');
      await vi.waitFor(() => expect(inspectSignal).toBeDefined());
      let disposePromise: Promise<void>;
      if (shutdownMode === 'abortOperationsForExit') {
        host.abortOperationsForExit();
        expect(inspectSignal?.aborted).toBe(true);
        disposePromise = host.dispose();
      } else {
        disposePromise = host.dispose();
        expect(inspectSignal?.aborted).toBe(true);
      }
      await expect(inspection).resolves.toMatchObject({
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      });
      await disposePromise;
    },
  );

  it.each(['Booted', 'Booting'] as const)(
    'keeps archived ownership and scheduler capacity when %s shutdown fails',
    async (deviceState) => {
      const sessionId = `archived-cleanup-failure-${deviceState.toLowerCase()}`;
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(async () => {
          throw new Error('simctl shutdown failed');
        }),
        createExact: vi.fn(),
        deleteExact: vi.fn(async () => undefined),
      };
      const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
      const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
      const instance = actor.attach({
        sessionId,
        worktreeRoot: '/tmp/archived-cleanup-failure',
        sourceFingerprint: 'fingerprint-a',
        creationProvenance: 'cindy',
        bootProvenance: 'agent-booted',
        device: { ...READY_REPORT.devices[0]!, state: deviceState },
      });
      const resourceScheduler = testResourceScheduler();
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        resourceScheduler,
        runtime: {
          inspect: vi.fn(async () => ({
            ...READY_REPORT,
            devices: [{ ...READY_REPORT.devices[0]!, state: deviceState }],
          })),
        },
        getSession: vi.fn(async () => ({
          ...localSession(sessionId),
          status: 'archived' as const,
        })),
      });

      await host.reconcileOwnership();

      expect(actor.getOwned(sessionId, instance.instanceId)).toMatchObject({
        healthState: 'degraded',
        errorCode: 'ARCHIVED_CLEANUP_FAILED',
      });
      expect(resourceScheduler.runningCount()).toBe(1);
      expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    },
  );

  it('releases scheduler capacity only after Simulator shutdown succeeds', async () => {
    const shutdownExact = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new IOSSimulatorInstanceError('SIMULATOR_SHUTDOWN_FAILED', 'simctl shutdown failed', true),
      )
      .mockResolvedValue(undefined);
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact,
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'shutdown-retry-session',
      worktreeRoot: '/tmp/shutdown-retry-session',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const resourceScheduler = testResourceScheduler();
    await resourceScheduler.runStart(instance.instanceId, async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('shutdown-retry-session')),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('shutdown-retry-session', instance.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    await expect(
      host.callTool('stop_instance', route, {
        sessionId: 'shutdown-retry-session',
        origin: 'user',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_SHUTDOWN_FAILED' });
    expect(resourceScheduler.runningCount()).toBe(1);
    expect(actor.getOwned('shutdown-retry-session', instance.instanceId)).toMatchObject({
      lifecycleState: 'error',
      errorCode: 'SIMULATOR_SHUTDOWN_FAILED',
    });

    await expect(
      host.callTool('stop_instance', route, {
        sessionId: 'shutdown-retry-session',
        origin: 'user',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(resourceScheduler.runningCount()).toBe(0);
    expect(shutdownExact).toHaveBeenCalledTimes(2);
    await host.dispose();
  });

  it.each([
    {
      label: 'external preexisting',
      creationProvenance: 'external' as const,
      bootProvenance: 'preexisting' as const,
      expectShutdown: false,
      expectDelete: false,
    },
    {
      label: 'external Agent-booted',
      creationProvenance: 'external' as const,
      bootProvenance: 'agent-booted' as const,
      expectShutdown: true,
      expectDelete: false,
    },
    {
      label: 'Cindy-created',
      creationProvenance: 'cindy' as const,
      bootProvenance: 'user-booted' as const,
      expectShutdown: true,
      expectDelete: true,
    },
  ])(
    'cleans a removed $label binding after startup ownership reconcile has latched',
    async ({ creationProvenance, bootProvenance, expectShutdown, expectDelete }) => {
      const device = { ...READY_REPORT.devices[0]!, state: 'Booted' as const };
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(async () => device),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(async () => undefined),
      };
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
        lifecycle,
      });
      const instance = actor.attach({
        sessionId: 'removed-session',
        worktreeRoot: '/tmp/removed-session',
        sourceFingerprint: 'fingerprint-a',
        creationProvenance,
        bootProvenance,
        device,
      });
      const resourceScheduler = testResourceScheduler();
      await resourceScheduler.runStart(instance.instanceId, async (commitRunning) => {
        commitRunning();
      });
      const stopDriver = vi.fn(async () => undefined);
      const discardSession = vi.fn(async () => undefined);
      const discardInstance = vi.fn(async () => undefined);
      const framePump = { clear: vi.fn(), snapshot: vi.fn(() => null) };
      const h264FramePump = { clear: vi.fn() };
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        resourceScheduler,
        driverManager: {
          get: vi.fn(() => null),
          start: vi.fn(),
          stop: stopDriver,
        },
        framePump: framePump as never,
        h264FramePump: h264FramePump as never,
        mediaCapture: {
          discardSession,
          discardInstance,
        } as unknown as IOSSimulatorMediaCaptureAdapter,
        runtime: { inspect: vi.fn(async () => READY_REPORT) },
        getSession: vi.fn(async (id) => localSession(id)),
      });

      await host.reconcileOwnership();
      await expect(host.cleanupRemovedSession('removed-session')).resolves.toBeUndefined();
      await expect(host.cleanupRemovedSession('removed-session')).resolves.toBeUndefined();

      expect(actor.list('removed-session')).toEqual([]);
      expect(resourceScheduler.runningCount()).toBe(0);
      expect(stopDriver).toHaveBeenCalledOnce();
      expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
      expect(discardInstance).toHaveBeenCalledOnce();
      expect(framePump.clear).toHaveBeenCalledWith(instance.instanceId);
      expect(h264FramePump.clear).toHaveBeenCalledWith(instance.instanceId);
      expect(lifecycle.findExact).toHaveBeenCalledTimes(expectShutdown ? 1 : 0);
      expect(lifecycle.shutdownExact).toHaveBeenCalledTimes(expectShutdown ? 1 : 0);
      expect(lifecycle.deleteExact).toHaveBeenCalledTimes(expectDelete ? 1 : 0);
    },
  );

  it('treats an already missing Cindy-created device as successfully removed', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => null),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'removed-session',
      worktreeRoot: '/tmp/removed-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: READY_REPORT.devices[0]!,
    });
    const resourceScheduler = testResourceScheduler();
    await resourceScheduler.runStart(instance.instanceId, async (commitRunning) => {
      commitRunning();
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await host.reconcileOwnership();
    await expect(host.cleanupRemovedSession('removed-session')).resolves.toBeUndefined();
    await expect(host.cleanupRemovedSession('removed-session')).resolves.toBeUndefined();

    expect(actor.list('removed-session')).toEqual([]);
    expect(resourceScheduler.runningCount()).toBe(0);
    expect(lifecycle.findExact).toHaveBeenCalledOnce();
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('cleans only the removed task ownership and scheduler capacity', async () => {
    const otherDevice = {
      ...READY_REPORT.devices[0]!,
      udid: '2A9D41E0-E031-4AD0-A8B5-847480802E8E',
      name: 'iPhone 17 Pro B',
    };
    const environment = { ...READY_REPORT, devices: [READY_REPORT.devices[0]!, otherDevice] };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const removed = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'preexisting',
      device: READY_REPORT.devices[0]!,
    });
    const retained = actor.attach({
      sessionId: 'session-b',
      worktreeRoot: '/tmp/session-b',
      sourceFingerprint: 'fingerprint-b',
      creationProvenance: 'external',
      bootProvenance: 'preexisting',
      device: otherDevice,
    });
    const resourceScheduler = testResourceScheduler();
    for (const instance of [removed, retained]) {
      await resourceScheduler.runStart(instance.instanceId, async (commitRunning) => {
        commitRunning();
      });
    }
    const stopDriver = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => environment) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await host.reconcileOwnership();
    await host.cleanupRemovedSession('session-a');

    expect(actor.list('session-a')).toEqual([]);
    expect(actor.list('session-b')).toHaveLength(1);
    expect(actor.list('session-b')[0]?.instanceId).toBe(retained.instanceId);
    expect(resourceScheduler.runningCount()).toBe(1);
    expect(stopDriver).toHaveBeenCalledOnce();
    expect(stopDriver).toHaveBeenCalledWith(removed.instanceId);
  });

  it('aborts CoreSimulator startup before waiting on task-removal barriers', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' };
    let bootSignal: AbortSignal | undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => shutdownDevice),
      bootExact: vi.fn(
        (_udid, signal) =>
          new Promise<typeof shutdownDevice>((_resolve, reject) => {
            bootSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'removed-during-start',
      worktreeRoot: '/tmp/removed-during-start',
      sourceFingerprint: 'fingerprint-a',
      device: shutdownDevice,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler: testResourceScheduler(),
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: {
        inspect: vi.fn(async () => ({ ...READY_REPORT, devices: [shutdownDevice] })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    await host.reconcileOwnership();
    let releasePostCancellationProbe: (device: typeof shutdownDevice) => void = () => undefined;
    const postCancellationProbe = new Promise<typeof shutdownDevice>((resolve) => {
      releasePostCancellationProbe = resolve;
    });
    vi.mocked(lifecycle.findExact).mockImplementation(async () => postCancellationProbe);
    const current = actor.getOwned(attached.sessionId, attached.instanceId);
    const starting = host.callTool(
      'start_instance',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: current.sessionId, origin: 'user' },
    );
    await vi.waitFor(() => expect(bootSignal).toBeDefined());

    const cleanup = host.cleanupRemovedSession(current.sessionId);
    await vi.waitFor(() => expect(bootSignal?.aborted).toBe(true));

    await expect(starting).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    releasePostCancellationProbe(shutdownDevice);
    await expect(cleanup).resolves.toBeUndefined();
    expect(actor.list(current.sessionId)).toEqual([]);
    await host.dispose();
  });

  it('retains degraded ownership and scheduler capacity when removed-task cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => READY_REPORT.devices[0]!),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'removed-session',
      worktreeRoot: '/tmp/removed-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'agent-booted',
      device: READY_REPORT.devices[0]!,
    });
    const resourceScheduler = testResourceScheduler();
    await resourceScheduler.runStart(instance.instanceId, async (commitRunning) => {
      commitRunning();
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => {
          throw new Error('driver process group did not stop');
        }),
      },
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await host.reconcileOwnership();
    await expect(host.cleanupRemovedSession('removed-session')).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
    });

    expect(actor.getOwned('removed-session', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(resourceScheduler.runningCount()).toBe(1);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('aborts and drains pending-marker reconciliation before host disposal completes', async () => {
    let reconcileSignal: AbortSignal | undefined;
    let finishReconciliation: (value: readonly string[]) => void = () => undefined;
    const reconcilePendingCreates = vi.fn(
      (_owned: readonly { udid: string; name: string }[], signal?: AbortSignal) =>
        new Promise<readonly string[]>((resolve) => {
          reconcileSignal = signal;
          finishReconciliation = resolve;
        }),
    );
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      reconcilePendingCreates,
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'abc',
      device: READY_REPORT.devices[0]!,
    });
    const inspect = vi.fn(async () => READY_REPORT);
    const host = createIOSSimulatorHost({ actor, lifecycle, runtime: { inspect } });

    const reconciling = host.reconcileOwnership();
    await vi.waitFor(() => expect(reconcileSignal).toBeDefined());
    let disposed = false;
    const disposing = host.dispose().then(() => {
      disposed = true;
    });

    expect(reconcileSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(reconcilePendingCreates).toHaveBeenCalledWith(
      [{ udid: instance.simulatorUdid, name: instance.simulatorName }],
      reconcileSignal,
    );

    finishReconciliation([]);
    await Promise.all([reconciling, disposing]);
    expect(disposed).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('disposes WDA and recording resources on host shutdown without changing ownership', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const cancelLifecycleStarts = vi.spyOn(actor, 'cancelAllLifecycleStarts');
    const instance = actor.attach({
      sessionId: 'dispose-session',
      worktreeRoot: '/tmp/dispose-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const stopDriver = vi.fn(async () => undefined);
    const discardInstance = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      mediaCapture: { discardInstance } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('dispose-session')),
    });

    let mutationSignal: AbortSignal | undefined;
    const activeMutation = actor
      .runMutation(
        {
          sessionId: instance.sessionId,
          instanceId: instance.instanceId,
          generation: instance.generation,
          leaseId: instance.lease.id,
        },
        async (_current, signal) => {
          mutationSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        'user',
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mutationSignal).toBeDefined());

    await host.dispose();
    await host.dispose();

    expect(mutationSignal?.aborted).toBe(true);
    await expect(activeMutation).resolves.toMatchObject({ code: 'MUTATION_CANCELLED' });
    expect(discardInstance).toHaveBeenCalledTimes(1);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);
    expect(stopDriver).toHaveBeenCalledTimes(1);
    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(cancelLifecycleStarts).toHaveBeenCalledTimes(1);
    expect(actor.listAll()).toHaveLength(1);
  });

  it('fails closed for status and tool calls after host disposal begins', async () => {
    const inspect = vi.fn(async () => READY_REPORT);
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await host.dispose();

    await expect(host.getStatus('disposed-session')).resolves.toMatchObject({
      ok: false,
      sessionId: 'disposed-session',
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'disposed-session', origin: 'user' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not keep a WDA start alive when disposal races an in-flight tool call', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'dispose-race-session',
      worktreeRoot: '/tmp/dispose-race-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let releaseStart!: (value: WdaRunningInstance) => void;
    const startDriver = vi.fn(
      () =>
        new Promise<WdaRunningInstance>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const stopDriver = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      driverManager: {
        get: vi.fn(() => null),
        start: startDriver,
        stop: stopDriver,
      },
      resourceScheduler: testResourceScheduler(),
      getSession: vi.fn(async () => localSession('dispose-race-session')),
    });
    await expect(host.getStatus('dispose-race-session')).resolves.toMatchObject({ ok: true });
    const current = actor.getOwned('dispose-race-session', instance.instanceId);
    const callPromise = host.callTool(
      'start_instance',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: 'dispose-race-session', origin: 'user' },
    );
    await vi.waitFor(() => expect(startDriver).toHaveBeenCalledTimes(1));

    await host.dispose();
    releaseStart({
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 123,
      controlPort: 8100,
      mjpegPort: 9100,
      sourceRevision: 'revision',
      buildCacheKey: 'cache',
      driver: {} as WdaRunningInstance['driver'],
      driverSessionId: 'session',
      health: {
        ready: true,
        message: null,
        osName: 'iOS',
        osVersion: '26.4',
        sdkVersion: '26.4',
        deviceIp: null,
      },
      startedAt: new Date().toISOString(),
    });

    await expect(callPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    expect(stopDriver).toHaveBeenCalled();
  });

  it('does not retain build results that finish after host disposal', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'dispose-build-session',
      worktreeRoot: '/tmp/dispose-build-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const projectRoot = path.join(
      app.getPath('userData'),
      'ios-simulator',
      'projects',
      `dispose-build-${crypto.randomUUID()}`,
    );
    const resultBundlePath = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    await mkdir(resultBundlePath, { recursive: true });
    let buildSignal: AbortSignal | undefined;
    const build = vi.fn(
      (input: Parameters<IOSSimulatorProjectBuilderAdapter['build']>[0]) =>
        new Promise<Awaited<ReturnType<IOSSimulatorProjectBuilderAdapter['build']>>>(
          (_, reject) => {
            buildSignal = input.signal;
            input.signal?.addEventListener('abort', () => {
              reject(
                new IOSSimulatorProjectBuildError(
                  'APP_BUILD_FAILED',
                  'cancelled',
                  '',
                  resultBundlePath,
                  false,
                  true,
                ),
              );
            });
          },
        ),
    );
    const disposeMedia = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      projectBuilder: { build },
      mediaCapture: {
        dispose: disposeMedia,
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('dispose-build-session')),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('dispose-build-session', instance.instanceId);
    const callPromise = host.callTool(
      'build_app',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: 'dispose-build-session', origin: 'user' },
    );
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));

    const disposePromise = host.dispose();
    expect(disposeMedia).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(buildSignal?.aborted).toBe(true));
    await disposePromise;

    try {
      await expect(callPromise).resolves.toMatchObject({
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator host is shutting down.',
      });
      await expect(stat(resultBundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('aborts and drains active xcresult readers before host disposal completes', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'force-quit-xcresult-session',
      worktreeRoot: '/tmp/force-quit-xcresult-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const resultBundlePath = `/tmp/CindyBuild-${crypto.randomUUID()}.xcresult`;
    const build = vi.fn<IOSSimulatorProjectBuilderAdapter['build']>(async (input) => ({
      kind: 'xcode-project',
      worktreeRoot: input.worktreeRoot,
      projectRoot: input.worktreeRoot,
      containerPath: `${input.worktreeRoot}/Demo.xcodeproj`,
      scheme: 'Demo',
      appPath: `${input.worktreeRoot}/Demo.app`,
      resultBundlePath,
      buildLogTail: 'build succeeded',
    }));
    let readSignal: AbortSignal | undefined;
    let releaseRead!: () => void;
    let projectBuilder!: IOSSimulatorProjectBuilderAdapter;
    const readXcresult = vi.fn(function (
      this: IOSSimulatorProjectBuilderAdapter,
      _path: string,
      _maxBufferBytes?: number,
      signal?: AbortSignal,
    ) {
      expect(this).toBe(projectBuilder);
      return new Promise<string>((resolve) => {
        readSignal = signal;
        releaseRead = () => {
          resolve('late xcresult content that must not be cached');
        };
      });
    });
    projectBuilder = { build, readXcresult };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      projectBuilder,
      appLifecycle: {
        inspectArtifact: vi.fn(async () => ({
          artifactId: 'artifact-xcresult',
          worktreeRoot: '/tmp/force-quit-xcresult-session',
          authorizedRoot: '/tmp/force-quit-xcresult-session',
          appPath: '/tmp/force-quit-xcresult-session/Demo.app',
          bundleId: 'com.example.demo',
          createdAt: '2026-08-08T00:00:00.000Z',
        })),
        installExact: vi.fn(async () => undefined),
        launchExact: vi.fn(async () => undefined),
        terminateExact: vi.fn(async () => undefined),
        openUrlExact: vi.fn(async () => undefined),
      },
      mediaCapture: {
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('force-quit-xcresult-session')),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('force-quit-xcresult-session', instance.instanceId);
    const built = await host.callTool(
      'build_app',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: current.sessionId, origin: 'user' },
    );
    expect(built).toMatchObject({ ok: true });
    const diagnosticsId = (built as { ok: true; data: { diagnostics: { diagnosticsId: string } } })
      .data.diagnostics.diagnosticsId;
    const readPromise = host.callTool(
      'read_build_diagnostics',
      { diagnosticsId, source: 'xcresult' },
      { sessionId: current.sessionId, origin: 'agent' },
    );
    await vi.waitFor(() => expect(readXcresult).toHaveBeenCalledOnce());

    expect(() => host.abortOperationsForExit()).not.toThrow();
    expect(readSignal?.aborted).toBe(true);
    let disposeSettled = false;
    const disposePromise = host.dispose().then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    releaseRead();

    await disposePromise;
    await expect(readPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    expect(readXcresult).toHaveBeenCalledWith(resultBundlePath, undefined, readSignal);
  });

  it('synchronously aborts active builds before updater force-quit', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const abortLifecycleStarts = vi.spyOn(actor, 'abortOperationsForExit');
    const instance = actor.attach({
      sessionId: 'force-quit-build-session',
      worktreeRoot: '/tmp/force-quit-build-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let buildSignal: AbortSignal | undefined;
    const build = vi.fn(
      (input: Parameters<IOSSimulatorProjectBuilderAdapter['build']>[0]) =>
        new Promise<Awaited<ReturnType<IOSSimulatorProjectBuilderAdapter['build']>>>(
          (_, reject) => {
            buildSignal = input.signal;
            input.signal?.addEventListener('abort', () => {
              reject(
                new IOSSimulatorProjectBuildError(
                  'APP_BUILD_FAILED',
                  'cancelled',
                  '',
                  null,
                  false,
                  true,
                ),
              );
            });
          },
        ),
    );
    const abortRecording = vi.fn(() => {
      throw new Error('recording already exited');
    });
    const abortDriver = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        abortOperationsForExit: abortDriver,
      },
      projectBuilder: { build },
      mediaCapture: {
        abortOperationsForExit: abortRecording,
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('force-quit-build-session')),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('force-quit-build-session', instance.instanceId);
    const callPromise = host.callTool(
      'build_app',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: 'force-quit-build-session', origin: 'user' },
    );
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());

    let mutationSignal: AbortSignal | undefined;
    const activeMutation = actor
      .runMutation(
        {
          sessionId: current.sessionId,
          instanceId: current.instanceId,
          generation: current.generation,
          leaseId: current.lease.id,
        },
        async (_instance, signal) => {
          mutationSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        'user',
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mutationSignal).toBeDefined());

    expect(() => host.abortOperationsForExit()).not.toThrow();

    expect(buildSignal?.aborted).toBe(true);
    expect(mutationSignal?.aborted).toBe(true);
    expect(abortLifecycleStarts).toHaveBeenCalledOnce();
    expect(abortRecording).toHaveBeenCalledOnce();
    expect(abortDriver).toHaveBeenCalledOnce();
    await expect(callPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(activeMutation).resolves.toMatchObject({ code: 'MUTATION_CANCELLED' });
    await host.dispose();
  });

  it('rejects SSH sessions before touching local Apple tooling', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async (id) => ({ ...localSession(id), remoteHostId: 'build-mac' })),
    });

    await expect(host.getStatus('remote-session')).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_SESSION_KIND',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('enforces the project plugin gate for MCP but not the shared host', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const deps = getIOSSimulatorMcpDeps({
      host,
      isIOSSimulatorEnabled: () => false,
    });

    await expect(
      deps.callTool('check_environment', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_DISABLED',
    });
    await expect(host.getStatus('session-a')).resolves.toMatchObject({ ok: true });
  });

  it('evaluates the MCP plugin gate against the current project workdir', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const isIOSSimulatorEnabled = vi.fn(
      (context?: { workingDir?: string }) => context?.workingDir === '/projects/enabled-ios',
    );
    const deps = getIOSSimulatorMcpDeps({ host, isIOSSimulatorEnabled });

    await expect(
      deps.callTool(
        'check_environment',
        {},
        {
          sessionId: 'session-a',
          workingDir: '/projects/enabled-ios',
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      deps.callTool(
        'check_environment',
        {},
        {
          sessionId: 'session-a',
          workingDir: '/projects/disabled-ios',
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_DISABLED',
    });
    expect(isIOSSimulatorEnabled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workingDir: '/projects/enabled-ios' }),
    );
    expect(isIOSSimulatorEnabled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workingDir: '/projects/disabled-ios' }),
    );
  });

  it('does not expose WDA endpoints or raw driver errors to callers', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => READY_REPORT.devices[0]!),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(async () => {
          throw new WdaError(
            'HTTP_ERROR',
            'GET http://127.0.0.1:43127/status returned an internal Xcode path',
            500,
          );
        }),
        stop: vi.fn(async () => undefined),
      },
      resourceScheduler: testResourceScheduler(),
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    const result = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'WDA_UNAVAILABLE',
      message: 'The simulator automation driver is unavailable.',
    });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('43127');
    expect(JSON.stringify(result)).not.toContain('Xcode path');
  });

  it('recycles an idle WDA process without shutting down the simulator', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const started = await actor.start({
      sessionId: 'session-a',
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    });
    const running = {
      instanceId: started.instanceId,
      simulatorUdid: started.simulatorUdid,
      pid: 42,
      driver: { streamFrames: vi.fn(async () => ({ endReason: 'aborted' as const })) },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      idleRecycleMs: 1,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const route = {
      instanceId: started.instanceId,
      generation: started.generation,
      leaseId: started.lease.id,
    };
    await expect(host.setViewerVisibility('session-a', route, false)).resolves.toMatchObject({
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(driverManager.stop).toHaveBeenCalledWith(started.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it('does not let a late viewer open resurrect a stream after the matching close', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: {
        getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
        getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    let liveRunning: WdaRunningInstance | null = null;
    const probe = vi.fn(async () => liveRunning);
    let resolveMemoryProbe: (value: {
      source: 'node-os';
      freePercentage: null;
      freeBytes: number;
      totalBytes: number;
    }) => void = () => undefined;
    const memoryProbe = vi.fn(
      () =>
        new Promise<{
          source: 'node-os';
          freePercentage: null;
          freeBytes: number;
          totalBytes: number;
        }>((resolve) => {
          resolveMemoryProbe = resolve;
        }),
    );
    const resourceScheduler = new IOSSimulatorResourceScheduler({ memoryProbe });
    const driverManager = {
      get: vi.fn(() => liveRunning),
      probe,
      start: vi.fn(async () => running),
      stop: vi.fn(async () => undefined),
    };
    const framePump = {
      setVisible: vi.fn(({ visible }: { visible: boolean }) => ({
        instanceId: instance.instanceId,
        generation: instance.generation,
        state: visible ? ('connecting' as const) : ('idle' as const),
        reconnectAttempt: 0,
        latestFrame: null,
      })),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      driverManager,
      framePump: framePump as never,
      idleRecycleMs: 20,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    const lateOpen = host.setViewerVisibility(
      'session-a',
      route,
      true,
      'jpeg',
      undefined,
      17,
      'viewer-a',
    );
    await vi.waitFor(() => expect(memoryProbe).toHaveBeenCalledOnce());
    await expect(
      host.setViewerVisibility('session-a', route, false, 'jpeg', undefined, 17, 'viewer-a'),
    ).resolves.toMatchObject({ ok: true });
    expect(actor.getOwned('session-a', instance.instanceId).healthState).toBe('healthy');
    resolveMemoryProbe({
      source: 'node-os',
      freePercentage: null,
      freeBytes: 100 * 1024 ** 3,
      totalBytes: 128 * 1024 ** 3,
    });

    await expect(lateOpen).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(framePump.setVisible).not.toHaveBeenCalledWith(
      expect.objectContaining({ visible: true }),
    );

    liveRunning = running;
    let resolveStaleProbe: (value: WdaRunningInstance | null) => void = () => undefined;
    probe.mockImplementationOnce(
      () =>
        new Promise<WdaRunningInstance | null>((resolve) => {
          resolveStaleProbe = resolve;
        }),
    );
    const staleOpen = host.setViewerVisibility(
      'session-a',
      route,
      true,
      'jpeg',
      undefined,
      17,
      'viewer-stale',
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await expect(
      host.setViewerVisibility('session-a', route, true, 'jpeg', undefined, 17, 'viewer-current'),
    ).resolves.toMatchObject({ ok: true });
    const hiddenCallsBeforeStaleClose = framePump.setVisible.mock.calls.filter(
      ([request]) => request.visible === false,
    ).length;
    await expect(
      host.setViewerVisibility('session-a', route, false, 'jpeg', undefined, 17, 'viewer-stale'),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });
    expect(
      framePump.setVisible.mock.calls.filter(([request]) => request.visible === false),
    ).toHaveLength(hiddenCallsBeforeStaleClose);
    resolveStaleProbe(running);
    await expect(staleOpen).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });

    await expect(
      host.setViewerVisibility('session-a', route, false, 'jpeg', undefined, 17, 'viewer-current'),
    ).resolves.toMatchObject({ ok: true });
    let resolveRevokedProbe: (value: WdaRunningInstance | null) => void = () => undefined;
    probe.mockImplementationOnce(
      () =>
        new Promise<WdaRunningInstance | null>((resolve) => {
          resolveRevokedProbe = resolve;
        }),
    );
    const revokedOpen = host.setViewerVisibility(
      'session-a',
      route,
      true,
      'jpeg',
      undefined,
      17,
      'viewer-revoked',
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
    // The pending open has already cancelled the timer from the explicit
    // close, so only revocation cleanup can produce the next stop call.
    driverManager.stop.mockClear();
    expect(host.revokeRendererViewer('session-a', 17)).toBe(1);
    resolveRevokedProbe(running);
    await expect(revokedOpen).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });
    await vi.waitFor(() => expect(driverManager.stop).toHaveBeenCalledWith(instance.instanceId));

    const invalidOpen = host.setViewerVisibility(
      'session-a',
      { ...route, instanceId: 'renderer-supplied-unknown-instance' },
      true,
      'jpeg',
      undefined,
      18,
      'viewer-invalid',
    );
    expect(host.revokeRendererViewer('session-a', 18)).toBe(0);
    await expect(invalidOpen).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_FOUND',
    });
    await host.dispose();
  });

  it('returns a fresh viewer route when driver recovery outlives the lease', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 100,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: {
        getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
        getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(async () => {
        now = 1_101;
        return running;
      }),
      stop: vi.fn(async () => undefined),
    };
    const framePump = {
      setVisible: vi.fn(() => ({
        instanceId: instance.instanceId,
        generation: instance.generation,
        state: 'connecting' as const,
        reconnectAttempt: 0,
        latestFrame: null,
      })),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
    });
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    const result = await host.setViewerVisibility('session-a', route, true, 'jpeg');

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: instance.instanceId,
          generation: instance.generation,
          lease: {
            id: expect.any(String),
            expiresAt: new Date(1_201).toISOString(),
          },
        },
        stream: { state: 'connecting' },
      },
    });
    expect(
      (
        result as {
          ok: true;
          data: { instance: { lease: { id: string } } };
        }
      ).data.instance.lease.id,
    ).not.toBe(route.leaseId);
    await host.dispose();
  });

  it('stops exact expired viewer media without letting a stale lease stop its replacement', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 100,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const nativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const wdaDriver = {
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
    };
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: wdaDriver,
      driverRouter: {
        stream: vi.fn(() => ({
          adapter: 'native-sidecar',
          fallback: false,
          reason: null,
          source: nativeDriver,
        })),
        capabilityReport: vi.fn(() => ({
          nativeSidecar: { available: true },
        })),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const snapshot = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      state: 'streaming' as const,
      reconnectAttempt: 0,
      latestFrame: null,
    };
    const framePump = {
      setVisible: vi.fn(() => snapshot),
      snapshot: vi.fn(() => snapshot),
      clear: vi.fn(),
    };
    const h264FramePump = {
      setVisible: vi.fn(() => snapshot),
      snapshot: vi.fn(() => snapshot),
      clear: vi.fn(),
    };
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      h264FramePump: h264FramePump as never,
      idleRecycleMs: Number.POSITIVE_INFINITY,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const initialRoute = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    await expect(
      host.setViewerVisibility('session-a', initialRoute, true, 'h264', undefined, 17),
    ).resolves.toMatchObject({ ok: true });
    h264FramePump.clear.mockClear();
    now += 101;
    await expect(host.getLatestFrame('session-a', initialRoute, 17)).resolves.toMatchObject({
      ok: false,
      errorCode: 'LEASE_EXPIRED',
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(instance.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(driverManager.stop).not.toHaveBeenCalled();

    const closeLease = actor.heartbeatOwned('session-a', instance.instanceId);
    const closeRoute = {
      instanceId: closeLease.instanceId,
      generation: closeLease.generation,
      leaseId: closeLease.lease.id,
    };
    await host.setViewerVisibility('session-a', closeRoute, true, 'h264');
    h264FramePump.clear.mockClear();
    now += 101;
    await expect(host.setViewerVisibility('session-a', closeRoute, false)).resolves.toMatchObject({
      ok: true,
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(instance.instanceId);

    const obsoleteLease = actor.heartbeatOwned('session-a', instance.instanceId);
    const obsoleteRoute = {
      instanceId: obsoleteLease.instanceId,
      generation: obsoleteLease.generation,
      leaseId: obsoleteLease.lease.id,
    };
    await host.setViewerVisibility('session-a', obsoleteRoute, true, 'h264');
    h264FramePump.clear.mockClear();
    now += 101;
    actor.heartbeatOwned('session-a', instance.instanceId);
    await expect(
      host.setViewerVisibility('session-a', obsoleteRoute, false),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'LEASE_EXPIRED',
    });
    expect(h264FramePump.clear).not.toHaveBeenCalled();
    await host.dispose();
  });

  it('pushes H.264 frames only to the exact current viewer and rejects stale generations', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => READY_REPORT.devices[0]!),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    let frameSink: ((frame: IOSSimulatorH264Frame) => void | Promise<void>) | null = null;
    const emitFrame = async (frame: IOSSimulatorH264Frame): Promise<void> => {
      const sink = frameSink as ((nextFrame: IOSSimulatorH264Frame) => void | Promise<void>) | null;
      if (!sink) throw new Error('native frame sink was not registered');
      await sink(frame);
    };
    const streamNativeFrames = vi.fn<IOSSimulatorNativeSidecarDriver['streamNativeFrames']>(
      async (options) => {
        frameSink = options.onFrame;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          frameCount: 1,
          byteCount: 4,
          startedAt: '2026-08-07T00:00:00.000Z',
          firstFrameAt: '2026-08-07T00:00:00.001Z',
          endedAt: '2026-08-07T00:00:00.002Z',
          endReason: 'aborted',
        } satisfies IOSSimulatorStreamStats;
      },
    );
    const beginTouch = vi.fn(async () => undefined);
    const moveTouch = vi.fn(async () => undefined);
    const endTouch = vi.fn(async () => undefined);
    const nativeDriver = {
      kind: 'native-sidecar',
      capabilities: {
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: true,
        bgraStream: true,
        discreteInput: false,
        continuousInput: true,
        multiTouch: true,
      },
      configureNativeStream: vi.fn(async (profile) => profile),
      streamNativeFrames,
      beginTouch,
      moveTouch,
      endTouch,
    } as unknown as IOSSimulatorNativeSidecarDriver;
    const getWindowSize = vi.fn(async () => ({ width: 393, height: 852 }));
    const configureStream = vi.fn(
      async (_driverSessionId: string, profile: IOSSimulatorStreamProfile) => profile,
    );
    const wdaDriver = {
      getWindowSize,
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      configureStream,
    };
    const capabilityReport = () => ({
      nativeSidecar: { available: true },
      routes: {
        continuousInput: {
          selected: 'native-sidecar',
          fallback: false,
          reason: null,
        },
        stream: {
          h264: {
            selected: 'native-sidecar',
            fallback: false,
            reason: null,
          },
        },
      },
    });
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: wdaDriver,
      driverSessionId: 'wda-session',
      driverRouter: {
        stream: vi.fn(() => ({
          adapter: 'native-sidecar',
          fallback: false,
          reason: null,
          source: nativeDriver,
        })),
        capabilityReport,
        continuousInput: vi.fn(() => nativeDriver),
      },
    } as unknown as WdaRunningInstance;
    const pushH264Frame = vi.fn();
    const liveViewerIds = new Set([77, 88]);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      driverManager: {
        get: vi.fn(() => running),
        start: vi.fn(async () => running),
        stop: vi.fn(async () => undefined),
      },
      pushH264Frame,
      isViewerWebContentsAlive: (webContentsId) => liveViewerIds.has(webContentsId),
    });
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 77, 'viewer-a'),
    ).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(streamNativeFrames).toHaveBeenCalledOnce());
    const firstFrame: IOSSimulatorH264Frame = {
      encoding: 'h264',
      format: 'annex-b',
      bytes: Uint8Array.from([0, 0, 0, 1]),
      receivedAt: '2026-08-07T00:00:00.001Z',
      width: 393,
      height: 852,
      orientation: 'PORTRAIT',
      scale: 1,
      colorSpace: 'srgb',
      timestampMicros: 1,
      keyFrame: true,
    };
    await emitFrame(firstFrame);
    expect(pushH264Frame).toHaveBeenCalledOnce();
    expect(pushH264Frame).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        instanceId: instance.instanceId,
        generation: instance.generation,
        encoding: 'h264',
      }),
    );

    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 88, 'viewer-b'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INSTANCE_NOT_OWNED' });
    await emitFrame({ ...firstFrame, timestampMicros: 2 });
    expect(pushH264Frame).toHaveBeenCalledTimes(2);
    expect(pushH264Frame).toHaveBeenLastCalledWith(
      77,
      expect.objectContaining({ instanceId: instance.instanceId }),
    );

    await expect(
      host.setViewerVisibility('session-a', route, false, 'h264', undefined, 77, 'viewer-a'),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 88, 'viewer-b'),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 88, 'viewer-c'),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.setViewerVisibility('session-a', route, false, 'h264', undefined, 88, 'viewer-b'),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });
    await emitFrame({ ...firstFrame, timestampMicros: 3 });
    expect(pushH264Frame).toHaveBeenCalledTimes(3);
    expect(pushH264Frame).toHaveBeenLastCalledWith(
      88,
      expect.objectContaining({ instanceId: instance.instanceId }),
    );

    const staleViewportDeferred: {
      resolve: ((value: { width: number; height: number }) => void) | null;
    } = { resolve: null };
    getWindowSize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          staleViewportDeferred.resolve = resolve;
        }),
    );
    const staleRemount = host.setViewerVisibility(
      'session-a',
      route,
      true,
      'h264',
      undefined,
      88,
      'viewer-d-stale',
    );
    await vi.waitFor(() => expect(staleViewportDeferred.resolve).not.toBeNull());
    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 88, 'viewer-e-current'),
    ).resolves.toMatchObject({ ok: true });
    staleViewportDeferred.resolve?.({ width: 393, height: 852 });
    await expect(staleRemount).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });
    await expect(
      host.setViewerVisibility('session-a', route, false, 'h264', undefined, 88, 'viewer-d-stale'),
    ).resolves.toMatchObject({ ok: true, data: { ignored: true } });

    const profileCallsBeforeStaleRequest = configureStream.mock.calls.length;
    await expect(
      host.setViewerStreamProfile('session-a', route, 88, 'viewer-c', {
        framesPerSecond: 10,
        jpegQuality: 45,
        scalingPercent: 70,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INSTANCE_NOT_OWNED' });
    expect(configureStream).toHaveBeenCalledTimes(profileCallsBeforeStaleRequest);

    const staleProfileDeferred: {
      resolve: ((profile: IOSSimulatorStreamProfile) => void) | null;
    } = { resolve: null };
    configureStream.mockImplementationOnce(
      (_driverSessionId, profile) =>
        new Promise((resolve) => {
          staleProfileDeferred.resolve = resolve;
          void profile;
        }),
    );
    const staleProfileRequest = host.setViewerStreamProfile(
      'session-a',
      route,
      88,
      'viewer-e-current',
      { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
    );
    await vi.waitFor(() => expect(staleProfileDeferred.resolve).not.toBeNull());
    await expect(
      host.setViewerVisibility(
        'session-a',
        route,
        true,
        'h264',
        undefined,
        88,
        'viewer-profile-current',
      ),
    ).resolves.toMatchObject({ ok: true });
    staleProfileDeferred.resolve?.({
      framesPerSecond: 10,
      jpegQuality: 45,
      scalingPercent: 70,
    });
    await expect(staleProfileRequest).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });
    await expect(
      host.setViewerStreamProfile('session-a', route, 88, 'viewer-profile-current', {
        framesPerSecond: 20,
        jpegQuality: 70,
        scalingPercent: 100,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      },
    });

    await expect(
      host.updateViewerTouch('session-a', route, 88, {
        gestureId: 'gesture-old-viewer',
        phase: 'begin',
        xRatio: 0.4,
        yRatio: 0.4,
      }),
    ).resolves.toMatchObject({ ok: true });
    liveViewerIds.delete(88);
    liveViewerIds.add(99);
    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 99, 'viewer-f'),
    ).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(endTouch).toHaveBeenCalledWith(
        'gesture-old-viewer',
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        true,
      ),
    );
    endTouch.mockClear();
    await emitFrame({ ...firstFrame, timestampMicros: 4 });
    expect(pushH264Frame).toHaveBeenCalledTimes(4);
    expect(pushH264Frame).toHaveBeenLastCalledWith(
      99,
      expect.objectContaining({ instanceId: instance.instanceId }),
    );

    await expect(
      host.updateViewerTouch('session-a', route, 99, {
        gestureId: 'gesture-1',
        phase: 'begin',
        xRatio: 0.5,
        yRatio: 0.5,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(beginTouch).toHaveBeenCalledTimes(2);
    expect(host.revokeRendererViewer('session-b', 99)).toBe(0);
    expect(host.revokeRendererViewer('session-a', 98)).toBe(0);
    await emitFrame({ ...firstFrame, timestampMicros: 5 });
    expect(pushH264Frame).toHaveBeenCalledTimes(5);

    expect(host.revokeRendererViewer('session-a', 99)).toBe(1);
    await vi.waitFor(() =>
      expect(endTouch).toHaveBeenCalledWith(
        'gesture-1',
        expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        true,
      ),
    );
    await emitFrame({ ...firstFrame, timestampMicros: 6 });
    expect(pushH264Frame).toHaveBeenCalledTimes(5);

    const current = actor.getOwned('session-a', instance.instanceId);
    await actor.stop({
      sessionId: current.sessionId,
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    });
    await emitFrame({ ...firstFrame, timestampMicros: 7 });
    expect(pushH264Frame).toHaveBeenCalledTimes(5);
    await host.dispose();
  });

  it('selects H.264, falls back to JPEG, and re-arms native streaming on the next viewer request', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const started = await actor.start({
      sessionId: 'session-a',
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    });
    const nativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const recoveredNativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const wdaDriver = {
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      configureStream: vi.fn(
        async (
          _sessionId: string,
          profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
        ) => profile,
      ),
      setOrientation: vi.fn(async () => undefined),
      tap: vi.fn(async () => undefined),
      swipe: vi.fn(
        async (
          ...args: [
            string,
            { x: number; y: number },
            { x: number; y: number },
            number,
            AbortSignal?,
          ]
        ) => {
          void args;
        },
      ),
    };
    let nativeAvailable = true;
    let selectedNativeDriver = nativeDriver;
    const routeStatuses: IOSSimulatorPublicRouteStatus[] = [];
    const running = {
      instanceId: started.instanceId,
      simulatorUdid: started.simulatorUdid,
      pid: 42,
      driver: wdaDriver,
      driverRouter: {
        continuousInput: vi.fn(() => null),
        stream: vi.fn(() =>
          nativeAvailable
            ? {
                adapter: 'native-sidecar',
                fallback: false,
                reason: null,
                source: selectedNativeDriver,
              }
            : {
                adapter: 'wda',
                fallback: true,
                reason: 'Native sidecar process is not running.',
                source: wdaDriver,
              },
        ),
        capabilityReport: vi.fn(() => ({
          nativeSidecar: { available: nativeAvailable },
          routes: {
            continuousInput: {
              selected: 'wda',
              fallback: true,
              reason: 'Native continuous input is unavailable.',
            },
            stream: {
              h264: nativeAvailable
                ? {
                    selected: 'native-sidecar',
                    fallback: false,
                    reason: null,
                  }
                : {
                    selected: 'wda',
                    fallback: true,
                    reason: 'Native sidecar process is not running.',
                  },
            },
          },
        })),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    let jpegSnapshot = {
      instanceId: started.instanceId,
      generation: started.generation,
      state: 'connecting' as 'connecting' | 'reconnecting' | 'disconnected',
      reconnectAttempt: 0,
      latestFrame: null,
    };
    let h264Snapshot = {
      ...jpegSnapshot,
      state: 'connecting' as 'connecting' | 'streaming' | 'disconnected',
    };
    const framePump = {
      setVisible: vi.fn((request: { instanceId: string; generation: number }) => {
        jpegSnapshot = {
          ...jpegSnapshot,
          instanceId: request.instanceId,
          generation: request.generation,
        };
        return jpegSnapshot;
      }),
      snapshot: vi.fn(() => jpegSnapshot),
      clear: vi.fn(),
    };
    const h264FramePump = {
      setVisible: vi.fn((request: { instanceId: string; generation: number }) => {
        h264Snapshot = {
          ...h264Snapshot,
          instanceId: request.instanceId,
          generation: request.generation,
        };
        return h264Snapshot;
      }),
      snapshot: vi.fn(() => h264Snapshot),
      clear: vi.fn(),
    };
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      recoverNativeSidecar: vi.fn(async () => {
        selectedNativeDriver = recoveredNativeDriver;
        nativeAvailable = true;
        return running;
      }),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      h264FramePump: h264FramePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      pushRouteStatus: (status) => routeStatuses.push(status),
    });
    await host.reconcileOwnership();
    const reconciled = actor.getOwned('session-a', started.instanceId);
    const route = {
      instanceId: reconciled.instanceId,
      generation: reconciled.generation,
      leaseId: reconciled.lease.id,
    };

    await expect(
      host.setViewerVisibility('session-a', route, true, 'h264', undefined, 77, 'viewer-token'),
    ).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'connecting' } },
    });
    expect(h264FramePump.setVisible).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: started.instanceId,
        driver: nativeDriver,
        profile: {
          encoding: 'h264',
          framesPerSecond: 5,
          scalingPercent: 50,
          orientation: 'PORTRAIT',
        },
        visible: true,
      }),
    );
    expect(framePump.setVisible).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    expect(routeStatuses.at(-1)).toMatchObject({
      sessionId: 'session-a',
      instanceId: started.instanceId,
      generation: route.generation,
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'detecting',
        reasonCode: 'native-probe-pending',
      },
    });

    h264FramePump.snapshot.mockClear();
    framePump.snapshot.mockClear();
    await expect(host.getLatestFrame('session-a', route, 88)).resolves.toMatchObject({
      ok: false,
      errorCode: 'INSTANCE_NOT_OWNED',
    });
    expect(h264FramePump.snapshot).not.toHaveBeenCalled();
    expect(framePump.snapshot).not.toHaveBeenCalled();

    const fallbackHighProfile = {
      framesPerSecond: 20,
      jpegQuality: 70,
      scalingPercent: 100,
    };
    const experimentalNativeProfile = {
      framesPerSecond: 60,
      scalingPercent: 70,
    };
    await expect(
      host.setViewerStreamProfile(
        'session-a',
        route,
        77,
        'viewer-token',
        fallbackHighProfile,
        experimentalNativeProfile,
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(wdaDriver.configureStream).not.toHaveBeenCalled();

    h264Snapshot = { ...h264Snapshot, state: 'streaming' };
    await expect(
      host.setViewerStreamProfile(
        'session-a',
        route,
        77,
        'viewer-token',
        fallbackHighProfile,
        experimentalNativeProfile,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        profile: fallbackHighProfile,
        nativeProfile: experimentalNativeProfile,
      },
    });
    expect(wdaDriver.configureStream).toHaveBeenLastCalledWith('wda-session', fallbackHighProfile);
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          encoding: 'h264',
          framesPerSecond: 60,
          scalingPercent: 70,
        }),
      }),
    );
    await expect(
      host.setViewerStreamProfile('session-a', route, 77, 'viewer-token', {
        framesPerSecond: 60,
        jpegQuality: 70,
        scalingPercent: 70,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });

    wdaDriver.setOrientation.mockRejectedValueOnce(
      new WdaError(
        'ORIENTATION_UNSUPPORTED',
        'The foreground app does not support the requested orientation.',
        500,
      ),
    );
    const orientationResult = await host.callTool(
      'set_orientation',
      { ...route, orientation: 'LANDSCAPE' },
      { sessionId: 'session-a', origin: 'user' },
    );
    expect(orientationResult).toMatchObject({
      ok: true,
      data: {
        mode: 'viewer',
        orientation: 'LANDSCAPE',
        viewport: { width: 852, height: 393, orientation: 'LANDSCAPE' },
      },
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ orientation: 'LANDSCAPE' }),
      }),
    );
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.25, yRatio: 0.5 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(wdaDriver.tap).toHaveBeenCalledWith(
      'wda-session',
      {
        x: 196.5,
        y: 639,
      },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          startXRatio: 0.1,
          startYRatio: 0.2,
          endXRatio: 0.9,
          endYRatio: 0.8,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const rotatedSwipe = wdaDriver.swipe.mock.lastCall!;
    expect(rotatedSwipe[0]).toBe('wda-session');
    expect(rotatedSwipe[1]!.x).toBeCloseTo(78.6);
    expect(rotatedSwipe[1]!.y).toBeCloseTo(766.8);
    expect(rotatedSwipe[2]!.x).toBeCloseTo(314.4);
    expect(rotatedSwipe[2]!.y).toBeCloseTo(85.2);
    expect(rotatedSwipe[3]).toBe(250);
    expect(rotatedSwipe[4]).toBeInstanceOf(AbortSignal);
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'PORTRAIT' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        mode: 'device',
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          framesPerSecond: 60,
          scalingPercent: 70,
          orientation: 'PORTRAIT',
        }),
      }),
    );

    h264Snapshot = { ...h264Snapshot, state: 'disconnected' };
    nativeAvailable = false;
    const afterOrientation = actor.getOwned('session-a', started.instanceId);
    const latestRoute = {
      instanceId: afterOrientation.instanceId,
      generation: afterOrientation.generation,
      leaseId: afterOrientation.lease.id,
    };
    await expect(host.getLatestFrame('session-a', latestRoute, 77)).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'connecting' } },
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(started.instanceId);
    expect(framePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true }),
    );
    expect(routeStatuses.at(-1)).toMatchObject({
      sessionId: 'session-a',
      instanceId: started.instanceId,
      generation: latestRoute.generation,
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'detecting',
        reasonCode: 'native-stream-disconnected',
      },
    });

    jpegSnapshot = { ...jpegSnapshot, state: 'reconnecting' };
    await expect(host.getLatestFrame('session-a', latestRoute, 77)).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'reconnecting' } },
    });
    expect(routeStatuses.at(-1)).toMatchObject({
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'reconnecting',
        reasonCode: 'native-stream-disconnected',
      },
    });

    h264Snapshot = { ...h264Snapshot, state: 'connecting' };
    await expect(
      host.setViewerVisibility(
        'session-a',
        latestRoute,
        true,
        'h264',
        undefined,
        77,
        'viewer-token',
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'connecting' } },
    });
    expect(driverManager.recoverNativeSidecar).toHaveBeenCalledWith(started.instanceId, {
      rearm: false,
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        driver: recoveredNativeDriver,
        visible: true,
      }),
    );

    await expect(
      host.setViewerVisibility(
        'session-a',
        latestRoute,
        false,
        'jpeg',
        undefined,
        77,
        'viewer-token',
      ),
    ).resolves.toMatchObject({ ok: true });
    nativeAvailable = false;
    await expect(
      host.setViewerVisibility(
        'session-a',
        latestRoute,
        true,
        'h264',
        undefined,
        77,
        'viewer-reopened',
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(driverManager.recoverNativeSidecar).toHaveBeenLastCalledWith(started.instanceId, {
      rearm: true,
    });
  });

  it('stops the embedded viewer when the exact external simulator is shut down', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => shutdownDevice),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
      deviceLivenessIntervalMs: 0,
    });
    const route = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };

    const result = await host.setViewerVisibility('session-a', route, true);

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          generation: initialGeneration + 1,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
        stream: null,
        viewport: null,
      },
    });
    expect(lifecycle.bootExact).not.toHaveBeenCalled();
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
  });

  it('does not resurrect a viewer when driver startup finishes after an external shutdown', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi
        .fn()
        .mockResolvedValueOnce(READY_REPORT.devices[0]!)
        .mockResolvedValue(shutdownDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let resolveStart!: (running: WdaRunningInstance) => void;
    let liveRunning: WdaRunningInstance | null = null;
    const running = {
      instanceId: attached.instanceId,
      simulatorUdid: attached.simulatorUdid,
      pid: 42,
      driver: {},
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => liveRunning),
      start: vi.fn(
        () =>
          new Promise<WdaRunningInstance>((resolve) => {
            resolveStart = (value) => {
              liveRunning = value;
              resolve(value);
            };
          }),
      ),
      stop: vi.fn(async () => {
        liveRunning = null;
      }),
    };
    const framePump = {
      setVisible: vi.fn(),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
      deviceLivenessIntervalMs: 0,
    });
    const route = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };

    const viewer = host.setViewerVisibility('session-a', route, true);
    await vi.waitFor(() => expect(driverManager.start).toHaveBeenCalledTimes(1));
    await expect(host.getStatus('session-a')).resolves.toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
      ],
    });

    resolveStart(running);

    await expect(viewer).resolves.toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: attached.instanceId,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
        stream: null,
        viewport: null,
      },
    });
    expect(framePump.setVisible).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledTimes(2);
  });

  it('does not unblock builds when an external shutdown overlaps instance activation', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const environment = { ...READY_REPORT, devices: [shutdownDevice] };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => shutdownDevice),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: shutdownDevice,
    });
    const running = {
      instanceId: attached.instanceId,
      simulatorUdid: attached.simulatorUdid,
      pid: 42,
      driver: {},
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(async () => running),
      stop: vi.fn(async () => undefined),
    };
    const build = vi.fn<IOSSimulatorProjectBuilderAdapter['build']>();
    const resourceScheduler = testResourceScheduler();
    const runStart = resourceScheduler.runStart.bind(resourceScheduler);
    let signalActivationReady!: () => void;
    const activationReady = new Promise<void>((resolve) => {
      signalActivationReady = resolve;
    });
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    vi.spyOn(resourceScheduler, 'runStart').mockImplementation(async (instanceId, task) => {
      const result = await runStart(instanceId, task);
      signalActivationReady();
      await activationGate;
      return result;
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      projectBuilder: { build },
      runtime: { inspect: vi.fn(async () => environment) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler,
      deviceLivenessIntervalMs: 0,
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('session-a', attached.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    const startPromise = host.callTool('start_instance', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await activationReady;
    await expect(host.getStatus('session-a')).resolves.toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          lifecycleState: 'stopped',
        },
      ],
    });
    releaseActivation();

    await expect(startPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    const stopped = actor.getOwned('session-a', attached.instanceId);
    await expect(
      host.callTool(
        'build_app',
        {
          instanceId: stopped.instanceId,
          generation: stopped.generation,
          leaseId: stopped.lease.id,
        },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MUTATION_CANCELLED' });
    expect(build).not.toHaveBeenCalled();
    await host.dispose();
  });

  it.each(['stop_instance', 'detach_device'] as const)(
    'cancels driver startup when %s overlaps Simulator boot',
    async (toolName) => {
      const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
      const bootedDevice = { ...READY_REPORT.devices[0]!, state: 'Booted' as const };
      let resolveBoot: (device: typeof bootedDevice) => void = () => undefined;
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(async () => bootedDevice),
        bootExact: vi.fn(
          () =>
            new Promise<typeof bootedDevice>((resolve) => {
              resolveBoot = resolve;
            }),
        ),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      };
      const detachedCleanups: Array<() => void | Promise<void>> = [];
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
        lifecycle,
        scheduler: {
          schedule: (_delay, task) => {
            detachedCleanups.push(task);
            return () => {
              const index = detachedCleanups.indexOf(task);
              if (index >= 0) detachedCleanups.splice(index, 1);
            };
          },
        },
      });
      const attached = actor.attach({
        sessionId: 'session-a',
        worktreeRoot: '/tmp/session-a',
        sourceFingerprint: 'fingerprint-a',
        device: shutdownDevice,
      });
      const startDriver = vi.fn();
      const stopDriver = vi.fn(async () => undefined);
      const resourceScheduler = testResourceScheduler();
      const environment = { ...READY_REPORT, devices: [shutdownDevice] };
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        driverManager: {
          get: vi.fn(() => null),
          start: startDriver,
          stop: stopDriver,
        },
        resourceScheduler,
        runtime: { inspect: vi.fn(async () => environment) },
        getSession: vi.fn(async (id) => localSession(id)),
        deviceLivenessIntervalMs: 0,
      });
      await host.reconcileOwnership();
      stopDriver.mockClear();
      const current = actor.getOwned('session-a', attached.instanceId);
      const route = {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      };

      const start = host.callTool('start_instance', route, {
        sessionId: 'session-a',
        origin: 'user',
      });
      await vi.waitFor(() => expect(lifecycle.bootExact).toHaveBeenCalledOnce());
      const teardown = host.callTool(toolName, route, {
        sessionId: 'session-a',
        origin: 'user',
      });
      await vi.waitFor(() => expect(stopDriver).toHaveBeenCalledWith(attached.instanceId));
      resolveBoot(bootedDevice);

      await expect(start).resolves.toMatchObject({
        ok: false,
        errorCode: 'MUTATION_CANCELLED',
      });
      await expect(teardown).resolves.toMatchObject({ ok: true });
      expect(startDriver).not.toHaveBeenCalled();

      if (toolName === 'stop_instance') {
        expect(actor.getOwned('session-a', attached.instanceId)).toMatchObject({
          lifecycleState: 'stopped',
        });
        expect(resourceScheduler.runningCount()).toBe(0);
      } else {
        expect(actor.getOwned('session-a', attached.instanceId)).toMatchObject({
          viewerState: 'detached',
          bootProvenance: 'agent-booted',
        });
        expect(detachedCleanups).toHaveLength(1);
        await detachedCleanups[0]?.();
        expect(actor.list('session-a')).toEqual([]);
        expect(resourceScheduler.runningCount()).toBe(0);
      }
      await host.dispose();
    },
  );

  it('ignores an exact-device probe that finishes after the binding is detached', async () => {
    let resolveProbe!: (device: (typeof READY_REPORT.devices)[number] | null) => void;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(
        () =>
          new Promise<(typeof READY_REPORT.devices)[number] | null>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    const status = host.getStatus('session-a');
    await vi.waitFor(() => expect(lifecycle.findExact).toHaveBeenCalledTimes(1));
    const current = actor.getOwned('session-a', attached.instanceId);
    await actor.detach({
      instanceId: current.instanceId,
      sessionId: current.sessionId,
      generation: current.generation,
      leaseId: current.lease.id,
    });
    resolveProbe(READY_REPORT.devices[0]!);

    await expect(status).resolves.toMatchObject({ ok: true, instances: [] });
  });

  it('marks an unavailable exact simulator as orphaned even when it reports Shutdown', async () => {
    const unavailableDevice = {
      ...READY_REPORT.devices[0]!,
      state: 'Shutdown' as const,
      isAvailable: false,
      availabilityError: 'runtime unavailable',
    };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => unavailableDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    await expect(host.getStatus('session-a')).resolves.toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          lifecycleState: 'error',
          healthState: 'degraded',
          errorCode: 'ORPHANED_DEVICE',
        },
      ],
    });
  });

  it('marks an externally deleted exact simulator as orphaned', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => null),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    const status = await host.getStatus('session-a');

    expect(status).toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          generation: initialGeneration + 2,
          lifecycleState: 'error',
          healthState: 'degraded',
          errorCode: 'ORPHANED_DEVICE',
        },
      ],
    });
    expect(lifecycle.bootExact).not.toHaveBeenCalled();
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
  });

  it('deduplicates concurrent exact-device liveness probes for one generation', async () => {
    let resolveProbe!: (device: (typeof READY_REPORT.devices)[number] | null) => void;
    const probe = new Promise<(typeof READY_REPORT.devices)[number] | null>((resolve) => {
      resolveProbe = resolve;
    });
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(() => probe),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 1_000,
    });

    const statuses = Promise.all([host.getStatus('session-a'), host.getStatus('session-a')]);
    await vi.waitFor(() => expect(lifecycle.findExact).toHaveBeenCalledTimes(1));
    resolveProbe({ ...READY_REPORT.devices[0]!, state: 'Booted' });

    await expect(statuses).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        instances: [
          expect.objectContaining({
            instanceId: attached.instanceId,
            generation: initialGeneration + 1,
            lifecycleState: 'ready',
          }),
        ],
      }),
      expect.objectContaining({
        ok: true,
        instances: [
          expect.objectContaining({
            instanceId: attached.instanceId,
            generation: initialGeneration + 1,
            lifecycleState: 'ready',
          }),
        ],
      }),
    ]);
    expect(lifecycle.findExact).toHaveBeenCalledTimes(1);
  });

  it('creates and attaches a Cindy-owned simulator from an exact template device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async ({ name, runtimeIdentifier, deviceTypeIdentifier }) => ({
        udid: '2A9D41E0-E031-4AD0-A8B5-847480802E8E',
        name,
        runtimeIdentifier,
        deviceTypeIdentifier,
      })),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const templateDevice = {
      ...READY_REPORT.devices[0]!,
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    };
    const host = createIOSSimulatorHost({
      actor,
      runtime: {
        inspect: vi.fn(async () => ({ ...READY_REPORT, devices: [templateDevice] })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await expect(
      host.callTool(
        'create_instance',
        { templateUdid: templateDevice.udid, name: 'Cindy iPhone' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        instance: {
          simulatorName: 'Cindy iPhone',
          creationProvenance: 'cindy',
          lifecycleState: 'stopped',
        },
      },
    });
    expect(lifecycle.createExact).toHaveBeenCalledWith(
      {
        name: 'Cindy iPhone',
        runtimeIdentifier: templateDevice.runtimeIdentifier,
        deviceTypeIdentifier: templateDevice.deviceTypeIdentifier,
      },
      expect.any(AbortSignal),
    );
  });

  it('aborts and drains create_instance before Host disposal completes', async () => {
    const createdUdid = '2A9D41E0-E031-4AD0-A8B5-847480802E8E';
    let createSignal: AbortSignal | undefined;
    let resolveCreate: (created: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    let resolveDelete: () => void = () => undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(
        (_input, signal) =>
          new Promise<Awaited<ReturnType<IOSSimulatorSimctlLifecycle['createExact']>>>(
            (resolve) => {
              createSignal = signal;
              resolveCreate = resolve;
            },
          ),
      ),
      deleteExact: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      ),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const templateDevice = {
      ...READY_REPORT.devices[0]!,
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: {
        inspect: vi.fn(async () => ({ ...READY_REPORT, devices: [templateDevice] })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    const call = host.callTool(
      'create_instance',
      { templateUdid: templateDevice.udid, name: 'Cindy iPhone' },
      { sessionId: 'session-a', origin: 'user' },
    );
    await vi.waitFor(() => expect(createSignal).toBeDefined());

    const disposing = host.dispose();
    expect(createSignal?.aborted).toBe(true);
    resolveCreate({
      udid: createdUdid,
      name: 'Cindy iPhone',
      runtimeIdentifier: templateDevice.runtimeIdentifier,
      deviceTypeIdentifier: templateDevice.deviceTypeIdentifier,
    });
    await vi.waitFor(() => expect(lifecycle.deleteExact).toHaveBeenCalledOnce());
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    resolveDelete();

    await expect(call).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(disposing).resolves.toBeUndefined();
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(createdUdid, expect.any(AbortSignal));
    expect(actor.listAll()).toEqual([]);
  });

  it('forwards task cancellation to an active simulator control command', async () => {
    let controlSignal: AbortSignal | undefined;
    const bootedDevice = READY_REPORT.devices[0]!;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => bootedDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
      setAppearance: vi.fn(
        (_udid, _appearance, signal) =>
          new Promise<void>((_resolve, reject) => {
            controlSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'abc',
      device: bootedDevice,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('session-a', instance.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    const changing = host.callTool(
      'set_appearance',
      { ...route, appearance: 'dark' },
      { sessionId: 'session-a', origin: 'user' },
    );
    await vi.waitFor(() => expect(controlSignal).toBeDefined());

    const cancelling = host.cancelSessionOperations('session-a');
    expect(controlSignal?.aborted).toBe(true);

    await expect(changing).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cancelling).resolves.toBeUndefined();
    expect(lifecycle.setAppearance).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'dark',
      controlSignal,
    );
    await host.dispose();
  });

  it('cancels active WDA snapshot reads with the owning task', async () => {
    let snapshotSignal: AbortSignal | undefined;
    const bootedDevice = READY_REPORT.devices[0]!;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => bootedDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'abc',
      device: bootedDevice,
    });
    const driver = {
      getAccessibilityTree: vi.fn(
        (_sessionId: string | undefined, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            snapshotSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
    };
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver,
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => running),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('session-a', instance.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    const reading = host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await vi.waitFor(() => expect(snapshotSignal).toBeDefined());

    const cancelling = host.cancelSessionOperations('session-a');
    expect(snapshotSignal?.aborted).toBe(true);
    await expect(reading).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cancelling).resolves.toBeUndefined();
    expect(driver.getAccessibilityTree).toHaveBeenCalledWith('wda-session', snapshotSignal);
    await host.dispose();
  });

  it('automatically authorizes the same agent session after attach for start', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const driver = {
      configureStream: vi.fn(
        async (_sessionId: string, profile: IOSSimulatorStreamProfile) => profile,
      ),
    };
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver,
            driverSessionId: 'wda-session',
          }) as unknown as WdaRunningInstance,
      ),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    const attachedResult = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-agent', origin: 'agent' },
    );
    expect(attachedResult).toMatchObject({ ok: true });

    const instance = actor.list('session-agent')[0]!;
    await expect(
      host.callTool(
        'start_instance',
        {
          instanceId: instance.instanceId,
          generation: instance.generation,
          leaseId: instance.lease.id,
        },
        { sessionId: 'session-agent', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(lifecycle.bootExact).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
  });

  it('revokes an attached agent lease even when persisting the denial fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const grantStore = new IOSSimulatorDeviceGrantStore({
      initialGrants: [
        {
          simulatorUdid: READY_REPORT.devices[0]!.udid,
          agentControl: 'allowed',
          screenshotCapture: 'unknown',
          policySource: 'user',
          updatedAt: '2026-08-07T00:00:00.000Z',
        },
      ],
      onChange: () => {
        throw new Error('disk unavailable');
      },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      grantStore,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-agent', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const instance = actor.list('session-agent')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    await expect(
      host.setAgentControlGrant('session-agent', instance.instanceId, 'denied'),
    ).resolves.toMatchObject({ ok: false });
    expect(grantStore.get(instance.simulatorUdid).agentControl).toBe('denied');
    await expect(
      host.callTool('stop_instance', route, {
        sessionId: 'session-agent',
        origin: 'agent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'DEVICE_CONTROL_NOT_GRANTED' });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it('rechecks a Main-owned elevation after resolving the task and before persistence', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const grantStore = new IOSSimulatorDeviceGrantStore();
    let pauseSessionResolution = false;
    let notifyResolutionStarted: (() => void) | undefined;
    let releaseSessionResolution: (() => void) | undefined;
    const resolutionStarted = new Promise<void>((resolve) => {
      notifyResolutionStarted = resolve;
    });
    const resolutionGate = new Promise<void>((resolve) => {
      releaseSessionResolution = resolve;
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      grantStore,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => {
        if (pauseSessionResolution) {
          notifyResolutionStarted?.();
          await resolutionGate;
        }
        return localSession(id);
      }),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-agent', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const instance = actor.list('session-agent')[0]!;
    let approvalCurrent = true;
    const assertElevationCurrent = vi.fn(() => {
      if (!approvalCurrent) throw new Error('Agent control approval expired');
    });

    pauseSessionResolution = true;
    const elevation = host.setAgentControlGrant(
      'session-agent',
      instance.instanceId,
      'allowed',
      assertElevationCurrent,
    );
    await resolutionStarted;
    approvalCurrent = false;
    releaseSessionResolution?.();

    await expect(elevation).resolves.toMatchObject({ ok: false });
    expect(assertElevationCurrent).toHaveBeenCalledOnce();
    expect(grantStore.get(instance.simulatorUdid).agentControl).toBe('unknown');
  });

  it('renews the lease after a slow driver start and opens the embedded viewer', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 60_000,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const requestViewerFocus = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(async (options) => {
          now = 61_001;
          return {
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          } as unknown as WdaRunningInstance;
        }),
        stop: vi.fn(async () => undefined),
      },
      requestViewerFocus,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'slow-session', origin: 'user' },
    );
    const attached = actor.list('slow-session')[0]!;
    const result = await host.callTool(
      'start_instance',
      {
        instanceId: attached.instanceId,
        generation: attached.generation,
        leaseId: attached.lease.id,
      },
      { sessionId: 'slow-session', origin: 'user' },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: attached.instanceId,
          lifecycleState: 'ready',
          lease: {
            id: expect.any(String),
            expiresAt: new Date(121_001).toISOString(),
          },
        },
      },
    });
    expect(
      (
        result as {
          ok: true;
          data: { instance: { lease: { id: string } } };
        }
      ).data.instance.lease.id,
    ).not.toBe(attached.lease.id);
    expect(requestViewerFocus).toHaveBeenCalledOnce();
    expect(requestViewerFocus).toHaveBeenCalledWith('slow-session', attached.instanceId);
  });

  it('does not open the embedded viewer when driver startup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const requestViewerFocus = vi.fn();
    const resourceScheduler = testResourceScheduler();
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(async (options: { instanceId: string; simulatorUdid: string }) => {
        return {
          instanceId: options.instanceId,
          simulatorUdid: options.simulatorUdid,
          pid: 42,
          driver: {},
          driverSessionId: 'wda-session',
        } as unknown as WdaRunningInstance;
      }),
      stop: vi.fn(async () => undefined),
    };
    driverManager.start.mockRejectedValueOnce(new WdaError('UNREACHABLE', 'driver failed'));
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      requestViewerFocus,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler,
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'failed-session', origin: 'user' },
    );
    const attached = actor.list('failed-session')[0]!;
    await expect(
      host.callTool(
        'start_instance',
        {
          instanceId: attached.instanceId,
          generation: attached.generation,
          leaseId: attached.lease.id,
        },
        { sessionId: 'failed-session', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DRIVER_DISCONNECTED',
    });
    expect(requestViewerFocus).not.toHaveBeenCalled();
    expect(resourceScheduler.runningCount()).toBe(1);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    const retryInstance = actor.list('failed-session')[0]!;
    expect(retryInstance).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'degraded',
      errorCode: 'WDA_UNAVAILABLE',
    });
    await expect(
      host.callTool(
        'start_instance',
        {
          instanceId: retryInstance.instanceId,
          generation: retryInstance.generation,
          leaseId: retryInstance.lease.id,
        },
        { sessionId: 'failed-session', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(lifecycle.bootExact).toHaveBeenCalledOnce();
    expect(driverManager.start).toHaveBeenCalledTimes(2);
    expect(resourceScheduler.runningCount()).toBe(1);
  });

  it.each(['booting', 'probe-error'] as const)(
    'keeps scheduler occupancy when readiness fails with a %s exact probe',
    async (probeMode) => {
      const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
      const bootingDevice = { ...READY_REPORT.devices[0]!, state: 'Booting' as const };
      let findExactCalls = 0;
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(async () => {
          findExactCalls += 1;
          if (findExactCalls === 1) return shutdownDevice;
          if (probeMode === 'probe-error') throw new Error('simctl probe failed');
          return bootingDevice;
        }),
        bootExact: vi.fn(async () => {
          throw new IOSSimulatorInstanceError(
            'SIMULATOR_BOOT_TIMEOUT',
            'Device boot started but readiness timed out.',
            true,
          );
        }),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      };
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore(),
        lifecycle,
      });
      const resourceScheduler = testResourceScheduler();
      const driverManager = {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      };
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        driverManager,
        runtime: {
          inspect: vi.fn(async () => ({ ...READY_REPORT, devices: [shutdownDevice] })),
        },
        getSession: vi.fn(async (id) => localSession(id)),
        resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
        resourceScheduler,
        deviceLivenessIntervalMs: 0,
      });

      await host.callTool(
        'attach_device',
        { udid: shutdownDevice.udid },
        { sessionId: 'boot-timeout-session', origin: 'user' },
      );
      const attached = actor.list('boot-timeout-session')[0]!;
      await expect(
        host.callTool(
          'start_instance',
          {
            instanceId: attached.instanceId,
            generation: attached.generation,
            leaseId: attached.lease.id,
          },
          { sessionId: 'boot-timeout-session', origin: 'user' },
        ),
      ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_BOOT_TIMEOUT' });
      expect(resourceScheduler.runningCount()).toBe(1);
      expect(driverManager.start).not.toHaveBeenCalled();
      expect(actor.list('boot-timeout-session')[0]).toMatchObject({
        lifecycleState: 'error',
        errorCode: 'SIMULATOR_BOOT_TIMEOUT',
      });
      await host.dispose();
    },
  );

  it('cancels an active build before detaching and releasing scheduler capacity', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const actorStart = vi.spyOn(actor, 'start');
    const actorAttach = vi.spyOn(actor, 'attachSerialized');
    const resourceScheduler = testResourceScheduler();
    let running: WdaRunningInstance | null = null;
    let buildSignal: AbortSignal | undefined;
    let finishDetachCleanup!: () => void;
    const discardInstance = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDetachCleanup = resolve;
        }),
    );
    const build = vi.fn(
      (input: Parameters<IOSSimulatorProjectBuilderAdapter['build']>[0]) =>
        new Promise<Awaited<ReturnType<IOSSimulatorProjectBuilderAdapter['build']>>>(
          (_, reject) => {
            buildSignal = input.signal;
            input.signal?.addEventListener('abort', () => {
              reject(
                new IOSSimulatorProjectBuildError(
                  'APP_BUILD_FAILED',
                  'cancelled',
                  '',
                  null,
                  false,
                  true,
                ),
              );
            });
          },
        ),
    );
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler,
      projectBuilder: { build },
      driverManager: {
        get: vi.fn(() => running),
        start: vi.fn(async (options) => {
          running = {
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {} as WdaRunningInstance['driver'],
            driverSessionId: 'wda-session',
          } as WdaRunningInstance;
          return running;
        }),
        stop: vi.fn(async () => {
          running = null;
        }),
      },
      mediaCapture: {
        discardInstance,
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });

    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    actorAttach.mockClear();
    expect(resourceScheduler.runningCount()).toBe(1);
    const attached = actor.list('session-a')[0]!;
    const route = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };
    const buildPromise = host.callTool('build_app', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());

    const detachPromise = host.callTool('detach_device', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await vi.waitFor(() => expect(discardInstance).toHaveBeenCalledOnce());
    expect(buildSignal?.aborted).toBe(true);
    await expect(buildPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(
      host.callTool('build_app', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MUTATION_CANCELLED' });
    await expect(
      host.callTool('start_instance', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MUTATION_CANCELLED' });
    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MUTATION_CANCELLED' });
    expect(build).toHaveBeenCalledOnce();
    expect(actorStart).not.toHaveBeenCalled();
    expect(actorAttach).not.toHaveBeenCalled();
    finishDetachCleanup();
    await expect(detachPromise).resolves.toMatchObject({ ok: true });
    expect(resourceScheduler.runningCount()).toBe(0);
    await host.dispose();
  });

  it('waits for a racing start and shuts down the device before cleanup returns', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const bootedDevice = { ...READY_REPORT.devices[0]!, state: 'Booted' as const };
    let resolveBoot: (device: typeof bootedDevice) => void = () => undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => bootedDevice),
      bootExact: vi.fn(
        () =>
          new Promise<typeof bootedDevice>((resolve) => {
            resolveBoot = resolve;
          }),
      ),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: shutdownDevice,
    });
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const resourceScheduler = testResourceScheduler();
    const environment = { ...READY_REPORT, devices: [shutdownDevice] };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      resourceScheduler,
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => environment) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    await host.reconcileOwnership();
    driverManager.stop.mockClear();
    const current = actor.getOwned('session-a', attached.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    const start = host.callTool('start_instance', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await vi.waitFor(() => expect(lifecycle.bootExact).toHaveBeenCalledOnce());
    const cleanup = host.cleanupRemovedSession('session-a');
    resolveBoot(bootedDevice);

    await expect(start).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cleanup).resolves.toBeUndefined();
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      attached.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(actor.list('session-a')).toEqual([]);
    expect(resourceScheduler.runningCount()).toBe(0);
  });

  it('waits for a racing viewer open before clearing its runtime projection', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let resolveWindowSize: (size: { width: number; height: number }) => void = () => undefined;
    const running = {
      instanceId: attached.instanceId,
      simulatorUdid: attached.simulatorUdid,
      pid: 42,
      driver: {
        getWindowSize: vi.fn(
          () =>
            new Promise<{ width: number; height: number }>((resolve) => {
              resolveWindowSize = resolve;
            }),
        ),
        getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const framePump = {
      setVisible: vi.fn(),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('session-a', attached.instanceId);
    const route = {
      instanceId: current.instanceId,
      generation: current.generation,
      leaseId: current.lease.id,
    };

    const viewer = host.setViewerVisibility('session-a', route, true, 'jpeg');
    await vi.waitFor(() => expect(running.driver.getWindowSize).toHaveBeenCalledOnce());
    const cleanup = host.cleanupRemovedSession('session-a');
    await Promise.resolve();
    expect(driverManager.stop).not.toHaveBeenCalled();
    resolveWindowSize({ width: 393, height: 852 });

    await expect(viewer).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cleanup).resolves.toBeUndefined();
    expect(framePump.setVisible).not.toHaveBeenCalled();
    expect(framePump.clear).toHaveBeenCalledWith(attached.instanceId);
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
    expect(actor.list('session-a')).toEqual([]);
  });

  it('waits for a racing attach and removes its partially started runtime', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    let resolveDriverStart: (running: WdaRunningInstance) => void = () => undefined;
    let liveRunning: WdaRunningInstance | null = null;
    const driverManager = {
      get: vi.fn(() => liveRunning),
      start: vi.fn(
        () =>
          new Promise<WdaRunningInstance>((resolve) => {
            resolveDriverStart = (running) => {
              liveRunning = running;
              resolve(running);
            };
          }),
      ),
      stop: vi.fn(async () => {
        liveRunning = null;
      }),
    };
    const resourceScheduler = testResourceScheduler();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      resourceScheduler,
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });
    await host.reconcileOwnership();

    const attach = host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    await vi.waitFor(() => expect(driverManager.start).toHaveBeenCalledOnce());
    const attached = actor.list('session-a')[0]!;
    const cleanup = host.cleanupRemovedSession('session-a');
    resolveDriverStart({
      instanceId: attached.instanceId,
      simulatorUdid: attached.simulatorUdid,
      pid: 42,
      driver: {},
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance);

    await expect(attach).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cleanup).resolves.toBeUndefined();
    expect(actor.list('session-a')).toEqual([]);
    expect(resourceScheduler.runningCount()).toBe(0);
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('waits for a racing create and deletes the late Cindy-owned device', async () => {
    const template = {
      ...READY_REPORT.devices[0]!,
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    };
    const createdDevice = {
      ...template,
      udid: '2A9D41E0-E031-4AD0-A8B5-847480802E8E',
      name: 'Late Cindy iPhone',
      state: 'Shutdown' as const,
    };
    let resolveCreate: (device: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => createdDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(
        (_input: Parameters<IOSSimulatorSimctlLifecycle['createExact']>[0]) =>
          new Promise<Awaited<ReturnType<IOSSimulatorSimctlLifecycle['createExact']>>>(
            (resolve) => {
              resolveCreate = resolve;
            },
          ),
      ),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const environment = { ...READY_REPORT, devices: [template] };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => environment) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });
    await host.reconcileOwnership();

    const create = host.callTool(
      'create_instance',
      { templateUdid: template.udid, name: createdDevice.name },
      { sessionId: 'session-a', origin: 'user' },
    );
    await vi.waitFor(() => expect(lifecycle.createExact).toHaveBeenCalledOnce());
    const cleanup = host.cleanupRemovedSession('session-a');
    resolveCreate({
      udid: createdDevice.udid,
      name: createdDevice.name,
      runtimeIdentifier: createdDevice.runtimeIdentifier,
      deviceTypeIdentifier: createdDevice.deviceTypeIdentifier!,
    });

    await expect(create).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(cleanup).resolves.toBeUndefined();
    expect(actor.list('session-a')).toEqual([]);
    expect(lifecycle.findExact).not.toHaveBeenCalled();
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(createdDevice.udid, expect.any(AbortSignal));
  });

  it('does not register a build after its task is archived at the reconcile boundary', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    let armed = false;
    let armedReadCount = 0;
    let signalFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    let resolveFinalRead!: () => void;
    const getSession = vi.fn(async (id: string) => {
      const snapshot = { ...localSession(id), status: 'active' as const };
      if (armed && ++armedReadCount === 2) {
        signalFinalRead();
        await new Promise<void>((resolve) => {
          resolveFinalRead = resolve;
        });
      }
      return snapshot;
    });
    const build = vi.fn<IOSSimulatorProjectBuilderAdapter['build']>();
    const discardSession = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession,
      projectBuilder: { build },
      mediaCapture: {
        discardSession,
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });

    await host.reconcileOwnership();
    const instance = actor.list('session-a')[0]!;
    armed = true;

    const buildPromise = host.callTool(
      'build_app',
      {
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      },
      { sessionId: 'session-a', origin: 'user' },
    );
    await finalReadStarted;
    await host.cancelSessionOperations('session-a');
    expect(discardSession).toHaveBeenCalledOnce();
    expect(discardSession).toHaveBeenCalledWith('session-a');
    resolveFinalRead();

    await expect(buildPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    expect(build).not.toHaveBeenCalled();
    await host.dispose();
  });

  it('does not register a recording after its task cancellation has completed', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    let armed = false;
    let armedReadCount = 0;
    let signalFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    let resolveFinalRead!: () => void;
    const getSession = vi.fn(async (id: string) => {
      const snapshot = { ...localSession(id), status: 'active' as const };
      if (armed && ++armedReadCount === 2) {
        signalFinalRead();
        await new Promise<void>((resolve) => {
          resolveFinalRead = resolve;
        });
      }
      return snapshot;
    });
    const startRecording = vi.fn(async () => ({
      recordingId: 'late-recording',
      startedAt: new Date().toISOString(),
    }));
    const discardSession = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession,
      mediaCapture: {
        startRecording,
        discardSession,
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });

    await host.reconcileOwnership();
    const instance = actor.list('session-a')[0]!;
    armed = true;
    const recordingPromise = host.callTool(
      'start_recording',
      {
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      },
      { sessionId: 'session-a', origin: 'user' },
    );
    await finalReadStarted;
    await host.cancelSessionOperations('session-a');
    resolveFinalRead();

    await expect(recordingPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    expect(startRecording).not.toHaveBeenCalled();
    expect(discardSession).toHaveBeenCalledOnce();
    await host.dispose();
  });

  it('does not capture a screenshot after its task cancellation has completed', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    let armed = false;
    let armedReadCount = 0;
    let signalFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    let resolveFinalRead!: () => void;
    const getSession = vi.fn(async (id: string) => {
      const snapshot = { ...localSession(id), status: 'active' as const };
      if (armed && ++armedReadCount === 2) {
        signalFinalRead();
        await new Promise<void>((resolve) => {
          resolveFinalRead = resolve;
        });
      }
      return snapshot;
    });
    const takeScreenshot = vi.fn(async () => ({
      hash: 'a'.repeat(64),
      ext: '.png',
      mimeType: 'image/png',
      bytes: 8,
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
      deduplicated: false,
      refIds: ['ref-a'],
    }));
    const discardSession = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession,
      mediaCapture: {
        takeScreenshot,
        discardSession,
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });

    await host.reconcileOwnership();
    const instance = actor.list('session-a')[0]!;
    armed = true;
    const screenshotPromise = host.callTool(
      'take_screenshot',
      {
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      },
      { sessionId: 'session-a', origin: 'user' },
    );
    await finalReadStarted;
    await host.cancelSessionOperations('session-a');
    resolveFinalRead();

    await expect(screenshotPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    expect(takeScreenshot).not.toHaveBeenCalled();
    expect(discardSession).toHaveBeenCalledOnce();
    await host.dispose();
  });

  it('aborts and drains an active simulator mutation before task cancellation returns', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      mediaCapture: {
        discardSession: vi.fn(async () => undefined),
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });
    let mutationSignal: AbortSignal | undefined;
    const active = actor
      .runMutation(
        {
          sessionId: instance.sessionId,
          instanceId: instance.instanceId,
          generation: instance.generation,
          leaseId: instance.lease.id,
        },
        async (_current, signal) => {
          mutationSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        'user',
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mutationSignal).toBeDefined());

    await expect(host.cancelSessionOperations('session-a')).resolves.toBeUndefined();
    expect(mutationSignal?.aborted).toBe(true);
    await expect(active).resolves.toMatchObject({ code: 'MUTATION_CANCELLED' });
    await host.dispose();
  });

  it('does not block task removal when recording cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const discardSession = vi.fn(async () => {
      throw new Error('recording process did not exit');
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      mediaCapture: {
        discardSession,
        discardInstance: vi.fn(async () => undefined),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
    });

    await expect(host.cancelSessionOperations('session-a')).resolves.toBeUndefined();
    expect(discardSession).toHaveBeenCalledWith('session-a');
    await host.dispose();
  });

  it('rejects queued screenshot and recording registration after instance teardown begins', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    let markActiveStarted: () => void = () => undefined;
    let releaseActive: () => void = () => undefined;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markDiscardStarted: () => void = () => undefined;
    let releaseDiscard: () => void = () => undefined;
    const discardStarted = new Promise<void>((resolve) => {
      markDiscardStarted = resolve;
    });
    const discardGate = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    let discardCalls = 0;
    const discardInstance = vi.fn(async () => {
      discardCalls += 1;
      if (discardCalls !== 1) return;
      markDiscardStarted();
      await discardGate;
    });
    const takeScreenshot = vi.fn(async () => ({
      hash: 'a'.repeat(64),
      ext: '.png',
      mimeType: 'image/png',
      bytes: 8,
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
      deduplicated: false,
      refIds: ['ref-a'],
    }));
    const startRecording = vi.fn(async () => ({
      recordingId: 'late-recording',
      startedAt: new Date().toISOString(),
    }));
    const openUrlExact = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      mediaCapture: {
        takeScreenshot,
        startRecording,
        discardInstance,
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      appLifecycle: {
        inspectArtifact: vi.fn(),
        installExact: vi.fn(),
        launchExact: vi.fn(),
        terminateExact: vi.fn(),
        openUrlExact,
      },
    });

    await host.reconcileOwnership();
    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    await expect(
      host.setAgentControlGrant('session-a', instance.instanceId, 'allowed'),
    ).resolves.toMatchObject({ ok: true });
    const active = actor.runMutation(
      { sessionId: 'session-a', ...route },
      async () => {
        markActiveStarted();
        await activeGate;
      },
      'agent',
    );
    await activeStarted;

    const screenshot = host.callTool('take_screenshot', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    const recording = host.callTool('start_recording', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    await vi.waitFor(() =>
      expect(actor.mutationState(instance.instanceId)).toMatchObject({ queuedAgentMutations: 2 }),
    );

    const stopping = host.callTool('stop_instance', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await discardStarted;
    await expect(
      host.callTool(
        'open_url',
        { ...route, url: 'demo://teardown-race' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MUTATION_CANCELLED' });
    expect(openUrlExact).not.toHaveBeenCalled();
    releaseActive();

    await expect(screenshot).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(recording).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    expect(takeScreenshot).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();

    releaseDiscard();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    await expect(active).rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
    await host.dispose();
  });

  it.each(['stop_instance', 'detach_device'] as const)(
    'completes %s even when pending media cleanup times out',
    async (toolName) => {
      const lifecycle: IOSSimulatorSimctlLifecycle = {
        findExact: vi.fn(async () => READY_REPORT.devices[0]!),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      };
      const actor = new IOSSimulatorInstanceActor({
        store: new IOSSimulatorOwnershipStore(),
        lifecycle,
      });
      const instance = actor.attach({
        sessionId: 'session-a',
        worktreeRoot: '/tmp/session-a',
        sourceFingerprint: 'fingerprint-a',
        device: READY_REPORT.devices[0]!,
        bootProvenance: 'preexisting',
      });
      const discardInstance = vi
        .fn()
        .mockRejectedValueOnce(new Error('raw media ingest did not become idle'))
        .mockResolvedValue(undefined);
      const stopDriver = vi.fn(async () => undefined);
      const host = createIOSSimulatorHost({
        actor,
        lifecycle,
        runtime: { inspect: vi.fn(async () => READY_REPORT) },
        getSession: vi.fn(async (id) => localSession(id)),
        driverManager: {
          get: vi.fn(() => null),
          start: vi.fn(),
          stop: stopDriver,
        },
        mediaCapture: {
          discardInstance,
        } as unknown as IOSSimulatorMediaCaptureAdapter,
      });
      await host.reconcileOwnership();
      const current = actor.getOwned('session-a', instance.instanceId);
      const route = {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      };

      await expect(
        host.callTool(toolName, route, { sessionId: 'session-a', origin: 'user' }),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          mediaCleanupWarning: { code: 'MEDIA_CLEANUP_INCOMPLETE' },
        },
      });
      expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);
      expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
      if (toolName === 'stop_instance') {
        expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
          instance.simulatorUdid,
          expect.any(AbortSignal),
        );
        expect(actor.list('session-a')[0]).toMatchObject({ lifecycleState: 'stopped' });
      } else {
        expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
        expect(actor.list('session-a')).toEqual([]);
      }
      await host.dispose();
    },
  );

  it('shares exact attachment and lifecycle state while rejecting another session', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
      setAppearance: vi.fn(async () => undefined),
      setIncreaseContrast: vi.fn(async () => undefined),
      setContentSize: vi.fn(async () => undefined),
      setLocation: vi.fn(async () => undefined),
      startLocationRoute: vi.fn(async () => undefined),
      clearLocation: vi.fn(async () => undefined),
      setPrivacy: vi.fn(async () => undefined),
      pushNotification: vi.fn(async () => undefined),
      setStatusBar: vi.fn(async () => undefined),
      clearStatusBar: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const driver = {
      kind: 'wda' as const,
      probe: vi.fn(async (...args: [signal?: AbortSignal]) => {
        void args;
        return { ready: true, message: null };
      }),
      getAccessibilityTree: vi.fn(async (...args: [sessionId?: string, signal?: AbortSignal]) => {
        void args;
        return {
          capturedAt: '2026-07-22T12:00:00.000Z',
          tree: {
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            enabled: true,
            visible: true,
            rect: { x: 20, y: 40, width: 100, height: 40 },
          },
        };
      }),
      getWindowSize: vi.fn(async (...args: [sessionId?: string, signal?: AbortSignal]) => {
        void args;
        return { width: 393, height: 852 };
      }),
      getOrientation: vi.fn(async (...args: [sessionId?: string, signal?: AbortSignal]) => {
        void args;
        return 'PORTRAIT' as const;
      }),
      configureStream: vi.fn(
        async (
          ...args: [
            string,
            { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
          ]
        ) => args[1],
      ),
      tap: vi.fn(async () => undefined),
      swipe: vi.fn(
        async (...args: [string, { x: number; y: number }, { x: number; y: number }, number]) => {
          void args;
        },
      ),
      typeText: vi.fn(async () => undefined),
      home: vi.fn(async () => undefined),
      setOrientation: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
    };
    const nativeInput = {
      capabilities: {
        continuousInput: true,
        multiTouch: true,
      },
      touchPath: vi.fn(async (...args: [IOSSimulatorTouchPoint[], AbortSignal?]) => {
        void args;
      }),
      touch2Path: vi.fn(
        async (...args: [IOSSimulatorTouchPoint[], IOSSimulatorTouchPoint[], AbortSignal?]) => {
          void args;
        },
      ),
      beginTouch: vi.fn(async () => undefined),
      moveTouch: vi.fn(async () => undefined),
      endTouch: vi.fn(async () => undefined),
    };
    let nativeInputEnabled = false;
    let running: WdaRunningInstance | null = null;
    const nativeAdmission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: createIOSSimulatorNativeDevelopmentAdmissionPolicy({
        enableH264Stream: true,
      }),
      detectedCapabilities: {
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: true,
        bgraStream: true,
        discreteInput: false,
        continuousInput: false,
        multiTouch: false,
      },
      processState: 'parked',
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(async (options) => {
        running = {
          instanceId: options.instanceId,
          simulatorUdid: options.simulatorUdid,
          pid: 42,
          driver,
          driverRouter: {
            continuousInput: vi.fn(() => (nativeInputEnabled ? nativeInput : null)),
          },
          driverSessionId: 'wda-session',
        } as unknown as WdaRunningInstance;
        return running;
      }),
      stop: vi.fn(async () => {
        running = null;
      }),
      diagnostics: vi.fn(() => ({
        running: true,
        logTail: '',
        capabilityReport: null,
        nativeSidecar: {
          running: false,
          state: 'parked' as const,
          crashCount: 3,
          probe: null,
          lastFailure: 'IOSurface lookup failed at /Users/example/private/SimulatorKit.framework',
          lastTermination: {
            reasonCode: 'process-exit' as const,
            message: 'Native sidecar exited beside /Users/example/private/SimulatorKit.framework',
            exitCode: 23,
            signal: null,
            occurredAt: '2026-07-25T00:00:01.000Z',
            stderrTail:
              'token=private-value VideoToolbox failed at /Users/example/private/CoreSimulator.framework',
          },
          admission: nativeAdmission,
        },
      })),
    };
    const discardInstance = vi.fn(async () => undefined);
    const mediaCapture = {
      discardInstance,
      captureScreenshotBytes: vi.fn(async () =>
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
      takeScreenshot: vi.fn(async () => ({
        hash: 'a'.repeat(64),
        ext: '.png',
        mimeType: 'image/png',
        bytes: 8,
        url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
        deduplicated: false,
        refIds: ['ref-screenshot'],
      })),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    } as unknown as IOSSimulatorMediaCaptureAdapter;
    const resourceScheduler = testResourceScheduler();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      mediaCapture,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    const attached = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    expect(attached).toMatchObject({
      ok: true,
      data: { instance: { sessionId: 'session-a', lifecycleState: 'ready' } },
    });
    expect(resourceScheduler.runningCount()).toBe(1);
    expect(attached).not.toHaveProperty('data.instance.worktreeRoot');
    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-b' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_ATTACHED_ELSEWHERE' });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true, data: { instances: [{ sessionId: 'session-a' }] } });

    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    await expect(
      host.setViewerVisibility('session-a', route, true, 'jpeg', undefined, 17, 'viewer-token'),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.setViewerStreamProfile('session-a', route, 17, 'viewer-token', {
        framesPerSecond: 10,
        jpegQuality: 45,
        scalingPercent: 70,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 } },
    });
    await expect(
      host.callTool('stop_instance', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'DEVICE_CONTROL_NOT_GRANTED' });
    await expect(
      host.setAgentControlGrant('session-a', instance.instanceId, 'allowed'),
    ).resolves.toMatchObject({ ok: true, data: { grant: { agentControl: 'allowed' } } });
    const screenResult = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(screenResult).toMatchObject({
      ok: true,
      data: { screenMap: { generation: instance.generation, elements: [{ label: 'Continue' }] } },
    });
    expect(driver.getAccessibilityTree).toHaveBeenLastCalledWith(
      'wda-session',
      expect.any(AbortSignal),
    );
    expect(driver.getWindowSize).toHaveBeenLastCalledWith('wda-session', expect.any(AbortSignal));
    expect(driver.getOrientation).toHaveBeenLastCalledWith('wda-session', expect.any(AbortSignal));
    const doctor = await host.callTool('doctor', {}, { sessionId: 'session-a', origin: 'agent' });
    expect(doctor).toMatchObject({
      ok: true,
      data: {
        availability: {
          ready: true,
          instanceCount: 1,
          runningInstanceCount: 1,
          tools: {
            drag_on_simulator: { state: 'available', backend: 'wda' },
            touch_path: { state: 'unavailable', reasonCode: 'NATIVE_HID_NOT_ADMITTED' },
          },
        },
        resource: { runningCount: 1 },
      },
    });
    expect(JSON.stringify(doctor)).not.toContain('/Users/example');
    expect(JSON.stringify(doctor)).not.toContain('SimulatorKit.framework');
    const capturedState = await host.callTool('capture_state', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(capturedState).toMatchObject({
      ok: true,
      data: {
        driverDiagnostics: {
          nativeSidecar: {
            state: 'parked',
            lastFailure: 'Native sidecar is unavailable.',
            lastTermination: {
              reasonCode: 'process-exit',
              exitCode: 23,
              signal: null,
              occurredAt: '2026-07-25T00:00:01.000Z',
              stderrTail: 'token=<redacted> VideoToolbox failed at <redacted-path>',
            },
            admission: {
              generatedAt: '2026-07-25T00:00:00.000Z',
              processState: 'parked',
              launch: { active: false, reasonCode: 'PROCESS_PARKED' },
              capabilities: {
                h264Stream: { active: false, reasonCode: 'PROCESS_PARKED' },
              },
            },
          },
        },
      },
    });
    expect(driver.probe).toHaveBeenLastCalledWith(expect.any(AbortSignal));
    expect(driver.getOrientation).toHaveBeenLastCalledWith('wda-session', expect.any(AbortSignal));
    expect(driver.getAccessibilityTree).toHaveBeenLastCalledWith(
      'wda-session',
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(capturedState)).not.toContain('/Users/example');
    expect(JSON.stringify(capturedState)).not.toContain('SimulatorKit.framework');
    expect(JSON.stringify(capturedState)).not.toContain('private-value');
    expect(JSON.stringify(capturedState)).not.toContain('CoreSimulator.framework');
    const baseline = (screenResult as { ok: true; data: { screenMap: unknown } }).data.screenMap;
    await expect(
      host.callTool(
        'compare_screen_maps',
        { ...route, baseline },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { diff: { unchangedCount: 1, added: [], removed: [], changed: [] } },
    });
    await expect(
      host.callTool('take_screenshot', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({
      ok: true,
      data: { mediaUrl: expect.stringMatching(/^cindy-media:\/\/blobs\//) },
    });
    expect(mediaCapture.takeScreenshot).toHaveBeenCalledWith({
      simulatorUdid: instance.simulatorUdid,
      sessionId: 'session-a',
      instanceId: instance.instanceId,
      source: 'agent',
      signal: expect.any(AbortSignal),
    });
    const visualBaseline = await host.callTool('capture_visual_baseline', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(visualBaseline).toMatchObject({
      ok: true,
      data: { baselineId: expect.any(String), bytes: expect.any(Number) },
    });
    const baselineId = (visualBaseline as { ok: true; data: { baselineId: string } }).data
      .baselineId;
    await expect(
      host.callTool(
        'visual_diff',
        { ...route, baselineId, threshold: 16 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { diff: { comparedPixels: 1, differentPixels: 0, differenceRatio: 0 } },
    });
    expect(mediaCapture.captureScreenshotBytes).toHaveBeenNthCalledWith(1, {
      simulatorUdid: instance.simulatorUdid,
      signal: expect.any(AbortSignal),
    });
    expect(mediaCapture.captureScreenshotBytes).toHaveBeenNthCalledWith(2, {
      simulatorUdid: instance.simulatorUdid,
      signal: expect.any(AbortSignal),
    });
    await expect(
      host.callTool(
        'audit_accessibility',
        { ...route, maxViolations: 10 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        audit: {
          generation: instance.generation,
          checkedElements: 1,
          violationCount: 0,
          violations: [],
        },
      },
    });
    await expect(
      host.callTool(
        'set_appearance',
        { ...route, appearance: 'dark' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_appearance' } });
    await expect(
      host.callTool(
        'set_increase_contrast',
        { ...route, enabled: true },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_increase_contrast' } });
    await expect(
      host.callTool(
        'set_content_size',
        { ...route, contentSize: 'accessibility-extra-large' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_content_size' } });
    await expect(
      host.callTool(
        'set_location',
        { ...route, latitude: 31.23, longitude: 121.47 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_location' } });
    await expect(
      host.callTool(
        'start_location_route',
        {
          ...route,
          waypoints: [
            { latitude: 31.23, longitude: 121.47 },
            { latitude: 31.24, longitude: 121.48 },
          ],
          speedMetersPerSecond: 8,
          intervalSeconds: 1,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'start_location_route' } });
    await expect(
      host.callTool('clear_location', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'clear_location' } });
    await expect(
      host.callTool(
        'set_privacy',
        { ...route, action: 'grant', service: 'photos', bundleId: 'com.example.app' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_privacy' } });
    await expect(
      host.callTool(
        'push_notification',
        { ...route, bundleId: 'com.example.app', payload: { aps: { alert: 'Hi' } } },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'push_notification' } });
    await expect(
      host.callTool(
        'set_status_bar',
        { ...route, time: '9:41', wifiBars: 3 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_status_bar' } });
    await expect(
      host.callTool('clear_status_bar', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'clear_status_bar' } });
    expect(lifecycle.setAppearance).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'dark',
      expect.any(AbortSignal),
    );
    expect(lifecycle.setIncreaseContrast).toHaveBeenCalledWith(
      instance.simulatorUdid,
      true,
      expect.any(AbortSignal),
    );
    expect(lifecycle.setContentSize).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'accessibility-extra-large',
      expect.any(AbortSignal),
    );
    expect(lifecycle.setLocation).toHaveBeenCalledWith(
      instance.simulatorUdid,
      31.23,
      121.47,
      expect.any(AbortSignal),
    );
    expect(lifecycle.startLocationRoute).toHaveBeenCalledWith(
      instance.simulatorUdid,
      {
        waypoints: [
          { latitude: 31.23, longitude: 121.47 },
          { latitude: 31.24, longitude: 121.48 },
        ],
        speedMetersPerSecond: 8,
        intervalSeconds: 1,
        distanceMeters: undefined,
      },
      expect.any(AbortSignal),
    );
    expect(lifecycle.clearLocation).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    expect(lifecycle.setPrivacy).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'grant',
      'photos',
      'com.example.app',
      expect.any(AbortSignal),
    );
    expect(lifecycle.pushNotification).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'com.example.app',
      { aps: { alert: 'Hi' } },
      expect.any(AbortSignal),
    );
    expect(lifecycle.setStatusBar).toHaveBeenCalledWith(
      instance.simulatorUdid,
      {
        time: '9:41',
        wifiBars: 3,
      },
      expect.any(AbortSignal),
    );
    expect(lifecycle.clearStatusBar).toHaveBeenCalledWith(
      instance.simulatorUdid,
      expect.any(AbortSignal),
    );
    const refreshedScreenResult = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!refreshedScreenResult.ok) throw new Error('expected a refreshed screen map');
    let screenMap = (
      refreshedScreenResult.data as {
        screenMap: { snapshotId: string; elements: Array<{ elementId: string }> };
      }
    ).screenMap;
    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:01.000Z',
      tree: {
        type: 'XCUIElementTypeButton',
        label: 'Done',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    await expect(
      host.callTool(
        'tap',
        {
          ...route,
          snapshotId: screenMap.snapshotId,
          elementId: screenMap.elements[0]!.elementId,
          observeAfter: 'immediate',
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        interaction: 'tap',
        screenMapInvalidated: false,
        observation: {
          mode: 'immediate',
          screenMap: { elements: [{ label: 'Done' }] },
        },
      },
    });

    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:02.000Z',
      tree: {
        type: 'XCUIElementTypeStaticText',
        label: 'Loading',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:03.000Z',
      tree: {
        type: 'XCUIElementTypeButton',
        label: 'Done',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    await expect(
      host.callTool(
        'wait_for_ui',
        {
          ...route,
          condition: { kind: 'element_exists', selector: { labelContains: 'Done' } },
          timeoutMs: 1_000,
          pollIntervalMs: 100,
          stableForMs: 100,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        timedOut: false,
        screenMap: { elements: [{ label: 'Done' }] },
      },
    });
    await expect(
      host.callTool(
        'wait_for_ui',
        {
          ...route,
          condition: { kind: 'element_exists', selector: { labelContains: 'Never appears' } },
          timeoutMs: 100,
          pollIntervalMs: 100,
          stableForMs: 100,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'UI_WAIT_TIMEOUT' });
    expect(actor.mutationState(instance.instanceId)).toMatchObject({
      activeSource: null,
      takeoverPending: false,
    });

    const postObservationScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!postObservationScreen.ok) throw new Error('expected post-observation screen map');
    screenMap = (
      postObservationScreen.data as {
        screenMap: { snapshotId: string; elements: Array<{ elementId: string }> };
      }
    ).screenMap;
    const tapArgs = {
      ...route,
      snapshotId: screenMap.snapshotId,
      elementId: screenMap.elements[0]!.elementId,
    };
    await expect(
      host.callTool('tap', tapArgs, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.tap).toHaveBeenCalledWith(
      'wda-session',
      { x: 70, y: 60 },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool('tap', tapArgs, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'STALE_UI_SNAPSHOT' });

    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.5, yRatio: 0.25 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.tap).toHaveBeenLastCalledWith(
      'wda-session',
      { x: 196.5, y: 213 },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          startXRatio: 0.1,
          startYRatio: 0.2,
          endXRatio: 0.9,
          endYRatio: 0.8,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const swipeCall = driver.swipe.mock.lastCall!;
    expect(swipeCall[0]).toBe('wda-session');
    expect(swipeCall[1].x).toBeCloseTo(39.3);
    expect(swipeCall[1].y).toBeCloseTo(170.4);
    expect(swipeCall[2].x).toBeCloseTo(353.7);
    expect(swipeCall[2].y).toBeCloseTo(681.6);
    expect(swipeCall[3]).toBe(250);
    nativeInputEnabled = true;
    await expect(
      host.updateViewerTouch('session-a', route, 18, {
        gestureId: 'viewer-1',
        phase: 'begin',
        xRatio: 0.1,
        yRatio: 0.2,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INSTANCE_NOT_OWNED' });
    expect(nativeInput.beginTouch).not.toHaveBeenCalled();
    await expect(
      host.updateViewerTouch('session-a', route, 17, {
        gestureId: 'viewer-1',
        phase: 'begin',
        xRatio: 0.1,
        yRatio: 0.2,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.updateViewerTouch('session-a', route, 17, {
        gestureId: 'viewer-1',
        phase: 'move',
        xRatio: 0.5,
        yRatio: 0.5,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.updateViewerTouch('session-a', route, 17, {
        gestureId: 'viewer-1',
        phase: 'end',
        xRatio: 0.9,
        yRatio: 0.8,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.beginTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.1), y: expect.closeTo(0.2) }),
      expect.any(AbortSignal),
    );
    expect(nativeInput.moveTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.5), y: expect.closeTo(0.5) }),
      expect.any(AbortSignal),
    );
    expect(nativeInput.endTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.9), y: expect.closeTo(0.8) }),
      false,
      expect.any(AbortSignal),
    );
    nativeInput.touchPath.mockClear();
    const wdaTapCount = driver.tap.mock.calls.length;
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.5, yRatio: 0.25 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touchPath).toHaveBeenCalledOnce();
    expect(driver.tap).toHaveBeenCalledTimes(wdaTapCount);
    nativeInput.touchPath.mockClear();
    const nativeSwipeScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!nativeSwipeScreen.ok) throw new Error('expected native swipe screen map');
    const nativeSwipeSnapshot = (
      nativeSwipeScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          snapshotId: nativeSwipeSnapshot,
          startX: 39.3,
          startY: 170.4,
          endX: 353.7,
          endY: 681.6,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touchPath).toHaveBeenCalledOnce();
    const nativeSwipePath = nativeInput.touchPath.mock.lastCall![0];
    expect(nativeSwipePath[0]).toMatchObject({
      phase: 'down',
      y: 0.2,
      dtMs: 0,
    });
    expect(nativeSwipePath[0]!.x).toBeCloseTo(0.1);
    expect(nativeSwipePath.at(-1)).toMatchObject({
      phase: 'up',
      y: 0.8,
    });
    expect(nativeSwipePath.at(-1)!.x).toBeCloseTo(0.9);

    const nativeMultiScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!nativeMultiScreen.ok) throw new Error('expected native multi-touch screen map');
    const nativeMultiSnapshot = (
      nativeMultiScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    await expect(
      host.callTool(
        'touch2_path',
        {
          ...route,
          snapshotId: nativeMultiSnapshot,
          first: [
            { phase: 'down', x: 157.2, y: 426 },
            { phase: 'move', x: 117.9, y: 426, dtMs: 20 },
            { phase: 'up', x: 78.6, y: 426, dtMs: 20 },
          ],
          second: [
            { phase: 'down', x: 235.8, y: 426 },
            { phase: 'move', x: 275.1, y: 426, dtMs: 20 },
            { phase: 'up', x: 314.4, y: 426, dtMs: 20 },
          ],
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touch2Path).toHaveBeenCalledOnce();
    expect(nativeInput.touch2Path.mock.lastCall![0][0]!.x).toBeCloseTo(0.4);
    expect(nativeInput.touch2Path.mock.lastCall![0][0]!.y).toBeCloseTo(0.5);
    expect(nativeInput.touch2Path.mock.lastCall![1][0]!.x).toBeCloseTo(0.6);
    expect(nativeInput.touch2Path.mock.lastCall![1][0]!.y).toBeCloseTo(0.5);

    const takeoverScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!takeoverScreen.ok) throw new Error('expected takeover screen map');
    const takeoverSnapshot = (
      takeoverScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    let takeoverSignal: AbortSignal | undefined;
    nativeInput.touchPath.mockImplementationOnce(
      async (_points: IOSSimulatorTouchPoint[], signal?: AbortSignal) => {
        takeoverSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    const activeNativeGesture = host.callTool(
      'touch_path',
      {
        ...route,
        snapshotId: takeoverSnapshot,
        points: [
          { phase: 'down', x: 39.3, y: 170.4 },
          { phase: 'move', x: 196.5, y: 426, dtMs: 1_000 },
          { phase: 'up', x: 353.7, y: 681.6, dtMs: 1_000 },
        ],
      },
      { sessionId: 'session-a', origin: 'agent' },
    );
    await vi.waitFor(() => expect(takeoverSignal).toBeDefined());
    await expect(host.setAgentMutationPaused('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { takeoverPending: true } },
    });
    expect(takeoverSignal?.aborted).toBe(true);
    await expect(activeNativeGesture).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(host.setAgentMutationPaused('session-a', route, false)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: false } },
    });

    const accessibilityCallsAfterNativeInteractions = driver.getAccessibilityTree.mock.calls.length;
    await expect(
      host.callTool(
        'type_text',
        { ...route, text: 'Hello' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.typeText).toHaveBeenLastCalledWith(
      'wda-session',
      'Hello',
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool('press_home', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.home).toHaveBeenCalledOnce();
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'LANDSCAPE' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { orientation: 'LANDSCAPE' } });
    expect(driver.setOrientation).toHaveBeenCalledWith(
      'LANDSCAPE',
      'wda-session',
      expect.any(AbortSignal),
    );
    driver.setOrientation.mockRejectedValueOnce(
      new WdaError(
        'ORIENTATION_UNSUPPORTED',
        'The foreground app does not support the requested orientation.',
        500,
      ),
    );
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'PORTRAIT' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'ORIENTATION_UNSUPPORTED',
      message: 'The foreground app does not support the requested orientation.',
    });
    await expect(
      host.callTool('lock_screen', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool('unlock_screen', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.lock).toHaveBeenCalledWith('wda-session', expect.any(AbortSignal));
    expect(driver.unlock).toHaveBeenCalledWith('wda-session', expect.any(AbortSignal));
    expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(
      accessibilityCallsAfterNativeInteractions,
    );
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 1.1, yRatio: 0.5 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(
      accessibilityCallsAfterNativeInteractions,
    );

    await expect(host.setAgentMutationPaused('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: true } },
    });
    await expect(
      host.callTool('get_screen_map', route, {
        sessionId: 'session-a',
        origin: 'agent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'AGENT_MUTATION_PAUSED' });
    await expect(
      host.callTool('press_home', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(host.setAgentMutationPaused('session-a', route, false)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: false } },
    });

    running = null;
    await expect(
      host.setViewerStreamProfile('session-a', route, 17, 'viewer-token', {
        framesPerSecond: 20,
        jpegQuality: 70,
        scalingPercent: 100,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 } },
    });
    await expect(host.setViewerVisibility('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { viewport: { width: 393, height: 852 } },
    });
    expect(driverManager.start).toHaveBeenCalledTimes(2);

    await expect(
      host.callTool('stop_instance', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driverManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: instance.instanceId,
        simulatorUdid: READY_REPORT.devices[0]!.udid,
      }),
    );
    expect(driverManager.stop).toHaveBeenCalledWith(instance.instanceId);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);

    const stopped = actor.list('session-a')[0]!;
    await expect(
      host.callTool(
        'detach_device',
        {
          instanceId: stopped.instanceId,
          generation: stopped.generation,
          leaseId: stopped.lease.id,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(discardInstance).toHaveBeenCalledTimes(2);
    expect(resourceScheduler.runningCount()).toBe(0);
  });

  it('routes build, install, launch, terminate, and URL actions through injected adapters', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          }) as unknown as Promise<WdaRunningInstance>,
      ),
      stop: vi.fn(async () => undefined),
    };
    const buildProject = vi.fn<IOSSimulatorProjectBuilderAdapter['build']>(
      async ({ worktreeRoot, derivedDataPath }) => ({
        kind: 'xcode-project' as const,
        worktreeRoot,
        projectRoot: `${worktreeRoot}/ios`,
        containerPath: `${worktreeRoot}/ios/Demo.xcodeproj`,
        scheme: 'Demo',
        appPath: `${worktreeRoot}/build/Demo.app`,
        resultBundlePath: `${derivedDataPath}/CindyBuild.xcresult`,
        buildLogTail:
          'compile /tmp/session-a/secret.swift\\nGH_TOKEN=ghp_1234567890abcdefghijkl\\nwarning: keep this warning',
      }),
    );
    const validateLaunch = vi.fn(async () => ({
      healthy: true,
      expectedPort: 8081,
      expectedSource: 'branch@commit',
      currentSourceOnExpectedPort: true,
      anyMetro: true,
      targetSimulatorUdid: READY_REPORT.devices[0]!.udid,
      targetBooted: true,
    }));
    const projectBuilder: IOSSimulatorProjectBuilderAdapter = {
      build: buildProject,
      readXcresult: vi.fn(async () =>
        JSON.stringify({
          issues: [
            {
              message:
                'failed at /Users/secret/project.swift Authorization: Bearer simulator-diagnostic-secret-123456',
            },
          ],
        }),
      ),
      validateLaunch,
    };
    const artifact = {
      artifactId: 'artifact-a',
      worktreeRoot: '/tmp/session-a',
      authorizedRoot: '/tmp/session-a',
      appPath: '/tmp/session-a/build/Demo.app',
      bundleId: 'com.example.demo',
      createdAt: '2026-07-23T00:00:00.000Z',
    };
    const inspectArtifact = vi.fn<IOSSimulatorAppLifecycleAdapter['inspectArtifact']>(
      async () => artifact,
    );
    const installExact = vi.fn<IOSSimulatorAppLifecycleAdapter['installExact']>(
      async () => undefined,
    );
    const appLifecycle: IOSSimulatorAppLifecycleAdapter = {
      inspectArtifact,
      installExact,
      launchExact: vi.fn(async () => undefined),
      terminateExact: vi.fn(async () => undefined),
      openUrlExact: vi.fn(async () => undefined),
    };
    const requestViewerFocus = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      driverManager,
      projectBuilder,
      appLifecycle,
      resourceScheduler: testResourceScheduler(),
      requestViewerFocus,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    const built = await host.callTool(
      'build_app',
      { ...route, containerPath: 'ios/Demo.xcodeproj' },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );
    expect(built).toMatchObject({
      ok: true,
      data: {
        artifact: { artifactId: artifact.artifactId, bundleId: artifact.bundleId },
        diagnostics: {
          diagnosticsId: expect.any(String),
          buildLogTail: expect.stringContaining('<redacted-path>'),
          xcresultAvailable: true,
        },
      },
    });
    expect(JSON.stringify(built)).not.toContain('ghp_1234567890abcdefghijkl');
    const diagnosticsId = (built as { ok: true; data: { diagnostics: { diagnosticsId: string } } })
      .data.diagnostics.diagnosticsId;
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log', offset: 0, limit: 20 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        diagnosticsId,
        source: 'build-log',
        offset: 0,
        limit: 20,
        available: true,
        text: expect.any(String),
        nextOffset: 20,
        eof: false,
      },
    });
    const xcresult = await host.callTool(
      'read_build_diagnostics',
      { diagnosticsId, source: 'xcresult', offset: 0, limit: 64 * 1024 },
      { sessionId: 'session-a', origin: 'agent' },
    );
    expect(xcresult).toMatchObject({ ok: true, data: { available: true, eof: true } });
    expect(JSON.stringify(xcresult)).not.toContain('/Users/secret');
    expect(JSON.stringify(xcresult)).not.toContain('simulator-diagnostic-secret-123456');
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-b', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(projectBuilder.readXcresult).toHaveBeenCalledTimes(1);

    await expect(
      host.callTool(
        'install_app',
        { ...route, artifactId: artifact.artifactId },
        {
          sessionId: 'session-a',
          origin: 'user',
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool(
        'launch_app',
        { ...route, artifactId: artifact.artifactId, args: ['--uitesting'] },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });

    const mobileArtifact = { ...artifact, artifactId: 'mobile-artifact' };
    buildProject.mockResolvedValueOnce({
      kind: 'cindy-mobile',
      worktreeRoot: '/tmp/session-a',
      projectRoot: '/tmp/session-a/apps/mobile',
      containerPath: null,
      scheme: 'Cindy',
      appPath: '/tmp/session-a/apps/mobile/ios/build/Cindy.app',
      resultBundlePath: null,
      buildLogTail: '',
    });
    inspectArtifact.mockResolvedValueOnce(mobileArtifact);
    await expect(
      host.callTool('build_app', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool(
        'launch_app',
        { ...route, artifactId: mobileArtifact.artifactId, args: [] },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(validateLaunch).toHaveBeenCalledWith(
      '/tmp/session-a',
      READY_REPORT.devices[0]!.udid,
      expect.any(AbortSignal),
    );
    await host.callTool(
      'terminate_app',
      { ...route, artifactId: artifact.artifactId },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );
    await host.callTool(
      'open_url',
      { ...route, url: 'demo://home' },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );

    expect(projectBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeRoot: '/tmp/session-a',
        containerPath: 'ios/Demo.xcodeproj',
      }),
    );
    expect(appLifecycle.installExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      artifact,
      expect.any(AbortSignal),
    );
    expect(appLifecycle.launchExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      artifact,
      ['--uitesting'],
      expect.any(AbortSignal),
    );
    expect(appLifecycle.terminateExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      artifact.bundleId,
      expect.any(AbortSignal),
    );
    expect(appLifecycle.openUrlExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      'demo://home',
      expect.any(AbortSignal),
    );
    expect(requestViewerFocus).toHaveBeenCalledWith('session-a', instance.instanceId);

    let installSignal: AbortSignal | undefined;
    installExact.mockImplementationOnce(
      async (_simulatorUdid, _artifact, signal) =>
        new Promise<void>((resolve) => {
          installSignal = signal;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const installing = host.callTool(
      'install_app',
      { ...route, artifactId: artifact.artifactId },
      { sessionId: 'session-a', origin: 'user' },
    );
    await vi.waitFor(() => expect(installSignal).toBeDefined());
    const stopping = host.callTool('stop_instance', route, {
      sessionId: 'session-a',
      origin: 'user',
    });
    await vi.waitFor(() => expect(installSignal?.aborted).toBe(true));
    await expect(installing).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(stopping).resolves.toMatchObject({ ok: true });
  });

  it('returns readable diagnostics when build_app fails', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          }) as unknown as Promise<WdaRunningInstance>,
      ),
      stop: vi.fn(async () => undefined),
    };
    const resultBundlePath =
      '/tmp/cindy-user-data/ios-simulator/projects/build/CindyBuild-failed.xcresult';
    const projectBuilder: IOSSimulatorProjectBuilderAdapter = {
      build: vi.fn(async () => {
        throw new IOSSimulatorProjectBuildError(
          'APP_BUILD_FAILED',
          'The Xcode project could not be built.',
          'compile /Users/secret/project.swift\nerror: BUILD_FAILURE_MARKER',
          resultBundlePath,
          true,
          true,
        );
      }),
      readXcresult: vi.fn(async () => 'xcresult BUILD_FAILURE_MARKER'),
    };
    const host = createIOSSimulatorHost({
      actor,
      driverManager,
      projectBuilder,
      resourceScheduler: testResourceScheduler(),
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    const failed = await host.callTool('build_app', route, {
      sessionId: 'session-a',
      origin: 'user',
    });

    expect(failed).toMatchObject({
      ok: false,
      errorCode: 'APP_BUILD_FAILED',
      message: 'The Xcode project could not be built.',
      data: {
        diagnostics: {
          diagnosticsId: expect.any(String),
          buildLogTail: expect.stringMatching(/<redacted-path>.*BUILD_FAILURE_MARKER/s),
          xcresultAvailable: true,
          outputTruncated: true,
        },
      },
    });
    const diagnosticsId = (
      failed as unknown as { ok: false; data: { diagnostics: { diagnosticsId: string } } }
    ).data.diagnostics.diagnosticsId;
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        diagnosticsId,
        available: true,
        text: expect.stringContaining('BUILD_FAILURE_MARKER'),
      },
    });
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-b', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
  });

  itMac(
    'retries persisted removed-task cleanup after another registry writer releases its lease',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-host-persisted-cleanup-'));
      const registryPath = path.join(root, 'ios-simulator', 'ownership-registry.json');
      const setupRegistry = new IOSSimulatorOwnershipRegistryFile(registryPath, {
        acquireWriterLease: () => {
          let held = true;
          return {
            isHeld: () => held,
            release: () => {
              held = false;
            },
          };
        },
      });
      expect(setupRegistry.acquireWriterSync()).toBe(true);
      const persistedInstance = new IOSSimulatorOwnershipStore({
        createId: () => 'persisted-removed-instance',
      }).attach({
        sessionId: 'persisted-removed-session',
        worktreeRoot: '/tmp/persisted-removed-session',
        sourceFingerprint: 'persisted-fingerprint',
        device: READY_REPORT.devices[0]!,
      });
      setupRegistry.saveSync([persistedInstance]);
      setupRegistry.releaseWriterSync();

      const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
      let writerLeaseHeld = false;
      let acquireAttempts = 0;
      const acquireWriter = vi
        .spyOn(IOSSimulatorOwnershipRegistryFile.prototype, 'acquireWriterSync')
        .mockImplementation(() => {
          if (writerLeaseHeld) return true;
          acquireAttempts += 1;
          if (acquireAttempts === 1) return false;
          writerLeaseHeld = true;
          return true;
        });
      const isWriter = vi
        .spyOn(IOSSimulatorOwnershipRegistryFile.prototype, 'isWriter', 'get')
        .mockImplementation(() => writerLeaseHeld);
      const releaseWriter = vi
        .spyOn(IOSSimulatorOwnershipRegistryFile.prototype, 'releaseWriterSync')
        .mockImplementation(() => {
          writerLeaseHeld = false;
        });
      const cleanupOrphaned = vi
        .spyOn(WdaProcessManager.prototype, 'cleanupOrphaned')
        .mockResolvedValue();
      try {
        await expect(
          cleanupIOSSimulatorRemovedSession('persisted-removed-session'),
        ).rejects.toMatchObject({
          code: 'DEVICE_BUSY',
          retryable: true,
        });
        expect(acquireAttempts).toBe(1);

        await expect(
          cleanupIOSSimulatorRemovedSession('persisted-removed-session'),
        ).resolves.toBeUndefined();

        expect(acquireAttempts).toBe(2);
        const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as {
          instances: unknown[];
        };
        expect(persisted.instances).toEqual([]);
      } finally {
        await disposeIOSSimulatorHost();
        expect(writerLeaseHeld).toBe(false);
        releaseWriter.mockRestore();
        isWriter.mockRestore();
        acquireWriter.mockRestore();
        cleanupOrphaned.mockRestore();
        getPath.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

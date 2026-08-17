import path from "node:path";

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
} from "../capability-admission.js";
import type { IOSSimulatorNativeSidecarDriver } from "../driver.js";
import {
  HostIOSSimulatorSidecarSupervisor,
  IOSSimulatorCapabilityProviderError,
  IOSSimulatorStaticSidecarArtifactResolver,
  type IOSSimulatorSidecarArtifactDescriptor,
  type IOSSimulatorSidecarRuntime,
  type IOSSimulatorSidecarRuntimeFactoryInput,
} from "./provider.js";
import type {
  IOSSimulatorNativeSidecarDiagnostics,
  IOSSimulatorNativeSidecarRunningInstance,
  IOSSimulatorNativeSidecarStartOptions,
} from "./process-manager.js";

import { describe, expect, it, vi } from "vitest";

const UDID = "A1B2C3D4-1111-2222-3333-444455556666";
const START: IOSSimulatorNativeSidecarStartOptions = {
  instanceId: "instance-a",
  simulatorUdid: UDID,
  generation: 7,
  runtime: {
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    runtimeBuildVersion: "23E244",
    xcodeBuild: "17E192",
    architecture: "arm64",
  },
};
const CAPABILITIES = Object.freeze({
  accessibility: false,
  sessions: false,
  jpegStream: false,
  h264Stream: true,
  bgraStream: false,
  discreteInput: true,
  continuousInput: true,
  multiTouch: true,
});

function bundledArtifact(
  patch: Partial<IOSSimulatorSidecarArtifactDescriptor> = {},
): IOSSimulatorSidecarArtifactDescriptor {
  const descriptor: IOSSimulatorSidecarArtifactDescriptor = {
    artifactId: "cindy.ios-simulator-sidecar",
    source: "bundled",
    version: "1.0.0",
    architecture: "arm64",
    executablePath: "/Applications/Cindy.app/Contents/Resources/sidecar",
    trust: "development",
    sha256: null,
    ...patch,
  };
  return {
    ...descriptor,
    executablePath: path.normalize(descriptor.executablePath),
  };
}

function developmentPolicy(
  artifact: IOSSimulatorSidecarArtifactDescriptor,
): IOSSimulatorNativeCapabilityAdmissionPolicy {
  return {
    ...createIOSSimulatorNativeDevelopmentAdmissionPolicy({
      enableH264Stream: true,
      enableContinuousInput: true,
    }),
    artifact: {
      source: artifact.source,
      trust: artifact.trust,
    },
  };
}

class FakeRuntime implements IOSSimulatorSidecarRuntime {
  readonly #policy: (
    input: IOSSimulatorNativeSidecarStartOptions,
  ) => IOSSimulatorNativeCapabilityAdmissionPolicy;
  readonly running = new Map<
    string,
    IOSSimulatorNativeSidecarRunningInstance
  >();
  readonly start = vi.fn(
    async (
      input: IOSSimulatorNativeSidecarStartOptions,
    ): Promise<IOSSimulatorNativeSidecarRunningInstance> => {
      const admission = evaluateIOSSimulatorNativeCapabilityAdmission({
        policy: this.#policy(input),
        detectedCapabilities: CAPABILITIES,
        processState: "running",
      });
      const adapter = {
        kind: "native-sidecar",
        simulatorUdid: input.simulatorUdid,
        generation: input.generation,
        capabilities: CAPABILITIES,
      } as IOSSimulatorNativeSidecarDriver;
      const value: IOSSimulatorNativeSidecarRunningInstance = {
        instanceId: input.instanceId,
        simulatorUdid: input.simulatorUdid,
        generation: input.generation,
        adapter,
        handshake: {
          protocolVersion: 1,
          simulatorUdid: input.simulatorUdid,
          generation: input.generation,
          ready: true,
          message: null,
          capabilities: CAPABILITIES,
          probe: null,
        },
        admission,
        startedAt: new Date(0).toISOString(),
      };
      this.running.set(input.instanceId, value);
      return value;
    },
  );
  readonly recover = vi.fn(
    async (
      input: IOSSimulatorNativeSidecarStartOptions,
    ): Promise<IOSSimulatorNativeSidecarRunningInstance> => this.start(input),
  );
  readonly stop = vi.fn(async (instanceId: string) => {
    this.running.delete(instanceId);
  });
  readonly abortOperationsForExit = vi.fn();

  constructor(
    readonly artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
    policy: (
      input: IOSSimulatorNativeSidecarStartOptions,
    ) => IOSSimulatorNativeCapabilityAdmissionPolicy,
  ) {
    this.#policy = policy;
  }

  get(instanceId: string): IOSSimulatorNativeSidecarRunningInstance | null {
    return this.running.get(instanceId) ?? null;
  }

  admission(instanceId: string) {
    return this.running.get(instanceId)?.admission ?? null;
  }

  diagnostics(instanceId: string): IOSSimulatorNativeSidecarDiagnostics | null {
    const running = this.running.get(instanceId);
    if (!running) return null;
    return {
      running: true,
      state: "running",
      crashCount: 0,
      probe: null,
      lastFailure: null,
      lastTermination: null,
      admission: running.admission,
    };
  }
}

function createSupervisor(input: {
  resolve: () =>
    | IOSSimulatorSidecarArtifactDescriptor
    | null
    | Promise<IOSSimulatorSidecarArtifactDescriptor | null>;
  policy?: (
    artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
    start: Readonly<IOSSimulatorNativeSidecarStartOptions>,
  ) => IOSSimulatorNativeCapabilityAdmissionPolicy;
}) {
  const runtimes: FakeRuntime[] = [];
  const createRuntime = vi.fn(
    (factoryInput: IOSSimulatorSidecarRuntimeFactoryInput) => {
      const runtime = new FakeRuntime(
        factoryInput.artifact,
        factoryInput.admissionPolicy,
      );
      runtimes.push(runtime);
      return runtime;
    },
  );
  const supervisor = new HostIOSSimulatorSidecarSupervisor({
    providerId: "cindy.bundled-ios-simulator",
    artifactResolver: { resolve: input.resolve },
    admissionPolicy: {
      resolve: ({ artifact, start }) =>
        input.policy?.(artifact, start) ?? developmentPolicy(artifact),
    },
    createRuntime,
  });
  return { supervisor, createRuntime, runtimes };
}

describe("HostIOSSimulatorSidecarSupervisor", () => {
  it("forwards updater force-exit aborts to the bound Host runtime", async () => {
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => bundledArtifact(),
    });
    await supervisor.start(START);

    supervisor.abortOperationsForExit();

    expect(runtimes[0]!.abortOperationsForExit).toHaveBeenCalledOnce();
  });

  it("keeps artifact resolution and process creation behind the Host provider", async () => {
    const artifact = bundledArtifact();
    const { supervisor, createRuntime, runtimes } = createSupervisor({
      resolve: () => artifact,
    });

    const running = await supervisor.start(START);

    expect(supervisor.providerId).toBe("cindy.bundled-ios-simulator");
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime.mock.calls[0]![0].artifact).toEqual(artifact);
    expect(running.adapter.kind).toBe("native-sidecar");
    expect(supervisor.get(START.instanceId)?.generation).toBe(7);
    await supervisor.stop(START.instanceId);
    expect(runtimes[0]!.stop).toHaveBeenCalledWith(START.instanceId);
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("preserves the artifact binding while its runtime is still retiring", async () => {
    let artifact = bundledArtifact();
    const { supervisor, createRuntime, runtimes } = createSupervisor({
      resolve: () => artifact,
    });
    await supervisor.start(START);
    const runtime = runtimes[0]!;
    const terminationFailure = Object.assign(new Error("still alive"), {
      code: "TERMINATION_FAILED",
    });
    runtime.stop.mockRejectedValueOnce(terminationFailure);

    await expect(supervisor.stop(START.instanceId)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    artifact = bundledArtifact({
      artifactId: "replacement.ios-sidecar",
      sha256: "b".repeat(64),
    });
    await expect(supervisor.start(START)).rejects.toMatchObject({
      code: "ARTIFACT_CHANGED",
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);

    artifact = bundledArtifact();
    runtime.start.mockRejectedValueOnce(terminationFailure);
    await expect(supervisor.start(START)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);

    await supervisor.stop(START.instanceId);
    artifact = bundledArtifact({
      artifactId: "replacement.ios-sidecar",
      sha256: "b".repeat(64),
    });
    await supervisor.start(START);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it("retries disposal after a bounded termination failure", async () => {
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => bundledArtifact(),
    });
    await supervisor.start(START);
    const runtime = runtimes[0]!;
    runtime.stop.mockRejectedValueOnce(
      Object.assign(new Error("still alive"), {
        code: "TERMINATION_FAILED",
      }),
    );

    await expect(supervisor.dispose()).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    expect(supervisor.get(START.instanceId)).not.toBeNull();
    supervisor.abortOperationsForExit();
    expect(runtime.abortOperationsForExit).toHaveBeenCalledTimes(1);

    await supervisor.dispose();
    expect(supervisor.get(START.instanceId)).toBeNull();
    supervisor.abortOperationsForExit();
    expect(runtime.abortOperationsForExit).toHaveBeenCalledTimes(1);
    expect(() => supervisor.enable()).toThrowError(
      IOSSimulatorCapabilityProviderError,
    );
  });

  it("blocks enable and new starts throughout asynchronous disposal", async () => {
    const { supervisor, createRuntime, runtimes } = createSupervisor({
      resolve: () => bundledArtifact(),
    });
    await supervisor.start(START);
    const runtime = runtimes[0]!;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    runtime.stop.mockImplementationOnce(async (instanceId) => {
      await stopGate;
      runtime.running.delete(instanceId);
    });

    const disposal = supervisor.dispose();
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledOnce());
    expect(() => supervisor.enable()).toThrowError(
      IOSSimulatorCapabilityProviderError,
    );
    await expect(
      supervisor.start({ ...START, instanceId: "instance-b" }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(createRuntime).toHaveBeenCalledTimes(1);

    releaseStop();
    await disposal;
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("derives artifact trust from the Host resolver and rejects an untrusted plugin before runtime creation", async () => {
    const pluginArtifact = bundledArtifact({
      artifactId: "example.ios-sidecar",
      source: "plugin",
      trust: "untrusted",
      executablePath: "/Library/Application Support/Cindy/plugin/sidecar",
    });
    const { supervisor, createRuntime } = createSupervisor({
      resolve: () => pluginArtifact,
      policy: () => ({
        ...developmentPolicy(bundledArtifact()),
        // A policy implementation cannot promote resolver-owned artifact facts.
        artifact: { source: "bundled", trust: "verified" },
      }),
    });

    await expect(supervisor.start(START)).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(supervisor.admission(START.instanceId)).toMatchObject({
      artifact: { source: "plugin", trust: "untrusted" },
      launch: { allowed: false, reasonCode: "ARTIFACT_UNTRUSTED" },
    });
    expect(
      JSON.stringify(supervisor.diagnostics(START.instanceId)),
    ).not.toContain(pluginArtifact.executablePath);
  });

  it("accepts a Host-verified plugin artifact through the same provider contract", async () => {
    const artifact = bundledArtifact({
      artifactId: "example.ios-sidecar",
      source: "plugin",
      trust: "verified",
      sha256: "a".repeat(64),
      executablePath: "/Library/Application Support/Cindy/plugin/sidecar",
    });
    const { supervisor, createRuntime } = createSupervisor({
      resolve: () => artifact,
    });

    await expect(supervisor.start(START)).resolves.toMatchObject({
      instanceId: START.instanceId,
    });
    expect(createRuntime.mock.calls[0]![0].artifact).toMatchObject({
      source: "plugin",
      trust: "verified",
      sha256: "a".repeat(64),
    });
  });

  it("rejects invalid, unverifiable, or architecture-mismatched descriptors", async () => {
    for (const artifact of [
      bundledArtifact({ trust: "verified", sha256: null }),
      bundledArtifact({ executablePath: "relative/sidecar" }),
      bundledArtifact({ architecture: "x86_64" }),
    ]) {
      const { supervisor, createRuntime } = createSupervisor({
        resolve: () => artifact,
      });
      await expect(supervisor.start(START)).rejects.toBeInstanceOf(
        IOSSimulatorCapabilityProviderError,
      );
      expect(createRuntime).not.toHaveBeenCalled();
    }
  });

  it("stops the old runtime instead of recovering across an artifact identity change", async () => {
    let artifact = bundledArtifact();
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => artifact,
    });
    await supervisor.start(START);
    artifact = bundledArtifact({
      version: "2.0.0",
      executablePath: "/Applications/Cindy.app/Contents/Resources/sidecar-v2",
    });

    await expect(
      supervisor.recover(START, { rearm: true }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_CHANGED",
    });
    expect(runtimes[0]!.recover).not.toHaveBeenCalled();
    expect(runtimes[0]!.stop).toHaveBeenCalledWith(START.instanceId);
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("stops all bindings when disabled and requires an explicit re-enable", async () => {
    const resolver = new IOSSimulatorStaticSidecarArtifactResolver(
      bundledArtifact(),
    );
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => resolver.resolve(),
    });
    await supervisor.start(START);

    await supervisor.disable();

    expect(runtimes[0]!.stop).toHaveBeenCalledWith(START.instanceId);
    await expect(supervisor.start(START)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
    });
    supervisor.enable();
    await expect(supervisor.start(START)).resolves.toMatchObject({
      instanceId: START.instanceId,
    });
  });

  it("rechecks Host policy on recovery and stops a capability that was revoked", async () => {
    const artifact = bundledArtifact();
    let allowed = true;
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => artifact,
      policy: () => ({
        ...developmentPolicy(artifact),
        resourceAdmission: allowed ? "allowed" : "denied",
      }),
    });
    await supervisor.start(START);
    allowed = false;

    await expect(supervisor.recover(START)).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
    });
    expect(runtimes[0]!.recover).not.toHaveBeenCalled();
    expect(runtimes[0]!.stop).toHaveBeenCalledWith(START.instanceId);
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("converges an in-flight provider start to stopped without a late binding", async () => {
    const artifact = bundledArtifact();
    const runtime = new FakeRuntime(artifact, () =>
      developmentPolicy(artifact),
    );
    let rejectStart!: (error: Error) => void;
    runtime.start.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject;
        }),
    );
    runtime.stop.mockImplementation(async () => {
      rejectStart(new Error("stopped"));
    });
    const supervisor = new HostIOSSimulatorSidecarSupervisor({
      providerId: "cindy.bundled-ios-simulator",
      artifactResolver: { resolve: () => artifact },
      admissionPolicy: {
        resolve: () => developmentPolicy(artifact),
      },
      createRuntime: () => runtime,
    });

    const start = supervisor.start(START);
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    const stop = supervisor.stop(START.instanceId);

    await expect(start).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await stop;
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("converges an in-flight recovery to stopped without restarting after provider stop", async () => {
    const artifact = bundledArtifact();
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => artifact,
    });
    await supervisor.start(START);
    const runtime = runtimes[0]!;
    let rejectRecovery!: (error: Error) => void;
    runtime.recover.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRecovery = reject;
        }),
    );
    runtime.stop.mockImplementation(async (instanceId) => {
      runtime.running.delete(instanceId);
      rejectRecovery(new Error("stopped"));
    });

    const recovery = supervisor.recover(START, { rearm: true });
    await vi.waitFor(() => expect(runtime.recover).toHaveBeenCalledOnce());
    const stop = supervisor.stop(START.instanceId);

    await expect(recovery).rejects.toMatchObject({ code: "START_STOPPED" });
    await stop;
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("cancels a pending artifact resolution when that artifact is invalidated", async () => {
    const artifact = bundledArtifact();
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    const resolve = vi.fn(async () => {
      await resolverGate;
      return artifact;
    });
    const { supervisor, createRuntime } = createSupervisor({ resolve });
    const start = supervisor.start(START);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const invalidation = supervisor.invalidateArtifact(artifact.artifactId);
    releaseResolver();

    await expect(start).rejects.toMatchObject({ code: "START_STOPPED" });
    await invalidation;
    expect(createRuntime).not.toHaveBeenCalled();
    expect(supervisor.get(START.instanceId)).toBeNull();
  });

  it("does not expose artifact resolver failures through the provider boundary", async () => {
    const { supervisor } = createSupervisor({
      resolve: () => {
        throw new Error("/Users/example/private/plugin/sidecar");
      },
    });

    await expect(supervisor.start(START)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Native capability artifact resolution failed.",
    });
  });

  it("invalidates only bindings owned by the selected artifact", async () => {
    const artifact = bundledArtifact();
    const { supervisor, runtimes } = createSupervisor({
      resolve: () => artifact,
    });
    await supervisor.start(START);

    await supervisor.invalidateArtifact(artifact.artifactId);

    expect(runtimes[0]!.stop).toHaveBeenCalledWith(START.instanceId);
    expect(supervisor.get(START.instanceId)).toBeNull();
  });
});

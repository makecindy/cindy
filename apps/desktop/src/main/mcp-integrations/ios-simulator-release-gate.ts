import {
  createIOSSimulatorNativeSidecarSandboxPolicy,
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  IOSSimulatorNativeSidecarProcessManager,
  validateIOSimulatorNativeFrame,
  type IOSSimulatorEnvironmentReport,
  type IOSSimulatorNativeCapabilityAdmissionDecision,
  type IOSSimulatorNativeSidecarStartOptions,
  type IOSSimulatorRuntimeInfo,
  type IOSSimulatorSidecarArtifactDescriptor,
} from '@cindy/ios-simulator-runtime';

import {
  IOSSimulatorPackagedSidecarArtifactResolver,
  verifyIOSSimulatorSidecarDigest,
} from './ios-simulator-artifact.js';
import { resolveIOSSimulatorDesktopAdmissionPolicy } from './ios-simulator-admission.js';

export type IOSSimulatorReleaseGateMode = 'static' | 'native';

export interface IOSSimulatorReleaseGateOptions {
  mode: IOSSimulatorReleaseGateMode;
  packaged: boolean;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  hostOsRelease: string;
  resourcesPath: string;
  version: string;
}

export interface IOSSimulatorReleaseGateNativeResult {
  h264Frames: number;
  keyFrames: number;
  singleTouchAccepted: boolean;
  multiTouchAccepted: boolean;
  cleanRestartReady: boolean;
}

export interface IOSSimulatorReleaseGateReport {
  schemaVersion: 1;
  ok: true;
  mode: IOSSimulatorReleaseGateMode;
  environmentReady: boolean;
  artifact: {
    source: IOSSimulatorSidecarArtifactDescriptor['source'];
    trust: IOSSimulatorSidecarArtifactDescriptor['trust'];
    architecture: IOSSimulatorSidecarArtifactDescriptor['architecture'];
  };
  runtime: {
    identifier: string;
    buildVersion: string | null;
  } | null;
  compatibility: {
    sidecar: 'eligible' | 'ineligible' | 'unknown';
    h264Stream: 'eligible' | 'ineligible' | 'unknown';
    continuousInput: 'eligible' | 'ineligible' | 'unknown';
    multiTouch: 'eligible' | 'ineligible' | 'unknown';
  };
  admission: {
    launchAllowed: boolean;
    reasonCode: IOSSimulatorNativeCapabilityAdmissionDecision['launch']['reasonCode'];
    fallbackRoute: 'wda-mjpeg';
  };
  native: IOSSimulatorReleaseGateNativeResult | null;
}

interface IOSSimulatorReleaseGateNativeProbeInput {
  environment: IOSSimulatorEnvironmentReport;
  runtime: IOSSimulatorRuntimeInfo;
  artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>;
  start: IOSSimulatorNativeSidecarStartOptions;
  resolvePolicy(
    start: IOSSimulatorNativeSidecarStartOptions,
  ): ReturnType<typeof resolveIOSSimulatorDesktopAdmissionPolicy>;
  revalidateArtifact(
    start: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<Readonly<IOSSimulatorSidecarArtifactDescriptor>>;
}

export interface IOSSimulatorReleaseGateDependencies {
  inspectEnvironment(): Promise<IOSSimulatorEnvironmentReport>;
  resolveArtifact(
    start: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<Readonly<IOSSimulatorSidecarArtifactDescriptor>>;
  runNativeProbe(
    input: IOSSimulatorReleaseGateNativeProbeInput,
  ): Promise<IOSSimulatorReleaseGateNativeResult>;
}

function hostArchitecture(architecture: NodeJS.Architecture): 'arm64' | 'x86_64' {
  return architecture === 'x64' ? 'x86_64' : 'arm64';
}

function startOptions(
  runtime: IOSSimulatorRuntimeInfo | null,
  xcodeVersion: string | null,
  architecture: 'arm64' | 'x86_64',
): IOSSimulatorNativeSidecarStartOptions {
  return {
    instanceId: 'ios-simulator-release-gate',
    simulatorUdid: '00000000-0000-0000-0000-000000000000',
    generation: 1,
    runtime: runtime
      ? {
          runtimeIdentifier: runtime.identifier,
          runtimeBuildVersion: runtime.buildVersion,
          xcodeBuild: xcodeVersion ?? 'unknown',
          architecture,
        }
      : undefined,
  };
}

function sameArtifact(
  left: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
  right: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.source === right.source &&
    left.version === right.version &&
    left.architecture === right.architecture &&
    left.executablePath === right.executablePath &&
    left.trust === right.trust &&
    left.sha256 === right.sha256
  );
}

/** @internal Exported only so cleanup error precedence stays covered by unit tests. */
export async function finalizeIOSSimulatorReleaseGateProbe(
  probeSucceeded: boolean,
  cleanupSteps: readonly (() => Promise<void>)[],
): Promise<void> {
  let firstCleanupError: unknown;
  let cleanupFailed = false;
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      if (!cleanupFailed) firstCleanupError = error;
      cleanupFailed = true;
    }
  }
  if (probeSucceeded && cleanupFailed) {
    throw new Error('IOS_SIMULATOR_RELEASE_CLEANUP_FAILED', {
      cause: firstCleanupError,
    });
  }
}

async function runNativeProbe(
  input: IOSSimulatorReleaseGateNativeProbeInput,
): Promise<IOSSimulatorReleaseGateNativeResult> {
  const template =
    input.environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === input.runtime.identifier &&
        candidate.deviceTypeIdentifier,
    ) ?? null;
  const artifactSha256 = input.artifact.sha256;
  if (!template?.deviceTypeIdentifier || !artifactSha256) {
    throw new Error('IOS_SIMULATOR_RELEASE_NATIVE_UNAVAILABLE');
  }

  const lifecycle = createIOSSimulatorSimctlLifecycle();
  let simulatorUdid: string | null = null;
  let probeSucceeded = false;
  const manager = new IOSSimulatorNativeSidecarProcessManager({
    binaryPath: input.artifact.executablePath,
    admissionPolicy: input.resolvePolicy,
    verifyBinaryIntegrity: () =>
      verifyIOSSimulatorSidecarDigest(input.artifact.executablePath, artifactSha256),
    sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
      required: true,
      platform: input.environment.platform,
    }),
  });

  try {
    const created = await lifecycle.createExact({
      name: `Cindy Packaged Native Gate ${Date.now()}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: input.runtime.identifier,
    });
    simulatorUdid = created.udid;
    await lifecycle.bootExact(simulatorUdid);
    const start: IOSSimulatorNativeSidecarStartOptions = {
      ...input.start,
      simulatorUdid,
    };
    const revalidated = await input.revalidateArtifact(start);
    if (revalidated.trust !== 'verified' || !sameArtifact(input.artifact, revalidated)) {
      throw new Error('IOS_SIMULATOR_RELEASE_ARTIFACT_CHANGED');
    }

    const running = await manager.start(start);
    if (
      !running.admission.capabilities.h264Stream.active ||
      !running.admission.capabilities.continuousInput.active ||
      !running.admission.capabilities.multiTouch.active
    ) {
      throw new Error('IOS_SIMULATOR_RELEASE_CAPABILITY_INACTIVE');
    }
    const framebuffer = await running.adapter.captureNativeFrame({
      maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
    });
    validateIOSimulatorNativeFrame(framebuffer);
    await running.adapter.configureNativeStream({
      encoding: 'h264',
      framesPerSecond: 5,
      scalingPercent: 50,
    });
    let h264Frames = 0;
    let keyFrames = 0;
    const h264Stats = await running.adapter.streamNativeFrames({
      maxFrames: 3,
      maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
      onFrame(frame) {
        validateIOSimulatorNativeFrame(frame);
        if (frame.encoding !== 'h264') {
          throw new Error('IOS_SIMULATOR_RELEASE_H264_INVALID');
        }
        h264Frames += 1;
        if (frame.keyFrame) keyFrames += 1;
      },
    });
    if (h264Frames !== 3 || keyFrames < 1 || h264Stats.endReason !== 'max-frames') {
      throw new Error('IOS_SIMULATOR_RELEASE_H264_INCOMPLETE');
    }

    await running.adapter.touchPath([
      { phase: 'down', x: 0.3, y: 0.3 },
      { phase: 'move', x: 0.4, y: 0.4, dtMs: 20 },
      { phase: 'up', x: 0.5, y: 0.5, dtMs: 20 },
    ]);
    await running.adapter.touch2Path(
      [
        { phase: 'down', x: 0.4, y: 0.5 },
        { phase: 'move', x: 0.35, y: 0.5, dtMs: 20 },
        { phase: 'up', x: 0.3, y: 0.5, dtMs: 20 },
      ],
      [
        { phase: 'down', x: 0.6, y: 0.5 },
        { phase: 'move', x: 0.65, y: 0.5, dtMs: 20 },
        { phase: 'up', x: 0.7, y: 0.5, dtMs: 20 },
      ],
    );

    await manager.stop(start.instanceId);
    const restartArtifact = await input.revalidateArtifact(start);
    if (restartArtifact.trust !== 'verified' || !sameArtifact(input.artifact, restartArtifact)) {
      throw new Error('IOS_SIMULATOR_RELEASE_ARTIFACT_CHANGED');
    }
    const restarted = await manager.start(start);
    const cleanRestartReady =
      restarted.admission.capabilities.h264Stream.active &&
      restarted.admission.capabilities.continuousInput.active &&
      restarted.admission.capabilities.multiTouch.active;
    if (!cleanRestartReady) {
      throw new Error('IOS_SIMULATOR_RELEASE_RESTART_INCOMPLETE');
    }

    probeSucceeded = true;
    return {
      h264Frames,
      keyFrames,
      singleTouchAccepted: true,
      multiTouchAccepted: true,
      cleanRestartReady,
    };
  } finally {
    const cleanupSteps: Array<() => Promise<void>> = [() => manager.stop(input.start.instanceId)];
    const cleanupUdid = simulatorUdid;
    if (cleanupUdid) {
      cleanupSteps.push(
        () => lifecycle.shutdownExact(cleanupUdid),
        () => lifecycle.deleteExact(cleanupUdid),
      );
    }
    await finalizeIOSSimulatorReleaseGateProbe(probeSucceeded, cleanupSteps);
  }
}

function defaultDependencies(
  options: IOSSimulatorReleaseGateOptions,
): IOSSimulatorReleaseGateDependencies {
  const architecture = hostArchitecture(options.architecture);
  const resolver = new IOSSimulatorPackagedSidecarArtifactResolver({
    resourcesPath: options.resourcesPath,
    version: options.version,
    architecture,
    platform: options.platform,
  });
  return {
    inspectEnvironment: () => createIOSSimulatorRuntime({ platform: options.platform }).inspect(),
    resolveArtifact: (start) => resolver.resolve(start),
    runNativeProbe,
  };
}

/**
 * Runs only from the packaged main-process release-test short circuit. The
 * returned report deliberately excludes paths, signing identities, UDIDs, and
 * private-framework diagnostics so build logs remain safe to archive.
 */
export async function runIOSSimulatorReleaseGate(
  options: IOSSimulatorReleaseGateOptions,
  dependencies: IOSSimulatorReleaseGateDependencies = defaultDependencies(options),
): Promise<IOSSimulatorReleaseGateReport> {
  if (
    !options.packaged ||
    options.platform !== 'darwin' ||
    (options.architecture !== 'arm64' && options.architecture !== 'x64')
  ) {
    throw new Error('IOS_SIMULATOR_RELEASE_HOST_UNSUPPORTED');
  }
  const environment = await dependencies.inspectEnvironment();
  const architecture = hostArchitecture(options.architecture);
  const availableRuntimes = environment.runtimes.filter((runtime) => runtime.isAvailable);
  const initialStart = startOptions(
    availableRuntimes[0] ?? null,
    environment.xcodeVersion,
    architecture,
  );
  const artifact = await dependencies.resolveArtifact(initialStart);

  const candidates = (availableRuntimes.length > 0 ? availableRuntimes : [null]).map((runtime) => {
    const start = startOptions(runtime, environment.xcodeVersion, architecture);
    const policy = resolveIOSSimulatorDesktopAdmissionPolicy({
      packaged: true,
      platform: options.platform,
      architecture: options.architecture,
      hostOsRelease: options.hostOsRelease,
      artifact,
      start,
      developmentRequests: {
        h264Stream: false,
        continuousInput: false,
      },
    });
    return {
      runtime,
      start,
      policy,
      decision: evaluateIOSSimulatorNativeCapabilityAdmission({
        policy,
        processState: 'idle',
        // Release promotion remains strict even though product runtime
        // admission soft-opens unknown combinations for probing.
        requireVerifiedCompatibility: true,
      }),
    };
  });
  const selected =
    candidates.find((candidate) => candidate.decision.launch.allowed) ?? candidates[0]!;

  let native: IOSSimulatorReleaseGateNativeResult | null = null;
  if (options.mode === 'native') {
    if (!environment.ready || !selected.runtime || !selected.decision.launch.allowed) {
      throw new Error('IOS_SIMULATOR_RELEASE_NATIVE_NOT_ADMITTED');
    }
    native = await dependencies.runNativeProbe({
      environment,
      runtime: selected.runtime,
      artifact,
      start: selected.start,
      resolvePolicy: (start) =>
        resolveIOSSimulatorDesktopAdmissionPolicy({
          packaged: true,
          platform: options.platform,
          architecture: options.architecture,
          hostOsRelease: options.hostOsRelease,
          artifact,
          start,
          developmentRequests: {
            h264Stream: false,
            continuousInput: false,
          },
        }),
      revalidateArtifact: dependencies.resolveArtifact,
    });
  }

  return {
    schemaVersion: 1,
    ok: true,
    mode: options.mode,
    environmentReady: environment.ready,
    artifact: {
      source: artifact.source,
      trust: artifact.trust,
      architecture: artifact.architecture,
    },
    runtime: selected.runtime
      ? {
          identifier: selected.runtime.identifier,
          buildVersion: selected.runtime.buildVersion,
        }
      : null,
    compatibility: { ...selected.policy.compatibility },
    admission: {
      launchAllowed: selected.decision.launch.allowed,
      reasonCode: selected.decision.launch.reasonCode,
      fallbackRoute: selected.decision.fallbackRoute,
    },
    native,
  };
}

export function parseIOSSimulatorReleaseGateArgs(argv: readonly string[]): {
  enabled: boolean;
  mode: IOSSimulatorReleaseGateMode;
} {
  const argument = argv.find((candidate) => candidate.startsWith('--ios-simulator-release-gate='));
  if (!argument) return { enabled: false, mode: 'static' };
  const value = argument.slice('--ios-simulator-release-gate='.length);
  if (value !== 'static' && value !== 'native') {
    throw new Error('IOS_SIMULATOR_RELEASE_GATE_MODE_INVALID');
  }
  return { enabled: true, mode: value };
}

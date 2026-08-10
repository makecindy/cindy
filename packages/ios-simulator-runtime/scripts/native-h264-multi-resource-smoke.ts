import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectIOSSimulatorMemorySnapshot,
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  IOSSimulatorNativeSidecarProcessManager,
  type IOSSimulatorNativeStreamProfile,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const architecture = process.arch === "x64" ? "x86_64" : "arm64";
const binaryPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "native",
  architecture,
  "ios-simulator-sidecar",
);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;
const lifecycle = createIOSSimulatorSimctlLifecycle();

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const balancedSeconds = positiveIntegerEnvironment(
  "CINDY_IOS_H264_MULTI_BALANCED_SECONDS",
  15,
);
const downshiftSeconds = positiveIntegerEnvironment(
  "CINDY_IOS_H264_MULTI_DOWNSHIFT_SECONDS",
  60,
);
if (balancedSeconds > 60 || downshiftSeconds > 5 * 60) {
  throw new Error("Multi-resource smoke phase duration is out of bounds");
}

interface TemporaryInstance {
  instanceId: string;
  simulatorUdid: string;
  manager: IOSSimulatorNativeSidecarProcessManager;
  running: Awaited<
    ReturnType<IOSSimulatorNativeSidecarProcessManager["start"]>
  >;
}

interface StreamResult {
  framesPerSecond: number;
  scalingPercent: number;
  expectedFrames: number;
  observedFrames: number;
  actualFramesPerSecond: number;
  width: number;
  height: number;
  keyFrameCount: number;
  byteCount: number;
  bytesPerSecond: number;
  maximumFrameGapMs: number;
  endReason: string;
}

interface ResourceSample {
  sampledAtMs: number;
  totalRssBytes: number;
  totalCpuPercent: number;
  instances: number;
}

async function simulatorTemplate(): Promise<{
  runtimeIdentifier: string;
  deviceTypeIdentifier: string;
}> {
  const environment = await createIOSSimulatorRuntime().inspect();
  if (!environment.ready) {
    throw new Error(
      environment.error ??
        environment.issue ??
        "Simulator environment unavailable",
    );
  }
  const requestedRuntime = process.env.CINDY_IOS_SIMULATOR_RUNTIME?.trim();
  const runtime = environment.runtimes.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.identifier.includes(".iOS-") &&
      (!requestedRuntime ||
        candidate.identifier === requestedRuntime ||
        candidate.version === requestedRuntime ||
        candidate.name === requestedRuntime),
  );
  if (!runtime) {
    throw new Error(
      requestedRuntime
        ? `Requested iOS runtime is not available: ${requestedRuntime}`
        : "No available iOS runtime",
    );
  }
  const template =
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
    ) ??
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier,
    );
  if (!template?.deviceTypeIdentifier) {
    throw new Error("No compatible simulator device type");
  }
  return {
    runtimeIdentifier: runtime.identifier,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
  };
}

async function sampleResources(
  instances: TemporaryInstance[],
  startedAt: number,
): Promise<ResourceSample> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "rss=,%cpu=,command="],
    { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
  );
  let totalRssBytes = 0;
  let totalCpuPercent = 0;
  let observedInstances = 0;
  for (const instance of instances) {
    const line = stdout
      .split("\n")
      .find(
        (candidate) =>
          candidate.includes("ios-simulator-sidecar") &&
          candidate.includes(instance.simulatorUdid),
      );
    const match = line?.match(/^\s*(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    totalRssBytes += Number(match[1]) * 1024;
    totalCpuPercent += Number(match[2]);
    observedInstances += 1;
  }
  return {
    sampledAtMs: Math.round(performance.now() - startedAt),
    totalRssBytes,
    totalCpuPercent,
    instances: observedInstances,
  };
}

async function streamProfile(
  instance: TemporaryInstance,
  profile: IOSSimulatorNativeStreamProfile,
  durationSeconds: number,
): Promise<StreamResult> {
  await instance.running.adapter.configureNativeStream(profile);
  const expectedFrames = profile.framesPerSecond * durationSeconds;
  let observedFrames = 0;
  let previousSequence = -1;
  let previousTimestamp = -1;
  let keyFrameCount = 0;
  let width = 0;
  let height = 0;
  let maximumFrameGapMs = 0;
  let lastFrameAt = performance.now();
  const startedAt = performance.now();
  const stats = await instance.running.adapter.streamNativeFrames({
    maxFrames: expectedFrames,
    maxFrameBytes,
    onFrame(frame) {
      if (frame.encoding !== "h264" || frame.format !== "annex-b") {
        throw new Error(
          `Expected Annex-B H.264, received ${frame.encoding}/${frame.format}`,
        );
      }
      if (frame.sequence !== previousSequence + 1) {
        throw new Error(
          `${instance.instanceId} sequence changed from ${previousSequence} to ${frame.sequence}`,
        );
      }
      if (frame.timestampMicros <= previousTimestamp) {
        throw new Error(`${instance.instanceId} timestamp is not monotonic`);
      }
      const now = performance.now();
      if (observedFrames > 0) {
        maximumFrameGapMs = Math.max(maximumFrameGapMs, now - lastFrameAt);
      }
      if (observedFrames === 0 && !frame.keyFrame) {
        throw new Error(`${instance.instanceId} did not start with an IDR`);
      }
      if (width === 0) {
        width = frame.width;
        height = frame.height;
      } else if (width !== frame.width || height !== frame.height) {
        throw new Error(
          `${instance.instanceId} dimensions changed mid-profile`,
        );
      }
      if (frame.keyFrame) keyFrameCount += 1;
      previousSequence = frame.sequence;
      previousTimestamp = frame.timestampMicros;
      lastFrameAt = now;
      observedFrames += 1;
    },
  });
  const elapsedMs = performance.now() - startedAt;
  if (
    stats.endReason !== "max-frames" ||
    stats.frameCount !== expectedFrames ||
    observedFrames !== expectedFrames
  ) {
    throw new Error(
      `${instance.instanceId} stream ended unexpectedly: ${JSON.stringify(stats)}`,
    );
  }
  return {
    framesPerSecond: profile.framesPerSecond,
    scalingPercent: profile.scalingPercent,
    expectedFrames,
    observedFrames,
    actualFramesPerSecond: Number(
      (observedFrames / (elapsedMs / 1_000)).toFixed(3),
    ),
    width,
    height,
    keyFrameCount,
    byteCount: stats.byteCount,
    bytesPerSecond: Math.round(stats.byteCount / (elapsedMs / 1_000)),
    maximumFrameGapMs: Math.round(maximumFrameGapMs),
    endReason: stats.endReason,
  };
}

const instances: TemporaryInstance[] = [];
const createdUdids: string[] = [];

try {
  const template = await simulatorTemplate();
  const memoryBefore = await collectIOSSimulatorMemorySnapshot();
  for (let index = 0; index < 4; index += 1) {
    const created = await lifecycle.createExact({
      name: `Cindy Native H264 Multi Resource Smoke ${index + 1} ${Date.now()}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: template.runtimeIdentifier,
    });
    createdUdids.push(created.udid);
    await lifecycle.bootExact(created.udid);
    const instanceId = `native-h264-multi-resource-${index + 1}`;
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath,
      enableH264Stream: true,
    });
    const running = await manager.start({
      instanceId,
      simulatorUdid: created.udid,
      generation: 1,
    });
    if (!running.handshake.capabilities.h264Stream) {
      throw new Error(`${instanceId} did not advertise H.264 streaming`);
    }
    instances.push({
      instanceId,
      simulatorUdid: created.udid,
      manager,
      running,
    });
  }

  const startedAt = performance.now();
  const resourceSamples: ResourceSample[] = [];
  const collectSample = async () => {
    resourceSamples.push(await sampleResources(instances, startedAt));
  };
  await collectSample();
  const sampleTimer = setInterval(() => void collectSample(), 2_000);
  let balanced: StreamResult[];
  let downshifted: StreamResult[];
  try {
    balanced = await Promise.all(
      instances.map((instance) =>
        streamProfile(
          instance,
          {
            encoding: "h264",
            framesPerSecond: 10,
            scalingPercent: 50,
            orientation: "PORTRAIT",
          },
          balancedSeconds,
        ),
      ),
    );
    downshifted = await Promise.all(
      instances.map((instance, index) =>
        streamProfile(
          instance,
          index === 0
            ? {
                encoding: "h264",
                framesPerSecond: 15,
                scalingPercent: 50,
                orientation: "PORTRAIT",
              }
            : {
                encoding: "h264",
                framesPerSecond: 5,
                scalingPercent: 25,
                orientation: "PORTRAIT",
              },
          downshiftSeconds,
        ),
      ),
    );
  } finally {
    clearInterval(sampleTimer);
    await collectSample();
  }

  const foreground = downshifted[0]!;
  const backgrounds = downshifted.slice(1);
  if (
    foreground.actualFramesPerSecond < 12 ||
    backgrounds.some((result) => result.actualFramesPerSecond < 4) ||
    backgrounds.some(
      (result, index) =>
        result.width >= foreground.width ||
        result.height >= foreground.height ||
        result.bytesPerSecond >= balanced[index + 1]!.bytesPerSecond,
    )
  ) {
    throw new Error(
      `Four-instance downshift validation failed: ${JSON.stringify({
        balanced,
        downshifted,
      })}`,
    );
  }
  const memoryAfter = await collectIOSSimulatorMemorySnapshot();
  const totalCpuSamples = resourceSamples.filter(
    (sample) => sample.instances === 4,
  );
  const averageTotalCpuPercent =
    totalCpuSamples.reduce((sum, sample) => sum + sample.totalCpuPercent, 0) /
    Math.max(1, totalCpuSamples.length);
  const peakTotalCpuPercent = Math.max(
    0,
    ...totalCpuSamples.map((sample) => sample.totalCpuPercent),
  );
  const peakTotalRssBytes = Math.max(
    0,
    ...totalCpuSamples.map((sample) => sample.totalRssBytes),
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtime: template.runtimeIdentifier,
      architecture,
      instances: instances.map((instance) => ({
        instanceId: instance.instanceId,
        simulatorUdid: instance.simulatorUdid,
      })),
      phases: {
        balanced: {
          durationSeconds: balancedSeconds,
          profile: { framesPerSecond: 10, scalingPercent: 50 },
          streams: balanced,
        },
        downshifted: {
          durationSeconds: downshiftSeconds,
          foregroundProfile: { framesPerSecond: 15, scalingPercent: 50 },
          backgroundProfile: { framesPerSecond: 5, scalingPercent: 25 },
          streams: downshifted,
        },
      },
      resources: {
        samples: totalCpuSamples.length,
        averageTotalCpuPercent: Number(averageTotalCpuPercent.toFixed(2)),
        peakTotalCpuPercent,
        peakTotalRssBytes,
        memoryBefore,
        memoryAfter,
      },
    })}\n`,
  );
} finally {
  await Promise.all(
    instances.map((instance) =>
      instance.manager.stop(instance.instanceId).catch(() => undefined),
    ),
  );
  for (const simulatorUdid of createdUdids.reverse()) {
    await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
    await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
  }
}

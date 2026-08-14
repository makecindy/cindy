import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  IOSSimulatorNativeSidecarProcessManager,
  type IOSSimulatorH264Frame,
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
const instanceId = "native-h264-stability-smoke";
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

const durationSeconds = positiveIntegerEnvironment(
  "CINDY_IOS_H264_STABILITY_SECONDS",
  30 * 60,
);
const framesPerSecond = positiveIntegerEnvironment(
  "CINDY_IOS_H264_STABILITY_FPS",
  5,
);
const scalingPercent = positiveIntegerEnvironment(
  "CINDY_IOS_H264_STABILITY_SCALING",
  50,
);
if (durationSeconds > 60 * 60 || framesPerSecond > 60 || scalingPercent > 100) {
  throw new Error(
    "Stability smoke is bounded to 60 minutes, 60 FPS, and 100% scaling",
  );
}
const maxFrames = durationSeconds * framesPerSecond;

interface ProcessSample {
  sampledAtMs: number;
  rssBytes: number;
  cpuPercent: number;
}

async function sampleSidecarProcess(
  simulatorUdid: string,
  startedAt: number,
): Promise<ProcessSample | null> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "rss=,%cpu=,command="],
    { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
  );
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(.+)$/);
    if (
      match?.[3]?.includes("ios-simulator-sidecar") &&
      match[3].includes(simulatorUdid)
    ) {
      return {
        sampledAtMs: Math.round(performance.now() - startedAt),
        rssBytes: Number(match[1]) * 1024,
        cpuPercent: Number(match[2]),
      };
    }
  }
  return null;
}

async function createTemporarySimulator(): Promise<{
  runtimeIdentifier: string;
  simulatorUdid: string;
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
  const created = await lifecycle.createExact({
    name: `Cindy Native H264 Stability Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  await lifecycle.bootExact(created.udid);
  return {
    runtimeIdentifier: runtime.identifier,
    simulatorUdid: created.udid,
  };
}

function nalTypes(bytes: Uint8Array): number[] {
  const result: number[] = [];
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    let startCodeLength = 0;
    if (
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 1
    ) {
      startCodeLength = 3;
    } else if (
      index + 4 < bytes.byteLength &&
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 &&
      bytes[index + 3] === 1
    ) {
      startCodeLength = 4;
    }
    if (startCodeLength > 0) {
      const header = bytes[index + startCodeLength];
      if (header !== undefined) result.push(header & 0x1f);
      index += startCodeLength - 1;
    }
  }
  return result;
}

let simulatorUdid: string | null = null;
let manager: IOSSimulatorNativeSidecarProcessManager | null = null;

try {
  const temporary = await createTemporarySimulator();
  simulatorUdid = temporary.simulatorUdid;
  manager = new IOSSimulatorNativeSidecarProcessManager({
    binaryPath,
    enableH264Stream: true,
  });
  const running = await manager.start({
    instanceId,
    simulatorUdid,
    generation: 1,
  });
  if (!running.handshake.capabilities.h264Stream) {
    throw new Error("Opt-in sidecar did not advertise H.264 streaming");
  }
  const framebuffer = await running.adapter.captureNativeFrame({
    maxFrameBytes,
  });
  await running.adapter.configureNativeStream({
    encoding: "h264",
    framesPerSecond,
    scalingPercent,
  });

  let observedFrames = 0;
  let keyFrameCount = 0;
  let previousSequence = -1;
  let previousTimestamp = -1;
  let firstFrame: IOSSimulatorH264Frame | null = null;
  let lastFrame: IOSSimulatorH264Frame | null = null;
  let maximumFrameGapMs = 0;
  let lastFrameAt = performance.now();
  const processSamples: ProcessSample[] = [];
  const startedAt = performance.now();
  const collectSample = async () => {
    if (!simulatorUdid) return;
    const sample = await sampleSidecarProcess(simulatorUdid, startedAt);
    if (sample) processSamples.push(sample);
  };
  await collectSample();
  const sampleTimer = setInterval(() => void collectSample(), 5_000);
  let streamStats;
  try {
    streamStats = await running.adapter.streamNativeFrames({
      maxFrames,
      maxFrameBytes,
      onFrame(frame) {
        if (frame.encoding !== "h264" || frame.format !== "annex-b") {
          throw new Error(
            `Expected Annex-B H.264, received ${frame.encoding}/${frame.format}`,
          );
        }
        if (frame.sequence !== previousSequence + 1) {
          throw new Error(
            `Non-contiguous H.264 sequence: ${previousSequence} -> ${frame.sequence}`,
          );
        }
        if (frame.timestampMicros <= previousTimestamp) {
          throw new Error("H.264 timestamps are not strictly monotonic");
        }
        const now = performance.now();
        if (observedFrames > 0) {
          maximumFrameGapMs = Math.max(maximumFrameGapMs, now - lastFrameAt);
        }
        const types = nalTypes(frame.bytes);
        if (frame.keyFrame) {
          keyFrameCount += 1;
          if (!types.includes(7) || !types.includes(8) || !types.includes(5)) {
            throw new Error(
              `Key frame is not independently decodable: ${types.join(",")}`,
            );
          }
        }
        firstFrame ??= frame;
        lastFrame = frame;
        previousSequence = frame.sequence;
        previousTimestamp = frame.timestampMicros;
        lastFrameAt = now;
        observedFrames += 1;
      },
    });
  } finally {
    clearInterval(sampleTimer);
    await collectSample();
  }
  const elapsedMs = performance.now() - startedAt;
  if (
    streamStats.endReason !== "max-frames" ||
    streamStats.frameCount !== maxFrames ||
    observedFrames !== maxFrames ||
    !firstFrame ||
    !lastFrame ||
    !firstFrame.keyFrame
  ) {
    throw new Error(
      `H.264 stability stream ended unexpectedly: ${JSON.stringify({
        streamStats,
        observedFrames,
        firstFrame: Boolean(firstFrame),
        lastFrame: Boolean(lastFrame),
      })}`,
    );
  }
  const averageCpuPercent =
    processSamples.reduce((sum, sample) => sum + sample.cpuPercent, 0) /
    Math.max(1, processSamples.length);
  const peakCpuPercent = Math.max(
    0,
    ...processSamples.map((sample) => sample.cpuPercent),
  );
  const peakRssBytes = Math.max(
    0,
    ...processSamples.map((sample) => sample.rssBytes),
  );
  const firstRssBytes = processSamples[0]?.rssBytes ?? 0;
  const lastRssBytes = processSamples.at(-1)?.rssBytes ?? 0;
  const theoreticalBgraBytes = framebuffer.bytes.byteLength * maxFrames;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      simulatorUdid,
      runtime: temporary.runtimeIdentifier,
      architecture,
      durationSeconds,
      profile: { framesPerSecond, scalingPercent },
      frames: {
        expected: maxFrames,
        observed: observedFrames,
        actualFramesPerSecond: Number(
          (observedFrames / (elapsedMs / 1_000)).toFixed(3),
        ),
        keyFrameCount,
        maximumFrameGapMs: Math.round(maximumFrameGapMs),
        width: firstFrame.width,
        height: firstFrame.height,
      },
      bytes: {
        encoded: streamStats.byteCount,
        perSecond: Math.round(streamStats.byteCount / (elapsedMs / 1_000)),
        theoreticalBgra: theoreticalBgraBytes,
        compressionRatio: Number(
          (theoreticalBgraBytes / streamStats.byteCount).toFixed(2),
        ),
      },
      resources: {
        samples: processSamples.length,
        averageCpuPercent: Number(averageCpuPercent.toFixed(2)),
        peakCpuPercent,
        firstRssBytes,
        lastRssBytes,
        rssDeltaBytes: lastRssBytes - firstRssBytes,
        peakRssBytes,
      },
      endReason: streamStats.endReason,
    })}\n`,
  );
} finally {
  if (manager) await manager.stop(instanceId).catch(() => undefined);
  if (simulatorUdid) {
    await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
    await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
  }
}
